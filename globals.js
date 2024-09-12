let MY_LOCAL_PASTELID = null;
let MY_PASTELID_PASSPHRASE = null;

const MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE = 1000;

function setPastelIdAndPassphrase(pastelId, passphrase) {
    MY_LOCAL_PASTELID = pastelId;
    MY_PASTELID_PASSPHRASE = passphrase;
}

function getPastelIdAndPassphrase() {
    return { pastelID: MY_LOCAL_PASTELID, passphrase: MY_PASTELID_PASSPHRASE };
}

function getPastelId() {
    return MY_LOCAL_PASTELID;
}

function getPassphrase() {
    return MY_PASTELID_PASSPHRASE;
}

module.exports = {
    setPastelIdAndPassphrase,
    getPastelIdAndPassphrase,
    getPastelId,
    getPassphrase,
    MAX_CHARACTERS_TO_DISPLAY_IN_ERROR_MESSAGE
};
