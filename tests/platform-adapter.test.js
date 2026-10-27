/**
 * The SeloraX Messages platform adapter — offline, `fetch` is mocked.
 * Run: node --test tests/platform-adapter.test.js
 */
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.MESSAGING_PLATFORM_URL = 'https://platform.test/';
process.env.MESSAGING_PLATFORM_API_KEY = 'sx_secret_key_123';

const platform = require('../services/sms-providers/platform');

const realFetch = global.fetch;
let calls = [];

function mockFetch(...responses) {
    calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return { status: next.status, json: async () => next.body };
    };
}

test.afterEach(() => {
    global.fetch = realFetch;
});

const sentBody = {
    batch_id: 'b1',
    from: 'SELORAX',
    messages: [{ id: 'm1', to: '8801760505055', status: 'sent', segments: 1, price: '0.35' }],
    skipped: [],
};

test('sends to /api/v1/messages with the store as store_ref and an Idempotency-Key', async () => {
    mockFetch({ status: 200, body: sentBody });
    const res = await platform.sendSms('01760505055', 'hello', { event_topic: 'order.confirmed', store_id: 42 });

    assert.equal(res.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://platform.test/api/v1/messages');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sx_secret_key_123');
    assert.ok(calls[0].init.headers['Idempotency-Key']);
    assert.deepEqual(calls[0].body, { to: '01760505055', body: 'hello', store_ref: '42' });
    assert.equal(res.provider_response.message_id, 'm1');
    assert.equal(res.provider_response.sender_id, 'SELORAX');
});

test('marks campaign sends promotional, and omits store_ref when there is no store', async () => {
    mockFetch({ status: 200, body: sentBody }, { status: 200, body: sentBody });
    await platform.sendSms('01760505055', 'sale', { event_topic: 'campaign', store_id: 7 });
    await platform.sendSms('01760505055', 'otp 123', { event_topic: 'admin.otp' });
    assert.equal(calls[0].body.promotional, true);
    assert.equal(calls[1].body.store_ref, undefined);
    assert.equal(calls[1].body.promotional, undefined);
});

test('treats an "unknown" outcome as sent (it may have gone out and was charged)', async () => {
    mockFetch({ status: 200, body: { ...sentBody, messages: [{ ...sentBody.messages[0], status: 'unknown' }] } });
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, true);
    assert.equal(res.provider_response.status, 'unknown');
});

test('a failed message is a failure with an error code', async () => {
    mockFetch({ status: 200, body: { ...sentBody, messages: [{ ...sentBody.messages[0], status: 'failed' }] } });
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, false);
    assert.equal(res.provider_response.error, 'send_rejected');
});

test('maps platform error types to our codes, without retrying a 4xx', async () => {
    mockFetch({ status: 422, body: { error: { type: 'sender_id_unavailable', message: 'no sender' } } });
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, false);
    assert.equal(res.provider_response.error, 'no_sender_id');
    assert.equal(res.provider_response.http_status, 422);
    assert.equal(calls.length, 1);
});

test('retries a timeout with the same Idempotency-Key', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    mockFetch(timeout, { status: 200, body: sentBody });
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
});

test('network failures on every attempt → indeterminate failure, never throws', async () => {
    mockFetch(new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'));
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, false);
    assert.equal(res.provider_response.error, 'network_error');
    assert.equal(res.provider_response.indeterminate, true);
    assert.equal(calls.length, 3);
});

test('still in progress (409) after every attempt → indeterminate, not a plain failure', async () => {
    const busy = { status: 409, body: { error: { type: 'request_in_progress', message: 'busy' } } };
    mockFetch(busy, busy, busy);
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, false);
    assert.equal(res.provider_response.indeterminate, true);
    assert.equal(res.provider_response.error, 'platform_pending');
});

test('a 200 with an unreadable body is indeterminate (it was most likely sent)', async () => {
    mockFetch({ status: 200, body: null });
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, false);
    assert.equal(res.provider_response.indeterminate, true);
});

test('a plain 500 is a definite failure after the retries', async () => {
    const err = { status: 500, body: { error: { type: 'internal_error', message: 'boom' } } };
    mockFetch(err, err, err);
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.provider_response.error, 'platform_error');
    assert.equal(res.provider_response.indeterminate, undefined);
});

test('never puts the API key into provider_response', async () => {
    const leak = { status: 500, body: { error: { type: 'internal_error', message: 'bad key sx_secret_key_123' } } };
    mockFetch(leak, leak, leak);
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    assert.equal(res.success, false);
    assert.ok(!JSON.stringify(res).includes('sx_secret_key_123'));
});

test('registerStore PUTs display details to /api/v1/stores/{id}', async () => {
    mockFetch({ status: 200, body: { store_ref: '42' } });
    const r = await platform.registerStore(42, { name: 'Shop', domain: 'shop.test', active: true });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls[0].url, 'https://platform.test/api/v1/stores/42');
    assert.equal(calls[0].init.method, 'PUT');
    assert.deepEqual(calls[0].body, { name: 'Shop', domain: 'shop.test', active: true });
});

test('not configured → fails without calling out', async () => {
    const saved = process.env.MESSAGING_PLATFORM_API_KEY;
    delete process.env.MESSAGING_PLATFORM_API_KEY;
    mockFetch();
    const res = await platform.sendSms('01760505055', 'x', { store_id: 1 });
    process.env.MESSAGING_PLATFORM_API_KEY = saved;
    assert.equal(res.provider_response.error, 'not_configured');
    assert.equal(calls.length, 0);
});
