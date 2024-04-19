require("dotenv").config();
const axios = require("axios");
const {
  signMessageWithPastelID,
  checkSupernodeList,
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
  getNClosestSupernodesToPastelIDURLs,
  computeSHA3256HashOfSQLModelResponseFields,
  getCurrentPastelBlockHeight,
  estimatedMarketPriceOfInferenceCreditsInPSLTerms,
  logActionWithPayload,
  transformCreditPackPurchaseRequestResponse,
} = require("./utility_functions");

const MESSAGING_TIMEOUT_IN_SECONDS = process.env.MESSAGING_TIMEOUT_IN_SECONDS;

class PastelInferenceClient {
  constructor(pastelID, passphrase) {
    this.pastelID = pastelID;
    this.passphrase = passphrase;
  }

  async requestAndSignChallenge(supernodeURL) {
    try {
      const response = await axios.get(
        `${supernodeURL}/request_challenge/${this.pastelID}`
      );
      const { challenge, challenge_id } = response.data;
      const signature = await signMessageWithPastelID(
        this.pastelID,
        challenge,
        this.passphrase
      );
      return {
        challenge,
        challenge_id,
        signature,
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
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const payload = userMessage.toJSON();
      const response = await axios.post(
        `${supernodeURL}/send_user_message`,
        {
          user_message: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
      const result = response.data;
      const validatedResult = await userMessageSchema.validateAsync(result);
      const userMessageInstance = await UserMessage.create(validatedResult);
      return userMessageInstance;
    } catch (error) {
      logger.error(`Error sending user message: ${error.message}`);
      throw error;
    }
  }

  async getUserMessages(supernodeURL) {
    try {
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const { challenge, challenge_id, signature } = challengeResult;
      const params = {
        pastelid: this.pastelID,
        challenge,
        challenge_id,
        challenge_signature: signature,
      };
      const response = await axios.get(`${supernodeURL}/get_user_messages`, {
        params,
        timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
      });
      const result = response.data;
      const validatedResults = await Promise.all(
        result.map((messageData) =>
          userMessageSchema.validateAsync(messageData)
        )
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

  async getCreditPackTicketFromTxid(supernodeURL, txid) {
    try {
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const params = {
        txid,
        pastelid: this.pastelID,
        challenge,
        challenge_id,
        challenge_signature: challengeSignature,
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
      const result = response.data;
      const resultTransformed =
        transformCreditPackPurchaseRequestResponse(result);
      logActionWithPayload(
        "receiving",
        "credit pack ticket from Supernode",
        resultTransformed
      );
      const validatedResult =
        await creditPackPurchaseRequestResponseSchema.validateAsync(
          resultTransformed
        );
      const creditPackPurchaseRequestResponseInstance =
        await CreditPackPurchaseRequestResponse.create(validatedResult);
      return creditPackPurchaseRequestResponseInstance;
    } catch (error) {
      logger.error(`Error retrieving credit pack ticket: ${error.message}`);
      throw error;
    }
  }

  async creditPackTicketInitialPurchaseRequest(
    supernodeURL,
    creditPackRequest
  ) {
    try {
      const { error } =
        creditPackPurchaseRequestSchema.validate(creditPackRequest);
      if (error) {
        throw new Error(`Invalid credit pack request: ${error.message}`);
      }
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;

      const validatedCreditPackRequest =
        await creditPackPurchaseRequestSchema.validateAsync(creditPackRequest);
      const _creditPackPurchaseRequestInstance =
        await CreditPackPurchaseRequest.create(validatedCreditPackRequest);

      const payload = creditPackRequest.toJSON();
      logActionWithPayload(
        "requesting",
        "a new Pastel credit pack ticket",
        payload
      );
      const response = await axios.post(
        `${supernodeURL}/credit_purchase_initial_request`,
        {
          credit_pack_request: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
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
        const validatedRejection =
          await creditPackPurchaseRequestRejectionSchema.validateAsync(result);
        const creditPackPurchaseRequestRejectionInstance =
          await CreditPackPurchaseRequestRejection.create(validatedRejection);
        return creditPackPurchaseRequestRejectionInstance;
      } else {
        logActionWithPayload(
          "receiving",
          "response to credit pack purchase request",
          result
        );
        const validatedPriceQuote =
          await creditPackPurchaseRequestPreliminaryPriceQuoteSchema.validateAsync(
            result
          );
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
      credit_pack_purchase_request_fields_json: requestFields,
    } = preliminaryPriceQuote;
    const { requested_initial_credits_in_credit_pack: requestedCredits } =
      JSON.parse(requestFields);
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
    if (
      quotedPricePerCredit <= maximumPerCreditPriceInPSL &&
      quotedTotalPrice <= maximumTotalCreditPackPriceInPSL &&
      priceDifferencePercentage <=
        process.env
          .MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING
    ) {
      logger.info(
        `Preliminary price quote is within the acceptable range: ${quotedPricePerCredit} PSL per credit, ${quotedTotalPrice} PSL total, which is within the maximum of ${maximumPerCreditPriceInPSL} PSL per credit and ${maximumTotalCreditPackPriceInPSL} PSL total. The price difference from the estimated fair market price is ${
          priceDifferencePercentage * 100
        }%, which is within the allowed maximum of ${
          process.env
            .MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING *
          100
        }%.`
      );
      return true;
    } else {
      logger.warn(
        `Preliminary price quote exceeds the maximum acceptable price or the price difference from the estimated fair price is too high! Quoted price: ${quotedPricePerCredit} PSL per credit, ${quotedTotalPrice} PSL total, maximum price: ${maximumPerCreditPriceInPSL} PSL per credit, ${maximumTotalCreditPackPriceInPSL} PSL total. The price difference from the estimated fair market price is ${
          priceDifferencePercentage * 100
        }%, which exceeds the allowed maximum of ${
          process.env
            .MAXIMUM_LOCAL_CREDIT_PRICE_DIFFERENCE_TO_ACCEPT_CREDIT_PRICING *
          100
        }%.`
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
      const { error } =
        creditPackPurchaseRequestPreliminaryPriceQuoteResponseSchema.validate(
          preliminaryPriceQuote
        );
      if (error) {
        throw new Error(`Invalid preliminary price quote: ${error.message}`);
      }
      const agreeWithPriceQuote = await this.confirmPreliminaryPriceQuote(
        preliminaryPriceQuote,
        maximumTotalCreditPackPriceInPSL,
        maximumPerCreditPriceInPSL
      );
      const agreeWithPreliminaryPriceQuote = agreeWithPriceQuote;
      const priceQuoteResponse =
        CreditPackPurchaseRequestPreliminaryPriceQuoteResponse.build({
          sha3_256_hash_of_credit_pack_purchase_request_fields:
            creditPackRequest.sha3_256_hash_of_credit_pack_purchase_request_fields,
          sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields:
            preliminaryPriceQuote.sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields,
          credit_pack_purchase_request_fields_json:
            preliminaryPriceQuote.credit_pack_purchase_request_fields_json,
          agree_with_preliminary_price_quote: agreeWithPreliminaryPriceQuote,
          credit_usage_tracking_psl_address:
            preliminaryPriceQuote.credit_usage_tracking_psl_address,
          preliminary_quoted_price_per_credit_in_psl:
            preliminaryPriceQuote.preliminary_quoted_price_per_credit_in_psl,
          preliminary_price_quote_response_timestamp_utc_iso_string:
            new Date().toISOString(),
          preliminary_price_quote_response_pastel_block_height:
            await getCurrentPastelBlockHeight(),
          preliminary_price_quote_response_message_version_string: "1.0",
          requesting_end_user_pastelid:
            creditPackRequest.requesting_end_user_pastelid,
          sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields:
            "",
          requesting_end_user_pastelid_signature_on_preliminary_price_quote_response_hash:
            "",
        });
      priceQuoteResponse.sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields =
        await computeSHA3256HashOfSQLModelResponseFields(priceQuoteResponse);
      priceQuoteResponse.requesting_end_user_pastelid_signature_on_preliminary_price_quote_response_hash =
        await signMessageWithPastelID(
          creditPackRequest.requesting_end_user_pastelid,
          priceQuoteResponse.sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields,
          this.passphrase
        );
      const validatedPriceQuoteResponse =
        await creditPackPurchaseRequestPreliminaryPriceQuoteResponseSchema.validateAsync(
          priceQuoteResponse
        );
      const priceQuoteResponseInstance =
        await CreditPackPurchaseRequestPreliminaryPriceQuoteResponse.create(
          validatedPriceQuoteResponse
        );

      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const payload = priceQuoteResponseInstance.toJSON();
      logActionWithPayload(
        "sending",
        "price quote response to supernode",
        payload
      );
      const response = await axios.post(
        `${supernodeURL}/credit_purchase_preliminary_price_quote_response`,
        {
          preliminary_price_quote_response: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 3 * 1000,
        }
      );
      const result = response.data;
      if (result.termination_reason_string) {
        logger.error(
          `Credit pack purchase request response terminated: ${result.termination_reason_string}`
        );
        const validatedTermination =
          await creditPackPurchaseRequestResponseTerminationSchema.validateAsync(
            result
          );
        const terminationInstance =
          await CreditPackPurchaseRequestResponseTermination.create(
            validatedTermination
          );
        return terminationInstance;
      } else {
        const transformedResult =
          transformCreditPackPurchaseRequestResponse(result);
        logActionWithPayload(
          "receiving",
          "response to credit pack purchase request",
          transformedResult
        );
        const validatedResponse =
          await creditPackPurchaseRequestResponseSchema.validateAsync(
            transformedResult
          );
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

  async checkStatusOfCreditPurchaseRequest(
    supernodeURL,
    creditPackPurchaseRequestHash
  ) {
    try {
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
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
      const validatedStatusCheck =
        await creditPackRequestStatusCheckSchema.validateAsync(statusCheck);
      await CreditPackRequestStatusCheck.create(validatedStatusCheck);
      const payload = validatedStatusCheck.toJSON();
      logActionWithPayload(
        "checking",
        "status of credit pack purchase request",
        payload
      );
      const response = await axios.post(
        `${supernodeURL}/check_status_of_credit_purchase_request`,
        {
          credit_pack_request_status_check: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
      const result = response.data;
      logActionWithPayload(
        "receiving",
        "credit pack purchase request response from Supernode",
        result
      );
      const validatedResult =
        await creditPackPurchaseRequestStatusSchema.validateAsync(result);
      const statusInstance = await CreditPackPurchaseRequestStatus.create(
        validatedResult
      );
      return statusInstance;
    } catch (error) {
      logger.error(
        `Error checking status of credit purchase request: ${error.message}`
      );
      throw error;
    }
  }

  async creditPackPurchaseCompletionAnnouncement(
    supernodeURL,
    creditPackPurchaseRequestConfirmation
  ) {
    try {
      const { error } = creditPackPurchaseRequestConfirmationSchema.validate(
        creditPackPurchaseRequestConfirmation
      );
      if (error) {
        throw new Error(
          `Invalid credit pack purchase request confirmation: ${error.message}`
        );
      }
      const validatedConfirmation =
        await creditPackPurchaseRequestConfirmationSchema.validateAsync(
          creditPackPurchaseRequestConfirmation
        );
      const confirmationInstance =
        await CreditPackPurchaseRequestConfirmation.create(
          validatedConfirmation
        );
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const payload = confirmationInstance.toJSON();
      logActionWithPayload(
        "sending",
        "purchase completion announcement message",
        payload
      );
      await axios.post(
        `${supernodeURL}/credit_pack_purchase_completion_announcement`,
        {
          confirmation: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
    } catch (error) {
      logger.error(
        `Error sending credit pack purchase completion announcement: ${safeStringify(
          error.message
        )}`
      );
      throw error;
    }
  }

  async creditPackStorageRetryRequest(
    supernodeURL,
    creditPackStorageRetryRequest
  ) {
    try {
      const { error } = creditPackStorageRetryRequestSchema.validate(
        creditPackStorageRetryRequest
      );
      if (error) {
        throw new Error(
          `Invalid credit pack storage retry request: ${error.message}`
        );
      }
      const validatedRequest =
        await creditPackStorageRetryRequestSchema.validateAsync(
          creditPackStorageRetryRequest
        );
      const requestInstance = await CreditPackStorageRetryRequest.create(
        validatedRequest
      );
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const payload = requestInstance.toJSON();
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
          challenge_signature: challengeSignature,
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
      const validatedResponse =
        await creditPackStorageRetryRequestResponseSchema.validateAsync(result);
      const responseInstance =
        await CreditPackStorageRetryRequestResponse.create(validatedResponse);
      return responseInstance;
    } catch (error) {
      logger.error(
        `Error sending credit pack storage retry request: ${error.message}`
      );
      throw error;
    }
  }

  async creditPackStorageRetryCompletionAnnouncement(
    supernodeURL,
    creditPackStorageRetryRequestResponse
  ) {
    try {
      const { error } = creditPackStorageRetryRequestResponseSchema.validate(
        creditPackStorageRetryRequestResponse
      );
      if (error) {
        throw new Error(
          `Invalid credit pack storage retry request response: ${error.message}`
        );
      }
      const validatedResponse =
        await creditPackStorageRetryRequestResponseSchema.validateAsync(
          creditPackStorageRetryRequestResponse
        );
      const responseInstance =
        await CreditPackStorageRetryRequestResponse.create(validatedResponse);
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const payload = responseInstance.toJSON();
      logActionWithPayload(
        "sending",
        "storage retry completion announcement message",
        payload
      );
      await axios.post(
        `${supernodeURL}/credit_pack_storage_retry_completion_announcement`,
        {
          response: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
    } catch (error) {
      logger.error(
        `Error sending credit pack storage retry completion announcement: ${error.message}`
      );
      throw error;
    }
  }

  async makeInferenceAPIUsageRequest(supernodeURL, requestData) {
    try {
      const { error } = inferenceAPIUsageRequestSchema.validate(requestData);
      if (error) {
        throw new Error(
          `Invalid inference API usage request: ${error.message}`
        );
      }
      const validatedRequest =
        await inferenceAPIUsageRequestSchema.validateAsync(requestData);
      const requestInstance = await InferenceAPIUsageRequest.create(
        validatedRequest
      );
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const payload = requestInstance.toJSON();
      logActionWithPayload("making", "inference usage request", payload);
      const response = await axios.post(
        `${supernodeURL}/make_inference_api_usage_request`,
        {
          inference_api_usage_request: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
        },
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 3 * 1000,
        }
      );
      const result = response.data;
      logActionWithPayload(
        "received",
        "response to inference usage request",
        result
      );
      const validatedResponse =
        await inferenceAPIUsageResponseSchema.validateAsync(result);
      const responseInstance = await InferenceAPIUsageResponse.create(
        validatedResponse
      );
      return responseInstance;
    } catch (error) {
      logger.error(
        `Error making inference API usage request: ${error.message}`
      );
      throw error;
    }
  }

  async sendInferenceConfirmation(supernodeURL, confirmationData) {
    try {
      const { error } = inferenceConfirmationSchema.validate(confirmationData);
      if (error) {
        throw new Error(
          `Invalid inference confirmation data: ${error.message}`
        );
      }
      const validatedConfirmation =
        await inferenceConfirmationSchema.validateAsync(confirmationData);
      const confirmationInstance = await InferenceConfirmation.create(
        validatedConfirmation
      );
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const payload = confirmationInstance.toJSON();
      logActionWithPayload("sending", "inference confirmation", payload);
      const response = await axios.post(
        `${supernodeURL}/confirm_inference_request`,
        {
          inference_confirmation: payload,
          challenge,
          challenge_id,
          challenge_signature: challengeSignature,
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
      logger.error(`Error sending inference confirmation: ${error.message}`);
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
          `HTTP error checking status of inference request results from Supernode URL: ${supernodeURL}: ${error}`
        );
      } else {
        logger.error(
          `Error checking status of inference request results from Supernode URL: ${supernodeURL}: ${error}`
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
      const challengeResult = await this.requestAndSignChallenge(supernodeURL);
      const {
        challenge,
        challenge_id,
        signature: challengeSignature,
      } = challengeResult;
      const params = {
        inference_response_id: inferenceResponseID,
        pastelid: this.pastelID,
        challenge,
        challenge_id,
        challenge_signature: challengeSignature,
      };
      logActionWithPayload(
        "attempting",
        `to retrieve inference output results for response ID ${inferenceResponseID}`,
        params
      );
      const response = await axios.post(
        `${supernodeURL}/retrieve_inference_output_results`,
        null,
        {
          params,
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
        }
      );
      const result = response.data;
      logActionWithPayload("receiving", "inference output results", result);
      const validatedResult =
        await inferenceAPIOutputResultSchema.validateAsync(result);
      const resultInstance = await InferenceAPIOutputResult.create(
        validatedResult
      );
      return resultInstance;
    } catch (error) {
      logger.error(
        `Error retrieving inference output results: ${error.message}`
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
      logActionWithPayload(
        "calling",
        "audit inference request response",
        payload
      );
      const response = await axios.post(
        `${supernodeURL}/audit_inference_request_response`,
        payload,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 2 * 1000,
        }
      );
      const result = response.data;
      logActionWithPayload(
        "receiving",
        "response to audit inference request response",
        result
      );
      const validatedResult =
        await inferenceAPIUsageResponseSchema.validateAsync(result);
      const resultInstance = await InferenceAPIUsageResponse.create(
        validatedResult
      );
      return resultInstance;
    } catch (error) {
      logger.error(
        `Error calling audit inference request response from Supernode URL: ${supernodeURL}: ${error}`
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
      logActionWithPayload(
        "calling",
        "audit inference request result",
        payload
      );
      const response = await axios.post(
        `${supernodeURL}/audit_inference_request_result`,
        payload,
        {
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 2 * 1000,
        }
      );
      const result = response.data;
      logActionWithPayload(
        "receiving",
        "response to audit inference request result",
        result
      );
      const validatedResult =
        await inferenceAPIOutputResultSchema.validateAsync(result);
      const resultInstance = await InferenceAPIOutputResult.create(
        validatedResult
      );
      return resultInstance;
    } catch (error) {
      logger.error(
        `Error calling audit inference request result from Supernode URL: ${supernodeURL}: ${error}`
      );
      throw error;
    }
  }

  async auditInferenceRequestResponseID(
    inferenceResponseID,
    pastelIDOfSupernodeToAudit
  ) {
    try {
      const supernodeListDF = await checkSupernodeList();
      const n = 4;
      const supernodeURLsAndPastelIDs =
        await getNClosestSupernodesToPastelIDURLs(
          n,
          this.pastelID,
          supernodeListDF
        );
      const listOfSupernodePastelIDs = supernodeURLsAndPastelIDs
        .filter(({ pastelID }) => pastelID !== pastelIDOfSupernodeToAudit)
        .map(({ pastelID }) => pastelID);
      const listOfSupernodeURLs = supernodeURLsAndPastelIDs
        .filter(({ pastelID }) => pastelID !== pastelIDOfSupernodeToAudit)
        .map(({ url }) => url);
      const listOfSupernodeIPs = listOfSupernodeURLs.map(
        (url) => url.split("//")[1].split(":")[0]
      );
      logger.info(
        `Now attempting to audit inference request response with ID ${inferenceResponseID} with ${listOfSupernodePastelIDs.length} closest supernodes (with Supernode IPs of ${listOfSupernodeIPs})...`
      );
      logger.info(
        `Now attempting to audit inference request response with ID ${inferenceResponseID} by comparing information from other Supernodes to the information reported by the Responding Supernode...`
      );
      const responseAuditTasks = listOfSupernodeURLs.map((url) =>
        this.callAuditInferenceRequestResponse(url, inferenceResponseID)
      );
      const responseAuditResults = await Promise.all(responseAuditTasks);
      await new Promise();
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
        `Error auditing inference request response ID: ${error.message}`
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
          timeout: MESSAGING_TIMEOUT_IN_SECONDS * 1000,
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
              if (param.name === desiredParam) {
                if ("type" in param) {
                  if (param.type === "int" && Number.isInteger(desiredValue)) {
                    paramFound = true;
                  } else if (
                    param.type === "float" &&
                    typeof desiredValue === "number"
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
        `Error checking if Supernode supports desired model from Supernode URL: ${supernodeURL}: ${error}`
      );
      return false;
    }
  }

  async getClosestSupernodeURLThatSupportsDesiredModel(
    desiredModelCanonicalString,
    desiredModelInferenceTypeString,
    desiredModelParametersJSON
  ) {
    try {
      const supernodeListDF = await checkSupernodeList();
      const n = supernodeListDF.length;
      const supernodeURLsAndPastelIDs =
        await getNClosestSupernodesToPastelIDURLs(
          n,
          this.pastelID,
          supernodeListDF
        );
      const listOfSupernodePastelIDs = supernodeURLsAndPastelIDs.map(
        ({ pastelID }) => pastelID
      );
      const listOfSupernodeURLs = supernodeURLsAndPastelIDs.map(
        ({ url }) => url
      );
      const listOfSupernodeIPs = listOfSupernodeURLs.map(
        (url) => url.split("//")[1].split(":")[0]
      );
      logger.info(
        `Now attempting to check which supernodes support the desired model (${desiredModelCanonicalString}) with ${listOfSupernodePastelIDs.length} closest supernodes (with Supernode IPs of ${listOfSupernodeIPs})...`
      );
      const modelSupportTasks = listOfSupernodeURLs.map((url) =>
        this.checkIfSupernodeSupportsDesiredModel(
          url,
          desiredModelCanonicalString,
          desiredModelInferenceTypeString,
          desiredModelParametersJSON
        )
      );
      const modelSupportResults = await Promise.all(modelSupportTasks);
      const supernodeSupportDict = listOfSupernodePastelIDs.reduce(
        (dict, pastelID, index) => {
          dict[pastelID] = modelSupportResults[index];
          return dict;
        },
        {}
      );
      logger.info(
        `Found ${
          modelSupportResults.filter(Boolean).length
        } supernodes that support the desired model (${desiredModelCanonicalString}) out of ${
          modelSupportResults.length
        } checked.`
      );
      const closestSupportingSupernodePastelID =
        modelSupportResults.indexOf(true) !== -1
          ? listOfSupernodePastelIDs[modelSupportResults.indexOf(true)]
          : null;
      const closestSupportingSupernodeURL =
        modelSupportResults.indexOf(true) !== -1
          ? listOfSupernodeURLs[modelSupportResults.indexOf(true)]
          : null;
      logger.info(
        `Closest supporting supernode PastelID: ${closestSupportingSupernodePastelID} | URL: ${closestSupportingSupernodeURL}`
      );
      return {
        supernodeSupportDict,
        closestSupportingSupernodePastelID,
        closestSupportingSupernodeURL,
      };
    } catch (error) {
      logger.error(
        `Error getting closest Supernode URL that supports desired model: ${error.message}`
      );
      throw error;
    }
  }
}

module.exports = {
  PastelInferenceClient,
};
