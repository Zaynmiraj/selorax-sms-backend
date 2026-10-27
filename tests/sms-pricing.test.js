/**
 * Price per SMS (custom purchases): input validation and resolution.
 * Pure functions only — no DB. Run: node --test tests/sms-pricing.test.js
 * (models/sms-pricing.js loads the DB module only when a query runs.)
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { parseUnitPrice, resolveUnitPrice, FALLBACK_UNIT_PRICE } = require('../models/sms-pricing');

test('parseUnitPrice accepts plain decimals up to 4 places and normalizes them', () => {
    assert.equal(parseUnitPrice('0.5'), '0.5');
    assert.equal(parseUnitPrice('0.7000'), '0.7');
    assert.equal(parseUnitPrice(' 1.25 '), '1.25');
    assert.equal(parseUnitPrice(0.65), '0.65');
    assert.equal(parseUnitPrice('100'), '100');
});

test('parseUnitPrice rejects zero, negatives, other notations, junk and out-of-range', () => {
    for (const bad of ['0', '0.0', '-1', '1e3', '0x10', '.5', '+5', 'abc', '', null, undefined, '101', '0.12345']) {
        assert.throws(() => parseUnitPrice(bad), (e) => e.code === 'invalid_price', `expected rejection for ${JSON.stringify(bad)}`);
    }
});

test('resolveUnitPrice: store price, else default, else fallback', () => {
    assert.equal(resolveUnitPrice('0.55', '0.70'), '0.55');
    assert.equal(resolveUnitPrice(null, '0.65'), '0.65');
    assert.equal(resolveUnitPrice(undefined, null), FALLBACK_UNIT_PRICE);
    assert.equal(FALLBACK_UNIT_PRICE, '0.70');
});
