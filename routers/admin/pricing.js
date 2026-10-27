/**
 * /api/admin/pricing — the DEFAULT price per SMS for custom credit purchases,
 * used by every store without a price of its own (set on /api/admin/stores).
 * Packages keep their own prices. See models/sms-pricing.js.
 */
const express = require('express');
const Router = express.Router();
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const { requireRole } = require('../../middlewares/smsAdminAuth');
const pricing = require('../../models/sms-pricing');

Router.get('/', asyncMiddleware(async (req, res) => {
    const value = await pricing.getDefaultUnitPrice();
    return res.send({ status: 200, default_unit_price: Number(value), max_unit_price: pricing.MAX_UNIT_PRICE });
}));

// PUT /api/admin/pricing { unit_price }
Router.put('/', requireRole('super_admin'), asyncMiddleware(async (req, res) => {
    try {
        const { previous, value } = await pricing.setDefaultUnitPrice(req.body?.unit_price, req.admin.admin_id);
        console.log(`[SMS Admin] price change: default ${previous} → ${value} by admin ${req.admin.admin_id}`);
        return res.send({ status: 200, default_unit_price: Number(value) });
    } catch (e) {
        if (e.code === 'invalid_price') return res.status(400).send({ message: e.message, status: 400, code: e.code });
        if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
            return res.status(503).send({ message: 'Pricing is not set up yet: database migration 013 has not been applied.', status: 503, code: 'migration_required' });
        }
        throw e;
    }
}));

module.exports = Router;
