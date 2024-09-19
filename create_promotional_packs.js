const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const {
    createAndRegisterNewPastelID,
    initializeRPCConnection,
    getLocalRPCSettings,
    dumpPrivKey,
    getPastelIDDirectory,
    getCurrentPastelBlockHeight,
    isPastelIDRegistered,
    isCreditPackConfirmed,
    getNewAddress,
    sendToAddress,
    signMessageWithPastelID,
    checkSupernodeList,
    getNetworkInfo,
} = require('./rpc_functions');
const { filterSupernodes } = require('./utility_functions');
const { PastelInferenceClient } = require('./pastel_inference_client');
const { handleCreditPackTicketEndToEnd, estimateCreditPackCostEndToEnd } = require('./end_to_end_functions');
const { logger } = require('./logger');
const globals = require("./globals");
const { promisify } = require('util');
const sleep = promisify(setTimeout);
const mkdirAsync = promisify(fs.mkdir);

// Configuration
const MAX_WAIT_TIME = 900000; // 15 minutes
const CONCURRENT_CREDIT_PACK_CREATIONS = 3; // Increased from 1 to 3 for actual concurrency
const INTERMEDIATE_PROMO_PACK_RESULTS_FILE = 'intermediate_promo_pack_results.json';
const PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS = "testpass";
const RETRY_DELAY = 10000; // 10 seconds
const BATCH_DELAY = 30000; // 30 seconds
const MAX_RETRIES = 3;
const { network, burnAddress } = getNetworkInfo("9932");

function loadIntermediateResults() {
    try {
        if (fs.existsSync(INTERMEDIATE_PROMO_PACK_RESULTS_FILE)) {
            return JSON.parse(fs.readFileSync(INTERMEDIATE_PROMO_PACK_RESULTS_FILE, 'utf8'));
        }
    } catch (error) {
        logger.error(`Error loading intermediate results: ${error.message}`);
    }
    return { registeredPastelIDs: [], completedPacks: [], pendingCreditPacks: [] };
}

function saveIntermediateResults(results) {
    try {
        fs.writeFileSync(INTERMEDIATE_PROMO_PACK_RESULTS_FILE, JSON.stringify(results, null, 2));
    } catch (error) {
        logger.error(`Error saving intermediate results: ${error.message}`);
    }
}

async function waitForConfirmation(checkFunction, ...args) {
    const startTime = Date.now();
    logger.info(`Starting confirmation wait for ${checkFunction.name} with args: ${JSON.stringify(args)}`);
    while (Date.now() - startTime < MAX_WAIT_TIME) {
        if (await checkFunction(...args)) {
            logger.info(`Confirmation successful for ${checkFunction.name}`);
            return true;
        }
        logger.debug(`Waiting for confirmation of ${checkFunction.name}. Elapsed time: ${(Date.now() - startTime) / 1000} seconds`);
        await sleep(10000);
    }
    logger.error(`Confirmation timed out for ${checkFunction.name} after ${MAX_WAIT_TIME / 1000} seconds`);
    throw new Error('Confirmation timed out');
}

async function createPastelIDs(count) {
    logger.info(`Starting creation of ${count} PastelIDs...`);
    const intermediateResults = loadIntermediateResults();
    const pastelIDs = [...intermediateResults.registeredPastelIDs];
    logger.info(`Loaded ${pastelIDs.length} existing PastelIDs from intermediate results`);

    for (let i = pastelIDs.length; i < count; i++) {
        const passphrase = PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS;
        logger.info(`Attempting to create PastelID ${i + 1}/${count} with passphrase: ${passphrase}`);

        try {
            const result = await createAndRegisterNewPastelID(passphrase);

            if (result && result.success) {
                const newPastelID = { pastelID: result.PastelID, passphrase };
                pastelIDs.push(newPastelID);
                intermediateResults.registeredPastelIDs.push(newPastelID);
                saveIntermediateResults(intermediateResults);
                logger.info(`Successfully created and registered PastelID ${i + 1}/${count}: ${result.PastelID}`);
            } else {
                logger.error(`Failed to create PastelID ${i + 1}/${count}: ${result ? result.message : 'Unknown error'}`);
            }

            await sleep(1000);
        } catch (error) {
            logger.error(`Unexpected error during PastelID creation attempt ${i + 1}/${count}: ${error.message}`);
        }
    }

    logger.info(`Completed creation of PastelIDs. Total successful: ${pastelIDs.length}/${count}`);
    return pastelIDs;
}

async function waitForPastelIDRegistrations(pastelIDs) {
    logger.info(`Starting to wait for ${pastelIDs.length} PastelID registrations...`);
    const registrationPromises = pastelIDs.map(({ pastelID }) => {
        logger.debug(`Waiting for registration of PastelID: ${pastelID}`);
        return waitForConfirmation(isPastelIDRegistered, pastelID);
    });
    await Promise.all(registrationPromises);
    logger.info('All PastelIDs confirmed in blockchain');
}

async function createCreditPack(pastelID, passphrase, creditsPerPack) {
    const maximumTotalCreditPackPriceInPSL = 10000;
    const maximumPerCreditPriceInPSL = 150;

    logger.info(`Starting credit pack creation for PastelID: ${pastelID} with ${creditsPerPack} credits`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const creditUsageTrackingPSLAddress = await getNewAddress();
            logger.info(`Created new PSL tracking address: ${creditUsageTrackingPSLAddress}`);

            const { rpcport } = await getLocalRPCSettings();
            const burnAddress = rpcport === '9932' ? 'PtpasteLBurnAddressXXXXXXXXXXbJ5ndd' :
                rpcport === '19932' ? 'tPpasteLBurnAddressXXXXXXXXXXX3wy7u' :
                    '44oUgmZSL997veFEQDq569wv5tsT6KXf9QY7';

            const result = await handleCreditPackTicketEndToEnd(
                creditsPerPack,
                creditUsageTrackingPSLAddress,
                burnAddress,
                maximumTotalCreditPackPriceInPSL,
                maximumPerCreditPriceInPSL,
                pastelID,
                passphrase
            );

            if (!result || !result.txid) {
                throw new Error('Failed to create credit pack ticket');
            }

            logger.info(`Credit pack ticket created successfully. TXID: ${result.txid}`);

            const trackingAddressPrivateKey = await dumpPrivKey(creditUsageTrackingPSLAddress);
            logger.info(`Private key retrieved successfully for tracking address: ${creditUsageTrackingPSLAddress}`);

            const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
            const pastelIDDir = getPastelIDDirectory(network);
            const secureContainerPath = path.join(pastelIDDir, pastelID);
            const secureContainerContent = fs.readFileSync(secureContainerPath, 'base64');
            logger.info(`Secure container file retrieved successfully for PastelID: ${pastelID}`);

            return {
                pastelID,
                passphrase,
                secureContainer: secureContainerContent,
                creditPackTicket: result,
                trackingAddress: {
                    address: creditUsageTrackingPSLAddress,
                    privateKey: trackingAddressPrivateKey
                },
                fundingTxid: result.txid
            };
        } catch (error) {
            if (attempt === MAX_RETRIES) {
                logger.error(`Failed to create credit pack for PastelID: ${pastelID} after ${MAX_RETRIES} attempts: ${error.message}`);
                throw error;
            }
            logger.warn(`Attempt ${attempt} failed. Retrying in ${RETRY_DELAY / 1000} seconds...`);
            await sleep(RETRY_DELAY);
        }
    }
}

async function generatePromotionalPacks(numberOfPacks, creditsPerPack) {
    logger.info(`Starting generation of ${numberOfPacks} promotional packs with ${creditsPerPack} credits each`);

    await initializeRPCConnection();
    logger.info('RPC connection initialized successfully');

    let pastelIDs = await createPastelIDs(numberOfPacks);
    logger.info(`Created ${pastelIDs.length} PastelIDs successfully`);

    logger.info('Waiting for all PastelID registrations to be confirmed...');
    await waitForPastelIDRegistrations(pastelIDs);

    logger.info(`Starting credit pack creation for ${pastelIDs.length} PastelIDs`);
    const promotionalPacks = [];
    const intermediateResults = loadIntermediateResults();

    for (let i = 0; i < pastelIDs.length; i += CONCURRENT_CREDIT_PACK_CREATIONS) {
        const batch = pastelIDs.slice(i, i + CONCURRENT_CREDIT_PACK_CREATIONS);
        logger.info(`Processing batch ${Math.floor(i / CONCURRENT_CREDIT_PACK_CREATIONS) + 1}: Creating ${batch.length} credit packs concurrently`);

        const batchPromises = batch.map(({ pastelID, passphrase }) =>
            createCreditPack(pastelID, passphrase, creditsPerPack)
        );

        const batchResults = await Promise.allSettled(batchPromises);

        for (let j = 0; j < batchResults.length; j++) {
            const result = batchResults[j];
            if (result.status === 'fulfilled') {
                promotionalPacks.push(result.value);
                intermediateResults.completedPacks.push(result.value);
                logger.info(`Successfully created credit pack for PastelID ${batch[j].pastelID}`);
            } else {
                logger.error(`Failed to create credit pack for PastelID ${batch[j].pastelID}: ${result.reason}`);
                intermediateResults.pendingCreditPacks.push({
                    pastelID: batch[j].pastelID,
                    passphrase: batch[j].passphrase,
                    creditsPerPack
                });
            }
        }

        saveIntermediateResults(intermediateResults);
        logger.info(`Completed batch ${Math.floor(i / CONCURRENT_CREDIT_PACK_CREATIONS) + 1}. Total packs created: ${promotionalPacks.length}`);

        if (i + CONCURRENT_CREDIT_PACK_CREATIONS < pastelIDs.length) {
            logger.info(`Waiting ${BATCH_DELAY / 1000} seconds before processing the next batch...`);
            await sleep(BATCH_DELAY);
        }
    }

    logger.info(`Completed creation of all ${promotionalPacks.length} promotional packs`);
    return promotionalPacks;
}


async function recoverExistingCreditPacks(creditsPerPack, maxBlockAge = 1500) {
    logger.info(`Starting recovery of existing credit packs with ${creditsPerPack} credits and max block age of ${maxBlockAge}`);
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const filteredSupernodes = await filterSupernodes(validMasternodeListFullDF);
    const selected_supernode_url = filteredSupernodes[0].url;
    const { rpcport } = await getLocalRPCSettings();
    const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
    const pastelIDDir = getPastelIDDirectory(network);

    // File to store PastelIDs that don't work with the default passphrase
    const invalidPassphrasePastelIDsFile = 'invalid_passphrase_pastelids.json';

    // Ensure the directory exists
    try {
        await mkdirAsync(pastelIDDir, { recursive: true });
    } catch (error) {
        logger.error(`Error creating directory ${pastelIDDir}: ${error.message}`);
        throw error; // Rethrow the error as this is a critical operation
    }

    // Load or initialize the list of PastelIDs that don't work with the default passphrase
    let invalidPassphrasePastelIDs = new Set();
    try {
        const data = await fsPromises.readFile(invalidPassphrasePastelIDsFile, 'utf8');
        invalidPassphrasePastelIDs = new Set(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist, create it with an empty array
            await fsPromises.writeFile(invalidPassphrasePastelIDsFile, '[]');
        } else if (error instanceof SyntaxError) {
            // File exists but contains invalid JSON, overwrite with an empty array
            await fsPromises.writeFile(invalidPassphrasePastelIDsFile, '[]');
        } else {
            logger.warn(`Error reading invalid passphrase PastelIDs file: ${error.message}`);
        }
    }

    // Read the directory and sort files by creation time, most recent first
    const pastelIDFiles = await fsPromises.readdir(pastelIDDir);
    const pastelIDs = await Promise.all(pastelIDFiles
        .filter(file => file.length === 86)
        .map(async file => ({
            file,
            ctime: (await fsPromises.stat(path.join(pastelIDDir, file))).ctime
        })));

    pastelIDs.sort((a, b) => b.ctime - a.ctime); // Sort by creation time, descending

    const currentBlockHeight = await getCurrentPastelBlockHeight();
    const recoveredPacks = [];
    const recoveredPastelIDs = [];

    for (const { file: pastelID } of pastelIDs) {
        if (invalidPassphrasePastelIDs.has(pastelID)) {
            logger.debug(`Skipping PastelID ${pastelID}: Known invalid passphrase`);
            continue;
        }

        try {
            const testMessage = "Test message for PastelID verification";
            await signMessageWithPastelID(pastelID, testMessage, PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS);

            const inferenceClient = new PastelInferenceClient(pastelID, PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS);
            const validCreditPacks = await inferenceClient.getValidCreditPackTicketsForPastelID(selected_supernode_url);

            if (validCreditPacks.length === 0) {
                // This PastelID doesn't have any credit packs, add it to recoveredPastelIDs
                recoveredPastelIDs.push({
                    pastelID,
                    passphrase: PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS
                });
                logger.info(`Recovered PastelID without credit pack: ${pastelID}`);
            } else {
                for (const pack of validCreditPacks) {
                    if (
                        (pack.requested_initial_credits_in_credit_pack === creditsPerPack) &&
                        (currentBlockHeight - pack.credit_purchase_request_confirmation_pastel_block_height) <= maxBlockAge
                    ) {
                        const trackingAddressPrivKey = await dumpPrivKey(pack.credit_usage_tracking_psl_address);
                        const secureContainerPath = path.join(pastelIDDir, pastelID);
                        const secureContainerContent = await fsPromises.readFile(secureContainerPath, 'base64');

                        const recoveredPack = {
                            pastelID,
                            passphrase: PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS,
                            secureContainer: secureContainerContent,
                            creditPackTicket: pack,
                            trackingAddress: {
                                address: pack.credit_usage_tracking_psl_address,
                                privateKey: trackingAddressPrivKey
                            },
                            fundingTxid: pack.txid_of_credit_purchase_burn_transaction
                        };

                        recoveredPacks.push(recoveredPack);
                        logger.info(`Recovered credit pack for PastelID: ${pastelID}, TXID: ${pack.txid_of_credit_purchase_burn_transaction}`);
                    }
                }
            }
        } catch (error) {
            logger.debug(`PastelID ${pastelID} skipped: Unable to sign with default passphrase or error in recovery: ${error.message}`);
            invalidPassphrasePastelIDs.add(pastelID);
        }
    }

    // Save the updated list of invalid passphrase PastelIDs
    try {
        await fsPromises.writeFile(invalidPassphrasePastelIDsFile, JSON.stringify(Array.from(invalidPassphrasePastelIDs)));
    } catch (error) {
        logger.warn(`Error writing invalid passphrase PastelIDs file: ${error.message}`);
    }

    // Update intermediate results
    const intermediateResults = loadIntermediateResults();
    intermediateResults.registeredPastelIDs = [
        ...intermediateResults.registeredPastelIDs,
        ...recoveredPastelIDs
    ];
    intermediateResults.completedPacks = [
        ...intermediateResults.completedPacks,
        ...recoveredPacks
    ];
    saveIntermediateResults(intermediateResults);

    logger.info(`Recovered ${recoveredPacks.length} existing credit packs and ${recoveredPastelIDs.length} PastelIDs without credit packs`);
    return { recoveredPacks, recoveredPastelIDs };
}

async function generateOrRecoverPromotionalPacks(numberOfPacks, creditsPerPack) {
    logger.info(`Starting generation or recovery of ${numberOfPacks} promotional packs with ${creditsPerPack} credits each`);

    await initializeRPCConnection();
    logger.info('RPC connection initialized successfully');

    // Recover existing packs and PastelIDs
    const { recoveredPacks, recoveredPastelIDs } = await recoverExistingCreditPacks(creditsPerPack);
    logger.info(`Recovered ${recoveredPacks.length} existing promotional packs and ${recoveredPastelIDs.length} PastelIDs without credit packs`);

    const intermediateResults = loadIntermediateResults();
    const availablePastelIDs = [
        ...recoveredPastelIDs,
        ...intermediateResults.registeredPastelIDs.filter(id =>
            !intermediateResults.completedPacks.some(pack => pack.pastelID === id.pastelID)
        )
    ];

    // If we have recovered enough packs, return them
    if (recoveredPacks.length >= numberOfPacks) {
        logger.info(`Sufficient packs recovered. Returning ${numberOfPacks} packs.`);
        return recoveredPacks.slice(0, numberOfPacks);
    }

    // If we haven't recovered enough packs, use available PastelIDs or generate new ones
    const packsToGenerate = numberOfPacks - recoveredPacks.length;
    logger.info(`Generating ${packsToGenerate} additional promotional packs`);

    const generatedPacks = [];
    for (let i = 0; i < packsToGenerate; i++) {
        let pastelID, passphrase;
        if (availablePastelIDs.length > 0) {
            ({ pastelID, passphrase } = availablePastelIDs.pop());
            logger.info(`Using existing PastelID: ${pastelID}`);
        } else {
            // Create new PastelIDs using the existing createPastelIDs function
            const newPastelIDs = await createPastelIDs(1);
            ({ pastelID, passphrase } = newPastelIDs[0]);
            intermediateResults.registeredPastelIDs.push({ pastelID, passphrase });
            logger.info(`Created new PastelID: ${pastelID}`);
        }

        // Create credit pack
        const pack = await handleCreditPackTicketEndToEnd(
            creditsPerPack,
            await getNewAddress(),
            burnAddress,
            10000, // maximumTotalCreditPackPriceInPSL
            150,   // maximumPerCreditPriceInPSL
            pastelID,
            passphrase
        );

        if (pack && pack.txid) {
            const trackingAddressPrivKey = await dumpPrivKey(pack.creditUsageTrackingPSLAddress);
            const secureContainerPath = path.join(getPastelIDDirectory(network), pastelID);
            const secureContainerContent = await fsPromises.readFile(secureContainerPath, 'base64');

            const generatedPack = {
                pastelID,
                passphrase,
                secureContainer: secureContainerContent,
                creditPackTicket: pack,
                trackingAddress: {
                    address: pack.creditUsageTrackingPSLAddress,
                    privateKey: trackingAddressPrivKey
                },
                fundingTxid: pack.txid
            };

            generatedPacks.push(generatedPack);
            intermediateResults.completedPacks.push(generatedPack);
            logger.info(`Generated credit pack for PastelID: ${pastelID}, TXID: ${pack.txid}`);
        } else {
            logger.error(`Failed to create credit pack for PastelID: ${pastelID}`);
        }

        // Save intermediate results after each pack generation
        saveIntermediateResults(intermediateResults);
    }

    logger.info(`Generated ${generatedPacks.length} new promotional packs`);

    // Combine recovered and generated packs
    const combinedPacks = [...recoveredPacks, ...generatedPacks];
    logger.info(`Total packs: ${combinedPacks.length} (${recoveredPacks.length} recovered, ${generatedPacks.length} generated)`);

    return combinedPacks;
}

module.exports = {
    generatePromotionalPacks,
    recoverExistingCreditPacks,
    generateOrRecoverPromotionalPacks
};