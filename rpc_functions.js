require("dotenv").config();
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const axios = require("axios");
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
      rpcport = line.split("=")[1].trim();
    } else if (line.startsWith("rpcuser")) {
      rpcuser = line.split("=")[1].trim();
    } else if (line.startsWith("rpcpassword")) {
      rpcpassword = line.split("=")[1].trim();
    } else if (line.startsWith("rpchost")) {
      // Skip rpchost
    } else if (line.trim() !== "") {
      const [currentFlag, currentValue] = line.trim().split("=");
      otherFlags[currentFlag.trim()] = currentValue.trim();
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
  [Symbol.toPrimitive](hint) {
    if (hint === "string") {
      return `JSONRPCException '${this}'`;
    }
    return null;
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
    this.authHeader = `Basic ${Buffer.from(authPair, "utf-8").toString(
      "base64"
    )}`;
    this.reconnectTimeout = reconnectTimeout;
    this.reconnectAmount = reconnectAmount;
    this.requestTimeout = requestTimeout;
  }

  async call(methodName, ...params) {
    await AsyncAuthServiceProxy.semaphore.acquire();
    try {
      this.idCount += 1;
      const postData = safeStringify({
        version: "1.1",
        method: methodName,
        params: params,
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
            logger.warn(`Reconnect try #${i + 1}`);
            logger.info(`Waiting for ${sleepTime} seconds before retrying.`);
            await new Promise((resolve) =>
              setTimeout(resolve, sleepTime * 1000)
            );
          }
          response = await this.client.post(this.serviceUrl, postData, {
            headers,
          });
          if (response && response.data && response.data.error === null) {
            break; // Exit loop if response is successful
          } else if (response && response.data && response.data.error) {
            throw new JSONRPCException(response.data.error); // Throw if JSON-RPC error
          }
        } catch (error) {
          logger.error(
            `Error occurred on attempt ${i + 1}: ${safeStringify(error)}`
          );
          if (i === this.reconnectAmount - 1) {
            logger.error("Reconnect tries exceeded.");
            throw error; // Rethrow error on last attempt
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
  new(serviceName) {
    return new AsyncAuthServiceProxy(this.serviceUrl, serviceName);
  }
}

const new_AsyncAuthServiceProxy = (
  serviceUrl,
  serviceName,
  reconnectTimeout,
  reconnectAmount,
  requestTimeout
) => {
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === "then") {
          if (serviceName.indexOf("undefined") !== -1) {
            return undefined;
          }
          return (onFulfilled, onRejected) => {
            const promise = asyncAuthServiceProxy.call(serviceName);
            return promise.then(onFulfilled, onRejected);
          };
        }
        if (prop === "catch") {
          if (serviceName.indexOf("undefined") !== -1) {
            return undefined;
          }
          return (onRejected) => {
            const promise = asyncAuthServiceProxy.call(serviceName);
            return promise.catch(onRejected);
          };
        }
        if (serviceName !== null) {
          serviceName = `${serviceName}.${prop}`;
        } else {
          serviceName = prop;
        }
        return new_AsyncAuthServiceProxy(
          serviceUrl,
          serviceName,
          reconnectTimeout,
          reconnectAmount,
          requestTimeout
        );
      },
    }
  );
};

const asyncAuthServiceProxy = (
  serviceUrl,
  serviceName = null,
  reconnectTimeout = 15,
  reconnectAmount = 2,
  requestTimeout = 20
) => {
  return new AsyncAuthServiceProxy(
    serviceUrl,
    serviceName,
    reconnectTimeout,
    reconnectAmount,
    requestTimeout
  );
};

async function initializeRPCConnection() {
  const { rpchost, rpcport, rpcuser, rpcpassword } =
    await getLocalRPCSettings();
  rpc_connection = new AsyncAuthServiceProxy(
    `http://${rpcuser}:${rpcpassword}@${rpchost}:${rpcport}`,
    "PastelRPC"
  );
}

async function waitForRPCConnection(maxRetries = 5, interval = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (rpc_connection) {
      console.log("RPC connection is now available.");
      return true; // Connection is available
    }
    console.log(
      `Waiting for RPC connection... Attempt ${attempt}/${maxRetries}`
    );
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  console.error("Failed to establish RPC connection after several attempts.");
  return false; // Connection is not available after retries
}

async function checkMasternodeTop() {
  const masternodeTopOutput = await rpc_connection.call("masternode", "top");
  return masternodeTopOutput;
}

async function getCurrentPastelBlockHeight() {
  const bestBlockHash = await rpc_connection.call("getbestblockhash");
  const bestBlockDetails = await rpc_connection.call("getblock", bestBlockHash);
  const currentBlockHeight = bestBlockDetails.height;
  return currentBlockHeight;
}

async function getBestBlockHashAndMerkleRoot() {
  const bestBlockHeight = await getCurrentPastelBlockHeight();
  const bestBlockHash = await rpc_connection.call(
    "getblockhash",
    bestBlockHeight
  );
  const bestBlockDetails = await rpc_connection.call("getblock", bestBlockHash);
  const bestBlockMerkleRoot = bestBlockDetails.merkleroot;
  return [bestBlockHash, bestBlockMerkleRoot, bestBlockHeight];
}

async function verifyMessageWithPastelID(
  pastelid,
  messageToVerify,
  pastelIDSignatureOnMessage
) {
  const { error } = messageSchema.validate({
    pastelid,
    messageToVerify,
    pastelIDSignatureOnMessage,
  });
  if (error) {
    logger.error(
      `Invalid data for verifyMessageWithPastelID: ${error.message}`
    );
    throw new Error(
      `Invalid data for verifyMessageWithPastelID: ${error.message}`
    );
  }
  const verificationResult = await rpc_connection.call(
    "pastelid",
    "verify",
    messageToVerify,
    pastelIDSignatureOnMessage,
    pastelid,
    "ed448"
  );
  return verificationResult.verification;
}

async function sendToAddress(
  address,
  amount,
  comment = "",
  commentTo = "",
  subtractFeeFromAmount = false
) {
  try {
    const result = await rpc_connection.call(
      "sendtoaddress",
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
  try {
    const fromAccount = "";
    const result = await rpc_connection.call(
      "sendmany",
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
  const balance = await rpc_connection.call("z_getbalance", addressToCheck);
  return balance;
}

async function checkIfAddressIsAlreadyImportedInLocalWallet(addressToCheck) {
  const addressAmounts = await rpc_connection.call("listaddressamounts");
  const addressAmountsArray = Object.entries(addressAmounts).map(
    ([address, amount]) => ({ address, amount })
  );
  const filteredAddressAmounts = addressAmountsArray.filter(
    (entry) => entry.address === addressToCheck
  );
  return filteredAddressAmounts.length > 0;
}

async function getAndDecodeRawTransaction(txid, blockhash = null) {
  try {
    const rawTxData = await rpc_connection.call(
      "getrawtransaction",
      txid,
      0,
      blockhash
    );
    if (!rawTxData) {
      logger.error(`Failed to retrieve raw transaction data for ${txid}`);
      return {};
    }

    const decodedTxData = await rpc_connection.call(
      "decoderawtransaction",
      rawTxData
    );
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
  try {
    const transactionDetails = await rpc_connection.call(
      "gettransaction",
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
      const transactionInfo = await rpc_connection.call("gettransaction", txid);
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
    await rpc_connection.call("importaddress", address, label, rescan);
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
    const blockHash = await rpc_connection.call("getblockhash", blockHeight);
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
    const block = await rpc_connection.call("getblock", blockHash);
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
    const signature = await rpc_connection.call(
      "pastelid",
      "sign",
      messageToSign,
      pastelid,
      passphrase,
      "ed448"
    );
    return signature;
  } catch (error) {
    logger.error(`Error in signMessageWithPastelID: ${safeStringify(error)}`);
    return null;
  }
}

async function createAndFundNewPSLCreditTrackingAddress(
  amountOfPSLToFundAddressWith
) {
  try {
    const newCreditTrackingAddress = await rpc_connection.call("getnewaddress");
    const txid = await sendToAddress(
      newCreditTrackingAddress,
      amountOfPSLToFundAddressWith,
      "Funding new credit tracking address",
      "",
      false
    );
    logger.info(
      `Funded new credit tracking address ${newCreditTrackingAddress} with ${amountOfPSLToFundAddressWith} PSL. TXID: ${txid}`
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

async function checkSupernodeList() {
  try {
    const isConnectionReady = await waitForRPCConnection();
    if (!isConnectionReady) {
      console.error("RPC connection is not available. Cannot proceed.");
      return; // Stop the function if the connection is not available
    }
    const [
      masternodeListFull,
      masternodeListRank,
      masternodeListPubkey,
      masternodeListExtra,
    ] = await Promise.all([
      rpc_connection.call("masternodelist", "full"),
      rpc_connection.call("masternodelist", "rank"),
      rpc_connection.call("masternodelist", "pubkey"),
      rpc_connection.call("masternodelist", "extra"),
    ]);
    const masternodeListFullData = Object.entries(masternodeListFull).map(
      ([txidVout, data]) => {
        const [
          supernodeStatus,
          protocolVersion,
          supernodePslAddress,
          lastSeenTime,
          activeSeconds,
          lastPaidTime,
          lastPaidBlock,
          ipAddressPort,
        ] = data.split(" ");
        return {
          supernode_status: supernodeStatus,
          protocol_version: Number(protocolVersion),
          supernode_psl_address: supernodePslAddress,
          lastseentime: Number(lastSeenTime),
          activeseconds: Number(activeSeconds),
          lastpaidtime: Number(lastPaidTime),
          lastpaidblock: Number(lastPaidBlock),
          "ipaddress:port": ipAddressPort,
          txid_vout: txidVout,
        };
      }
    );
    const masternodeListFullDF = masternodeListFullData.map((data) => {
      const { txid_vout, ...rest } = data;
      const rank = masternodeListRank[txid_vout];
      const pubkey = masternodeListPubkey[txid_vout];
      const extra = masternodeListExtra[txid_vout];
      return {
        ...rest,
        rank: Number(rank),
        pubkey,
        extAddress: extra.extAddress,
        extP2P: extra.extP2P,
        extKey: extra.extKey,
        activedays: Number(rest.activeseconds) / 86400,
      };
    });
    const validMasternodeListFullDF = masternodeListFullDF.filter(
      (data) =>
        ["ENABLED", "PRE_ENABLED"].includes(data.supernode_status) &&
        data["ipaddress:port"] !== "154.38.164.75:29933"
    );
    const { error } = supernodeListSchema.validate(
      validMasternodeListFullDF[0]
    );
    if (error) {
      throw new Error(`Invalid supernode list data: ${error.message}`);
    }
    const masternodeListFullDFJSON = safeStringify(
      Object.fromEntries(
        validMasternodeListFullDF.map((data) => [data.txid_vout, data])
      )
    );

    await SupernodeList.bulkCreate(validMasternodeListFullDF, {
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

    return {
      supernodeListDF: validMasternodeListFullDF,
      supernodeListJSON: masternodeListFullDFJSON,
    };
  } catch (error) {
    logger.error(`Error in checkSupernodeList: ${error.message}`);
    throw error;
  }
}

module.exports = {
  safeStringify,
  getLocalRPCSettings,
  JSONRPCException,
  asyncAuthServiceProxy,
  AsyncAuthServiceProxy,
  new_AsyncAuthServiceProxy,
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
  createAndFundNewPSLCreditTrackingAddress,
  rpc_connection,
  checkSupernodeList,
};
