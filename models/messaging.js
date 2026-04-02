const crypto = require('crypto');
const { connection } = require('../startup/db');
const { resolveProvider } = require('../services/sms-providers');

const GSM7_REGEX = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&'()*+,\-.\/0-9:;<=>?¡A-ZÄÖÑÜa-zäöñüà^{}\\[\\]~|€]*$/;

function calculateSmsParts(message) {
    if (!message) return 1;
    const isUnicode = !GSM7_REGEX.test(message);
    const singleLimit = isUnicode ? 70 : 160;
    const multiLimit = isUnicode ? 67 : 153;
    const len = message.length;
    return len <= singleLimit ? 1 : Math.ceil(len / multiLimit);
}

function generateWebhookSecret() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Get messaging settings for a store
 * Queries messaging app's own settings table directly by store_id.
 */
async function getSettings(store_id) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_settings
        WHERE store_id = ?
        LIMIT 1
    `, [store_id]);
    return rows[0] || null;
}

async function getWebhookSigningSecret(store_id) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT webhook_signing_secret FROM app_messaging_settings
        WHERE store_id = ? LIMIT 1
    `, [store_id]);
    return rows[0]?.webhook_signing_secret || null;
}

async function ensureWebhookSigningSecret(store_id) {
    let secret = await getWebhookSigningSecret(store_id);
    if (secret) return secret;

    secret = generateWebhookSecret();
    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_settings
        SET webhook_signing_secret = ?
        WHERE store_id = ?
    `, [secret, store_id]);
    return secret;
}

/**
 * Update messaging settings
 */
async function updateSettings(store_id, installation_id, updates) {
    const allowed = [
        'is_enabled', 'use_own_provider', 'provider', 'api_key', 'sender_id',
        'provider_endpoint', 'auto_sms_enabled',
        'auto_renew_enabled', 'auto_renew_package_id', 'auto_renew_threshold',
    ];
    const sets = [];
    const params = [];

    for (const key of allowed) {
        if (updates[key] !== undefined) {
            sets.push(`\`${key}\` = ?`);
            params.push(updates[key]);
        }
    }

    if (sets.length === 0) return null;
    params.push(store_id, installation_id);

    await connection.promise().query(/*sql*/`
        UPDATE app_messaging_settings SET ${sets.join(', ')}
        WHERE store_id = ? AND installation_id = ?
    `, params);

    return getSettings(store_id);
}

/**
 * Ensure settings row exists (create on first access)
 */
async function ensureSettings(store_id, installation_id) {
    const existing = await getSettings(store_id);
    if (existing) {
        if (!existing.webhook_signing_secret) {
            await ensureWebhookSigningSecret(store_id);
        }
        return getSettings(store_id);
    }

    await connection.promise().query(/*sql*/`
        INSERT IGNORE INTO app_messaging_settings (installation_id, store_id)
        VALUES (?, ?)
    `, [installation_id, store_id]);

    await ensureWebhookSigningSecret(store_id);
    return getSettings(store_id);
}

/**
 * Get all templates for an installation
 */
async function getTemplates(installation_id) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_templates
        WHERE installation_id = ?
        ORDER BY event_topic
    `, [installation_id]);
    return rows;
}

/**
 * Get all templates for a store (used by webhook receiver)
 */
async function getTemplatesByStore(store_id) {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_templates
        WHERE store_id = ?
        ORDER BY event_topic
    `, [store_id]);
    return rows;
}

/**
 * Create or update a template
 */
async function upsertTemplate(installation_id, store_id, { event_topic, name, template_text, is_active, delay_minutes }) {
    await connection.promise().query(/*sql*/`
        INSERT INTO app_messaging_templates (installation_id, store_id, event_topic, name, template_text, is_active, delay_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            template_text = VALUES(template_text),
            is_active = VALUES(is_active),
            delay_minutes = VALUES(delay_minutes),
            updated_at = CURRENT_TIMESTAMP
    `, [installation_id, store_id, event_topic, name, template_text, is_active ?? 1, delay_minutes ?? 0]);

    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_templates
        WHERE installation_id = ? AND event_topic = ?
    `, [installation_id, event_topic]);
    return rows[0];
}

/**
 * Delete a template
 */
async function deleteTemplate(template_id, store_id) {
    const [result] = await connection.promise().query(/*sql*/`
        DELETE FROM app_messaging_templates WHERE template_id = ? AND store_id = ?
    `, [template_id, store_id]);
    return result.affectedRows > 0;
}

/**
 * Render template text by replacing {{variable}} placeholders
 */
function renderTemplate(templateText, variables = {}) {
    return templateText.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return variables[key] !== undefined ? variables[key] : match;
    });
}

/**
 * Core send SMS function.
 * Checks SMS credits → sends via provider → deducts calculated credits → logs result.
 */
async function sendSms(store_id, installation_id, phone, message, { event_topic, resource_id, source_app, metadata } = {}) {
    const wallet = require('./messaging-wallet');

    // Check SMS credits
    const credits = await wallet.getCredits(store_id);
    const parts = calculateSmsParts(message);
    if (credits < parts) {
        return { success: false, error: 'insufficient_balance', sms_credits: credits };
    }

    // Get settings and resolve provider
    const settings = await getSettings(store_id);
    const provider = resolveProvider(settings);

    // Send SMS
    const result = await provider.sendSms(phone, message);
    const enrichedProviderResponse = {
        ...(result.provider_response || {}),
        meta: {
            source_app: source_app || null,
            metadata: metadata || null,
        },
    };

    // Log the SMS
    let sms_log_id = null;
    try {
        const [logResult] = await connection.promise().query(/*sql*/`
            INSERT INTO app_messaging_logs (store_id, installation_id, phone, message, event_topic, resource_id, status, provider_response)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            store_id, installation_id, phone, message,
            event_topic || null, resource_id || null,
            result.success ? 'sent' : 'failed',
            JSON.stringify(enrichedProviderResponse),
        ]);
        sms_log_id = logResult.insertId;
    } catch (logErr) {
        console.error(`[SMS] Log insert failed for store ${store_id}, phone ${phone}:`, logErr.message);
    }

    // Deduct 1 SMS credit only if sent successfully
    let debitSuccess = false;
    if (result.success) {
        try {
            await wallet.deductCredit(store_id, parts);
            debitSuccess = true;
        } catch (debitErr) {
            console.error(`[SMS] Credit deduct failed for store ${store_id}:`, debitErr.message);
            try {
                await connection.promise().query(/*sql*/`
                    UPDATE app_messaging_logs SET provider_response = JSON_SET(COALESCE(provider_response, '{}'), '$.debit_error', ?)
                    WHERE log_id = ?
                `, [debitErr.message, sms_log_id]);
            } catch { /* non-critical */ }
        }
    }

    const remainingCredits = await wallet.getCredits(store_id);

    return {
        success: result.success,
        log_id: sms_log_id,
        sms_credits: remainingCredits,
        provider_response: enrichedProviderResponse,
    };
}

/**
 * Get paginated SMS logs
 */
async function getLogs(store_id, { page = 1, limit = 20, status, phone, event_topic, from_date, to_date } = {}) {
    const offset = (page - 1) * limit;
    let where = 'WHERE store_id = ?';
    const params = [store_id];

    if (status) {
        where += ' AND status = ?';
        params.push(status);
    }
    if (phone) {
        where += ' AND phone LIKE ?';
        params.push(`%${phone}%`);
    }
    if (event_topic) {
        where += ' AND event_topic = ?';
        params.push(event_topic);
    }
    if (from_date) {
        where += ' AND created_at >= ?';
        params.push(from_date);
    }
    if (to_date) {
        where += ' AND created_at <= ?';
        params.push(to_date + ' 23:59:59');
    }

    const [rows] = await connection.promise().query(/*sql*/`
        SELECT * FROM app_messaging_logs ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const [countRows] = await connection.promise().query(/*sql*/`
        SELECT COUNT(*) as total FROM app_messaging_logs ${where}
    `, params);

    return { logs: rows, total: countRows[0].total, page, limit };
}

/**
 * Get stats for the messaging dashboard
 */
async function getStats(store_id) {
    const [totalRows] = await connection.promise().query(/*sql*/`
        SELECT
            COUNT(*) as total_sent,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_success,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed
        FROM app_messaging_logs WHERE store_id = ?
    `, [store_id]);

    const [monthRows] = await connection.promise().query(/*sql*/`
        SELECT COUNT(*) as this_month
        FROM app_messaging_logs
        WHERE store_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
    `, [store_id]);

    const stats = totalRows[0];
    stats.this_month = monthRows[0].this_month;
    stats.success_rate = stats.total_sent > 0
        ? Math.round((stats.total_success / stats.total_sent) * 100)
        : 0;

    return stats;
}

module.exports = {
    getSettings,
    updateSettings,
    ensureSettings,
    getTemplates,
    getTemplatesByStore,
    upsertTemplate,
    deleteTemplate,
    renderTemplate,
    calculateSmsParts,
    sendSms,
    getLogs,
    getStats,
    getWebhookSigningSecret,
    ensureWebhookSigningSecret,
};
