/**
 * Platform-to-platform internal endpoints (X-Internal-Secret auth).
 *
 * Currently: one endpoint used by SeloraX-Backend to unify SMS billing for the merchant
 * "Send pay-link SMS" button on the order detail — routed here so the send bills THIS
 * app's sms_credits pool (the pool merchants top up in-app) rather than the backend's
 * separate wallet meter. Same billing/logging path as automations, so it lands in
 * `app_messaging_logs` and is dedupable via `resource_id`.
 */
const express = require('express');
const Router = express.Router();
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const internalAuth = require('../middlewares/internalAuth');
const messaging = require('../models/messaging');

/**
 * POST /api/messaging/internal/send-sms
 * Body: { store_id, phone, message, event_topic?, resource_id?, source_app? }
 *
 * Returns:
 *   200 { success: true,  data: { log_id, sms_credits, parts, phone_last4 } }
 *   200 { success: false, code: 'insufficient_balance', data: { sms_credits } }
 *   200 { success: false, code: 'app_not_installed' }   — merchant hasn't installed messaging
 *   400 { message, code }                                — validation
 */
Router.post('/send-sms', internalAuth, asyncMiddleware(async (req, res) => {
    const { store_id, phone, message, event_topic, resource_id, source_app } = req.body || {};

    if (!store_id || !phone || !message) {
        return res.status(400).send({
            message: 'store_id, phone, message are required.',
            status: 400,
            code: 'missing_field',
        });
    }

    const bdPhoneRegex = /^(?:\+?880|0)1[3-9]\d{8}$/;
    if (!bdPhoneRegex.test(String(phone).replace(/[\s\-()]+/g, ''))) {
        return res.status(400).send({
            message: `Invalid BD phone number: ${phone}`,
            status: 400,
            code: 'invalid_phone',
        });
    }

    // Resolve the app installation — required so the log row / provider config attach to
    // the right install. If the store hasn't installed the messaging app, tell the caller
    // so they can either fall back or prompt the merchant to install.
    const settings = await messaging.getSettings(store_id);
    if (!settings) {
        return res.status(200).send({
            success: false,
            code: 'app_not_installed',
            message: 'Messaging app is not installed for this store.',
            status: 200,
        });
    }
    if (!settings.is_enabled) {
        return res.status(200).send({
            success: false,
            code: 'app_disabled',
            message: 'Messaging app is installed but disabled for this store.',
            status: 200,
        });
    }

    const result = await messaging.sendSms(
        store_id,
        settings.installation_id,
        String(phone).replace(/[\s\-()]+/g, ''),
        String(message),
        {
            event_topic: event_topic || 'internal.manual_send',
            resource_id: resource_id || null,
            source_app: source_app || 'selorax-backend',
        },
    );

    // Normalize the response shape to what a backend caller can act on.
    if (!result.success) {
        return res.status(200).send({
            success: false,
            code: result.error || 'send_failed',
            data: { sms_credits: result.sms_credits },
            status: 200,
        });
    }

    return res.status(200).send({
        success: true,
        data: {
            log_id: result.log_id,
            sms_credits: result.sms_credits,
            phone_last4: String(phone).slice(-4),
        },
        status: 200,
    });
}));

module.exports = Router;
