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
    ensureTrackingAddressesHaveMinimalPSLBalance,
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

async function checkIfPastelIDPassphraseIsPromoPackDefault(pastelID) {
    const DEFAULT_PROMO_PACK_PASSPHRASE = CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS;
    const TEST_MESSAGE = "Promo pack passphrase verification test";

    try {
        const signature = await signMessageWithPastelID(pastelID, TEST_MESSAGE, DEFAULT_PROMO_PACK_PASSPHRASE);

        // If we get a valid signature, the passphrase is correct
        if (signature && typeof signature === 'string' && signature.length > 0) {
            logger.info(`PastelID ${pastelID} is using the default promotional pack passphrase.`);
            return true;
        } else {
            logger.info(`PastelID ${pastelID} is not using the default promotional pack passphrase.`);
            return false;
        }
    } catch (error) {
        // If there's an error, the passphrase is likely incorrect
        logger.warn(`Error checking passphrase for PastelID ${pastelID}: ${error.message}`);
        return false;
    }
}

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
                    logger.info(`Successfully created and registered PastelID ${i + 1}/${count}: ${result.PastelID}`);
                } else {
                    logger.warn(`PastelID ${result.PastelID} creation succeeded but registration not immediately confirmed. Proceeding anyway.`);
                }

                pastelIDs.push(newPastelID);
                intermediateResults.registeredPastelIDs.push(newPastelID);
                await saveIntermediateResults(intermediateResults);
            } else {
                logger.error(`Failed to create PastelID ${i + 1}/${count}: ${result ? result.message : 'Unknown error'}`);
            }

            await sleep(1000);
        } catch (error) {
            logger.error(`Unexpected error during PastelID creation attempt ${i + 1}/${count}: ${error.message}`);
        }
    }

    logger.info(`Completed creation of PastelIDs. Total created: ${pastelIDs.length}/${count}`);
    return pastelIDs;
}

async function deduplicateIntermediateResults(intermediateResults) {
    // Deduplicate registered PastelIDs
    const uniqueRegisteredPastelIDs = new Map();
    for (const pastelID of intermediateResults.registeredPastelIDs) {
        if (pastelID.pastel_id_pubkey) {
            uniqueRegisteredPastelIDs.set(pastelID.pastel_id_pubkey, pastelID);
        }
    }

    // Deduplicate completed packs
    const uniqueCompletedPacks = new Map();
    for (const pack of intermediateResults.completedPacks) {
        if (pack.pastel_id_pubkey && pack.credit_pack_registration_txid) {
            const key = `${pack.pastel_id_pubkey}-${pack.credit_pack_registration_txid}`;
            if (!uniqueCompletedPacks.has(key) ||
                pack.credit_purchase_request_confirmation_pastel_block_height >
                uniqueCompletedPacks.get(key).credit_purchase_request_confirmation_pastel_block_height) {
                uniqueCompletedPacks.set(key, pack);
            }
        }
    }

    // Deduplicate pending credit packs
    const uniquePendingCreditPacks = new Map();
    for (const pack of intermediateResults.pendingCreditPacks) {
        if (pack.pastel_id_pubkey && pack.psl_credit_usage_tracking_address) {
            const key = `${pack.pastel_id_pubkey}-${pack.requested_initial_credits_in_credit_pack}-${pack.psl_credit_usage_tracking_address}`;
            if (!uniquePendingCreditPacks.has(key)) {
                uniquePendingCreditPacks.set(key, pack);
            }
        }
    }

    // Remove completed packs from pending packs
    for (const [key, pack] of uniqueCompletedPacks) {
        const pendingKey = `${pack.pastel_id_pubkey}-${pack.requested_initial_credits_in_credit_pack}-${pack.psl_credit_usage_tracking_address}`;
        uniquePendingCreditPacks.delete(pendingKey);
    }

    // Remove PastelIDs that have completed packs from registeredPastelIDs
    for (const pack of uniqueCompletedPacks.values()) {
        uniqueRegisteredPastelIDs.delete(pack.pastel_id_pubkey);
    }

    // Update the intermediate results
    intermediateResults.registeredPastelIDs = Array.from(uniqueRegisteredPastelIDs.values());
    intermediateResults.completedPacks = Array.from(uniqueCompletedPacks.values());
    intermediateResults.pendingCreditPacks = Array.from(uniquePendingCreditPacks.values());

    // Log the deduplication results
    logger.info(`Deduplication completed. Registered PastelIDs: ${intermediateResults.registeredPastelIDs.length}, Completed packs: ${intermediateResults.completedPacks.length}, Pending packs: ${intermediateResults.pendingCreditPacks.length}`);

    // Save the deduplicated results
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

        // Create a Set of processed PastelIDs to avoid duplicates
        const processedPastelIDs = new Set();

        for (const pendingPack of intermediateResults.pendingCreditPacks) {
            try {

                if (invalidPassphrasePastelIDs.has(pendingPack.pastel_id_pubkey)) {
                    logger.info(`Skipping PastelID with invalid passphrase: ${pendingPack.pastel_id_pubkey}`);
                    continue;
                }

                processedPastelIDs.add(pendingPack.pastel_id_pubkey);

                const isValidPassphrase = await checkIfPastelIDPassphraseIsPromoPackDefault(pendingPack.pastel_id_pubkey);
                if (!isValidPassphrase) {
                    logger.info(`PastelID ${pendingPack.pastel_id_pubkey} does not have the default promo pack passphrase. Skipping.`);
                    await saveInvalidPassphrasePastelID(pendingPack.pastel_id_pubkey);
                    continue;
                }

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

async function generateOrRecoverPromotionalPacks(numberOfPacks, creditsPerPack, useRecoveredPacks = true) {
    logger.info(`Starting generation or recovery of ${numberOfPacks} promotional packs with ${creditsPerPack} credits each`);
    logger.info(`Use recovered packs: ${useRecoveredPacks}`);

    try {
        await initializeRPCConnection();
        logger.info('RPC connection initialized successfully');

        let intermediateResults = await loadIntermediateResults();
        await deduplicateIntermediateResults(intermediateResults);
        logger.info('Intermediate results loaded and deduplicated');

        let combinedPacks = [];

        if (useRecoveredPacks) {
            const { recoveredPacks } = await recoverExistingCreditPacks(creditsPerPack);
            logger.info(`Recovered ${recoveredPacks.length} existing promotional packs`);
            combinedPacks = [...recoveredPacks];
        } else if (intermediateResults.completedPacks.length > 0) {
            combinedPacks = [...intermediateResults.completedPacks];
            logger.info(`Using ${combinedPacks.length} existing completed packs`);
        }

        combinedPacks = combinedPacks.filter(pack => pack.requested_initial_credits_in_credit_pack === creditsPerPack);
        logger.info(`${combinedPacks.length} packs match the required ${creditsPerPack} credits per pack`);

        const outputDirectory = 'generated_promo_packs';
        await fs.mkdir(outputDirectory, { recursive: true });

        const { rpcport } = await getLocalRPCSettings();
        const { network, burnAddress } = getNetworkInfo(rpcport);

        const packsToGenerate = numberOfPacks - combinedPacks.length;
        logger.info(`Generating ${packsToGenerate} additional promotional packs`);

        for (let i = 0; i < packsToGenerate; i++) {
            let pastelID, passphrase;
            let isValidPassphrase = false;

            while (!isValidPassphrase) {
                const result = await createAndRegisterNewPastelID(CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS);
                if (!result || !result.success) {
                    logger.error("Failed to create new PastelID. Retrying.");
                    continue;
                }
                pastelID = result.PastelID;
                passphrase = CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS;

                isValidPassphrase = await checkIfPastelIDPassphraseIsPromoPackDefault(pastelID);
                if (!isValidPassphrase) {
                    logger.warn(`PastelID ${pastelID} does not have the default promo pack passphrase. Retrying.`);
                    await saveInvalidPassphrasePastelID(pastelID);
                } else {
                    logger.info(`Created new PastelID: ${pastelID}`);
                }
            }

            // Wait for PastelID to be registered
            logger.info(`Waiting for PastelID ${pastelID} to be registered...`);
            let isRegistered = false;
            let attempts = 0;
            const maxAttempts = 30;
            const delay = 10000;

            while (!isRegistered && attempts < maxAttempts) {
                try {
                    const registeredTickets = await listPastelIDTickets("mine");
                    isRegistered = registeredTickets.some(ticket => ticket.ticket.pastelID === pastelID);
                    if (isRegistered) {
                        logger.info(`PastelID ${pastelID} is now registered.`);
                    } else {
                        attempts++;
                        logger.info(`PastelID ${pastelID} not yet registered. Attempt ${attempts}/${maxAttempts}. Waiting ${delay / 1000} seconds...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                } catch (error) {
                    logger.error(`Error checking registration for PastelID ${pastelID}: ${error.message}`);
                    attempts++;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            if (!isRegistered) {
                logger.warn(`PastelID ${pastelID} failed to register after ${maxAttempts} attempts. Skipping this pack.`);
                continue;
            }

            const newAddress = await getNewAddress();
            try {
                const { creditPackRequest, creditPackPurchaseRequestConfirmation, creditPackPurchaseRequestConfirmationResponse } = await handleCreditPackTicketEndToEnd(
                    creditsPerPack,
                    newAddress,
                    burnAddress,
                    20000, // maximumTotalCreditPackPriceInPSL
                    150,   // maximumPerCreditPriceInPSL
                    pastelID,
                    passphrase
                );

                if (creditPackPurchaseRequestConfirmationResponse && creditPackPurchaseRequestConfirmationResponse.pastel_api_credit_pack_ticket_registration_txid) {
                    const trackingAddressPrivKey = await dumpPrivKey(creditPackRequest.credit_usage_tracking_psl_address);
                    const secureContainerPath = path.join(getPastelIDDirectory(network), pastelID);
                    const secureContainerContent = await fs.readFile(secureContainerPath, 'base64');

                    const generatedPack = {
                        pastel_id_pubkey: pastelID,
                        pastel_id_passphrase: passphrase,
                        secureContainerBase64: secureContainerContent,
                        credit_pack_registration_txid: creditPackPurchaseRequestConfirmationResponse.pastel_api_credit_pack_ticket_registration_txid,
                        credit_purchase_request_confirmation_pastel_block_height: creditPackPurchaseRequestConfirmationResponse.credit_purchase_request_confirmation_pastel_block_height,
                        requested_initial_credits_in_credit_pack: creditsPerPack,
                        psl_credit_usage_tracking_address: creditPackRequest.credit_usage_tracking_psl_address,
                        psl_credit_usage_tracking_address_private_key: trackingAddressPrivKey
                    };

                    const fileName = `promo_pack_${pastelID}.json`;
                    const filePath = path.join(outputDirectory, fileName);
                    await fs.writeFile(filePath, JSON.stringify(generatedPack, null, 2));

                    combinedPacks.push(generatedPack);
                    intermediateResults.completedPacks.push(generatedPack);
                    logger.info(`Successfully generated and saved credit pack for PastelID: ${pastelID}, TXID: ${creditPackPurchaseRequestConfirmationResponse.pastel_api_credit_pack_ticket_registration_txid}, Tracking Address: ${creditPackRequest.credit_usage_tracking_psl_address}`);

                    await ensureTrackingAddressesHaveMinimalPSLBalance([creditPackRequest.credit_usage_tracking_psl_address]);
                } else {
                    logger.error(`Failed to create credit pack for PastelID: ${pastelID}; error message: ${creditPackPurchaseRequestConfirmationResponse.errorMessage}`);
                }
            } catch (error) {
                logger.error(`Error generating credit pack for PastelID ${pastelID}: ${error.message}`);
            }

            await saveIntermediateResults(intermediateResults);
        }

        if (combinedPacks.length < numberOfPacks) {
            logger.warn(`Only ${combinedPacks.length} out of ${numberOfPacks} requested promotional packs were successfully created.`);
        } else {
            logger.info(`Successfully created all ${numberOfPacks} requested promotional packs.`);
        }

        logger.info(`Total packs: ${combinedPacks.length}`);
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