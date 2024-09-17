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
    getTransactionDetails,
    checkSupernodeList,
    getNewAddress,
    sendToAddress
} = require('./rpc_functions');
const { filterSupernodes } = require('./utility_functions');
const { handleCreditPackTicketEndToEnd, estimateCreditPackCostEndToEnd } = require('./end_to_end_functions');
const { logger, safeStringify } = require('./logger');
const axios = require('axios');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIRMATION_BLOCKS = 1;
const MAX_WAIT_TIME = 900000; // 15 minutes
const CONCURRENT_CREDIT_PACK_CREATIONS = 3;
const INTERMEDIATE_PROMO_PACK_RESULTS_FILE = 'intermediate_promo_pack_results.json';
const TIMEOUT_PERIOD = 5000; // 5 seconds timeout
const MINIMUM_RESPONSE_SIZE = 1024; // 1 KB minimum response size

async function checkSupernodeResponsiveness(supernodeURL) {
    const startTime = Date.now();
    try {
        const response = await axios.get(`${supernodeURL}/get_inference_model_menu`, {
            timeout: TIMEOUT_PERIOD,
        });
        const responseTime = Date.now() - startTime;

        if (response.status === 200 && JSON.stringify(response.data).length >= MINIMUM_RESPONSE_SIZE) {
            return { url: supernodeURL, responseTime };
        }
    } catch (error) {
        logger.debug(`Error checking supernode ${supernodeURL}: ${error.message}`);
    }
    return null;
}

async function selectResponsiveSupernodes(count = 12) {
    try {
        const { validMasternodeListFullDF } = await checkSupernodeList();
        const filteredSupernodes = await filterSupernodes(validMasternodeListFullDF);

        const checkPromises = filteredSupernodes.map(supernode =>
            checkSupernodeResponsiveness(supernode.url)
        );

        const results = await Promise.allSettled(checkPromises);

        const validResponses = results
            .filter(res => res.status === 'fulfilled' && res.value !== null)
            .map(res => res.value);

        const sortedResponses = validResponses.sort((a, b) => a.responseTime - b.responseTime);

        return sortedResponses.slice(0, count);
    } catch (error) {
        logger.error(`Failed to select responsive supernodes: ${error.message}`);
        throw error;
    }
}

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
    logger.info(`Starting confirmation wait for ${checkFunction.name} with args: ${safeStringify(args)}`);
    while (Date.now() - startTime < MAX_WAIT_TIME) {
        if (await checkFunction(...args)) {
            logger.info(`Confirmation successful for ${checkFunction.name}`);
            return true;
        }
        logger.debug(`Waiting for confirmation of ${checkFunction.name}. Elapsed time: ${(Date.now() - startTime) / 1000} seconds`);
        await new Promise(resolve => setTimeout(resolve, 10000));
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
        const passphrase = `testpass`;
        logger.info(`Attempting to create PastelID ${i + 1}/${count} with passphrase: ${passphrase}`);

        try {
            logger.debug(`Initiating PastelID creation request for attempt ${i + 1}/${count}`);

            const result = await createAndRegisterNewPastelID(passphrase);

            if (result && result.success) {
                const newPastelID = { pastelID: result.PastelID, passphrase };
                pastelIDs.push(newPastelID);
                intermediateResults.registeredPastelIDs.push(newPastelID);
                saveIntermediateResults(intermediateResults);
                logger.info(`Successfully created and registered PastelID ${i + 1}/${count}: ${result.PastelID}`);
                logger.debug(`Updated intermediate results with new PastelID: ${result.PastelID}`);
            } else {
                logger.error(`Failed to create PastelID ${i + 1}/${count}: ${result ? result.message : 'Unknown error'}`);
                logger.debug(`Detailed error for PastelID creation attempt ${i + 1}/${count}: ${JSON.stringify(result)}`);
            }

            await sleep(1000);
        } catch (error) {
            logger.error(`Unexpected error during PastelID creation attempt ${i + 1}/${count}: ${error.message}`);
            logger.debug(`Stack trace: ${error.stack}`);
        }

        logger.info(`Progress: ${pastelIDs.length}/${count} PastelIDs created`);
    }

    logger.info(`Completed creation of PastelIDs. Total successful: ${pastelIDs.length}/${count}`);
    logger.debug(`Final PastelID list: ${JSON.stringify(pastelIDs.map(p => p.pastelID))}`);
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
    const amountOfPSLForTrackingTransactions = 10.0; // Additional PSL for future tracking transactions
    const creditPriceCushionPercentage = 0.05; // 5% cushion/flexibility on per credit price

    logger.info(`Starting credit pack creation for PastelID: ${pastelID} with ${creditsPerPack} credits`);

    try {
        // Estimate the cost of the credit pack
        const estimatedCost = await estimateCreditPackCostEndToEnd(creditsPerPack, creditPriceCushionPercentage);
        logger.info(`Estimated cost for credit pack: ${estimatedCost} PSL`);

        // Calculate total amount to fund (estimated cost + tracking transactions amount)
        const amountToFund = estimatedCost + amountOfPSLForTrackingTransactions;

        // Create a new PSL address for tracking
        const creditUsageTrackingPSLAddress = await getNewAddress();
        logger.info(`Created new PSL tracking address: ${creditUsageTrackingPSLAddress}`);

        // Fund the new address
        const fundingResult = await sendToAddress(creditUsageTrackingPSLAddress, amountToFund, "Funding for credit pack tracking");
        if (!fundingResult.success) {
            throw new Error(`Failed to fund tracking address: ${fundingResult.message}`);
        }
        logger.info(`Funded tracking address with ${amountToFund} PSL. TXID: ${fundingResult.result}`);

        const responsiveSupernodes = await selectResponsiveSupernodes(5); // Select top 5 responsive supernodes

        for (const supernode of responsiveSupernodes) {
            try {
                const creditPackResult = await handleCreditPackTicketEndToEnd(
                    creditsPerPack,
                    creditUsageTrackingPSLAddress,
                    'PtpasteLBurnAddressXXXXXXXXXXbJ5ndd',
                    maximumTotalCreditPackPriceInPSL,
                    maximumPerCreditPriceInPSL,
                    supernode.url
                );

                if (!creditPackResult || !creditPackResult.txid) {
                    throw new Error('Failed to create credit pack ticket');
                }

                logger.info(`Credit pack ticket created. TXID: ${creditPackResult.txid}`);

                await waitForConfirmation(isCreditPackConfirmed, creditPackResult.txid);
                logger.info(`Credit pack ticket ${creditPackResult.txid} confirmed in blockchain`);

                const trackingAddressPrivateKey = await dumpPrivKey(creditUsageTrackingPSLAddress);
                logger.info(`Private key retrieved successfully for tracking address: ${creditUsageTrackingPSLAddress}`);

                const { rpcport } = await getLocalRPCSettings();
                const network = rpcport === '9932' ? 'mainnet' : rpcport === '19932' ? 'testnet' : 'devnet';
                logger.debug(`Determined network: ${network}`);
                const pastelIDDir = getPastelIDDirectory(network);
                const secureContainerPath = path.join(pastelIDDir, pastelID);
                logger.debug(`Reading secure container file from: ${secureContainerPath}`);
                const secureContainerContent = fs.readFileSync(secureContainerPath, 'base64');
                logger.info(`Secure container file retrieved successfully for PastelID: ${pastelID}`);

                logger.info(`Completed credit pack creation for PastelID: ${pastelID}`);
                return {
                    pastelID,
                    passphrase,
                    secureContainer: secureContainerContent,
                    creditPackTicket: creditPackResult,
                    trackingAddress: {
                        address: creditUsageTrackingPSLAddress,
                        privateKey: trackingAddressPrivateKey
                    },
                    fundingTxid: creditPackResult.txid
                };
            } catch (error) {
                logger.error(`Error creating credit pack with supernode ${supernode.url}: ${error.message}`);
            }
        }
        throw new Error(`Failed to create credit pack for PastelID: ${pastelID} after trying all responsive supernodes`);
    } catch (error) {
        logger.error(`Failed to create credit pack for PastelID: ${pastelID}: ${error.message}`);
        throw error;
    }
}

async function createPromotionalPacks(count, creditsPerPack) {
    logger.info(`Starting generation of ${count} promotional packs with ${creditsPerPack} credits each`);

    await initializeRPCConnection();
    logger.info('RPC connection initialized successfully');

    const intermediateResults = loadIntermediateResults();
    let pastelIDs = intermediateResults.registeredPastelIDs;
    if (pastelIDs.length < count) {
        pastelIDs = await createPastelIDs(count);
    }

    logger.info(`Created ${pastelIDs.length} PastelIDs successfully`);

    logger.info('Waiting for all PastelID registrations to be confirmed...');
    await waitForPastelIDRegistrations(pastelIDs);

    logger.info(`Starting credit pack creation for ${pastelIDs.length} PastelIDs`);
    const promotionalPacks = [...intermediateResults.completedPacks];
    const pendingCreditPacks = [...intermediateResults.pendingCreditPacks];

    // First, try to complete any pending credit packs
    for (const pendingPack of pendingCreditPacks) {
        try {
            const completedPack = await createCreditPack(pendingPack.pastelID, pendingPack.passphrase, creditsPerPack);
            promotionalPacks.push(completedPack);
            intermediateResults.completedPacks.push(completedPack);
            intermediateResults.pendingCreditPacks = intermediateResults.pendingCreditPacks.filter(
                pack => pack.pastelID !== pendingPack.pastelID
            );
            saveIntermediateResults(intermediateResults);
        } catch (error) {
            logger.error(`Failed to complete pending credit pack for PastelID ${pendingPack.pastelID}: ${error.message}`);
        }
    }

    // Then, create new credit packs for remaining PastelIDs
    const remainingPastelIDs = pastelIDs.filter(
        pastelID => !promotionalPacks.some(pack => pack.pastelID === pastelID.pastelID) &&
            !pendingCreditPacks.some(pack => pack.pastelID === pastelID.pastelID)
    );

    for (let i = 0; i < remainingPastelIDs.length; i += CONCURRENT_CREDIT_PACK_CREATIONS) {
        const batch = remainingPastelIDs.slice(i, i + CONCURRENT_CREDIT_PACK_CREATIONS);
        logger.info(`Processing batch ${Math.floor(i / CONCURRENT_CREDIT_PACK_CREATIONS) + 1}: Creating ${batch.length} credit packs concurrently`);
        const batchPromises = batch.map(({ pastelID, passphrase }) =>
            createCreditPack(pastelID, passphrase, creditsPerPack)
        );
        const batchResults = await Promise.allSettled(batchPromises);
        batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                promotionalPacks.push(result.value);
                intermediateResults.completedPacks.push(result.value);
                intermediateResults.registeredPastelIDs = intermediateResults.registeredPastelIDs.filter(
                    id => id.pastelID !== result.value.pastelID
                );
            } else {
                logger.error(`Failed to create credit pack for PastelID ${batch[index].pastelID}: ${result.reason}`);
                intermediateResults.pendingCreditPacks.push({
                    ...batch[index],
                    error: result.reason
                });
            }
            saveIntermediateResults(intermediateResults);
        });
        logger.info(`Completed batch ${Math.floor(i / CONCURRENT_CREDIT_PACK_CREATIONS) + 1}. Total packs created: ${promotionalPacks.length}`);
    }

    logger.info(`Completed creation of all ${promotionalPacks.length} promotional packs`);
    return promotionalPacks;
}

async function generatePromotionalPacks(numberOfPacks, creditsPerPack) {
    logger.info(`Starting generation of ${numberOfPacks} promotional packs with ${creditsPerPack} credits each`);

    const folderPath = path.join(__dirname, 'generated_promo_packs');
    if (!fs.existsSync(folderPath)) {
        logger.info(`Creating folder for promotional packs: ${folderPath}`);
        fs.mkdirSync(folderPath);
    }

    logger.info('Initiating creation of promotional packs...');
    const promotionalPacks = await createPromotionalPacks(numberOfPacks, creditsPerPack);

    // Prepare the final promotional pack data
    const finalPromotionalPacks = promotionalPacks.map(pack => ({
        pastelID: pack.pastelID,
        passphrase: pack.passphrase,
        secureContainer: pack.secureContainer,
        creditPackTicket: pack.creditPackTicket,
        trackingAddress: pack.trackingAddress,
        fundingTxid: pack.fundingTxid
    }));

    const serializedPacks = JSON.stringify(finalPromotionalPacks, null, 2);
    const fileName = path.join(folderPath, `promotional_packs_${Date.now()}.json`);
    logger.info(`Saving ${finalPromotionalPacks.length} promotional packs to file: ${fileName}`);
    fs.writeFileSync(fileName, serializedPacks);
    logger.info(`Successfully saved promotional packs to file`);

    // Update intermediate results to remove completed packs
    const intermediateResults = loadIntermediateResults();
    intermediateResults.completedPacks = intermediateResults.completedPacks.filter(
        pack => !finalPromotionalPacks.some(p => p.pastelID === pack.pastelID)
    );
    saveIntermediateResults(intermediateResults);

    logger.info(`Generation complete. ${finalPromotionalPacks.length} promotional packs created and saved to ${fileName}`);
    return { fileName, packCount: finalPromotionalPacks.length };
}

module.exports = { generatePromotionalPacks };