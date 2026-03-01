const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const wallet = require('../models/messaging-wallet');
const { getPricePerSms } = require('../services/sms-providers');

/**
 * GET /api/messaging/wallet
 * Get wallet balance + pricing info (wallet from platform API, pricing from local DB)
 */
Router.get('/', auth, asyncMiddleware(async (req, res) => {
    const w = await wallet.getWallet(req.user.store_id);
    const pricePerSms = await getPricePerSms();
    const balance = Number(w.balance);
    const smsRemaining = Math.floor(balance / pricePerSms);

    res.send({
        message: 'Wallet fetched.',
        data: {
            ...w,
            balance,
            total_topup: Number(w.total_topup || 0),
            total_spent: Number(w.total_spent || 0),
            price_per_sms: pricePerSms,
            sms_remaining: smsRemaining,
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
 * Get active pricing (from messaging app's own DB)
 */
Router.get('/pricing', auth, asyncMiddleware(async (req, res) => {
    const pricing = await wallet.getPricing();
    res.send({ message: 'Pricing fetched.', data: pricing, status: 200 });
}));

module.exports = Router;
