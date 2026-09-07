/**
 * Anbernet SMS gateway adapter.
 *
 * Vendor reference: docs/anbernet-api.md
 * Design:           docs/superpowers/specs/2026-07-16-anbernet-sms-provider-design.md
 *
 * Differences from the BulkSMS adapter that matter:
 *   - Success is the STRING `status: "success"`, not `response_code == 202`.
 *     Getting this wrong logs failed sends as `sent` and deducts customer credits.
 *   - Receivers must be `88XXXXXXXXXX`. The app stores `01XXXXXXXXX`, so every
 *     number is normalized first or the vendor rejects it with code 1004.
 *   - Repeated bad credentials get the SERVER IP BANNED (vendor docs). 401/403 are
 *     therefore fatal and trip a process-level breaker instead of being retried.
 */

const SEND_TIMEOUT_MS = 30000;

/**
 * Detect whether a string contains non-GSM-7 characters (Bangla, Arabic, emoji…).
 * GSM-7 covers a limited ASCII subset; anything outside it must be sent as unicode.
 * Kept here so the adapter is self-contained (this was the last dependency on the
 * removed BulkSMS adapter).
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

/**
 * Sender ID limits.
 *
 * The vendor docs say "max 11 chars", but that is the GSM cap for ALPHANUMERIC
 * sender IDs only. Numeric sender IDs (long codes, e.g. 8809639884422) are legal
 * up to 15 digits — the vendor's own incoming-SMS example returns a 13-digit
 * senderid ("8801711958087"). Enforcing 11 across the board would reject a valid
 * numeric sender ID.
 */
const SENDER_ID_ALNUM_MAX = 11;
const SENDER_ID_NUMERIC_MAX = 15;

function senderIdError(senderId) {
    const value = String(senderId);

    if (/^\d+$/.test(value)) {
        return value.length > SENDER_ID_NUMERIC_MAX
            ? `numeric sender ID "${value}" exceeds ${SENDER_ID_NUMERIC_MAX} digits`
            : null;
    }

    return value.length > SENDER_ID_ALNUM_MAX
        ? `alphanumeric sender ID "${value}" exceeds ${SENDER_ID_ALNUM_MAX} chars`
        : null;
}

/**
 * Process-level circuit breaker.
 *
 * The vendor bans our IP after repeated auth failures, and the callers retry:
 * scheduler.js retries 3x with backoff and campaign-sender.js loops batches of 20.
 * Left alone, one bad credential would become a burst of failed auth and take SMS
 * down for every store. Once tripped, no further Anbernet request is attempted
 * until the process restarts (or resetCircuit() is called in tests).
 */
let circuitTrippedReason = null;

function tripCircuit(reason) {
    if (circuitTrippedReason) return;
    circuitTrippedReason = reason;
    console.error(
        `[Anbernet] CIRCUIT TRIPPED — all Anbernet sending halted: ${reason}. ` +
        `Fix the credentials in .env (SMS_API_*) and restart the app.`
    );
}

function resetCircuit() {
    circuitTrippedReason = null;
}

function getCircuitReason() {
    return circuitTrippedReason;
}

/**
 * Normalize a Bangladeshi number to the vendor's `88XXXXXXXXXX` form.
 * Mirrors the app's own validator: /^(?:\+?880|0)1[3-9]\d{8}$/
 * Returns null for anything unrecognised — we never hand junk to an API that
 * bans on bad input.
 */
function normalizeBd(phone) {
    if (phone === null || phone === undefined) return null;

    const digits = String(phone).trim().replace(/[\s()-]/g, '');
    const national = digits.match(/^(?:\+?880|0)?(1[3-9]\d{8})$/);

    return national ? `880${national[1]}` : null;
}

const SECRET_KEYS = new Set(['password', 'token', 'api_key', 'apikey', 'old_password', 'new_password']);

/**
 * Strip credentials out of a vendor payload before it is stored or logged.
 *
 * Anbernet echoes the submitted request back inside validation errors — a real
 * 422 contains `input: { account, api_key }`. sendSms() persists provider_response
 * into app_messaging_logs, so without this the API key would be written to the
 * database (and to stdout) in plain text on every malformed request.
 */
function redactSecrets(value) {
    if (Array.isArray(value)) return value.map(redactSecrets);

    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : redactSecrets(v);
        }
        return out;
    }

    return value;
}

/**
 * Map a vendor reply onto our result shape.
 * Exported for tests so the success/failure rules can be verified without network.
 */
function classifyResponse(httpStatus, body) {
    if (httpStatus === 401) {
        return { success: false, fatal: true, reason: 'auth_failed' };
    }
    if (httpStatus === 403) {
        return { success: false, fatal: true, reason: 'ip_banned' };
    }

    // Documented but never observed in any example response — treated as advisory.
    const code = body && (body.code ?? body.status_code);
    const numericCode = Number(code);
    if (numericCode === 1001) return { success: false, fatal: true, reason: 'auth_failed' };
    if (numericCode === 1002) return { success: false, fatal: true, reason: 'insufficient_vendor_balance' };
    if (numericCode === 1003) {
        return { success: false, fatal: false, reason: 'invalid_sender_id', senderIdRejected: true };
    }

    // An HTTP error can never be an accepted send, whatever the body claims. Without
    // this guard a 500 carrying a stray `status: "success"` would bill the merchant
    // for a message that never left.
    if (!(httpStatus >= 200 && httpStatus < 300)) {
        return { success: false, fatal: false, reason: 'send_rejected' };
    }

    // Acceptance signals, in the order the vendor documents them.
    //
    // This used to be an exact match on the lowercase string 'success' and nothing
    // else — a rule taken from docs/anbernet-api.md and never verified against a
    // live send. A gateway that accepted the SMS but replied in any other documented
    // shape was classified as a failure, and because models/messaging.js gates BOTH
    // the log status and wallet.deductCredit() on this one boolean, the merchant saw
    // `failed` on a message the customer had already received, un-billed, and the
    // scheduler then retried it up to 3x.
    const status = typeof (body && body.status) === 'string' ? body.status.trim().toLowerCase() : null;
    if (status === 'success') {
        return { success: true, fatal: false, reason: null, matched: 'status_success' };
    }
    if (numericCode === 9000) {
        // docs/anbernet-api.md section 8: 9000 = "SMS accepted".
        return { success: true, fatal: false, reason: null, matched: 'code_9000' };
    }
    if (body && Array.isArray(body.messageids) && body.messageids.length > 0) {
        // The documented success example always carries per-recipient message ids.
        return { success: true, fatal: false, reason: null, matched: 'messageids' };
    }

    return { success: false, fatal: false, reason: 'send_rejected' };
}

class AnbernetProvider {
    /**
     * @param {object} cfg
     * @param {string} cfg.apiKey  Portal "API key". It is 40 hex chars, which is
     *   exactly the vendor's documented token format (secrets.token_hex(20)), so
     *   it is used as `token` — /balance rejects a field literally named api_key.
     * @param {string} cfg.password Portal password. Required by /balance.
     */
    constructor({ baseUrl, account, apiKey, password, token, senderId, campaignId } = {}) {
        this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
        this.account = account;
        this.apiKey = apiKey;
        this.password = password;
        this.token = token || apiKey;
        this.senderId = senderId;
        this.campaignId = campaignId || '';
    }

    /**
     * Credential fields for a request body.
     *
     * Prefers password+token: it is the vendor's primary documented form, it is
     * the ONLY form /balance accepts, and therefore the only one we can verify
     * read-only before sending. Falls back to api_key, which the docs show for
     * sendsms only.
     */
    authFields() {
        if (this.password && this.token) {
            return { password: this.password, token: this.token };
        }
        return { api_key: this.apiKey };
    }

    /**
     * Missing config must never reach the network: empty credentials would be a
     * guaranteed 401, and repeated 401s are what get the IP banned.
     */
    configError() {
        if (!this.baseUrl) return 'SMS_API_ENDPOINT is not set';
        if (!this.account) return 'SMS_API_ACCOUNT is not set';
        if (!this.apiKey && !this.token) return 'SMS_API_KEY is not set';
        if (!this.senderId) return 'no sender ID (settings.sender_id or SMS_API_SENDER_ID)';
        return senderIdError(this.senderId);
    }

    /** /balance accepts password+token only — api_key alone gets a 422. */
    balanceConfigError() {
        return this.configError()
            || (!this.password ? 'SMS_API_PASSWORD is not set (/balance requires password + token)' : null);
    }

    /**
     * @param {string} phone
     * @param {string} message
     * @param {{event_topic?: string}} opts
     * @returns {Promise<{success: boolean, sms_type?: string, provider_response: object}>}
     */
    async sendSms(phone, message, { event_topic } = {}) {
        const fail = (error, extra = {}) => ({
            success: false,
            sms_type: isUnicode(message || '') ? 'unicode' : 'text',
            provider_response: { provider: 'anbernet', error, ...extra },
        });

        if (circuitTrippedReason) {
            return fail('circuit_open', { reason: circuitTrippedReason });
        }

        const configError = this.configError();
        if (configError) {
            return fail('not_configured', { reason: configError });
        }

        const receiver = normalizeBd(phone);
        if (!receiver) {
            return fail('invalid_receiver', { phone });
        }

        // Order automations are transactional; campaign-sender.js tags its sends
        // with event_topic 'campaign'. Promotional traffic requires an approved
        // campaign id — we fail loudly rather than send marketing as transactional,
        // which is how sender IDs get blacklisted.
        const transtype = event_topic === 'campaign' ? 'P' : 'T';
        if (transtype === 'P' && !this.campaignId) {
            return fail('campaign_id_required', {
                reason: 'SMS_API_CAMPAIGN_ID is not set; promotional SMS needs an approved campaign id',
            });
        }

        const payload = {
            account: this.account,
            ...this.authFields(),
            senderid: this.senderId,
            receivers: [receiver],
            msgdata: message,
            flashon: false,
            transtype,
        };
        if (transtype === 'P') payload.campaignId = this.campaignId;

        let response;
        let body;
        try {
            response = await fetch(`${this.baseUrl}/sendsms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });

            const text = await response.text();
            try {
                body = JSON.parse(text);
            } catch {
                body = { raw: text.slice(0, 500) };
            }
        } catch (err) {
            // Network/timeout — transient, safe for the existing retry paths. This
            // catch covers both the fetch AND the body read, so the vendor may
            // already have accepted the message: the outcome is genuinely unknown.
            // Stay `failed` (the safe direction — never bill an unconfirmed send)
            // but mark the row so it is identifiable, e.g. for a later /dlrcheck
            // reconciliation.
            return fail(err.message, { indeterminate: true });
        }

        const verdict = classifyResponse(response.status, body);

        if (verdict.fatal) {
            tripCircuit(`${verdict.reason} (HTTP ${response.status})`);
        }

        // redactSecrets: the vendor echoes submitted credentials back inside
        // validation errors, and this object is persisted to app_messaging_logs.
        const safeBody = redactSecrets(body);

        // An unrecognised reply is the one failure mode that cannot be debugged
        // after the fact, so say it out loud. This is what tells us a delivered
        // SMS is being classified as a failure.
        if (verdict.reason === 'send_rejected') {
            console.warn(
                `[Anbernet] send_rejected — HTTP ${response.status}, body: `
                + JSON.stringify(safeBody).slice(0, 500)
            );
        }

        return {
            success: verdict.success,
            sms_type: isUnicode(message || '') ? 'unicode' : 'text',
            provider_response: {
                // Vendor body FIRST so our own diagnostics win a key collision. It
                // used to be spread last, which let a vendor field named `error`,
                // `http_status`, `receiver`, `provider` or `transtype` silently
                // overwrite our classification in the stored log row.
                ...safeBody,
                provider: 'anbernet',
                http_status: response.status,
                transtype,
                receiver,
                ...(verdict.reason ? { error: verdict.reason } : {}),
                ...(verdict.matched ? { matched: verdict.matched } : {}),
                ...(verdict.senderIdRejected ? { sender_id_rejected: true } : {}),
            },
        };
    }

    /**
     * Read-only credential probe. Cannot send or bill — used to validate config
     * before any real traffic is switched over.
     */
    async checkBalance() {
        const configError = this.balanceConfigError();
        if (configError) return { ok: false, error: configError };

        try {
            const response = await fetch(`${this.baseUrl}/balance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account: this.account,
                    password: this.password,
                    token: this.token,
                }),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });

            const text = await response.text();
            let body;
            try {
                body = JSON.parse(text);
            } catch {
                body = { raw: text.slice(0, 300) };
            }

            if (response.status === 401 || response.status === 403) {
                return { ok: false, error: body?.message || `HTTP ${response.status}`, http_status: response.status, raw: body };
            }

            // Vendor returns { "Balance Status": "account:1234.5678" } — a string.
            const raw = body?.['Balance Status'];
            const balance = typeof raw === 'string' ? parseFloat(raw.split(':').pop()) : null;

            if (!response.ok || balance === null) {
                // Never leave the caller with `undefined` — always say what came back.
                const detail = typeof body?.message === 'string'
                    ? body.message
                    : JSON.stringify(redactSecrets(body?.detail ?? body)).slice(0, 400);

                return {
                    ok: false,
                    error: `HTTP ${response.status}: ${detail}`,
                    http_status: response.status,
                    raw: body,
                };
            }

            return { ok: true, balance, raw: body, http_status: response.status };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }
}

module.exports = AnbernetProvider;
module.exports.normalizeBd = normalizeBd;
module.exports.senderIdError = senderIdError;
module.exports.classifyResponse = classifyResponse;
module.exports.redactSecrets = redactSecrets;
module.exports.resetCircuit = resetCircuit;
module.exports.getCircuitReason = getCircuitReason;
