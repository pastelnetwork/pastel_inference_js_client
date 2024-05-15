const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const os = require("os");
const path = require("path");
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
  checkForPastelIDAndCreateIfNeeded,
} = require("./rpc_functions");
const { logger, logEmitter, logBuffer, safeStringify } = require("./logger");
const {
  prettyJSON,
  getClosestSupernodeToPastelIDURL,
  getNClosestSupernodesToPastelIDURLs,
} = require("./utility_functions");
if (!process.env.MY_LOCAL_PASTELID || !process.env.MY_PASTELID_PASSPHRASE) {
  console.error("Required environment variables are not set.");
  process.exit(1); // Exit if essential environment variables are not available
}
const MY_LOCAL_PASTELID = process.env.MY_LOCAL_PASTELID;
const MY_PASTELID_PASSPHRASE = process.env.MY_PASTELID_PASSPHRASE;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

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

  // Send the buffered log entries to the newly connected client
  logBuffer.forEach((logEntry) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(logEntry);
    }
  });

  // Stream new log entries to the client
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
    logger.error(`WebSocket error: ${error.message}`);
    logEmitter.removeListener("newLog", logListener);
  });
});

(async () => {
  try {
    await initializeRPCConnection();
    const { rpcport } = await getLocalRPCSettings();
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const { url: supernodeURL } = await getClosestSupernodeToPastelIDURL(
      MY_LOCAL_PASTELID,
      validMasternodeListFullDF
    );
    if (!supernodeURL) {
      throw new Error("Supernode URL is undefined");
    }

    async function configureRPCAndSetBurnAddress() {
      try {
        // Get the local RPC settings
        const { rpcport } = await getLocalRPCSettings();
        // Initialize the RPC connection
        await initializeRPCConnection();
        // Initialize variable for the burn address
        let burnAddress;
        // Determine the burn address based on the RPC port
        if (rpcport === "9932") {
          burnAddress = "PtpasteLBurnAddressXXXXXXXXXXbJ5ndd";
        } else if (rpcport === "19932") {
          burnAddress = "tPpasteLBurnAddressXXXXXXXXXXX3wy7u";
        } else if (rpcport === "29932") {
          burnAddress = "44oUgmZSL997veFEQDq569wv5tsT6KXf9QY7";
        } else {
          // Handle cases where the port does not match expected values
          throw new Error(`Unsupported RPC port: ${rpcport}`);
        }
        return burnAddress; // Return the burn address
      } catch (error) {
        console.error("Failed to configure RPC or set burn address:", error);
        throw error; // Re-throw the error if you need to handle it further up the chain
      }
    }

    app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "index.html"));
    });

    app.get("/favicon.ico", (req, res) => {
      res.sendFile(path.join(__dirname, "favicon.ico"));
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
        const pastelInferenceClient = new PastelInferenceClient(
          MY_LOCAL_PASTELID,
          MY_PASTELID_PASSPHRASE
        );
        const modelMenu = await pastelInferenceClient.getModelMenu(
          supernodeURL
        );
        res.json({ success: true, modelMenu });
      } catch (error) {
        logger.error(`Error in getInferenceModelMenu: ${safeStringify(error)}`);
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
        res.status(500).json({ success: false, error: error.message });
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
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/create-inference-request", async (req, res) => {
      const {
        selectedCreditPackTicketId,
        selectedInferenceType,
        selectedModel,
        prompt,
        maxTokens,
        numCompletions,
        maxCost,
      } = req.body;
      try {
        const burnAddress = await configureRPCAndSetBurnAddress();
        const result = await handleInferenceRequestEndToEnd(
          selectedCreditPackTicketId,
          prompt,
          selectedModel,
          selectedInferenceType,
          { max_tokens: maxTokens, num_completions: numCompletions },
          maxCost,
          burnAddress
        );
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/check-supernode-list", async (req, res) => {
      try {
        const result = await checkSupernodeList();
        res.json({ success: true, result });
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
        console.log("Pastel ID Tickets:", result); // Add this line
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
      const { account, minConf, includeWatchOnly } = req.query;
      try {
        const result = await getBalance(account, minConf, includeWatchOnly);
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
        const result = await checkForPastelIDAndCreateIfNeeded(autoRegister);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Error initializing server:", error);
    process.exit(1);
  }
})();
