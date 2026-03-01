const BulkSmsProvider = require('./bulksms');
const { connection } = require('../../startup/db');

/**
 * Resolve SMS provider based on store settings.
 * If merchant has own provider keys → use those.
 * Otherwise → use platform defaults from env vars.
 */
function resolveProvider(settings) {
    if (settings?.use_own_provider && settings?.api_key) {
        return new BulkSmsProvider({
            endpoint: settings.provider_endpoint || process.env.SMS_API_ENDPOINT,
            apiKey: settings.api_key,
            senderId: settings.sender_id || process.env.SMS_API_SENDER_ID,
        });
    }

    return new BulkSmsProvider({
        endpoint: process.env.SMS_API_ENDPOINT,
        apiKey: process.env.SMS_API_KEY,
        senderId: process.env.SMS_API_SENDER_ID,
    });
}

/**
 * Get active price per SMS from the pricing table
 */
async function getPricePerSms(provider = 'bulksms') {
    const [rows] = await connection.promise().query(/*sql*/`
        SELECT price_per_sms FROM app_messaging_pricing
        WHERE provider = ? AND is_active = 1 LIMIT 1
    `, [provider]);

    return rows.length ? parseFloat(rows[0].price_per_sms) : 0.50;
}

module.exports = { resolveProvider, getPricePerSms };
