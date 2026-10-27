/**
 * /api/admin/stores — list stores that use the app and manage their SMS credits
 * and their price per SMS (custom purchases; models/sms-pricing.js).
 * Sender IDs and gateways are NOT managed here: they are set per store in the
 * SeloraX Messages platform admin (this app sends through it as a partner).
 */
const express = require('express');
const Router = express.Router();
const { connection } = require('../../startup/db');
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const { requireRole } = require('../../middlewares/smsAdminAuth');
const { validateDatabaseIdentifier } = require('../../models/messaging');
const pricing = require('../../models/sms-pricing');

const db = connection.promise();

async function enrichNames(storeIds) {
    const names = {};
    if (!storeIds.length) return names;
    const platformDb = validateDatabaseIdentifier(process.env.PLATFORM_DATABASE);
    if (!platformDb) return names;
    try {
        const placeholders = storeIds.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT store_id, name, domain FROM \`${platformDb}\`.stores WHERE store_id IN (${placeholders})`,
            storeIds
        );
        for (const r of rows) names[r.store_id] = { name: r.name, domain: r.domain };
    } catch (e) { /* platform DB absent / no access — omit names */ }
    return names;
}

function serializeStore(row, names, defaultPrice) {
    // `sms_unit_price` is undefined until migration 013 runs — same as "no own price".
    const own = row.sms_unit_price === null || row.sms_unit_price === undefined ? null : Number(row.sms_unit_price);
    return {
        store_id: row.store_id,
        name: names[row.store_id]?.name || null,
        domain: names[row.store_id]?.domain || null,
        sms_credits: Number(row.sms_credits) || 0,
        is_enabled: !!row.is_enabled,
        auto_sms_enabled: !!row.auto_sms_enabled,
        sms_unit_price: own,
        effective_unit_price: Number(pricing.resolveUnitPrice(own, defaultPrice)),
    };
}

Router.get('/', asyncMiddleware(async (req, res) => {
    // SELECT * so this keeps working before migration 013 adds sms_unit_price.
    const [rows] = await db.query(/*sql*/`
        SELECT * FROM app_messaging_settings ORDER BY store_id ASC
    `);
    const [names, defaultPrice] = await Promise.all([
        enrichNames(rows.map(r => r.store_id)),
        pricing.getDefaultUnitPrice(),
    ]);
    return res.send({
        status: 200,
        stores: rows.map(r => serializeStore(r, names, defaultPrice)),
        default_unit_price: Number(defaultPrice),
    });
}));

Router.get('/:storeId', asyncMiddleware(async (req, res) => {
    const storeId = Number(req.params.storeId);
    if (!storeId) return res.status(400).send({ message: 'Invalid store id.', status: 400 });
    const [rows] = await db.query(`SELECT * FROM app_messaging_settings WHERE store_id = ?`, [storeId]);
    if (rows.length === 0) return res.status(404).send({ message: 'Store not found.', status: 404 });

    const [names, defaultPrice] = await Promise.all([enrichNames([storeId]), pricing.getDefaultUnitPrice()]);
    const store = serializeStore(rows[0], names, defaultPrice);
    const [smsRows] = await db.query(`SELECT COUNT(*) as c FROM app_messaging_logs WHERE store_id = ? AND status = 'sent'`, [storeId]);
    store.sms_sent_total = Number(smsRows[0]?.c) || 0;
    return res.send({ status: 200, store, default_unit_price: Number(defaultPrice) });
}));

// PATCH /api/admin/stores/:storeId/sms-price { unit_price } — the store's own
// price per SMS for custom purchases; null/"" resets it to the default.
Router.patch('/:storeId/sms-price', requireRole('super_admin'), asyncMiddleware(async (req, res) => {
    const storeId = Number(req.params.storeId);
    if (!storeId) return res.status(400).send({ message: 'Invalid store id.', status: 400 });
    // Must be explicit: a body without the field must not silently reset the price.
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'unit_price')) {
        return res.status(400).send({ message: 'unit_price is required (null resets to the default).', status: 400, code: 'invalid_price' });
    }
    try {
        const { previous, value } = await pricing.setStoreUnitPrice(storeId, req.body.unit_price);
        console.log(`[SMS Admin] price change: store ${storeId} ${previous ?? 'default'} → ${value ?? 'default'} by admin ${req.admin.admin_id}`);
        const effective = await pricing.getStoreUnitPrice(storeId);
        return res.send({
            status: 200,
            store_id: storeId,
            sms_unit_price: value === null ? null : Number(value),
            effective_unit_price: Number(effective.unit_price),
        });
    } catch (e) {
        if (e.code === 'invalid_price' || e.code === 'store_not_installed') {
            return res.status(e.status).send({ message: e.message, status: e.status, code: e.code });
        }
        if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
            return res.status(503).send({ message: 'Pricing is not set up yet: database migration 013 has not been applied.', status: 503, code: 'migration_required' });
        }
        throw e;
    }
}));

Router.patch('/:storeId/credits', requireRole('super_admin'), asyncMiddleware(async (req, res) => {
    const storeId = Number(req.params.storeId);
    if (!storeId) return res.status(400).send({ message: 'Invalid store id.', status: 400 });
    const mode = req.body?.mode === 'set' ? 'set' : 'add';
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount)) {
        return res.status(400).send({ message: 'A numeric amount is required.', status: 400, code: 'invalid_amount' });
    }
    if (mode === 'set' && amount < 0) {
        return res.status(400).send({ message: 'Cannot set credits below zero.', status: 400, code: 'invalid_amount' });
    }
    const sql = mode === 'set'
        ? `UPDATE app_messaging_settings SET sms_credits = ? WHERE store_id = ?`
        : `UPDATE app_messaging_settings SET sms_credits = GREATEST(0, sms_credits + ?) WHERE store_id = ?`;
    const [result] = await db.query(sql, [Math.floor(amount), storeId]);
    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Store has not installed the app.', status: 404, code: 'store_not_installed' });
    }
    const [rows] = await db.query(`SELECT sms_credits FROM app_messaging_settings WHERE store_id = ?`, [storeId]);
    return res.send({ status: 200, store_id: storeId, sms_credits: Number(rows[0]?.sms_credits) || 0 });
}));

module.exports = Router;

