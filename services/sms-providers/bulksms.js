/**
 * BulkSMS BD API adapter
 */

/**
 * Detect whether a string contains non-GSM-7 characters (e.g., Bangla, Arabic, emoji).
 * GSM-7 supports a limited ASCII subset. Anything outside it requires UCS-2 (unicode).
 */
const GSM7_CHARS = new Set(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    + 'ÄÖÑÜabcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€'
);

function isUnicode(text) {
    for (const char of text) {
        if (!GSM7_CHARS.has(char)) return true;
    }
    return false;
}

class BulkSmsProvider {
    constructor({ endpoint, apiKey, senderId }) {
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.senderId = senderId;
    }

    async sendSms(phone, message) {
        try {
            const smsType = isUnicode(message) ? 'unicode' : 'text';
            const url = `${this.endpoint}?api_key=${encodeURIComponent(this.apiKey)}&type=${smsType}&number=${encodeURIComponent(phone)}&message=${encodeURIComponent(message)}&senderid=${encodeURIComponent(this.senderId)}`;

            const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
            const data = await response.json();

            const success = data?.response_code == 202;

            return {
                success,
                sms_type: smsType,
                provider_response: data,
            };
        } catch (err) {
            return {
                success: false,
                provider_response: { error: err.message },
            };
        }
    }
}

module.exports = BulkSmsProvider;
module.exports.isUnicode = isUnicode;
