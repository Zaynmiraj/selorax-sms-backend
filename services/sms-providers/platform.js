const crypto = require('crypto');

/**
 * SeloraX Messages platform adapter — the ONLY way this app sends SMS.
 *
 * We are a "partner" organization on the platform (smsapi.selorax.io). Every
 * SMS goes to its POST /api/v1/messages with our partner API key and the
 * store's id as `store_ref`; the platform picks that store's sender ID and
 * gateway (managed in the platform's /admin) and charges our partner wallet.
 * Store SMS credits stay in this app (models/messaging-wallet.js).
 *
 * Env:
 *   MESSAGING_PLATFORM_URL      base URL, e.g. https://smsapi.selorax.io
 *   MESSAGING_PLATFORM_API_KEY  partner API key (sx_…)
 *
 * Same contract as the old Anbernet adapter so callers did not change:
 * sendSms() never throws and returns { success, sms_type, provider_response }.
 */

// Must stay ABOVE the platform's own gateway timeout (30 s): giving up first
// would record a failure for an SMS the platform then sends and bills.
const TIMEOUT_MS = 40000;
const MAX_ATTEMPTS = 3;
// After a timeout, ask at most once more (same key → the platform replays or
// says it is still working); never wait 3 × 40 s on a hung platform.
const MAX_TIMEOUTS = 2;

// The connection never got made: the SMS definitely did NOT go out.
// (Node/undici codes, TLS handshake failures, and Bun's spelling.)
const CONNECT_ERRORS = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
    'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ConnectionRefused',
]);
const GSM7_REGEX = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜa-zäöñüà^{}\\[\]~|€]*$/;

// Platform error `type` → our own code. Anything unlisted becomes `send_rejected`.
const ERROR_CODES = {
    insufficient_funds: 'platform_insufficient_funds',
    sender_id_unavailable: 'no_sender_id',
    sending_unavailable: 'sending_unavailable',
    pricing_unavailable: 'pricing_unavailable',
    invalid_recipient: 'invalid_receiver',
    suppressed: 'suppressed',
    rate_limited: 'rate_limited',
    unauthorized: 'auth_failed',
};

// A 422 invalid_request is only ever the platform refusing `store_ref` /
// `promotional` because our org is not (yet) a partner — systemic.
function codeForError(status, type) {
    if (status === 422 && type === 'invalid_request') return 'partner_not_enabled';
    return ERROR_CODES[type] || null;
}

function baseUrl() {
    return (process.env.MESSAGING_PLATFORM_URL || '').replace(/\/+$/, '');
}

function isConfigured() {
    return Boolean(baseUrl() && process.env.MESSAGING_PLATFORM_API_KEY);
}

/** Never let the API key reach a log or provider_response. */
function redactKey(text) {
    const key = process.env.MESSAGING_PLATFORM_API_KEY;
    const s = String(text ?? '');
    return key ? s.split(key).join('[redacted]') : s;
}

async function request(method, path, body, { idempotencyKey } = {}) {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MESSAGING_PLATFORM_API_KEY}`,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(`${baseUrl()}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }
    return { status: response.status, data };
}

// Worth retrying with the SAME Idempotency-Key: the platform either never
// recorded the request (5xx before dispatch releases the key), is still on it
// (409), or replays the stored result — so a retry can never double-send.
function isRetryable(status) {
    return status === 409 || status >= 500;
}

// Still unresolved after the last attempt = the SMS may or may not have gone
// out: 409 (platform still processing it) or a proxy gateway timeout (504).
// A 502/503 means the request never reached a working platform: not sent.
function isIndeterminate(status) {
    return status === 409 || status === 504;
}

/**
 * About the NUMBER itself — retrying can never help. Everything else
 * (configuration, platform down, no sender yet, …) is fixable and retried.
 */
const PERMANENT_ERRORS = new Set(['invalid_receiver', 'suppressed']);

/**
 * The platform/link is unusable for EVERY store right now (misconfigured,
 * down, out of service). Callers should hold the work and try later instead
 * of failing it: nothing was sent and nothing was charged.
 */
const SYSTEMIC_ERRORS = new Set([
    'not_configured', 'auth_failed', 'partner_not_enabled', 'platform_unreachable', 'platform_unavailable', 'platform_error',
    'sending_unavailable', 'pricing_unavailable', 'platform_insufficient_funds', 'rate_limited',
]);

function fail(error, extra = {}) {
    return {
        success: false,
        sms_type: null,
        provider_response: { provider: 'platform', error, ...extra },
    };
}

/**
 * Send one SMS for a store. `store_id` omitted = a send for the app itself
 * (admin login OTP): the platform then uses our partner's general sender.
 */
async function sendSms(phone, message, { event_topic, store_id } = {}) {
    if (!isConfigured()) {
        return fail('not_configured', { reason: 'MESSAGING_PLATFORM_URL / MESSAGING_PLATFORM_API_KEY not set' });
    }

    const body = {
        to: String(phone),
        body: message,
        ...(store_id !== undefined && store_id !== null ? { store_ref: String(store_id) } : {}),
        ...(event_topic === 'campaign' ? { promotional: true } : {}),
    };
    const idempotencyKey = crypto.randomUUID();
    const sms_type = GSM7_REGEX.test(message || '') ? 'text' : 'unicode';

    let res = null;
    let lastError = null;
    let everReached = false; // did ANY attempt possibly reach the platform?
    let maybeSent = false;   // did an earlier attempt end without a definite answer?
    let timeouts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            res = await request('POST', '/api/v1/messages', body, { idempotencyKey });
            lastError = null;
            everReached = true;
            if (!isRetryable(res.status) && res.status !== 429) break;
            if (isIndeterminate(res.status)) maybeSent = true;
        } catch (err) {
            res = null;
            lastError = err;
            const code = err?.cause?.code || err?.code;
            if (!CONNECT_ERRORS.has(code)) {
                everReached = true;
                maybeSent = true;
            }
            if (err?.name === 'TimeoutError' && ++timeouts >= MAX_TIMEOUTS) break;
        }
        if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, res?.status === 409 || res?.status === 429 ? 3000 : 500 * attempt));
        }
    }

    if (!res && !everReached) {
        // Never connected: definitely not sent, safe to try again later.
        return fail('platform_unreachable', {
            reason: redactKey(lastError?.cause?.code || lastError?.message),
            idempotency_key: idempotencyKey,
        });
    }

    if (!res) {
        // Timeout / dropped connection: the platform MAY have sent it. Not
        // billed here, flagged `indeterminate` so nothing auto-retries it (a
        // retry uses a new key and could send it twice).
        return fail('network_error', {
            indeterminate: true,
            reason: redactKey(lastError?.name === 'TimeoutError' ? 'timeout' : lastError?.message),
            idempotency_key: idempotencyKey,
        });
    }

    const { status, data } = res;
    // An earlier attempt may have gone through, and this final answer does not
    // settle it: a 5xx/429/404 comes from in front of the idempotency record,
    // so it says nothing about whether that earlier attempt sent the SMS.
    // (A replayed business error — 4xx with an error type — DOES settle it.)
    const unsettling = status >= 500 || status === 429 || status === 404;
    if (status !== 200 && (isIndeterminate(status) || (maybeSent && unsettling))) {
        return fail('platform_pending', {
            indeterminate: true,
            http_status: status,
            reason: redactKey(data?.error?.message || ''),
            idempotency_key: idempotencyKey,
        });
    }
    if (status === 200 && !data) {
        // Accepted, but the body could not be read: it was most likely sent.
        return fail('unreadable_response', { indeterminate: true, http_status: status, idempotency_key: idempotencyKey });
    }
    if (status !== 200) {
        const type = data?.error?.type;
        const mapped = codeForError(status, type);
        const fallback = status === 502 || status === 503 ? 'platform_unavailable'
            : status >= 500 ? 'platform_error'
                : status === 404 ? 'platform_unavailable' // wrong URL / platform not deployed
                    : 'send_rejected';
        return fail(mapped || fallback, {
            http_status: status,
            type: type || null,
            reason: redactKey(data?.error?.message || ''),
            idempotency_key: idempotencyKey,
        });
    }

    const msg = Array.isArray(data?.messages) ? data.messages[0] : null;
    const skipped = Array.isArray(data?.skipped) && data.skipped.length > 0;
    // `unknown` = handed to the gateway with an indeterminate outcome; it may
    // well have been delivered and is charged to us, so it counts as sent.
    const success = msg?.status === 'sent' || msg?.status === 'unknown';
    const provider_response = {
        provider: 'platform',
        http_status: status,
        status: msg?.status || (skipped ? 'suppressed' : null),
        message_id: msg?.id || null,
        batch_id: data?.batch_id || null,
        sender_id: data?.from || null,
        segments: msg?.segments ?? null,
        // (The platform's per-SMS price is deliberately NOT stored: logs are
        // shown to merchants and it is SeloraX's wholesale cost.)
        ...(success ? {} : { error: skipped ? 'suppressed' : 'send_rejected' }),
    };
    return { success, sms_type, provider_response };
}

/**
 * Register or refresh a store's display details on the platform
 * (PUT /api/v1/stores/{store_id}). Best-effort: sending registers a store
 * anyway, so a failure here is only logged.
 */
async function registerStore(store_id, { name, domain, active } = {}) {
    if (!isConfigured()) return { ok: false, error: 'not_configured' };
    try {
        const payload = {};
        if (name !== undefined) payload.name = name;
        if (domain !== undefined) payload.domain = domain;
        if (active !== undefined) payload.active = active;
        const res = await request('PUT', `/api/v1/stores/${encodeURIComponent(String(store_id))}`, payload);
        return res.status === 200 ? { ok: true } : { ok: false, error: res.data?.error?.type || `http_${res.status}` };
    } catch (err) {
        return { ok: false, error: redactKey(err.message) };
    }
}

module.exports = { sendSms, registerStore, isConfigured, ERROR_CODES, PERMANENT_ERRORS, SYSTEMIC_ERRORS };
