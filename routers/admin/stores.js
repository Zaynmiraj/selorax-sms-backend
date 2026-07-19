/**
 * /api/admin/stores — list stores that use the app and assign a sender ID to each.
 * Mounted behind smsAdminAuth (see routers/admin/index.js). Both roles allowed.
 *
 * The store list comes from app_messaging_settings (one row per installed store).
 * Store names are best-effort enriched from the platform DB; a lookup failure just
 * omits names and never breaks the list.
 */
const express = require('express');
const Router = express.Router();
const { connection } = require('../../startup/db');
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const { requireRole } = require('../../middlewares/smsAdminAuth');
const { validateDatabaseIdentifier } = require('../../models/messaging');
const catalog = require('../../models/sms-sender-ids');

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
    } catch (e) {
        // platform DB absent / no access — return without names.
    }
    return names;
}

// GET /api/admin/stores
Router.get('/', asyncMiddleware(async (req, res) => {
    const [rows] = await db.query(/*sql*/`
        SELECT store_id, sender_id, sms_credits, is_enabled, auto_sms_enabled
        FROM app_messaging_settings
        ORDER BY store_id ASC
    `);
    const globalDefault = await catalog.getGlobalDefault();
    const names = await enrichNames(rows.map(r => r.store_id));

    const stores = rows.map(r => ({
        store_id: r.store_id,
        name: names[r.store_id]?.name || null,
        domain: names[r.store_id]?.domain || null,
        sms_credits: Number(r.sms_credits) || 0,
        is_enabled: !!r.is_enabled,
        auto_sms_enabled: !!r.auto_sms_enabled,
        assigned_sender_id: r.sender_id || null,
        // What the send path will actually use: explicit assignment, else global default, else env.
        effective_sender_id: r.sender_id || globalDefault || process.env.SMS_API_SENDER_ID || null,
    }));

    return res.send({ status: 200, stores, global_default: globalDefault || null });
}));

// PATCH /api/admin/stores/:storeId/sender-id  { value }  (empty/null clears the assignment)
Router.patch('/:storeId/sender-id', asyncMiddleware(async (req, res) => {
    const storeId = Number(req.params.storeId);
    if (!storeId) return res.status(400).send({ message: 'Invalid store id.', status: 400 });

    const raw = req.body?.value;
    const value = raw == null ? null : String(raw).trim() || null;

    // A non-empty value must be an active catalog entry — so a store can never be
    // pointed at a sender ID Anbernet hasn't approved.
    if (value !== null && !(await catalog.isAssignable(value))) {
        return res.status(400).send({
            message: 'That sender ID is not in the active catalog. Add it first.',
            status: 400, code: 'sender_id_not_in_catalog',
        });
    }

    const [result] = await db.query(
        `UPDATE app_messaging_settings SET sender_id = ? WHERE store_id = ?`,
        [value, storeId]
    );
    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Store has not installed the app.', status: 404, code: 'store_not_installed' });
    }

    return res.send({ status: 200, store_id: storeId, assigned_sender_id: value });
}));

// PATCH /api/admin/stores/:storeId/credits  { mode:'add'|'set', amount }  (super_admin only)
// Adjusts a store's sms_credits pool. 'add' increments (amount may be negative to
// deduct, but the result is clamped at 0); 'set' assigns an absolute value.
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
