const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');

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
    listPastelIDTickets,
} = require('./rpc_functions');

const { filterSupernodes, getNClosestSupernodesToPastelIDURLs } = require('./utility_functions');
const { PastelInferenceClient } = require('./pastel_inference_client');
const { handleCreditPackTicketEndToEnd, estimateCreditPackCostEndToEnd } = require('./end_to_end_functions');
const { logger } = require('./logger');

const CONFIG = {
    MAX_WAIT_TIME: 900000,
    CONCURRENT_CREDIT_PACK_CREATIONS: 3,
    INTERMEDIATE_PROMO_PACK_RESULTS_FILE: 'intermediate_promo_pack_results.json',
    INVALID_PASSPHRASE_PASTELIDS_FILE: 'invalid_passphrase_pastelids.json',
    LOCK_FILE: 'invalid_pastelids.lock',
    PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS: "testpass",
    RETRY_DELAY: 10000,
    BATCH_DELAY: 30000,
    MAX_RETRIES: 3
};

const sleep = promisify(setTimeout);
const { network, burnAddress } = getNetworkInfo("9932");

async function saveIntermediateResults(results) {
    try {
        // Update pendingCreditPacks structure
        results.pendingCreditPacks = results.pendingCreditPacks.map(pack => ({
            pastel_id_pubkey: pack.pastel_id_pubkey,
            pastel_id_passphrase: pack.pastel_id_passphrase,
            requested_initial_credits_in_credit_pack: pack.requested_initial_credits_in_credit_pack,
            psl_credit_usage_tracking_address: pack.psl_credit_usage_tracking_address,
            psl_credit_usage_tracking_address_private_key: pack.psl_credit_usage_tracking_address_private_key
        }));
        await fs.writeFile(CONFIG.INTERMEDIATE_PROMO_PACK_RESULTS_FILE, JSON.stringify(results, null, 2));
    } catch (error) {
        logger.error(`Error saving intermediate results: ${error.message}`);
    }
}

function validateIntermediateResults(results) {
    if (!results.registeredPastelIDs || !Array.isArray(results.registeredPastelIDs)) {
        throw new Error('Invalid registeredPastelIDs in intermediate results');
    }
    if (!results.completedPacks || !Array.isArray(results.completedPacks)) {
        throw new Error('Invalid completedPacks in intermediate results');
    }
    if (!results.pendingCreditPacks || !Array.isArray(results.pendingCreditPacks)) {
        throw new Error('Invalid pendingCreditPacks in intermediate results');
    }
}

async function loadIntermediateResults() {
    try {
        const data = await fs.readFile(CONFIG.INTERMEDIATE_PROMO_PACK_RESULTS_FILE, 'utf8');
        const results = JSON.parse(data);
        validateIntermediateResults(results);
        return results;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error(`Error loading intermediate results: ${error.message}`);
        }
        return { registeredPastelIDs: [], completedPacks: [], pendingCreditPacks: [] };
    }
}

async function acquireLock() {
    while (true) {
        try {
            await fs.writeFile(CONFIG.LOCK_FILE, '', { flag: 'wx' });
            return;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

async function releaseLock() {
    try {
        await fs.unlink(CONFIG.LOCK_FILE);
    } catch (error) {
        logger.error(`Error releasing lock: ${error.message}`);
    }
}

async function loadInvalidPassphrasePastelIDs() {
    await acquireLock();
    try {
        const data = await fs.readFile(CONFIG.INVALID_PASSPHRASE_PASTELIDS_FILE, 'utf8');
        return new Set(JSON.parse(data));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error(`Error loading invalid passphrase PastelIDs: ${error.message}`);
        }
        return new Set();
    } finally {
        await releaseLock();
    }
}

async function saveInvalidPassphrasePastelID(pastelID) {
    await acquireLock();
    try {
        let invalidPastelIDs;
        try {
            const data = await fs.readFile(CONFIG.INVALID_PASSPHRASE_PASTELIDS_FILE, 'utf8');
            invalidPastelIDs = new Set(JSON.parse(data));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error(`Error reading invalid passphrase PastelIDs: ${error.message}`);
            }
            invalidPastelIDs = new Set();
        }

        invalidPastelIDs.add(pastelID);
        await fs.writeFile(CONFIG.INVALID_PASSPHRASE_PASTELIDS_FILE, JSON.stringify(Array.from(invalidPastelIDs)));
    } catch (error) {
        logger.error(`Error saving invalid passphrase PastelID: ${error.message}`);
    } finally {
        await releaseLock();
    }
}

async function verifyPastelIDAndPassphrase(pastelID, passphrase) {
    try {
        const testMessage = "Verification test message";
        const signature = await signMessageWithPastelID(pastelID, testMessage, passphrase);
        const verificationResult = await verifyMessageWithPastelID(pastelID, testMessage, signature);
        return verificationResult;
    } catch (error) {
        logger.error(`Error verifying PastelID and passphrase: ${error.message}`);
        return false;
    }
}

async function createPastelIDs(count) {
    logger.info(`Starting creation of ${count} PastelIDs...`);
    const intermediateResults = await loadIntermediateResults();
    const pastelIDs = [...intermediateResults.registeredPastelIDs];
    logger.info(`Loaded ${pastelIDs.length} existing PastelIDs from intermediate results`);

    for (let i = pastelIDs.length; i < count; i++) {
        const passphrase = CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS;
        logger.info(`Attempting to create PastelID ${i + 1}/${count} with passphrase: ${passphrase}`);

        try {
            const result = await createAndRegisterNewPastelID(passphrase);

            if (result && result.success) {
                const newPastelID = { pastel_id_pubkey: result.PastelID, pastel_id_passphrase: passphrase };

                // Verify registration
                const isRegistered = await isPastelIDRegistered(result.PastelID);
                if (isRegistered) {
                    pastelIDs.push(newPastelID);
                    intermediateResults.registeredPastelIDs.push(newPastelID);
                    await saveIntermediateResults(intermediateResults);
                    logger.info(`Successfully created and registered PastelID ${i + 1}/${count}: ${result.PastelID}`);
                } else {
                    logger.warn(`PastelID ${result.PastelID} creation succeeded but registration not confirmed`);
                }
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

async function deduplicateIntermediateResults(intermediateResults) {
    // Deduplicate registered PastelIDs
    const uniqueRegisteredPastelIDs = new Map();
    for (const pastelID of intermediateResults.registeredPastelIDs) {
        uniqueRegisteredPastelIDs.set(pastelID.pastel_id_pubkey, pastelID);
    }

    // Deduplicate completed packs
    const uniqueCompletedPacks = new Map();
    for (const pack of intermediateResults.completedPacks) {
        const key = `${pack.pastel_id_pubkey}-${pack.credit_pack_registration_txid}`;
        if (!uniqueCompletedPacks.has(key) ||
            pack.credit_purchase_request_confirmation_pastel_block_height >
            uniqueCompletedPacks.get(key).credit_purchase_request_confirmation_pastel_block_height) {
            uniqueCompletedPacks.set(key, pack);
        }
    }

    // Deduplicate pending credit packs
    const uniquePendingCreditPacks = new Map();
    for (const pack of intermediateResults.pendingCreditPacks) {
        const key = `${pack.pastel_id_pubkey}-${pack.requested_initial_credits_in_credit_pack}-${pack.psl_credit_usage_tracking_address}`;
        if (!uniquePendingCreditPacks.has(key)) {
            uniquePendingCreditPacks.set(key, pack);
        }

        // Remove this PastelID from registeredPastelIDs if it exists
        uniqueRegisteredPastelIDs.delete(pack.pastel_id_pubkey);
    }

    intermediateResults.registeredPastelIDs = Array.from(uniqueRegisteredPastelIDs.values());
    intermediateResults.completedPacks = Array.from(uniqueCompletedPacks.values());
    intermediateResults.pendingCreditPacks = Array.from(uniquePendingCreditPacks.values());

    await saveIntermediateResults(intermediateResults);
}

async function saveCompletedPacksAsIndividualFiles() {
    try {
        const intermediateResultsPath = 'intermediate_promo_pack_results.json';
        const intermediateResultsData = await fs.readFile(intermediateResultsPath, 'utf8');
        let intermediateResults = JSON.parse(intermediateResultsData);

        const outputDirectory = 'generated_promo_packs';
        await fs.mkdir(outputDirectory, { recursive: true });

        const remainingCompletedPacks = [];
        for (const pack of intermediateResults.completedPacks) {
            const fileName = `promo_pack_${pack.pastel_id_pubkey}.json`;
            const filePath = path.join(outputDirectory, fileName);

            try {
                await fs.writeFile(filePath, JSON.stringify(pack, null, 2));
                console.log(`Saved promo pack for PastelID: ${pack.pastel_id_pubkey}`);
            } catch (error) {
                console.error(`Error saving promo pack for PastelID: ${pack.pastel_id_pubkey}`, error);
                remainingCompletedPacks.push(pack);
            }
        }

        intermediateResults.completedPacks = remainingCompletedPacks;
        await fs.writeFile(intermediateResultsPath, JSON.stringify(intermediateResults, null, 2));

        console.log(`Completed saving ${intermediateResults.completedPacks.length} promo packs.`);
        console.log(`${remainingCompletedPacks.length} completed promo packs remain in the intermediate results.`);
    } catch (error) {
        console.error('Error in saveCompletedPacksAsIndividualFiles:', error);
    }
}

async function recoverExistingCreditPacks(creditsPerPack, maxBlockAge = 1500) {
    try {
        await saveCompletedPacksAsIndividualFiles();
        logger.info(`Starting recovery of existing credit packs with ${creditsPerPack} credits and max block age of ${maxBlockAge}`);

        const { validMasternodeListFullDF } = await checkSupernodeList();
        logger.info(`Found ${validMasternodeListFullDF.length} valid masternodes`);

        const { rpcport } = await getLocalRPCSettings();
        const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
        const pastelIDDir = getPastelIDDirectory(network);

        let intermediateResults = await loadIntermediateResults();
        let invalidPassphrasePastelIDs = await loadInvalidPassphrasePastelIDs();

        const currentBlockHeight = await getCurrentPastelBlockHeight();
        logger.info(`Current block height: ${currentBlockHeight}`);

        const newlyRecoveredPacks = [];
        const outputDirectory = 'generated_promo_packs';
        await fs.mkdir(outputDirectory, { recursive: true });

        const initialMinimumNonEmptyResponses = 5;
        const maxTotalResponsesIfAllEmpty = 20;

        for (const pendingPack of intermediateResults.pendingCreditPacks) {
            try {
                logger.info(`Processing pending pack for PastelID: ${pendingPack.pastel_id_pubkey}`);

                const closestSupernodes = await getNClosestSupernodesToPastelIDURLs(120, pendingPack.pastel_id_pubkey, validMasternodeListFullDF);

                let allResponses = [];
                let nonEmptyResponses = [];
                let isResolved = false;

                await new Promise((resolve, reject) => {
                    let completedRequests = 0;

                    const handleResponse = () => {
                        if (isResolved) return;

                        if (nonEmptyResponses.length >= initialMinimumNonEmptyResponses) {
                            isResolved = true;
                            resolve();
                        } else if (allResponses.length >= maxTotalResponsesIfAllEmpty) {
                            isResolved = true;
                            resolve();
                        } else if (completedRequests >= closestSupernodes.length) {
                            isResolved = true;
                            resolve();
                        }
                    };

                    closestSupernodes.forEach(({ url }) => {
                        if (isResolved) return;

                        (async () => {
                            try {
                                const inferenceClient = new PastelInferenceClient(pendingPack.pastel_id_pubkey, pendingPack.pastel_id_passphrase);
                                const response = await inferenceClient.getValidCreditPackTicketsForPastelID(url);

                                if (isResolved) return;

                                allResponses.push({ response, url });
                                if (response.length > 0) {
                                    nonEmptyResponses.push({ response, url });
                                }
                                completedRequests++;
                                handleResponse();
                            } catch (error) {
                                if (isResolved) return;
                                logger.error(`Error querying supernode at ${url}: ${error.message}`);
                                completedRequests++;
                                handleResponse();
                            }
                        })();
                    });
                });

                if (nonEmptyResponses.length > 0) {
                    const longestResponse = nonEmptyResponses.reduce((prev, current) =>
                        current.response.length > prev.response.length ? current : prev
                    ).response;

                    for (const pack of longestResponse) {
                        if (pack.requested_initial_credits_in_credit_pack === pendingPack.requested_initial_credits_in_credit_pack &&
                            pack.credit_usage_tracking_psl_address === pendingPack.psl_credit_usage_tracking_address) {

                            const isConfirmed = await isCreditPackConfirmed(pack.credit_pack_registration_txid);
                            if (!isConfirmed) {
                                logger.info(`Credit pack ${pack.credit_pack_registration_txid} is not yet confirmed. Skipping.`);
                                continue;
                            }

                            const packAge = currentBlockHeight - pack.credit_purchase_request_confirmation_pastel_block_height;
                            if (packAge > maxBlockAge) {
                                logger.info(`Credit pack ${pack.credit_pack_registration_txid} is too old (${packAge} blocks). Skipping.`);
                                continue;
                            }

                            const trackingAddressPrivKey = await dumpPrivKey(pack.credit_usage_tracking_psl_address);
                            const secureContainerPath = path.join(pastelIDDir, pendingPack.pastel_id_pubkey);
                            const secureContainerContent = await fs.readFile(secureContainerPath, 'base64');

                            const recoveredPack = {
                                pastel_id_pubkey: pendingPack.pastel_id_pubkey,
                                pastel_id_passphrase: pendingPack.pastel_id_passphrase,
                                secureContainerBase64: secureContainerContent,
                                credit_pack_registration_txid: pack.credit_pack_registration_txid,
                                credit_purchase_request_confirmation_pastel_block_height: pack.credit_purchase_request_confirmation_pastel_block_height,
                                requested_initial_credits_in_credit_pack: pack.requested_initial_credits_in_credit_pack,
                                psl_credit_usage_tracking_address: pack.credit_usage_tracking_psl_address,
                                psl_credit_usage_tracking_address_private_key: trackingAddressPrivKey
                            };

                            const fileName = `promo_pack_${pendingPack.pastel_id_pubkey}.json`;
                            const filePath = path.join(outputDirectory, fileName);
                            await fs.writeFile(filePath, JSON.stringify(recoveredPack, null, 2));

                            newlyRecoveredPacks.push(recoveredPack);
                            logger.info(`Recovered and saved credit pack for PastelID: ${pendingPack.pastel_id_pubkey}, TXID: ${pack.credit_pack_registration_txid}`);

                            // Remove this pack from pendingCreditPacks
                            intermediateResults.pendingCreditPacks = intermediateResults.pendingCreditPacks.filter(
                                p => p.pastel_id_pubkey !== pendingPack.pastel_id_pubkey
                            );
                            break;
                        }
                    }
                } else {
                    logger.info(`No valid credit packs found for PastelID: ${pendingPack.pastel_id_pubkey}`);
                }
            } catch (error) {
                logger.error(`Error processing pending credit pack for PastelID ${pendingPack.pastel_id_pubkey}: ${error.message}`);
            }
        }

        intermediateResults.completedPacks = [
            ...intermediateResults.completedPacks,
            ...newlyRecoveredPacks
        ];

        await saveIntermediateResults(intermediateResults);
        await deduplicateIntermediateResults(intermediateResults);

        logger.info(`Recovered ${newlyRecoveredPacks.length} new credit packs`);
        return { recoveredPacks: newlyRecoveredPacks, recoveredPastelIDs: [] };
    } catch (error) {
        logger.error(`Error in recoverExistingCreditPacks: ${error.message}`);
        throw error;
    }
}

async function generateOrRecoverPromotionalPacks(numberOfPacks, creditsPerPack) {
    logger.info(`Starting generation or recovery of ${numberOfPacks} promotional packs with ${creditsPerPack} credits each`);

    try {
        await initializeRPCConnection();
        logger.info('RPC connection initialized successfully');

        let intermediateResults = await loadIntermediateResults();
        await deduplicateIntermediateResults(intermediateResults);
        logger.info('Intermediate results loaded and deduplicated');

        const { recoveredPacks, recoveredPastelIDs } = await recoverExistingCreditPacks(creditsPerPack);
        logger.info(`Recovered ${recoveredPacks.length} existing promotional packs and ${recoveredPastelIDs.length} PastelIDs without credit packs`);

        intermediateResults.registeredPastelIDs = [
            ...intermediateResults.registeredPastelIDs,
            ...recoveredPastelIDs
        ];

        const availablePastelIDs = [
            ...recoveredPastelIDs,
            ...intermediateResults.registeredPastelIDs.filter(id =>
                !intermediateResults.completedPacks.some(pack => pack.pastel_id_pubkey === id.pastel_id_pubkey)
            )
        ];

        let combinedPacks = [...recoveredPacks];

        const outputDirectory = 'generated_promo_packs';
        await fs.mkdir(outputDirectory, { recursive: true });

        if (combinedPacks.length < numberOfPacks) {
            const packsToGenerate = numberOfPacks - combinedPacks.length;
            logger.info(`Generating ${packsToGenerate} additional promotional packs`);

            const { rpcport } = await getLocalRPCSettings();
            const { network, burnAddress } = getNetworkInfo(rpcport);

            for (let i = 0; i < packsToGenerate; i++) {
                let pastelID, passphrase;
                if (availablePastelIDs.length > 0) {
                    ({ pastel_id_pubkey: pastelID, pastel_id_passphrase: passphrase } = availablePastelIDs.pop());
                    logger.info(`Using existing PastelID: ${pastelID}`);
                } else {
                    const newPastelIDs = await createPastelIDs(1);
                    ({ pastel_id_pubkey: pastelID, pastel_id_passphrase: passphrase } = newPastelIDs[0]);
                    intermediateResults.registeredPastelIDs.push({ pastel_id_pubkey: pastelID, pastel_id_passphrase: passphrase });
                    logger.info(`Created new PastelID: ${pastelID}`);
                }

                const newAddress = await getNewAddress();
                try {
                    const pack = await handleCreditPackTicketEndToEnd(
                        creditsPerPack,
                        newAddress,
                        burnAddress,
                        20000, // maximumTotalCreditPackPriceInPSL
                        150,   // maximumPerCreditPriceInPSL
                        pastelID,
                        passphrase
                    );

                    if (pack && pack.credit_pack_registration_txid) {
                        const trackingAddressPrivKey = await dumpPrivKey(pack.creditUsageTrackingPSLAddress);
                        const secureContainerPath = path.join(getPastelIDDirectory(network), pastelID);
                        const secureContainerContent = await fs.readFile(secureContainerPath, 'base64');

                        const generatedPack = {
                            pastel_id_pubkey: pastelID,
                            pastel_id_passphrase: passphrase,
                            secureContainerBase64: secureContainerContent,
                            credit_pack_registration_txid: pack.credit_pack_registration_txid,
                            credit_purchase_request_confirmation_pastel_block_height: pack.credit_purchase_request_confirmation_pastel_block_height,
                            requested_initial_credits_in_credit_pack: creditsPerPack,
                            psl_credit_usage_tracking_address: pack.creditUsageTrackingPSLAddress,
                            psl_credit_usage_tracking_address_private_key: trackingAddressPrivKey
                        };

                        // Save individual JSON file for the newly generated pack
                        const fileName = `promo_pack_${pastelID}.json`;
                        const filePath = path.join(outputDirectory, fileName);
                        await fs.writeFile(filePath, JSON.stringify(generatedPack, null, 2));

                        combinedPacks.push(generatedPack);
                        intermediateResults.completedPacks.push(generatedPack);
                        logger.info(`Generated and saved credit pack for PastelID: ${pastelID}, TXID: ${pack.credit_pack_registration_txid}, Tracking Address: ${pack.creditUsageTrackingPSLAddress}`);
                    } else {
                        logger.error(`Failed to create credit pack for PastelID: ${pastelID}`);
                        intermediateResults.pendingCreditPacks.push({
                            pastel_id_pubkey: pastelID,
                            pastel_id_passphrase: passphrase,
                            requested_initial_credits_in_credit_pack: creditsPerPack,
                            psl_credit_usage_tracking_address: newAddress
                        });
                    }
                } catch (error) {
                    logger.error(`Error generating credit pack for PastelID ${pastelID}: ${error.message}`);
                    intermediateResults.pendingCreditPacks.push({
                        pastel_id_pubkey: pastelID,
                        pastel_id_passphrase: passphrase,
                        requested_initial_credits_in_credit_pack: creditsPerPack,
                        psl_credit_usage_tracking_address: newAddress
                    });
                }

                await saveIntermediateResults(intermediateResults);
            }
        } else {
            logger.info(`Sufficient packs recovered. Using ${numberOfPacks} out of ${combinedPacks.length} available packs.`);
            combinedPacks = combinedPacks.slice(0, numberOfPacks);
        }

        if (combinedPacks.length < numberOfPacks) {
            logger.warn(`Only ${combinedPacks.length} out of ${numberOfPacks} requested promotional packs were successfully created.`);
        }

        logger.info(`Total packs: ${combinedPacks.length} (${recoveredPacks.length} recovered, ${combinedPacks.length - recoveredPacks.length} generated)`);
        await deduplicateIntermediateResults(intermediateResults);
        logger.info('Final deduplication of intermediate results completed');
        return combinedPacks;
    } catch (error) {
        logger.error(`Error in generateOrRecoverPromotionalPacks: ${error.message}`);
        throw error;
    }
}

module.exports = {
    generateOrRecoverPromotionalPacks,
    recoverExistingCreditPacks,
};