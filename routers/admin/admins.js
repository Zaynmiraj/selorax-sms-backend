/**
 * /api/admin/admins — manage admin accounts. super_admin only.
 * Mounted behind smsAdminAuth (see routers/admin/index.js); this router adds
 * the requireRole('super_admin') gate.
 */
const express = require('express');
const Router = express.Router();
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const { requireRole } = require('../../middlewares/smsAdminAuth');
const smsAdmin = require('../../models/sms-admin');

Router.use(requireRole('super_admin'));

function handle(res, e) {
    const map = { invalid_phone: 400, duplicate_phone: 409, not_found: 404, last_super_admin: 409 };
    return res.status(map[e.code] || 400).send({ message: e.message, status: map[e.code] || 400, code: e.code || 'error' });
}

// GET /api/admin/admins
Router.get('/', asyncMiddleware(async (req, res) => {
    return res.send({ status: 200, admins: await smsAdmin.listAdmins() });
}));

// POST /api/admin/admins  { name, phone, role }
Router.post('/', asyncMiddleware(async (req, res) => {
    const { name, phone, role } = req.body || {};
    if (!phone) return res.status(400).send({ message: 'Phone is required.', status: 400, code: 'missing_field' });
    try {
        const admin = await smsAdmin.createAdmin({ name, phone, role, created_by: req.admin.admin_id });
        return res.status(201).send({ status: 201, admin });
    } catch (e) { return handle(res, e); }
}));

// PATCH /api/admin/admins/:id  { name?, role?, is_active? }
Router.patch('/:id', asyncMiddleware(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send({ message: 'Invalid id.', status: 400 });
    const { name, role, is_active } = req.body || {};
    try {
        const admin = await smsAdmin.updateAdmin(id, { name, role, is_active });
        return res.send({ status: 200, admin });
    } catch (e) { return handle(res, e); }
}));

// DELETE /api/admin/admins/:id
Router.delete('/:id', asyncMiddleware(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send({ message: 'Invalid id.', status: 400 });
    try {
        return res.send({ status: 200, ...(await smsAdmin.deleteAdmin(id)) });
    } catch (e) { return handle(res, e); }
}));

module.exports = Router;
