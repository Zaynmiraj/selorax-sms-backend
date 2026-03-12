const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { default: rateLimit } = require('express-rate-limit');

module.exports = function (app) {
    app.use(cors({
        origin: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true,
    }));

    app.use(cookieParser());
    // Capture raw body for webhook HMAC signature verification
    app.use(express.json({
        verify: (req, _res, buf) => { req.rawBody = buf; },
    }));
    app.use(express.urlencoded({ extended: true }));

    const limiter = rateLimit({
        windowMs: 1 * 60 * 1000,
        max: 500,
        message: 'Too many requests, please try again later.',
    });
    app.use('/api/', limiter);

    // Health check
    app.get('/health', (req, res) => res.send({ status: 'ok', app: 'selorax-messaging' }));

    // Messaging app routes
    app.use('/api/messaging', require('../routers/messaging'));
    app.use('/api/messaging/wallet', require('../routers/wallet'));
    app.use('/api/messaging/payment', require('../routers/payment'));
    app.use('/api/messaging/scheduled', require('../routers/scheduled'));

    // OAuth token receiver (called by SeloraX platform on install/uninstall)
    app.use('/api/messaging/oauth', require('../routers/oauth'));

    // Webhook receiver (called by SeloraX platform)
    app.use('/api/messaging/webhooks', require('../routers/webhooks'));

    // Global error handler
    app.use(require('../middlewares/error'));
};
