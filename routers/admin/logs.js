/**
 * /api/admin/logs — read-only log views for the panel. Behind smsAdminAuth.
 *   GET /logs/store  — customer SMS across all stores (app_messaging_logs)
 *   GET /logs/admin  — admin-panel SMS (sms_admin_logs), e.g. login OTPs
 */
const express = require('express');
const Router = express.Router();
const { connection } = require('../../startup/db');
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const { validateDatabaseIdentifier } = require('../../models/messaging');
const smsAdmin = require('../../models/sms-admin');

const db = connection.promise();

function clampLimit(v, def = 50, max = 200) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(Math.floor(n), max);
}

async function enrichNames(storeIds) {
    const names = {};
    const ids = [...new Set(storeIds)].filter(Boolean);
    if (!ids.length) return names;
    const platformDb = validateDatabaseIdentifier(process.env.PLATFORM_DATABASE);
    if (!platformDb) return names;
    try {
        const ph = ids.map(() => '?').join(',');
        const [rows] = await db.query(`SELECT store_id, name FROM \`${platformDb}\`.stores WHERE store_id IN (${ph})`, ids);
        for (const r of rows) names[r.store_id] = r.name;
    } catch (e) { /* platform DB absent — no names */ }
    return names;
}

// GET /api/admin/logs/store?store_id=&status=&event_topic=&limit=&offset=
Router.get('/store', asyncMiddleware(async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const where = [];
    const params = [];
    if (req.query.store_id) { where.push('store_id = ?'); params.push(Number(req.query.store_id)); }
    if (req.query.status === 'sent' || req.query.status === 'failed') { where.push('status = ?'); params.push(req.query.status); }
    if (req.query.event_topic) { where.push('event_topic = ?'); params.push(String(req.query.event_topic)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await db.query(/*sql*/`
        SELECT log_id, store_id, phone, message, event_topic, resource_id, status, provider_response, created_at
        FROM app_messaging_logs
        ${whereSql}
        ORDER BY created_at DESC, log_id DESC
        LIMIT ? OFFSET ?
    `, [...params, limit + 1, offset]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const names = await enrichNames(page.map(r => r.store_id));

    return res.send({
        status: 200,
        logs: page.map((r) => {
            let providerResponse = r.provider_response;
            if (typeof providerResponse === 'string') {
                try { providerResponse = JSON.parse(providerResponse); } catch { providerResponse = null; }
            }
            const senderAttempts = providerResponse?.meta?.sender_attempts;
            return {
                ...r,
                provider_response: Array.isArray(senderAttempts) ? { meta: { sender_attempts: senderAttempts } } : null,
                store_name: names[r.store_id] || null,
            };
        }),
        has_more: hasMore,
        offset,
        limit,
    });
}));

// GET /api/admin/logs/admin?limit=&offset=
Router.get('/admin', asyncMiddleware(async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await smsAdmin.listAdminLogs({ limit: limit + 1, offset });
    const hasMore = rows.length > limit;
    return res.send({ status: 200, logs: hasMore ? rows.slice(0, limit) : rows, has_more: hasMore, offset, limit });
}));

module.exports = Router;
