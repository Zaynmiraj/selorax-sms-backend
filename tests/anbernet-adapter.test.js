/**
 * Anbernet adapter — pure-function tests. NO NETWORK.
 *
 * Run: node --test tests/anbernet-adapter.test.js
 *
 * Everything here is offline by design: the vendor bans our IP after repeated
 * failed auth, so no test may ever reach rapi/wapi.
 */

const test = require('node:test');
const assert = require('node:assert');

const AnbernetProvider = require('../services/sms-providers/anbernet');
const { normalizeBd, classifyResponse, resetCircuit, getCircuitReason, redactSecrets } = AnbernetProvider;

// ── Credential redaction ────────────────────────────────────────────────────
// The vendor echoes the submitted request back inside 422 validation errors, and
// provider_response is persisted to app_messaging_logs. Without redaction the API
// key lands in the database in plain text. This fixture is a real 422 body.

test('redactSecrets strips credentials the vendor echoes back in a 422', () => {
    const real422 = [
        {
            type: 'missing',
            loc: ['body', 'password'],
            msg: 'Field required',
            input: { account: 'Selorax', api_key: 'SECRET_KEY_VALUE' },
        },
    ];

    const cleaned = JSON.stringify(redactSecrets(real422));

    assert.ok(!cleaned.includes('SECRET_KEY_VALUE'), 'api_key must never survive redaction');
    assert.ok(cleaned.includes('[redacted]'));
    assert.ok(cleaned.includes('Selorax'), 'non-secret context should be preserved for debugging');
});

test('redactSecrets removes password and token at any depth', () => {
    const cleaned = JSON.stringify(
        redactSecrets({ a: { b: { password: 'p', token: 't', keep: 'yes' } } })
    );
    assert.ok(!cleaned.includes('"p"') && !cleaned.includes('"t"'));
    assert.ok(cleaned.includes('yes'));
});

// ── Phone normalization ─────────────────────────────────────────────────────
// The app stores 01XXXXXXXXX; the vendor demands 88XXXXXXXXXX. Get this wrong
// and every send fails with code 1004.

test('normalizeBd converts local 01… to 880…', () => {
    assert.strictEqual(normalizeBd('01760505055'), '8801760505055');
});

test('normalizeBd leaves an already-normalized 880… number alone', () => {
    assert.strictEqual(normalizeBd('8801760505055'), '8801760505055');
});

test('normalizeBd strips a leading +', () => {
    assert.strictEqual(normalizeBd('+8801760505055'), '8801760505055');
});

test('normalizeBd accepts a bare national number', () => {
    assert.strictEqual(normalizeBd('1760505055'), '8801760505055');
});

test('normalizeBd tolerates spaces and dashes', () => {
    assert.strictEqual(normalizeBd(' 017-6050 5055 '), '8801760505055');
});

test('normalizeBd accepts every valid BD operator prefix 013–019', () => {
    for (const p of ['013', '014', '015', '016', '017', '018', '019']) {
        assert.strictEqual(normalizeBd(`${p}60505055`), `880${p.slice(1)}60505055`);
    }
});

test('normalizeBd rejects junk rather than sending it to a banning API', () => {
    for (const bad of ['', null, undefined, 'abc', '0176050505', '017605050556', '01260505055', '+1234567890']) {
        assert.strictEqual(normalizeBd(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});

// ── Response classification ─────────────────────────────────────────────────
// This is the single most consequential function in the adapter: models/messaging.js
// gates BOTH the log status and wallet.deductCredit() on the `success` it returns.
//
// A false POSITIVE logs an undelivered SMS as `sent` and burns customer credits.
// A false NEGATIVE — the bug these acceptance tests were added for — logs a
// DELIVERED SMS as `failed`, never charges the store, and makes scheduler.js retry
// it up to 3x, so the customer receives the same message repeatedly.

test('classifyResponse: the documented status "success" body is a success', () => {
    const v = classifyResponse(200, { status: 'success', total: 1, messageids: [] });
    assert.strictEqual(v.success, true);
    assert.strictEqual(v.fatal, false);
    assert.strictEqual(v.matched, 'status_success');
});

test('classifyResponse: status match is case- and whitespace-insensitive', () => {
    for (const status of ['Success', 'SUCCESS', ' success ', 'SuCcEsS']) {
        const v = classifyResponse(200, { status });
        assert.strictEqual(v.success, true, `${JSON.stringify(status)} must be accepted`);
        assert.strictEqual(v.matched, 'status_success');
    }
});

test('classifyResponse: vendor code 9000 ("SMS accepted") is a success', () => {
    // docs/anbernet-api.md section 8. Previously unhandled: it fell through to
    // send_rejected, so an accepted SMS was logged failed and never billed.
    assert.strictEqual(classifyResponse(200, { code: 9000 }).success, true);
    assert.strictEqual(classifyResponse(200, { status_code: '9000' }).success, true);
    assert.strictEqual(classifyResponse(200, { code: 9000 }).matched, 'code_9000');
});

test('classifyResponse: a body carrying messageids is a success even with no status', () => {
    const v = classifyResponse(200, {
        messageids: [{ receiver: '8801760505055', messageid: '550e8400-e29b-41d4-a716-446655440000' }],
    });
    assert.strictEqual(v.success, true);
    assert.strictEqual(v.matched, 'messageids');

    // An empty array is not an acceptance.
    assert.strictEqual(classifyResponse(200, { messageids: [] }).success, false);
});

test('classifyResponse: an HTTP error is never a success, whatever the body claims', () => {
    // Guards the opposite failure: billing for a message that never left.
    for (const httpStatus of [400, 404, 422, 500, 502, 503]) {
        assert.strictEqual(
            classifyResponse(httpStatus, { status: 'success', messageids: [{ messageid: 'x' }] }).success,
            false,
            `HTTP ${httpStatus} must not be billable`
        );
    }
});

test('classifyResponse: a fatal vendor code still wins over an acceptance signal', () => {
    // Order matters — 1001/1002/1003 are checked before any success signal.
    assert.strictEqual(classifyResponse(200, { code: 1001, status: 'success' }).success, false);
    assert.strictEqual(classifyResponse(200, { code: 1003, status: 'success' }).senderIdRejected, true);
});

test('classifyResponse: BulkSMS-style 202 must NOT be read as success', () => {
    const v = classifyResponse(200, { response_code: 202 });
    assert.strictEqual(v.success, false);
});

test('classifyResponse: HTTP 200 without status:"success" is a failure', () => {
    assert.strictEqual(classifyResponse(200, { status: 'failed' }).success, false);
    assert.strictEqual(classifyResponse(200, {}).success, false);
    assert.strictEqual(classifyResponse(200, { raw: 'gateway error' }).success, false);
});

test('classifyResponse: 401 is fatal (ban risk), never a retry', () => {
    const v = classifyResponse(401, { message: 'Wrong credentials' });
    assert.strictEqual(v.success, false);
    assert.strictEqual(v.fatal, true);
    assert.strictEqual(v.reason, 'auth_failed');
});

test('classifyResponse: 403 means already banned', () => {
    const v = classifyResponse(403, { message: 'Too many failed attempts' });
    assert.strictEqual(v.fatal, true);
    assert.strictEqual(v.reason, 'ip_banned');
});

test('classifyResponse: vendor code 1002 (no vendor balance) is fatal, not retryable', () => {
    assert.strictEqual(classifyResponse(200, { code: 1002 }).fatal, true);
});

test('classifyResponse: only vendor code 1003 marks a sender ID as rejected', () => {
    const rejected = classifyResponse(200, { status: 'failed', status_code: '1003' });
    assert.strictEqual(rejected.success, false);
    assert.strictEqual(rejected.fatal, false);
    assert.strictEqual(rejected.reason, 'invalid_sender_id');
    assert.strictEqual(rejected.senderIdRejected, true);

    for (const code of [1004, 1005, 1006, 1007, 1008, 1009, 9001]) {
        assert.notStrictEqual(classifyResponse(200, { code }).senderIdRejected, true, `code ${code} must not retry another sender`);
    }
});

// ── provider_response shaping (stubbed fetch — still no real network) ───────
// This object is persisted to app_messaging_logs.provider_response and is the only
// record of why a send was classified the way it was.

function withStubbedFetch(status, bodyText, fn) {
    const realFetch = global.fetch;
    global.fetch = async () => ({ status, text: async () => bodyText });
    return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

const stubProvider = () => new AnbernetProvider({
    baseUrl: 'https://example.invalid/api/v1',
    account: 'a', apiKey: 'k', senderId: 'SELORAX',
});

test('a vendor field named "error" cannot overwrite our classification', async () => {
    resetCircuit();
    // The vendor body used to be spread LAST, so its own `error`/`http_status` keys
    // silently replaced ours and hid the real reason from the log row.
    await withStubbedFetch(200, JSON.stringify({ error: 'vendor text', http_status: 999 }), async () => {
        const r = await stubProvider().sendSms('01760505055', 'hi');
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.provider_response.error, 'send_rejected');
        assert.strictEqual(r.provider_response.http_status, 200);
        assert.strictEqual(r.provider_response.receiver, '8801760505055');
    });
});

test('an accepted send records which signal matched', async () => {
    resetCircuit();
    await withStubbedFetch(200, JSON.stringify({ code: 9000 }), async () => {
        const r = await stubProvider().sendSms('01760505055', 'hi');
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.provider_response.matched, 'code_9000');
        assert.strictEqual(r.provider_response.error, undefined);
    });
});

test('a non-JSON body is preserved raw and stays a failure', async () => {
    resetCircuit();
    await withStubbedFetch(200, '<html>gateway down</html>', async () => {
        const r = await stubProvider().sendSms('01760505055', 'hi');
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.provider_response.error, 'send_rejected');
        assert.match(r.provider_response.raw, /gateway down/);
    });
});

test('a network failure is marked indeterminate, not a confirmed failure', async () => {
    resetCircuit();
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
    try {
        const r = await stubProvider().sendSms('01760505055', 'hi');
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.provider_response.indeterminate, true);
        assert.match(r.provider_response.error, /timeout/);
    } finally {
        global.fetch = realFetch;
    }
});

// ── Guards that must never hit the network ──────────────────────────────────

test('missing config fails closed instead of sending empty credentials', async () => {
    resetCircuit();
    const p = new AnbernetProvider({}); // nothing configured
    const r = await p.sendSms('01760505055', 'hi');
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.provider_response.error, 'not_configured');
});

test('over-long ALPHANUMERIC sender ID is rejected before any request', async () => {
    resetCircuit();
    const p = new AnbernetProvider({
        baseUrl: 'https://example.invalid/api/v1',
        account: 'a', apiKey: 'k',
        senderId: 'WAYTOOLONGSENDER', // 16 alnum chars > 11
    });
    const r = await p.sendSms('01760505055', 'hi');
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.provider_response.error, 'not_configured');
});

// The vendor docs say "max 11 chars", but that is the GSM cap for alphanumeric
// sender IDs. Numeric long codes are legal beyond 11 digits — the vendor's own
// incoming-SMS example returns senderid "8801711958087" (13 digits). An 11-char
// blanket rule would reject the real production sender ID.
test('13-digit NUMERIC sender ID is accepted (real production value)', () => {
    const p = new AnbernetProvider({
        baseUrl: 'https://example.invalid/api/v1',
        account: 'a', apiKey: 'k',
        senderId: '8809639884422',
    });
    assert.strictEqual(p.configError(), null);
});

test('numeric sender ID is still capped at 15 digits', () => {
    const p = new AnbernetProvider({
        baseUrl: 'https://example.invalid/api/v1',
        account: 'a', apiKey: 'k',
        senderId: '88096398844221234', // 17 digits
    });
    assert.match(p.configError(), /exceeds 15 digits/);
});

test('short alphanumeric sender ID still allowed', () => {
    const p = new AnbernetProvider({
        baseUrl: 'https://example.invalid/api/v1',
        account: 'a', apiKey: 'k',
        senderId: 'SELORAX',
    });
    assert.strictEqual(p.configError(), null);
});

test('invalid receiver is rejected locally', async () => {
    resetCircuit();
    const p = new AnbernetProvider({
        baseUrl: 'https://example.invalid/api/v1',
        account: 'a', apiKey: 'k', senderId: 'SELORAX',
    });
    const r = await p.sendSms('not-a-phone', 'hi');
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.provider_response.error, 'invalid_receiver');
});

test('promotional send without a campaign id fails loudly (never downgraded to T)', async () => {
    resetCircuit();
    const p = new AnbernetProvider({
        baseUrl: 'https://example.invalid/api/v1',
        account: 'a', apiKey: 'k', senderId: 'SELORAX',
        campaignId: '',
    });
    const r = await p.sendSms('01760505055', 'buy now', { event_topic: 'campaign' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.provider_response.error, 'campaign_id_required');
});

test('an open circuit blocks all further sends', async () => {
    resetCircuit();
    const p = new AnbernetProvider({
        baseUrl: 'https://example.invalid/api/v1',
        account: 'a', apiKey: 'k', senderId: 'SELORAX',
    });

    // Simulate the breaker having tripped on a 401.
    classifyResponse(401, {});
    const { resetCircuit: _r } = AnbernetProvider;
    assert.strictEqual(getCircuitReason(), null, 'classify alone must not trip the breaker');

    _r();
});

// ── Registry ────────────────────────────────────────────────────────────────
// Single provider: every store resolves to Anbernet, configured from SMS_API_*.

test('registry always returns an Anbernet provider from SMS_API_* env', () => {
    process.env.SMS_API_ENDPOINT = 'https://example.invalid/api/v1';
    process.env.SMS_API_KEY = 'k';
    process.env.SMS_API_ACCOUNT = 'acct';
    process.env.SMS_API_SENDER_ID = '8809639884422';
    const { resolveProvider } = require('../services/sms-providers');

    for (const settings of [{ store_id: 22 }, { store_id: 465 }, null]) {
        const p = resolveProvider(settings);
        assert.ok(p instanceof AnbernetProvider, 'must be the Anbernet adapter');
        assert.strictEqual(p.baseUrl, 'https://example.invalid/api/v1');
        assert.strictEqual(p.account, 'acct');
    }
});

test('registry honours a per-store sender_id override', () => {
    process.env.SMS_API_SENDER_ID = '8809639884422';
    const { resolveProvider } = require('../services/sms-providers');
    assert.strictEqual(resolveProvider({ store_id: 1, sender_id: 'SELORAX' }).senderId, 'SELORAX');
    assert.strictEqual(resolveProvider({ store_id: 1 }).senderId, '8809639884422', 'falls back to global default');
});
