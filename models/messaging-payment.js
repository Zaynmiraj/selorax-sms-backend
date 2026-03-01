/**
 * Messaging Payment — uses platform billing API for wallet top-ups
 *
 * Creates charges via the SeloraX Platform Billing API.
 * The platform handles EPS payments, commission splits, and wallet crediting.
 */
const platformBilling = require('../services/platform-billing');

/**
 * Create a wallet top-up charge via platform billing API.
 * Returns a confirmation_url for the merchant to approve payment.
 */
async function initiateTopup(store_id, amount) {
    const charge = await platformBilling.createWalletTopupCharge(store_id, amount, {
        name: 'SMS Credits Top-up',
    });

    return {
        charge_id: charge.charge_id,
        confirmation_url: charge.confirmation_url,
        amount: charge.amount,
        status: charge.status,
    };
}

/**
 * Get charge status (for polling from frontend)
 */
async function getChargeStatus(store_id, charge_id) {
    try {
        const charge = await platformBilling.getCharge(store_id, charge_id);
        if (!charge) return null;

        return {
            charge_id: charge.charge_id,
            status: charge.status,
            amount: parseFloat(charge.amount),
            activated_at: charge.activated_at,
            created_at: charge.created_at,
        };
    } catch (err) {
        if (err.status === 404) return null;
        throw err;
    }
}

module.exports = {
    initiateTopup,
    getChargeStatus,
};
