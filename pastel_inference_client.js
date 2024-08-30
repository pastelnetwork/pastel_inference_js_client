require("dotenv").config();
const axios = require("axios");
const {
  signMessageWithPastelID,
  checkSupernodeList,
  getCurrentPastelBlockHeight,
} = require("./rpc_functions");
const {
  UserMessage,
  CreditPackPurchaseRequest,
  CreditPackPurchaseRequestRejection,
  CreditPackPurchaseRequestPreliminaryPriceQuote,
  CreditPackPurchaseRequestPreliminaryPriceQuoteResponse,
  CreditPackPurchaseRequestResponseTermination,
  CreditPackPurchaseRequestResponse,
  CreditPackPurchaseRequestConfirmation,
  CreditPackPurchaseRequestConfirmationResponse,
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
  userMessageSchema,
  creditPackPurchaseRequestSchema,
  creditPackPurchaseRequestRejectionSchema,
  creditPackPurchaseRequestPreliminaryPriceQuoteSchema,
  creditPackPurchaseRequestPreliminaryPriceQuoteResponseSchema,
  creditPackPurchaseRequestResponseTerminationSchema,
  creditPackPurchaseRequestResponseSchema,
  creditPackPurchaseRequestConfirmationSchema,
  creditPackPurchaseRequestConfirmationResponseSchema,
  creditPackRequestStatusCheckSchema,
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
  filterSupernodes,
  getNClosestSupernodesToPastelIDURLs,
  computeSHA3256HashOfSQLModelResponseFields,
  prepareModelForEndpoint,
  prepareModelForValidation,
  removeSequelizeFields,
  pythonCompatibleStringify,
  estimatedMarketPriceOfInferenceCreditsInPSLTerms,
  logActionWithPayload,
  transformCreditPackPurchaseRequestResponse,
} = require("./utility_functions");


const MESSAGING_TIMEOUT_IN_SECONDS = process.env.MESSAGING_TIMEOUT_IN_SECONDS;

function getIsoStringWithMicroseconds() {
  // Get the current time
  const now = new Date();
  // Convert the date to an ISO string and replace 'Z' with '+00:00' to match Python's format
  // Ensure to remove any unwanted spaces directly in this step if they were somehow introduced
  const isoString = now.toISOString().replace("Z", "+00:00").replace(/\s/g, "");
  // Return the correctly formatted ISO string without any spaces
  return isoString;
}

class PastelInferenceClient {
  constructor(pastelID, passphrase) {
    this.pastelID = pastelID;
    this.passphrase = passphrase;
  }

  async requestAndSignChallenge(supernodeURL) {
    try {
      const response = await axios.get(
        `${supernodeURL}/request_challenge/${this.pastelID}`,
        {
          timeout: 6000,
        }
      );
      const { challenge, challenge_id } = response.data;
      const challenge_signature = await signMessageWithPastelID(
        this.pastelID,
        challenge,
        this.passphrase
      );
      return {
        challenge,
        challenge_id,
        challenge_signature,
      };
    } catch (error) {
      logger.error(
        `Error requesting and signing challenge: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async sendUserMessage(supernodeURL, userMessage) {
    try {
      const { error } = userMessageSchema.validate(userMessage);
      if (error) {
        throw new Error(`Invalid user message: ${error.message}`);
      }
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);

      const payload = userMessage.toJSON();
      const response = await axios.post(
        `${supernodeURL}/send_user_message`,
        {
          user_message: payload,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
      const result = response.data;
      const { resultError, value: validatedResult } =
        await userMessageSchema.validate(result);
      if (error) {
        throw new Error(`Invalid user message: ${resultError.message}`);
      }
      const userMessageInstance = await UserMessage.create(validatedResult);
      return userMessageInstance;
    } catch (error) {
      logger.error(`Error sending user message: ${error.message}`);
      throw error;
    }
  }

  async getUserMessages(supernodeURL) {
    try {
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const params = {
        pastelid: this.pastelID,
        challenge,
        challenge_id,
        challenge_signature,
      };
      const response = await axios.get(`${supernodeURL}/get_user_messages`, {
        params,
        timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
      });
      const result = response.data;
      const validatedResults = await Promise.all(
        result.map((messageData) => userMessageSchema.validate(messageData))
      );
      const userMessageInstances = await UserMessage.bulkCreate(
        validatedResults
      );
      return userMessageInstances;
    } catch (error) {
      logger.error(`Error retrieving user messages: ${error.message}`);
      throw error;
    }
  }

  async getModelMenu() {
    const minimumNumberOfResponses = 5; // Minimum number of valid responses needed
    const retryLimit = 1; // Number of retries per supernode
    try {
      const { validMasternodeListFullDF } = await checkSupernodeList();
      const closestSupernodes = await getNClosestSupernodesToPastelIDURLs(
        60,
        this.pastelID,
        validMasternodeListFullDF
      );
      let validResponses = [];

      // Custom promise to collect a specified minimum number of valid responses
      await new Promise((resolve, reject) => {
        let completedRequests = 0;
        closestSupernodes.forEach(({ url }) => {
          this.retryPromise(() => this.getModelMenuFromSupernode(url), retryLimit)
            .then(response => {
              logger.info(`Successful model menu response received from supernode at ${url}`);
              validResponses.push({ response, url });
              // Resolve promise when minimum number of valid responses are collected
              if (validResponses.length >= minimumNumberOfResponses) {
                resolve();
              }
            })
            .catch(error => {
              logger.error(`Error querying supernode at ${url}: ${error.message}`);
              completedRequests++;
              // Check if it's still possible to get the minimum number of valid responses
              if (completedRequests > closestSupernodes.length - minimumNumberOfResponses + validResponses.length) {
                reject(new Error("Insufficient valid responses received from supernodes"));
              }
            });
        });
      });

      // Determine the largest/longest response
      const largestResponse = validResponses.reduce((prev, current) => {
        return JSON.stringify(current.response).length > JSON.stringify(prev.response).length ? current : prev;
      }).response;

      return largestResponse;
    } catch (error) {
      logger.error(`Error in getModelMenu: ${error.message}`);
      throw error;
    }
  }

  async getModelMenuFromSupernode(supernodeURL) {
    try {
      const response = await axios.get(
        `${supernodeURL}/get_inference_model_menu`,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
      return response.data;
    } catch (error) {
      logger.error(
        `Error fetching model menu from Supernode URL: ${supernodeURL}: ${safeStringify(
          error
        )}`
      );
      throw error;
    }
  }

  async retryPromise(promiseFunc, limit, count = 0) {
    try {
      return await promiseFunc();
    } catch (error) {
      if (count < limit) {
        return this.retryPromise(promiseFunc, limit, count + 1);
      } else {
        throw error;
      }
    }
  }

  async getValidCreditPackTicketsForPastelID(supernodeURL) {
    const useVerbose = false;
    try {
      if (!this.pastelID) {
        return [];
      }
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const payload = {
        pastelid: this.pastelID,
        challenge,
        challenge_id,
        challenge_signature,
      };
      if (useVerbose) {
        logActionWithPayload(
          "retrieving",
          "valid credit pack tickets for PastelID",
          payload
        );
      }
      const response = await axios.post(
        `${supernodeURL}/get_valid_credit_pack_tickets_for_pastelid`,
        payload,
        {
          timeout: 6000,
        }
      );
      if (response.status !== 200) {
        if (useVerbose) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return [];
      }
      const validCreditPackTickets = response.data;
      if (useVerbose && validCreditPackTickets.length) {
        logger.info(
          `Received ${validCreditPackTickets.length} valid credit pack tickets for PastelID ${this.pastelID}`
        );
      }

      // Process the new format of returned results
      const processedTickets = validCreditPackTickets.map(ticket => ({
        credit_pack_registration_txid: ticket.credit_pack_registration_txid,
        credit_purchase_request_confirmation_pastel_block_height: ticket.credit_purchase_request_confirmation_pastel_block_height,
        requesting_end_user_pastelid: ticket.requesting_end_user_pastelid,
        ticket_input_data_fully_parsed_sha3_256_hash: ticket.ticket_input_data_fully_parsed_sha3_256_hash,
        txid_of_credit_purchase_burn_transaction: ticket.txid_of_credit_purchase_burn_transaction,
        credit_usage_tracking_psl_address: ticket.credit_usage_tracking_psl_address,
        psl_cost_per_credit: ticket.psl_cost_per_credit,
        requested_initial_credits_in_credit_pack: ticket.requested_initial_credits_in_credit_pack,
        credit_pack_current_credit_balance: ticket.credit_pack_current_credit_balance,
        balance_as_of_datetime: ticket.balance_as_of_datetime,
        number_of_confirmation_transactions: ticket.number_of_confirmation_transactions
      }));

      return processedTickets;
    } catch (error) {
      if (useVerbose) {
        logger.error(
          `Error retrieving valid credit pack tickets for PastelID: ${error.message}`
        );
      }
      if (useVerbose) {
        throw error;
      }
      return [];
    }
  }


  async checkCreditPackBalance(supernodeURL, txid) {
    try {
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const payload = {
        credit_pack_ticket_txid: txid,
        challenge,
        challenge_id,
        challenge_signature,
      };
      logActionWithPayload("checking", "credit pack balance", payload);

      const response = await axios.post(
        `${supernodeURL}/check_credit_pack_balance`,
        payload,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );

      if (response.status !== 200) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const balanceInfo = response.data;
      logger.info(
        `Received credit pack balance info for txid ${txid}: ${JSON.stringify(
          balanceInfo
        )}`
      );
      return balanceInfo;
    } catch (error) {
      logger.error(
        `Error checking credit pack balance for txid ${txid}: ${error.message}`
      );
      throw error;
    }
  }

  async getCreditPackTicketFromTxid(supernodeURL, txid) {
    try {
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const params = {
        txid,
        pastelid: this.pastelID,
        challenge,
        challenge_id,
        challenge_signature,
      };
      logActionWithPayload(
        "retrieving",
        "credit pack ticket from txid",
        params
      );

      const response = await axios.get(
        `${supernodeURL}/get_credit_pack_ticket_from_txid`,
        {
          params,
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );

      if (response.status !== 200) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const {
        credit_pack_purchase_request_response,
        credit_pack_purchase_request_confirmation,
      } = response.data;

      logActionWithPayload("received", "credit pack ticket from Supernode", {
        credit_pack_purchase_request_response,
        credit_pack_purchase_request_confirmation,
      });

      const { errorRequestResponse, value: validatedRequestResponse } =
        creditPackPurchaseRequestResponseSchema.validate(
          credit_pack_purchase_request_response
        );
      if (errorRequestResponse) {
        throw new Error(
          `Invalid credit pack request response: ${errorRequestResponse.message}`
        );
      }
      const { errorRequestConfirmation, value: validatedRequestConfirmation } =
        creditPackPurchaseRequestConfirmationSchema.validate(
          credit_pack_purchase_request_confirmation
        );
      if (errorRequestConfirmation) {
        throw new Error(
          `Invalid credit pack request confirmation: ${errorRequestConfirmation.message}`
        );
      }
      return {
        creditPackPurchaseRequestResponse:
          new CreditPackPurchaseRequestResponse(validatedRequestResponse),
        creditPackPurchaseRequestConfirmation:
          new CreditPackPurchaseRequestConfirmation(
            validatedRequestConfirmation
          ),
      };
    } catch (error) {
      logger.error(
        `Error retrieving credit pack ticket from txid: ${error.message}`
      );
      throw error;
    }
  }

  async creditPackTicketInitialPurchaseRequest(
    supernodeURL,
    creditPackRequest
  ) {
    try {
      // Validate the credit pack request using Joi
      const { error, value: validatedCreditPackRequest } =
        creditPackPurchaseRequestSchema.validate(creditPackRequest.toJSON());
      if (error) {
        throw new Error(`Invalid credit pack request: ${error.message}`);
      }
      // Create the credit pack purchase request in the database
      const _creditPackPurchaseRequestInstance =
        await CreditPackPurchaseRequest.create(validatedCreditPackRequest);
      logActionWithPayload(
        "requesting",
        "a new Pastel credit pack ticket",
        validatedCreditPackRequest
      );
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      let preparedCreditPackRequest = await prepareModelForEndpoint(
        creditPackRequest
      );
      const response = await axios.post(
        `${supernodeURL}/credit_purchase_initial_request`,
        {
          challenge,
          challenge_id,
          challenge_signature,
          credit_pack_request: preparedCreditPackRequest,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
      const result = response.data;

      if (result.rejection_reason_string) {
        logger.error(
          `Credit pack purchase request rejected: ${result.rejection_reason_string}`
        );
        let rejectionResponse = await prepareModelForValidation(result);
        const { rejectionError, value: validatedRejection } =
          await creditPackPurchaseRequestRejectionSchema.validateAsync(
            rejectionResponse
          );
        if (rejectionError) {
          throw new Error(
            `Invalid credit pack purchase request rejection: ${rejectionError.message}`
          );
        }
        const creditPackPurchaseRequestRejectionInstance =
          await CreditPackPurchaseRequestRejection.create(validatedRejection);
        return creditPackPurchaseRequestRejectionInstance;
      } else {
        logActionWithPayload(
          "receiving",
          "response to credit pack purchase request",
          result
        );
        let preparedResult = await prepareModelForValidation(result);
        const { priceQuoteError, value: validatedPriceQuote } =
          await creditPackPurchaseRequestPreliminaryPriceQuoteSchema.validate(
            preparedResult
          );
        if (priceQuoteError) {
          throw new Error(
            "Invalid credit pack request: " + priceQuoteError.message
          );
        }
        const creditPackPurchaseRequestPreliminaryPriceQuoteInstance =
          await CreditPackPurchaseRequestPreliminaryPriceQuote.create(
            validatedPriceQuote
          );
        return creditPackPurchaseRequestPreliminaryPriceQuoteInstance;
      }
    } catch (error) {
      logger.error(
        `Error initiating credit pack ticket purchase: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async calculatePriceDifferencePercentage(quotedPrice, estimatedPrice) {
    if (estimatedPrice === 0) {
      throw new Error("Estimated price cannot be zero.");
    }
    const differencePercentage =
      Math.abs(quotedPrice - estimatedPrice) / estimatedPrice;
    return differencePercentage;
  }

  async confirmPreliminaryPriceQuote(
    preliminaryPriceQuote,
    maximumTotalCreditPackPriceInPSL,
    maximumPerCreditPriceInPSL
  ) {
    if (!maximumTotalCreditPackPriceInPSL && !maximumPerCreditPriceInPSL) {
      maximumPerCreditPriceInPSL =
        process.env.MAXIMUM_PER_CREDIT_PRICE_IN_PSL_FOR_CLIENT;
    }
    const {
      preliminary_quoted_price_per_credit_in_psl: quotedPricePerCredit,
      preliminary_total_cost_of_credit_pack_in_psl: quotedTotalPrice,
      credit_pack_purchase_request_fields_json_b64: requestFieldsB64,
    } = preliminaryPriceQuote;
    let requestFields = JSON.parse(atob(requestFieldsB64)); // Decode base64 string
    const { requested_initial_credits_in_credit_pack: requestedCredits } =
      requestFields;
    if (!maximumTotalCreditPackPriceInPSL) {
      maximumTotalCreditPackPriceInPSL =
        maximumPerCreditPriceInPSL * requestedCredits;
    } else if (!maximumPerCreditPriceInPSL) {
      maximumPerCreditPriceInPSL =
        maximumTotalCreditPackPriceInPSL / requestedCredits;
    }
    const estimatedPricePerCredit =
      await estimatedMarketPriceOfInferenceCreditsInPSLTerms();
    const priceDifferencePercentage =
      await this.calculatePriceDifferencePercentage(
        quotedPricePerCredit,
        estimatedPricePerCredit
      );

    const numberFormat = new Intl.NumberFormat("en-US");
    const percentageFormat = (value) => value.toFixed(2);

    if (
      quotedPricePerCredit <= maximumPerCreditPriceInPSL &&
      quotedTotalPrice <= maximumTotalCreditPackPriceInPSL &&
      priceDifferencePercentage <=
      process.env
        .MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING
    ) {
      logger.info(
        `Preliminary price quote is within the acceptable range: ${numberFormat.format(
          quotedPricePerCredit
        )} PSL per credit, ${numberFormat.format(
          quotedTotalPrice
        )} PSL total, which is within the maximum of ${numberFormat.format(
          maximumPerCreditPriceInPSL
        )} PSL per credit and ${numberFormat.format(
          maximumTotalCreditPackPriceInPSL
        )} PSL total. The price difference from the estimated fair market price is ${percentageFormat(
          priceDifferencePercentage * 100
        )}%, which is within the allowed maximum of ${percentageFormat(
          process.env
            .MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING *
          100
        )}%.`
      );
      return true;
    } else {
      logger.warn(
        `Preliminary price quote exceeds the maximum acceptable price or the price difference from the estimated fair price is too high! Quoted price: ${numberFormat.format(
          quotedPricePerCredit
        )} PSL per credit, ${numberFormat.format(
          quotedTotalPrice
        )} PSL total, maximum price: ${numberFormat.format(
          maximumPerCreditPriceInPSL
        )} PSL per credit, ${numberFormat.format(
          maximumTotalCreditPackPriceInPSL
        )} PSL total. The price difference from the estimated fair market price is ${percentageFormat(
          priceDifferencePercentage * 100
        )}%, which exceeds the allowed maximum of ${percentageFormat(
          process.env
            .MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING *
          100
        )}%.`
      );
      return false;
    }
  }

  async internalEstimateOfCreditPackTicketCostInPSL(
    desiredNumberOfCredits,
    priceCushionPercentage
  ) {
    const estimatedPricePerCredit =
      await estimatedMarketPriceOfInferenceCreditsInPSLTerms();
    const estimatedTotalCostOfTicket =
      Math.round(
        desiredNumberOfCredits *
        estimatedPricePerCredit *
        (1 + priceCushionPercentage) *
        100
      ) / 100;
    return estimatedTotalCostOfTicket;
  }

  async creditPackTicketPreliminaryPriceQuoteResponse(
    supernodeURL,
    creditPackRequest,
    preliminaryPriceQuote,
    maximumTotalCreditPackPriceInPSL,
    maximumPerCreditPriceInPSL
  ) {
    try {
      if (preliminaryPriceQuote instanceof CreditPackPurchaseRequestRejection) {
        logger.error(
          `Credit pack purchase request rejected: ${preliminaryPriceQuote.rejection_reason_string}`
        );
        return preliminaryPriceQuote;
      }

      const agreeWithPriceQuote = await this.confirmPreliminaryPriceQuote(
        preliminaryPriceQuote,
        maximumTotalCreditPackPriceInPSL,
        maximumPerCreditPriceInPSL
      );

      const priceQuoteResponse =
        CreditPackPurchaseRequestPreliminaryPriceQuoteResponse.build({
          sha3_256_hash_of_credit_pack_purchase_request_fields:
            creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields,
          sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields:
            preliminaryPriceQuote.sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields,
          credit_pack_purchase_request_fields_json_b64:
            preliminaryPriceQuote.credit_pack_purchase_request_fields_json_b64,
          agree_with_preliminary_price_quote: agreeWithPriceQuote,
          credit_usage_tracking_psl_address:
            preliminaryPriceQuote.credit_usage_tracking_psl_address,
          preliminary_quoted_price_per_credit_in_psl: parseFloat(
            preliminaryPriceQuote.preliminary_quoted_price_per_credit_in_psl
          ),
          preliminary_price_quote_response_timestamp_utc_iso_string:
            getIsoStringWithMicroseconds(),
          preliminary_price_quote_response_pastel_block_height: parseInt(
            await getCurrentPastelBlockHeight(),
            10
          ),
          preliminary_price_quote_response_message_version_string: "1.0",
          requesting_end_user_pastelid:
            creditPackRequest.requesting_end_user_pastelid,
          sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields:
            "",
          requesting_end_user_pastelid_signature_on_preliminary_price_quote_response_hash:
            "",
        });
      // Compute hashes and signatures
      priceQuoteResponse.sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields =
        await computeSHA3256HashOfSQLModelResponseFields(priceQuoteResponse);
      priceQuoteResponse.requesting_end_user_pastelid_signature_on_preliminary_price_quote_response_hash =
        await signMessageWithPastelID(
          creditPackRequest.requesting_end_user_pastelid,
          priceQuoteResponse.sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields,
          this.passphrase
        );
      // Validate the price quote response
      const {
        error: priceQuoteValidationError,
        value: validatedPriceQuoteResponse,
      } =
        await creditPackPurchaseRequestPreliminaryPriceQuoteResponseSchema.validate(
          priceQuoteResponse.toJSON()
        );
      if (priceQuoteValidationError) {
        throw new Error(
          `Invalid price quote response: ${priceQuoteValidationError.message}`
        );
      }
      // Prepare model for endpoint before sending
      let preparedPriceQuoteResponse = await prepareModelForEndpoint(
        priceQuoteResponse
      );

      delete preparedPriceQuoteResponse["id"];
      preparedPriceQuoteResponse["agree_with_preliminary_price_quote"] =
        preparedPriceQuoteResponse["agree_with_preliminary_price_quote"]
          ? 1
          : 0;

      // Prepare and send the payload to the supernode
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const completePriceQuoteResponse = {
        challenge,
        challenge_id,
        challenge_signature,
        preliminary_price_quote_response: preparedPriceQuoteResponse,
      };

      const response = await axios.post(
        `${supernodeURL}/credit_purchase_preliminary_price_quote_response`,
        completePriceQuoteResponse,
        { timeout: 3 * MESSAGING_TIMEOUT_IN_SECONDS * 1000 }
      );
      const result = response.data;
      if (result.termination_reason_string) {
        logger.error(
          `Credit pack purchase request response terminated: ${result.termination_reason_string}`
        );
        const terminationResponse = await prepareModelForValidation(result);
        const { error: terminationError, value: validatedTermination } =
          await creditPackPurchaseRequestResponseTerminationSchema.validateAsync(
            terminationResponse
          );
        if (terminationError) {
          throw new Error(
            `Invalid credit pack purchase request response termination: ${terminationError.message}`
          );
        }
        const terminationInstance =
          await CreditPackPurchaseRequestResponseTermination.create(
            validatedTermination
          );
        return terminationInstance;
      } else {
        let transformedResult = transformCreditPackPurchaseRequestResponse(
          await prepareModelForValidation(result)
        );
        logActionWithPayload(
          "receiving",
          "response to credit pack purchase request",
          transformedResult
        );
        const { error: resultError, value: validatedResponse } =
          await creditPackPurchaseRequestResponseSchema.validate(
            transformedResult
          );
        if (resultError) {
          throw new Error(
            `Invalid credit pack purchase request response: ${resultError.message}`
          );
        }
        const responseInstance = await CreditPackPurchaseRequestResponse.create(
          validatedResponse
        );
        return responseInstance;
      }
    } catch (error) {
      logger.error(
        `Error responding to preliminary price quote: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async confirmCreditPurchaseRequest(
    supernodeURL,
    creditPackPurchaseRequestConfirmation
  ) {
    try {
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const payload = await prepareModelForEndpoint(
        creditPackPurchaseRequestConfirmation
      );
      logActionWithPayload(
        "confirming",
        "credit pack purchase request",
        payload
      );
      const response = await axios.post(
        `${supernodeURL}/confirm_credit_purchase_request`,
        {
          confirmation: payload,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 30 * 1000, // Need to be patient with the timeout here since it requires the transaction to be mined/confirmed
        }
      );
      const result = response.data;
      logActionWithPayload(
        "receiving",
        "response to credit pack purchase confirmation",
        result
      );
      const { error: validationError, value: validatedResult } =
        await creditPackPurchaseRequestConfirmationResponseSchema.validate(
          result
        );
      if (validationError) {
        throw new Error(
          `Invalid credit pack purchase request confirmation response: ${validationError.message}`
        );
      }
      const creditPackPurchaseRequestConfirmationResponseInstance =
        await CreditPackPurchaseRequestConfirmationResponse.create(result);
      return creditPackPurchaseRequestConfirmationResponseInstance;
    } catch (error) {
      logger.error(
        `Error confirming credit pack purchase request: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async checkStatusOfCreditPurchaseRequest(
    supernodeURL,
    creditPackPurchaseRequestHash
  ) {
    try {
      // Request challenge from the server
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      // Build and validate the status check model
      const statusCheck = CreditPackRequestStatusCheck.build({
        sha3_256_hash_of_credit_pack_purchase_request_fields:
          creditPackPurchaseRequestHash,
        requesting_end_user_pastelid: this.pastelID,
        requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_fields:
          await signMessageWithPastelID(
            this.pastelID,
            creditPackPurchaseRequestHash,
            this.passphrase
          ),
      });
      const { error: validationError, value: validatedStatusCheck } =
        await creditPackRequestStatusCheckSchema.validate(statusCheck.toJSON());
      if (validationError) {
        logger.error(
          `Invalid credit pack request status check: ${validationError.message}`
        );
        throw new Error(
          `Invalid credit pack request status check: ${validationError.message}`
        );
      }
      delete validatedStatusCheck["id"];
      logActionWithPayload(
        "checking",
        "status of credit pack purchase request",
        validatedStatusCheck
      );
      // Send the request to the server
      const response = await axios.post(
        `${supernodeURL}/check_status_of_credit_purchase_request`,
        {
          credit_pack_request_status_check: validatedStatusCheck,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
      // Check response status and handle any errors
      if (response.status !== 200) {
        throw new Error(
          `HTTP error ${response.status}: ${response.statusText}`
        );
      }
      logActionWithPayload(
        "receiving",
        "credit pack purchase request response from Supernode",
        response.data
      );
      // Validate the received result
      let transformedResult = await prepareModelForValidation(response.data);
      delete transformedResult["id"];
      const { error: resultError, value: validatedResult } =
        await creditPackPurchaseRequestStatusSchema.validate(transformedResult);
      if (resultError) {
        throw new Error(
          `Invalid credit pack purchase request status: ${resultError.message}`
        );
      }
      // Create and return the status instance from the validated result
      const statusInstance = await CreditPackPurchaseRequestStatus.create(
        validatedResult
      );
      return statusInstance;
    } catch (error) {
      logger.error(
        `Error checking status of credit purchase request: ${safeStringify(
          error.message
        )}`
      );
      throw error; // Rethrow to handle error upstream
    }
  }

  async creditPackPurchaseCompletionAnnouncement(
    supernodeURL,
    creditPackPurchaseRequestConfirmation
  ) {
    try {
      // Validate the incoming data
      const { error, value: validatedConfirmation } =
        await creditPackPurchaseRequestConfirmationSchema.validate(
          creditPackPurchaseRequestConfirmation.toJSON()
        );
      if (error) {
        logger.error(
          `Invalid credit pack purchase request confirmation: ${error.message}`
        );
        return; // Return early instead of throwing an error
      }

      // Request challenge from the server
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);

      // Prepare the model for the endpoint
      let payload = validatedConfirmation;
      delete payload["id"]; // Removing the 'id' key as done in the Python method

      // Send the request to the server with a shortened timeout
      const response = await axios.post(
        `${supernodeURL}/credit_pack_purchase_completion_announcement`,
        {
          confirmation: payload,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: 2 * 1000, // Shortened timeout of 2 seconds
        }
      );

      // Check response status and log any errors
      if (response.status !== 200) {
        logger.error(`HTTP error ${response.status}: ${response.statusText}`);
      } else {
        logger.info(
          `Credit pack purchase completion announcement sent successfully to ${supernodeURL}`
        );
      }
    } catch (error) {
      // Log the error without rethrowing to prevent upstream disruption
      if (error.response) {
        logger.error(
          `HTTP error sending credit pack purchase completion announcement to ${supernodeURL}: ${error.response.status} ${error.response.statusText}`
        );
      } else if (error.code === "ECONNABORTED") {
        logger.error(
          `Timeout error sending credit pack purchase completion announcement to ${supernodeURL}: ${error.message}`
        );
      } else {
        logger.error(
          `Error sending credit pack purchase completion announcement to ${supernodeURL}: ${error.message || error
          }`
        );
      }
    }
  }

  async creditPackStorageRetryRequest(
    supernodeURL,
    creditPackStorageRetryRequest
  ) {
    try {
      const { error, value: validatedRequest } =
        await creditPackStorageRetryRequestSchema.validate(
          creditPackStorageRetryRequest.toJSON()
        );
      if (error) {
        throw new Error(
          `Invalid credit pack storage retry request: ${error.message}`
        );
      }

      const requestInstance = await CreditPackStorageRetryRequest.create(
        validatedRequest
      );

      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);

      const payload = await prepareModelForEndpoint(requestInstance);
      logActionWithPayload(
        "sending",
        "credit pack storage retry request",
        payload
      );

      const response = await axios.post(
        `${supernodeURL}/credit_pack_storage_retry_request`,
        {
          request: payload,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );

      const result = response.data;
      logActionWithPayload(
        "receiving",
        "response to credit pack storage retry request",
        result
      );

      let transformedResult = await prepareModelForValidation(result);
      const { error: responseError, value: validatedResponse } =
        await creditPackStorageRetryRequestResponseSchema.validate(
          transformedResult
        );
      if (responseError) {
        throw new Error(
          `Invalid credit pack storage retry request response: ${responseError.message}`
        );
      }

      const responseInstance =
        await CreditPackStorageRetryRequestResponse.create(validatedResponse);
      return responseInstance;
    } catch (error) {
      logger.error(
        `Error sending credit pack storage retry request: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async creditPackStorageRetryCompletionAnnouncement(
    supernodeURL,
    creditPackStorageRetryRequestResponse
  ) {
    try {
      const { error, value: validatedResponse } =
        await creditPackStorageRetryRequestResponseSchema.validate(
          creditPackStorageRetryRequestResponse.toJSON()
        );
      if (error) {
        throw new Error(
          `Invalid credit pack storage retry request response: ${error.message}`
        );
      }

      const responseInstance =
        await CreditPackStorageRetryRequestResponse.create(validatedResponse);

      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);

      const payload = await prepareModelForEndpoint(responseInstance);
      logActionWithPayload(
        "sending",
        "storage retry completion announcement message",
        payload
      );

      const response = await axios.post(
        `${supernodeURL}/credit_pack_storage_retry_completion_announcement`,
        {
          response: payload,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );

      response.data; // Access the response data to trigger any potential errors
    } catch (error) {
      logger.error(
        `Error sending credit pack storage retry completion announcement: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async retrieveCreditPackTicketFromPurchaseBurnTxid(supernodeURL, txid) {
    try {
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const payload = {
        purchase_burn_txid: txid,
        challenge,
        challenge_id,
        challenge_signature,
      };
      logActionWithPayload(
        "retrieving",
        "credit pack ticket from purchase burn txid",
        payload
      );

      const response = await axios.post(
        `${supernodeURL}/retrieve_credit_pack_ticket_from_purchase_burn_txid`,
        payload,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );

      if (response.status !== 200) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const ticketInfo = response.data;
      logger.info(
        `Received credit pack ticket for purchase burn txid ${txid}: ${JSON.stringify(
          ticketInfo
        )}`
      );
      return ticketInfo;
    } catch (error) {
      logger.error(
        `Error retrieving credit pack ticket for purchase burn txid ${txid}: ${error.message}`
      );
      throw error;
    }
  }

  async getFinalCreditPackRegistrationTxidFromPurchaseBurnTxid(
    supernodeURL,
    purchaseBurnTxid
  ) {
    try {
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const payload = {
        purchase_burn_txid: purchaseBurnTxid,
        challenge,
        challenge_id,
        challenge_signature,
      };
      logActionWithPayload(
        "retrieving",
        "final credit pack registration txid",
        payload
      );

      const response = await axios.post(
        `${supernodeURL}/get_final_credit_pack_registration_txid_from_credit_purchase_burn_txid`,
        payload,
        { timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000 }
      );

      if (response.status !== 200) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const finalTxid = response.data.final_credit_pack_registration_txid;
      logger.info(
        `Received final credit pack registration txid for purchase burn txid ${purchaseBurnTxid}: ${finalTxid}`
      );
      return finalTxid;
    } catch (error) {
      logger.error(
        `Error retrieving final credit pack registration txid for purchase burn txid ${purchaseBurnTxid}: ${error.message}`
      );
      throw error;
    }
  }

  async makeInferenceAPIUsageRequest(supernodeURL, requestData) {
    try {
      const { error, value: validatedRequest } =
        await inferenceAPIUsageRequestSchema.validate(requestData.toJSON());
      if (error) {
        throw new Error(
          `Invalid inference API usage request: ${error.message}`
        );
      }
      delete validatedRequest["id"];
      const requestInstance = await InferenceAPIUsageRequest.create(
        validatedRequest
      );
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const payload = await prepareModelForEndpoint(requestInstance);
      logActionWithPayload(
        "making",
        "inference usage request",
        validatedRequest
      );
      const response = await axios.post(
        `${supernodeURL}/make_inference_api_usage_request`,
        {
          inference_api_usage_request: validatedRequest,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 6 * 1000,
        }
      );
      const result = response.data;
      logActionWithPayload(
        "received",
        "response to inference usage request",
        result
      );
      let transformedResult = await prepareModelForValidation(result);
      delete transformedResult["id"];
      const { error: responseError, value: validatedResponse } =
        await inferenceAPIUsageResponseSchema.validate(transformedResult);
      if (responseError) {
        throw new Error(
          `Invalid inference API usage response: ${responseError.message}`
        );
      }
      const responseInstance = await InferenceAPIUsageResponse.create(
        validatedResponse
      );
      return responseInstance;
    } catch (error) {
      logger.error(
        `Error making inference API usage request: ${safeStringify(error)}`
      );
      throw error;
    }
  }

  async sendInferenceConfirmation(supernodeURL, confirmationData) {
    try {
      const confirmationDataJSON = confirmationData.toJSON();
      // Remove the 'id' field from the JSON object
      delete confirmationDataJSON["id"];

      const { error, value: validatedConfirmation } =
        await inferenceConfirmationSchema.validate(confirmationDataJSON);
      if (error) {
        throw new Error(
          `Invalid inference confirmation data: ${error.message}`
        );
      }
      const confirmationInstance = await InferenceConfirmation.create(
        validatedConfirmation
      );
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);

      const payload = await prepareModelForEndpoint(confirmationInstance);
      logActionWithPayload("sending", "inference confirmation", payload);
      const response = await axios.post(
        `${supernodeURL}/confirm_inference_request`,
        {
          inference_confirmation: confirmationDataJSON,
          challenge,
          challenge_id,
          challenge_signature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 4 * 1000,
        }
      );
      const result = response.data;
      logActionWithPayload(
        "receiving",
        "response to inference confirmation",
        result
      );

      return result;
    } catch (error) {
      logger.error(
        `Error sending inference confirmation: ${safeStringify(error.message)}`
      );
      throw error;
    }
  }
  async checkStatusOfInferenceRequestResults(
    supernodeURL,
    inferenceResponseID
  ) {
    try {
      logger.info(
        `Checking status of inference request results for ID ${inferenceResponseID}`
      );

      const response = await axios.get(
        `${supernodeURL}/check_status_of_inference_request_results/${inferenceResponseID}`,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );

      const result = response.data;
      logActionWithPayload(
        "receiving",
        `status of inference request results for ID ${inferenceResponseID}`,
        result
      );

      return typeof result === "boolean" ? result : false;
    } catch (error) {
      if (error.response) {
        logger.error(
          `HTTP error checking status of inference request results from Supernode URL: ${supernodeURL}: ${safeStringify(
            error
          )}`
        );
      } else {
        logger.error(
          `Error checking status of inference request results from Supernode URL: ${supernodeURL}: ${safeStringify(
            error
          )}`
        );
      }
      return false;
    }
  }

  async retrieveInferenceOutputResults(
    supernodeURL,
    inferenceRequestID,
    inferenceResponseID
  ) {
    try {
      const { challenge, challenge_id, challenge_signature } =
        await this.requestAndSignChallenge(supernodeURL);
      const params = new URLSearchParams({
        inference_response_id: inferenceResponseID,
        pastelid: this.pastelID,
        challenge,
        challenge_id,
        challenge_signature,
      }).toString();
      logActionWithPayload(
        "attempting",
        `to retrieve inference output results for response ID ${inferenceResponseID}`,
        params
      );
      const response = await axios.post(
        `${supernodeURL}/retrieve_inference_output_results?${params}`,
        {}, // No data object needed since we're sending parameters in the URL
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 4 * 1000,
        }
      );
      const result = response.data;
      delete result["id"]; // Remove the 'id' field from the JSON object
      logActionWithPayload("receiving", "inference output results", result);
      let transformedResult = await prepareModelForValidation(result);
      const { error: validationError, value: validatedResult } =
        await inferenceAPIOutputResultSchema.validate(transformedResult);
      if (validationError) {
        throw new Error(
          `Invalid inference API output result: ${validationError.message}`
        );
      }
      const resultInstance = await InferenceAPIOutputResult.create(
        validatedResult
      );
      return resultInstance;
    } catch (error) {
      logger.error(
        `Error retrieving inference output results: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async callAuditInferenceRequestResponse(supernodeURL, inferenceResponseID) {
    try {
      const signature = await signMessageWithPastelID(
        this.pastelID,
        inferenceResponseID,
        this.passphrase
      );
      const payload = {
        inference_response_id: inferenceResponseID,
        pastel_id: this.pastelID,
        signature,
      };
      const response = await axios.post(
        `${supernodeURL}/audit_inference_request_response`,
        payload,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 2 * 1000,
        }
      );
      const result = response.data;
      delete result["id"]; // Remove the 'id' field from the JSON object
      let transformedResult = await prepareModelForValidation(result);
      const { error: validationError, value: validatedResult } =
        await inferenceAPIUsageResponseSchema.validate(transformedResult);
      if (validationError) {
        throw new Error(
          `Invalid inference API usage response: ${validationError.message}`
        );
      }
      return validatedResult;
    } catch (error) {
      logger.error(
        `Error calling audit inference request response from Supernode URL: ${supernodeURL}: ${safeStringify(
          error
        )}`
      );
      throw error;
    }
  }

  async callAuditInferenceRequestResult(supernodeURL, inferenceResponseID) {
    try {
      const signature = await signMessageWithPastelID(
        this.pastelID,
        inferenceResponseID,
        this.passphrase
      );
      const payload = {
        inference_response_id: inferenceResponseID,
        pastel_id: this.pastelID,
        signature,
      };
      const response = await axios.post(
        `${supernodeURL}/audit_inference_request_result`,
        payload,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 2 * 1000,
        }
      );
      const result = response.data;
      delete result["id"]; // Remove the 'id' field from the JSON object
      let transformedResult = await prepareModelForValidation(result);
      const { error: validationError, value: validatedResult } =
        await inferenceAPIOutputResultSchema.validate(transformedResult);
      if (validationError) {
        throw new Error(
          `Invalid inference API output result: ${validationError.message}`
        );
      }
      return validatedResult;
    } catch (error) {
      logger.error(
        `Error calling audit inference request result from Supernode URL: ${supernodeURL}: ${safeStringify(
          error
        )}`
      );
      throw error;
    }
  }

  async auditInferenceRequestResponseID(
    inferenceResponseID,
    pastelIDOfSupernodeToAudit
  ) {
    try {
      const { validMasternodeListFullDF } = await checkSupernodeList();
      const filteredSupernodes = await filterSupernodes(validMasternodeListFullDF);

      const supernodeURLsAndPastelIDs = filteredSupernodes
        .filter(({ pastelID }) => pastelID !== pastelIDOfSupernodeToAudit)
        .slice(0, 5); // Get the 5 closest supernodes

      const listOfSupernodePastelIDs = supernodeURLsAndPastelIDs.map(({ pastelID }) => pastelID);
      const listOfSupernodeURLs = supernodeURLsAndPastelIDs.map(({ url }) => url);
      const listOfSupernodeIPs = listOfSupernodeURLs.map(
        (url) => url.split("//")[1].split(":")[0]
      );

      logger.info(
        `Now attempting to audit inference request response with ID ${inferenceResponseID} with ${listOfSupernodePastelIDs.length} closest supernodes (with Supernode IPs of ${listOfSupernodeIPs})...`
      );

      const responseAuditTasks = listOfSupernodeURLs.map((url) =>
        this.callAuditInferenceRequestResponse(url, inferenceResponseID)
      );
      const responseAuditResults = await Promise.all(responseAuditTasks);

      await new Promise((resolve) => setTimeout(resolve, 20000));

      logger.info(
        `Now attempting to audit inference request result for response ID ${inferenceResponseID} by comparing information from other Supernodes to the information reported by the Responding Supernode...`
      );

      const resultAuditTasks = listOfSupernodeURLs.map((url) =>
        this.callAuditInferenceRequestResult(url, inferenceResponseID)
      );
      const resultAuditResults = await Promise.all(resultAuditTasks);

      const auditResults = [...responseAuditResults, ...resultAuditResults];
      logger.info(
        `Audit results retrieved for inference response ID ${inferenceResponseID}`
      );

      return auditResults;
    } catch (error) {
      logger.error(
        `Error auditing inference request response ID: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async checkIfSupernodeSupportsDesiredModel(
    supernodeURL,
    modelCanonicalString,
    modelInferenceTypeString,
    modelParametersJSON
  ) {
    try {
      const response = await axios.get(
        `${supernodeURL}/get_inference_model_menu`,
        {
          timeout: 8 * 1000,
        }
      );

      const modelMenu = response.data;
      const desiredParameters = JSON.parse(modelParametersJSON);

      for (const model of modelMenu.models) {
        if (
          model.model_name === modelCanonicalString &&
          model.supported_inference_type_strings.includes(
            modelInferenceTypeString
          )
        ) {
          const unsupportedParameters = [];

          for (const [desiredParam, desiredValue] of Object.entries(
            desiredParameters
          )) {
            let paramFound = false;

            for (const param of model.model_parameters) {
              if (
                param.name === desiredParam &&
                param.inference_types_parameter_applies_to.includes(
                  modelInferenceTypeString
                )
              ) {
                if ("type" in param) {
                  if (
                    param.type === "int" &&
                    Number.isInteger(Number(desiredValue))
                  ) {
                    paramFound = true;
                  } else if (
                    param.type === "float" &&
                    !isNaN(parseFloat(desiredValue))
                  ) {
                    paramFound = true;
                  } else if (
                    param.type === "string" &&
                    typeof desiredValue === "string"
                  ) {
                    if (
                      "options" in param &&
                      param.options.includes(desiredValue)
                    ) {
                      paramFound = true;
                    } else if (!("options" in param)) {
                      paramFound = true;
                    }
                  }
                } else {
                  paramFound = true;
                }
                break;
              }
            }

            if (!paramFound) {
              unsupportedParameters.push(desiredParam);
            }
          }

          if (unsupportedParameters.length === 0) {
            return true;
          } else {
            const unsupportedParamStr = unsupportedParameters.join(", ");
            logger.error(
              `Unsupported model parameters for ${modelCanonicalString}: ${unsupportedParamStr}`
            );
            return false;
          }
        }
      }
      return false;
    } catch (error) {
      logger.error(
        `Error checking if Supernode supports desired model from Supernode URL: ${supernodeURL}: ${safeStringify(
          error
        )}`
      );
      return false;
    }
  }

  async getClosestSupernodeURLThatSupportsDesiredModel(
    desiredModelCanonicalString,
    desiredModelInferenceTypeString,
    desiredModelParametersJSON
  ) {
    const minimumNumberOfResponses = 3; // Minimum number of valid responses needed
    const timeoutPeriod = 3000; // Timeout period in milliseconds

    try {
      const { validMasternodeListFullDF } = await checkSupernodeList();
      const filteredSupernodes = await filterSupernodes(validMasternodeListFullDF);
      let validResponses = [];

      // Custom promise to collect a specified minimum number of valid responses
      await new Promise((resolve, reject) => {
        let completedRequests = 0;

        const checkSupernode = async (supernode) => {
          try {
            const result = await Promise.race([
              this.checkIfSupernodeSupportsDesiredModel(
                supernode.url,
                desiredModelCanonicalString,
                desiredModelInferenceTypeString,
                desiredModelParametersJSON
              ),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutPeriod))
            ]);
            if (result) {
              validResponses.push({ result, url: supernode.url });
              if (validResponses.length >= minimumNumberOfResponses) {
                resolve();
              }
            }
          } catch (error) {
            logger.error(`Error querying supernode at ${supernode.url}: ${error.message}`);
          } finally {
            completedRequests++;
            if (completedRequests >= filteredSupernodes.length && validResponses.length < minimumNumberOfResponses) {
              reject(new Error("Insufficient valid responses received from supernodes"));
            }
          }
        };

        filteredSupernodes.forEach(checkSupernode);
      });

      // Find the fastest valid response
      const fastestResponse = validResponses.reduce((prev, current) => {
        return prev.time < current.time ? prev : current;
      });

      if (fastestResponse) {
        logger.info(`Found supporting supernode: URL: ${fastestResponse.url}`);
        return {
          supernodeSupportDict: {
            [fastestResponse.url]: true,
          },
          closestSupportingSupernodeURL: fastestResponse.url,
        };
      } else {
        logger.warn(`No supporting supernodes found for model: ${desiredModelCanonicalString}`);
        return {
          supernodeSupportDict: {},
          closestSupportingSupernodeURL: null,
        };
      }
    } catch (error) {
      logger.error(`Error getting closest Supernode URL that supports desired model: ${safeStringify(error.message)}`);
      throw error;
    }
  }
}

module.exports = {
  PastelInferenceClient,
};
