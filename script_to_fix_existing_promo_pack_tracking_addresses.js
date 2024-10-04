const fs = require('fs').promises;
const path = require('path');
const { initializeRPCConnection } = require('./rpc_functions');

async function main() {
    try {
        // Initialize RPC connection
        await initializeRPCConnection();

        const directoryPath = 'generated_promo_packs/';
        const files = await fs.readdir(directoryPath);

        const trackingAddresses = [];

        for (const file of files) {
            if (path.extname(file) === '.json') {
                const filePath = path.join(directoryPath, file);
                const fileContent = await fs.readFile(filePath, 'utf8');
                const jsonData = JSON.parse(fileContent);

                if (jsonData.psl_credit_usage_tracking_address) {
                    trackingAddresses.push(jsonData.psl_credit_usage_tracking_address);
                }
            }
        }

        console.log(`Found ${trackingAddresses.length} tracking addresses.`);

        // Remove duplicates
        const uniqueAddresses = [...new Set(trackingAddresses)];
        console.log(`Unique addresses: ${uniqueAddresses.length}`);

        console.log('Finished ensuring minimal balances for all tracking addresses.');
    } catch (error) {
        console.error('An error occurred:', error);
    }
}

main();