/**
 * SMS Admin panel — pure-function tests. NO NETWORK, NO DB QUERIES.
 * Run: node --test tests/sms-admin.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const smsAdmin = require('../models/sms-admin');
const catalog = require('../models/sms-sender-ids');

// ── Phone normalization ──────────────────────────────────────────────────────
// Admins are stored/looked-up in local 11-digit form regardless of input format,
// so the seeded super admin (01731620933) is found whether the user types
// 01731620933, 8801731620933, or +8801731620933.
test('toLocalPhone folds every accepted format to 01XXXXXXXXX', () => {
    assert.strictEqual(smsAdmin.toLocalPhone('01731620933'), '01731620933');
    assert.strictEqual(smsAdmin.toLocalPhone('8801731620933'), '01731620933');
    assert.strictEqual(smsAdmin.toLocalPhone('+8801731620933'), '01731620933');
    assert.strictEqual(smsAdmin.toLocalPhone('01760505055'), '01760505055');
});

test('toLocalPhone rejects junk', () => {
    for (const bad of ['', null, undefined, 'abc', '0176050505', '01260505055']) {
        assert.strictEqual(smsAdmin.toLocalPhone(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});

test('generateOtp is always a 4-digit string', () => {
    for (let i = 0; i < 200; i++) {
        const otp = smsAdmin.generateOtp();
        assert.match(otp, /^\d{4}$/, `bad otp: ${otp}`);
    }
});

// ── Sender-ID catalog validation ─────────────────────────────────────────────
// The catalog reuses the provider's exact rules, so a value Anbernet would
// reject can never be saved or assigned.
test('validateValue accepts a numeric long code and a short alphanumeric mask', () => {
    assert.strictEqual(catalog.validateValue('8809639884422'), null);
    assert.strictEqual(catalog.validateValue('SELORAX'), null);
});

test('validateValue rejects empty, over-long numeric, and over-long alphanumeric', () => {
    assert.ok(catalog.validateValue(''));                     // required
    assert.ok(catalog.validateValue('88096398844221234'));    // 17 digits > 15
    assert.ok(catalog.validateValue('WAYTOOLONGSENDER'));     // 16 alnum > 11
});

test('classifyType distinguishes numeric long codes from alphanumeric masks', () => {
    assert.strictEqual(catalog.classifyType('8809639884422'), 'numeric');
    assert.strictEqual(catalog.classifyType('SELORAX'), 'alnum');
    assert.strictEqual(catalog.classifyType('SX-01'), 'alnum');
});
