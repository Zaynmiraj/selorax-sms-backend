/**
 * SMS Admin panel — pure-function tests. NO NETWORK, NO DB QUERIES.
 * Run: node --test tests/sms-admin.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const smsAdmin = require('../models/sms-admin');

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

