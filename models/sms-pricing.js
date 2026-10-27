/**
 * Price per SMS for CUSTOM credit purchases (packages keep their own prices).
 *
 * Resolution, per store:
 *   app_messaging_settings.sms_unit_price  (set by an admin for that store)
 *   → app_messaging_config 'default_sms_unit_price'  (set by an admin)
 *   → FALLBACK_UNIT_PRICE (what the app always charged before migration 013)
 *
 * Prices are handled as strings with ≤ 4 decimals, matching DECIMAL(10,4), and
 * only multiplied out once for a purchase total.
 */
// Loaded on first use, so the pure rules below (parseUnitPrice,
// resolveUnitPrice) can be tested without a database driver.
let pool = null;
function db() {
    if (!pool) pool = require('../startup/db').connection.promise();
    return pool;
}

const FALLBACK_UNIT_PRICE = '0.70';
const DEFAULT_KEY = 'default_sms_unit_price';
const MAX_UNIT_PRICE = 100;
const CACHE_MS = 30 * 1000;

let defaultCache = null; // { value, at }

function invalid(message) {
    return Object.assign(new Error(message), { status: 400, code: 'invalid_price' });
}

/**
 * Validate an admin-entered price. Plain decimal notation ONLY — Number()
 * would happily read "1e3" as 1000 or "0x10" as 16 — then 0 < price ≤ 100.
 * Returns a normalized string (e.g. "0.65").
 */
function parseUnitPrice(input) {
    const raw = typeof input === 'number' ? String(input) : String(input ?? '').trim();
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
        throw invalid('Price must be a plain number with at most 4 decimals, e.g. 0.65.');
    }
    const value = Number(raw);
    if (!(value > 0)) throw invalid('Price must be greater than 0.');
    if (value > MAX_UNIT_PRICE) throw invalid(`Price cannot exceed ${MAX_UNIT_PRICE}.`);
    return String(value);
}

/** Pure: the store's own price if set, else the default, else the fallback. */
function resolveUnitPrice(storePrice, defaultPrice) {
    if (storePrice !== null && storePrice !== undefined && storePrice !== '') return String(Number(storePrice));
    if (defaultPrice !== null && defaultPrice !== undefined && defaultPrice !== '') return String(Number(defaultPrice));
    return FALLBACK_UNIT_PRICE;
}

async function getDefaultUnitPrice() {
    if (defaultCache && Date.now() - defaultCache.at < CACHE_MS) return defaultCache.value;
    let value = FALLBACK_UNIT_PRICE;
    try {
        const [rows] = await db().query(
            'SELECT config_value FROM app_messaging_config WHERE config_key = ?', [DEFAULT_KEY]
        );
        if (rows[0]?.config_value) value = String(Number(rows[0].config_value));
    } catch (e) {
        // Table not migrated yet (013) — keep charging what we always did.
        if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    defaultCache = { value, at: Date.now() };
    return value;
}

async function setDefaultUnitPrice(input, adminId) {
    const value = parseUnitPrice(input);
    const previous = await getDefaultUnitPrice();
    await db().query(/*sql*/`
        INSERT INTO app_messaging_config (config_key, config_value, updated_by_admin_id)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_by_admin_id = VALUES(updated_by_admin_id)
    `, [DEFAULT_KEY, value, adminId || null]);
    defaultCache = null;
    return { previous, value };
}

async function getStoreUnitPrice(store_id) {
    const [rows, default_price] = await Promise.all([
        db().query('SELECT sms_unit_price FROM app_messaging_settings WHERE store_id = ?', [store_id])
            .then(([r]) => r)
            // Column not migrated yet (013) — every store is on the default.
            .catch((e) => { if (e.code === 'ER_BAD_FIELD_ERROR') return []; throw e; }),
        getDefaultUnitPrice(),
    ]);
    const raw = rows[0]?.sms_unit_price;
    const store_price = raw === null || raw === undefined ? null : String(Number(raw));
    return {
        unit_price: resolveUnitPrice(store_price, default_price),
        source: store_price !== null ? 'store' : 'default',
        store_price,
        default_price,
    };
}

/** `input` null/'' clears the store's price (back to the default). */
async function setStoreUnitPrice(store_id, input) {
    const value = input === null || input === undefined || input === '' ? null : parseUnitPrice(input);
    const before = await getStoreUnitPrice(store_id);
    const [result] = await db().query(
        'UPDATE app_messaging_settings SET sms_unit_price = ? WHERE store_id = ?', [value, store_id]
    );
    if (result.affectedRows === 0) {
        throw Object.assign(new Error('Store has not installed the app.'), { status: 404, code: 'store_not_installed' });
    }
    return { previous: before.store_price, value };
}

module.exports = {
    FALLBACK_UNIT_PRICE,
    MAX_UNIT_PRICE,
    parseUnitPrice,
    resolveUnitPrice,
    getDefaultUnitPrice,
    setDefaultUnitPrice,
    getStoreUnitPrice,
    setStoreUnitPrice,
};
