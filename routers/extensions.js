const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const { connection } = require('../startup/db');
const messaging = require('../models/messaging');
const wallet = require('../models/messaging-wallet');

// BDT value of one SMS credit. Mirrors CUSTOM_SMS_UNIT_PRICE in models/messaging-payment.js.
const SMS_UNIT_PRICE = 0.70;

/**
 * Dashboard extension endpoints, called by the SeloraX platform's extension proxy
 * (POST /api/apps/extensions/action on the platform backend), never by a browser.
 *
 * The platform resolves each extension's relative action_url against the app's
 * registered app_url — which is the FRONTEND — so these are reached through the
 * frontend's /api/messaging/extensions/* proxy routes.
 *
 * Response contract is the platform's ExtensionSlot directive shape:
 * { update_state, show_toast, update_ui, navigate, refetch, ... }. Anything else
 * is ignored by the renderer.
 */

/**
 * POST /api/messaging/extensions/widget-data
 * Loader for the `dashboard.widget` extension (SMS Overview).
 */
Router.post('/widget-data', auth, asyncMiddleware(async (req, res) => {
    const store_id = req.user.store_id;

    const [credits, stats, settings] = await Promise.all([
        wallet.getCredits(store_id),
        messaging.getStats(store_id),
        messaging.getSettings(store_id),
    ]);

    res.send({
        update_state: {
            loaded: true,
            balance: (credits * SMS_UNIT_PRICE).toFixed(2),
            sms_remaining: credits,
            this_month: Number(stats.this_month) || 0,
            total_sent: Number(stats.total_sent) || 0,
            success_rate: Number(stats.success_rate) || 0,
            auto_sms: Boolean(settings?.auto_sms_enabled),
        },
    });
}));

/**
 * POST /api/messaging/extensions/order-sms
 * Loader for the `order.detail.block` extension (SMS History).
 * Body: { order_id }
 */
Router.post('/order-sms', auth, asyncMiddleware(async (req, res) => {
    const store_id = req.user.store_id;
    const { order_id } = req.body;

    if (!order_id) {
        return res.send({
            update_state: { loaded: true, has_logs: false, log_count: 0, sms_summary: 'No SMS messages' },
        });
    }

    const [logs] = await connection.promise().query(/*sql*/`
        SELECT status, created_at
        FROM app_messaging_logs
        WHERE store_id = ? AND resource_id = ?
        ORDER BY created_at DESC
        LIMIT 50
    `, [store_id, String(order_id)]);

    const sent = logs.filter(l => l.status === 'sent').length;
    const failed = logs.filter(l => l.status === 'failed').length;

    let sms_summary = 'No SMS messages';
    if (logs.length) {
        sms_summary = `${sent} sent${failed ? `, ${failed} failed` : ''}`;
    }

    res.send({
        update_state: {
            loaded: true,
            has_logs: logs.length > 0,
            log_count: sent,
            sms_summary,
        },
    });
}));

/**
 * POST /api/messaging/extensions/quick-send
 * Action for the `order.detail.block` Send button.
 * Body: { phone, message, order_id }
 */
Router.post('/quick-send', auth, asyncMiddleware(async (req, res) => {
    const store_id = req.user.store_id;
    const installation_id = req.user.installation_id || null;
    const { phone, message, order_id } = req.body;

    if (!phone || !message) {
        return res.send({
            show_toast: { type: 'error', message: 'Phone and message are required.' },
            update_state: { sending: false },
        });
    }

    const result = await messaging.sendSms(store_id, installation_id, phone, message, {
        event_topic: 'extension.quick_send',
        resource_id: order_id ? String(order_id) : null,
        source_app: 'dashboard-extension',
    });

    if (!result.success) {
        const reason = result.error === 'insufficient_balance'
            ? `Not enough SMS credits (${result.sms_credits} left).`
            : (result.error || 'Failed to send SMS.');
        return res.send({
            show_toast: { type: 'error', message: reason },
            update_state: { sending: false },
        });
    }

    const credits = await wallet.getCredits(store_id);

    res.send({
        show_toast: { type: 'success', message: 'SMS sent.' },
        update_state: {
            sending: false,
            show_send: false,
            send_message: '',
            has_logs: true,
            sms_remaining: credits,
        },
    });
}));

module.exports = Router;
