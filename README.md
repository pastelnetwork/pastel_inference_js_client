# Pastel Inference JavaScript Client

![Illustration](https://raw.githubusercontent.com/pastelnetwork/pastel_inference_js_client/master/illustration.webp)

The Pastel Inference JavaScript Client is a powerful tool for interacting with the Pastel Network and performing inference tasks using the network's decentralized infrastructure. This client allows you to create and manage inference credit packs, make inference requests, and verify the results returned by the supernodes.

## Introduction

The Pastel Inference JavaScript Client is designed to simplify the process of interacting with the Pastel Network for inference tasks. It provides a high-level API for purchasing inference credits, making inference requests, and verifying the results.

The client communicates with the Pastel Network through a set of supernodes, which are responsible for processing inference requests and returning the results. The client selects the most appropriate supernode based on factors such as proximity and support for the requested model.

To use the client, you first need to purchase inference credits, which are stored in a credit pack associated with a specific Pastel ID. Once you have a credit pack, you can make inference requests by specifying the desired model, input data, and other parameters. The client will select a suitable supernode, send the request, and retrieve the results.

To ensure the integrity of the inference results, the client includes functionality for auditing the responses received from the supernodes. This involves comparing the results returned by multiple supernodes and validating the consistency of the responses.

## Installation

To install the Pastel Inference JavaScript Client, you need to have Node.js (version 14 or higher) installed on your system. You can install the client using npm:

```bash
npm install pastel-inference-js-client
```


## Inference Client Class and Message Validation

The `PastelInferenceClient` class is the core of the Pastel Inference JavaScript Client. It encapsulates all the functionality required to interact with the Pastel Network for inference tasks. The class provides methods for purchasing inference credits, making inference requests, and verifying the results.

### Class Methods

The `PastelInferenceClient` class includes several methods that cover the different aspects of the inference process:

- `requestAndSignChallenge`: Requests and signs a challenge from a supernode to authenticate the client.
- `sendUserMessage`: Sends a user message to a supernode.
- `getUserMessages`: Retrieves user messages from a supernode.
- `getCreditPackTicketFromTxid`: Retrieves a credit pack ticket from a transaction ID.
- `creditPackTicketInitialPurchaseRequest`: Initiates a credit pack purchase request.
- `creditPackTicketPreliminaryPriceQuoteResponse`: Responds to a preliminary price quote for a credit pack purchase.
- `checkStatusOfCreditPurchaseRequest`: Checks the status of a credit pack purchase request.
- `creditPackPurchaseCompletionAnnouncement`: Announces the completion of a credit pack purchase.
- `creditPackStorageRetryRequest`: Sends a credit pack storage retry request.
- `creditPackStorageRetryCompletionAnnouncement`: Announces the completion of a credit pack storage retry.
- `makeInferenceAPIUsageRequest`: Makes an inference API usage request.
- `sendInferenceConfirmation`: Sends an inference confirmation.
- `checkStatusOfInferenceRequestResults`: Checks the status of inference request results.
- `retrieveInferenceOutputResults`: Retrieves inference output results.
- `callAuditInferenceRequestResponse`: Calls an audit on an inference request response.
- `callAuditInferenceRequestResult`: Calls an audit on an inference request result.
- `auditInferenceRequestResponseID`: Audits an inference request response ID.
- `checkIfSupernodeSupportsDesiredModel`: Checks if a supernode supports a desired model.
- `getClosestSupernodeURLThatSupportsDesiredModel`: Gets the closest supernode URL that supports a desired model.

These methods cover the entire lifecycle of an inference request, from purchasing credits to retrieving and auditing the results.

### Message Validation with Joi

To ensure the integrity and validity of the messages exchanged between the client and the supernodes, the Pastel Inference JavaScript Client employs the Joi validation library. Joi is a powerful schema description language and data validator for JavaScript.

For each type of message, a corresponding Joi validation schema is defined in the `validation_schemas.js` file. These schemas specify the expected structure and data types of the message fields. Before sending or processing any message, the client validates the message against its respective schema using the `validate` method provided by Joi.

If a message fails validation, an error is thrown, preventing the processing of invalid or malformed messages. This validation step adds an extra layer of security and reliability to the communication between the client and the supernodes.

### Data Persistence with Sequelize and SQLite

The Pastel Inference JavaScript Client uses the Sequelize ORM (Object-Relational Mapping) library to interact with an SQLite database for data persistence. Sequelize provides a convenient way to define database models and perform database operations using JavaScript.

The database models are defined in the `sequelize_data_models.js` file. Each model corresponds to a specific type of message or data entity used in the inference process, such as `UserMessage`, `CreditPackPurchaseRequest`, `InferenceAPIUsageRequest`, etc.

When a message is received or created by the client, the relevant data is extracted and stored in the corresponding database model using the `create` method provided by Sequelize. This allows the client to persist important information and maintain a local record of the inference-related activities.

The use of Sequelize and SQLite provides several benefits:

- Data persistence: The client can store and retrieve data across sessions, ensuring that important information is not lost.
- Query flexibility: Sequelize provides a powerful query interface that allows the client to retrieve data based on various criteria.
- Data integrity: The database schema and constraints defined in the models help maintain data integrity and consistency.

## Creating a New Credit Pack

Creating a new credit pack involves a complex orchestration of messages between the client and the supernodes on the Pastel network. Here's a detailed overview of the process:

1. The client initiates a credit pack purchase request by sending a `CreditPackPurchaseRequest` message to a supernode. This message includes the desired number of credits, the authorized PastelIDs allowed to use the credit pack, and the credit usage tracking PSL address.

2. The supernode receives the request and validates the request fields. If the validation passes, the supernode generates a preliminary price quote for the credit pack based on the current market conditions and network state. The supernode then sends back a `CreditPackPurchaseRequestPreliminaryPriceQuote` message to the client.

3. The client reviews the preliminary price quote and decides whether to proceed with the purchase. If the client agrees with the price, they send a `CreditPackPurchaseRequestPreliminaryPriceQuoteResponse` message back to the supernode, indicating their agreement.

4. Upon receiving the client's agreement, the supernode selects a group of potentially agreeing supernodes based on their proximity to the client's PastelID. The supernode sends a `CreditPackPurchasePriceAgreementRequest` message to these supernodes, asking for their agreement on the proposed credit pack pricing.

5. The selected supernodes review the price agreement request and determine if they agree with the proposed pricing. They send back a `CreditPackPurchasePriceAgreementRequestResponse` message to the requesting supernode, indicating their agreement or disagreement.

6. The requesting supernode collects the responses from the agreeing supernodes and generates a final `CreditPackPurchaseRequestResponse` message. This message includes the agreed-upon pricing, the list of agreeing supernodes, and their signatures on the credit pack purchase request fields.

7. The client receives the final credit pack purchase request response and reviews the terms. If the client accepts the terms, they send a `CreditPackPurchaseRequestConfirmation` message to the responding supernode, along with the required burn transaction to purchase the credit pack.

8. The responding supernode validates the confirmation message and the burn transaction. If the validation passes, the supernode stores the credit pack ticket on the Pastel blockchain by creating a transaction with the compressed credit pack data. The supernode then sends a `CreditPackPurchaseRequestConfirmationResponse` message back to the client, indicating the success or failure of the credit pack storage.

9. The client receives the confirmation response and saves the credit pack ticket for future use.

Throughout this process, the client and supernodes exchange various messages to ensure the integrity and consensus of the credit pack creation. The supernodes work together to validate the pricing, store the credit pack on the blockchain, and maintain the overall security of the Pastel network.

## Using a Credit Pack for Inference Requests

Once a client has purchased a credit pack, they can use it to pay for inference requests on the Pastel network. Here's how the process works:

1. The client prepares an inference request by specifying the desired model, input data, and other necessary parameters. They also provide the credit pack ticket TXID to indicate the credit pack they want to use for payment.

2. The client sends an `InferenceAPIUsageRequest` message to a supernode, including the inference request details and the credit pack ticket TXID.

3. The supernode receives the request and validates it against the provided credit pack. It checks if the client is authorized to use the credit pack and if there are sufficient credits available for the requested inference.

4. If the validation passes, the supernode processes the inference request using the specified model and input data. It deducts the required number of credits from the credit pack and generates an `InferenceAPIUsageResponse` message, which includes the inference results and the updated credit pack balance.

5. The client receives the inference response and can use the results as needed. They can continue to make inference requests using the same credit pack until the credits are exhausted or the credit pack expires.

Throughout this process, the supernodes ensure that the client is authorized to use the credit pack and that the inference requests are processed correctly. The supernodes also handle the credit deduction and management of the credit pack balance.

By using credit packs, clients can efficiently pay for inference requests on the Pastel network without the need for individual transactions for each request. The credit pack system provides a convenient and secure way to access the network's inference capabilities.

## Security Measures and Validation Steps

The Pastel network employs various security measures and validation steps to ensure the integrity of credit packs and protect against potential abuse or fraud. These measures are implemented throughout the credit pack creation and usage process, involving both the client and the supernodes. Let's explore the key security aspects in detail:

### Credit Pack Creation

1. **Request Validation**: When a client sends a credit pack purchase request, the receiving supernode validates the request fields to ensure they are complete, well-formatted, and meet the required criteria. This validation helps prevent malformed or malicious requests from being processed.

2. **PastelID Verification**: The supernodes verify the PastelIDs involved in the credit pack purchase process, including the requesting client's PastelID and the authorized PastelIDs allowed to use the credit pack. This verification ensures that only valid and authorized entities can participate in the credit pack creation.

3. **Preliminary Price Quote Consensus**: The supernodes engage in a consensus process to agree on the preliminary price quote for the credit pack. Multiple supernodes review the proposed pricing and provide their agreement or disagreement. This consensus mechanism helps prevent any single supernode from manipulating the pricing and ensures fair market conditions.

4. **Burn Transaction Verification**: When a client confirms the credit pack purchase, they must provide a burn transaction to prove their commitment. The supernodes validate this burn transaction to ensure it meets the required criteria, such as the correct amount of PSL being burned and the transaction being confirmed on the Pastel blockchain.

5. **Credit Pack Storage**: Once the credit pack purchase is confirmed, the supernodes store the credit pack ticket on the Pastel blockchain. This storage process involves compressing the credit pack data, splitting it into multiple outputs, and creating a transaction with the outputs. The transaction is then signed and broadcast to the Pastel network for confirmation. Storing the credit pack on the blockchain provides immutability and security.

### Credit Pack Usage

1. **Authorization Check**: When a client makes an inference request using a credit pack, the supernodes verify that the client is authorized to use the specified credit pack. This check ensures that only the intended users can utilize the credits associated with the credit pack.

2. **Credit Pack Balance Verification**: The supernodes check the available balance of the credit pack before processing an inference request. They ensure that sufficient credits are available to cover the cost of the requested inference. If the balance is insufficient, the request is rejected, preventing overuse or abuse of the credit pack.

3. **Inference Result Verification**: After processing an inference request, the supernodes generate a hash of the inference results and include it in the `InferenceAPIUsageResponse` message. The client can verify this hash to ensure the integrity of the received inference results and detect any potential tampering.

4. **Credit Deduction and Balance Update**: Upon successful completion of an inference request, the supernodes deduct the appropriate number of credits from the credit pack balance. They update the credit pack ticket on the blockchain to reflect the new balance. This ensures accurate tracking of credit usage and prevents double-spending or unauthorized modifications.

### Communication Security

1. **Message Signing**: Important messages, such as credit pack purchase requests and confirmations, are signed using the PastelIDs of the involved parties. These signatures provide authentication and non-repudiation, preventing unauthorized modifications and ensuring accountability.

2. **Encryption**: Sensitive data, such as the credit pack ticket and inference results, can be encrypted using strong encryption algorithms to protect against unauthorized access. The encryption keys are securely managed and shared only between the authorized parties.

The Pastel network employs a robust security framework to ensure the integrity and authenticity of the messages exchanged between the client and the supernodes. Let's delve into the details of how the messages are secured and validated:

1. **Timestamp Validation**: Each message includes a UTC timestamp field, which is checked against the current time as perceived by the receiving supernode. If the timestamp in the message deviates significantly from the supernode's current time, the message is considered invalid and rejected. This mechanism prevents the use of stale or fabricated messages.

2. **Blockchain Height Validation**: The messages also contain information about the current Pastel blockchain height. If the blockchain height mentioned in the message differs from the supernode's view of the current height by more than a predefined threshold (e.g., 2 blocks), the message is deemed invalid. This validation step ensures that the messages are current and consistent with the state of the Pastel blockchain.

3. **Message Expiration**: Supernodes cannot hold onto old messages and use them later. Each message has a limited validity period, and if a message is not processed within that timeframe, it becomes invalid. This prevents the use of outdated or replayed messages.

4. **Message Integrity and Authentication**: To ensure the integrity and authenticity of the messages, a cryptographic hash is computed over the relevant fields of each message using the SHA3-256 algorithm. The hash is then signed using the sender's PastelID, which is a persistent Ed448 digital signature keypair. The signature is included in the message itself. Upon receiving a message, the supernode verifies the signature using the sender's public key. If the signature is invalid or the message fields have been tampered with, the message is rejected. This mechanism prevents unauthorized modifications and ensures that the messages originate from the claimed sender, making the communications resistant to man-in-the-middle (MITM) attacks.

5. **Challenge-Response Authentication**: Before a client can interact with a supernode's REST endpoints, it must go through a challenge-response authentication process using its PastelID. The client initiates the process by providing its PastelID public key to request a challenge from the supernode. The supernode generates a unique challenge ID and challenge string (both UUIDs) specific to the client's PastelID and sends them back to the client. The client must then sign the challenge string using the same PastelID and include the challenge ID, challenge string, and signature in the payload of subsequent requests to the supernode. Without a valid challenge response, the supernode considers the requests as invalid. The challenges have an expiration time (e.g., a few hours) to prevent their use by attackers at a later time.

6. **Broadcast and Auditing**: When a responding supernode processes a request, it broadcasts relevant information to other supernodes in real-time. This allows the other supernodes to audit the actions of the responding supernode contemporaneously. By keeping the other supernodes informed about the state of the system, it minimizes the possibility of disputes between clients and supernodes regarding the claimed actions. If a responding supernode fails to complete an inference request that a user has already paid for, the other supernodes can step in and complete the request based on the information they have received through the broadcasts.

These security measures work together to create a secure and trustworthy environment for communication and transactions between clients and supernodes in the Pastel network. The combination of message-level security, challenge-response authentication, and real-time auditing by other supernodes ensures the integrity, authenticity, and reliability of the interactions within the network.

By validating timestamps, blockchain heights, and message integrity, the Pastel network protects against various types of attacks, such as replay attacks, message tampering, and MITM attacks. The challenge-response mechanism adds an extra layer of authentication, ensuring that only authorized clients can interact with the supernodes. The broadcasting and auditing process provides transparency and accountability, deterring malicious behavior and enabling the network to recover from any potential failures or disputes.

## Purchasing Inference Credits

To make inference requests, you first need to purchase inference credits. The credits are stored in a credit pack associated with your Pastel ID. The process of purchasing credits involves several steps:

### Estimating the Cost

Before purchasing credits, you can estimate the cost based on the desired number of credits and the current market price. The `internalEstimateOfCreditPackTicketCostInPSL` function allows you to estimate the cost in PSL (Pastel native currency):

```javascript
const desiredNumberOfCredits = 1000;
const creditPriceCushionPercentage = 0.15;

const estimatedTotalCost = await inferenceClient.internalEstimateOfCreditPackTicketCostInPSL(
  desiredNumberOfCredits,
  creditPriceCushionPercentage
);
```

### Creating a New Credit Tracking Address

To purchase credits, you need to create a new credit tracking address and fund it with sufficient PSL to cover the cost of the credits and any associated transaction fees.

```javascript
const amountToFundCreditTrackingAddress = Math.round(
  estimatedTotalCost + transactionFees
);

const { newCreditTrackingAddress } = await createAndFundNewPSLCreditTrackingAddress(
  amountToFundCreditTrackingAddress
);
```

### Initiating the Purchase Request

Once you have a funded credit tracking address, you can initiate the purchase request by providing the desired number of credits and the credit tracking address.

```javascript
const purchaseRequest = {
  requesting_end_user_pastelid: myPastelId,
  requested_initial_credits_in_credit_pack: desiredNumberOfCredits,
  credit_usage_tracking_psl_address: newCreditTrackingAddress,
  // ... other request parameters
};

const preliminaryPriceQuote = await inferenceClient.creditPackTicketInitialPurchaseRequest(
  supernodeURL,
  purchaseRequest
);
```

The supernode will respond with a preliminary price quote, which you can review and confirm.

### Confirming the Purchase

After reviewing the preliminary price quote, you can confirm the purchase by sending a confirmation message to the supernode.

```javascript
const confirmedPurchase = await inferenceClient.creditPackTicketPreliminaryPriceQuoteResponse(
  supernodeURL,
  purchaseRequest,
  preliminaryPriceQuote
);
```

### Checking the Purchase Status

Once you have confirmed the purchase, you can check the status of the purchase request to ensure that it has been successfully processed.

```javascript
const purchaseStatus = await inferenceClient.checkStatusOfCreditPurchaseRequest(
  supernodeURL,
  purchaseRequest.sha3_256_hash_of_credit_pack_purchase_request_fields
);
```

## Making Inference Requests

With a valid credit pack, you can make inference requests to the Pastel Network. The process involves selecting a supernode, preparing the request, sending the request, confirming the request, and retrieving the results.

### Selecting a Supernode

The client automatically selects the most appropriate supernode based on factors such as proximity and support for the requested model.

```javascript
const { closestSupportingSupernodeURL } = await inferenceClient.getClosestSupernodeURLThatSupportsDesiredModel(
  requestedModelCanonicalString,
  modelInferenceTypeString,
  modelParametersJSON
);
```

### Preparing the Request

To make an inference request, you need to provide the credit pack ticket, input data, requested model, and other parameters.

```javascript
const inferenceRequestData = {
  inference_request_id: generateUniqueRequestId(),
  requesting_pastelid: myPastelId,
  credit_pack_ticket_pastel_txid: creditPackTicketTxid,
  requested_model_canonical_string: requestedModelCanonicalString,
  model_inference_type_string: modelInferenceTypeString,
  model_parameters_json: modelParametersJSON,
  model_input_data_json_b64: inputDataBase64,
  // ... other request parameters
};
```

### Sending the Request

Once you have prepared the request data, you can send the request to the selected supernode.

```javascript
const usageRequestResponse = await inferenceClient.makeInferenceAPIUsageRequest(
  supernodeURL,
  inferenceRequestData
);
```

### Confirming the Request

After sending the request, you need to confirm it by sending a confirmation message to the supernode. This message includes a tracking transaction that proves you have sufficient credits to cover the cost of the request.

```javascript
const confirmationData = {
  inference_request_id: inferenceRequestData.inference_request_id,
  requesting_pastelid: myPastelId,
  confirmation_transaction: {
    txid: trackingTransactionTxid,
  },
};

const confirmationResult = await inferenceClient.sendInferenceConfirmation(
  supernodeURL,
  confirmationData
);
```

### Retrieving the Results

Once the request has been confirmed, you can retrieve the inference results from the supernode.

```javascript
const resultsAvailable = await inferenceClient.checkStatusOfInferenceRequestResults(
  supernodeURL,
  inferenceResponseId
);

if (resultsAvailable) {
  const outputResults = await inferenceClient.retrieveInferenceOutputResults(
    supernodeURL,
    inferenceRequestId,
    inferenceResponseId
  );
  // Process the output results
}
```

## Verifying Inference Results

To ensure the integrity of the inference results, the client includes functionality for auditing the responses received from the supernodes. This involves comparing the results returned by multiple supernodes and validating the consistency of the responses.

### Auditing the Inference Response

The first step in verifying the inference results is to audit the inference response by comparing the responses received from multiple supernodes.

```javascript
const auditResults = await inferenceClient.auditInferenceRequestResponseID(
  inferenceResponseId,
  supernodePastelId
);
```

### Auditing the Inference Result

After auditing the inference response, you can audit the actual inference result by comparing the results received from multiple supernodes.

```javascript
const resultAuditResults = await Promise.all(
  supernodeURLs.map((url) =>
    inferenceClient.callAuditInferenceRequestResult(url, inferenceResponseId)
  )
);
```

### Validating the Audit Results

Finally, you can validate the audit results by comparing the majority responses and ensuring they match the expected values.

```javascript
const validationResults = validateInferenceData(
  inferenceResultDict,
  auditResults
);
```

## Error Handling

The client includes comprehensive error handling to deal with various scenarios such as invalid requests, network errors, and inconsistent responses. Errors are thrown as exceptions and should be caught and handled appropriately in your application.

## Logging

The client uses the Winston logging library to provide detailed logs of its operations. You can configure the logging level and destinations according to your needs.

## Testing

The client includes a suite of unit tests to ensure the correctness of its functionality. You can run the tests using the following command:

```bash
npm test
```

## Contributing

Contributions to the Pastel Inference JavaScript Client are welcome! If you find a bug or have a feature request, please open an issue on the GitHub repository. If you would like to contribute code, please fork the repository and submit a pull request.

## License

The Pastel Inference JavaScript Client is released under the MIT License. See the `LICENSE` file for more information.
