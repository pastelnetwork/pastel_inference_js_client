// end_to_end_functions.js

require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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
  filterSupernodes,
  getNClosestSupernodesToPastelIDURLs,
  validateCreditPackTicketMessageData,
  validateInferenceData,
  computeSHA3256HashOfSQLModelResponseFields,
  checkIfPastelIDIsValid,
  getSupernodeUrlFromPastelID,
  getClosestSupernodePastelIDFromList,
  getClosestSupernodeToPastelIDURL,
} = require("./utility_functions");
const globals = require("./globals");

async function checkForNewIncomingMessages() {
  try {
    const pastelID = globals.getPastelId();
    const passphrase = globals.getPassphrase();
    const inferenceClient = new PastelInferenceClient(pastelID, passphrase);

    if (!pastelID || !passphrase) {
      logger.error("PastelID or passphrase is not set");
      return [];
    }
    const { validMasternodeListFullDF } = await checkSupernodeList();

    logger.info(`My local pastelid: ${inferenceClient.pastelID}`);

    const closestSupernodesToLocal = await getNClosestSupernodesToPastelIDURLs(
      3,
      inferenceClient.pastelID,
      validMasternodeListFullDF
    );
    logger.info(
      `Closest Supernodes to local pastelid: ${closestSupernodesToLocal
        .map((sn) => `PastelID: ${sn.pastelID}, URL: ${sn.url}`)
        .join(", ")}`
    );

    const messageRetrievalTasks = closestSupernodesToLocal.map(({ url }) =>
      inferenceClient.getUserMessages(url).catch((error) => {
        logger.warn(
          `Failed to retrieve messages from supernode ${url}: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`
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

    return uniqueMessages;
  } catch (error) {
    logger.error(`Error in checkForNewIncomingMessages: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
    throw error;
  }
}

async function sendMessageAndCheckForNewIncomingMessages(
  toPastelID,
  messageBody
) {
  try {
    const pastelID = globals.getPastelId();
    const passphrase = globals.getPassphrase();
    const inferenceClient = new PastelInferenceClient(pastelID, passphrase);
    const { validMasternodeListFullDF } = await checkSupernodeList();

    if (!pastelID || !passphrase) {
      throw new Error("PastelID or passphrase is not set");
    }

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
      from_pastelid: pastelID,
      to_pastelid: toPastelID,
      message_body: safeStringify(messageBody),
      message_signature: await signMessageWithPastelID(
        pastelID,
        messageBody,
        passphrase
      ),
    });

    const { error } = userMessageSchema.validate(userMessage.toJSON());
    if (error) {
      throw new Error(`Invalid user message: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
    }

    const sendTasks = closestSupernodesToRecipient.map(({ url }) =>
      inferenceClient.sendUserMessage(url, userMessage)
    );
    const sendResults = await Promise.all(sendTasks);
    logger.info(`Sent user messages: ${safeStringify(sendResults)}`);

    const receivedMessages = await checkForNewIncomingMessages();

    const messageDict = {
      sent_messages: sendResults,
      received_messages: receivedMessages,
    };

    return messageDict;
  } catch (error) {
    logger.error(
      `Error in sendMessageAndCheckForNewIncomingMessages: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`
    );
    throw error;
  }
}

function getIsoStringWithMicroseconds() {
  const now = new Date();
  const isoString = now.toISOString().replace("Z", "+00:00").replace(/\s/g, "");
  return isoString;
}

async function handleCreditPackTicketEndToEnd(
  numberOfCredits,
  creditUsageTrackingPSLAddress,
  burnAddress,
  maximumTotalCreditPackPriceInPSL,
  maximumPerCreditPriceInPSL,
  optionalPastelID = null,
  optionalPassphrase = null
) {
  let pastelID, passphrase;

  if (optionalPastelID && optionalPassphrase) {
    pastelID = optionalPastelID;
    passphrase = optionalPassphrase;
  } else {
    pastelID = globals.getPastelId();
    passphrase = globals.getPassphrase();
  }

  if (!pastelID || !passphrase) {
    throw new Error("PastelID or passphrase is not set");
  }

  const inferenceClient = new PastelInferenceClient(pastelID, passphrase);

  try {
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const requestTimestamp = getIsoStringWithMicroseconds();

    const creditPackRequest = CreditPackPurchaseRequest.build({
      requesting_end_user_pastelid: pastelID,
      requested_initial_credits_in_credit_pack: parseInt(numberOfCredits, 10),
      list_of_authorized_pastelids_allowed_to_use_credit_pack: JSON.stringify([pastelID]),
      credit_usage_tracking_psl_address: creditUsageTrackingPSLAddress,
      request_timestamp_utc_iso_string: requestTimestamp,
      request_pastel_block_height: parseInt(await getCurrentPastelBlockHeight(), 10),
      credit_purchase_request_message_version_string: "1.0",
      sha3_256_hash_of_credit_pack_purchase_request_fields: "",
      requesting_end_user_pastelid_signature_on_request_hash: "",
    });

    creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields =
      await computeSHA3256HashOfSQLModelResponseFields(creditPackRequest);
    creditPackRequest.requesting_end_user_pastelid_signature_on_request_hash =
      await signMessageWithPastelID(
        pastelID,
        creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields,
        passphrase
      );

    const closestSupernodes = await getNClosestSupernodesToPastelIDURLs(12, pastelID, validMasternodeListFullDF);
    if (closestSupernodes.length === 0) {
      throw new Error("No responsive supernodes found.");
    }

    for (const supernode of closestSupernodes) {
      try {
        logger.info(`Attempting credit pack request with supernode: ${supernode.url}`);

        const preliminaryPriceQuote = await inferenceClient.creditPackTicketInitialPurchaseRequest(
          supernode.url,
          creditPackRequest
        );

        const signedCreditPackTicketOrRejection = await inferenceClient.creditPackTicketPreliminaryPriceQuoteResponse(
          supernode.url,
          creditPackRequest,
          preliminaryPriceQuote,
          maximumTotalCreditPackPriceInPSL,
          maximumPerCreditPriceInPSL
        );

        if (signedCreditPackTicketOrRejection instanceof CreditPackPurchaseRequestResponseTermination) {
          logger.info(`Credit pack purchase request terminated: ${signedCreditPackTicketOrRejection.termination_reason_string}`);
          continue;
        }

        const signedCreditPackTicket = signedCreditPackTicketOrRejection;

        const burnTransactionResponse = await sendToAddress(
          burnAddress,
          Math.round(signedCreditPackTicket.proposed_total_cost_of_credit_pack_in_psl * 100000) / 100000,
          "Burn transaction for credit pack ticket"
        );

        if (!burnTransactionResponse.success) {
          throw new Error(`Error sending PSL to burn address: ${burnTransactionResponse.message}`);
        }

        const burnTransactionTxid = burnTransactionResponse.result;

        const creditPackPurchaseRequestConfirmation = await buildCreditPackPurchaseRequestConfirmation(
          creditPackRequest,
          signedCreditPackTicket,
          burnTransactionTxid,
          pastelID,
          passphrase
        );

        await CreditPackPurchaseRequestConfirmation.create(creditPackPurchaseRequestConfirmation.toJSON());

        const creditPackPurchaseRequestConfirmationResponse = await inferenceClient.confirmCreditPurchaseRequest(
          supernode.url,
          creditPackPurchaseRequestConfirmation
        );

        if (!creditPackPurchaseRequestConfirmationResponse) {
          throw new Error("Credit pack ticket storage failed");
        }

        let creditPackPurchaseRequestStatus = await checkCreditPackPurchaseRequestStatus(
          inferenceClient,
          supernode.url,
          creditPackRequest,
          closestSupernodes
        );

        if (creditPackPurchaseRequestStatus.status !== "completed") {
          const creditPackStorageRetryRequestResponse = await initiateStorageRetry(
            inferenceClient,
            creditPackRequest,
            signedCreditPackTicket,
            validMasternodeListFullDF,
            pastelID,
            passphrase
          );

          return { creditPackRequest, creditPackPurchaseRequestConfirmation, creditPackStorageRetryRequestResponse };
        } else {
          return { creditPackRequest, creditPackPurchaseRequestConfirmation, creditPackPurchaseRequestConfirmationResponse };
        }
      } catch (error) {
        logger.warn(`Failed to create credit pack with supernode ${supernode.url}: ${error.message}`);
      }
    }

    throw new Error('Failed to create credit pack ticket with all available supernodes');
  } catch (error) {
    logger.error(`Error in handleCreditPackTicketEndToEnd: ${error.message}`);
    throw new Error("An unexpected error occurred while processing your credit pack purchase. Please try again later.");
  }
}

async function buildCreditPackPurchaseRequestConfirmation(creditPackRequest, signedCreditPackTicket, burnTransactionTxid, pastelID, passphrase) {
  const confirmation = CreditPackPurchaseRequestConfirmation.build({
    sha3_256_hash_of_credit_pack_purchase_request_fields:
      creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields,
    sha3_256_hash_of_credit_pack_purchase_request_response_fields:
      signedCreditPackTicket.sha3_256_hash_of_credit_pack_purchase_request_response_fields,
    credit_pack_purchase_request_fields_json_b64:
      signedCreditPackTicket.credit_pack_purchase_request_fields_json_b64,
    requesting_end_user_pastelid: pastelID,
    txid_of_credit_purchase_burn_transaction: burnTransactionTxid,
    credit_purchase_request_confirmation_utc_iso_string: new Date().toISOString(),
    credit_purchase_request_confirmation_pastel_block_height: await getCurrentPastelBlockHeight(),
    credit_purchase_request_confirmation_message_version_string: "1.0",
    sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: "",
    requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: "",
  });

  confirmation.sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields =
    await computeSHA3256HashOfSQLModelResponseFields(confirmation);
  confirmation.requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields =
    await signMessageWithPastelID(
      pastelID,
      confirmation.sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields,
      passphrase
    );

  const { error: confirmationValidationError } = creditPackPurchaseRequestConfirmationSchema.validate(confirmation.toJSON());
  if (confirmationValidationError) {
    throw new Error(`Invalid credit pack purchase request confirmation: ${confirmationValidationError.message}`);
  }

  return confirmation;
}

async function checkCreditPackPurchaseRequestStatus(inferenceClient, highestRankedSupernodeURL, creditPackRequest, closestSupernodes) {
  try {
    const status = await inferenceClient.checkStatusOfCreditPurchaseRequest(
      highestRankedSupernodeURL,
      creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields
    );
    logger.info(`Credit pack purchase request status from the original supernode: ${JSON.stringify(status)}`);
    return status;
  } catch (error) {
    logger.debug(`Error checking status with original supernode: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}. Trying other supernodes.`);
    for (const supernode of closestSupernodes) {
      try {
        const status = await inferenceClient.checkStatusOfCreditPurchaseRequest(
          supernode.url,
          creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields
        );
        logger.info(`Credit pack purchase request status: ${JSON.stringify(status)}`);
        return status;
      } catch (retryError) {
        logger.debug(`Error checking status with supernode ${supernode.url}: ${retryError.message}`);
      }
    }
    throw new Error("Failed to check status of credit purchase request with all Supernodes");
  }
}

async function initiateStorageRetry(inferenceClient, creditPackRequest, signedCreditPackTicket, validMasternodeListFullDF, pastelID, passphrase) {
  const closestAgreeingSupernodePastelID = await getClosestSupernodePastelIDFromList(
    pastelID,
    signedCreditPackTicket.list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms
  );

  const creditPackStorageRetryRequest = await buildCreditPackStorageRetryRequest(
    creditPackRequest,
    signedCreditPackTicket,
    closestAgreeingSupernodePastelID,
    pastelID,
    passphrase
  );

  await CreditPackStorageRetryRequest.create(creditPackStorageRetryRequest.toJSON());

  const closestAgreeingSupernodeURL = await getSupernodeUrlFromPastelID(
    closestAgreeingSupernodePastelID,
    validMasternodeListFullDF
  );

  const creditPackStorageRetryRequestResponse = await inferenceClient.creditPackStorageRetryRequest(
    closestAgreeingSupernodeURL,
    creditPackStorageRetryRequest
  );

  const { error: storageRetryResponseValidationError } = creditPackStorageRetryRequestResponseSchema.validate(
    creditPackStorageRetryRequestResponse.toJSON()
  );

  if (storageRetryResponseValidationError) {
    throw new Error(`Invalid credit pack storage retry request response: ${storageRetryResponseValidationError.message}`);
  }

  // Silently attempt to announce completion to all agreeing supernodes
  const announcementPromises = signedCreditPackTicket.list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms.map(
    async (supernodePastelID) => {
      if (checkIfPastelIDIsValid(supernodePastelID)) {
        try {
          const supernodeURL = await getSupernodeUrlFromPastelID(supernodePastelID, validMasternodeListFullDF);
          await inferenceClient.creditPackPurchaseCompletionAnnouncement(
            supernodeURL,
            creditPackStorageRetryRequestResponse
          );
        } catch (error) {
          // Silently ignore errors in completion announcements
        }
      }
    }
  );

  await Promise.allSettled(announcementPromises);

  return creditPackStorageRetryRequestResponse;
}

async function buildCreditPackStorageRetryRequest(creditPackRequest, signedCreditPackTicket, closestAgreeingSupernodePastelID, pastelID, passphrase) {
  const storageRetryRequest = CreditPackStorageRetryRequest.build({
    sha3_256_hash_of_credit_pack_purchase_request_response_fields:
      signedCreditPackTicket.sha3_256_hash_of_credit_pack_purchase_request_response_fields,
    credit_pack_purchase_request_fields_json_b64:
      signedCreditPackTicket.credit_pack_purchase_request_fields_json_b64,
    requesting_end_user_pastelid: pastelID,
    closest_agreeing_supernode_to_retry_storage_pastelid: closestAgreeingSupernodePastelID,
    credit_pack_storage_retry_request_timestamp_utc_iso_string: new Date().toISOString(),
    credit_pack_storage_retry_request_pastel_block_height: await getCurrentPastelBlockHeight(),
    credit_pack_storage_retry_request_message_version_string: "1.0",
    sha3_256_hash_of_credit_pack_storage_retry_request_fields: "",
    requesting_end_user_pastelid_signature_on_credit_pack_storage_retry_request_hash: "",
  });

  storageRetryRequest.sha3_256_hash_of_credit_pack_storage_retry_request_fields =
    await computeSHA3256HashOfSQLModelResponseFields(storageRetryRequest);
  storageRetryRequest.requesting_end_user_pastelid_signature_on_credit_pack_storage_retry_request_hash =
    await signMessageWithPastelID(
      pastelID,
      storageRetryRequest.sha3_256_hash_of_credit_pack_storage_retry_request_fields,
      passphrase
    );

  const { error: storageRetryRequestValidationError } = creditPackStorageRetryRequestSchema.validate(storageRetryRequest.toJSON());
  if (storageRetryRequestValidationError) {
    throw new Error(`Invalid credit pack storage retry request: ${storageRetryRequestValidationError.message}`);
  }

  return storageRetryRequest;
}

async function getCreditPackTicketInfoEndToEnd(creditPackTicketPastelTxid, optionalPastelID = null,
  optionalPassphrase = null) {
  try {
    console.log("getCreditPackTicketInfoEndToEnd called with:", {
      creditPackTicketPastelTxid,
      optionalPastelID: optionalPastelID ? "[PROVIDED]" : "[NOT PROVIDED]",
      optionalPassphrase: optionalPassphrase ? "[PROVIDED]" : "[NOT PROVIDED]"
    });
    let pastelID, passphrase;

    if (optionalPastelID && optionalPassphrase) {
      pastelID = optionalPastelID;
      passphrase = optionalPassphrase;
    } else {
      pastelID = globals.getPastelId();
      passphrase = globals.getPassphrase();
    }
    console.log("Using PastelID:", pastelID);

    if (!pastelID || !passphrase) {
      throw new Error("PastelID or passphrase is not set");
    }
    const inferenceClient = new PastelInferenceClient(pastelID, passphrase);
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const { url: supernodeURL } = await getClosestSupernodeToPastelIDURL(
      pastelID,
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
    logger.error(`Error in getCreditPackTicketInfoEndToEnd: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
    throw error;
  }
}

async function getMyValidCreditPackTicketsEndToEnd() {
  const initialMinimumNonEmptyResponses = 5;
  const maxTotalResponsesIfAllEmpty = 20;
  const retryLimit = 1;

  try {
    const pastelID = globals.getPastelId();
    const passphrase = globals.getPassphrase();
    if (!pastelID || !passphrase) {
      throw new Error("PastelID or passphrase is not set");
    }

    const inferenceClient = new PastelInferenceClient(pastelID, passphrase);
    const { validMasternodeListFullDF } = await checkSupernodeList();

    const closestSupernodes = await getNClosestSupernodesToPastelIDURLs(
      120,
      pastelID,
      validMasternodeListFullDF
    );

    let allResponses = [];
    let nonEmptyResponses = [];
    let isResolved = false;

    await new Promise((resolve, reject) => {
      let completedRequests = 0;

      const handleResponse = () => {
        if (isResolved) return;

        if (nonEmptyResponses.length >= initialMinimumNonEmptyResponses) {
          logger.info(
            `Received ${nonEmptyResponses.length} non-empty responses out of ${allResponses.length} total responses`
          );
          isResolved = true;
          resolve();
        } else if (allResponses.length >= maxTotalResponsesIfAllEmpty) {
          logger.info(
            `Reached maximum total responses (${maxTotalResponsesIfAllEmpty}) with ${nonEmptyResponses.length} non-empty responses`
          );
          isResolved = true;
          resolve();
        } else if (completedRequests >= closestSupernodes.length) {
          logger.warn(
            `Queried all available supernodes. Got ${nonEmptyResponses.length} non-empty responses out of ${allResponses.length} total responses`
          );
          isResolved = true;
          resolve();
        }
      };

      closestSupernodes.forEach(({ url }) => {
        if (isResolved) return;

        retryPromise(
          () => inferenceClient.getValidCreditPackTicketsForPastelID(url),
          retryLimit
        )
          .then((response) => {
            if (isResolved) return;

            logger.info(
              `Response received from supernode at ${url}; response length: ${response.length}`
            );
            allResponses.push({ response, url });
            if (response.length > 0) {
              nonEmptyResponses.push({ response, url });
            }
            completedRequests++;
            handleResponse();
          })
          .catch((error) => {
            if (isResolved) return;

            logger.error(
              `Error querying supernode at ${url}: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`
            );
            completedRequests++;
            handleResponse();
          });
      });
    });

    if (nonEmptyResponses.length > 0) {
      // Return the longest non-empty response
      const longestResponse = nonEmptyResponses.reduce((prev, current) => {
        return current.response.length > prev.response.length ? current : prev;
      }).response;
      logger.info(
        `Returning longest non-empty response with length: ${longestResponse.length}`
      );
      return longestResponse;
    } else {
      logger.info("All responses were empty. Returning empty list.");
      return [];
    }
  } catch (error) {
    logger.error(
      `Error in getMyValidCreditPackTicketsEndToEnd: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`
    );
    return [];
  }
}

async function retryPromise(promiseFunc, limit, count = 0) {
  try {
    return await promiseFunc();
  } catch (error) {
    if (count < limit) {
      return retryPromise(promiseFunc, limit, count + 1);
    } else {
      throw error;
    }
  }
}

async function estimateCreditPackCostEndToEnd(
  desiredNumberOfCredits,
  creditPriceCushionPercentage
) {
  try {
    const pastelID = globals.getPastelId();
    const passphrase = globals.getPassphrase();
    if (!pastelID || !passphrase) {
      throw new Error("PastelID or passphrase is not set");
    }
    const inferenceClient = new PastelInferenceClient(pastelID, passphrase);
    const estimatedTotalCostOfTicket =
      await inferenceClient.internalEstimateOfCreditPackTicketCostInPSL(
        desiredNumberOfCredits,
        creditPriceCushionPercentage
      );
    return estimatedTotalCostOfTicket;
  } catch (error) {
    logger.error(`Error in estimateCreditPackCostEndToEnd: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
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
    const pastelID = globals.getPastelId();
    const passphrase = globals.getPassphrase();
    if (!pastelID || !passphrase) {
      throw new Error("PastelID or passphrase is not set");
    }
    const inferenceClient = new PastelInferenceClient(pastelID, passphrase);
    const modelParametersJSON = safeStringify(modelParameters);

    // Get the closest N supernode URLs that support the desired model, ordered by response time
    const supernodeURLs = await inferenceClient.getClosestSupernodeURLsThatSupportsDesiredModel(
      requestedModelCanonicalString,
      modelInferenceTypeString,
      modelParametersJSON,
      12 // Limit to the closest 12 supernodes
    );

    if (!supernodeURLs || supernodeURLs.length === 0) {
      logger.error(
        `No supporting supernode found with adequate performance for the desired model: ${requestedModelCanonicalString} with inference type: ${modelInferenceTypeString}`
      );
      return null;
    }

    let inferenceResultDict = null;
    let auditResults = null;
    let validationResults = null;
    let error = null;

    // Limit to trying the 5 fastest supernodes (based on response times)
    const maxTries = Math.min(5, supernodeURLs.length);

    for (let i = 0; i < maxTries; i++) {
      const supernodeURL = supernodeURLs[i];
      logger.info(`Attempting inference request to Supernode URL: ${supernodeURL}`);

      try {
        const modelInputDataJSONBase64Encoded = Buffer.from(
          JSON.stringify(modelInputData)
        ).toString("base64");

        const modelParametersJSONBase64Encoded =
          Buffer.from(modelParametersJSON).toString("base64");

        const currentBlockHeight = await getCurrentPastelBlockHeight();

        const inferenceRequestData = InferenceAPIUsageRequest.build({
          requesting_pastelid: pastelID,
          credit_pack_ticket_pastel_txid: creditPackTicketPastelTxid,
          requested_model_canonical_string: requestedModelCanonicalString,
          model_inference_type_string: modelInferenceTypeString,
          model_parameters_json_b64: modelParametersJSONBase64Encoded,
          model_input_data_json_b64: modelInputDataJSONBase64Encoded,
          inference_request_utc_iso_string: new Date().toISOString(),
          inference_request_pastel_block_height: currentBlockHeight,
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
            pastelID,
            sha3256HashOfInferenceRequestFields,
            passphrase
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
        if (validationErrors && validationErrors.length > 0) {
          throw new Error(
            `Invalid inference request response from Supernode URL ${supernodeURL}: ${validationErrors.join(
              ", "
            )}`
          );
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
            `Insufficient balance in tracking address: ${creditUsageTrackingPSLAddress}; amount needed: ${creditUsageTrackingAmountInPSL}; current balance: ${trackingAddressBalance}; shortfall: ${creditUsageTrackingAmountInPSL - trackingAddressBalance
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
              requesting_pastelid: pastelID,
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

            const maxTriesToGetConfirmation = 60;
            let initialWaitTimeInSeconds = 3;
            let waitTimeInSeconds = initialWaitTimeInSeconds;

            for (let cnt = 0; cnt < maxTriesToGetConfirmation; cnt++) {
              waitTimeInSeconds = waitTimeInSeconds * 1.04 ** cnt;
              logger.info(
                `Waiting for the inference results for ${Math.round(
                  waitTimeInSeconds
                )} seconds... (Attempt ${cnt + 1
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

                inferenceResultDict = {
                  supernode_url: supernodeURL,
                  request_data: inferenceRequestData.toJSON(),
                  usage_request_response: usageRequestResponseDict,
                  model_input_data_json: modelInputData,
                  output_results: outputResultsDict,
                };

                if (modelInferenceTypeString === "text_to_image") {
                  let jsonString = Buffer.from(
                    outputResults.inference_result_json_base64,
                    "base64"
                  ).toString("utf-8");
                  let jsonObject = JSON.parse(jsonString);
                  let imageBase64 = jsonObject.image;
                  inferenceResultDict.generated_image_decoded = Buffer.from(
                    imageBase64,
                    "base64"
                  );
                } else if (modelInferenceTypeString === "embedding_document") {
                  const inferenceResultDecoded = Buffer.from(
                    outputResults.inference_result_json_base64,
                    "base64"
                  ).toString("utf-8");
                  let zipBinary = Buffer.from(inferenceResultDecoded, "base64");
                  inferenceResultDict.zip_file_data = zipBinary;
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

                if (useAuditFeature) {
                  logger.info(
                    "Waiting 3 seconds for audit results to be available..."
                  );
                  await new Promise((resolve) => setTimeout(resolve, 3000));

                  auditResults =
                    await inferenceClient.auditInferenceRequestResponseID(
                      inferenceResponseID,
                      supernodeURL
                    );
                  validationResults = validateInferenceData(
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
          }
        } else {
          logger.info(
            `Quoted price of ${proposedCostInCredits} credits exceeds the maximum allowed cost of ${maximumInferenceCostInCredits} credits. Inference request not confirmed.`
          );
          return {
            inferenceResultDict: null,
            auditResults: null,
            validationResults: null,
          };
        }
      } catch (err) {
        error = err;
        logger.warn(`Failed inference request to Supernode URL ${supernodeURL}. Moving on to the next one.`);
      }
    }

    // If no inference request succeeded after all retries
    if (!inferenceResultDict) {
      throw new Error(
        `Failed to make inference request after ${maxTries} tries. Last error: ${error ? error.message : 'Unknown error'}`
      );
    }
  } catch (error) {
    logger.error(`Error in handleInferenceRequestEndToEnd: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
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
