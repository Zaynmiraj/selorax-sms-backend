const platform = require('./platform');

/**
 * SMS transport.
 *
 * Every SMS goes through the SeloraX Messages platform as a partner
 * (./platform.js). Which sender ID and gateway a store uses is decided THERE,
 * per store, in the platform's /admin — this app no longer knows about
 * Anbernet, sender IDs or gateways.
 *
 * (History: BulkSMS, then a direct Anbernet adapter with a local sender-ID
 * catalog and fallback loop. Both removed when sending moved to the platform.)
 */
function resolveProvider() {
    return platform;
}

module.exports = { resolveProvider };
