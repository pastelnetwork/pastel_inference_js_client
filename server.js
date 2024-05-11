const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const {
  sendMessageAndCheckForNewIncomingMessages,
  handleCreditPackTicketEndToEnd,
  getCreditPackTicketInfoEndToEnd,
  handleInferenceRequestEndToEnd,
} = require("./end_to_end_functions");
const {
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
  checkForPastelIDAndCreateIfNeeded,
} = require("./rpc_functions");
const { logger } = require("./logger");

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

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
    const messageDict = await sendMessageAndCheckForNewIncomingMessages();
    res.json({ success: true, messageDict });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/create-ticket", async (req, res) => {
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
