let MY_LOCAL_PASTELID = null;
let MY_PASTELID_PASSPHRASE = null;

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
    getPassphrase
};