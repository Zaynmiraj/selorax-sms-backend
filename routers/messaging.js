const express = require('express');
const Router = express.Router();
const auth = require('../middlewares/auth');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const messaging = require('../models/messaging');

/**
 * GET /api/messaging/settings
 * Get messaging settings for the store
 */
Router.get('/settings', auth, asyncMiddleware(async (req, res) => {
    const settings = await messaging.ensureSettings(req.user.store_id, req.installation.installation_id);
    res.send({ message: 'Settings fetched.', data: settings, status: 200 });
}));

/**
 * PUT /api/messaging/settings
 * Update messaging settings
 */
Router.put('/settings', auth, asyncMiddleware(async (req, res) => {
    const updated = await messaging.updateSettings(
        req.user.store_id,
        req.installation.installation_id,
        req.body
    );
    res.send({ message: 'Settings updated.', data: updated, status: 200 });
}));

/**
 * GET /api/messaging/templates
 * List all SMS templates for this installation
 */
Router.get('/templates', auth, asyncMiddleware(async (req, res) => {
    const templates = await messaging.getTemplates(req.installation.installation_id);
    res.send({ message: 'Templates fetched.', data: templates, status: 200 });
}));

/**
 * POST /api/messaging/templates
 * Create or update a template
 */
Router.post('/templates', auth, asyncMiddleware(async (req, res) => {
    const { event_topic, name, template_text, is_active } = req.body;

    if (!event_topic || !name || !template_text) {
        return res.status(400).send({ message: 'event_topic, name, and template_text are required.', status: 400 });
    }

    const template = await messaging.upsertTemplate(
        req.installation.installation_id,
        req.user.store_id,
        { event_topic, name, template_text, is_active }
    );
    res.send({ message: 'Template saved.', data: template, status: 200 });
}));

/**
 * DELETE /api/messaging/templates/:template_id
 * Delete a template
 */
Router.delete('/templates/:template_id', auth, asyncMiddleware(async (req, res) => {
    const deleted = await messaging.deleteTemplate(
        Number(req.params.template_id),
        req.user.store_id
    );

    if (!deleted) {
        return res.status(404).send({ message: 'Template not found.', status: 404 });
    }
    res.send({ message: 'Template deleted.', status: 200 });
}));

/**
 * POST /api/messaging/send
 * Send a manual SMS (deducts credits)
 */
Router.post('/send', auth, asyncMiddleware(async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).send({ message: 'phone and message are required.', status: 400 });
    }

    const result = await messaging.sendSms(
        req.user.store_id,
        req.installation.installation_id,
        phone,
        message,
        { event_topic: 'manual' }
    );

    if (!result.success && result.error === 'insufficient_balance') {
        return res.status(402).send({
            message: 'Insufficient SMS credits. Please top up your wallet.',
            code: 'insufficient_balance',
            balance: result.balance,
            required: result.required,
            status: 402,
        });
    }

    res.send({
        message: result.success ? 'SMS sent successfully.' : 'SMS sending failed.',
        data: result,
        status: result.success ? 200 : 500,
    });
}));

/**
 * GET /api/messaging/logs
 * Get SMS delivery logs (paginated)
 */
Router.get('/logs', auth, asyncMiddleware(async (req, res) => {
    const { page, limit, status, phone } = req.query;
    const logs = await messaging.getLogs(req.user.store_id, {
        page: Number(page) || 1,
        limit: Number(limit) || 20,
        status,
        phone,
    });
    res.send({ message: 'Logs fetched.', data: logs, status: 200 });
}));

/**
 * GET /api/messaging/stats
 * Get messaging dashboard stats
 */
Router.get('/stats', auth, asyncMiddleware(async (req, res) => {
    const stats = await messaging.getStats(req.user.store_id);
    res.send({ message: 'Stats fetched.', data: stats, status: 200 });
}));

module.exports = Router;
