/**
 * @route /api/messaging/oauth
 * OAuth webhook endpoints — receives install/uninstall notifications from SeloraX platform.
 *
 * Note: The messaging app authenticates with the platform using
 * client_id + client_secret (like Shopify offline tokens), so we no longer
 * need to store/manage per-store access tokens.
 */
const express = require('express');
const Router = express.Router();
const crypto = require('crypto');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const messaging = require('../models/messaging');
const { connection } = require('../startup/db');
const scheduler = require('../services/scheduler');

/**
 * POST /api/messaging/oauth/token
 * Called by platform after app installation. Acknowledges the install.
 */
Router.post('/token', asyncMiddleware(async (req, res) => {
    const { store_id, installation_id, hmac } = req.body;

    if (!store_id) {
        return res.status(400).send({ message: 'Missing required fields.', status: 400 });
    }

    // Verify HMAC if a signing key is available
    const signingKey = process.env.SESSION_SIGNING_KEY;
    if (signingKey && hmac) {
        const payload = JSON.stringify({ store_id, installation_id, access_token: req.body.access_token });
        const expectedHmac = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(hmac))) {
            return res.status(401).send({ message: 'Invalid HMAC signature.', status: 401 });
        }
    }

    // Ensure a settings row exists for the new installation
    if (installation_id) {
        await messaging.ensureSettings(store_id, installation_id);
    }

    console.log(`[OAuth] Install acknowledged for store_id=${store_id}, installation_id=${installation_id}`);
    res.send({ message: 'Installation acknowledged.', status: 200 });
}));




/**
 * POST /api/messaging/oauth/revoke
 * Called by the platform when the app is uninstalled.
 */
Router.post('/revoke', asyncMiddleware(async (req, res) => {
    const { store_id, hmac } = req.body;

    if (!store_id) {
        return res.status(400).send({ message: 'Missing required fields.', status: 400 });
    }

    const signingKey = process.env.SESSION_SIGNING_KEY;
    if (signingKey && hmac) {
        const payload = JSON.stringify({ store_id, action: 'revoke' });
        const expectedHmac = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(hmac))) {
            return res.status(401).send({ message: 'Invalid HMAC signature.', status: 401 });
        }
    }

    // Deactivate settings so webhooks stop processing for this store
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_settings
        SET is_enabled = 0, auto_sms_enabled = 0
        WHERE store_id = ?
    `, [store_id]);

    // Deactivate templates
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_templates
        SET is_active = 0
        WHERE store_id = ?
    `, [store_id]);

    // Cancel all pending scheduled SMS
    await scheduler.cancelAllForStore(store_id);

    console.log(`[OAuth] Uninstall completed for store_id=${store_id} — settings, templates & scheduled jobs deactivated`);
    res.send({ message: 'Uninstall acknowledged.', status: 200 });
}));

module.exports = Router;
