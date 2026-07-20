/**
 * /api/admin/stores — list stores that use the app and assign sender IDs.
 * Global sender IDs are an ordered fallback pool, not a single default.
 */
const express = require('express');
const Router = express.Router();
const { connection } = require('../../startup/db');
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const { requireRole } = require('../../middlewares/smsAdminAuth');
const { validateDatabaseIdentifier } = require('../../models/messaging');
const catalog = require('../../models/sms-sender-ids');
const { buildSenderAttemptOrder } = require('../../services/sender-fallback');

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

function globalPayload(globalSenderIds) {
    return globalSenderIds.map(({ value, global_priority }) => ({ value, global_priority }));
}

function serializeStore(row, names, globalSenderIds) {
    const senderAttemptOrder = buildSenderAttemptOrder({
        assignedSenderId: row.sender_id,
        globalSenderIds,
        envSenderId: process.env.SMS_API_SENDER_ID,
    });
    return {
        store_id: row.store_id,
        name: names[row.store_id]?.name || null,
        domain: names[row.store_id]?.domain || null,
        sms_credits: Number(row.sms_credits) || 0,
        is_enabled: !!row.is_enabled,
        auto_sms_enabled: !!row.auto_sms_enabled,
        assigned_sender_id: row.sender_id || null,
        sender_attempt_order: senderAttemptOrder,
        effective_sender_id: senderAttemptOrder[0] || null,
    };
}

Router.get('/', asyncMiddleware(async (req, res) => {
    const [rows] = await db.query(/*sql*/`
        SELECT store_id, sender_id, sms_credits, is_enabled, auto_sms_enabled
        FROM app_messaging_settings ORDER BY store_id ASC
    `);
    const globalSenderIds = await catalog.getActiveGlobalSenderIds();
    const names = await enrichNames(rows.map(r => r.store_id));
    return res.send({
        status: 200,
        stores: rows.map(r => serializeStore(r, names, globalSenderIds)),
        global_sender_ids: globalPayload(globalSenderIds),
    });
}));

Router.get('/:storeId', asyncMiddleware(async (req, res) => {
    const storeId = Number(req.params.storeId);
    if (!storeId) return res.status(400).send({ message: 'Invalid store id.', status: 400 });
    const [rows] = await db.query(`
        SELECT store_id, sender_id, sms_credits, is_enabled, auto_sms_enabled
        FROM app_messaging_settings WHERE store_id = ?
    `, [storeId]);
    if (rows.length === 0) return res.status(404).send({ message: 'Store not found.', status: 404 });

    const globalSenderIds = await catalog.getActiveGlobalSenderIds();
    const names = await enrichNames([storeId]);
    const store = serializeStore(rows[0], names, globalSenderIds);
    const [smsRows] = await db.query(`SELECT COUNT(*) as c FROM app_messaging_logs WHERE store_id = ? AND status = 'sent'`, [storeId]);
    store.sms_sent_total = Number(smsRows[0]?.c) || 0;
    return res.send({ status: 200, store, global_sender_ids: globalPayload(globalSenderIds) });
}));

// PATCH /api/admin/stores/:storeId/sender-id { value }; empty/null clears assignment.
Router.patch('/:storeId/sender-id', asyncMiddleware(async (req, res) => {
    const storeId = Number(req.params.storeId);
    if (!storeId) return res.status(400).send({ message: 'Invalid store id.', status: 400 });
    const raw = req.body?.value;
    const value = raw == null ? null : String(raw).trim() || null;
    if (value !== null && !(await catalog.isAssignable(value))) {
        return res.status(400).send({
            message: 'That sender ID is not in the active catalog. Add it first.',
            status: 400, code: 'sender_id_not_in_catalog',
        });
    }
    const [result] = await db.query(`UPDATE app_messaging_settings SET sender_id = ? WHERE store_id = ?`, [value, storeId]);
    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Store has not installed the app.', status: 404, code: 'store_not_installed' });
    }
    return res.send({ status: 200, store_id: storeId, assigned_sender_id: value });
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
