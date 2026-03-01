/**
 * Platform Billing Service — Shopify-like API calls
 *
 * All billing operations go through the SeloraX Platform API
 * using per-store OAuth access_tokens, exactly like Shopify apps
 * call the Shopify Billing API.
 *
 * Platform endpoints used:
 *   POST /api/apps/v1/billing/wallet-topup   — Create wallet top-up charge
 *   GET  /api/apps/v1/billing/charges/:id    — Get charge status
 *   GET  /api/apps/v1/billing/active         — List active charges
 *   GET  /api/apps/v1/billing/wallet         — Get wallet balance
 *   POST /api/apps/v1/billing/wallet/debit   — Debit wallet
 *   GET  /api/apps/v1/billing/wallet/transactions — Wallet history
 */
const platformApi = require('./platform-api');

// ──────────────────────────────────────────
// Charges
// ──────────────────────────────────────────

/**
 * Create a wallet top-up charge via platform billing API.
 * Returns a confirmation_url for the merchant to approve.
 */
async function createWalletTopupCharge(store_id, amount, { name, return_url } = {}) {
    const result = await platformApi.post(store_id, '/apps/v1/billing/wallet-topup', {
        amount,
        name: name || 'SMS Credits Top-up',
        return_url,
    });
    return result.data;
}

/**
 * Get charge status (for polling)
 */
async function getCharge(store_id, charge_id) {
    const result = await platformApi.get(store_id, `/apps/v1/billing/charges/${charge_id}`);
    return result.data;
}

/**
 * List active charges for the installation
 */
async function getActiveCharges(store_id) {
    const result = await platformApi.get(store_id, '/apps/v1/billing/active');
    return result.data;
}

// ──────────────────────────────────────────
// Wallet operations (via platform API)
// ──────────────────────────────────────────

/**
 * Get wallet balance from platform
 */
async function getWalletBalance(store_id) {
    const result = await platformApi.get(store_id, '/apps/v1/billing/wallet');
    return result.data;
}

/**
 * Debit wallet via platform API
 */
async function debitWallet(store_id, amount, description, metadata) {
    const result = await platformApi.post(store_id, '/apps/v1/billing/wallet/debit', {
        amount,
        description,
        metadata,
    });
    return result.data;
}

/**
 * Get wallet transaction history from platform
 */
async function getWalletTransactions(store_id, { page = 1, limit = 20 } = {}) {
    const result = await platformApi.get(store_id, `/apps/v1/billing/wallet/transactions?page=${page}&limit=${limit}`);
    return result.data;
}

module.exports = {
    createWalletTopupCharge,
    getCharge,
    getActiveCharges,
    getWalletBalance,
    debitWallet,
    getWalletTransactions,
};
