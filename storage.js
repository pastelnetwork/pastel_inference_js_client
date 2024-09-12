const storage = require("node-persist");
const { logger } = require("./logger");
const globals = require("./globals");

let storageInitialized = false;

async function initializeStorage() {
  if (!storageInitialized) {
    try {
      await storage.init({ logging: false });
      logger.info("Storage initialized successfully");
      storageInitialized = true;
    } catch (error) {
      logger.error(`Error initializing storage: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
      throw error;
    }
  }
}

async function getCurrentPastelIdAndPassphrase() {
  try {
    await initializeStorage();
    const pastelID = await storage.getItem("MY_LOCAL_PASTELID");
    const passphrase = await storage.getItem("MY_PASTELID_PASSPHRASE");

    if (!pastelID || !passphrase) {
      logger.warn("PastelID or passphrase not found in storage");
      return { pastelID: null, passphrase: null };
    }

    logger.info(`Retrieved PastelID from storage: ${pastelID}`);
    return { pastelID, passphrase };
  } catch (error) {
    logger.error(`Error retrieving PastelID and passphrase: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
    return { pastelID: null, passphrase: null };
  }
}

async function setPastelIdAndPassphrase(pastelID, passphrase) {
  if (!pastelID || !passphrase) {
    logger.error("Attempted to set empty PastelID or passphrase");
    throw new Error("PastelID and passphrase must not be empty");
  }

  try {
    await initializeStorage();
    await storage.setItem("MY_LOCAL_PASTELID", pastelID);
    await storage.setItem("MY_PASTELID_PASSPHRASE", passphrase);
    logger.info(`Set PastelID: ${pastelID}`);
  } catch (error) {
    logger.error(`Error setting PastelID and passphrase: ${error.message.slice(0, globals.MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE)}`);
    throw error;
  }
}

module.exports = {
  getCurrentPastelIdAndPassphrase,
  setPastelIdAndPassphrase,
};