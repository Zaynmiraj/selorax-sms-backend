const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const wallet = require('../models/messaging-wallet');
const payment = require('../models/messaging-payment');
const pricing = require('../models/sms-pricing');

/**
 * GET /api/messaging/wallet
 * Get SMS credits + package info
 */
Router.get('/', auth, asyncMiddleware(async (req, res) => {
    const [credits, packages, price] = await Promise.all([
        wallet.getCredits(req.user.store_id),
        payment.getPackages(),
        pricing.getStoreUnitPrice(req.user.store_id),
    ]);

    res.send({
        message: 'Wallet fetched.',
        data: {
            sms_credits: credits,
            packages,
            // Price per SMS for a custom purchase, for THIS store.
            custom_unit_price: Number(price.unit_price),
        },
        status: 200,
    });
}));

/**
 * GET /api/messaging/wallet/transactions
 * Get transaction history (from platform API)
 */
Router.get('/transactions', auth, asyncMiddleware(async (req, res) => {
    const { page, limit } = req.query;
    const result = await wallet.getTransactions(req.user.store_id, {
        page: Number(page) || 1,
        limit: Number(limit) || 20,
    });
    res.send({ message: 'Transactions fetched.', data: result, status: 200 });
}));

/**
 * GET /api/messaging/wallet/pricing
 * Get available SMS packages
 */
Router.get('/pricing', auth, asyncMiddleware(async (req, res) => {
    const packages = await payment.getPackages();
    res.send({ message: 'Packages fetched.', data: packages, status: 200 });
}));

module.exports = Router;
