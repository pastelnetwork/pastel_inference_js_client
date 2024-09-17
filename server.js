// server.js

const express = require("express");
const multer = require("multer");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const os = require("os");
const path = require("path");
const fs = require("fs");
const {
  getCurrentPastelIdAndPassphrase,
  setPastelIdAndPassphrase,
} = require("./storage");
const { PastelInferenceClient } = require("./pastel_inference_client");

const {
  checkForNewIncomingMessages,
  sendMessageAndCheckForNewIncomingMessages,
  handleCreditPackTicketEndToEnd,
  getCreditPackTicketInfoEndToEnd,
  getMyValidCreditPackTicketsEndToEnd,
  handleInferenceRequestEndToEnd,
  estimateCreditPackCostEndToEnd,
} = require("./end_to_end_functions");
const {
  getLocalRPCSettings,
  getNetworkInfo,
  initializeRPCConnection,
  createAndFundNewPSLCreditTrackingAddress,
  checkSupernodeList,
  registerPastelID,
  listPastelIDTickets,
  findPastelIDTicket,
  getPastelTicket,
  listContractTickets,
  findContractTicket,
  getContractTicket,
  importPrivKey,
  importWallet,
  listAddressAmounts,
  getBalance,
  getWalletInfo,
  getNewAddress,
  checkForRegisteredPastelID,
  createAndRegisterNewPastelID,
  stopPastelDaemon,
  startPastelDaemon,
  getMyPslAddressWithLargestBalance,
  isPastelIDRegistered,
  isCreditPackConfirmed,
  ensureTrackingAddressesHaveMinimalPSLBalance,
} = require("./rpc_functions");
const { initializeDatabase } = require('./sequelize_data_models');
const { generatePromotionalPacks } = require("./create_promotional_packs");
const { logger, logEmitter, logBuffer, safeStringify } = require("./logger");
const {
  prettyJSON,
  getClosestSupernodeToPastelIDURL,
  getNClosestSupernodesToPastelIDURLs,
  importPromotionalPack
} = require("./utility_functions");
const globals = require("./globals");
let MY_LOCAL_PASTELID = "";
let MY_PASTELID_PASSPHRASE = "";

const app = express();
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(bodyParser.json({ limit: "50mb" }));
const upload = multer({ dest: "uploads/" });

const port = process.env.CLIENT_PORT || 3100;
const webSocketPort = process.env.CLIENT_WEBSOCKET_PORT || 3101;

const wss = new WebSocket.Server({ port: webSocketPort }, () => {
  console.log(`WebSocket server started on port ${webSocketPort}`);
});

function getServerIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

app.get("/ws-url", (req, res) => {
  const ipAddress = getServerIpAddress();
  const wsUrl = `ws://${ipAddress}:${webSocketPort}`;
  res.json({ wsUrl });
});

wss.on("connection", (ws) => {
  logger.info(`Client connected: ${ws}`);

  logBuffer.forEach((logEntry) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(logEntry);
    }
  });

  const logListener = (logEntry) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(logEntry);
    }
  };
  logEmitter.on("newLog", logListener);

  ws.on("message", (message) => {
    logger.info(`Received message from client: ${message}`);
  });

  ws.on("close", (code, reason) => {
    logger.info(`Client disconnected; code: ${code}, reason: ${reason}`);
    logEmitter.removeListener("newLog", logListener);
  });

  ws.on("error", (error) => {
    logger.error(`WebSocket error: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
    logEmitter.removeListener("newLog", logListener);
  });
});

async function initializeServer() {
  try {
    const { pastelID, passphrase } = await getCurrentPastelIdAndPassphrase();
    if (pastelID && passphrase) {
      // Set global variables
      globals.setPastelIdAndPassphrase(pastelID, passphrase);

      // Set local variables
      MY_LOCAL_PASTELID = pastelID;
      MY_PASTELID_PASSPHRASE = passphrase;

      logger.info(`Successfully set global and local PastelID`);
    } else {
      logger.warn(
        `Failed to set global and local PastelID and passphrase from storage`
      );
    }

    // Rest of your server initialization code...
  } catch (error) {
    logger.error(`Error initializing server: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
    process.exit(1);
  }
}

let rpcport;
let network;

(async () => {
  try {
    await initializeDatabase();
    await initializeRPCConnection();
    await initializeServer();
    const rpcSettings = await getLocalRPCSettings();
    rpcport = rpcSettings.rpcport;
    network = getNetworkInfo(rpcport).network;

    const { pastelID, passphrase } = await getCurrentPastelIdAndPassphrase();
    if (pastelID && passphrase) {
      MY_LOCAL_PASTELID = pastelID;
      MY_PASTELID_PASSPHRASE = passphrase;
      logger.info(`Successfully set global PastelID`);
    } else {
      logger.warn(`Failed to set global PastelID and passphrase from storage`);
    }

    const { validMasternodeListFullDF } = await checkSupernodeList();
    if (!validMasternodeListFullDF) {
      throw new Error(
        "The Pastel Daemon is not fully synced, and thus the Supernode information commands are not returning complete information. Finish fully syncing and try again."
      );
    }

    let supernodeURL;
    if (MY_LOCAL_PASTELID !== "") {
      const result = await getClosestSupernodeToPastelIDURL(
        MY_LOCAL_PASTELID,
        validMasternodeListFullDF
      );
      if (result) {
        supernodeURL = result.url;
      }
    }

    async function configureRPCAndSetBurnAddress() {
      try {
        let burnAddress;
        if (rpcport === "9932") {
          burnAddress = "PtpasteLBurnAddressXXXXXXXXXXbJ5ndd";
        } else if (rpcport === "19932") {
          burnAddress = "tPpasteLBurnAddressXXXXXXXXXXX3wy7u";
        } else if (rpcport === "29932") {
          burnAddress = "44oUgmZSL997veFEQDq569wv5tsT6KXf9QY7";
        } else {
          throw new Error(`Unsupported RPC port: ${rpcport}`);
        }
        return burnAddress;
      } catch (error) {
        console.error("Failed to configure RPC or set burn address:", error);
        throw error;
      }
    }

    app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "index.html"));
    });

    app.get("/favicon.ico", (req, res) => {
      res.sendFile(path.join(__dirname, "favicon.ico"));
    });

    app.get("/get-network-info", async (req, res) => {
      try {
        res.json({ network });
      } catch (error) {
        console.error("Error getting network info:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to get network info" });
      }
    });

    app.get("/get-best-supernode-url", async (req, res) => {
      try {
        const userPastelID = req.query.userPastelID;
        const supernodeListDF = await checkSupernodeList();
        const { url: supernodeURL } = await getClosestSupernodeToPastelIDURL(
          userPastelID,
          supernodeListDF.validMasternodeListFullDF
        );
        if (!supernodeURL) {
          throw new Error("No valid supernode URL found.");
        }
        res.json({ success: true, supernodeURL });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-inference-model-menu", async (req, res) => {
      try {
        if (!MY_LOCAL_PASTELID || !MY_PASTELID_PASSPHRASE) {
          return res.status(400).json({
            success: false,
            message: "Pastel ID and passphrase not set.",
          });
        }
        const pastelInferenceClient = new PastelInferenceClient(
          MY_LOCAL_PASTELID,
          MY_PASTELID_PASSPHRASE
        );
        const modelMenu = await pastelInferenceClient.getModelMenu();
        res.json({ success: true, modelMenu });
      } catch (error) {
        logger.error(`Error in getInferenceModelMenu: ${safeStringify(error).slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/estimate-credit-pack-cost", async (req, res) => {
      const { desiredNumberOfCredits, creditPriceCushionPercentage } = req.body;
      try {
        const result = await estimateCreditPackCostEndToEnd(
          desiredNumberOfCredits,
          creditPriceCushionPercentage
        );
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/send-message", async (req, res) => {
      const { toPastelID, messageBody } = req.body;
      try {
        const messageDict = await sendMessageAndCheckForNewIncomingMessages(
          toPastelID,
          messageBody
        );
        res.json({ success: true, messageDict });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-received-messages", async (req, res) => {
      try {
        const messageDict = await checkForNewIncomingMessages();
        res.json({ success: true, messageDict });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/create-credit-pack-ticket", async (req, res) => {
      const burnAddress = await configureRPCAndSetBurnAddress();
      const {
        numCredits,
        creditUsageTrackingPSLAddress,
        maxTotalPrice,
        maxPerCreditPrice,
      } = req.body;
      try {
        const result = await handleCreditPackTicketEndToEnd(
          numCredits,
          creditUsageTrackingPSLAddress,
          burnAddress,
          maxTotalPrice,
          maxPerCreditPrice
        );
        res.json({ success: true, result });
      } catch (error) {
        console.error("Error in create-credit-pack-ticket:", error);
        res.status(500).json({
          success: false,
          error: error.message,
          details: error.details || "No additional details available",
        });
      }
    });

    app.get("/credit-pack-info/:txid", async (req, res) => {
      const { txid } = req.params;
      try {
        const result = await getCreditPackTicketInfoEndToEnd(txid);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-my-valid-credit-packs", async (req, res) => {
      try {
        const result = await getMyValidCreditPackTicketsEndToEnd();
        res.json({ success: true, result: result || [] });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-my-psl-address-with-largest-balance", async (req, res) => {
      try {
        const result = await getMyPslAddressWithLargestBalance();
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/create-inference-request", async (req, res) => {
      const {
        model_inference_type_string: modelInferenceTypeString,
        model_parameters_json_b64,
        model_input_data_json_b64,
        selectedCreditPackTicketId: creditPackTicketPastelTxid,
        maxCost: maximumInferenceCostInCredits,
        model_canonical_name: requestedModelCanonicalString,
      } = req.body;
      try {
        const burnAddress = await configureRPCAndSetBurnAddress();
        const modelParameters = JSON.parse(
          Buffer.from(model_parameters_json_b64, "base64").toString()
        );
        const modelInputData = JSON.parse(
          Buffer.from(model_input_data_json_b64, "base64").toString()
        );
        console.log(`Model Inference Type: ${modelInferenceTypeString}`);
        const result = await handleInferenceRequestEndToEnd(
          creditPackTicketPastelTxid,
          modelInputData,
          requestedModelCanonicalString,
          modelInferenceTypeString,
          modelParameters,
          maximumInferenceCostInCredits,
          burnAddress
        );
        res.json({ success: true, result });
      } catch (error) {
        console.error("Error in create-inference-request:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/check-supernode-list", async (req, res) => {
      try {
        const { validMasternodeListFullDF } = await checkSupernodeList();
        res.json({ success: true, result: { validMasternodeListFullDF } });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/register-pastel-id", async (req, res) => {
      const { pastelid, passphrase, address } = req.body;
      try {
        const result = await registerPastelID(pastelid, passphrase, address);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/list-pastel-id-tickets", async (req, res) => {
      const { filter, minheight } = req.query;
      try {
        const result = await listPastelIDTickets(filter, minheight);
        console.log("Pastel ID Tickets:", result);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/find-pastel-id-ticket/:key", async (req, res) => {
      const { key } = req.params;
      try {
        const result = await findPastelIDTicket(key);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-pastel-ticket/:txid", async (req, res) => {
      const { txid } = req.params;
      const { decodeProperties } = req.query;
      try {
        const result = await getPastelTicket(txid, decodeProperties);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/list-contract-tickets", async (req, res) => {
      const { ticketTypeIdentifier, startingBlockHeight } = req.query;
      try {
        const result = await listContractTickets(
          ticketTypeIdentifier,
          startingBlockHeight
        );
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/find-contract-ticket/:key", async (req, res) => {
      const { key } = req.params;
      try {
        const result = await findContractTicket(key);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-contract-ticket/:txid", async (req, res) => {
      const { txid } = req.params;
      const { decodeProperties } = req.query;
      try {
        const result = await getContractTicket(txid, decodeProperties);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/import-priv-key", async (req, res) => {
      const { zcashPrivKey, label, rescan } = req.body;
      try {
        const result = await importPrivKey(zcashPrivKey, label, rescan);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/import-wallet", async (req, res) => {
      const { filename } = req.body;
      try {
        const result = await importWallet(filename);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/list-address-amounts", async (req, res) => {
      const { includeEmpty, isMineFilter } = req.query;
      try {
        const result = await listAddressAmounts(includeEmpty, isMineFilter);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-balance", async (req, res) => {
      try {
        const result = await getBalance();
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/get-wallet-info", async (req, res) => {
      try {
        const result = await getWalletInfo();
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/create-and-fund-new-address", async (req, res) => {
      try {
        const { amount } = req.body;
        const result = await createAndFundNewPSLCreditTrackingAddress(amount);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/check-for-pastel-id", async (req, res) => {
      const { autoRegister } = req.body;
      try {
        const result = await checkForRegisteredPastelID(autoRegister);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post(
      "/import-pastel-id",
      upload.single("pastelIDFile"),
      async (req, res) => {
        try {
          const destFolder = getNetworkSpecificDestFolder(network);
          fs.mkdirSync(destFolder, { recursive: true });
          const sourceFilePath = req.file.path;
          const destFilePath = path.join(destFolder, req.file.originalname);
          fs.renameSync(sourceFilePath, destFilePath);

          await stopPastelDaemon();
          await startPastelDaemon();

          res.json({
            success: true,
            message: "PastelID imported successfully!",
          });
        } catch (error) {
          console.error("Error importing PastelID:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to import PastelID." });
        }
      }
    );

    app.get("/credit-pack-status/:txid", async (req, res) => {
      try {
        const txid = req.params.txid;
        const confirmed = await isCreditPackConfirmed(txid);
        res.json({ confirmed });
      } catch (error) {
        console.error("Error checking credit pack status:", error);
        res.status(500).json({ error: "Failed to check credit pack status" });
      }
    });

    app.post("/create-and-register-pastel-id", async (req, res) => {
      const { passphraseForNewPastelID } = req.body;
      try {
        const result = await createAndRegisterNewPastelID(
          passphraseForNewPastelID
        );
        if (result.success) {
          res.json({
            success: true,
            PastelID: result.PastelID,
            PastelIDRegistrationTXID: result.PastelIDRegistrationTXID,
          });
        } else {
          res.json({ success: false, message: result.message });
        }
      } catch (error) {
        logger.error(
          `Error in create-and-register-pastel-id: ${safeStringify(error).slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`
        );
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get("/check-pastel-id-status/:pastelID", async (req, res) => {
      try {
        const pastelID = req.params.pastelID;
        const isRegistered = await isPastelIDRegistered(pastelID);
        res.json({ registered: isRegistered });
      } catch (error) {
        console.error("Error checking PastelID status:", error);
        res.status(500).json({ error: "Failed to check PastelID status" });
      }
    });

    app.post("/set-pastel-id-passphrase", async (req, res) => {
      const { pastelID, passphrase } = req.body;
      try {
        // Check if the PastelID is valid
        const isValid = await isPastelIDRegistered(pastelID);

        if (!isValid) {
          // If not valid, send a response indicating that the PastelID is invalid
          return res.json({ success: false, message: "Invalid PastelID" });
        }

        // If valid, proceed with updating storage and global variables
        await setPastelIdAndPassphrase(pastelID, passphrase);
        globals.setPastelIdAndPassphrase(pastelID, passphrase);
        MY_LOCAL_PASTELID = pastelID;
        MY_PASTELID_PASSPHRASE = passphrase;

        res.json({ success: true });
        app.emit("pastelIDAndPassphraseSet");
      } catch (error) {
        console.error("Error setting PastelID and passphrase:", error);
        res.status(500).json({
          success: false,
          message: "Failed to set PastelID and passphrase",
        });
      }
    });

    app.post("/ensure-minimal-psl-balance", async (req, res) => {
      try {
        const { addresses } = req.body; // Expects a JSON body with an "addresses" array
        await ensureTrackingAddressesHaveMinimalPSLBalance(addresses);
        res.json({
          success: true,
          message: "Balance check and update process initiated.",
        });
      } catch (error) {
        logger.error(
          `Error in ensuring minimal PSL balance: ${safeStringify(error).slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`
        );
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/ensure-minimal-psl-balance", async (req, res) => {
      try {
        await ensureTrackingAddressesHaveMinimalPSLBalance();
        res.json({
          success: true,
          message:
            "Balance check and update process initiated for all addresses.",
        });
      } catch (error) {
        logger.error(
          `Error in ensuring minimal PSL balance for all addresses: ${safeStringify(
            error
          )}`
        );
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/check-pastel-id-validity', async (req, res) => {
      try {
        const { pastelID } = req.body;
        const isValid = await isPastelIDRegistered(pastelID);
        res.json({ isValid });
      } catch (error) {
        console.error("Error checking PastelID validity:", error);
        res.status(500).json({ error: "Failed to check PastelID validity" });
      }
    });

    app.get('/dump-priv-key/:tAddr', async (req, res) => {
      const { tAddr } = req.params;
      try {
        const privateKey = await dumpPrivKey(tAddr);
        res.json({ success: true, privateKey });
      } catch (error) {
        logger.error(`Error dumping private key for address ${tAddr}: ${safeStringify(error).slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/generate-promo-packs', async (req, res) => {
      const { numberOfPacks, creditsPerPack } = req.body;

      if (!numberOfPacks || !creditsPerPack) {
        return res.status(400).json({ success: false, message: 'Both numberOfPacks and creditsPerPack are required.' });
      }

      if (numberOfPacks <= 0 || creditsPerPack <= 0) {
        return res.status(400).json({ success: false, message: 'Both numberOfPacks and creditsPerPack must be positive numbers.' });
      }

      try {
        const result = await generatePromotionalPacks(numberOfPacks, creditsPerPack);
        res.json({ success: true, message: 'Promotional packs generation started.', result });
      } catch (error) {
        console.error('Error in /generate-promo-packs:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
          success: false,
          message: 'Failed to generate promotional packs.',
          error: error.message,
          stack: error.stack
        });
      }
    });

    app.post('/import-promotional-pack', upload.single('packFile'), async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }

      const tempFilePath = req.file.path;

      try {
        logger.info(`Received promotional pack file: ${req.file.originalname}`);

        // Call the importPromotionalPack function
        const result = await importPromotionalPack(tempFilePath);

        // Delete the temporary file
        fs.unlinkSync(tempFilePath);

        res.json({
          success: true,
          message: 'Promotional pack imported successfully',
          details: result
        });
      } catch (error) {
        logger.error(`Error importing promotional pack: ${error.message}`);

        // Attempt to delete the temporary file in case of error
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }

        res.status(500).json({
          success: false,
          message: 'Failed to import promotional pack',
          error: error.message
        });
      }
    });

    app.get('/download-promo-pack/:filename', (req, res) => {
      const filename = req.params.filename;
      const filepath = path.join(__dirname, 'generated_promo_packs', filename);

      if (!fs.existsSync(filepath)) {
        return res.status(404).json({
          success: false,
          message: 'Promotional pack file not found'
        });
      }

      res.download(filepath, (err) => {
        if (err) {
          logger.error(`Error downloading file ${filename}: ${err.message}`);
          res.status(500).json({
            success: false,
            message: 'Error downloading file',
            error: err.message
          });
        }
      });
    });

    app.get('/promo-generator', (req, res) => {
      const filePath = path.join(__dirname, 'public', 'promo_code_generator_tool.html');

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          success: false,
          message: 'Promo generator tool not found'
        });
      }

      res.sendFile(filePath);
    });

    app.get('/list-promo-packs', (req, res) => {
      const folderPath = path.join(__dirname, 'generated_promo_packs');

      fs.readdir(folderPath, (err, files) => {
        if (err) {
          logger.error(`Error reading promo packs directory: ${err.message}`);
          return res.status(500).json({
            success: false,
            message: 'Error listing promotional packs',
            error: err.message
          });
        }

        const promoPacks = files.filter(file => file.endsWith('.json'));
        res.json({
          success: true,
          promoPacks: promoPacks
        });
      });
    });

    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Error initializing server:", error);
    process.exit(1);
  }
})();

function getNetworkSpecificDestFolder(network) {
  if (network === "mainnet") {
    return path.join(process.env.HOME, ".pastel/pastelkeys");
  } else if (network === "testnet") {
    return path.join(process.env.HOME, ".pastel/testnet/pastelkeys");
  } else if (network === "devnet") {
    return path.join(process.env.HOME, ".pastel/devnet/pastelkeys");
  } else {
    throw new Error(`Unknown network: ${network}`);
  }
}
