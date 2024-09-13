const fs = require('fs');
const path = require('path');
const {
    createAndRegisterNewPastelID,
    getLocalRPCSettings,
    initializeRPCConnection,
    dumpPrivKey,
    getPastelIDDirectory,
    getCurrentPastelBlockHeight,
    isPastelIDRegistered,
    isCreditPackConfirmed,
    getTransactionDetails
} = require('./rpc_functions');
const { handleCreditPackTicketEndToEnd } = require('./end_to_end_functions');
const { logger, safeStringify } = require('./logger');

const CONFIRMATION_BLOCKS = 1; // Number of blocks to wait for confirmation
const MAX_WAIT_TIME = 600000; // Maximum wait time in milliseconds (10 minutes)

async function waitForConfirmation(checkFunction, ...args) {
    const startTime = Date.now();
    while (Date.now() - startTime < MAX_WAIT_TIME) {
        if (await checkFunction(...args)) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds before checking again
    }
    throw new Error('Confirmation timed out');
}

async function waitForBlockConfirmation(startingBlockHeight) {
    const targetBlockHeight = startingBlockHeight + CONFIRMATION_BLOCKS;
    return waitForConfirmation(async () => {
        const currentBlockHeight = await getCurrentPastelBlockHeight();
        return currentBlockHeight >= targetBlockHeight;
    });
}

async function createPromotionalPack(packNumber, creditsPerPack) {
    logger.info(`Starting creation of promotional pack ${packNumber}`);
    try {
        await initializeRPCConnection();
        logger.info('RPC connection initialized successfully');

        const startingBlockHeight = await getCurrentPastelBlockHeight();
        const passphrase = 'testpass';

        logger.info('Creating and registering new PastelID...');
        const pastelIDResult = await createAndRegisterNewPastelID(passphrase);
        if (!pastelIDResult.success) {
            throw new Error(`Failed to create PastelID: ${pastelIDResult.message}`);
        }
        const pastelID = pastelIDResult.PastelID;
        logger.info(`PastelID created: ${pastelID}. Waiting for confirmation...`);

        await waitForConfirmation(isPastelIDRegistered, pastelID);
        logger.info(`PastelID ${pastelID} confirmed in blockchain`);

        logger.info(`Creating credit pack ticket for ${creditsPerPack} credits...`);
        const creditPackResult = await handleCreditPackTicketEndToEnd(
            creditsPerPack,
            null,
            'PtpasteLBurnAddressXXXXXXXXXXbJ5ndd',
            1000000,
            2000
        );
        if (!creditPackResult || !creditPackResult.txid) {
            throw new Error('Failed to create credit pack ticket');
        }
        logger.info(`Credit pack ticket created. TXID: ${creditPackResult.txid}. Waiting for confirmation...`);

        await waitForConfirmation(isCreditPackConfirmed, creditPackResult.txid);
        logger.info(`Credit pack ticket ${creditPackResult.txid} confirmed in blockchain`);

        await waitForBlockConfirmation(startingBlockHeight);
        logger.info('Required number of blocks have been mined');

        const trackingAddressPrivateKey = await dumpPrivKey(creditPackResult.trackingAddress);
        logger.info('Private key retrieved successfully');

        const { rpcport } = await getLocalRPCSettings();
        const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
        const pastelIDDir = getPastelIDDirectory(network);
        const secureContainerPath = path.join(pastelIDDir, pastelID);
        const secureContainerContent = fs.readFileSync(secureContainerPath, 'base64');
        logger.info('Secure container file retrieved successfully');

        const promotionalPackData = {
            pastelID,
            passphrase,
            secureContainer: secureContainerContent,
            creditPackTicket: creditPackResult,
            trackingAddress: {
                address: creditPackResult.trackingAddress,
                privateKey: trackingAddressPrivateKey
            },
            fundingTxid: creditPackResult.txid
        };
        logger.info('Promotional pack data serialized successfully');

        return promotionalPackData;
    } catch (error) {
        logger.error(`Error creating promotional pack ${packNumber}: ${error.message}`);
        return null;
    }
}

async function generatePromotionalPacks(numberOfPacks, creditsPerPack) {
    logger.info(`Starting generation of ${numberOfPacks} promotional packs with ${creditsPerPack} credits each`);
    const promotionalPacks = [];

    // Create the generated_promo_packs folder if it doesn't exist
    const folderPath = path.join(__dirname, 'generated_promo_packs');
    if (!fs.existsSync(folderPath)) {
        logger.info(`Creating folder: ${folderPath}`);
        fs.mkdirSync(folderPath);
    }

    for (let i = 0; i < numberOfPacks; i++) {
        logger.info(`Generating promotional pack ${i + 1} of ${numberOfPacks}`);
        const pack = await createPromotionalPack(i + 1, creditsPerPack);
        if (pack) {
            promotionalPacks.push(pack);
            logger.info(`Promotional pack ${i + 1} generated successfully`);
        } else {
            logger.warn(`Failed to generate promotional pack ${i + 1}`);
        }
    }
    // Save promotional packs to a file
    const serializedPacks = JSON.stringify(promotionalPacks, null, 2);
    const fileName = path.join(folderPath, `promotional_packs_${Date.now()}.json`);
    logger.info(`Saving promotional packs to file: ${fileName}`);
    fs.writeFileSync(fileName, serializedPacks);

    logger.info(`Generated ${promotionalPacks.length} promotional packs and saved to ${fileName}`);
    return { fileName, packCount: promotionalPacks.length };
}

module.exports = { generatePromotionalPacks };