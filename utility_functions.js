const crypto = require("crypto");
const zstd = require("zstd-codec").ZstdCodec;
const axios = require("axios");
const winston = require("winston");
const {
  Message,
  UserMessage,
  CreditPackPurchaseRequest,
  CreditPackPurchaseRequestRejection,
  CreditPackPurchaseRequestPreliminaryPriceQuote,
  CreditPackPurchaseRequestPreliminaryPriceQuoteResponse,
  CreditPackPurchaseRequestResponseTermination,
  CreditPackPurchaseRequestResponse,
  CreditPackPurchaseRequestConfirmation,
  CreditPackRequestStatusCheck,
  CreditPackPurchaseRequestStatus,
  CreditPackStorageRetryRequest,
  CreditPackStorageRetryRequestResponse,
  InferenceAPIUsageRequest,
  InferenceAPIUsageResponse,
  InferenceAPIOutputResult,
  InferenceConfirmation,
} = require("./sequelize_data_models");

const {
  supernodeListSchema,  
  messageSchema,
  userMessageSchema,
  creditPackPurchaseRequestSchema,
  creditPackPurchaseRequestRejectionSchema,
  creditPackPurchaseRequestPreliminaryPriceQuoteSchema,
  creditPackPurchaseRequestPreliminaryPriceQuoteResponseSchema,
  creditPackPurchaseRequestResponseTerminationSchema,
  creditPackPurchaseRequestResponseSchema,
  creditPackPurchaseRequestConfirmationSchema,
  creditPackRequestStatusCheckSchema,
  creditPackPurchaseRequestStatusSchema,
  creditPackStorageRetryRequestSchema,
  creditPackStorageRetryRequestResponseSchema,
  inferenceAPIUsageRequestSchema,
  inferenceAPIUsageResponseSchema,
  inferenceAPIOutputResultSchema,
  inferenceConfirmationSchema,
} = require("./validation_schemas");

const {
  TARGET_VALUE_PER_CREDIT_IN_USD,
  TARGET_PROFIT_MARGIN,
  MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING,
  MAXIMUM_LOCAL_PASTEL_BLOCK_HEIGHT_DIFFERENCE_IN_BLOCKS,
} = require("./constants");

// Logging setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
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
        responseCMC.data.match(/price today is \$([0-9\.]+) USD/)[1]
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
      `Error calculating estimated market price of inference credits: ${error.message}`
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
    return JSON.stringify(parsedValue, null, 4);
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
    return JSON.stringify(formattedData, null, 4);
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

async function checkSupernodeList() {
    try {
      const [
        masternodeListFull,
        masternodeListRank,
        masternodeListPubkey,
        masternodeListExtra,
      ] = await Promise.all([
        rpc_connection.call("masternodelist", "full"),
        rpc_connection.call("masternodelist", "rank"),
        rpc_connection.call("masternodelist", "pubkey"),
        rpc_connection.call("masternodelist", "extra"),
      ]);
  
      const masternodeListFullData = Object.entries(masternodeListFull).map(
        ([txidVout, data]) => {
          const [
            supernodeStatus,
            protocolVersion,
            supernodePslAddress,
            lastSeenTime,
            activeSeconds,
            lastPaidTime,
            lastPaidBlock,
            ipAddressPort,
          ] = data.split(" ");
  
          return {
            supernode_status: supernodeStatus,
            protocol_version: Number(protocolVersion),
            supernode_psl_address: supernodePslAddress,
            lastseentime: Number(lastSeenTime),
            activeseconds: Number(activeSeconds),
            lastpaidtime: Number(lastPaidTime),
            lastpaidblock: Number(lastPaidBlock),
            "ipaddress:port": ipAddressPort,
            txid_vout: txidVout,
          };
        }
      );
  
      const masternodeListFullDF = masternodeListFullData.map((data) => {
        const { txid_vout, ...rest } = data;
        const rank = masternodeListRank[txid_vout];
        const pubkey = masternodeListPubkey[txid_vout];
        const extra = masternodeListExtra[txid_vout];
  
        return {
          ...rest,
          rank: Number(rank),
          pubkey,
          extAddress: extra.extAddress,
          extP2P: extra.extP2P,
          extKey: extra.extKey,
          activedays: Number(rest.activeseconds) / 86400,
        };
      });
  
      const validMasternodeListFullDF = masternodeListFullDF.filter(
        (data) =>
          ["ENABLED", "PRE_ENABLED"].includes(data.supernode_status) &&
          data["ipaddress:port"] !== "154.38.164.75:29933"
      );
  
      const { error } = supernodeListSchema.validate(validMasternodeListFullDF[0]);
      if (error) {
        throw new Error(`Invalid supernode list data: ${error.message}`);
      }
  
      const masternodeListFullDFJSON = JSON.stringify(
        Object.fromEntries(
          validMasternodeListFullDF.map((data) => [data.txid_vout, data])
        )
      );
  
      return { supernodeListDF: validMasternodeListFullDF, supernodeListJSON: masternodeListFullDFJSON };
    } catch (error) {
      logger.error(`Error in checkSupernodeList: ${error.message}`);
      throw error;
    }
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
      transformedResult[field] = JSON.stringify(transformedResult[field]);
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
  hash.update(inputData);
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

async function extractResponseFieldsFromCreditPackTicketMessageDataAsJSON(
  modelInstance
) {
  const responseFields = {};
  let lastHashFieldName = null;
  let lastSignatureFieldName = null;

  for (const fieldName in modelInstance) {
    if (fieldName.startsWith("sha3_256_hash_of")) {
      lastHashFieldName = fieldName;
    } else if (fieldName.includes("_signature_on_")) {
      lastSignatureFieldName = fieldName;
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(modelInstance)) {
    if (
      fieldName === lastHashFieldName ||
      fieldName === lastSignatureFieldName ||
      fieldName === "id" ||
      fieldName.includes("_sa_instance_state")
    ) {
      continue;
    }
    if (fieldValue !== null && fieldValue !== undefined) {
      if (fieldValue instanceof Date) {
        responseFields[fieldName] = fieldValue.toISOString();
      } else if (Array.isArray(fieldValue) || typeof fieldValue === "object") {
        responseFields[fieldName] = JSON.stringify(
          fieldValue,
          Object.keys(fieldValue).sort()
        );
      } else {
        responseFields[fieldName] = fieldValue.toString();
      }
    }
  }
  const sortedResponseFields = Object.fromEntries(
    Object.entries(responseFields).sort(([a], [b]) => a.localeCompare(b))
  );
  return JSON.stringify(sortedResponseFields);
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

  async function getClosestSupernodePastelIDFromList(localPastelID, supernodePastelIDs) {
    const xorDistances = await Promise.all(
      supernodePastelIDs.map(async (supernodePastelID) => {
        const distance = await calculateXORDistance(localPastelID, supernodePastelID);
        return { pastelID: supernodePastelID, distance };
      })
    );
  
    const sortedXorDistances = xorDistances.sort((a, b) => a.distance - b.distance);
    return sortedXorDistances[0].pastelID;
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
          `Invalid data for verifyMessageWithPastelID: ${error.message}`
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
    supernodeListDF.map(async ({ extKey, "ipaddress:port": ipAddressPort }) => {
      const distance = await calculateXORDistance(inputPastelID, extKey);
      return {
        pastelID: extKey,
        url: `http://${ipAddressPort.split(":")[0]}:7123`,
        distance,
      };
    })
  );

  const sortedXorDistances = xorDistances.sort(
    (a, b) => a.distance - b.distance
  );
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
  checkSupernodeList,
  transformCreditPackPurchaseRequestResponse,
  computeSHA3256Hexdigest,
  getSHA256HashOfInputData,
  compressDataWithZstd,
  decompressDataWithZstd,
  calculateXORDistance,
  extractResponseFieldsFromCreditPackTicketMessageDataAsJSON,
  computeSHA3256HashOfSQLModelResponseFields,
  validateTimestampFields,
  validatePastelBlockHeightFields,
  validateHashFields,
  validatePastelIDSignatureFields,
  getClosestSupernodePastelIDFromList,  
  getNClosestSupernodesToPastelIDURLs,
  validateCreditPackTicketMessageData,
  validateInferenceResponseFields,
  validateInferenceResultFields,
  validateInferenceData,
};
