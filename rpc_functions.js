require("dotenv").config();
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { URL } = require("url");
const axios = require("axios");
const Joi = require("joi");
const { SupernodeList } = require("./sequelize_data_models");
const { messageSchema, supernodeListSchema } = require("./validation_schemas");
const { logger, safeStringify } = require("./logger");
let rpc_connection;

function getLocalRPCSettings(
  directoryWithPastelConf = path.join(process.env.HOME, ".pastel")
) {
  const pastelConfPath = path.join(directoryWithPastelConf, "pastel.conf");
  const lines = fs.readFileSync(pastelConfPath, "utf-8").split("\n");

  const otherFlags = {};
  let rpchost = "127.0.0.1";
  let rpcport = "19932";
  let rpcuser = "";
  let rpcpassword = "";

  for (const line of lines) {
    if (line.startsWith("rpcport")) {
      rpcport = line.split("=")[1]?.trim();
    } else if (line.startsWith("rpcuser")) {
      rpcuser = line.split("=")[1]?.trim();
    } else if (line.startsWith("rpcpassword")) {
      rpcpassword = line.split("=")[1]?.trim();
    } else if (line.startsWith("rpchost")) {
      // Skip rpchost
    } else if (line?.trim() !== "") {
      const [currentFlag, currentValue] = line?.trim().split("=");
      otherFlags[currentFlag?.trim()] = currentValue?.trim();
    }
  }

  return { rpchost, rpcport, rpcuser, rpcpassword, otherFlags };
}

class JSONRPCException extends Error {
  constructor(rpcError) {
    super(rpcError.message);
    this.error = rpcError;
    this.code = rpcError.code || null;
    this.message = rpcError.message || null;
  }
  toString() {
    return `${this.code}: ${this.message}`;
  }
}

class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.counter = maxConcurrent;
    this.waiting = [];
  }
  async acquire() {
    if (this.counter <= 0) {
      await new Promise((resolve) => this.waiting.push(resolve));
    }
    this.counter--;
  }
  release() {
    this.counter++;
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      resolve();
    }
  }
}

class AsyncAuthServiceProxy {
  static maxConcurrentRequests = 5000;
  static semaphore = new Semaphore(AsyncAuthServiceProxy.maxConcurrentRequests);

  constructor(
    serviceUrl,
    serviceName = null,
    reconnectTimeout = 15,
    reconnectAmount = 2,
    requestTimeout = 20
  ) {
    this.serviceUrl = serviceUrl;
    this.serviceName = serviceName;
    this.url = new URL(serviceUrl);
    this.client = axios.create({
      timeout: requestTimeout * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 200 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 200 }),
    });
    this.idCount = 0;
    const { username, password } = this.url;
    const authPair = `${username}:${password}`;
    this.authHeader = `Basic ${Buffer.from(authPair).toString("base64")}`;
    this.reconnectTimeout = reconnectTimeout;
    this.reconnectAmount = reconnectAmount;
    this.requestTimeout = requestTimeout;
  }

  async call(methodName, ...args) {
    await AsyncAuthServiceProxy.semaphore.acquire();
    try {
      this.idCount += 1;
      const postData = JSON.stringify({
        jsonrpc: "2.0",
        method: methodName,
        params: args,
        id: this.idCount,
      });
      const headers = {
        Host: this.url.hostname,
        "User-Agent": "AuthServiceProxy/0.1",
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      };

      let response;
      for (let i = 0; i < this.reconnectAmount; i++) {
        try {
          if (i > 0) {
            const sleepTime = this.reconnectTimeout * 2 ** i;
            logger.error(`Reconnect try #${i + 1}`);
            logger.info(`Waiting for ${sleepTime} seconds before retrying.`);
            await new Promise((resolve) =>
              setTimeout(resolve, sleepTime * 1000)
            );
          }
          response = await this.client.post(this.serviceUrl, postData, {
            headers,
          });
          break;
        } catch (error) {
          logger.error(`Error occurred on attempt ${i + 1}: ${error}`);
          if (i === this.reconnectAmount - 1) {
            logger.error("Reconnect tries exceeded.");
            throw error;
          }
        }
      }
      if (!response) {
        throw new Error("No response from server, all retry attempts failed.");
      }
      const responseJson = response.data;
      if (responseJson.error) {
        throw new JSONRPCException(responseJson.error);
      } else if (!("result" in responseJson)) {
        throw new JSONRPCException({
          code: -343,
          message: "Missing JSON-RPC result",
        });
      }
      return responseJson.result;
    } finally {
      AsyncAuthServiceProxy.semaphore.release();
    }
  }

  // Create a proxy to handle method calls dynamically
  static create(serviceUrl) {
    const handler = {
      get: function (target, propKey) {
        if (typeof target[propKey] === "function") {
          return function (...args) {
            return target[propKey](...args);
          };
        } else {
          return function (...args) {
            return target.call(propKey, ...args);
          };
        }
      },
    };
    return new Proxy(new AsyncAuthServiceProxy(serviceUrl), handler);
  }
}

async function initializeRPCConnection() {
  const { rpchost, rpcport, rpcuser, rpcpassword } =
    await getLocalRPCSettings();
  rpc_connection = AsyncAuthServiceProxy.create(
    `http://${rpcuser}:${rpcpassword}@${rpchost}:${rpcport}`
  );
}

async function waitForRPCConnection(maxRetries = 5, interval = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (rpc_connection) {
      return true; // Connection is available
    }
    logger.info(
      `Waiting for RPC connection... Attempt ${attempt}/${maxRetries}`
    );
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  logger.error("Failed to establish RPC connection after several attempts.");
  return false; // Connection is not available after retries
}

async function checkMasternodeTop() {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  const masternodeTopOutput = await rpc_connection.masternode("top");
  return masternodeTopOutput;
}

async function getCurrentPastelBlockHeight() {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  const bestBlockHash = await rpc_connection.getbestblockhash();
  const bestBlockDetails = await rpc_connection.getblock(bestBlockHash);
  const currentBlockHeight = bestBlockDetails.height;
  return currentBlockHeight;
}

async function getBestBlockHashAndMerkleRoot() {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  const bestBlockHeight = await getCurrentPastelBlockHeight();
  const bestBlockHash = await rpc_connection.getblockhash(bestBlockHeight);
  const bestBlockDetails = await rpc_connection.getblock(bestBlockHash);
  const bestBlockMerkleRoot = bestBlockDetails.merkleroot;
  return [bestBlockHash, bestBlockMerkleRoot, bestBlockHeight];
}

async function verifyMessageWithPastelID(
  pastelid,
  messageToVerify,
  pastelIDSignatureOnMessage
) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  const verificationResult = await rpc_connection.pastelid(
    "verify",
    messageToVerify,
    pastelIDSignatureOnMessage,
    pastelid,
    "ed448"
  );
  return verificationResult.verification; // Return the verification result
}

async function sendToAddress(
  address,
  amount,
  comment = "",
  commentTo = "",
  subtractFeeFromAmount = false
) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  try {
    const result = await rpc_connection.sendtoaddress(
      address,
      amount,
      comment,
      commentTo,
      subtractFeeFromAmount
    );
    return result;
  } catch (error) {
    logger.error(`Error in sendToAddress: ${safeStringify(error)}`);
    return null;
  }
}

async function sendMany(
  amounts,
  minConf = 1,
  comment = "",
  changeAddress = ""
) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  try {
    const fromAccount = "";
    const result = await rpc_connection.sendmany(
      fromAccount,
      amounts,
      minConf,
      comment,
      [""],
      changeAddress
    );
    return result;
  } catch (error) {
    logger.error(`Error in sendMany: ${safeStringify(error)}`);
    return null;
  }
}

async function checkPSLAddressBalance(addressToCheck) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  const balance = await rpc_connection.z_getbalance(addressToCheck);
  return balance;
}

async function checkIfAddressIsAlreadyImportedInLocalWallet(addressToCheck) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  const addressAmounts = await rpc_connection.listaddressamounts();
  const addressAmountsArray = Object.entries(addressAmounts).map(
    ([address, amount]) => ({ address, amount })
  );
  const filteredAddressAmounts = addressAmountsArray.filter(
    (entry) => entry.address === addressToCheck
  );
  return filteredAddressAmounts.length > 0;
}

async function getAndDecodeRawTransaction(txid, blockhash = null) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  try {
    const rawTxData = await rpc_connection.getrawtransaction(
      txid,
      0,
      blockhash
    );
    if (!rawTxData) {
      logger.error(`Failed to retrieve raw transaction data for ${txid}`);
      return {};
    }
    const decodedTxData = await rpc_connection.decoderawtransaction(rawTxData);
    if (!decodedTxData) {
      logger.error(`Failed to decode raw transaction data for ${txid}`);
      return {};
    }
    logger.debug(
      `Decoded transaction details for ${txid}:`,
      safeStringify(decodedTxData)
    );
    return decodedTxData;
  } catch (error) {
    logger.error(
      `Error in getAndDecodeRawTransaction for ${txid}:`,
      safeStringify(error)
    );
    return {};
  }
}

async function getTransactionDetails(txid, includeWatchonly = false) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  try {
    const transactionDetails = await rpc_connection.gettransaction(
      txid,
      includeWatchonly
    );
    logger.debug(
      `Retrieved transaction details for ${txid}:`,
      safeStringify(transactionDetails)
    );
    return transactionDetails;
  } catch (error) {
    logger.error(
      `Error retrieving transaction details for ${txid}:`,
      safeStringify(error)
    );
    return {};
  }
}

async function sendTrackingAmountFromControlAddressToBurnAddressToConfirmInferenceRequest(
  inferenceRequestId,
  creditUsageTrackingPSLAddress,
  creditUsageTrackingAmountInPSL,
  burnAddress
) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return; // Stop the function if the connection is not available
    }
    const amounts = {
      [burnAddress]: creditUsageTrackingAmountInPSL,
    };
    const txid = await sendMany(
      amounts,
      0,
      "Confirmation tracking transaction for inference request with request_id " +
        inferenceRequestId,
      creditUsageTrackingPSLAddress
    );
    if (txid) {
      logger.info(
        `Sent ${creditUsageTrackingAmountInPSL} PSL from ${creditUsageTrackingPSLAddress} to ${burnAddress} to confirm inference request ${inferenceRequestId}. TXID: ${txid}`
      );
      const transactionInfo = await rpc_connection.gettransaction(txid);
      if (transactionInfo) {
        return txid;
      } else {
        logger.error(
          `No transaction info found for TXID: ${txid} to confirm inference request ${inferenceRequestId}`
        );
      }
      return null;
    } else {
      logger.error(
        `Failed to send ${creditUsageTrackingAmountInPSL} PSL from ${creditUsageTrackingPSLAddress} to ${burnAddress} to confirm inference request ${inferenceRequestId}`
      );
      return null;
    }
  } catch (error) {
    logger.error(
      "Error in sendTrackingAmountFromControlAddressToBurnAddressToConfirmInferenceRequest:",
      error
    );
    throw error;
  }
}

async function importAddress(address, label = "", rescan = false) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return; // Stop the function if the connection is not available
    }
    await rpc_connection.importaddress(address, label, rescan);
    logger.info(`Imported address: ${address}`);
  } catch (error) {
    logger.error(
      `Error importing address: ${address}. Error:`,
      safeStringify(error)
    );
  }
}

async function getBlockHash(blockHeight) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return; // Stop the function if the connection is not available
    }
    const blockHash = await rpc_connection.getblockhash(blockHeight);
    return blockHash;
  } catch (error) {
    logger.error(
      `Error in getBlockHash for block height ${blockHeight}:`,
      error
    );
    return null;
  }
}

async function getBlock(blockHash) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return; // Stop the function if the connection is not available
    }
    const block = await rpc_connection.getblock(blockHash);
    return block;
  } catch (error) {
    logger.error(
      `Error in getBlock for block hash ${blockHash}:`,
      safeStringify(error)
    );
    return null;
  }
}

async function signMessageWithPastelID(pastelid, messageToSign, passphrase) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return; // Stop the function if the connection is not available
    }
    const responseObj = await rpc_connection.pastelid(
      "sign",
      messageToSign,
      pastelid,
      '"' + passphrase + '"',
      "ed448"
    );
    return responseObj.signature;
  } catch (error) {
    logger.error(`Error in signMessageWithPastelID: ${safeStringify(error)}`);
    return null;
  }
}

async function checkPSLAddressBalanceAlternative(addressToCheck) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return; // Stop the function if the connection is not available
    }
    const addressAmountsDict = await rpc_connection.listaddressamounts();
    // Convert the object into an array of objects, each representing a row
    const data = Object.entries(addressAmountsDict).map(
      ([address, amount]) => ({ address, amount })
    );
    // Filter the array for the specified address
    const filteredData = data.filter((item) => item.address === addressToCheck);
    // Calculate the sum of the 'amount' column for the filtered array
    const balanceAtAddress = filteredData.reduce(
      (acc, item) => acc + item.amount,
      0
    );
    return balanceAtAddress;
  } catch (error) {
    logger.error(
      `Error in checkPSLAddressBalanceAlternative: ${safeStringify(error)}`
    );
    throw error;
  }
}

function formatNumberWithCommas(number) {
  return new Intl.NumberFormat("en-US").format(number);
}

async function createAndFundNewPSLCreditTrackingAddress(
  amountOfPSLToFundAddressWith
) {
  const isConnectionReady = await waitForRPCConnection();
  if (!isConnectionReady) {
    logger.error("RPC connection is not available. Cannot proceed.");
    return; // Stop the function if the connection is not available
  }
  try {
    const newCreditTrackingAddress = await rpc_connection.getnewaddress();
    const txid = await sendToAddress(
      newCreditTrackingAddress,
      amountOfPSLToFundAddressWith,
      "Funding new credit tracking address",
      "",
      false
    );
    logger.info(
      `Funded new credit tracking address ${newCreditTrackingAddress} with ${formatNumberWithCommas(
        amountOfPSLToFundAddressWith
      )} PSL. TXID: ${txid}`
    );
    return { newCreditTrackingAddress, txid };
  } catch (error) {
    logger.error(
      `Error creating and funding new PSL credit tracking address: ${safeStringify(
        error
      )}`
    );
    throw error;
  }
}

async function waitForTableCreation() {
  const maxRetries = 5;
  const retryDelay = 1000; // 1 second
  for (let i = 0; i < maxRetries; i++) {
    try {
      await SupernodeList.findOne();
      return; // Table exists, proceed with data insertion
    } catch (error) {
      if (
        error.name === "SequelizeDatabaseError" &&
        error.original.code === "SQLITE_ERROR" &&
        error.original.errno === 1
      ) {
        // Table doesn't exist, wait and retry
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        throw error; // Rethrow other errors
      }
    }
  }
  throw new Error("Table creation timed out.");
}

async function checkSupernodeList() {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const [
      masternodeListFull,
      masternodeListRank,
      masternodeListPubkey,
      masternodeListExtra,
    ] = await Promise.all([
      rpc_connection.masternodelist("full"),
      rpc_connection.masternodelist("rank"),
      rpc_connection.masternodelist("pubkey"),
      rpc_connection.masternodelist("extra"),
    ]);
    const masternodeListFullData = Object.entries(masternodeListFull).map(
      ([txidVout, data]) => {
        const splitData = data?.trim()?.split(/\s+/);
        return {
          txid_vout: txidVout,
          supernode_status: splitData[0],
          protocol_version: Number(splitData[1]),
          supernode_psl_address: splitData[2],
          lastseentime: Number(splitData[3]),
          activeseconds: Number(splitData[4]),
          lastpaidtime: Number(splitData[5]),
          lastpaidblock: Number(splitData[6]),
          ipaddress_port: splitData[7],
        };
      }
    );
    const masternodeListFullDF = masternodeListFullData.map((data) => {
      const rank = masternodeListRank[data.txid_vout];
      const pubkey = masternodeListPubkey[data.txid_vout];
      const extra = masternodeListExtra[data.txid_vout];
      return {
        ...data,
        rank: Number(rank),
        pubkey,
        extAddress: extra && extra.extAddress,
        extP2P: extra && extra.extP2P,
        extKey: extra && extra.extKey,
        activedays: data.activeseconds / 86400,
      };
    });
    const validMasternodeListFullDF = masternodeListFullDF.filter(
      (data) =>
        ["ENABLED", "PRE_ENABLED"].includes(data.supernode_status) &&
        data["ipaddress_port"] !== "154.38.164.75:29933" &&
        data.extP2P
    );
    if (validMasternodeListFullDF.length === 0) {
      logger.error("No valid masternodes found.");
      return;
    }
    const validationSchema = Joi.array().items(supernodeListSchema);
    const validation = validationSchema.validate(validMasternodeListFullDF);
    if (validation.error) {
      throw new Error(`Validation error: ${validation.error.message}`);
    }
    // Wait for the table to be created before inserting data
    await waitForTableCreation();

    try {
      const _ = await SupernodeList.bulkCreate(validMasternodeListFullDF, {
        updateOnDuplicate: [
          "supernode_status",
          "protocol_version",
          "supernode_psl_address",
          "lastseentime",
          "activeseconds",
          "lastpaidtime",
          "lastpaidblock",
          "ipaddress_port",
          "rank",
          "pubkey",
          "extAddress",
          "extP2P",
          "extKey",
        ],
      });
    } catch (error) {
      logger.error("Failed to insert data:", error);
    }
    const masternodeListFullDFJSON = JSON.stringify(
      Object.fromEntries(
        validMasternodeListFullDF.map((data) => [data.txid_vout, data])
      )
    );
    return { validMasternodeListFullDF, masternodeListFullDFJSON };
  } catch (error) {
    logger.error(`An error occurred: ${error.message}`);
  }
}

async function registerPastelID(pastelid, passphrase, address) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.tickets(
      "register",
      "id",
      pastelid,
      passphrase,
      address
    );
    logger.info(`Registered PastelID: ${pastelid}. TXID: ${result}`);
    return result;
  } catch (error) {
    logger.error(
      `Error registering PastelID: ${pastelid}. Error:`,
      safeStringify(error)
    );
    throw error;
  }
}

async function listPastelIDTickets(filter = "mine", minheight = null) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const params = [filter];
    if (minheight !== null) {
      params.push(minheight);
    }
    const result = await rpc_connection.tickets("list", "id", ...params);
    logger.info(`Pastel ID Tickets: ${result}`);
    logger.info(`Listed PastelID tickets with filter: ${filter}`);
    return result;
  } catch (error) {
    logger.error(
      `Error listing PastelID tickets with filter: ${filter}. Error:`,
      safeStringify(error)
    );
    throw error;
  }
}

async function findPastelIDTicket(key) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.tickets("find", "id", key);
    logger.info(`Found PastelID ticket with key: ${key}`);
    return result;
  } catch (error) {
    logger.error(
      `Error finding PastelID ticket with key: ${key}. Error:`,
      safeStringify(error)
    );
    throw error;
  }
}

async function getPastelTicket(txid, decodeProperties = false) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.tickets("get", txid, decodeProperties);
    logger.info(`Got Pastel ticket with TXID: ${txid}`);
    return result;
  } catch (error) {
    logger.error(
      `Error getting Pastel ticket with TXID: ${txid}. Error:`,
      safeStringify(error)
    );
    throw error;
  }
}

async function listContractTickets(
  ticketTypeIdentifier,
  startingBlockHeight = 0
) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.tickets(
      "list",
      "contract",
      ticketTypeIdentifier,
      startingBlockHeight
    );
    logger.info(
      `Listed contract tickets of type ${ticketTypeIdentifier} starting from block height ${startingBlockHeight}`
    );
    return result;
  } catch (error) {
    logger.error(
      `Error listing contract tickets of type ${ticketTypeIdentifier}. Error:`,
      safeStringify(error)
    );
    throw error;
  }
}

async function findContractTicket(key) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.tickets("find", "contract", key);
    logger.info(`Found contract ticket with key: ${key}`);
    return result;
  } catch (error) {
    logger.error(
      `Error finding contract ticket with key: ${key}. Error:`,
      safeStringify(error)
    );
    throw error;
  }
}

async function getContractTicket(txid, decodeProperties = true) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.tickets("get", txid, decodeProperties);
    if (result && result.ticket && result.ticket.contract_ticket) {
      logger.info(`Got contract ticket with TXID: ${txid}`);
      return result.ticket.contract_ticket;
    } else {
      logger.error(`Error getting contract ticket with TXID: ${txid}`);
      return null;
    }
  } catch (error) {
    logger.error(
      `Error getting contract ticket with TXID: ${txid}. Error:`,
      safeStringify(error)
    );
    throw error;
  }
}

async function importPrivKey(zcashPrivKey, label = "", rescan = true) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.importprivkey(
      zcashPrivKey,
      label,
      rescan
    );
    logger.info(`Imported private key with label: ${label}`);
    return result;
  } catch (error) {
    logger.error(`Error importing private key: ${safeStringify(error)}`);
    throw error;
  }
}

async function importWallet(filename) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.importwallet(filename);
    logger.info(`Imported wallet from file: ${filename}`);
    return result;
  } catch (error) {
    logger.error(`Error importing wallet: ${safeStringify(error)}`);
    throw error;
  }
}

async function listAddressAmounts(includeEmpty = false, isMineFilter = "all") {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.listaddressamounts(
      includeEmpty,
      isMineFilter
    );
    logger.info(
      `Listed address amounts with includeEmpty: ${includeEmpty} and isMineFilter: ${isMineFilter}`
    );
    return result;
  } catch (error) {
    logger.error(`Error listing address amounts: ${safeStringify(error)}`);
    throw error;
  }
}

async function getBalance(
  account = "*",
  minConf = 1,
  includeWatchOnly = false
) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.getbalance(
      account,
      minConf,
      includeWatchOnly
    );
    logger.info(`Got balance for account: ${account}`);
    return result;
  } catch (error) {
    logger.error(`Error getting balance: ${safeStringify(error)}`);
    throw error;
  }
}

async function getWalletInfo() {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.getwalletinfo();
    logger.info("Got wallet info");
    return result;
  } catch (error) {
    logger.error(`Error getting wallet info: ${safeStringify(error)}`);
    throw error;
  }
}

async function getNewAddress() {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return;
    }
    const result = await rpc_connection.getnewaddress();
    logger.info("Got new Pastel address");
    return result;
  } catch (error) {
    logger.error(`Error getting new address: ${safeStringify(error)}`);
    throw error;
  }
}

async function checkForPastelIDAndCreateIfNeeded(autoRegister = false) {
  try {
    const { rpchost, rpcport, rpcuser, rpcpassword } = getLocalRPCSettings();
    logger.info(
      `RPC settings: host=${rpchost}, port=${rpcport}, user=${rpcuser}, password=${rpcpassword}`
    );
    const { network, burnAddress } = getNetworkInfo(rpcport);
    logger.info(`Network: ${network}, Burn Address: ${burnAddress}`);
    const pastelIDDir = getPastelIDDirectory(network);
    logger.info(`Pastel ID directory: ${pastelIDDir}`);
    const pastelIDs = await getPastelIDsFromDirectory(pastelIDDir);
    logger.info(`Found Pastel IDs: ${pastelIDs}`);
    for (const pastelID of pastelIDs) {
      const isRegistered = await isPastelIDRegistered(pastelID);
      logger.info(`Pastel ID ${pastelID} is registered: ${isRegistered}`);
      if (isRegistered) {
        logger.info(`Found registered Pastel ID: ${pastelID}`);
        return pastelID;
      }
    }
    logger.info("No registered Pastel ID found. Checking wallet balance...");
    const balance = await getBalance();
    const registrationFee = 1000;
    const transactionFee = 1;
    const requiredBalance = registrationFee + transactionFee;
    if (balance < requiredBalance) {
      logger.error(
        `Insufficient balance to register a new Pastel ID. Required: ${requiredBalance} PSL, Available: ${balance} PSL`
      );
      logger.info(
        "Please acquire PSL through the faucet or purchase it on an exchange."
      );
      return null;
    }
    if (!autoRegister) {
      const confirmRegistration = await promptUserConfirmation(
        "Do you want to proceed with registering a new Pastel ID? (yes/no)"
      );
      if (confirmRegistration.toLowerCase() !== "yes") {
        logger.info("User declined to register a new Pastel ID.");
        return null;
      }
    }
    logger.info("Registering a new Pastel ID...");
    const newPastelID = await createAndRegisterPastelID(burnAddress);
    logger.info(`New Pastel ID registered successfully: ${newPastelID}`);
    return newPastelID;
  } catch (error) {
    logger.error(
      `Error in checkForPastelIDAndCreateIfNeeded: ${safeStringify(error)}`
    );
    throw error;
  }
}

function getLocalRPCSettings(
  directoryWithPastelConf = path.join(process.env.HOME, ".pastel")
) {
  const pastelConfPath = path.join(directoryWithPastelConf, "pastel.conf");
  const lines = fs.readFileSync(pastelConfPath, "utf-8").split("\n");
  const otherFlags = {};
  let rpchost = "127.0.0.1";
  let rpcport = "19932";
  let rpcuser = "";
  let rpcpassword = "";
  for (const line of lines) {
    if (line.startsWith("rpcport")) {
      rpcport = line.split("=")[1]?.trim();
    } else if (line.startsWith("rpcuser")) {
      rpcuser = line.split("=")[1]?.trim();
    } else if (line.startsWith("rpcpassword")) {
      rpcpassword = line.split("=")[1]?.trim();
    } else if (line.startsWith("rpchost")) {
      // Skip rpchost
    } else if (line?.trim() !== "") {
      const [currentFlag, currentValue] = line?.trim().split("=");
      otherFlags[currentFlag?.trim()] = currentValue?.trim();
    }
  }
  return { rpchost, rpcport, rpcuser, rpcpassword, otherFlags };
}

function getNetworkInfo(rpcport) {
  let network = "";
  let burnAddress = "";
  if (rpcport === "9932") {
    network = "mainnet";
    burnAddress = "PtpasteLBurnAddressXXXXXXXXXXbJ5ndd";
  } else if (rpcport === "19932") {
    network = "testnet";
    burnAddress = "tPpasteLBurnAddressXXXXXXXXXXX3wy7u";
  } else if (rpcport === "29932") {
    network = "devnet";
    burnAddress = "44oUgmZSL997veFEQDq569wv5tsT6KXf9QY7";
  } else {
    throw new Error(`Unknown RPC port: ${rpcport}`);
  }
  return { network, burnAddress };
}

function getPastelIDDirectory(network) {
  const homeDir = process.env.HOME;
  let pastelIDDir = "";
  if (network === "mainnet") {
    pastelIDDir = path.join(homeDir, ".pastel", "pastelkeys");
  } else if (network === "testnet") {
    pastelIDDir = path.join(homeDir, ".pastel", "testnet3", "pastelkeys");
  } else if (network === "devnet") {
    pastelIDDir = path.join(homeDir, ".pastel", "devnet3", "pastelkeys");
  }
  return pastelIDDir;
}

async function getPastelIDsFromDirectory(directory) {
  const files = await fs.promises.readdir(directory);
  const pastelIDs = files.filter((file) => file.length === 87);
  return pastelIDs;
}

async function isPastelIDRegistered(pastelID) {
  try {
    const ticketFindResult = await rpc_connection.tickets(
      "find",
      "id",
      pastelID
    );
    return ticketFindResult.length > 0;
  } catch (error) {
    logger.error(
      `Error checking if Pastel ID is registered: ${safeStringify(error)}`
    );
    return false;
  }
}

async function promptUserConfirmation(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message + " ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function createAndRegisterPastelID(burnAddress) {
  try {
    const newPastelIDResult = await rpc_connection.pastelid("newkey");
    const newPastelID = newPastelIDResult.pastelid;
    const passphrase = newPastelIDResult.passphrase;
    const address = await rpc_connection.getnewaddress();
    const registrationResult = await registerPastelID(
      newPastelID,
      passphrase,
      address
    );
    if (registrationResult) {
      return newPastelID;
    } else {
      throw new Error("Failed to register new Pastel ID");
    }
  } catch (error) {
    logger.error(
      `Error creating and registering Pastel ID: ${safeStringify(error)}`
    );
    throw error;
  }
}

async function createAndRegisterNewPastelID(passphraseForNewPastelID) {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      logger.error("RPC connection is not available. Cannot proceed.");
      return { success: false, message: "RPC connection is not available." };
    }
    let addressAmounts = await rpc_connection.listaddressamounts();
    const registrationFee = 1000;
    const transactionFee = 0.1;
    const requiredBalance = registrationFee + transactionFee;
    let fundingAddress = Object.keys(addressAmounts).find(
      (addr) => addressAmounts[addr] >= requiredBalance
    );
    if (!fundingAddress) {
      const newAddress = await getNewAddress();
      return {
        success: false,
        message: `Error: You do not have enough PSL in your wallet in a single address to register a new PastelID. Get some PSL (either from mining, buying on an exchange, a faucet, etc.) and then send at least 1,001 PSL of it to the following new PSL address which has been created for you: ${newAddress}`,
      };
    }
    const newPastelIDResult = await rpc_connection.pastelid(
      "newkey",
      '"' + passphraseForNewPastelID + '"'
    );
    const newPastelID = newPastelIDResult.pastelid;
    addressAmounts = await rpc_connection.listaddressamounts();
    fundingAddress = Object.keys(addressAmounts).find(
      (addr) => addressAmounts[addr] >= registrationFee
    );
    if (!fundingAddress) {
      return {
        success: false,
        message:
          "Error: No address found with enough PSL to register a new PastelID.",
      };
    }
    const registerResult = await rpc_connection.tickets(
      "register",
      "id",
      newPastelID,
      '"' + passphraseForNewPastelID + '"',
      fundingAddress
    );
    return {
      success: true,
      PastelID: newPastelID,
      PastelIDRegistrationTXID: registerResult.txid,
    };
  } catch (error) {
    logger.error(
      `Error in createAndRegisterNewPastelID: ${safeStringify(error)}`
    );
    return { success: false, message: error.message };
  }
}

module.exports = {
  safeStringify,
  getLocalRPCSettings,
  JSONRPCException,
  AsyncAuthServiceProxy,
  initializeRPCConnection,
  waitForRPCConnection,
  checkMasternodeTop,
  getCurrentPastelBlockHeight,
  getBestBlockHashAndMerkleRoot,
  verifyMessageWithPastelID,
  sendToAddress,
  sendMany,
  checkPSLAddressBalance,
  checkIfAddressIsAlreadyImportedInLocalWallet,
  getAndDecodeRawTransaction,
  getTransactionDetails,
  sendTrackingAmountFromControlAddressToBurnAddressToConfirmInferenceRequest,
  importAddress,
  getBlockHash,
  getBlock,
  signMessageWithPastelID,
  checkPSLAddressBalanceAlternative,
  createAndFundNewPSLCreditTrackingAddress,
  checkSupernodeList,
  checkForPastelIDAndCreateIfNeeded,
  getLocalRPCSettings,
  getNetworkInfo,
  getPastelIDDirectory,
  getPastelIDsFromDirectory,
  isPastelIDRegistered,
  promptUserConfirmation,
  createAndRegisterPastelID,
  createAndRegisterNewPastelID,
  getBalance,
  getWalletInfo,
  getNewAddress,
  listAddressAmounts,
  getPastelTicket,
  listPastelIDTickets,
  findPastelIDTicket,
  getPastelTicket,
  listContractTickets,
  findContractTicket,
  getContractTicket,
  importPrivKey,
  importWallet,
  registerPastelID,
  rpc_connection,
};
