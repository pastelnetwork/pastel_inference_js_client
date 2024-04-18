# Pastel Inference JavaScript Client

![Illustration](https://raw.githubusercontent.com/pastelnetwork/pastel_inference_js_client/master/illustration.webp)

The Pastel Inference JavaScript Client is a powerful tool for interacting with the Pastel Network and performing inference tasks using the network's decentralized infrastructure. This client allows you to create and manage inference credit packs, make inference requests, and verify the results returned by the supernodes.

## Table of Contents

- [Pastel Inference JavaScript Client](#pastel-inference-javascript-client)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Creating a New Credit Pack](#creating-a-new-credit-pack)
  - [Using a Credit Pack for Inference Requests](#using-a-credit-pack-for-inference-requests)
  - [Purchasing Inference Credits](#purchasing-inference-credits)
    - [Estimating the Cost](#estimating-the-cost)
    - [Creating a New Credit Tracking Address](#creating-a-new-credit-tracking-address)
    - [Initiating the Purchase Request](#initiating-the-purchase-request)
    - [Confirming the Purchase](#confirming-the-purchase)
    - [Checking the Purchase Status](#checking-the-purchase-status)
  - [Making Inference Requests](#making-inference-requests)
    - [Selecting a Supernode](#selecting-a-supernode)
    - [Preparing the Request](#preparing-the-request)
    - [Sending the Request](#sending-the-request)
    - [Confirming the Request](#confirming-the-request)
    - [Retrieving the Results](#retrieving-the-results)
  - [Verifying Inference Results](#verifying-inference-results)
    - [Auditing the Inference Response](#auditing-the-inference-response)
    - [Auditing the Inference Result](#auditing-the-inference-result)
    - [Validating the Audit Results](#validating-the-audit-results)
  - [Error Handling](#error-handling)
  - [Logging](#logging)
  - [Testing](#testing)
  - [Contributing](#contributing)
  - [License](#license)

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

## Configuration

Before using the client, you need to configure it with your Pastel ID and passphrase. You can do this by setting the following environment variables:

- `MY_LOCAL_PASTELID`: Your Pastel ID.
- `MY_PASTELID_PASSPHRASE`: The passphrase associated with your Pastel ID.

You can set these variables in a `.env` file in the root directory of your project:

```
MY_LOCAL_PASTELID=your_pastel_id
MY_PASTELID_PASSPHRASE=your_passphrase
```

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