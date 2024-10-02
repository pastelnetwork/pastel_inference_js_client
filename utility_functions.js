require("dotenv").config();
const crypto = require("crypto");
const zstd = require("zstd-codec").ZstdCodec;
const axios = require("axios");
const Sequelize = require("sequelize");
const fs = require("fs");
const path = require("path");
const ping = require("ping");
const { logger, safeStringify } = require("./logger");
const supernodeCacheStorage = require("node-persist");
const { getCurrentPastelIdAndPassphrase } = require("./storage");
const globals = require("./globals");

const {
  verifyMessageWithPastelID,
  getBestBlockHashAndMerkleRoot,
  checkSupernodeList,
  getPastelIDDirectory,
  getLocalRPCSettings,
  initializeRPCConnection,
  importPrivKey,
  waitForRPCConnection,
  stopPastelDaemon,
  startPastelDaemon,
  signMessageWithPastelID,
  isPastelIDRegistered,
  isCreditPackConfirmed,
} = require("./rpc_functions");

const MAX_CACHE_AGE_MS = 1 * 60 * 1000; // 1 minute in milliseconds

const { messageSchema } = require("./validation_schemas");

const TARGET_VALUE_PER_CREDIT_IN_USD = parseFloat(
  process.env.TARGET_VALUE_PER_CREDIT_IN_USD
);
const TARGET_PROFIT_MARGIN = parseFloat(process.env.TARGET_PROFIT_MARGIN);
const MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING =
  parseFloat(
    process.env.MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING
  );
const MAXIMUM_LOCAL_PASTEL_BLOCK_HEIGHT_DIFFERENCE_IN_BLOCKS = parseInt(
  process.env.MAXIMUM_LOCAL_PASTEL_BLOCK_HEIGHT_DIFFERENCE_IN_BLOCKS
);

async function initializeSupernodeCacheStorage() {
  await supernodeCacheStorage.init({ dir: "./supernode-cache" });
  await clearOldCache();
}

async function clearOldCache() {
  const currentTime = Date.now();
  const cacheKeys = await supernodeCacheStorage.keys();

  for (const key of cacheKeys) {
    const item = await supernodeCacheStorage.getItem(key);
    if (item && item.timestamp) {
      if (currentTime - item.timestamp > MAX_CACHE_AGE_MS) {
        await supernodeCacheStorage.removeItem(key);
      }
    } else {
      // If the item doesn't have a timestamp, remove it as well
      await supernodeCacheStorage.removeItem(key);
    }
  }
}

async function storeInCache(key, data) {
  await supernodeCacheStorage.setItem(key, {
    timestamp: Date.now(),
    data: data,
  });
}

// Modify the function that retrieves data from the cache
async function getFromCache(key) {
  const item = await supernodeCacheStorage.getItem(key);
  if (item && item.timestamp) {
    if (Date.now() - item.timestamp <= MAX_CACHE_AGE_MS) {
      return item.data;
    } else {
      // Data is too old, remove it
      await supernodeCacheStorage.removeItem(key);
    }
  }
  return null;
}

async function fetchCurrentPSLMarketPrice() {
  async function checkPrices() {
    try {
      const [responseCMC, responseCG] = await Promise.all([
        axios.get("https://coinmarketcap.com/currencies/pastel/"),
        axios.get(
          "https://api.coingecko.com/api/v3/simple/price?ids=pastel&vs_currencies=usd"
        ),
      ]);
      const priceCMC = parseFloat(
        responseCMC.data.match(/price today is \$([0-9.]+) USD/)[1]
      );
      const priceCG = responseCG.data.pastel.usd;
      return { priceCMC, priceCG };
    } catch (error) {
      logger.error(
        `Error fetching PSL market prices: ${error.message.slice(
          0,
          globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE
        )}`
      );
      return { priceCMC: null, priceCG: null };
    }
  }
  let { priceCMC, priceCG } = await checkPrices();
  if (priceCMC === null && priceCG === null) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    ({ priceCMC, priceCG } = await checkPrices());
  }
  const prices = [priceCMC, priceCG].filter((price) => price !== null);
  if (prices.length === 0) {
    throw new Error("Could not retrieve PSL price from any source.");
  }
  const averagePrice =
    prices.reduce((sum, price) => sum + price, 0) / prices.length;
  if (averagePrice < 0.0000001 || averagePrice > 0.02) {
    throw new Error(`Invalid PSL price: ${averagePrice}`);
  }
  logger.info(
    `The current Average PSL price is: $${averagePrice.toFixed(8)} based on ${prices.length
    } sources`
  );
  return averagePrice;
}

async function estimatedMarketPriceOfInferenceCreditsInPSLTerms() {
  try {
    const pslPriceUSD = await fetchCurrentPSLMarketPrice();
    const costPerCreditUSD =
      TARGET_VALUE_PER_CREDIT_IN_USD / (1 - TARGET_PROFIT_MARGIN);
    const costPerCreditPSL = costPerCreditUSD / pslPriceUSD;
    logger.info(
      `Estimated market price of 1.0 inference credit: ${costPerCreditPSL.toFixed(
        4
      )} PSL`
    );
    return costPerCreditPSL;
  } catch (error) {
    logger.error(
      `Error calculating estimated market price of inference credits: ${safeStringify(
        error.message
      )}`
    );
    throw error;
  }
}

function parseAndFormat(value) {
  try {
    if (typeof value === "string") {
      if (value.includes("\n")) {
        return value;
      }
      const parsedValue = JSON.parse(value);
      return JSON.stringify(parsedValue, null, 4);
    }
    return JSON.stringify(value, null, 4);
  } catch (error) {
    return value;
  }
}

function prettyJSON(data) {
  if (data instanceof Sequelize.Model) {
    data = data.get({ plain: true });
  }
  if (data instanceof Map) {
    data = Object.fromEntries(data);
  }
  if (Array.isArray(data) || (typeof data === "object" && data !== null)) {
    const formattedData = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" && key.endsWith("_json")) {
        formattedData[key] = parseAndFormat(value);
      } else if (typeof value === "object" && value !== null) {
        formattedData[key] = prettyJSON(value);
      } else {
        formattedData[key] = value;
      }
    }
    return JSON.stringify(formattedData, null, 4);
  } else if (typeof data === "string") {
    return parseAndFormat(data);
  }
  return data;
}

function abbreviateJSON(jsonString, maxLength) {
  if (jsonString.length <= maxLength) return jsonString;
  const abbreviated = jsonString.slice(0, maxLength) + "...";
  const openBraces =
    (jsonString.match(/{/g) || []).length -
    (abbreviated.match(/{/g) || []).length;
  const openBrackets =
    (jsonString.match(/\[/g) || []).length -
    (abbreviated.match(/\[/g) || []).length;
  return abbreviated + "}".repeat(openBraces) + "]".repeat(openBrackets);
}

function logActionWithPayload(action, payloadName, jsonPayload) {
  const maxPayloadLength = 10000;
  let formattedPayload = prettyJSON(jsonPayload);
  if (formattedPayload.length > maxPayloadLength) {
    formattedPayload = abbreviateJSON(formattedPayload, maxPayloadLength);
  }
  logger.info(
    `Now ${action} ${payloadName} with payload:\n${formattedPayload}`
  );
}

function transformCreditPackPurchaseRequestResponse(result) {
  const transformedResult = { ...result };
  const fieldsToConvert = [
    "list_of_potentially_agreeing_supernodes",
    "list_of_blacklisted_supernode_pastelids",
    "list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms",
    "list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms_selected_for_signature_inclusion",
    "selected_agreeing_supernodes_signatures_dict",
  ];
  fieldsToConvert.forEach((field) => {
    if (transformedResult[field]) {
      transformedResult[field] = safeStringify(transformedResult[field]);
    }
  });
  return transformedResult;
}

function computeSHA3256Hexdigest(input) {
  const hash = crypto.createHash("sha3-256");
  hash.update(input);
  return hash.digest("hex");
}

function getSHA256HashOfInputData(inputData) {
  const hash = crypto.createHash("sha3-256");
  hash.update(inputData, "utf-8");
  return hash.digest("hex");
}

async function compressDataWithZstd(inputData) {
  const zstdCodec = new zstd();
  const compressedData = await zstdCodec.compress(inputData, 20);
  const base64EncodedData = compressedData.toString("base64");
  return { compressedData, base64EncodedData };
}

async function decompressDataWithZstd(compressedInputData) {
  const zstdCodec = new zstd();
  const decompressedData = await zstdCodec.decompress(compressedInputData);
  return decompressedData;
}

async function calculateXORDistance(pastelID1, pastelID2) {
  const hash1 = crypto.createHash("sha3-256").update(pastelID1).digest("hex");
  const hash2 = crypto.createHash("sha3-256").update(pastelID2).digest("hex");
  const xorResult = BigInt(`0x${hash1}`) ^ BigInt(`0x${hash2}`);
  return xorResult;
}

function adjustJSONSpacing(jsonString) {
  return jsonString.replace(/(?<!\d):(\s*)/g, ": ").replace(/,(\s*)/g, ", ");
}

function escapeJsonString(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function pythonCompatibleStringify(obj) {
  function sortObjectByKeys(unsortedObj) {
    const priorityKeys = ["challenge", "challenge_id", "challenge_signature"];
    return Object.keys(unsortedObj)
      .sort((a, b) => {
        const aPriority = priorityKeys.indexOf(a);
        const bPriority = priorityKeys.indexOf(b);

        if (aPriority !== -1 && bPriority !== -1) {
          return aPriority - bPriority;
        }
        if (aPriority !== -1) {
          return 1;
        }
        if (bPriority !== -1) {
          return -1;
        }
        return a.localeCompare(b);
      })
      .reduce((acc, key) => {
        const value = unsortedObj[key];
        if (
          typeof value === "object" &&
          value !== null &&
          !(value instanceof Date)
        ) {
          acc[key] = Array.isArray(value)
            ? value.map(sortObjectByKeys)
            : sortObjectByKeys(value);
        } else {
          acc[key] = value;
        }
        return acc;
      }, {});
  }

  function customReplacer(key, value) {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "object" && value !== null) {
      return sortObjectByKeys(value);
    }
    if (
      typeof value === "string" &&
      value.startsWith("{") &&
      value.endsWith("}")
    ) {
      return escapeJsonString(value);
    }
    if (typeof value === "number") {
      return value;
    }
    return value;
  }
  const sortedObject = sortObjectByKeys(obj);
  let jsonString = JSON.stringify(sortedObject, customReplacer);
  jsonString = jsonString.replace(/"(true|false)"/g, "$1");
  jsonString = adjustJSONSpacing(jsonString);
  return jsonString;
}

function base64EncodeJson(jsonInput) {
  return btoa(pythonCompatibleStringify(JSON.parse(jsonInput)));
}

async function extractResponseFieldsFromCreditPackTicketMessageDataAsJSON(
  modelInstance
) {
  const responseFields = {};
  const plainObject =
    modelInstance instanceof Sequelize.Model
      ? modelInstance.get({ plain: true })
      : modelInstance;

  let lastHashFieldName = null;
  let lastSignatureFieldNames = [];
  for (const fieldName in plainObject) {
    if (fieldName.startsWith("sha3_256_hash_of")) {
      lastHashFieldName = fieldName;
    } else if (fieldName.includes("_signature_on_")) {
      lastSignatureFieldNames.push(fieldName);
    }
  }
  Object.keys(plainObject)
    .sort()
    .forEach((fieldName) => {
      if (
        ![
          lastHashFieldName,
          lastSignatureFieldNames.at(-1),
          "id",
          "_changed",
          "_options",
          "_previousDataValues",
          "dataValues",
          "isNewRecord",
          "uniqno",
        ].includes(fieldName)
      ) {
        const fieldValue = plainObject[fieldName];
        if (fieldValue instanceof Date) {
          responseFields[fieldName] = fieldValue.toISOString();
        } else if (typeof fieldValue === "boolean") {
          responseFields[fieldName] = fieldValue ? 1 : 0;
        } else if (typeof fieldValue === "object" && fieldValue !== null) {
          responseFields[fieldName] = pythonCompatibleStringify(fieldValue);
        } else {
          responseFields[fieldName] =
            typeof fieldValue === "number" ? fieldValue : fieldValue.toString();
        }
      }
    });
  return pythonCompatibleStringify(responseFields);
}

async function computeSHA3256HashOfSQLModelResponseFields(modelInstance) {
  let responseFieldsJSON =
    await extractResponseFieldsFromCreditPackTicketMessageDataAsJSON(
      modelInstance
    );
  const sha256HashOfResponseFields =
    getSHA256HashOfInputData(responseFieldsJSON);
  return sha256HashOfResponseFields;
}

async function prepareModelForEndpoint(modelInstance) {
  let preparedModelInstance = {};
  let instanceData =
    typeof modelInstance.get === "function"
      ? modelInstance.get({ plain: true })
      : modelInstance;
  for (const key in instanceData) {
    if (Object.prototype.hasOwnProperty.call(instanceData, key)) {
      if (key.endsWith("_json")) {
        if (typeof instanceData[key] === "string") {
          try {
            const parsedJson = JSON.parse(instanceData[key]);
            preparedModelInstance[key] = pythonCompatibleStringify(parsedJson);
          } catch (e) {
            console.error("Failed to parse JSON for key:", key, "Error:", e);
            preparedModelInstance[key] = instanceData[key];
          }
        } else {
          preparedModelInstance[key] = pythonCompatibleStringify(
            instanceData[key]
          );
        }
      } else {
        preparedModelInstance[key] = instanceData[key];
      }
    }
  }
  return preparedModelInstance;
}

function removeSequelizeFields(plainObject) {
  const fieldsToRemove = [
    "id",
    "_changed",
    "_options",
    "_previousDataValues",
    "dataValues",
    "isNewRecord",
    "uniqno",
  ];
  Object.keys(plainObject).forEach((fieldName) => {
    if (fieldsToRemove.includes(fieldName)) {
      delete plainObject[fieldName];
    }
  });
}

async function prepareModelForValidation(modelInstance) {
  let preparedModelInstance;
  if (typeof modelInstance.get === "function") {
    preparedModelInstance = modelInstance.get({ plain: true });
  } else if (typeof modelInstance === "object") {
    preparedModelInstance = { ...modelInstance };
  } else {
    throw new Error("Invalid modelInstance type");
  }
  Object.keys(preparedModelInstance).forEach((key) => {
    if (
      key.endsWith("_json") &&
      typeof preparedModelInstance[key] === "string"
    ) {
      try {
        preparedModelInstance[key] = JSON.parse(preparedModelInstance[key]);
      } catch (error) {
        console.error(`Error parsing ${key}: ${error}`);
      }
    }
  });
  return preparedModelInstance;
}

function compareDatetimes(datetime1, datetime2) {
  const diffInSeconds = Math.abs(datetime1 - datetime2) / 1000;
  const areCloseEnough =
    diffInSeconds <=
    MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING;
  return { diffInSeconds, areCloseEnough };
}

function validateTimestampFields(modelInstance, validationErrors) {
  for (const [fieldName, fieldValue] of Object.entries(modelInstance)) {
    if (fieldName.endsWith("_timestamp_utc_iso_string")) {
      try {
        const timestamp = new Date(fieldValue);
        const currentTimestamp = new Date();
        const { areCloseEnough } = compareDatetimes(
          timestamp,
          currentTimestamp
        );
        if (!areCloseEnough) {
          validationErrors.push(
            `Timestamp in field ${fieldName} is too far from the current time`
          );
        }
      } catch (error) {
        validationErrors.push(
          `Invalid timestamp format for field ${fieldName}`
        );
      }
    }
  }
}

async function validatePastelBlockHeightFields(
  modelInstance,
  validationErrors
) {
  const [, , bestBlockHeight] = await getBestBlockHashAndMerkleRoot();
  for (const [fieldName, fieldValue] of Object.entries(modelInstance)) {
    if (fieldName.endsWith("_pastel_block_height")) {
      if (
        Math.abs(fieldValue - bestBlockHeight) >
        MAXIMUM_LOCAL_PASTEL_BLOCK_HEIGHT_DIFFERENCE_IN_BLOCKS
      ) {
        validationErrors.push(
          `Pastel block height in field ${fieldName} does not match the current block height; difference is ${Math.abs(
            fieldValue - bestBlockHeight
          )} blocks (local: ${fieldValue}, remote: ${bestBlockHeight})`
        );
      }
    }
  }
}

async function validateHashFields(modelInstance, validationErrors) {
  const expectedHash = await computeSHA3256HashOfSQLModelResponseFields(
    modelInstance
  );
  let hashFieldName = null;
  for (const fieldName in modelInstance) {
    if (
      fieldName.includes("sha3_256_hash_of_") &&
      fieldName.endsWith("_fields")
    ) {
      hashFieldName = fieldName;
      break;
    }
  }
  if (hashFieldName) {
    const actualHash = modelInstance[hashFieldName];
    if (actualHash !== expectedHash) {
      validationErrors.push(
        `SHA3-256 hash in field ${hashFieldName} does not match the computed hash of the response fields`
      );
    }
  }
}

async function getClosestSupernodePastelIDFromList(
  localPastelID,
  filteredSupernodes,
  maxResponseTimeInMilliseconds = 800
) {
  await initializeSupernodeCacheStorage();
  if (!filteredSupernodes || filteredSupernodes.length === 0) {
    logger.warn("No filtered supernodes available");
    return null;
  }

  const xorDistances = await Promise.all(
    filteredSupernodes.map(async (supernode) => {
      let pastelID;
      if (typeof supernode === "string") {
        pastelID = supernode;
      } else if (supernode && supernode.pastelID) {
        pastelID = supernode.pastelID;
      } else {
        logger.warn(`Invalid supernode data: ${JSON.stringify(supernode)}`);
        return null;
      }

      try {
        const distance = await calculateXORDistance(localPastelID, pastelID);
        return { pastelID, distance: BigInt(distance) };
      } catch (error) {
        logger.error(
          `Error calculating XOR distance: ${error.message.slice(
            0,
            globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE
          )}`
        );
        return null;
      }
    })
  );

  const validDistances = xorDistances.filter(Boolean);

  if (validDistances.length === 0) {
    logger.warn("No valid XOR distances calculated");
    return null;
  }

  const sortedXorDistances = validDistances.sort((a, b) => {
    if (a.distance < b.distance) return -1;
    if (a.distance > b.distance) return 1;
    return 0;
  });

  return sortedXorDistances[0].pastelID;
}

function checkIfPastelIDIsValid(inputString) {
  const pattern = /^jX[A-Za-z0-9]{84}$/;
  return pattern.test(inputString);
}

async function getSupernodeUrlFromPastelID(pastelID, supernodeListDF) {
  const isValidPastelID = checkIfPastelIDIsValid(pastelID);
  if (!isValidPastelID) {
    throw new Error(`Invalid PastelID: ${pastelID}`);
  }
  const supernodeEntry = supernodeListDF.find(
    (node) => node.extKey === pastelID
  );
  if (!supernodeEntry) {
    throw new Error(
      `Supernode with PastelID ${pastelID} not found in the supernode list`
    );
  }
  const ipaddress = supernodeEntry["ipaddress_port"].split(":")[0];
  const supernodeURL = `http://${ipaddress}:7123`;
  return supernodeURL;
}

async function validatePastelIDSignatureFields(
  modelInstance,
  validationErrors
) {
  let lastSignatureFieldName = null;
  let lastHashFieldName = null;
  let firstPastelID;
  let pastelID, messageToVerify, signature;

  const fields = modelInstance.dataValues
    ? modelInstance.dataValues
    : modelInstance;
  for (const fieldName in fields) {
    if (
      fieldName.toLowerCase().includes("_pastelid") &&
      fields[fieldName] !== "NA"
    ) {
      firstPastelID = fields[fieldName];
      break;
    }
  }
  for (const fieldName in fields) {
    if (fieldName.includes("_signature_on_")) {
      lastSignatureFieldName = fieldName;
    } else if (
      fieldName.includes("sha3_256_hash_of_") &&
      fieldName.endsWith("_fields")
    ) {
      lastHashFieldName = fieldName;
    }
  }
  const embeddedField =
    fields[
    "supernode_pastelid_and_signature_on_inference_request_response_hash"
    ];
  if (embeddedField) {
    try {
      const parsedData = JSON.parse(embeddedField);
      firstPastelID = parsedData["signing_sn_pastelid"];
      signature = parsedData["sn_signature_on_response_hash"];
    } catch (e) {
      validationErrors.push(
        "Error parsing JSON from signature field: " + e.message
      );
      return;
    }
  }
  if (
    firstPastelID &&
    lastHashFieldName &&
    lastSignatureFieldName &&
    signature
  ) {
    pastelID = firstPastelID;
    messageToVerify = fields[lastHashFieldName];
    if (!embeddedField) {
      signature = fields[lastSignatureFieldName];
    }
    const verificationResult = await verifyMessageWithPastelID(
      pastelID,
      messageToVerify,
      signature
    );
    if (verificationResult !== "OK") {
      validationErrors.push(
        `PastelID signature in field ${lastSignatureFieldName} failed verification`
      );
    }
  } else {
    validationErrors.push(`Necessary fields for validation are missing`);
  }
}

async function getClosestSupernodeToPastelIDURL(
  inputPastelID,
  supernodeListDF,
  maxResponseTimeInMilliseconds = 1200
) {
  logger.info(
    `Attempting to find closest supernode for PastelID: ${inputPastelID}`
  );
  if (!inputPastelID) {
    logger.warn("No input PastelID provided");
    return { url: null, pastelID: null };
  }
  await initializeSupernodeCacheStorage();
  const filteredSupernodes = await filterSupernodes(
    supernodeListDF,
    maxResponseTimeInMilliseconds
  );
  if (filteredSupernodes.length > 0) {
    const closestSupernodePastelID = await getClosestSupernodePastelIDFromList(
      inputPastelID,
      filteredSupernodes,
      maxResponseTimeInMilliseconds
    );
    if (!closestSupernodePastelID) {
      logger.warn("No closest supernode PastelID found");
      return { url: null, pastelID: null };
    }

    const closestSupernode = supernodeListDF.find(
      (supernode) => supernode.extKey === closestSupernodePastelID
    );

    if (closestSupernode) {
      const supernodeURL = `http://${closestSupernode.ipaddress_port.split(":")[0]
        }:7123`;
      try {
        await axios.get(supernodeURL, {
          timeout: maxResponseTimeInMilliseconds,
        });
        return { url: supernodeURL, pastelID: closestSupernodePastelID };
      } catch (error) {
        return { url: null, pastelID: null };
      }
    }
  }
  logger.warn("No filtered supernodes available");
  return { url: null, pastelID: null };
}
async function getNClosestSupernodesToPastelIDURLs(
  n,
  inputPastelID,
  supernodeListDF,
  maxResponseTimeInMilliseconds = 800
) {
  if (!inputPastelID) {
    logger.warn("No input PastelID provided");
    return [];
  }

  await initializeSupernodeCacheStorage();

  try {
    const filteredSupernodes = await filterSupernodes(
      supernodeListDF,
      maxResponseTimeInMilliseconds
    );

    if (filteredSupernodes.length === 0) {
      logger.warn("No filtered supernodes available");
      return [];
    }

    const xorDistances = await Promise.all(
      filteredSupernodes.map(async (supernode) => {
        try {
          const distance = await calculateXORDistance(
            inputPastelID,
            supernode.pastelID
          );
          return { ...supernode, distance };
        } catch (error) {
          logger.error(
            `Error calculating XOR distance for supernode ${supernode.pastelID}: ${error.message}`
          );
          return null;
        }
      })
    );

    const validXorDistances = xorDistances.filter(Boolean);

    if (validXorDistances.length === 0) {
      logger.warn("No valid XOR distances calculated");
      return [];
    }

    const sortedXorDistances = validXorDistances.sort((a, b) => {
      if (a.distance < b.distance) return -1;
      if (a.distance > b.distance) return 1;
      return 0;
    });

    const closestSupernodes = sortedXorDistances.slice(0, n);

    const validSupernodePromises = closestSupernodes.map(
      async ({ url, pastelID }) => {
        try {
          await axios.get(url, {
            timeout: maxResponseTimeInMilliseconds,
            validateStatus: function (status) {
              return status >= 200 && status < 300; // Default
            },
          });
          return { url, pastelID };
        } catch (error) {
          return null;
        }
      }
    );

    const validSupernodes = (await Promise.all(validSupernodePromises)).filter(
      Boolean
    );

    if (validSupernodes.length === 0) {
      logger.warn("No valid supernodes found after connectivity check");
    } else {
      logger.info(`Found ${validSupernodes.length} valid supernodes`);
    }

    return validSupernodes;
  } catch (error) {
    logger.error(
      `Error in getNClosestSupernodesToPastelIDURLs: ${error.message}`
    );
    return [];
  }
}

async function validateCreditPackTicketMessageData(modelInstance) {
  const validationErrors = [];
  validateTimestampFields(modelInstance, validationErrors);
  await validatePastelBlockHeightFields(modelInstance, validationErrors);
  await validateHashFields(modelInstance, validationErrors);
  await validatePastelIDSignatureFields(modelInstance, validationErrors);
  return validationErrors;
}

function validateInferenceResponseFields(
  responseAuditResults,
  usageRequestResponse
) {
  const inferenceResponseIDCounts = {};
  const inferenceRequestIDCounts = {};
  const proposedCostInCreditsCounts = {};
  const remainingCreditsAfterRequestCounts = {};
  const creditUsageTrackingPSLAddressCounts = {};
  const requestConfirmationMessageAmountInPatoshisCounts = {};
  const maxBlockHeightToIncludeConfirmationTransactionCounts = {};
  const supernodePastelIDAndSignatureOnInferenceResponseIDCounts = {};

  for (const result of responseAuditResults) {
    inferenceResponseIDCounts[result.inference_response_id] =
      (inferenceResponseIDCounts[result.inference_response_id] || 0) + 1;
    inferenceRequestIDCounts[result.inference_request_id] =
      (inferenceRequestIDCounts[result.inference_request_id] || 0) + 1;
    proposedCostInCreditsCounts[
      result.proposed_cost_of_request_in_inference_credits
    ] =
      (proposedCostInCreditsCounts[
        result.proposed_cost_of_request_in_inference_credits
      ] || 0) + 1;
    remainingCreditsAfterRequestCounts[
      result.remaining_credits_in_pack_after_request_processed
    ] =
      (remainingCreditsAfterRequestCounts[
        result.remaining_credits_in_pack_after_request_processed
      ] || 0) + 1;
    creditUsageTrackingPSLAddressCounts[
      result.credit_usage_tracking_psl_address
    ] =
      (creditUsageTrackingPSLAddressCounts[
        result.credit_usage_tracking_psl_address
      ] || 0) + 1;
    requestConfirmationMessageAmountInPatoshisCounts[
      result.request_confirmation_message_amount_in_patoshis
    ] =
      (requestConfirmationMessageAmountInPatoshisCounts[
        result.request_confirmation_message_amount_in_patoshis
      ] || 0) + 1;
    maxBlockHeightToIncludeConfirmationTransactionCounts[
      result.max_block_height_to_include_confirmation_transaction
    ] =
      (maxBlockHeightToIncludeConfirmationTransactionCounts[
        result.max_block_height_to_include_confirmation_transaction
      ] || 0) + 1;
    supernodePastelIDAndSignatureOnInferenceResponseIDCounts[
      result.supernode_pastelid_and_signature_on_inference_request_response_hash
    ] =
      (supernodePastelIDAndSignatureOnInferenceResponseIDCounts[
        result
          .supernode_pastelid_and_signature_on_inference_request_response_hash
      ] || 0) + 1;
  }

  const majorityInferenceResponseID = Object.keys(
    inferenceResponseIDCounts
  ).reduce((a, b) =>
    inferenceResponseIDCounts[a] > inferenceResponseIDCounts[b] ? a : b
  );
  const majorityInferenceRequestID = Object.keys(
    inferenceRequestIDCounts
  ).reduce((a, b) =>
    inferenceRequestIDCounts[a] > inferenceRequestIDCounts[b] ? a : b
  );
  const majorityProposedCostInCredits = Object.keys(
    proposedCostInCreditsCounts
  ).reduce((a, b) =>
    proposedCostInCreditsCounts[a] > proposedCostInCreditsCounts[b] ? a : b
  );
  const majorityRemainingCreditsAfterRequest = Object.keys(
    remainingCreditsAfterRequestCounts
  ).reduce((a, b) =>
    remainingCreditsAfterRequestCounts[a] >
      remainingCreditsAfterRequestCounts[b]
      ? a
      : b
  );
  const majorityCreditUsageTrackingPSLAddress = Object.keys(
    creditUsageTrackingPSLAddressCounts
  ).reduce((a, b) =>
    creditUsageTrackingPSLAddressCounts[a] >
      creditUsageTrackingPSLAddressCounts[b]
      ? a
      : b
  );
  const majorityRequestConfirmationMessageAmountInPatoshis = Object.keys(
    requestConfirmationMessageAmountInPatoshisCounts
  ).reduce((a, b) =>
    requestConfirmationMessageAmountInPatoshisCounts[a] >
      requestConfirmationMessageAmountInPatoshisCounts[b]
      ? a
      : b
  );
  const majorityMaxBlockHeightToIncludeConfirmationTransaction = Object.keys(
    maxBlockHeightToIncludeConfirmationTransactionCounts
  ).reduce((a, b) =>
    maxBlockHeightToIncludeConfirmationTransactionCounts[a] >
      maxBlockHeightToIncludeConfirmationTransactionCounts[b]
      ? a
      : b
  );
  const majoritySupernodePastelIDAndSignatureOnInferenceResponseID =
    Object.keys(
      supernodePastelIDAndSignatureOnInferenceResponseIDCounts
    ).reduce((a, b) =>
      supernodePastelIDAndSignatureOnInferenceResponseIDCounts[a] >
        supernodePastelIDAndSignatureOnInferenceResponseIDCounts[b]
        ? a
        : b
    );

  const validationResults = {
    inference_response_id:
      majorityInferenceResponseID ===
      usageRequestResponse.inference_response_id,
    inference_request_id:
      majorityInferenceRequestID === usageRequestResponse.inference_request_id,
    proposed_cost_in_credits:
      majorityProposedCostInCredits ===
      usageRequestResponse.proposed_cost_of_request_in_inference_credits,
    remaining_credits_after_request:
      majorityRemainingCreditsAfterRequest ===
      usageRequestResponse.remaining_credits_in_pack_after_request_processed,
    credit_usage_tracking_psl_address:
      majorityCreditUsageTrackingPSLAddress ===
      usageRequestResponse.credit_usage_tracking_psl_address,
    request_confirmation_message_amount_in_patoshis:
      majorityRequestConfirmationMessageAmountInPatoshis ===
      usageRequestResponse.request_confirmation_message_amount_in_patoshis,
    max_block_height_to_include_confirmation_transaction:
      majorityMaxBlockHeightToIncludeConfirmationTransaction ===
      usageRequestResponse.max_block_height_to_include_confirmation_transaction,
    supernode_pastelid_and_signature_on_inference_response_id:
      majoritySupernodePastelIDAndSignatureOnInferenceResponseID ===
      usageRequestResponse.supernode_pastelid_and_signature_on_inference_request_response_hash,
  };

  return validationResults;
}

function validateInferenceResultFields(resultAuditResults, usageResult) {
  const inferenceResultIDCounts = {};
  const inferenceRequestIDCounts = {};
  const inferenceResponseIDCounts = {};
  const respondingSupernodePastelIDCounts = {};
  const inferenceResultJSONBase64Counts = {};
  const inferenceResultFileTypeStringsCounts = {};
  const respondingSupernodeSignatureOnInferenceResultIDCounts = {};

  for (const result of resultAuditResults) {
    inferenceResultIDCounts[result.inference_result_id] =
      (inferenceResultIDCounts[result.inference_result_id] || 0) + 1;
    inferenceRequestIDCounts[result.inference_request_id] =
      (inferenceRequestIDCounts[result.inference_request_id] || 0) + 1;
    inferenceResponseIDCounts[result.inference_response_id] =
      (inferenceResponseIDCounts[result.inference_response_id] || 0) + 1;
    respondingSupernodePastelIDCounts[result.responding_supernode_pastelid] =
      (respondingSupernodePastelIDCounts[
        result.responding_supernode_pastelid
      ] || 0) + 1;
    inferenceResultJSONBase64Counts[
      result.inference_result_json_base64.slice(0, 32)
    ] =
      (inferenceResultJSONBase64Counts[
        result.inference_result_json_base64.slice(0, 32)
      ] || 0) + 1;
    inferenceResultFileTypeStringsCounts[
      result.inference_result_file_type_strings
    ] =
      (inferenceResultFileTypeStringsCounts[
        result.inference_result_file_type_strings
      ] || 0) + 1;
    respondingSupernodeSignatureOnInferenceResultIDCounts[
      result.responding_supernode_signature_on_inference_result_id
    ] =
      (respondingSupernodeSignatureOnInferenceResultIDCounts[
        result.responding_supernode_signature_on_inference_result_id
      ] || 0) + 1;
  }

  const majorityInferenceResultID = Object.keys(inferenceResultIDCounts).reduce(
    (a, b) => (inferenceResultIDCounts[a] > inferenceResultIDCounts[b] ? a : b)
  );
  const majorityInferenceRequestID = Object.keys(
    inferenceRequestIDCounts
  ).reduce((a, b) =>
    inferenceRequestIDCounts[a] > inferenceRequestIDCounts[b] ? a : b
  );
  const majorityInferenceResponseID = Object.keys(
    inferenceResponseIDCounts
  ).reduce((a, b) =>
    inferenceResponseIDCounts[a] > inferenceResponseIDCounts[b] ? a : b
  );
  const majorityRespondingSupernodePastelID = Object.keys(
    respondingSupernodePastelIDCounts
  ).reduce((a, b) =>
    respondingSupernodePastelIDCounts[a] > respondingSupernodePastelIDCounts[b]
      ? a
      : b
  );
  const majorityInferenceResultJSONBase64 = Object.keys(
    inferenceResultJSONBase64Counts
  ).reduce((a, b) =>
    inferenceResultJSONBase64Counts[a] > inferenceResultJSONBase64Counts[b]
      ? a
      : b
  );
  const majorityInferenceResultFileTypeStrings = Object.keys(
    inferenceResultFileTypeStringsCounts
  ).reduce((a, b) =>
    inferenceResultFileTypeStringsCounts[a] >
      inferenceResultFileTypeStringsCounts[b]
      ? a
      : b
  );
  const majorityRespondingSupernodeSignatureOnInferenceResultID = Object.keys(
    respondingSupernodeSignatureOnInferenceResultIDCounts
  ).reduce((a, b) =>
    respondingSupernodeSignatureOnInferenceResultIDCounts[a] >
      respondingSupernodeSignatureOnInferenceResultIDCounts[b]
      ? a
      : b
  );

  const validationResults = {
    inference_result_id:
      majorityInferenceResultID === usageResult.inference_result_id,
    inference_request_id:
      majorityInferenceRequestID === usageResult.inference_request_id,
    inference_response_id:
      majorityInferenceResponseID === usageResult.inference_response_id,
    responding_supernode_pastelid:
      majorityRespondingSupernodePastelID ===
      usageResult.responding_supernode_pastelid,
    inference_result_json_base64:
      majorityInferenceResultJSONBase64 ===
      usageResult.inference_result_json_base64.slice(0, 32),
    inference_result_file_type_strings:
      majorityInferenceResultFileTypeStrings ===
      usageResult.inference_result_file_type_strings,
    responding_supernode_signature_on_inference_result_id:
      majorityRespondingSupernodeSignatureOnInferenceResultID ===
      usageResult.responding_supernode_signature_on_inference_result_id,
  };

  return validationResults;
}

function validateInferenceData(inferenceResultDict, auditResults) {
  const usageRequestResponse = inferenceResultDict.usage_request_response;
  const usageResult = inferenceResultDict.output_results;

  const responseValidationResults = validateInferenceResponseFields(
    auditResults.filter((result) => result.inference_response_id),
    usageRequestResponse
  );

  const resultValidationResults = validateInferenceResultFields(
    auditResults.filter((result) => result.inference_result_id),
    usageResult
  );

  const validationResults = {
    response_validation: responseValidationResults,
    result_validation: resultValidationResults,
  };

  return validationResults;
}

async function filterSupernodes(
  supernodeList,
  maxResponseTimeInMilliseconds = 700,
  minPerformanceRatio = 0.75,
  maxSupernodes = 130,
  totalTimeoutMs = 1100
) {
  const cacheKey = "filteredSupernodes";

  const stats = {
    totalProcessed: 0,
    removedDueToPing: 0,
    removedDueToPerformance: 0,
    removedDueToError: 0,
    timeouts: 0,
  };

  const logResults = () => {
    let USE_VERBOSE_LOGGING = false;
    const totalRemoved =
      stats.removedDueToPing +
      stats.removedDueToPerformance +
      stats.removedDueToError;
    const removedPercentage = (
      (totalRemoved / stats.totalProcessed) *
      100
    ).toFixed(2);
    if (USE_VERBOSE_LOGGING) {
      logger.info(`Total supernodes processed: ${stats.totalProcessed}`);
      logger.info(
        `Total supernodes removed: ${totalRemoved} (${removedPercentage}%)`
      );
      logger.info(`- Removed due to ping: ${stats.removedDueToPing}`);
      logger.info(
        `- Removed due to performance: ${stats.removedDueToPerformance}`
      );
      logger.info(`- Removed due to errors: ${stats.removedDueToError}`);
      if (stats.timeouts > 0) {
        logger.info(`Total timeouts: ${stats.timeouts}`);
      }
    }
  };

  const cachedData = await getFromCache(cacheKey);

  if (cachedData && cachedData.length >= maxSupernodes) {
    logger.info("Returning cached supernodes.");
    return cachedData.slice(0, maxSupernodes);
  }

  let fullSupernodeList = supernodeList;
  if (typeof supernodeList[0] === "string") {
    const { validMasternodeListFullDF } = await checkSupernodeList();
    fullSupernodeList = validMasternodeListFullDF.filter((supernode) =>
      supernodeList.includes(supernode.extKey)
    );
  }

  const filteredSupernodes = [];
  let completed = false;
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(150);

  const checkSupernode = async (supernode) => {
    stats.totalProcessed++;
    if (completed) return;
    const cacheKey = `supernode_${supernode.extKey}`;
    const cachedResult = await getFromCache(cacheKey);

    if (cachedResult) return cachedResult;

    try {
      const ipAddressPort = supernode.ipaddress_port;
      if (!ipAddressPort) return null;
      const ipAddress = ipAddressPort.split(":")[0];
      const pingResponse = await ping.promise.probe(ipAddress, {
        timeout: Math.ceil(maxResponseTimeInMilliseconds / 1000),
      });
      if (pingResponse.time > maxResponseTimeInMilliseconds) {
        stats.removedDueToPing++;
        return null;
      }
      const performanceResponse = await axios.get(
        `http://${ipAddress}:7123/liveness_ping`,
        {
          timeout: maxResponseTimeInMilliseconds,
        }
      );
      if (
        performanceResponse.data.performance_ratio_score < minPerformanceRatio
      ) {
        stats.removedDueToPerformance++;
        return null;
      }
      const result = {
        pastelID: supernode.extKey,
        url: `http://${ipAddress}:7123`,
      };
      await storeInCache(cacheKey, result);
      return result;
    } catch (error) {
      stats.removedDueToError++;
      return null;
    }
  };

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => {
      stats.timeouts++;
      reject(new Error("Operation timed out"));
    }, totalTimeoutMs)
  );

  try {
    await Promise.race([
      timeoutPromise,
      Promise.all(
        fullSupernodeList.map((supernode) =>
          limit(() =>
            checkSupernode(supernode).then((result) => {
              if (result) {
                filteredSupernodes.push(result);
                if (filteredSupernodes.length >= maxSupernodes) {
                  completed = true;
                }
              }
            })
          )
        )
      ),
    ]);
  } catch (error) {
    if (error.message !== "Operation timed out") {
      throw error;
    }
  }

  await storeInCache(cacheKey, filteredSupernodes);
  logResults();
  return filteredSupernodes.slice(0, maxSupernodes);
}

async function waitForConfirmation(checkFunction, ...checkFunctionArgs) {
  const options = {
    maxRetries: 30,
    retryDelay: 10000,
    actionName: "condition",
    ...(typeof checkFunctionArgs[checkFunctionArgs.length - 1] === "object"
      ? checkFunctionArgs.pop()
      : {}),
  };

  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await checkFunction(...checkFunctionArgs);
      if (result) {
        logger.info(
          `${options.actionName} confirmed after ${attempt} attempt(s).`
        );
        return true;
      }
    } catch (error) {
      logger.warn(
        `Error checking ${options.actionName} (attempt ${attempt}/${options.maxRetries}): ${error.message}`
      );
    }

    if (attempt < options.maxRetries) {
      logger.info(
        `${options.actionName} not yet confirmed. Attempt ${attempt}/${options.maxRetries
        }. Waiting ${options.retryDelay / 1000} seconds before next check...`
      );
      await new Promise((resolve) => setTimeout(resolve, options.retryDelay));
    }
  }

  logger.warn(
    `${options.actionName} not confirmed after ${options.maxRetries} attempts.`
  );
  return false;
}

async function waitForPastelIDRegistration(pastelID) {
  const isRegistered = await waitForConfirmation(
    isPastelIDRegistered,
    pastelID,
    {
      maxRetries: 20,
      retryDelay: 15000,
      actionName: "PastelID registration",
    }
  );

  if (isRegistered) {
    logger.info(`PastelID ${pastelID} has been successfully registered.`);
  } else {
    logger.error(`PastelID ${pastelID} registration could not be confirmed.`);
  }

  return isRegistered;
}

async function waitForCreditPackConfirmation(txid) {
  const isConfirmed = await waitForConfirmation(isCreditPackConfirmed, txid, {
    maxRetries: 40,
    retryDelay: 20000,
    actionName: "Credit pack confirmation",
  });

  if (isConfirmed) {
    logger.info(`Credit pack with TXID ${txid} has been confirmed.`);
  } else {
    logger.error(`Credit pack with TXID ${txid} could not be confirmed.`);
  }

  return isConfirmed;
}

async function importPromotionalPack(jsonFilePath) {
  logger.info(`Starting import of promotional pack from file: ${jsonFilePath}`);
  const processedPacks = [];

  try {
    // Initialize RPC connection
    logger.info("Initializing RPC connection...");
    await initializeRPCConnection();
    logger.info("RPC connection initialized successfully");

    // Read and parse the JSON file
    const jsonContent = fs.readFileSync(jsonFilePath, "utf8");
    let packData = JSON.parse(jsonContent);

    // Process each promotional pack in the file
    if (!Array.isArray(packData)) {
      packData = [packData]; // Wrap it in an array if it's not already
    }

    for (let i = 0; i < packData.length; i++) {
      const pack = packData[i];
      logger.info(`Processing pack ${i + 1} of ${packData.length}`);

      // 1. Save the PastelID secure container file
      const { rpcport } = await getLocalRPCSettings();
      const network =
        rpcport === "9932"
          ? "mainnet"
          : rpcport === "19932"
            ? "testnet"
            : "devnet";
      const pastelIDDir = getPastelIDDirectory(network);
      const secureContainerPath = path.join(pastelIDDir, pack.pastel_id_pubkey);

      logger.info(
        `Saving PastelID secure container to: ${secureContainerPath}`
      );
      fs.writeFileSync(
        secureContainerPath,
        Buffer.from(pack.secureContainerBase64, "base64")
      );

      // 2. Import the tracking address private key
      logger.info(
        `Importing private key for tracking address: ${pack.psl_credit_usage_tracking_address}`
      );

      const startingBlockHeight = 730000;
      const importResult = await importPrivKey(
        pack.psl_credit_usage_tracking_address_private_key,
        "Imported from promotional pack",
        true,
        startingBlockHeight
      );
      if (importResult) {
        logger.info(
          `Private key imported successfully for tracking address: ${importResult}`
        );
      } else {
        logger.warn("Failed to import private key");
      }

      // 3. Log other important information
      logger.info(`PastelID: ${pack.pastel_id_pubkey}`);
      logger.info(`Passphrase: ${pack.pastel_id_passphrase}`);
      logger.info(`Credit Pack Ticket: ${JSON.stringify(pack, null, 2)}`);

      // Add the processed pack info to our array
      processedPacks.push({
        pub_key: pack.pastel_id_pubkey,
        passphrase: pack.pastel_id_passphrase
      });

      logger.info(`Pack ${i + 1} processed successfully`);
    }

    // Wait for RPC connection to be re-established
    await waitForRPCConnection();

    // Verify PastelID import and wait for blockchain confirmation
    for (let i = 0; i < packData.length; i++) {
      const pack = packData[i];
      logger.info(`Verifying PastelID import for pack ${i + 1}`);

      try {
        // Wait for PastelID to be confirmed in the blockchain
        await waitForPastelIDRegistration(pack.pastel_id_pubkey);
        logger.info(
          `PastelID ${pack.pastel_id_pubkey} confirmed in blockchain`
        );

        // Verify PastelID functionality
        const testMessage = "This is a test message for PastelID verification";
        const signature = await signMessageWithPastelID(
          pack.pastel_id_pubkey,
          testMessage,
          pack.pastel_id_passphrase
        );
        logger.info(
          `Signature created successfully for PastelID: ${pack.pastel_id_pubkey}`
        );

        const verificationResult = await verifyMessageWithPastelID(
          pack.pastel_id_pubkey,
          testMessage,
          signature
        );

        if (verificationResult) {
          logger.info(
            `PastelID ${pack.pastel_id_pubkey} verified successfully`
          );
        } else {
          logger.warn(`PastelID ${pack.pastel_id_pubkey} verification failed`);
        }

        // Verify Credit Pack Ticket
        await waitForCreditPackConfirmation(pack.credit_pack_registration_txid);
        logger.info(
          `Credit Pack Ticket ${pack.credit_pack_registration_txid} confirmed in blockchain`
        );
      } catch (error) {
        logger.error(`Error verifying pack ${i + 1}: ${error.message}`);
      }
    }

    logger.info("All promo packs in the file have been processed and verified");
    return {
      success: true,
      message: "Promotional pack(s) imported and verified successfully",
      processedPacks: processedPacks
    };
  } catch (error) {
    logger.error(`Error importing promotional pack: ${error.message}`);
    return {
      success: false,
      message: `Failed to import promotional pack: ${error.message}`
    };
  }
}

module.exports = {
  fetchCurrentPSLMarketPrice,
  estimatedMarketPriceOfInferenceCreditsInPSLTerms,
  prettyJSON,
  logActionWithPayload,
  transformCreditPackPurchaseRequestResponse,
  computeSHA3256Hexdigest,
  getSHA256HashOfInputData,
  compressDataWithZstd,
  decompressDataWithZstd,
  calculateXORDistance,
  pythonCompatibleStringify,
  extractResponseFieldsFromCreditPackTicketMessageDataAsJSON,
  computeSHA3256HashOfSQLModelResponseFields,
  prepareModelForValidation,
  prepareModelForEndpoint,
  removeSequelizeFields,
  validateTimestampFields,
  validatePastelBlockHeightFields,
  validateHashFields,
  validatePastelIDSignatureFields,
  filterSupernodes,
  getClosestSupernodePastelIDFromList,
  checkIfPastelIDIsValid,
  getSupernodeUrlFromPastelID,
  getClosestSupernodeToPastelIDURL,
  getNClosestSupernodesToPastelIDURLs,
  validateCreditPackTicketMessageData,
  validateInferenceResponseFields,
  validateInferenceResultFields,
  validateInferenceData,
  logger,
  importPromotionalPack,
};
