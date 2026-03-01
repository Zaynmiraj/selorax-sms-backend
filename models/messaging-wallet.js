/**
 * Messaging Wallet — calls platform API for all wallet operations
 *
 * Like Shopify apps, the messaging app doesn't have direct DB access
 * to the platform's wallet tables. All operations go through the
 * SeloraX Platform Billing API using OAuth access_tokens.
 */
const platformBilling = require('../services/platform-billing');
const { connection } = require('../startup/db');

/**
 * Get wallet balance from platform
 */
async function getBalance(store_id) {
    const wallet = await platformBilling.getWalletBalance(store_id);
    return wallet.balance;
}

/**
 * Deduct credits from wallet via platform API
 * @param {number} store_id
 * @param {number} amount
 * @param {string} description
 * @param {number} [sms_log_id] - stored in metadata
 */
async function deduct(store_id, amount, description, sms_log_id) {
    const metadata = sms_log_id ? { sms_log_id } : null;
    const result = await platformBilling.debitWallet(store_id, amount, description, metadata);

    if (result.error) {
        throw new Error(result.error);
    }

    return { balance: result.balance };
}

/**
 * Get wallet data (balance + totals) from platform
 */
async function getWallet(store_id) {
    return platformBilling.getWalletBalance(store_id);
}

/**
 * Get paginated transaction history from platform
 */
async function getTransactions(store_id, { page = 1, limit = 20, type } = {}) {
    return platformBilling.getWalletTransactions(store_id, { page, limit });
}

/**
 * Get active pricing (from messaging app's own DB)
 */
async function getPricing() {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_pricing WHERE is_active = 1
    `);
    return rows;
}

module.exports = {
    getBalance,
    deduct,
    getWallet,
    getTransactions,
    getPricing,
};
