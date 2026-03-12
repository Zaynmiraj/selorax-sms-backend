const crypto = require('crypto');
const express = require('express');
const Router = express.Router();
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const messaging = require('../models/messaging');
const { connection } = require('../startup/db');
const scheduler = require('../services/scheduler');

/**
 * Map platform order_status values to messaging template event topics.
 * Platform fires generic `order.status_changed` with a status field.
 * Messaging templates use specific topics like `order.confirmed`.
 */
const STATUS_TO_EVENT_TOPIC = {
    processing: 'order.confirmed',   // Admin approves order → "confirmed"
    shipped: 'order.shipped',        // Courier assigned / shipped
    completed: 'order.delivered',    // Order completed / delivered
    delivered: 'order.delivered',
    cancelled: 'order.cancelled',
    hold: 'order.cancelled',         // On hold
};

/**
 * Verify HMAC-SHA256 webhook signature.
 * The platform signs "timestamp.body" with the subscription's signing_secret.
 * Header format: "sha256=<hex digest>"
 */
function verifySignature(body, signatureHeader, timestamp, secret) {
    if (!signatureHeader || !secret) return false;

    const signaturePayload = timestamp ? `${timestamp}.${body}` : body;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(signaturePayload)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(expected),
            Buffer.from(signatureHeader)
        );
    } catch {
        return false;
    }
}

/**
 * POST /api/messaging/webhooks/receive
 * Receives webhooks from SeloraX platform via Inngest delivery.
 * Verifies HMAC-SHA256 signature, maps order status to template, sends SMS.
 */
Router.post('/receive', asyncMiddleware(async (req, res) => {
    const signature = req.header('X-SeloraX-Signature');
    const eventTopic = req.header('X-SeloraX-Webhook-Event');
    const timestamp = req.header('X-SeloraX-Timestamp');

    if (!signature || !eventTopic) {
        return res.status(400).send({ message: 'Missing webhook headers.', status: 400 });
    }

    // Verify HMAC signature (platform signs "timestamp.rawBody")
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const signingSecret = process.env.WEBHOOK_SIGNING_SECRET;

    if (!verifySignature(rawBody, signature, timestamp, signingSecret)) {
        console.warn('[Webhook] Invalid signature for event:', eventTopic);
        return res.status(401).send({ message: 'Invalid webhook signature.', status: 401 });
    }

    const { store_id, data } = req.body;

    if (!store_id) {
        return res.status(400).send({ message: 'Missing store_id in payload.', status: 400 });
    }

    // HMAC signature already proves the webhook came from the platform.
    // No need to look up app_installations — use store_id directly.

    // Check if auto-SMS is enabled
    const settings = await messaging.getSettings(store_id);
    if (!settings || !settings.is_enabled || !settings.auto_sms_enabled) {
        return res.status(200).send({ message: 'Auto-SMS disabled, skipping.', status: 200 });
    }

    // Resolve the template event topic from the platform event
    // Platform sends "order.status_changed" — we map payload.status to a specific topic
    const order = data || {};
    let templateEventTopic = eventTopic;

    if (eventTopic === 'order.status_changed') {
        const orderStatus = order.status || order.order_status;
        templateEventTopic = STATUS_TO_EVENT_TOPIC[orderStatus] || null;

        if (!templateEventTopic) {
            return res.status(200).send({
                message: `No template mapping for status: ${orderStatus}`,
                status: 200
            });
        }
    }

    // Find matching template by store_id
    const templates = await messaging.getTemplatesByStore(store_id);
    const template = templates.find(t => t.event_topic === templateEventTopic && t.is_active);

    if (!template) {
        return res.status(200).send({ message: 'No active template for this event.', status: 200 });
    }

    // Extract customer phone from order data
    const rawPhone = order.customer_phone || order.phone || order.shipping_phone;

    if (!rawPhone) {
        return res.status(200).send({ message: 'No customer phone found in payload.', status: 200 });
    }

    // Normalize and validate BD phone number
    const phone = rawPhone.toString().replace(/[\s\-()]+/g, '');
    const bdPhoneRegex = /^(?:\+?880|0)1[3-9]\d{8}$/;
    if (!bdPhoneRegex.test(phone)) {
        console.warn(`[Webhook] Invalid phone number: ${rawPhone} for store ${store_id}`);
        return res.status(200).send({ message: `Invalid phone number: ${rawPhone}`, status: 200 });
    }

    // Duplicate prevention — skip if same SMS was already sent for this order+event in the last 5 min
    const orderId = order.order_id || order.id;
    const [dupeRows] = await connection.promise().query(/*sql*/`
        SELECT log_id FROM app_messaging_logs
        WHERE store_id = ? AND event_topic = ? AND resource_id = ? AND status = 'sent'
          AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
        LIMIT 1
    `, [store_id, templateEventTopic, orderId]);

    if (dupeRows.length > 0) {
        console.log(`[Webhook] Duplicate skipped: ${templateEventTopic} for order ${orderId} store ${store_id}`);
        return res.status(200).send({ message: 'Duplicate event — SMS already sent.', status: 200 });
    }

    // Render template with order variables
    const variables = {
        order_id: order.order_id || order.id || '',
        order_number: order.order_number || order.order_id || '',
        customer_name: order.customer_name || order.name || '',
        customer_phone: phone,
        total: order.total || order.grand_total || '',
        status: order.status || order.order_status || '',
        tracking_id: order.tracking_id || order.tracking_number || '',
        store_name: order.store_name || '',
    };

    const renderedMessage = messaging.renderTemplate(template.template_text, variables);

    // Cancel pending scheduled SMS if order is cancelled
    if (templateEventTopic === 'order.cancelled' && orderId) {
        await scheduler.cancelJobsForOrder(store_id, String(orderId));
    }

    // Check if template has delay
    if (template.delay_minutes > 0) {
        const scheduledAt = new Date(Date.now() + template.delay_minutes * 60 * 1000);
        const jobId = await scheduler.scheduleJob(
            store_id, settings.installation_id, phone, renderedMessage, scheduledAt,
            { event_topic: templateEventTopic, resource_id: orderId }
        );
        console.log(`[Webhook] ${templateEventTopic} → SMS scheduled (job ${jobId}) for ${scheduledAt.toISOString()} store ${store_id}`);
        return res.status(200).send({
            message: 'SMS scheduled.',
            data: { scheduled: true, job_id: jobId, scheduled_at: scheduledAt },
            status: 200,
        });
    }

    // Send immediately (no delay)
    const result = await messaging.sendSms(
        store_id,
        settings.installation_id,
        phone,
        renderedMessage,
        { event_topic: templateEventTopic, resource_id: order.order_id || order.id }
    );

    console.log(`[Webhook] ${templateEventTopic} → SMS ${result.success ? 'sent' : 'failed'} to ${phone} for store ${store_id}`);

    res.status(200).send({
        message: result.success ? 'SMS sent.' : 'SMS failed.',
        data: { success: result.success, log_id: result.log_id },
        status: 200,
    });
}));

module.exports = Router;
