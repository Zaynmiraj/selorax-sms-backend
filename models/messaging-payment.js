/**
 * Messaging Payment — SMS package-based billing
 *
 * Users purchase predefined SMS packages (1000, 5000, 10000 SMS).
 * Payment goes through SeloraX Platform Billing API.
 * On payment success, SMS credits are added to the store's local balance.
 */
const platformBilling = require('../services/platform-billing');
const { connection } = require('../startup/db');

/**
 * Get all active SMS packages
 */
async function getPackages() {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_packages WHERE is_active = 1 ORDER BY sort_order
    `);
    return rows;
}

/**
 * Get a single package by ID
 */
async function getPackage(package_id) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_packages WHERE package_id = ? AND is_active = 1
    `, [package_id]);
    return rows[0] || null;
}

/**
 * Initiate a package purchase via platform billing.
 * Creates a charge and tracks the pending purchase locally.
 */
async function initiatePurchase(store_id, package_id) {
    const pkg = await getPackage(package_id);
    if (!pkg) throw Object.assign(new Error('Package not found'), { status: 404 });

    const charge = await platformBilling.createWalletTopupCharge(store_id, pkg.total_price, {
        name: `SMS Package: ${pkg.name} (${pkg.sms_count} SMS)`,
    });

    // Track the pending purchase locally
    await connection.promise().query(/*sql*/`
        INSERT INTO app_messaging_purchases (store_id, package_id, charge_id, sms_count, amount, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
    `, [store_id, package_id, charge.charge_id, pkg.sms_count, pkg.total_price]);

    return {
        charge_id: charge.charge_id,
        confirmation_url: charge.confirmation_url,
        amount: charge.amount,
        status: charge.status,
        package: pkg,
    };
}

/**
 * Check charge status. If active and not yet credited, add SMS credits.
 */
async function getChargeStatus(store_id, charge_id) {
    try {
        const charge = await platformBilling.getCharge(store_id, charge_id);
        if (!charge) return null;

        // If charge is active/completed, credit SMS if not already done
        if (charge.status === 'active' || charge.status === 'completed') {
            await creditPurchase(store_id, charge_id);
        }

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

/**
 * Credit SMS to store if the purchase hasn't been credited yet.
 * Uses atomic UPDATE guard to prevent double-crediting race condition.
 */
async function creditPurchase(store_id, charge_id) {
    // Atomically claim the purchase — only one caller can set status from pending to credited
    const [result] = await connection.promise().query(/*sql*/`
        UPDATE app_messaging_purchases
        SET status = 'credited', credited_at = NOW()
        WHERE store_id = ? AND charge_id = ? AND status = 'pending'
    `, [store_id, charge_id]);

    if (result.affectedRows === 0) return; // Already credited or not found

    // Get the sms_count for the credited purchase
    const [purchases] = await connection.promise().query(/*sql*/`
        SELECT sms_count FROM app_messaging_purchases
        WHERE store_id = ? AND charge_id = ? AND status = 'credited'
    `, [store_id, charge_id]);

    if (!purchases.length) return;

    // Add SMS credits to store settings
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_settings
        SET sms_credits = sms_credits + ?
        WHERE store_id = ?
    `, [purchases[0].sms_count, store_id]);
}

/**
 * Get purchase history for a store
 */
async function getPurchaseHistory(store_id, { page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT p.*, pkg.name as package_name
        FROM app_messaging_purchases p
        LEFT JOIN app_messaging_packages pkg ON pkg.package_id = p.package_id
        WHERE p.store_id = ?
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
    `, [store_id, limit, offset]);

    const [countRows] = await connection.promise().query(/*sql*/`
        SELECT COUNT(*) as total FROM app_messaging_purchases WHERE store_id = ?
    `, [store_id]);

    return { purchases: rows, total: countRows[0].total, page, limit };
}

module.exports = {
    getPackages,
    getPackage,
    initiatePurchase,
    getChargeStatus,
    creditPurchase,
    getPurchaseHistory,
};
