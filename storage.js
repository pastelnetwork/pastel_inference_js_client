const storage = require("node-persist");

let storageInitialized = false;

async function initializeStorage() {
  if (!storageInitialized) {
    await storage.init({
      dir: "./my-local-pastelid-cache",
      logging: true,
    });
    console.log("Storage initialized");
    storageInitialized = true;
  }
}

async function getCurrentPastelIdAndPassphrase() {
  try {
    await initializeStorage();
    const pastelID = await storage.getItem("MY_LOCAL_PASTELID");
    const passphrase = await storage.getItem("MY_PASTELID_PASSPHRASE");
    console.log(`Retrieved PastelID: ${pastelID}, Passphrase: ${passphrase}`);
    return { pastelID: pastelID || "", passphrase: passphrase || "" };
  } catch (error) {
    console.error("Error retrieving PastelID and passphrase:", error);
    return { pastelID: "", passphrase: "" };
  }
}

async function setPastelIdAndPassphrase(pastelID, passphrase) {
  try {
    await initializeStorage();
    await storage.setItem("MY_LOCAL_PASTELID", pastelID);
    await storage.setItem("MY_PASTELID_PASSPHRASE", passphrase);
    console.log(`Set PastelID: ${pastelID}, Passphrase: ${passphrase}`);
  } catch (error) {
    console.error("Error setting PastelID and passphrase:", error);
    throw error;
  }
}

module.exports = {
  initializeStorage,
  getCurrentPastelIdAndPassphrase,
  setPastelIdAndPassphrase,
};
