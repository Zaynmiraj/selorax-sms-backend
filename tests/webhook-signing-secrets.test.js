const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeWebhookSigningSecrets,
    validateDatabaseIdentifier,
} = require('../models/messaging');
const { connection } = require('../startup/db');

test.after(() => {
    connection.end();
});

test('normalizeWebhookSigningSecrets keeps unique non-empty secrets', () => {
    assert.deepEqual(
        normalizeWebhookSigningSecrets(['a', '', null, 'a', 'b']),
        ['a', 'b']
    );
});

test('validateDatabaseIdentifier accepts safe database names', () => {
    assert.equal(validateDatabaseIdentifier('selorax'), 'selorax');
    assert.equal(validateDatabaseIdentifier('selorax_sms_2026'), 'selorax_sms_2026');
});

test('validateDatabaseIdentifier rejects unsafe database names', () => {
    assert.equal(validateDatabaseIdentifier('selorax;DROP TABLE stores'), null);
    assert.equal(validateDatabaseIdentifier('selorax-sms'), null);
});
