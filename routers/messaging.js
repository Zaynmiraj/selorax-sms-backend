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
    const { event_topic, name, template_text, is_active, delay_minutes } = req.body;

    if (!event_topic || !name || !template_text) {
        return res.status(400).send({ message: 'event_topic, name, and template_text are required.', status: 400 });
    }

    const template = await messaging.upsertTemplate(
        req.installation.installation_id,
        req.user.store_id,
        { event_topic, name, template_text, is_active, delay_minutes }
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
    const { phone, message, event_topic, resource_id, source_app, metadata } = req.body;

    if (!phone || !message) {
        return res.status(400).send({ message: 'phone and message are required.', status: 400 });
    }

    // Validate BD phone number format
    const cleanPhone = phone.toString().replace(/[\s\-()]+/g, '');
    const bdPhoneRegex = /^(?:\+?880|0)1[3-9]\d{8}$/;
    if (!bdPhoneRegex.test(cleanPhone)) {
        return res.status(400).send({ message: 'Invalid phone number format.', status: 400 });
    }

    const result = await messaging.sendSms(
        req.user.store_id,
        req.installation.installation_id,
        phone,
        message,
        {
            event_topic: event_topic || (source_app ? `app.${source_app}` : 'manual'),
            resource_id: resource_id || null,
            source_app: source_app || null,
            metadata: metadata || null,
        }
    );

    if (!result.success && result.error === 'insufficient_balance') {
        return res.status(402).send({
            message: 'No SMS credits remaining. Please buy a package.',
            code: 'insufficient_balance',
            sms_credits: result.sms_credits,
            status: 402,
        });
    }

    const httpStatus = result.success ? 200 : 500;
    res.status(httpStatus).send({
        message: result.success ? 'SMS sent successfully.' : 'SMS sending failed.',
        data: result,
        status: httpStatus,
    });
}));

/**
 * GET /api/messaging/logs
 * Get SMS delivery logs (paginated)
 */
Router.get('/logs', auth, asyncMiddleware(async (req, res) => {
    const { page, limit, status, phone, event_topic, from_date, to_date } = req.query;
    const logs = await messaging.getLogs(req.user.store_id, {
        page: Number(page) || 1,
        limit: Number(limit) || 20,
        status, phone, event_topic, from_date, to_date,
    });
    res.send({ message: 'Logs fetched.', data: logs, status: 200 });
}));

/**
 * POST /api/messaging/logs/:log_id/retry
 * Retry a failed SMS. Body: { scheduled_at?: ISO string }
 *   - no scheduled_at → send immediately (bills 1 SMS credit like any send)
 *   - scheduled_at    → queue on the scheduler for future delivery
 *
 * Only allowed when the log's status is 'failed' — retrying already-sent messages
 * would double-charge the buyer, and retrying pending/scheduled ones is meaningless.
 * Cross-store guard via getLogById scoping.
 */
Router.post('/logs/:log_id/retry', auth, asyncMiddleware(async (req, res) => {
    const log = await messaging.getLogById(req.user.store_id, req.params.log_id);
    if (!log) return res.status(404).send({ message: 'Log not found.', status: 404, code: 'not_found' });
    if (log.status !== 'failed') {
        return res.status(400).send({
            message: `Cannot retry a log with status '${log.status}' — only failed logs can be retried.`,
            status: 400, code: 'not_retryable',
        });
    }

    const { scheduled_at } = req.body || {};
    const scheduledDate = scheduled_at ? new Date(scheduled_at) : null;
    if (scheduled_at && (isNaN(scheduledDate.getTime()) || scheduledDate <= new Date())) {
        return res.status(400).send({
            message: 'scheduled_at must be a valid ISO datetime in the future.',
            status: 400, code: 'invalid_scheduled_at',
        });
    }

    // Schedule path — defers billing until the scheduler actually sends the SMS
    // (matches the existing scheduled-automation flow — no credit deducted until send).
    if (scheduledDate) {
        const scheduler = require('../services/scheduler');
        const jobId = await scheduler.scheduleJob(
            log.store_id, log.installation_id, log.phone, log.message, scheduledDate,
            { event_topic: log.event_topic, resource_id: log.resource_id },
        );
        return res.send({
            message: 'Retry scheduled.',
            data: { retry_type: 'scheduled', job_id: jobId, scheduled_at: scheduledDate.toISOString(), log_id: log.log_id },
            status: 200,
        });
    }

    // Immediate path — sendSms handles the credit check + debit + new log row insert.
    const result = await messaging.sendSms(
        log.store_id, log.installation_id, log.phone, log.message,
        {
            event_topic: log.event_topic || 'manual.retry',
            resource_id: log.resource_id,
            source_app: 'retry',
            metadata: { retried_from_log_id: log.log_id },
        },
    );

    if (!result.success && result.error === 'insufficient_balance') {
        return res.status(402).send({
            message: 'No SMS credits remaining. Please buy a package.',
            code: 'insufficient_balance',
            sms_credits: result.sms_credits,
            status: 402,
        });
    }

    res.status(result.success ? 200 : 500).send({
        message: result.success ? 'SMS retried.' : 'Retry failed.',
        data: { retry_type: 'immediate', ...result, retried_from_log_id: log.log_id },
        status: result.success ? 200 : 500,
    });
}));

/**
 * POST /api/messaging/logs/retry-bulk
 * Body: { log_ids: number[], scheduled_at?: ISO string }
 *
 * Retries every valid failed log in one call. Returns a per-id result summary so
 * the UI can toast e.g. "12 retried, 1 skipped (already sent), 2 insufficient credit".
 * Loops through candidates — a mid-batch credit exhaustion stops the immediate path
 * (later items report insufficient_balance), but scheduled retries queue regardless.
 */
Router.post('/logs/retry-bulk', auth, asyncMiddleware(async (req, res) => {
    const { log_ids, scheduled_at } = req.body || {};
    if (!Array.isArray(log_ids) || !log_ids.length) {
        return res.status(400).send({ message: 'log_ids array is required.', status: 400 });
    }
    if (log_ids.length > 200) {
        return res.status(400).send({ message: 'Max 200 log_ids per bulk retry call.', status: 400, code: 'batch_too_large' });
    }

    const scheduledDate = scheduled_at ? new Date(scheduled_at) : null;
    if (scheduled_at && (isNaN(scheduledDate.getTime()) || scheduledDate <= new Date())) {
        return res.status(400).send({ message: 'scheduled_at must be a valid ISO datetime in the future.', status: 400, code: 'invalid_scheduled_at' });
    }

    const logs = await messaging.getFailedLogsByIds(req.user.store_id, log_ids);
    const results = { retried: 0, scheduled: 0, skipped: 0, insufficient: 0, failed: 0, items: [] };

    const scheduler = scheduledDate ? require('../services/scheduler') : null;

    for (const inputId of log_ids) {
        const log = logs.find((l) => l.log_id === Number(inputId));
        if (!log) {
            results.skipped++;
            results.items.push({ log_id: Number(inputId), outcome: 'skipped', reason: 'not_failed_or_not_found' });
            continue;
        }

        if (scheduledDate) {
            try {
                const jobId = await scheduler.scheduleJob(
                    log.store_id, log.installation_id, log.phone, log.message, scheduledDate,
                    { event_topic: log.event_topic, resource_id: log.resource_id },
                );
                results.scheduled++;
                results.items.push({ log_id: log.log_id, outcome: 'scheduled', job_id: jobId });
            } catch (err) {
                results.failed++;
                results.items.push({ log_id: log.log_id, outcome: 'failed', error: err.message });
            }
            continue;
        }

        try {
            const result = await messaging.sendSms(
                log.store_id, log.installation_id, log.phone, log.message,
                {
                    event_topic: log.event_topic || 'manual.retry',
                    resource_id: log.resource_id,
                    source_app: 'retry-bulk',
                    metadata: { retried_from_log_id: log.log_id },
                },
            );
            if (result.success) {
                results.retried++;
                results.items.push({ log_id: log.log_id, outcome: 'retried', new_log_id: result.log_id });
            } else if (result.error === 'insufficient_balance') {
                results.insufficient++;
                results.items.push({ log_id: log.log_id, outcome: 'insufficient_balance' });
            } else {
                results.failed++;
                results.items.push({ log_id: log.log_id, outcome: 'failed', error: result.error || 'send_failed' });
            }
        } catch (err) {
            results.failed++;
            results.items.push({ log_id: log.log_id, outcome: 'failed', error: err.message });
        }
    }

    res.send({
        message: `Bulk retry complete: ${results.retried} sent, ${results.scheduled} scheduled, ${results.skipped} skipped, ${results.insufficient} out of credit, ${results.failed} failed.`,
        data: results,
        status: 200,
    });
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
