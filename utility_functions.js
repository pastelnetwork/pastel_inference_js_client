require("dotenv").config();
const crypto = require("crypto");
const zstd = require("zstd-codec").ZstdCodec;
const axios = require("axios");
const Sequelize = require("sequelize");
const { logger, safeStringify } = require("./logger");

const {
  verifyMessageWithPastelID,
  getBestBlockHashAndMerkleRoot,
} = require("./rpc_functions");

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
      logger.error(`Error fetching PSL market prices: ${error.message}`);
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
    `The current Average PSL price is: $${averagePrice.toFixed(8)} based on ${
      prices.length
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
    if (typeof value === "string" && value.includes("\n")) {
      return value;
    }
    const parsedValue = typeof value === "string" ? JSON.parse(value) : value;
    return safeStringify(parsedValue, null, 4);
  } catch (error) {
    logger.error(`Error parsing and formatting value: ${error.message}`);
    return value;
  }
}

function prettyJSON(data) {
  if (typeof data === "object" && data !== null) {
    const formattedData = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.endsWith("_json")) {
        formattedData[key] = parseAndFormat(value);
      } else if (typeof value === "object" && value !== null) {
        formattedData[key] = prettyJSON(value);
      } else {
        formattedData[key] = value;
      }
    }
    return safeStringify(formattedData, null, 4);
  } else if (typeof data === "string") {
    return parseAndFormat(data);
  } else {
    return data;
  }
}

function logActionWithPayload(action, payloadName, jsonPayload) {
  logger.info(
    `Now ${action} ${payloadName} with payload:\n${prettyJSON(jsonPayload)}`
  );
}

function transformCreditPackPurchaseRequestResponse(result) {
  const transformedResult = { ...result };
  const fieldsToConvert = [
    "list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms",
    "list_of_agreeing_supernode_pastelids_signatures_on_price_agreement_request_response_hash",
    "list_of_agreeing_supernode_pastelids_signatures_on_credit_pack_purchase_request_fields_json",
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
  hash.update(inputData, "utf-8"); // Explicitly specifying the encoding
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
  // Correctly format spaces after colons and commas to match Python's json.dumps()
  // This regex replaces the colon followed by any amount of whitespace with ": "
  // and the comma followed by any amount of whitespace with ", "
  // Ensure it does not match colons within timestamps or other strings
  return jsonString.replace(/(?<!\d):(\s*)/g, ": ").replace(/,(\s*)/g, ", ");
}

function pythonCompatibleStringify(obj) {
  function sortObjectByKeys(unsortedObj) {
    return Object.keys(unsortedObj)
      .sort()
      .reduce(
        (acc, key) => {
          const value = unsortedObj[key];
          if (
            typeof value === "object" &&
            value !== null &&
            !(value instanceof Date)
          ) {
            acc[key] = Array.isArray(value)
              ? value.map((item) => sortObjectByKeys(item))
              : sortObjectByKeys(value);
          } else {
            acc[key] = value;
          }
          return acc;
        },
        Array.isArray(unsortedObj) ? [] : {}
      );
  }
  // Modified customReplacer to handle number conversion explicitly
  function customReplacer(key, value) {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "object" && value !== null) {
      return sortObjectByKeys(value);
    }
    // Ensure that numbers are not converted into strings
    if (typeof value === "number") {
      return value;
    }
    return value;
  }
  const sortedObject = sortObjectByKeys(obj);
  let jsonString = JSON.stringify(sortedObject, customReplacer);
  // Apply the spacing adjustment right before returning the string
  return adjustJSONSpacing(jsonString);
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
  let lastSignatureFieldName = null;
  for (const fieldName in plainObject) {
    if (fieldName.startsWith("sha3_256_hash_of")) {
      lastHashFieldName = fieldName;
    } else if (fieldName.includes("_signature_on_")) {
      lastSignatureFieldName = fieldName;
    }
  }
  Object.keys(plainObject)
    .sort()
    .forEach((fieldName) => {
      if (
        ![
          lastHashFieldName,
          lastSignatureFieldName,
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
        } else if (typeof fieldValue === "object" && fieldValue !== null) {
          responseFields[fieldName] = fieldValue;
        } else {
          // Ensure numeric fields are not converted to strings
          responseFields[fieldName] =
            typeof fieldValue === "number" ? fieldValue : fieldValue.toString();
        }
      }
    });
  return pythonCompatibleStringify(responseFields);
}

async function computeSHA3256HashOfSQLModelResponseFields(modelInstance) {
  const responseFieldsJSON =
    await extractResponseFieldsFromCreditPackTicketMessageDataAsJSON(
      modelInstance
    );
  const sha256HashOfResponseFields =
    getSHA256HashOfInputData(responseFieldsJSON);
  return sha256HashOfResponseFields;
}

async function prepareModelForEndpoint(modelInstance) {
  let preparedModelInstance;
  // Check if modelInstance is a Sequelize model or similar
  if (typeof modelInstance.get === "function") {
    let modelInstanceJSON = pythonCompatibleStringify(
      modelInstance.get({ plain: true })
    );
    preparedModelInstance = JSON.parse(modelInstanceJSON);
  } else if (typeof modelInstance === "object") {
    // Assume modelInstance is already a plain object and needs JSON handling
    let modelInstanceJSON = pythonCompatibleStringify(modelInstance);
    preparedModelInstance = JSON.parse(modelInstanceJSON);
  } else {
    throw new Error("Invalid modelInstance type");
  }
  return preparedModelInstance;
}

async function prepareModelForValidation(modelInstance) {
  let preparedModelInstance;
  // Check if modelInstance is a Sequelize model or similar
  if (typeof modelInstance.get === "function") {
    preparedModelInstance = modelInstance.get({ plain: true });
  } else if (typeof modelInstance === "object") {
    preparedModelInstance = { ...modelInstance };
  } else {
    throw new Error("Invalid modelInstance type");
  }
  // Dynamically parse properties ending with `_json` if they are strings
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
  supernodePastelIDs
) {
  const xorDistances = await Promise.all(
    supernodePastelIDs.map(async (supernodePastelID) => {
      const distance = await calculateXORDistance(
        localPastelID,
        supernodePastelID
      );
      return { pastelID: supernodePastelID, distance };
    })
  );
  const sortedXorDistances = xorDistances.sort(
    (a, b) => a.distance - b.distance
  );
  return sortedXorDistances[0].pastelID;
}

function checkIfPastelIDIsValid(inputString) {
  // Define the regex pattern to match the conditions:
  // Starts with 'jX'; Followed by characters that are only alphanumeric and are shown in the example;
  const pattern = /^jX[A-Za-z0-9]{84}$/;
  return pattern.test(inputString);
}

async function getSupernodeUrlFromPastelID(pastelID, supernodeListDF) {
  const isValidPastelID = checkIfPastelIDIsValid(pastelID); // Ensure this function is defined to validate PastelIDs
  if (!isValidPastelID) {
    throw new Error(`Invalid PastelID: ${pastelID}`);
  }
  // Find the supernode entry with the matching 'extKey'
  const supernodeEntry = supernodeListDF.find(
    (node) => node.extKey === pastelID
  );
  if (!supernodeEntry) {
    throw new Error(
      `Supernode with PastelID ${pastelID} not found in the supernode list`
    );
  }
  // Extract the IP address from the 'ipaddress_port' string
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

  for (const fieldName in modelInstance) {
    if (fieldName.includes("_pastelid")) {
      firstPastelID = fieldName;
      break;
    }
  }

  for (const fieldName in modelInstance) {
    if (fieldName.includes("_signature_on_")) {
      lastSignatureFieldName = fieldName;
    } else if (
      fieldName.includes("sha3_256_hash_of_") &&
      fieldName.endsWith("_fields")
    ) {
      lastHashFieldName = fieldName;
    }
  }

  if (lastSignatureFieldName && lastHashFieldName) {
    if (firstPastelID || firstPastelID === "NA") {
      let pastelID, messageToVerify, signature;

      if (firstPastelID === "NA") {
        const pastelIDAndSignatureCombinedFieldName = lastSignatureFieldName;
        const pastelIDAndSignatureCombinedFieldJSON =
          modelInstance[pastelIDAndSignatureCombinedFieldName];
        const pastelIDAndSignatureCombinedFieldDict = JSON.parse(
          pastelIDAndSignatureCombinedFieldJSON
        );

        for (const key in pastelIDAndSignatureCombinedFieldDict) {
          if (key.includes("pastelid")) {
            pastelID = pastelIDAndSignatureCombinedFieldDict[key];
          }
          if (key.includes("signature")) {
            signature = pastelIDAndSignatureCombinedFieldDict[key];
          }
        }

        messageToVerify = modelInstance[lastHashFieldName];
      } else {
        pastelID = modelInstance[firstPastelID];
        messageToVerify = modelInstance[lastHashFieldName];
        signature = modelInstance[lastSignatureFieldName];
      }

      const { error } = messageSchema.validate({
        pastelid: pastelID,
        messageToVerify,
        pastelIDSignatureOnMessage: signature,
      });
      if (error) {
        validationErrors.push(
          `Invalid data for verifyMessageWithPastelID: ${safeStringify(
            error.message
          )}`
        );
      } else {
        const verificationResult = await verifyMessageWithPastelID(
          pastelID,
          messageToVerify,
          signature
        );
        if (verificationResult !== "OK") {
          validationErrors.push(
            `Pastelid signature in field ${lastSignatureFieldName} failed verification`
          );
        }
      }
    } else {
      validationErrors.push(
        `Corresponding pastelid field ${firstPastelID} not found for signature field ${lastSignatureFieldName}`
      );
    }
  }
}

async function getNClosestSupernodesToPastelIDURLs(
  n,
  inputPastelID,
  supernodeListDF
) {
  const xorDistances = await Promise.all(
    supernodeListDF.map(async ({ extKey, ipaddress_port: ipAddressPort }) => {
      const distance = await calculateXORDistance(inputPastelID, extKey);
      return {
        pastelID: extKey,
        url: `http://${ipAddressPort.split(":")[0]}:7123`,
        distance,
      };
    })
  );
  const sortedXorDistances = xorDistances.sort((a, b) => {
    if (a.distance > b.distance) return 1;
    if (a.distance < b.distance) return -1;
    return 0;
  });
  const closestSupernodes = sortedXorDistances.slice(0, n);
  return closestSupernodes.map(({ url, pastelID }) => ({ url, pastelID }));
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
  validateTimestampFields,
  validatePastelBlockHeightFields,
  validateHashFields,
  validatePastelIDSignatureFields,
  getClosestSupernodePastelIDFromList,
  checkIfPastelIDIsValid,
  getSupernodeUrlFromPastelID,
  getNClosestSupernodesToPastelIDURLs,
  validateCreditPackTicketMessageData,
  validateInferenceResponseFields,
  validateInferenceResultFields,
  validateInferenceData,
  logger,
};
