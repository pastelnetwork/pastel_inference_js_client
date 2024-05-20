require("dotenv").config();
const crypto = require("crypto");
const {
  UserMessage,
  CreditPackPurchaseRequest,
  CreditPackPurchaseRequestResponseTermination,
  CreditPackPurchaseRequestResponse,
  CreditPackPurchaseRequestConfirmation,
  CreditPackPurchaseRequestConfirmationResponse,
  CreditPackStorageRetryRequest,
  InferenceAPIUsageRequest,
  InferenceConfirmation,
} = require("./sequelize_data_models");
const {
  userMessageSchema,
  creditPackPurchaseRequestResponseSchema,
  creditPackPurchaseRequestConfirmationSchema,
  creditPackPurchaseRequestConfirmationResponseSchema,
  creditPackPurchaseRequestStatusSchema,
  creditPackStorageRetryRequestSchema,
  creditPackStorageRetryRequestResponseSchema,
  inferenceAPIUsageRequestSchema,
  inferenceAPIUsageResponseSchema,
  inferenceAPIOutputResultSchema,
  inferenceConfirmationSchema,
} = require("./validation_schemas");
const { logger, safeStringify } = require("./logger");
const {
  signMessageWithPastelID,
  checkSupernodeList,
  getCurrentPastelBlockHeight,
  sendToAddress,
  sendTrackingAmountFromControlAddressToBurnAddressToConfirmInferenceRequest,
  checkPSLAddressBalanceAlternative,
} = require("./rpc_functions");
const { PastelInferenceClient } = require("./pastel_inference_client");
const {
  prettyJSON,
  getNClosestSupernodesToPastelIDURLs,
  validateCreditPackTicketMessageData,
  validateInferenceData,
  computeSHA3256HashOfSQLModelResponseFields,
  checkIfPastelIDIsValid,
  getSupernodeUrlFromPastelID,
  getClosestSupernodePastelIDFromList,
  getClosestSupernodeToPastelIDURL,
} = require("./utility_functions");

const MY_LOCAL_PASTELID = process.env.MY_LOCAL_PASTELID;
const MY_PASTELID_PASSPHRASE = process.env.MY_PASTELID_PASSPHRASE;

async function checkForNewIncomingMessages() {
  try {
    const inferenceClient = new PastelInferenceClient(
      MY_LOCAL_PASTELID,
      MY_PASTELID_PASSPHRASE
    );
    const { validMasternodeListFullDF } = await checkSupernodeList();

    logger.info("Retrieving incoming user messages...");
    logger.info(`My local pastelid: ${inferenceClient.pastelID}`);

    const closestSupernodesToLocal = await getNClosestSupernodesToPastelIDURLs(
      3,
      inferenceClient.pastelID,
      validMasternodeListFullDF
    );
    logger.info(
      `Closest Supernodes to local pastelid: ${closestSupernodesToLocal.map(
        (sn) => sn.pastelID
      )}`
    );

    const messageRetrievalTasks = closestSupernodesToLocal.map(({ url }) =>
      inferenceClient.getUserMessages(url).catch((error) => {
        logger.warn(
          `Failed to retrieve messages from supernode ${url}: ${error.message}`
        );
        return []; // Return an empty array on error
      })
    );
    const messageLists = await Promise.all(messageRetrievalTasks);

    const uniqueMessages = [];
    const messageIDs = new Set();
    for (const messageList of messageLists) {
      for (const message of messageList) {
        if (!messageIDs.has(message.id)) {
          uniqueMessages.push(message);
          messageIDs.add(message.id);
        }
      }
    }

    logger.info(
      `Retrieved unique user messages: ${safeStringify(uniqueMessages)}`
    );

    return uniqueMessages;
  } catch (error) {
    logger.error(`Error in checkForNewIncomingMessages: ${error.message}`);
    throw error;
  }
}

async function sendMessageAndCheckForNewIncomingMessages(
  toPastelID,
  messageBody
) {
  try {
    const inferenceClient = new PastelInferenceClient(
      MY_LOCAL_PASTELID,
      MY_PASTELID_PASSPHRASE
    );
    const { validMasternodeListFullDF, _ } = await checkSupernodeList();

    logger.info("Sending user message...");
    logger.info(`Recipient pastelid: ${toPastelID}`);

    const closestSupernodesToRecipient =
      await getNClosestSupernodesToPastelIDURLs(
        3,
        toPastelID,
        validMasternodeListFullDF
      );
    logger.info(
      `Closest Supernodes to recipient pastelid: ${closestSupernodesToRecipient.map(
        (sn) => sn.pastelID
      )}`
    );

    const userMessage = UserMessage.build({
      from_pastelid: MY_LOCAL_PASTELID,
      to_pastelid: toPastelID,
      message_body: safeStringify(messageBody),
      message_signature: await signMessageWithPastelID(
        MY_LOCAL_PASTELID,
        messageBody,
        MY_PASTELID_PASSPHRASE
      ),
    });

    const { error } = userMessageSchema.validate(userMessage.toJSON());
    if (error) {
      throw new Error(`Invalid user message: ${error.message}`);
    }

    const sendTasks = closestSupernodesToRecipient.map(({ url }) =>
      inferenceClient.sendUserMessage(url, userMessage)
    );
    const sendResults = await Promise.all(sendTasks);
    logger.info(`Sent user messages: ${safeStringify(sendResults)}`);

    // Now call the new function to check for incoming messages
    const receivedMessages = await checkForNewIncomingMessages();

    const messageDict = {
      sent_messages: sendResults,
      received_messages: receivedMessages,
    };

    return messageDict;
  } catch (error) {
    logger.error(
      `Error in sendMessageAndCheckForNewIncomingMessages: ${error.message}`
    );
    throw error;
  }
}

function getIsoStringWithMicroseconds() {
  // Get the current time
  const now = new Date();
  // Convert the date to an ISO string and replace 'Z' with '+00:00' to match Python's format
  // Ensure to remove any unwanted spaces directly in this step if they were somehow introduced
  const isoString = now.toISOString().replace("Z", "+00:00").replace(/\s/g, "");
  // Return the correctly formatted ISO string without any spaces
  return isoString;
}

async function handleCreditPackTicketEndToEnd(
  numberOfCredits,
  creditUsageTrackingPSLAddress,
  burnAddress,
  maximumTotalCreditPackPriceInPSL,
  maximumPerCreditPriceInPSL
) {
  try {
    const inferenceClient = new PastelInferenceClient(
      MY_LOCAL_PASTELID,
      MY_PASTELID_PASSPHRASE
    );
    const { validMasternodeListFullDF, _ } = await checkSupernodeList();

    const requestTimestamp = getIsoStringWithMicroseconds();

    const creditPackRequest = CreditPackPurchaseRequest.build({
      requesting_end_user_pastelid: MY_LOCAL_PASTELID,
      requested_initial_credits_in_credit_pack: parseInt(numberOfCredits, 10),
      list_of_authorized_pastelids_allowed_to_use_credit_pack: JSON.stringify([
        MY_LOCAL_PASTELID,
      ]),
      credit_usage_tracking_psl_address: creditUsageTrackingPSLAddress,
      request_timestamp_utc_iso_string: requestTimestamp,
      request_pastel_block_height: parseInt(
        await getCurrentPastelBlockHeight(),
        10
      ),
      credit_purchase_request_message_version_string: "1.0",
      sha3_256_hash_of_credit_pack_purchase_request_fields: "",
      requesting_end_user_pastelid_signature_on_request_hash: "",
    });

    creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields =
      await computeSHA3256HashOfSQLModelResponseFields(creditPackRequest);
    creditPackRequest.requesting_end_user_pastelid_signature_on_request_hash =
      await signMessageWithPastelID(
        MY_LOCAL_PASTELID,
        creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields,
        MY_PASTELID_PASSPHRASE
      );

    const closestSupernodes = await getNClosestSupernodesToPastelIDURLs(
      1,
      MY_LOCAL_PASTELID,
      validMasternodeListFullDF
    );
    const highestRankedSupernodeURL = closestSupernodes[0].url;

    const preliminaryPriceQuote =
      await inferenceClient.creditPackTicketInitialPurchaseRequest(
        highestRankedSupernodeURL,
        creditPackRequest
      );

    const signedCreditPackTicketOrRejection =
      await inferenceClient.creditPackTicketPreliminaryPriceQuoteResponse(
        highestRankedSupernodeURL,
        creditPackRequest,
        preliminaryPriceQuote,
        maximumTotalCreditPackPriceInPSL,
        maximumPerCreditPriceInPSL
      );

    if (
      signedCreditPackTicketOrRejection instanceof
      CreditPackPurchaseRequestResponseTermination
    ) {
      logger.error(
        `Credit pack purchase request terminated: ${signedCreditPackTicketOrRejection.termination_reason_string}`
      );
      return null;
    }

    const signedCreditPackTicket = signedCreditPackTicketOrRejection;

    const burnTransactionTxid = await sendToAddress(
      burnAddress,
      Math.round(
        signedCreditPackTicket.proposed_total_cost_of_credit_pack_in_psl *
          100000
      ) / 100000,
      "Burn transaction for credit pack ticket"
    );
    if (!burnTransactionTxid) {
      logger.error("Error sending PSL to burn address for credit pack ticket");
      return null;
    }
    const creditPackPurchaseRequestConfirmation =
      CreditPackPurchaseRequestConfirmation.build({
        sha3_256_hash_of_credit_pack_purchase_request_fields:
          creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields,
        sha3_256_hash_of_credit_pack_purchase_request_response_fields:
          signedCreditPackTicket.sha3_256_hash_of_credit_pack_purchase_request_response_fields,
        credit_pack_purchase_request_fields_json_b64:
          signedCreditPackTicket.credit_pack_purchase_request_fields_json_b64,
        requesting_end_user_pastelid: MY_LOCAL_PASTELID,
        txid_of_credit_purchase_burn_transaction: burnTransactionTxid,
        credit_purchase_request_confirmation_utc_iso_string:
          new Date().toISOString(),
        credit_purchase_request_confirmation_pastel_block_height:
          await getCurrentPastelBlockHeight(),
        credit_purchase_request_confirmation_message_version_string: "1.0",
        sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: "",
        requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields:
          "",
      });
    creditPackPurchaseRequestConfirmation.sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields =
      await computeSHA3256HashOfSQLModelResponseFields(
        creditPackPurchaseRequestConfirmation
      );
    creditPackPurchaseRequestConfirmation.requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields =
      await signMessageWithPastelID(
        MY_LOCAL_PASTELID,
        creditPackPurchaseRequestConfirmation.sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields,
        MY_PASTELID_PASSPHRASE
      );
    const { error: confirmationValidationError } =
      creditPackPurchaseRequestConfirmationSchema.validate(
        creditPackPurchaseRequestConfirmation.toJSON()
      );
    if (confirmationValidationError) {
      throw new Error(
        `Invalid credit pack purchase request confirmation: ${confirmationValidationError.message}`
      );
    }
    const _creditPackPurchaseRequestConfirmationInstance =
      await CreditPackPurchaseRequestConfirmation.create(
        creditPackPurchaseRequestConfirmation.toJSON()
      );
    const creditPackPurchaseRequestConfirmationResponse =
      await inferenceClient.confirmCreditPurchaseRequest(
        highestRankedSupernodeURL,
        creditPackPurchaseRequestConfirmation
      );
    if (!creditPackPurchaseRequestConfirmationResponse) {
      logger.error("Credit pack ticket storage failed!");
      return null;
    }
    for (const supernodePastelID of JSON.parse(
      signedCreditPackTicket.list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms
    )) {
      let supernodeURL;
      try {
        if (checkIfPastelIDIsValid(supernodePastelID)) {
          supernodeURL = await getSupernodeUrlFromPastelID(
            supernodePastelID,
            validMasternodeListFullDF
          );
        }
      } catch (error) {
        logger.error(
          `Error getting Supernode URL for PastelID: ${supernodePastelID}: ${error.message}`
        );
        continue;
      }
      try {
        await inferenceClient.creditPackPurchaseCompletionAnnouncement(
          supernodeURL,
          creditPackPurchaseRequestConfirmation
        );
      } catch (error) {
        logger.error(
          `Error sending credit_pack_purchase_completion_announcement to Supernode URL: ${supernodeURL}: ${error.message}`
        );
      }
    }
    let creditPackPurchaseRequestStatus;
    for (let i = 0; i < closestSupernodes.length; i++) {
      try {
        const supernodeURL = closestSupernodes[i].url;
        creditPackPurchaseRequestStatus =
          await inferenceClient.checkStatusOfCreditPurchaseRequest(
            supernodeURL,
            creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields
          );
        logger.info(
          `Credit pack purchase request status: ${prettyJSON(
            creditPackPurchaseRequestStatus
          )}`
        );
        break;
      } catch (error) {
        logger.error(
          `Error checking status of credit purchase request with Supernode ${
            i + 1
          }: ${error.message}`
        );
        if (i === closestSupernodes.length - 1) {
          logger.error(
            "Failed to check status of credit purchase request with all Supernodes"
          );
          return null;
        }
      }
    }
    if (creditPackPurchaseRequestStatus.status !== "completed") {
      logger.error(
        `Credit pack purchase request failed: ${creditPackPurchaseRequestStatus.status}`
      );
      const closestAgreeingSupernodePastelID =
        await getClosestSupernodePastelIDFromList(
          MY_LOCAL_PASTELID,
          signedCreditPackTicket.list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms
        );
      const creditPackStorageRetryRequest = CreditPackStorageRetryRequest.build(
        {
          sha3_256_hash_of_credit_pack_purchase_request_response_fields:
            signedCreditPackTicket.sha3_256_hash_of_credit_pack_purchase_request_response_fields,
          credit_pack_purchase_request_fields_json_b64:
            signedCreditPackTicket.credit_pack_purchase_request_fields_json_b64,
          requesting_end_user_pastelid: MY_LOCAL_PASTELID,
          closest_agreeing_supernode_to_retry_storage_pastelid:
            closestAgreeingSupernodePastelID,
          credit_pack_storage_retry_request_timestamp_utc_iso_string:
            new Date().toISOString(),
          credit_pack_storage_retry_request_pastel_block_height:
            await getCurrentPastelBlockHeight(),
          credit_pack_storage_retry_request_message_version_string: "1.0",
          sha3_256_hash_of_credit_pack_storage_retry_request_fields: "",
          requesting_end_user_pastelid_signature_on_credit_pack_storage_retry_request_hash:
            "",
        }
      );
      creditPackStorageRetryRequest.sha3_256_hash_of_credit_pack_storage_retry_request_fields =
        await computeSHA3256HashOfSQLModelResponseFields(
          creditPackStorageRetryRequest
        );
      creditPackStorageRetryRequest.requesting_end_user_pastelid_signature_on_credit_pack_storage_retry_request_hash =
        await signMessageWithPastelID(
          MY_LOCAL_PASTELID,
          creditPackStorageRetryRequest.sha3_256_hash_of_credit_pack_storage_retry_request_fields,
          MY_PASTELID_PASSPHRASE
        );
      const { error: storageRetryRequestValidationError } =
        creditPackStorageRetryRequestSchema.validate(
          creditPackStorageRetryRequest.toJSON()
        );
      if (storageRetryRequestValidationError) {
        throw new Error(
          `Invalid credit pack storage retry request: ${storageRetryRequestValidationError.message}`
        );
      }
      const _creditPackStorageRetryRequestInstance =
        await CreditPackStorageRetryRequest.create(
          creditPackStorageRetryRequest.toJSON()
        );
      const closestAgreeingSupernodeURL = await getSupernodeUrlFromPastelID(
        closestAgreeingSupernodePastelID,
        validMasternodeListFullDF
      );
      const creditPackStorageRetryRequestResponse =
        await inferenceClient.creditPackStorageRetryRequest(
          closestAgreeingSupernodeURL,
          creditPackStorageRetryRequest
        );
      const { error: storageRetryResponseValidationError } =
        creditPackStorageRetryRequestResponseSchema.validate(
          creditPackStorageRetryRequestResponse.toJSON()
        );
      if (storageRetryResponseValidationError) {
        throw new Error(
          `Invalid credit pack storage retry request response: ${storageRetryResponseValidationError.message}`
        );
      }
      for (const supernodePastelID of signedCreditPackTicket.list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms) {
        let supernodeURL;
        try {
          if (checkIfPastelIDIsValid(supernodePastelID)) {
            supernodeURL = await getSupernodeUrlFromPastelID(
              supernodePastelID,
              validMasternodeListFullDF
            );
          }
        } catch (error) {
          logger.error(
            `Error getting Supernode URL for PastelID: ${supernodePastelID}: ${error.message}`
          );
          continue;
        }
        try {
          await inferenceClient.creditPackPurchaseCompletionAnnouncement(
            supernodeURL,
            creditPackStorageRetryRequestResponse
          );
        } catch (error) {
          logger.error(
            `Error sending credit_pack_purchase_completion_announcement to Supernode URL: ${supernodeURL}: ${error.message}`
          );
        }
      }
      return creditPackStorageRetryRequestResponse;
    } else {
      return creditPackPurchaseRequestConfirmationResponse;
    }
  } catch (error) {
    logger.error(`Error in handleCreditPackTicketEndToEnd: ${error.message}`);
    throw error;
  }
}

async function getCreditPackTicketInfoEndToEnd(creditPackTicketPastelTxid) {
  try {
    const inferenceClient = new PastelInferenceClient(
      MY_LOCAL_PASTELID,
      MY_PASTELID_PASSPHRASE
    );
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const { url: supernodeURL } = await getClosestSupernodeToPastelIDURL(
      MY_LOCAL_PASTELID,
      validMasternodeListFullDF
    );
    if (!supernodeURL) {
      throw new Error("Supernode URL is undefined");
    }
    logger.info(
      `Getting credit pack ticket data from Supernode URL: ${supernodeURL}...`
    );

    const {
      creditPackPurchaseRequestResponse,
      creditPackPurchaseRequestConfirmation,
    } = await inferenceClient.getCreditPackTicketFromTxid(
      supernodeURL,
      creditPackTicketPastelTxid
    );

    const balanceInfo = await inferenceClient.checkCreditPackBalance(
      supernodeURL,
      creditPackTicketPastelTxid
    );

    return {
      requestResponse: creditPackPurchaseRequestResponse,
      requestConfirmation: creditPackPurchaseRequestConfirmation,
      balanceInfo,
    };
  } catch (error) {
    logger.error(`Error in getCreditPackTicketInfoEndToEnd: ${error.message}`);
    throw error;
  }
}

async function getMyValidCreditPackTicketsEndToEnd() {
  try {
    const inferenceClient = new PastelInferenceClient(
      MY_LOCAL_PASTELID,
      MY_PASTELID_PASSPHRASE
    );
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const { url: supernodeURL } = await getClosestSupernodeToPastelIDURL(
      MY_LOCAL_PASTELID,
      validMasternodeListFullDF
    );
    if (!supernodeURL) {
      throw new Error("Supernode URL is undefined");
    }
    logger.info(
      `Getting credit pack ticket data from Supernode URL: ${supernodeURL}...`
    );
    const validCreditPackTickets =
      await inferenceClient.getValidCreditPackTicketsForPastelID(
        supernodeURL,
        MY_LOCAL_PASTELID
      );
    return validCreditPackTickets;
  } catch (error) {
    logger.error(
      `Error in getMyValidCreditPackTicketsEndToEnd: ${error.message}`
    );
    throw error;
  }
}

async function estimateCreditPackCostEndToEnd(
  desiredNumberOfCredits,
  creditPriceCushionPercentage
) {
  try {
    const inferenceClient = new PastelInferenceClient(
      MY_LOCAL_PASTELID,
      MY_PASTELID_PASSPHRASE
    );
    const estimatedTotalCostOfTicket =
      await inferenceClient.internalEstimateOfCreditPackTicketCostInPSL(
        desiredNumberOfCredits,
        creditPriceCushionPercentage
      );
    return estimatedTotalCostOfTicket;
  } catch (error) {
    logger.error(`Error in estimateCreditPackCostEndToEnd: ${error.message}`);
    throw error;
  }
}

async function handleInferenceRequestEndToEnd(
  creditPackTicketPastelTxid,
  modelInputData,
  requestedModelCanonicalString,
  modelInferenceTypeString,
  modelParameters,
  maximumInferenceCostInCredits,
  burnAddress
) {
  try {
    const inferenceClient = new PastelInferenceClient(
      MY_LOCAL_PASTELID,
      MY_PASTELID_PASSPHRASE
    );
    const modelParametersJSON = safeStringify(modelParameters);
    const {
      closestSupportingSupernodePastelID,
      closestSupportingSupernodeURL,
    } = await inferenceClient.getClosestSupernodeURLThatSupportsDesiredModel(
      requestedModelCanonicalString,
      modelInferenceTypeString,
      modelParametersJSON
    );
    const supernodeURL = closestSupportingSupernodeURL;
    const supernodePastelID = closestSupportingSupernodePastelID;

    if (!supernodeURL) {
      logger.error(
        `Error! No supporting Supernode found for the desired model: ${requestedModelCanonicalString} with inference type: ${modelInferenceTypeString}`
      );
      return null;
    }

    let modelInputDataJSONBase64Encoded;
    if (
      modelInferenceTypeString === "embedding_document" ||
      modelInferenceTypeString === "embedding_audio"
    ) {
      modelInputDataJSONBase64Encoded = modelInputData.toString("base64");
    } else {
      modelInputDataJSONBase64Encoded = Buffer.from(
        JSON.stringify(modelInputData)
      ).toString("base64");
    }
    const modelParametersJSONBase64Encoded =
      Buffer.from(modelParametersJSON).toString("base64");

    const inferenceRequestData = InferenceAPIUsageRequest.build({
      requesting_pastelid: MY_LOCAL_PASTELID,
      credit_pack_ticket_pastel_txid: creditPackTicketPastelTxid,
      requested_model_canonical_string: requestedModelCanonicalString,
      model_inference_type_string: modelInferenceTypeString,
      model_parameters_json_b64: modelParametersJSONBase64Encoded,
      model_input_data_json_b64: modelInputDataJSONBase64Encoded,
      inference_request_utc_iso_string: new Date().toISOString(),
      inference_request_pastel_block_height:
        await getCurrentPastelBlockHeight(),
      status: "initiating",
      inference_request_message_version_string: "1.0",
      sha3_256_hash_of_inference_request_fields: "",
      requesting_pastelid_signature_on_request_hash: "",
    });

    const sha3256HashOfInferenceRequestFields =
      await computeSHA3256HashOfSQLModelResponseFields(inferenceRequestData);
    inferenceRequestData.sha3_256_hash_of_inference_request_fields =
      sha3256HashOfInferenceRequestFields;
    const requestingPastelIDSignatureOnRequestHash =
      await signMessageWithPastelID(
        MY_LOCAL_PASTELID,
        sha3256HashOfInferenceRequestFields,
        MY_PASTELID_PASSPHRASE
      );
    inferenceRequestData.requesting_pastelid_signature_on_request_hash =
      requestingPastelIDSignatureOnRequestHash;

    const usageRequestResponse =
      await inferenceClient.makeInferenceAPIUsageRequest(
        supernodeURL,
        inferenceRequestData
      );

    const validationErrors = await validateCreditPackTicketMessageData(
      usageRequestResponse
    );
    if (validationErrors) {
      if (validationErrors.length > 0) {
        throw new Error(
          `Invalid inference request response from Supernode URL ${supernodeURL}: ${validationErrors.join(
            ", "
          )}`
        );
      }
    }

    const usageRequestResponseDict = usageRequestResponse.toJSON();
    const inferenceRequestID = usageRequestResponseDict.inference_request_id;
    const inferenceResponseID = usageRequestResponseDict.inference_response_id;
    const proposedCostInCredits = parseFloat(
      usageRequestResponseDict.proposed_cost_of_request_in_inference_credits
    );
    const creditUsageTrackingPSLAddress =
      usageRequestResponseDict.credit_usage_tracking_psl_address;
    const creditUsageTrackingAmountInPSL =
      parseFloat(
        usageRequestResponseDict.request_confirmation_message_amount_in_patoshis
      ) / 100000;
    const trackingAddressBalance = await checkPSLAddressBalanceAlternative(
      creditUsageTrackingPSLAddress
    );

    if (trackingAddressBalance < creditUsageTrackingAmountInPSL) {
      logger.error(
        `Insufficient balance in tracking address: ${creditUsageTrackingPSLAddress}; amount needed: ${creditUsageTrackingAmountInPSL}; current balance: ${trackingAddressBalance}; shortfall: ${
          creditUsageTrackingAmountInPSL - trackingAddressBalance
        }`
      );
      return null;
    }

    if (proposedCostInCredits <= maximumInferenceCostInCredits) {
      const trackingTransactionTxid =
        await sendTrackingAmountFromControlAddressToBurnAddressToConfirmInferenceRequest(
          inferenceRequestID,
          creditUsageTrackingPSLAddress,
          creditUsageTrackingAmountInPSL,
          burnAddress
        );

      const txidLooksValid = /^[0-9a-fA-F]{64}$/.test(trackingTransactionTxid);

      if (txidLooksValid) {
        const confirmationData = InferenceConfirmation.build({
          inference_request_id: inferenceRequestID,
          requesting_pastelid: MY_LOCAL_PASTELID,
          confirmation_transaction: { txid: trackingTransactionTxid },
        });

        const confirmationResult =
          await inferenceClient.sendInferenceConfirmation(
            supernodeURL,
            confirmationData
          );

        logger.info(
          `Sent inference confirmation: ${prettyJSON(confirmationResult)}`
        );

        const maxTriesToGetConfirmation = 10;
        let initialWaitTimeInSeconds = 10;
        let waitTimeInSeconds = initialWaitTimeInSeconds;

        for (let cnt = 0; cnt < maxTriesToGetConfirmation; cnt++) {
          waitTimeInSeconds = waitTimeInSeconds * 1.2 ** cnt;
          logger.info(
            `Waiting for the inference results for ${Math.round(
              waitTimeInSeconds
            )} seconds... (Attempt ${
              cnt + 1
            }/${maxTriesToGetConfirmation}); Checking with Supernode URL: ${supernodeURL}`
          );

          await new Promise((resolve) =>
            setTimeout(resolve, waitTimeInSeconds * 1000)
          );

          if (
            inferenceRequestID.length === 0 ||
            inferenceResponseID.length === 0
          ) {
            throw new Error("Inference request ID or response ID is empty");
          }

          const resultsAvailable =
            await inferenceClient.checkStatusOfInferenceRequestResults(
              supernodeURL,
              inferenceResponseID
            );

          if (resultsAvailable) {
            const outputResults =
              await inferenceClient.retrieveInferenceOutputResults(
                supernodeURL,
                inferenceRequestID,
                inferenceResponseID
              );

            const outputResultsDict = outputResults.toJSON();
            const outputResultsSize =
              outputResults.inference_result_json_base64.length;
            const maxResponseSizeToLog = 20000;

            const inferenceResultDict = {
              supernode_url: supernodeURL,
              request_data: inferenceRequestData.toJSON(),
              usage_request_response: usageRequestResponseDict,
              model_input_data_json: modelInputData, // Changed to modelInputData
              output_results: outputResultsDict,
            };

            if (modelInferenceTypeString === "text_to_image") {
              inferenceResultDict.generated_image_base64 =
                outputResults.inference_result_json_base64;
              inferenceResultDict.generated_image_decoded = Buffer.from(
                outputResults.inference_result_json_base64,
                "base64"
              );
            } else {
              const inferenceResultDecoded = Buffer.from(
                outputResults.inference_result_json_base64,
                "base64"
              ).toString();
              logger.info(`Decoded response:\n${inferenceResultDecoded}`);
              inferenceResultDict.inference_result_decoded =
                inferenceResultDecoded;
            }

            const useAuditFeature = false;
            let auditResults;
            let validationResults;

            if (useAuditFeature) {
              logger.info(
                "Waiting 3 seconds for audit results to be available..."
              );
              await new Promise((resolve) => setTimeout(resolve, 3000));

              const auditResults =
                await inferenceClient.auditInferenceRequestResponseID(
                  inferenceResponseID,
                  supernodePastelID
                );
              const validationResults = validateInferenceData(
                inferenceResultDict,
                auditResults
              );
              logger.info(
                `Validation results: ${prettyJSON(validationResults)}`
              );
              if (!auditResults) {
                logger.warn("Audit results are null");
              }
              if (!validationResults) {
                logger.warn("Validation results are null");
              }
              return { inferenceResultDict, auditResults, validationResults };
            } else {
              auditResults = null;
              validationResults = null;
            }

            if (!inferenceResultDict) {
              logger.error("Inference result is null");
              return {
                inferenceResultDict: null,
                auditResults: null,
                validationResults: null,
              };
            }
            return { inferenceResultDict, auditResults, validationResults };
          } else {
            logger.info("Inference results not available yet; retrying...");
          }
        }

        logger.info(
          `Quoted price of ${proposedCostInCredits} credits exceeds the maximum allowed cost of ${maximumInferenceCostInCredits} credits. Inference request not confirmed.`
        );
        return {
          inferenceResultDict: null,
          auditResults: null,
          validationResults: null,
        };
      }
    }
  } catch (error) {
    logger.error(`Error in handleInferenceRequestEndToEnd: ${error.message}`);
    throw error;
  }
}

module.exports = {
  checkForNewIncomingMessages,
  sendMessageAndCheckForNewIncomingMessages,
  handleCreditPackTicketEndToEnd,
  getCreditPackTicketInfoEndToEnd,
  getMyValidCreditPackTicketsEndToEnd,
  handleInferenceRequestEndToEnd,
  estimateCreditPackCostEndToEnd,
};
