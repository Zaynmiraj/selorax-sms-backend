const { connection } = require('../startup/db');
const { resolveProvider, getPricePerSms } = require('../services/sms-providers');

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

/**
 * Update messaging settings
 */
async function updateSettings(store_id, installation_id, updates) {
    const allowed = ['is_enabled', 'use_own_provider', 'provider', 'api_key', 'sender_id', 'provider_endpoint', 'auto_sms_enabled'];
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
    if (existing) return existing;

    await connection.promise().query(/*sql*/`
        INSERT IGNORE INTO app_messaging_settings (installation_id, store_id)
        VALUES (?, ?)
    `, [installation_id, store_id]);

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
async function upsertTemplate(installation_id, store_id, { event_topic, name, template_text, is_active }) {
    await connection.promise().query(/*sql*/`
        INSERT INTO app_messaging_templates (installation_id, store_id, event_topic, name, template_text, is_active)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            template_text = VALUES(template_text),
            is_active = VALUES(is_active),
            updated_at = CURRENT_TIMESTAMP
    `, [installation_id, store_id, event_topic, name, template_text, is_active ?? 1]);

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
 * Checks balance → deducts → sends via provider → logs result.
 */
async function sendSms(store_id, installation_id, phone, message, { event_topic, resource_id } = {}) {
    const wallet = require('./messaging-wallet');

    // Get pricing
    const pricePerSms = await getPricePerSms();

    // Check balance
    const balance = await wallet.getBalance(store_id);
    if (balance < pricePerSms) {
        return { success: false, error: 'insufficient_balance', balance, required: pricePerSms };
    }

    // Get settings and resolve provider
    const settings = await getSettings(store_id);
    const provider = resolveProvider(settings);

    // Send SMS
    const result = await provider.sendSms(phone, message);

    // Log the SMS
    const [logResult] = await connection.promise().query(/*sql*/`
        INSERT INTO app_messaging_logs (store_id, installation_id, phone, message, event_topic, resource_id, status, provider_response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        store_id, installation_id, phone, message,
        event_topic || null, resource_id || null,
        result.success ? 'sent' : 'failed',
        JSON.stringify(result.provider_response),
    ]);

    const sms_log_id = logResult.insertId;

    // Deduct from wallet only if sent successfully
    if (result.success) {
        await wallet.deduct(store_id, pricePerSms, `SMS to ${phone}`, sms_log_id);
    }

    return {
        success: result.success,
        log_id: sms_log_id,
        balance_after: result.success ? (balance - pricePerSms) : balance,
        provider_response: result.provider_response,
    };
}

/**
 * Get paginated SMS logs
 */
async function getLogs(store_id, { page = 1, limit = 20, status, phone } = {}) {
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
    sendSms,
    getLogs,
    getStats,
};
