/**
 * Messaging Wallet — SMS credit-based system
 *
 * SMS credits are tracked locally in app_messaging_settings.sms_credits.
 * Platform wallet is only used for payment processing (top-ups).
 */
const platformBilling = require('../services/platform-billing');
const { connection } = require('../startup/db');

/**
 * Get SMS credits for a store
 */
async function getCredits(store_id) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT sms_credits FROM app_messaging_settings WHERE store_id = ?
    `, [store_id]);
    return rows[0]?.sms_credits || 0;
}

/**
 * Check if store has enough credits to send SMS
 */
async function hasCredits(store_id, count = 1) {
    const credits = await getCredits(store_id);
    return credits >= count;
}

/**
 * Deduct SMS credits locally
 */
async function deductCredit(store_id, count = 1) {
    const [result] = await connection.promise().query(/*sql*/`
        UPDATE app_messaging_settings
        SET sms_credits = sms_credits - ?
        WHERE store_id = ? AND sms_credits >= ?
    `, [count, store_id, count]);

    if (result.affectedRows === 0) {
        throw new Error('Insufficient SMS credits');
    }

    const credits = await getCredits(store_id);
    return { sms_credits: credits };
}

/**
 * Get paginated transaction history from platform
 */
async function getTransactions(store_id, { page = 1, limit = 20 } = {}) {
    return platformBilling.getWalletTransactions(store_id, { page, limit });
}

module.exports = {
    getCredits,
    hasCredits,
    deductCredit,
    getTransactions,
};
