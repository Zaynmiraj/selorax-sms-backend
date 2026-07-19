const AnbernetProvider = require('./anbernet');

/**
 * SMS provider registry.
 *
 * The app sends through a single provider: Anbernet. Its credentials live under the
 * standard, provider-neutral SMS_API_* env names so the same convention carries over
 * to the other SeloraX apps:
 *
 *   SMS_API_ENDPOINT   base URL          e.g. https://wapi.anbernet.com:9956/api/v1
 *   SMS_API_KEY        token / api key
 *   SMS_API_SENDER_ID  default sender id (per-store settings.sender_id overrides it)
 *   SMS_API_ACCOUNT    account name
 *   SMS_API_PASSWORD   account password  (required by /balance and /sendsms auth)
 *   SMS_API_CAMPAIGN_ID  approved campaign id, only needed for promotional traffic
 *
 * (History: this used to switch between BulkSMS and Anbernet via SMS_PROVIDER +
 * a per-store canary. Once every store was migrated to Anbernet, BulkSMS and the
 * selection logic were removed. Reintroduce a switch here if a second provider is
 * ever added.)
 */

/**
 * Resolve the SMS provider for a store.
 * @param {object|null} settings row from app_messaging_settings (SELECT *)
 */
function resolveProvider(settings) {
    return new AnbernetProvider({
        baseUrl: process.env.SMS_API_ENDPOINT,
        account: process.env.SMS_API_ACCOUNT,
        apiKey: process.env.SMS_API_KEY,
        password: process.env.SMS_API_PASSWORD,
        // Per-store sender ID wins, global default backs it. settings.sender_id is
        // what the admin panel will write per store; empty everywhere today.
        senderId: settings?.sender_id || process.env.SMS_API_SENDER_ID,
        campaignId: process.env.SMS_API_CAMPAIGN_ID,
    });
}

module.exports = { resolveProvider };
