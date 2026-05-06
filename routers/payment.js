const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const payment = require('../models/messaging-payment');

/**
 * GET /api/messaging/packages
 * List available SMS packages
 */
Router.get('/packages', auth, asyncMiddleware(async (req, res) => {
    const packages = await payment.getPackages();
    res.send({ message: 'Packages fetched.', data: packages, status: 200 });
}));

/**
 * POST /api/messaging/payment/topup
 * Purchase an SMS package. Accepts package_id.
 */
Router.post('/topup', auth, asyncMiddleware(async (req, res) => {
    const { package_id, sms_count } = req.body;

    if (!package_id && !sms_count) {
        return res.status(400).send({ message: 'Please select a package or enter a custom SMS quantity.', status: 400 });
    }

    const result = package_id
        ? await payment.initiatePurchase(
            req.user.store_id,
            Number(package_id)
        )
        : await payment.initiateCustomPurchase(
            req.user.store_id,
            Number(sms_count)
        );

    res.send({
        message: 'Charge created. Redirect merchant to approve payment.',
        data: result,
        status: 200,
    });
}));

/**
 * GET /api/messaging/payment/verify/:id
 * Check status of a charge. Auto-credits SMS on success.
 *
 * The :id path param can be either a numeric platform charge_id OR a
 * merchant_transaction_id (tran_id) string — EPS callbacks return either
 * depending on flow. We auto-detect by whether the value parses as a
 * positive integer.
 */
Router.get('/verify/:id', auth, asyncMiddleware(async (req, res) => {
    const raw = String(req.params.id || '');
    const numericId = Number(raw);
    const isCharge = Number.isInteger(numericId) && numericId > 0;

    const charge = isCharge
        ? await payment.getChargeStatus(req.user.store_id, numericId)
        : await payment.getChargeStatusByTranId(req.user.store_id, raw);

    if (!charge) {
        return res.status(404).send({ message: 'Charge not found.', status: 404 });
    }

    res.send({
        message: 'Charge status.',
        data: charge,
        status: 200,
    });
}));

/**
 * GET /api/messaging/payment/purchases
 * Purchase history for the store
 */
Router.get('/purchases', auth, asyncMiddleware(async (req, res) => {
    const { page, limit } = req.query;
    const result = await payment.getPurchaseHistory(req.user.store_id, {
        page: Number(page) || 1,
        limit: Number(limit) || 20,
    });
    res.send({ message: 'Purchase history.', data: result, status: 200 });
}));

module.exports = Router;
