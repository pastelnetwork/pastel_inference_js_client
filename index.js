const fs = require("fs");
const path = require("path");
const {
  getLocalRPCSettings,
  initializeRPCConnection,
  createAndFundNewPSLCreditTrackingAddress,
} = require("./rpc_functions");
const { PastelInferenceClient } = require("./pastel_inference_client");
const {
  sendMessageAndCheckForNewIncomingMessages,
  handleCreditPackTicketEndToEnd,
  getCreditPackTicketInfoEndToEnd,
  handleInferenceRequestEndToEnd,
} = require("./end_to_end_functions");
const { logger } = require("./logger");
const { prettyJSON } = require("./utility_functions");
async function main() {
  const { rpcport } = await getLocalRPCSettings();
  await initializeRPCConnection();

  let burnAddress;
  if (rpcport === "9932") {
    burnAddress = "PtpasteLBurnAddressXXXXXXXXXXbJ5ndd";
  } else if (rpcport === "19932") {
    burnAddress = "tPpasteLBurnAddressXXXXXXXXXXX3wy7u";
  } else if (rpcport === "29932") {
    burnAddress = "44oUgmZSL997veFEQDq569wv5tsT6KXf9QY7";
  }
  const globals = require("./globals");

  const useTestMessagingFunctionality = false;
  const useTestCreditPackTicketFunctionality = false;
  const useTestCreditPackTicketUsage = false;
  const useTestInferenceRequestFunctionality = false;
  const useTestLLMTextCompletion = false;
  const useTestImageGeneration = false;

  const MY_LOCAL_PASTELID = "";
  const MY_PASTELID_PASSPHRASE = "";
  const inferenceClient = new PastelInferenceClient(
    MY_LOCAL_PASTELID,
    MY_PASTELID_PASSPHRASE
  );

  // Define variables to store the credit pack ticket TXID and tracking address
  let creditPackTicketPastelTxid;
  let creditUsageTrackingPSLAddress;

  const savedCreditPackTicketPastelTxid =
    "e8954607c3e64a00e81b216516f403b687698c59ca31ef3faf92793a113fcd5e";

  if (useTestMessagingFunctionality) {
    const messageBody =
      "Hello, this is a brand 🍉 NEW test message from a regular user!";
    const toPastelID =
      "jXXiVgtFzLto4eYziePHjjb1hj3c6eXdABej5ndnQ62B8ouv1GYveJaD5QUMfainQM3b4MTieQuzFEmJexw8Cr";
    const messageDict = await sendMessageAndCheckForNewIncomingMessages(
      toPastelID,
      messageBody
    );
    logger.info(`Message data: ${prettyJSON(messageDict)}`);
  }

  if (useTestCreditPackTicketFunctionality && !creditPackTicketPastelTxid) {
    const desiredNumberOfCredits = 250;
    const amountOfPSLForTrackingTransactions = 10.0;
    const creditPriceCushionPercentage = 0.15;
    const maximumTotalAmountOfPSLToFundInNewTrackingAddress = 150000.0;
    const estimatedTotalCostInPSLForCreditPack =
      await inferenceClient.internalEstimateOfCreditPackTicketCostInPSL(
        desiredNumberOfCredits,
        creditPriceCushionPercentage
      );
    if (
      estimatedTotalCostInPSLForCreditPack >
      maximumTotalAmountOfPSLToFundInNewTrackingAddress
    ) {
      logger.error(
        `Estimated total cost of credit pack exceeds the maximum allowed amount of ${maximumTotalAmountOfPSLToFundInNewTrackingAddress} PSL`
      );
      throw new Error(
        `Estimated total cost of credit pack exceeds the maximum allowed amount of ${maximumTotalAmountOfPSLToFundInNewTrackingAddress} PSL`
      );
    }
    const amountToFundCreditTrackingAddress = Math.round(
      amountOfPSLForTrackingTransactions + estimatedTotalCostInPSLForCreditPack
    );
    const { newCreditTrackingAddress: creditUsageTrackingPSLAddress } =
      await createAndFundNewPSLCreditTrackingAddress(
        amountToFundCreditTrackingAddress
      );
    const creditPackPurchaseRequestConfirmationResponse =
      await handleCreditPackTicketEndToEnd(
        desiredNumberOfCredits,
        creditUsageTrackingPSLAddress,
        burnAddress
      );
    if (creditPackPurchaseRequestConfirmationResponse) {
      // Store the TXID and tracking address from the credit pack ticket creation response
      creditPackTicketPastelTxid =
        creditPackPurchaseRequestConfirmationResponse.pastel_api_credit_pack_ticket_registration_txid;
      const creditUsageTrackingPSLAddress =
        creditPackPurchaseRequestConfirmationResponse.credit_usage_tracking_psl_address;
      logger.info(
        `Credit pack ticket stored on the blockchain with transaction ID: ${creditPackPurchaseRequestConfirmationResponse.pastel_api_credit_pack_ticket_registration_txid} (corresponding to tracking address: ${creditUsageTrackingPSLAddress})`
      );
      logger.info(
        `Credit pack details: ${prettyJSON(
          creditPackPurchaseRequestConfirmationResponse
        )}`
      );
    } else {
      logger.error("Credit pack ticket storage failed!");
    }
  }

  // Check if creditPackTicketPastelTxid is undefined
  if (typeof creditPackTicketPastelTxid === "undefined") {
    // If undefined, assign the value of savedCreditPackTicketPastelTxid
    creditPackTicketPastelTxid = savedCreditPackTicketPastelTxid;
  }
  logger.info(
    `Selected credit pack ticket transaction ID: ${creditPackTicketPastelTxid}`
  );

  if (useTestCreditPackTicketUsage) {
    // Check if a credit pack ticket TXID is available
    if (creditPackTicketPastelTxid) {
      const startTime = Date.now();
      const { requestResponse, requestConfirmation } =
        await getCreditPackTicketInfoEndToEnd(creditPackTicketPastelTxid);

      // Decoding Base64 using Buffer
      let credit_pack_purchase_request_fields_json = Buffer.from(
        requestResponse.credit_pack_purchase_request_fields_json_b64,
        "base64"
      ).toString("utf-8");
      const creditPackPurchaseRequestDict = JSON.parse(
        credit_pack_purchase_request_fields_json
      );
      const initialCreditPackBalance =
        creditPackPurchaseRequestDict.requested_initial_credits_in_credit_pack;

      logger.info(
        `Credit pack ticket data retrieved with initial balance ${initialCreditPackBalance}`
      );
      logger.info(
        `Corresponding credit pack request dict: ${prettyJSON(
          creditPackPurchaseRequestDict
        )}`
      );

      const endTime = Date.now();
      const durationInSeconds = (endTime - startTime) / 1000;
      logger.info(
        `Total time taken for credit pack ticket lookup: ${durationInSeconds.toFixed(
          2
        )} seconds`
      );
    }
  }

  if (useTestInferenceRequestFunctionality) {
    if (useTestLLMTextCompletion) {
      // Check if a credit pack ticket TXID is available
      if (creditPackTicketPastelTxid) {
        const startTime = Date.now();
        const inputPromptTextToLLM =
          "how do you measure the speed of an earthquake?";
        const requestedModelCanonicalString = "claude3-opus";
        const modelInferenceTypeString = "text_completion";
        const modelParameters = {
          number_of_tokens_to_generate: 2000,
          number_of_completions_to_generate: 1,
        };
        const maxCreditCostToApproveInferenceRequest = 200.0;
        const { inferenceResultDict, auditResults, validationResults } =
          await handleInferenceRequestEndToEnd(
            creditPackTicketPastelTxid,
            inputPromptTextToLLM,
            requestedModelCanonicalString,
            modelInferenceTypeString,
            modelParameters,
            maxCreditCostToApproveInferenceRequest,
            burnAddress
          );
        logger.info(
          `Inference result data:\n\n${prettyJSON(inferenceResultDict)}`
        );
        logger.info(`Audit results:\n\n${prettyJSON(auditResults)}`);
        logger.info(`Validation results:\n\n${prettyJSON(validationResults)}`);
        logger.info(
          "\n_____________________________________________________________________\n"
        );
        logger.info(
          `\n\nFinal Decoded Inference Result:\n\n${inferenceResultDict.inference_result_decoded}`
        );
        const endTime = Date.now();
        const durationInMinutes = (endTime - startTime) / 60000;
        logger.info(
          `Total time taken for inference request: ${durationInMinutes.toFixed(
            2
          )} minutes`
        );
      }
    }

    if (useTestImageGeneration) {
      // Check if a credit pack ticket TXID is available
      if (creditPackTicketPastelTxid) {
        const startTime = Date.now();
        const inputPromptTextToLLM =
          "A picture of a clown holding a sign that says PASTEL";
        const requestedModelCanonicalString = "stability-core";
        const modelInferenceTypeString = "text_to_image";
        const styleStringsList = [
          "3d-model",
          "analog-film",
          "anime",
          "cinematic",
          "comic-book",
          "digital-art",
          "enhance",
          "fantasy-art",
          "isometric",
          "line-art",
          "low-poly",
          "modeling-compound",
          "neon-punk",
          "origami",
          "photographic",
          "pixel-art",
          "tile-texture",
        ];
        const stylePresetString = styleStringsList[styleStringsList.length - 3];
        const outputFormatList = ["png", "jpeg", "webp"];
        const outputFormatString = outputFormatList[0];
        const aspectRatioList = [
          "16:9",
          "1:1",
          "21:9",
          "2:3",
          "3:2",
          "4:5",
          "5:4",
          "9:16",
          "9:21",
        ];
        const aspectRatioString = aspectRatioList[0];
        const randomSeed = Math.floor(Math.random() * 1001);

        let modelParameters;
        if (requestedModelCanonicalString.includes("core")) {
          modelParameters = {
            aspect_ratio: aspectRatioString,
            seed: randomSeed,
            style_preset: stylePresetString,
            output_format: outputFormatString,
            negative_prompt: "low quality, blurry, pixelated",
          };
        } else {
          modelParameters = {
            height: 512,
            width: 512,
            steps: 50,
            seed: 0,
            num_samples: 1,
            negative_prompt: "low quality, blurry, pixelated",
            style_preset: stylePresetString,
          };
        }

        const maxCreditCostToApproveInferenceRequest = 200.0;
        const { inferenceResultDict, auditResults, validationResults } =
          await handleInferenceRequestEndToEnd(
            creditPackTicketPastelTxid,
            inputPromptTextToLLM,
            requestedModelCanonicalString,
            modelInferenceTypeString,
            modelParameters,
            maxCreditCostToApproveInferenceRequest,
            burnAddress
          );

        logger.info(
          `Inference result data received at ${new Date()}; decoded image size in megabytes: ${inferenceResultDict.generated_image_decoded.length / (1024 * 1024)
          }`
        );
        logger.info(`Audit results:\n\n${prettyJSON(auditResults)}`);
        logger.info(`Validation results:\n\n${prettyJSON(validationResults)}`);

        logger.info(
          "\n_____________________________________________________________________\n"
        );

        const currentDatetimeString = new Date()
          .toISOString()
          .replace(/[-:.]/g, "_")
          .slice(0, -5);
        const imageGenerationPromptWithoutWhitespaceOrNewlinesAbbreviatedTo100Characters =
          inputPromptTextToLLM.replace(/\s+/g, "_").slice(0, 100);
        const generatedImageFilename = `generated_image__prompt__${imageGenerationPromptWithoutWhitespaceOrNewlinesAbbreviatedTo100Characters}__generated_on_${currentDatetimeString}.${outputFormatString}`;
        const generatedImageFolderName = "generated_images";

        if (!fs.existsSync(generatedImageFolderName)) {
          fs.mkdirSync(generatedImageFolderName);
        }

        const generatedImageFilePath = path.join(
          generatedImageFolderName,
          generatedImageFilename
        );
        const imageData = inferenceResultDict.generated_image_decoded;
        fs.writeFileSync(generatedImageFilePath, imageData);

        logger.info(`Generated image saved as '${generatedImageFilePath}'`);

        const endTime = Date.now();
        const durationInMinutes = (endTime - startTime) / 60000;
        logger.info(
          `Total time taken for inference request: ${durationInMinutes.toFixed(
            2
          )} minutes`
        );
      }
    }
  }
}

main().catch((error) => {
  logger.error(`Error in main function: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
  process.exit(1);
});

module.exports = {
  logger,
};
