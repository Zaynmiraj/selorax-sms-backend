/**
 * /api/admin/sender-ids — the global sender-ID catalog. Both roles may manage it.
 * Mounted behind smsAdminAuth (see routers/admin/index.js).
 */
const express = require('express');
const Router = express.Router();
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const catalog = require('../../models/sms-sender-ids');

function handle(res, e) {
    const map = { invalid_sender_id: 400, invalid_global_priority: 400, duplicate_sender_id: 409, duplicate_global_priority: 409, not_found: 404 };
    return res.status(map[e.code] || 400).send({ message: e.message, status: map[e.code] || 400, code: e.code || 'error' });
}

// GET /api/admin/sender-ids
Router.get('/', asyncMiddleware(async (req, res) => {
    return res.send({ status: 200, sender_ids: await catalog.listSenderIds() });
}));

// POST /api/admin/sender-ids  { value, label?, global_priority? }
Router.post('/', asyncMiddleware(async (req, res) => {
    const { value, label, global_priority } = req.body || {};
    try {
        const row = await catalog.createSenderId({ value, label, global_priority, created_by: req.admin.admin_id });
        return res.status(201).send({ status: 201, sender_id: row });
    } catch (e) { return handle(res, e); }
}));

// PATCH /api/admin/sender-ids/:id  { value?, label?, global_priority?, is_active? }
Router.patch('/:id', asyncMiddleware(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send({ message: 'Invalid id.', status: 400 });
    const { value, label, global_priority, is_active } = req.body || {};
    try {
        const row = await catalog.updateSenderId(id, { value, label, global_priority, is_active });
        return res.send({ status: 200, sender_id: row });
    } catch (e) { return handle(res, e); }
}));

// DELETE /api/admin/sender-ids/:id
Router.delete('/:id', asyncMiddleware(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send({ message: 'Invalid id.', status: 400 });
    try {
        return res.send({ status: 200, ...(await catalog.deleteSenderId(id)) });
    } catch (e) { return handle(res, e); }
}));

module.exports = Router;
