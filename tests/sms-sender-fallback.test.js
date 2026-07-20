/**
 * Sender fallback helpers — pure tests. NO NETWORK, NO DB QUERIES.
 * Run: node --test tests/sms-sender-fallback.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildSenderAttemptOrder } = require('../services/sender-fallback');

test('buildSenderAttemptOrder tries assigned sender before unique global priorities', () => {
    assert.deepStrictEqual(
        buildSenderAttemptOrder({
            assignedSenderId: 'STOREID',
            globalSenderIds: [{ value: 'GLOBAL1', global_priority: 1 }, { value: 'GLOBAL2', global_priority: 2 }],
            envSenderId: 'ENVONLY',
        }),
        ['STOREID', 'GLOBAL1', 'GLOBAL2']
    );
});

test('buildSenderAttemptOrder omits a global sender already assigned to the store', () => {
    assert.deepStrictEqual(
        buildSenderAttemptOrder({
            assignedSenderId: 'GLOBAL1',
            globalSenderIds: [{ value: 'GLOBAL1', global_priority: 1 }, { value: 'GLOBAL2', global_priority: 2 }],
            envSenderId: 'ENVONLY',
        }),
        ['GLOBAL1', 'GLOBAL2']
    );
});

test('buildSenderAttemptOrder uses the environment sender only when no catalog global sender exists', () => {
    assert.deepStrictEqual(
        buildSenderAttemptOrder({ assignedSenderId: null, globalSenderIds: [], envSenderId: 'ENVONLY' }),
        ['ENVONLY']
    );
    assert.deepStrictEqual(
        buildSenderAttemptOrder({
            assignedSenderId: null,
            globalSenderIds: [{ value: 'GLOBAL1', global_priority: 1 }],
            envSenderId: 'ENVONLY',
        }),
        ['GLOBAL1']
    );
});
