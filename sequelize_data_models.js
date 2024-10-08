require("dotenv").config();
const { Sequelize, DataTypes } = require("sequelize");

// SQLite database in project root directory
const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: "pastel_inference_client.sqlite", // Path to the database file
  logging: false, // Disable logging; default: console.log
});

sequelize
  .authenticate()
  .then(() => console.log("Connection has been established successfully."))
  .catch((err) => console.error("Unable to connect to the database:", err));

const SupernodeList = sequelize.define(
  "SupernodeList",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    txid_vout: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    supernode_status: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    protocol_version: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    supernode_psl_address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    lastseentime: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    activeseconds: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    activedays: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    lastpaidtime: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lastpaidblock: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    ipaddress_port: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rank: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    pubkey: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    extAddress: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    extP2P: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    extKey: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "supernode_lists",
    timestamps: false,
  }
);

const Message = sequelize.define(
  "Message",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    sending_sn_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    receiving_sn_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sending_sn_txid_vout: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    receiving_sn_txid_vout: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    message_type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    message_body: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    signature: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
  },
  {
    tableName: "messages",
    timestamps: false,
  }
);

const UserMessage = sequelize.define(
  "UserMessage",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    from_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    to_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    message_body: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    message_signature: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
  },
  {
    tableName: "user_messages",
    timestamps: false,
  }
);

const CreditPackPurchaseRequest = sequelize.define(
  "CreditPackPurchaseRequest",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    requesting_end_user_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requested_initial_credits_in_credit_pack: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    list_of_authorized_pastelids_allowed_to_use_credit_pack: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    credit_usage_tracking_psl_address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    request_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    request_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_purchase_request_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    requesting_end_user_pastelid_signature_on_request_hash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_requests",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestRejection = sequelize.define(
  "CreditPackPurchaseRequestRejection",
  {
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_purchase_request_fields_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rejection_reason_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rejection_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rejection_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_purchase_request_rejection_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_rejection_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_signature_on_credit_pack_purchase_request_rejection_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_rejections",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestPreliminaryPriceQuote = sequelize.define(
  "CreditPackPurchaseRequestPreliminaryPriceQuote",
  {
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_usage_tracking_psl_address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_purchase_request_fields_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    preliminary_quoted_price_per_credit_in_psl: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    preliminary_total_cost_of_credit_pack_in_psl: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    preliminary_price_quote_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    preliminary_price_quote_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    preliminary_price_quote_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_signature_on_credit_pack_purchase_request_preliminary_price_quote_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_preliminary_price_quotes",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestPreliminaryPriceQuoteResponse = sequelize.define(
  "CreditPackPurchaseRequestPreliminaryPriceQuoteResponse",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_fields:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_purchase_request_fields_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    agree_with_preliminary_price_quote: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    credit_usage_tracking_psl_address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    preliminary_quoted_price_per_credit_in_psl: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    preliminary_price_quote_response_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    preliminary_price_quote_response_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    preliminary_price_quote_response_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_end_user_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_preliminary_price_quote_response_fields:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_end_user_pastelid_signature_on_preliminary_price_quote_response_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_preliminary_price_quote_responses",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestResponseTermination = sequelize.define(
  "CreditPackPurchaseRequestResponseTermination",
  {
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_purchase_request_fields_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    termination_reason_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    termination_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    termination_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_purchase_request_termination_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_termination_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_signature_on_credit_pack_purchase_request_termination_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_response_terminations",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestResponse = sequelize.define(
  "CreditPackPurchaseRequestResponse",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_purchase_request_fields_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    psl_cost_per_credit: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    proposed_total_cost_of_credit_pack_in_psl: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    credit_usage_tracking_psl_address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    request_response_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    request_response_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    best_block_merkle_root: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    best_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_purchase_request_response_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    list_of_blacklisted_supernode_pastelids: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    list_of_potentially_agreeing_supernodes: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    list_of_supernode_pastelids_agreeing_to_credit_pack_purchase_terms_selected_for_signature_inclusion:
    {
      type: DataTypes.JSON,
      allowNull: false,
    },
    selected_agreeing_supernodes_signatures_dict: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    responding_supernode_signature_on_credit_pack_purchase_request_response_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_responses",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestConfirmation = sequelize.define(
  "CreditPackPurchaseRequestConfirmation",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "credit_pack_purchase_requests",
        key: "sha3_256_hash_of_credit_pack_purchase_request_fields",
      },
    },
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "credit_pack_purchase_request_responses",
        key: "sha3_256_hash_of_credit_pack_purchase_request_response_fields",
      },
    },
    credit_pack_purchase_request_fields_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_end_user_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    txid_of_credit_purchase_burn_transaction: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_purchase_request_confirmation_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_purchase_request_confirmation_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_purchase_request_confirmation_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_confirmations",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestConfirmationResponse = sequelize.define(
  "CreditPackPurchaseRequestConfirmationResponse",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "credit_pack_purchase_requests",
        key: "sha3_256_hash_of_credit_pack_purchase_request_fields",
      },
    },
    sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "credit_pack_purchase_request_confirmations",
        key: "sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields",
      },
    },
    credit_pack_confirmation_outcome_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    pastel_api_credit_pack_ticket_registration_txid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_confirmation_failure_reason_if_applicable: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "",
    },
    credit_purchase_request_confirmation_response_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_purchase_request_confirmation_response_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_purchase_request_confirmation_response_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_confirmation_response_fields:
    {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    responding_supernode_signature_on_credit_pack_purchase_request_confirmation_response_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_confirmation_responses",
    timestamps: false,
  }
);

const CreditPackRequestStatusCheck = sequelize.define(
  "CreditPackRequestStatusCheck",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_end_user_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_end_user_pastelid_signature_on_sha3_256_hash_of_credit_pack_purchase_request_fields:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_request_status_checks",
    timestamps: false,
  }
);

const CreditPackPurchaseRequestStatus = sequelize.define(
  "CreditPackPurchaseRequestStatus",
  {
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "credit_pack_purchase_requests",
        key: "sha3_256_hash_of_credit_pack_purchase_request_fields",
      },
    },
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "credit_pack_purchase_request_responses",
        key: "sha3_256_hash_of_credit_pack_purchase_request_response_fields",
      },
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status_details: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status_update_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status_update_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_purchase_request_status_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_status_fields: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    responding_supernode_signature_on_credit_pack_purchase_request_status_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_purchase_request_statuses",
    timestamps: false,
  }
);

const CreditPackStorageRetryRequest = sequelize.define(
  "CreditPackStorageRetryRequest",
  {
    sha3_256_hash_of_credit_pack_purchase_request_response_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_purchase_request_fields_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_end_user_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    closest_agreeing_supernode_to_retry_storage_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_storage_retry_request_timestamp_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_storage_retry_request_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_pack_storage_retry_request_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_storage_retry_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_end_user_pastelid_signature_on_credit_pack_storage_retry_request_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_storage_retry_requests",
    timestamps: false,
  }
);

const CreditPackStorageRetryRequestResponse = sequelize.define(
  "CreditPackStorageRetryRequestResponse",
  {
    sha3_256_hash_of_credit_pack_purchase_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_purchase_request_confirmation_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_storage_retry_confirmation_outcome_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    pastel_api_credit_pack_ticket_registration_txid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_storage_retry_confirmation_failure_reason_if_applicable: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_storage_retry_confirmation_response_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_storage_retry_confirmation_response_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    credit_pack_storage_retry_confirmation_response_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    closest_agreeing_supernode_to_retry_storage_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_credit_pack_storage_retry_confirmation_response_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    closest_agreeing_supernode_to_retry_storage_pastelid_signature_on_credit_pack_storage_retry_confirmation_response_hash:
    {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "credit_pack_storage_retry_request_responses",
    timestamps: false,
  }
);

const InferenceAPIUsageRequest = sequelize.define(
  "InferenceAPIUsageRequest",
  {
    inference_request_id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    requesting_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_pack_ticket_pastel_txid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requested_model_canonical_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    model_inference_type_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    model_parameters_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    model_input_data_json_b64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_request_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_request_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_request_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_inference_request_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_pastelid_signature_on_request_hash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "inference_api_usage_requests",
    timestamps: false,
  }
);

const InferenceAPIUsageResponse = sequelize.define(
  "InferenceAPIUsageResponse",
  {
    inference_response_id: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    inference_request_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "inference_api_usage_requests",
        key: "inference_request_id",
      },
    },
    proposed_cost_of_request_in_inference_credits: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    remaining_credits_in_pack_after_request_processed: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    credit_usage_tracking_psl_address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    request_confirmation_message_amount_in_patoshis: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    max_block_height_to_include_confirmation_transaction: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    inference_request_response_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_request_response_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    inference_request_response_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_inference_request_response_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    supernode_pastelid_and_signature_on_inference_request_response_hash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "inference_api_usage_responses",
    timestamps: false,
  }
);

const InferenceAPIOutputResult = sequelize.define(
  "InferenceAPIOutputResult",
  {
    inference_result_id: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    inference_request_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "inference_api_usage_requests",
        key: "inference_request_id",
      },
    },
    inference_response_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: "inference_api_usage_responses",
        key: "inference_response_id",
      },
    },
    responding_supernode_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_result_json_base64: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_result_file_type_strings: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_result_utc_iso_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inference_result_pastel_block_height: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    inference_result_message_version_string: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sha3_256_hash_of_inference_result_fields: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    responding_supernode_signature_on_inference_result_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "inference_api_output_results",
    timestamps: false,
  }
);

const InferenceConfirmation = sequelize.define(
  "InferenceConfirmation",
  {
    inference_request_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requesting_pastelid: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    confirmation_transaction: {
      type: DataTypes.JSON,
      allowNull: false,
    },
  },
  {
    tableName: "inference_confirmations",
    timestamps: false,
  }
);

// Sync all defined models to the DB
sequelize.sync({ force: true }).then(() => {
  console.log("Database & tables created!");
});

async function initializeDatabase() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ force: true }); // This will recreate all tables
    console.log("All models were synchronized successfully.");
  } catch (error) {
    console.error("Unable to connect to the database:", error);
  }
}

module.exports = {
  SupernodeList,
  Message,
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
  initializeDatabase
};
