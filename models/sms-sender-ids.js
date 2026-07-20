/**
 * Sender-ID catalog — admin-managed, Anbernet-approved sender IDs.
 * Active entries with a global_priority form the ordered global fallback pool.
 */
const { connection } = require('../startup/db');
const { senderIdError } = require('../services/sms-providers/anbernet');

const db = connection.promise();
const GLOBAL_CACHE_TTL = 60 * 1000;
let globalCache = { value: [], expiresAt: 0 };

function clearGlobalCache() {
    globalCache = { value: [], expiresAt: 0 };
}

async function getActiveGlobalSenderIds() {
    if (Date.now() < globalCache.expiresAt) return globalCache.value;
    let value = [];
    try {
        const [rows] = await db.query(/*sql*/`
            SELECT sender_id_pk, value, global_priority
            FROM sms_sender_ids
            WHERE is_active = 1 AND global_priority IS NOT NULL
            ORDER BY global_priority ASC, sender_id_pk ASC
        `);
        value = rows;
    } catch (e) {
        // A missing migration or transient catalog error must not block sending.
        value = [];
    }
    globalCache = { value, expiresAt: Date.now() + GLOBAL_CACHE_TTL };
    return value;
}

function classifyType(value) {
    return /^\d+$/.test(String(value)) ? 'numeric' : 'alnum';
}

function validateValue(value) {
    const v = String(value || '').trim();
    if (!v) return 'sender ID value is required';
    return senderIdError(v);
}

function normalizeGlobalPriority(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const priority = Number(value);
    if (!Number.isInteger(priority) || priority < 1) {
        const error = new Error('Global fallback priority must be a positive integer.');
        error.code = 'invalid_global_priority';
        throw error;
    }
    return priority;
}

async function listSenderIds() {
    const [rows] = await db.query(/*sql*/`
        SELECT sender_id_pk, value, type, label, global_priority, is_active, created_at, updated_at
        FROM sms_sender_ids
        ORDER BY global_priority IS NULL ASC, global_priority ASC, is_active DESC, value ASC
    `);
    return rows;
}

async function getById(id) {
    const [rows] = await db.query(/*sql*/`
        SELECT sender_id_pk, value, type, label, global_priority, is_active, created_at, updated_at
        FROM sms_sender_ids WHERE sender_id_pk = ? LIMIT 1
    `, [id]);
    return rows[0] || null;
}

function translateDuplicate(error, value) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    if (String(error.message || '').includes('idx_sms_sender_ids_global_priority')) {
        const duplicate = new Error('That global fallback priority is already in use.');
        duplicate.code = 'duplicate_global_priority';
        throw duplicate;
    }
    const duplicate = new Error(`Sender ID "${value}" already exists in the catalog.`);
    duplicate.code = 'duplicate_sender_id';
    throw duplicate;
}

async function createSenderId({ value, label, global_priority, created_by }) {
    const v = String(value || '').trim();
    const err = validateValue(v);
    if (err) { const error = new Error(err); error.code = 'invalid_sender_id'; throw error; }
    const priority = normalizeGlobalPriority(global_priority);

    try {
        const [res] = await db.query(/*sql*/`
            INSERT INTO sms_sender_ids (value, type, label, global_priority, created_by)
            VALUES (?, ?, ?, ?, ?)
        `, [v, classifyType(v), label || null, priority ?? null, created_by || null]);
        clearGlobalCache();
        return getById(res.insertId);
    } catch (e) {
        translateDuplicate(e, v);
    }
}

async function updateSenderId(id, { value, label, global_priority, is_active }) {
    const existing = await getById(id);
    if (!existing) { const error = new Error('Sender ID not found.'); error.code = 'not_found'; throw error; }

    const sets = [];
    const params = [];
    let currentValue = existing.value;
    if (value !== undefined) {
        const v = String(value || '').trim();
        const err = validateValue(v);
        if (err) { const error = new Error(err); error.code = 'invalid_sender_id'; throw error; }
        currentValue = v;
        sets.push('value = ?', 'type = ?');
        params.push(v, classifyType(v));
    }
    if (label !== undefined) { sets.push('label = ?'); params.push(label || null); }
    if (is_active !== undefined) { sets.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (global_priority !== undefined) {
        sets.push('global_priority = ?');
        params.push(normalizeGlobalPriority(global_priority));
    }

    if (sets.length) {
        params.push(id);
        try {
            await db.query(`UPDATE sms_sender_ids SET ${sets.join(', ')} WHERE sender_id_pk = ?`, params);
        } catch (e) {
            translateDuplicate(e, currentValue);
        }
    }
    clearGlobalCache();
    return getById(id);
}

async function deleteSenderId(id) {
    const existing = await getById(id);
    if (!existing) { const error = new Error('Sender ID not found.'); error.code = 'not_found'; throw error; }
    await db.query(`DELETE FROM sms_sender_ids WHERE sender_id_pk = ?`, [id]);
    clearGlobalCache();
    return { deleted: true, sender_id_pk: id };
}

async function isAssignable(value) {
    const v = String(value || '').trim();
    if (!v) return false;
    const [rows] = await db.query(/*sql*/`
        SELECT 1 FROM sms_sender_ids WHERE value = ? AND is_active = 1 LIMIT 1
    `, [v]);
    return rows.length > 0;
}

module.exports = {
    getActiveGlobalSenderIds,
    clearGlobalCache,
    validateValue,
    classifyType,
    normalizeGlobalPriority,
    listSenderIds,
    getById,
    createSenderId,
    updateSenderId,
    deleteSenderId,
    isAssignable,
};
