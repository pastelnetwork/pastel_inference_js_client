const axios = require("axios");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const {
  Message,
  UserMessage,
  CreditPackPurchaseRequest,
  CreditPackPurchaseRequestRejection,
  CreditPackPurchaseRequestPreliminaryPriceQuote,
  CreditPackPurchaseRequestPreliminaryPriceQuoteResponse,
  CreditPackPurchaseRequestResponseTermination,
  CreditPackPurchaseRequestResponse,
  CreditPackPurchaseRequestConfirmation,
  CreditPackRequestStatusCheck,
  CreditPackPurchaseRequestStatus,
  CreditPackStorageRetryRequest,
  CreditPackStorageRetryRequestResponse,
  InferenceAPIUsageRequest,
  InferenceAPIUsageResponse,
  InferenceAPIOutputResult,
  InferenceConfirmation,
} = require("./sequelize_data_models");

const {
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
} = require("./validation_schemas");
const { logger } = require("./utility_functions");

let rpc_connection;
let burn_address;

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

const encodeDecimal = (obj) => {
  if (typeof obj === "number") {
    return Number(obj.toFixed(8));
  }
  throw new TypeError(`${obj} is not JSON serializable`);
};

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

  async call(...args) {
    await AsyncAuthServiceProxy.semaphore.acquire();
    try {
      this.idCount += 1;
      const postData = JSON.stringify(
        {
          version: "1.1",
          method: this.serviceName,
          params: args,
          id: this.idCount,
        },
        encodeDecimal
      );
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
            logger.warn(`Reconnect try #${i + 1}`);
            const sleepTime = this.reconnectTimeout * 2 ** i;
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
          logger.error(`Error occurred in call: ${error}`);
          const errMsg = `Failed to connect to ${this.url.hostname}:${this.url.port}`;
          const rtm = this.reconnectTimeout;
          if (rtm) {
            logger.error(`${errMsg}. Waiting ${rtm} seconds.`);
          } else {
            logger.error(errMsg);
          }
        }
      }

      if (!response) {
        logger.error("Reconnect tries exceeded.");
        return;
      }

      const responseJson = response.data;
      if (responseJson.error !== null) {
        throw new JSONRPCException(responseJson.error);
      } else if (!("result" in responseJson)) {
        throw new JSONRPCException({
          code: -343,
          message: "missing JSON-RPC result",
        });
      } else {
        return responseJson.result;
      }
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

async function initializeRPCConnection() {
  const { rpchost, rpcport, rpcuser, rpcpassword } =
    await getLocalRPCSettings();
  rpc_connection = new AsyncAuthServiceProxy(
    `http://${rpcuser}:${rpcpassword}@${rpchost}:${rpcport}`
  );

  if (rpcport === "9932") {
    burn_address = "PtpasteLBurnAddressXXXXXXXXXXbJ5ndd";
  } else if (rpcport === "19932") {
    burn_address = "tPpasteLBurnAddressXXXXXXXXXXX3wy7u";
  } else if (rpcport === "29932") {
    burn_address = "44oUgmZSL997veFEQDq569wv5tsT6KXf9QY7";
  }
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
  const { error, value } = messageSchema.validate({
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
    logger.error(`Error in sendToAddress: ${error}`);
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
    logger.error(`Error in sendMany: ${error}`);
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
      JSON.stringify(decodedTxData)
    );
    return decodedTxData;
  } catch (error) {
    logger.error(`Error in getAndDecodeRawTransaction for ${txid}:`, error);
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
      JSON.stringify(transactionDetails)
    );
    return transactionDetails;
  } catch (error) {
    logger.error(`Error retrieving transaction details for ${txid}:`, error);
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
    logger.error(`Error importing address: ${address}. Error:`, error);
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
    logger.error(`Error in getBlock for block hash ${blockHash}:`, error);
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
    logger.error(`Error in signMessageWithPastelID: ${error}`);
    return null;
  }
}

async function createAndFundNewPSLCreditTrackingAddress(amountOfPSLToFundAddressWith) {
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
    logger.error(`Error creating and funding new PSL credit tracking address: ${error.message}`);
    throw error;
  }
}

module.exports = {
  getLocalRPCSettings,
  JSONRPCException,
  asyncAuthServiceProxy,
  AsyncAuthServiceProxy,
  initializeRPCConnection,
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
};
