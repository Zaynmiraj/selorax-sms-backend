/**
 * Anbernet credential probe — read-only.
 *
 * Run: node tests/anbernet-balance.js
 *
 * Calls the vendor's /balance endpoint once. It cannot send an SMS and cannot bill
 * anyone. This is the ONLY thing that should touch Anbernet before the canary,
 * because it proves four things in a single request:
 *   1. SMS_API_ACCOUNT + SMS_API_KEY are correct
 *   2. SMS_API_ENDPOINT is the right host (rapi vs wapi)
 *   3. the non-standard port (9978/9956) is reachable from this machine
 *   4. we are not already IP-banned
 *
 * Run it ONCE. Do not loop it, and do not retry it with guessed credentials —
 * repeated failures are exactly what triggers the vendor's IP ban.
 */

require('dotenv').config();
const AnbernetProvider = require('../services/sms-providers/anbernet');

(async () => {
    const provider = new AnbernetProvider({
        baseUrl: process.env.SMS_API_ENDPOINT,
        account: process.env.SMS_API_ACCOUNT,
        apiKey: process.env.SMS_API_KEY,
        password: process.env.SMS_API_PASSWORD,
        // Not used by /balance, but configError() checks it — pass the global default
        // so a missing sender id doesn't mask a credential problem.
        senderId: process.env.SMS_API_SENDER_ID || 'PROBE',
    });

    console.log(`[Anbernet] probing ${process.env.SMS_API_ENDPOINT || '(SMS_API_ENDPOINT unset)'} …`);

    const result = await provider.checkBalance();

    if (result.ok) {
        console.log(`✅ credentials OK — balance: ${result.balance}`);
        console.log('   raw:', JSON.stringify(result.raw));
        console.log('\nAnbernet is the app-wide SMS provider (SMS_API_* in .env).');
        process.exit(0);
    }

    console.error(`❌ probe failed: ${result.error}`);
    if (result.http_status === 401) {
        console.error('   → 401 Wrong credentials. Do NOT retry with guesses; repeated');
        console.error('     failures trigger an IP ban. Re-check account + api_key first.');
    } else if (result.http_status === 403) {
        console.error('   → 403 Too many failed attempts: this IP is ALREADY BANNED.');
        console.error('     Contact Anbernet. Do not keep calling.');
    } else {
        console.error('   → Could be the wrong base URL (rapi vs wapi) or the port being');
        console.error('     blocked outbound. Confirm with Anbernet before retrying.');
    }
    process.exit(1);
})();
