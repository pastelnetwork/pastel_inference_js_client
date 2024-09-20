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

const { filterSupernodes } = require('./utility_functions');
const { PastelInferenceClient } = require('./pastel_inference_client');
const { handleCreditPackTicketEndToEnd, estimateCreditPackCostEndToEnd } = require('./end_to_end_functions');
const { logger } = require('./logger');

const CONFIG = {
    MAX_WAIT_TIME: 900000,
    CONCURRENT_CREDIT_PACK_CREATIONS: 3,
    INTERMEDIATE_PROMO_PACK_RESULTS_FILE: 'intermediate_promo_pack_results.json',
    INVALID_PASSPHRASE_PASTELIDS_FILE: 'invalid_passphrase_pastelids.json',
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

async function loadInvalidPassphrasePastelIDs() {
    try {
        const data = await fs.readFile(CONFIG.INVALID_PASSPHRASE_PASTELIDS_FILE, 'utf8');
        return new Set(JSON.parse(data));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error(`Error loading invalid passphrase PastelIDs: ${error.message}`);
        }
        return new Set();
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

async function saveInvalidPassphrasePastelID(pastelID) {
    try {
        const invalidPastelIDs = await loadInvalidPassphrasePastelIDs();
        invalidPastelIDs.add(pastelID);
        await fs.writeFile(CONFIG.INVALID_PASSPHRASE_PASTELIDS_FILE, JSON.stringify(Array.from(invalidPastelIDs)));
    } catch (error) {
        logger.error(`Error saving invalid passphrase PastelID: ${error.message}`);
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

async function recoverMissingTrackingAddresses() {
    logger.info("Starting recovery of missing tracking addresses for pending credit packs...");
    const intermediateResults = await loadIntermediateResults();
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const filteredSupernodes = await filterSupernodes(validMasternodeListFullDF);
    const selected_supernode_url = filteredSupernodes[0].url;

    for (let i = 0; i < intermediateResults.pendingCreditPacks.length; i++) {
        const pack = intermediateResults.pendingCreditPacks[i];
        if (!pack.psl_credit_usage_tracking_address || !pack.psl_credit_usage_tracking_address_private_key) {
            logger.info(`Attempting to recover tracking address for PastelID: ${pack.pastel_id_pubkey}`);
            try {
                const inferenceClient = new PastelInferenceClient(pack.pastel_id_pubkey, pack.pastel_id_passphrase);
                const validCreditPacks = await inferenceClient.getValidCreditPackTicketsForPastelID(selected_supernode_url);

                const matchingPack = validCreditPacks.find(vp => vp.requested_initial_credits_in_credit_pack === pack.requested_initial_credits_in_credit_pack);

                if (matchingPack) {
                    pack.psl_credit_usage_tracking_address = matchingPack.credit_usage_tracking_psl_address;
                    pack.psl_credit_usage_tracking_address_private_key = await dumpPrivKey(matchingPack.credit_usage_tracking_psl_address);
                    delete pack.error;
                    logger.info(`Recovered tracking address ${pack.psl_credit_usage_tracking_address} for PastelID: ${pack.pastel_id_pubkey}`);
                } else {
                    logger.warn(`Could not find matching credit pack for PastelID: ${pack.pastel_id_pubkey}`);
                }
            } catch (error) {
                logger.error(`Error recovering tracking address for PastelID ${pack.pastel_id_pubkey}: ${error.message}`);
                pack.error = { message: error.message };
            }
        }
    }

    await saveIntermediateResults(intermediateResults);
    logger.info("Completed recovery of missing tracking addresses for pending credit packs.");
}

async function deduplicateIntermediateResults(intermediateResults) {
    // Deduplicate registered PastelIDs
    const uniqueRegisteredPastelIDs = new Map();
    for (const pastelID of intermediateResults.registeredPastelIDs) {
        uniqueRegisteredPastelIDs.set(pastelID.pastel_id_pubkey, pastelID);
    }
    intermediateResults.registeredPastelIDs = Array.from(uniqueRegisteredPastelIDs.values());

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
    intermediateResults.completedPacks = Array.from(uniqueCompletedPacks.values());

    // Deduplicate pending credit packs
    const uniquePendingCreditPacks = new Map();
    for (const pack of intermediateResults.pendingCreditPacks) {
        const key = `${pack.pastel_id_pubkey}-${pack.requested_initial_credits_in_credit_pack}-${pack.psl_credit_usage_tracking_address}`;
        if (!uniquePendingCreditPacks.has(key)) {
            uniquePendingCreditPacks.set(key, pack);
        }
    }
    intermediateResults.pendingCreditPacks = Array.from(uniquePendingCreditPacks.values());

    await saveIntermediateResults(intermediateResults);

    logger.info('Deduplicated intermediate results:');
    logger.info(`- Registered PastelIDs: ${intermediateResults.registeredPastelIDs.length}`);
    logger.info(`- Completed Packs: ${intermediateResults.completedPacks.length}`);
    logger.info(`- Pending Credit Packs: ${intermediateResults.pendingCreditPacks.length}`);
}

async function recoverExistingCreditPacks(creditsPerPack, maxBlockAge = 1500) {
    logger.info(`Starting recovery of existing credit packs with ${creditsPerPack} credits and max block age of ${maxBlockAge}`);
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const filteredSupernodes = await filterSupernodes(validMasternodeListFullDF);
    const selected_supernode_url = filteredSupernodes[0].url;
    const { rpcport } = await getLocalRPCSettings();
    const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
    const pastelIDDir = getPastelIDDirectory(network);

    let intermediateResults = await loadIntermediateResults();
    let invalidPassphrasePastelIDs = await loadInvalidPassphrasePastelIDs();

    const pastelIDFiles = await fs.readdir(pastelIDDir);
    const pastelIDsToCheck = pastelIDFiles.filter(file => file.length === 86 && !invalidPassphrasePastelIDs.has(file));

    const currentBlockHeight = await getCurrentPastelBlockHeight();
    const newlyRecoveredPacks = [];
    const newlyRecoveredPastelIDs = [];

    const outputDirectory = 'generated_promo_packs';
    await fs.mkdir(outputDirectory, { recursive: true });

    for (const pastelID of pastelIDsToCheck) {
        try {
            const inferenceClient = new PastelInferenceClient(pastelID, CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS);
            const validCreditPacks = await inferenceClient.getValidCreditPackTicketsForPastelID(selected_supernode_url);

            if (validCreditPacks.length === 0) {
                newlyRecoveredPastelIDs.push({
                    pastel_id_pubkey: pastelID,
                    pastel_id_passphrase: CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS
                });
                logger.info(`Recovered PastelID without credit pack: ${pastelID}`);
            } else {
                for (const pack of validCreditPacks) {
                    if (pack.requested_initial_credits_in_credit_pack === creditsPerPack &&
                        currentBlockHeight - pack.credit_purchase_request_confirmation_pastel_block_height <= maxBlockAge) {
                        const trackingAddressPrivKey = await dumpPrivKey(pack.credit_usage_tracking_psl_address);
                        const secureContainerPath = path.join(pastelIDDir, pastelID);
                        const secureContainerContent = await fs.readFile(secureContainerPath, 'base64');

                        const recoveredPack = {
                            pastel_id_pubkey: pastelID,
                            pastel_id_passphrase: CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS,
                            secureContainerBase64: secureContainerContent,
                            credit_pack_registration_txid: pack.credit_pack_registration_txid,
                            credit_purchase_request_confirmation_pastel_block_height: pack.credit_purchase_request_confirmation_pastel_block_height,
                            requested_initial_credits_in_credit_pack: pack.requested_initial_credits_in_credit_pack,
                            psl_credit_usage_tracking_address: pack.credit_usage_tracking_psl_address,
                            psl_credit_usage_tracking_address_private_key: trackingAddressPrivKey
                        };

                        // Save individual JSON file for the recovered pack
                        const fileName = `promo_pack_${pastelID}.json`;
                        const filePath = path.join(outputDirectory, fileName);
                        await fs.writeFile(filePath, JSON.stringify(recoveredPack, null, 2));

                        newlyRecoveredPacks.push(recoveredPack);
                        logger.info(`Recovered and saved credit pack for PastelID: ${pastelID}, TXID: ${pack.credit_pack_registration_txid}, Tracking Address: ${pack.credit_usage_tracking_psl_address}`);
                    }
                }
            }
        } catch (error) {
            logger.debug(`PastelID ${pastelID} skipped: ${error.message}`);
            await saveInvalidPassphrasePastelID(pastelID);
        }
    }

    // Update intermediate results
    intermediateResults.registeredPastelIDs = [
        ...intermediateResults.registeredPastelIDs,
        ...newlyRecoveredPastelIDs
    ];
    intermediateResults.completedPacks = [
        ...intermediateResults.completedPacks,
        ...newlyRecoveredPacks
    ];

    // Save updated intermediate results
    await saveIntermediateResults(intermediateResults);

    logger.info(`Recovered ${newlyRecoveredPacks.length} new credit packs and ${newlyRecoveredPastelIDs.length} new PastelIDs without credit packs`);
    return { recoveredPacks: newlyRecoveredPacks, recoveredPastelIDs: newlyRecoveredPastelIDs };
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

                    if (pack && pack.txid) {
                        const trackingAddressPrivKey = await dumpPrivKey(pack.creditUsageTrackingPSLAddress);
                        const secureContainerPath = path.join(getPastelIDDirectory(network), pastelID);
                        const secureContainerContent = await fs.readFile(secureContainerPath, 'base64');

                        const generatedPack = {
                            pastel_id_pubkey: pastelID,
                            pastel_id_passphrase: passphrase,
                            secureContainerBase64: secureContainerContent,
                            credit_pack_registration_txid: pack.txid,
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
                        logger.info(`Generated and saved credit pack for PastelID: ${pastelID}, TXID: ${pack.txid}, Tracking Address: ${pack.creditUsageTrackingPSLAddress}`);
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
                }

                await saveIntermediateResults(intermediateResults);
            }
        } else {
            logger.info(`Sufficient packs recovered. Using ${numberOfPacks} out of ${combinedPacks.length} available packs.`);
            combinedPacks = combinedPacks.slice(0, numberOfPacks);
        }

        logger.info(`Total packs: ${combinedPacks.length} (${recoveredPacks.length} recovered, ${combinedPacks.length - recoveredPacks.length} generated)`);
        await recoverMissingTrackingAddresses();
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