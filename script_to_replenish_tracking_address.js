const fs = require('fs').promises;
const path = require('path');
const { initializeRPCConnection, sendToAddress, getMyPslAddressWithLargestBalance, checkPSLAddressBalance, checkPSLAddressBalanceAlternative } = require('./rpc_functions');

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

        // Get the funding address
        const fundingAddress = await getMyPslAddressWithLargestBalance();
        if (!fundingAddress) {
            throw new Error("No address with sufficient funds to send PSL.");
        }

        for (const address of uniqueAddresses) {

            //get balance of address
            const balance = await checkPSLAddressBalanceAlternative(address);
            // console.log(`Balance of ${address}: ${balance}`);

            const amountToSend = 1; // 1 PSL
            const sendResult = await sendToAddress(
                address,
                amountToSend,
                "Sending 1 PSL to tracking address"
            );

            if (sendResult.success) {
                console.log(`Sent ${amountToSend} PSL to address ${address}. TXID: ${sendResult.result}`);
            } else {
                console.error(`Failed to send PSL to address ${address}: ${sendResult.message}`);
            }
        }

        console.log('Finished sending 10 PSL to all tracking addresses.');
    } catch (error) {
        console.error('An error occurred:', error);
    }
}

main();