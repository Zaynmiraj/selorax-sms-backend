/**
 * Sender-ID catalog — the global pool of Anbernet-approved sender IDs the admin
 * panel manages. Stores are assigned one of these values (written into the
 * existing app_messaging_settings.sender_id column, so the send path is unchanged).
 *
 * getGlobalDefault() is consulted by messaging.getSettings() on the hot send path,
 * so it is cached in-memory with a short TTL to avoid a query per send.
 */
const { connection } = require('../startup/db');
const { senderIdError } = require('../services/sms-providers/anbernet');

const db = connection.promise();

// ── Global-default cache (hot path) ─────────────────────────────────────────
let _defaultCache = { value: null, expiresAt: 0 };
const DEFAULT_CACHE_TTL = 60 * 1000; // 60s

function clearDefaultCache() {
    _defaultCache = { value: null, expiresAt: 0 };
}

/**
 * The active, global-default sender-ID string, or null if none is set.
 * Cached so getSettings() stays cheap. Falls back to null on any DB error so a
 * catalog problem can never break sending (env SMS_API_SENDER_ID still backstops).
 */
async function getGlobalDefault() {
    if (Date.now() < _defaultCache.expiresAt) return _defaultCache.value;
    let value = null;
    try {
        const [rows] = await db.query(/*sql*/`
            SELECT value FROM sms_sender_ids
            WHERE is_global_default = 1 AND is_active = 1
            ORDER BY updated_at DESC
            LIMIT 1
        `);
        value = rows[0]?.value || null;
    } catch (e) {
        // Table missing (migration not applied) or transient error — behave as
        // if no global default exists. Never throw on the send path.
        value = null;
    }
    _defaultCache = { value, expiresAt: Date.now() + DEFAULT_CACHE_TTL };
    return value;
}

// ── Validation ──────────────────────────────────────────────────────────────
// Reuse the provider's exact sender-ID rules (numeric <=15, alnum <=11) so the
// catalog can never hold a value Anbernet would reject.
function classifyType(value) {
    return /^\d+$/.test(String(value)) ? 'numeric' : 'alnum';
}

function validateValue(value) {
    const v = String(value || '').trim();
    if (!v) return 'sender ID value is required';
    return senderIdError(v); // null when valid
}

// ── CRUD ────────────────────────────────────────────────────────────────────
async function listSenderIds() {
    const [rows] = await db.query(/*sql*/`
        SELECT sender_id_pk, value, type, label, is_global_default, is_active, created_at, updated_at
        FROM sms_sender_ids
        ORDER BY is_global_default DESC, is_active DESC, value ASC
    `);
    return rows;
}

async function getById(id) {
    const [rows] = await db.query(/*sql*/`
        SELECT * FROM sms_sender_ids WHERE sender_id_pk = ? LIMIT 1
    `, [id]);
    return rows[0] || null;
}

async function createSenderId({ value, label, is_global_default, created_by }) {
    const v = String(value || '').trim();
    const err = validateValue(v);
    if (err) { const e = new Error(err); e.code = 'invalid_sender_id'; throw e; }

    const type = classifyType(v);
    const asDefault = is_global_default ? 1 : 0;

    // Only one global default at a time.
    if (asDefault) await db.query(`UPDATE sms_sender_ids SET is_global_default = 0`);

    try {
        const [res] = await db.query(/*sql*/`
            INSERT INTO sms_sender_ids (value, type, label, is_global_default, created_by)
            VALUES (?, ?, ?, ?, ?)
        `, [v, type, label || null, asDefault, created_by || null]);
        clearDefaultCache();
        return getById(res.insertId);
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            const dup = new Error(`Sender ID "${v}" already exists in the catalog.`);
            dup.code = 'duplicate_sender_id';
            throw dup;
        }
        throw e;
    }
}

async function updateSenderId(id, { value, label, is_global_default, is_active }) {
    const existing = await getById(id);
    if (!existing) { const e = new Error('Sender ID not found.'); e.code = 'not_found'; throw e; }

    const sets = [];
    const params = [];

    if (value !== undefined) {
        const v = String(value || '').trim();
        const err = validateValue(v);
        if (err) { const e = new Error(err); e.code = 'invalid_sender_id'; throw e; }
        sets.push('value = ?', 'type = ?');
        params.push(v, classifyType(v));
    }
    if (label !== undefined) { sets.push('label = ?'); params.push(label || null); }
    if (is_active !== undefined) { sets.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (is_global_default !== undefined) {
        if (is_global_default) await db.query(`UPDATE sms_sender_ids SET is_global_default = 0`);
        sets.push('is_global_default = ?'); params.push(is_global_default ? 1 : 0);
    }

    if (sets.length) {
        params.push(id);
        try {
            await db.query(`UPDATE sms_sender_ids SET ${sets.join(', ')} WHERE sender_id_pk = ?`, params);
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') {
                const dup = new Error('Another catalog entry already uses that value.');
                dup.code = 'duplicate_sender_id';
                throw dup;
            }
            throw e;
        }
    }
    clearDefaultCache();
    return getById(id);
}

async function deleteSenderId(id) {
    const existing = await getById(id);
    if (!existing) { const e = new Error('Sender ID not found.'); e.code = 'not_found'; throw e; }
    await db.query(`DELETE FROM sms_sender_ids WHERE sender_id_pk = ?`, [id]);
    clearDefaultCache();
    return { deleted: true, sender_id_pk: id };
}

/** True if `value` is an active catalog entry — used to gate per-store assignment. */
async function isAssignable(value) {
    const v = String(value || '').trim();
    if (!v) return false;
    const [rows] = await db.query(/*sql*/`
        SELECT 1 FROM sms_sender_ids WHERE value = ? AND is_active = 1 LIMIT 1
    `, [v]);
    return rows.length > 0;
}

module.exports = {
    getGlobalDefault,
    clearDefaultCache,
    validateValue,
    classifyType,
    listSenderIds,
    getById,
    createSenderId,
    updateSenderId,
    deleteSenderId,
    isAssignable,
};
