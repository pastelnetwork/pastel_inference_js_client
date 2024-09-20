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
        // Ensure pendingCreditPacks includes the tracking address
        results.pendingCreditPacks = results.pendingCreditPacks.map(pack => ({
            ...pack,
            trackingAddress: typeof pack.trackingAddress === 'string'
                ? { address: pack.trackingAddress }
                : pack.trackingAddress || { address: pack.creditUsageTrackingPSLAddress }
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
                const newPastelID = { pastelID: result.PastelID, passphrase };

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
        if (
            (Object.keys(pack.error || {}).length === 0 && Object.keys(pack.trackingAddress || {}).length === 0) ||
            (!pack.trackingAddress || !pack.trackingAddress.address)
        ) {
            logger.info(`Attempting to recover tracking address for PastelID: ${pack.pastelID}`);
            try {
                const inferenceClient = new PastelInferenceClient(pack.pastelID, pack.passphrase);
                const validCreditPacks = await inferenceClient.getValidCreditPackTicketsForPastelID(selected_supernode_url);

                const matchingPack = validCreditPacks.find(vp => vp.requested_initial_credits_in_credit_pack === pack.creditsPerPack);

                if (matchingPack) {
                    pack.trackingAddress = {
                        address: matchingPack.credit_usage_tracking_psl_address,
                        privateKey: await dumpPrivKey(matchingPack.credit_usage_tracking_psl_address)
                    };
                    // Remove the error field if it exists
                    delete pack.error;
                    logger.info(`Recovered tracking address ${pack.trackingAddress.address} for PastelID: ${pack.pastelID}`);
                } else {
                    logger.warn(`Could not find matching credit pack for PastelID: ${pack.pastelID}`);
                }
            } catch (error) {
                logger.error(`Error recovering tracking address for PastelID ${pack.pastelID}: ${error.message}`);
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
        uniqueRegisteredPastelIDs.set(pastelID.pastelID, pastelID);
    }
    intermediateResults.registeredPastelIDs = Array.from(uniqueRegisteredPastelIDs.values());

    // Deduplicate completed packs
    const uniqueCompletedPacks = new Map();
    for (const pack of intermediateResults.completedPacks) {
        const key = `${pack.pastelID}-${pack.creditPackTicket.txid}`;
        if (!uniqueCompletedPacks.has(key) ||
            pack.creditPackTicket.credit_purchase_request_confirmation_pastel_block_height >
            uniqueCompletedPacks.get(key).creditPackTicket.credit_purchase_request_confirmation_pastel_block_height) {
            uniqueCompletedPacks.set(key, pack);
        }
    }
    intermediateResults.completedPacks = Array.from(uniqueCompletedPacks.values());

    // Deduplicate pending credit packs
    const uniquePendingCreditPacks = new Map();
    for (const pack of intermediateResults.pendingCreditPacks) {
        const addressString = pack.trackingAddress
            ? (typeof pack.trackingAddress === 'string'
                ? pack.trackingAddress
                : pack.trackingAddress.address)
            : 'no_address';
        const key = `${pack.pastelID}-${pack.creditsPerPack}-${addressString}`;
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

async function extractAndSaveCompletedPromoPacks(intermediateResults) {
    const outputDirectory = 'generated_promo_packs';
    await fs.mkdir(outputDirectory, { recursive: true });

    const extractedPacks = [];

    for (const pack of intermediateResults.completedPacks) {
        const fileName = `promo_pack_${pack.pastelID}.json`;
        const filePath = path.join(outputDirectory, fileName);

        await fs.writeFile(filePath, JSON.stringify(pack, null, 2));

        logger.info(`Extracted promotional pack for PastelID ${pack.pastelID} to ${fileName} `);
        extractedPacks.push(pack);
    }

    intermediateResults.completedPacks = intermediateResults.completedPacks.filter(
        pack => !extractedPacks.some(extracted => extracted.pastelID === pack.pastelID)
    );

    await saveIntermediateResults(intermediateResults);

    logger.info(`Extracted and saved ${extractedPacks.length} completed promotional packs`);
    return extractedPacks;
}

async function convertPendingPacksToCompletedPacks() {
    logger.info("Starting conversion of pending credit packs to completed packs");

    let intermediateResults = await loadIntermediateResults();
    const { rpcport } = await getLocalRPCSettings();
    const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
    const pastelIDDir = getPastelIDDirectory(network);

    const convertedPacks = [];
    const failedConversions = [];

    for (const pack of intermediateResults.pendingCreditPacks) {
        if (pack.trackingAddress && pack.trackingAddress.address && pack.creditsPerPack) {
            try {
                logger.info(`Converting pending credit pack for PastelID: ${pack.pastelID}`);

                const secureContainerPath = path.join(pastelIDDir, pack.pastelID);
                let secureContainerContent;
                try {
                    secureContainerContent = await fs.readFile(secureContainerPath, 'base64');
                } catch (error) {
                    logger.warn(`Could not read secure container for PastelID: ${pack.pastelID}. Error: ${error.message}`);
                    secureContainerContent = null;
                }

                const completedPack = {
                    pastelID: pack.pastelID,
                    passphrase: pack.passphrase,
                    secureContainer: secureContainerContent,
                    creditPackTicket: {
                        credit_pack_registration_txid: pack.creditPackTicket?.credit_pack_registration_txid || "",
                        credit_purchase_request_confirmation_pastel_block_height: pack.creditPackTicket?.credit_purchase_request_confirmation_pastel_block_height || 0,
                        requesting_end_user_pastelid: pack.pastelID,
                        ticket_input_data_fully_parsed_sha3_256_hash: pack.creditPackTicket?.ticket_input_data_fully_parsed_sha3_256_hash || "",
                        txid_of_credit_purchase_burn_transaction: pack.fundingTxid || "",
                        credit_usage_tracking_psl_address: pack.trackingAddress.address,
                        psl_cost_per_credit: pack.creditPackTicket?.psl_cost_per_credit || 0,
                        requested_initial_credits_in_credit_pack: pack.creditsPerPack,
                        credit_pack_current_credit_balance: pack.creditsPerPack,
                        balance_as_of_datetime: new Date().toISOString(),
                        number_of_confirmation_transactions: 0
                    },
                    trackingAddress: pack.trackingAddress,
                    fundingTxid: pack.fundingTxid || ""
                };

                // Save the completed pack as an individual promo pack JSON file
                const fileName = `promo_pack_${pack.pastelID}.json`;
                const filePath = path.join('generated_promo_packs', fileName);
                await fs.writeFile(filePath, JSON.stringify(completedPack, null, 2));
                logger.info(`Saved completed pack to ${filePath}`);

                convertedPacks.push(completedPack);
            } catch (error) {
                logger.error(`Error converting credit pack for PastelID ${pack.pastelID}: ${error.message}`);
                failedConversions.push(pack.pastelID);
            }
        } else {
            logger.warn(`Incomplete information for PastelID: ${pack.pastelID}. Skipping.`);
            failedConversions.push(pack.pastelID);
        }
    }

    // Remove converted packs from pendingCreditPacks and add to completedPacks
    intermediateResults.pendingCreditPacks = intermediateResults.pendingCreditPacks.filter(
        pack => !convertedPacks.some(converted => converted.pastelID === pack.pastelID)
    );
    intermediateResults.completedPacks = [
        ...intermediateResults.completedPacks,
        ...convertedPacks
    ];

    // Save updated results
    await saveIntermediateResults(intermediateResults);

    logger.info(`Converted and saved ${convertedPacks.length} credit packs`);
    logger.info(`Failed to convert ${failedConversions.length} pending credit packs`);

    return { convertedPacks, failedConversions };
}

async function recoverExistingCreditPacks(creditsPerPack, maxBlockAge = 1500) {

    const result = await convertPendingPacksToCompletedPacks();
    console.log(`Converted ${result.convertedPacks.length} packs`);
    console.log(`Failed to convert ${result.failedConversions.length} packs`);

    logger.info(`Starting recovery of existing credit packs with ${creditsPerPack} credits and max block age of ${maxBlockAge} `);
    const { validMasternodeListFullDF } = await checkSupernodeList();
    const filteredSupernodes = await filterSupernodes(validMasternodeListFullDF);
    const selected_supernode_url = filteredSupernodes[0].url;
    const { rpcport } = await getLocalRPCSettings();
    const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
    const pastelIDDir = getPastelIDDirectory(network);

    let intermediateResults = await loadIntermediateResults();
    let invalidPassphrasePastelIDs = await loadInvalidPassphrasePastelIDs();

    await recoverMissingTrackingAddresses();
    await extractAndSaveCompletedPromoPacks(intermediateResults);
    await deduplicateIntermediateResults(intermediateResults);

    const pastelIDFiles = await fs.readdir(pastelIDDir);
    const pastelIDsToCheck = pastelIDFiles
        .filter(file => file.length === 86 &&
            !invalidPassphrasePastelIDs.has(file) &&
            !intermediateResults.registeredPastelIDs.some(rp => rp.pastelID === file))
        .map(file => ({
            file,
            ctime: fs.statSync(path.join(pastelIDDir, file)).ctime
        }));

    pastelIDsToCheck.sort((a, b) => b.ctime - a.ctime);

    const currentBlockHeight = await getCurrentPastelBlockHeight();
    const newlyRecoveredPacks = [];
    const newlyRecoveredPastelIDs = [];

    for (const { file: pastelID } of pastelIDsToCheck) {
        try {
            const testMessage = "Test message for PastelID verification";
            await signMessageWithPastelID(pastelID, testMessage, CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS);

            const inferenceClient = new PastelInferenceClient(pastelID, CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS);
            const validCreditPacks = await inferenceClient.getValidCreditPackTicketsForPastelID(selected_supernode_url);

            if (validCreditPacks.length === 0) {
                newlyRecoveredPastelIDs.push({
                    pastelID,
                    passphrase: CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS
                });
                logger.info(`Recovered PastelID without credit pack: ${pastelID} `);
            } else {
                for (const pack of validCreditPacks) {
                    if (pack.requested_initial_credits_in_credit_pack === creditsPerPack &&
                        currentBlockHeight - pack.credit_purchase_request_confirmation_pastel_block_height <= maxBlockAge &&
                        !intermediateResults.completedPacks.some(cp => cp.pastelID === pastelID && cp.creditPackTicket.txid === pack.txid)) {

                        const trackingAddressPrivKey = await dumpPrivKey(pack.credit_usage_tracking_psl_address);
                        const secureContainerPath = path.join(pastelIDDir, pastelID);
                        const secureContainerContent = await fs.readFile(secureContainerPath, 'base64');

                        const recoveredPack = {
                            pastelID,
                            passphrase: CONFIG.PASSPHRASE_FOR_PROMO_PACK_CREDIT_PACKS,
                            secureContainer: secureContainerContent,
                            creditPackTicket: pack,
                            trackingAddress: {
                                address: pack.credit_usage_tracking_psl_address,
                                privateKey: trackingAddressPrivKey
                            },
                            fundingTxid: pack.txid_of_credit_purchase_burn_transaction
                        };

                        newlyRecoveredPacks.push(recoveredPack);
                        logger.info(`Recovered credit pack for PastelID: ${pastelID}, TXID: ${pack.txid_of_credit_purchase_burn_transaction}, Tracking Address: ${pack.credit_usage_tracking_psl_address} `);
                    }
                }
            }
        } catch (error) {
            logger.debug(`PastelID ${pastelID} skipped: Unable to sign with default passphrase or error in recovery: ${error.message} `);
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

    // Save updated results
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
            ...recoveredPastelIDs.map(id => ({ pastelID: id.pastelID, passphrase: id.passphrase }))
        ];

        const availablePastelIDs = [
            ...recoveredPastelIDs,
            ...intermediateResults.registeredPastelIDs.filter(id =>
                !intermediateResults.completedPacks.some(pack => pack.pastelID === id.pastelID)
            )
        ];

        let combinedPacks = [...recoveredPacks];

        if (combinedPacks.length < numberOfPacks) {
            const packsToGenerate = numberOfPacks - combinedPacks.length;
            logger.info(`Generating ${packsToGenerate} additional promotional packs`);

            const { rpcport } = await getLocalRPCSettings();
            const { network, burnAddress } = getNetworkInfo(rpcport);

            for (let i = 0; i < packsToGenerate; i++) {
                let pastelID, passphrase;
                if (availablePastelIDs.length > 0) {
                    ({ pastelID, passphrase } = availablePastelIDs.pop());
                    logger.info(`Using existing PastelID: ${pastelID} `);
                } else {
                    const newPastelIDs = await createPastelIDs(1);
                    ({ pastelID, passphrase } = newPastelIDs[0]);
                    intermediateResults.registeredPastelIDs.push({ pastelID, passphrase });
                    logger.info(`Created new PastelID: ${pastelID} `);
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
                        combinedPacks.push(generatedPack);
                        intermediateResults.completedPacks.push(generatedPack);
                        logger.info(`Generated credit pack for PastelID: ${pastelID}, TXID: ${pack.txid}, Tracking Address: ${pack.creditUsageTrackingPSLAddress} `);
                    } else {
                        logger.error(`Failed to create credit pack for PastelID: ${pastelID} `);
                        // Add to pending credit packs with tracking address
                        intermediateResults.pendingCreditPacks.push({
                            pastelID,
                            passphrase,
                            creditsPerPack,
                            trackingAddress: newAddress // This is the address we generated earlier
                        });
                    }
                } catch (error) {
                    logger.error(`Error generating credit pack for PastelID ${pastelID}: ${error.message} `);
                }

                // Save intermediate results after each pack generation
                await saveIntermediateResults(intermediateResults);
            }
        } else {
            logger.info(`Sufficient packs recovered.Using ${numberOfPacks} out of ${combinedPacks.length} available packs.`);
            combinedPacks = combinedPacks.slice(0, numberOfPacks);
        }

        logger.info(`Total packs: ${combinedPacks.length} (${recoveredPacks.length} recovered, ${combinedPacks.length - recoveredPacks.length} generated)`);
        await recoverMissingTrackingAddresses();
        await extractAndSaveCompletedPromoPacks(intermediateResults);
        await deduplicateIntermediateResults(intermediateResults);
        logger.info('Final deduplication of intermediate results completed');
        return combinedPacks;
    } catch (error) {
        logger.error(`Error in generateOrRecoverPromotionalPacks: ${error.message} `);
        throw error;
    }
}


module.exports = {
    generateOrRecoverPromotionalPacks,
    recoverExistingCreditPacks
};                            