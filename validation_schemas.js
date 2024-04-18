const Joi = require('joi');

const supernodeListSchema = Joi.object({
  supernode_status: Joi.string().required(),
  protocol_version: Joi.number().required(),
  supernode_psl_address: Joi.string().required(),
  lastseentime: Joi.number().required(),
  activeseconds: Joi.number().required(),
  lastpaidtime: Joi.number().required(),
  lastpaidblock: Joi.number().required(),
  "ipaddress:port": Joi.string().required(),
  rank: Joi.number().required(),
  pubkey: Joi.string().required(),
  extAddress: Joi.string().required(),
  extP2P: Joi.string().required(),
  extKey: Joi.string().required(),
});

const messageSchema = Joi.object({
    sending_sn_pastelid: Joi.string().required(),
    receiving_sn_pastelid: Joi.string().required(),
    sending_sn_txid_vout: Joi.string().required(),
    receiving_sn_txid_vout: Joi.string().required(),
    message_type: Joi.string().required(),
    message_body: Joi.object().required(),
    signature: Joi.string().required(),
    timestamp: Joi.date().iso(),
  });
  
  const userMessageSchema = Joi.object({
    from_pastelid: Joi.string().required(),
    to_pastelid: Joi.string().required(),
    message_body: Joi.object().required(),
    message_signature: Joi.string().required(),
    timestamp: Joi.date().iso(),
  });
  
  const creditPackPurchaseRequestSchema = Joi.object({
    requesting_end_user_pastelid: Joi.string().required(),
    requested_initial_credits_in_credit_pack: Joi.number().integer().required(),
    list_of_authorized_pastelids_allowed_to_use_credit_pack: Joi.array().items(Joi.string()).required(),
    credit_usage_tracking_psl_address: Joi.string().required(),
    request_timestamp_utc_iso_string: Joi.string().required(),
    request_pastel_block_height: Joi.number().integer().required(),
    credit_purchase_request_message_version_string: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    requesting_end_user_pastelid_signature_on_request_hash: Joi.string().required(),
  });
  
  const creditPackPurchaseRequestRejectionSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    credit_pack_purchase_request_fields_json: Joi.object().required(),
    rejection_reason_string: Joi.string().required(),
    rejection_timestamp_utc_iso_string: Joi.string().required(),
    rejection_pastel_block_height: Joi.number().integer().required(),
    credit_purchase_request_rejection_message_version_string: Joi.string().required(),
    responding_supernode_pastelid: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_rejection_fields: Joi.string().required(),
    responding_supernode_signature_on_credit_pack_purchase_request_rejection_hash: Joi.string().required(),
  });
  
  const creditPackPurchaseRequestPreliminaryPriceQuoteSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    credit_usage_tracking_psl_address: Joi.string().required(),
    credit_pack_purchase_request_fields_json: Joi.object().required(),
    preliminary_quoted_price_per_credit_in_psl: Joi.number().required(),
    preliminary_total_cost_of_credit_pack_in_psl: Joi.number().required(),
    preliminary_price_quote_timestamp_utc_iso_string: Joi.string().required(),
    preliminary_price_quote_pastel_block_height: Joi.number().integer().required(),
    preliminary_price_quote_message_version_string: Joi.string().required(),
    responding_supernode_pastelid: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields: Joi.string().required(),
    responding_supernode_signature_on_credit_pack_purchase_request_preliminary_price_quote_hash: Joi.string().required(),
  });
  
  const creditPackPurchaseRequestPreliminaryPriceQuoteResponseSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields: Joi.string().required(),
    credit_pack_purchase_request_fields_json: Joi.object().required(),
    agree_with_preliminary_price_quote: Joi.boolean().required(),
    credit_usage_tracking_psl_address: Joi.string().required(),
    preliminary_quoted_price_per_credit_in_psl: Joi.number().required(),
    preliminary_price_quote_response_timestamp_utc_iso_string: Joi.string().required(),
    preliminary_price_quote_response_pastel_block_height: Joi.number().integer().required(),
    preliminary_price_quote_response_message_version_string: Joi.string().required(),
    requesting_end_user_pastelid: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields: Joi.string().required(),
    requesting_end_user_pastelid_signature_on_preliminary_price_quote_response_hash: Joi.string().required(),
  });
  
  const creditPackPurchaseRequestResponseTerminationSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    credit_pack_purchase_request_fields_json: Joi.object().required(),
    termination_reason_string: Joi.string().required(),
    termination_timestamp_utc_iso_string: Joi.string().required(),
    termination_pastel_block_height: Joi.number().integer().required(),
    credit_purchase_request_termination_message_version_string: Joi.string().required(),
    responding_supernode_pastelid: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_termination_fields: Joi.string().required(),
    responding_supernode_signature_on_credit_pack_purchase_request_termination_hash: Joi.string().required(),
  });
  
  const creditPackPurchaseRequestResponseSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    credit_pack_purchase_request_fields_json: Joi.object().required(),
    psl_cost_per_credit: Joi.number().required(),
    proposed_total_cost_of_credit_pack_in_psl: Joi.number().required(),
    credit_usage_tracking_psl_address: Joi.string().required(),
    request_response_timestamp_utc_iso_string: Joi.string().required(),
    request_response_pastel_block_height: Joi.number().integer().required(),
    credit_purchase_request_response_message_version_string: Joi.string().required(),
    responding_supernode_pastelid: Joi.string().required(),
    list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms: Joi.array().items(Joi.string()).required(),
    list_of_agreeing_supernode_pastelids_signatures_on_price_agreement_request_response_hash: Joi.array().items(Joi.string()).required(),
    list_of_agreeing_supernode_pastelids_signatures_on_credit_pack_purchase_request_fields_json: Joi.array().items(Joi.string()).required(),
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: Joi.string().required(),
    responding_supernode_signature_on_credit_pack_purchase_request_response_hash: Joi.string().required(),
  });
  
  const creditPackPurchaseRequestConfirmationSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: Joi.string().required(),
    credit_pack_purchase_request_fields_json: Joi.object().required(),
    requesting_end_user_pastelid: Joi.string().required(),
    txid_of_credit_purchase_burn_transaction: Joi.string().required(),
    credit_purchase_request_confirmation_utc_iso_string: Joi.string().required(),
    credit_purchase_request_confirmation_pastel_block_height: Joi.number().integer().required(),
    credit_purchase_request_confirmation_message_version_string: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: Joi.string().required(),
    requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: Joi.string().required(),
  });
  
  const creditPackRequestStatusCheckSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    requesting_end_user_pastelid: Joi.string().required(),
    requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
  });
  
  const creditPackPurchaseRequestStatusSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: Joi.string().required(),
    status: Joi.string().required(),
    status_details: Joi.string().required(),
    status_update_timestamp_utc_iso_string: Joi.string().required(),
    status_update_pastel_block_height: Joi.number().integer().required(),
    credit_purchase_request_status_message_version_string: Joi.string().required(),
    responding_supernode_pastelid: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_status_fields: Joi.string().required(),
    responding_supernode_signature_on_credit_pack_purchase_request_status_hash: Joi.string().required(),
  });
  
  const creditPackStorageRetryRequestSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: Joi.string().required(),
    credit_pack_purchase_request_fields_json: Joi.object().required(),
    requesting_end_user_pastelid: Joi.string().required(),
    closest_agreeing_supernode_to_retry_storage_pastelid: Joi.string().required(),
    credit_pack_storage_retry_request_timestamp_utc_iso_string: Joi.string().required(),
    credit_pack_storage_retry_request_pastel_block_height: Joi.number().integer().required(),
    credit_pack_storage_retry_request_message_version_string: Joi.string().required(),
    sha3_256_hash_of_credit_pack_storage_retry_request_fields: Joi.string().required(),
    requesting_end_user_pastelid_signature_on_credit_pack_storage_retry_request_hash: Joi.string().required(),
  });
  
  const creditPackStorageRetryRequestResponseSchema = Joi.object({
    sha3_256_hash_of_credit_pack_purchase_request_fields: Joi.string().required(),
    sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: Joi.string().required(),
    credit_pack_storage_retry_confirmation_outcome_string: Joi.string().required(),
    pastel_api_credit_pack_ticket_registration_txid: Joi.string().required(),
    credit_pack_storage_retry_confirmation_failure_reason_if_applicable: Joi.string().required(),
    credit_pack_storage_retry_confirmation_response_utc_iso_string: Joi.string().required(),
    credit_pack_storage_retry_confirmation_response_pastel_block_height: Joi.number().integer().required(),
    credit_pack_storage_retry_confirmation_response_message_version_string: Joi.string().required(),
    closest_agreeing_supernode_to_retry_storage_pastelid: Joi.string().required(),
    sha3_256_hash_of_credit_pack_storage_retry_confirmation_response_fields: Joi.string().required(),
    closest_agreeing_supernode_to_retry_storage_pastelid_signature_on_credit_pack_storage_retry_confirmation_response_hash: Joi.string().required(),
  });
  
  const inferenceAPIUsageRequestSchema = Joi.object({
    inference_request_id: Joi.string().required(),
    requesting_pastelid: Joi.string().required(),
    credit_pack_ticket_pastel_txid: Joi.string().required(),
    requested_model_canonical_string: Joi.string().required(),
    model_inference_type_string: Joi.string().required(),
    model_parameters_json: Joi.object().required(),
    model_input_data_json_b64: Joi.string().required(),
    inference_request_utc_iso_string: Joi.string().required(),
    inference_request_pastel_block_height: Joi.number().integer().required(),
    status: Joi.string().required(),
    inference_request_message_version_string: Joi.string().required(),
    sha3_256_hash_of_inference_request_fields: Joi.string().required(),
    requesting_pastelid_signature_on_request_hash: Joi.string().required(),
  });
  
  const inferenceAPIUsageResponseSchema = Joi.object({
    inference_response_id: Joi.string().required(),
    inference_request_id: Joi.string().required(),
    proposed_cost_of_request_in_inference_credits: Joi.number().required(),
    remaining_credits_in_pack_after_request_processed: Joi.number().required(),
    credit_usage_tracking_psl_address: Joi.string().required(),
    request_confirmation_message_amount_in_patoshis: Joi.number().integer().required(),
    max_block_height_to_include_confirmation_transaction: Joi.number().integer().required(),
    inference_request_response_utc_iso_string: Joi.string().required(),
    inference_request_response_pastel_block_height: Joi.number().integer().required(),
    inference_request_response_message_version_string: Joi.string().required(),
    sha3_256_hash_of_inference_request_response_fields: Joi.string().required(),
    supernode_pastelid_and_signature_on_inference_request_response_hash: Joi.string().required(),
  });
  
  const inferenceAPIOutputResultSchema = Joi.object({
    inference_result_id: Joi.string().required(),
    inference_request_id: Joi.string().required(),
    inference_response_id: Joi.string().required(),
    responding_supernode_pastelid: Joi.string().required(),
    inference_result_json_base64: Joi.string().required(),
    inference_result_file_type_strings: Joi.string().required(),
    inference_result_utc_iso_string: Joi.string().required(),
    inference_result_pastel_block_height: Joi.number().integer().required(),
    inference_result_message_version_string: Joi.string().required(),
    sha3_256_hash_of_inference_result_fields: Joi.string().required(),
    responding_supernode_signature_on_inference_result_id: Joi.string().required(),
  });
  
  const inferenceConfirmationSchema = Joi.object({
    inference_request_id: Joi.string().required(),
    requesting_pastelid: Joi.string().required(),
    confirmation_transaction: Joi.object().required(),
  });
  
  async function createInferenceAPIUsageResponse(data) {
    const { error, value } = inferenceAPIUsageResponseSchema.validate(data);
    if (error) {
      throw new Error(`Invalid data: ${error.details[0].message}`);
    }
    const inferenceAPIUsageResponse = await InferenceAPIUsageResponse.create(value);
    return inferenceAPIUsageResponse;
  }
  
  async function createInferenceAPIOutputResult(data) {
    const { error, value } = inferenceAPIOutputResultSchema.validate(data);
    if (error) {
      throw new Error(`Invalid data: ${error.details[0].message}`);
    }
    const inferenceAPIOutputResult = await InferenceAPIOutputResult.create(value);
    return inferenceAPIOutputResult;
  }
  
  async function createInferenceConfirmation(data) {
    const { error, value } = inferenceConfirmationSchema.validate(data);
    if (error) {
      throw new Error(`Invalid data: ${error.details[0].message}`);
    }
    const inferenceConfirmation = await InferenceConfirmation.create(value);
    return inferenceConfirmation;
  }


  module.exports = {
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
  };