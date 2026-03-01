const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const payment = require('../models/messaging-payment');

/**
 * POST /api/messaging/payment/topup
 * Create a wallet top-up charge via platform billing API.
 * Returns confirmation_url — frontend sends this to parent frame
 * via postMessage for the merchant to approve.
 */
Router.post('/topup', auth, asyncMiddleware(async (req, res) => {
    const { amount } = req.body;

    if (!amount || amount < 10) {
        return res.status(400).send({ message: 'Minimum top-up amount is 10 BDT.', status: 400 });
    }

    if (amount > 50000) {
        return res.status(400).send({ message: 'Maximum top-up amount is 50,000 BDT.', status: 400 });
    }

    const result = await payment.initiateTopup(
        req.user.store_id,
        parseFloat(amount)
    );

    res.send({
        message: 'Charge created. Redirect merchant to approve payment.',
        data: result,
        status: 200,
    });
}));

/**
 * GET /api/messaging/payment/verify/:charge_id
 * Check status of a charge (for polling from frontend)
 */
Router.get('/verify/:charge_id', auth, asyncMiddleware(async (req, res) => {
    const charge = await payment.getChargeStatus(
        req.user.store_id,
        Number(req.params.charge_id)
    );

    if (!charge) {
        return res.status(404).send({ message: 'Charge not found.', status: 404 });
    }

    res.send({
        message: 'Charge status.',
        data: charge,
        status: 200,
    });
}));

module.exports = Router;
