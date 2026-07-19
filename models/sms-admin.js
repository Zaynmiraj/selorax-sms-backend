/**
 * SMS Admin panel — identity + auth for the /admin panel.
 *
 * Self-contained: its own `sms_admins` table, its own JWT secret. Nothing here
 * touches the per-store session-token auth used by the embedded app, and login
 * OTPs are sent via the provider directly (no store credits, no billing/logs).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { connection } = require('../startup/db');
const { normalizeBd, redactSecrets } = require('../services/sms-providers/anbernet');
const { resolveProvider } = require('../services/sms-providers');

const db = connection.promise();

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_TTL = '24h';
const COOKIE_NAME = 'sms_admin_token';

function jwtSecret() {
    const secret = process.env.SMS_ADMIN_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('SMS_ADMIN_JWT_SECRET (or JWT_SECRET) is not set');
    return secret;
}

/**
 * Store/lookup key. Admins are stored in local 11-digit form (01XXXXXXXXX);
 * accept any input format (+880…, 880…, 01…) and fold to that.
 */
function toLocalPhone(phone) {
    const norm = normalizeBd(phone); // -> 8801XXXXXXXXX or null
    if (!norm) return null;
    return '0' + norm.slice(3); // 880 + 1XXXXXXXXX -> 0 + 1XXXXXXXXX
}

function generateOtp() {
    // 4 digits, matching the SeloraX super-admin OTP length.
    return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// ── Lookups ─────────────────────────────────────────────────────────────────
async function findByPhone(phone) {
    const local = toLocalPhone(phone);
    if (!local) return null;
    const [rows] = await db.query(/*sql*/`
        SELECT * FROM sms_admins WHERE phone = ? LIMIT 1
    `, [local]);
    return rows[0] || null;
}

async function findById(admin_id) {
    const [rows] = await db.query(/*sql*/`
        SELECT * FROM sms_admins WHERE admin_id = ? LIMIT 1
    `, [admin_id]);
    return rows[0] || null;
}

function publicAdmin(row) {
    if (!row) return null;
    return {
        admin_id: row.admin_id,
        name: row.name,
        phone: row.phone,
        role: row.role,
        is_active: !!row.is_active,
        last_login: row.last_login,
        created_at: row.created_at,
    };
}

// ── Auth ────────────────────────────────────────────────────────────────────
/**
 * Send a login OTP. Only known, active admins can request one (no self-signup).
 * Returns { sent:true } on success; throws with .code otherwise.
 * The OTP SMS goes through the provider directly — it does NOT consume any
 * store's sms_credits and is never written to app_messaging_logs.
 */
async function requestOtp(phone) {
    const admin = await findByPhone(phone);
    if (!admin) { const e = new Error('No admin account for this phone.'); e.code = 'admin_not_found'; throw e; }
    if (!admin.is_active) { const e = new Error('This admin account is disabled.'); e.code = 'admin_disabled'; throw e; }

    const otp = generateOtp();
    const validTill = Date.now() + OTP_TTL_MS;
    await db.query(`UPDATE sms_admins SET otp = ?, otp_valid_till = ? WHERE admin_id = ?`, [otp, validTill, admin.admin_id]);

    if (process.env.NODE_ENV !== 'production') {
        console.log(`[SMS Admin] OTP for ${admin.phone}: ${otp}`);
    }

    let sendResult = null;
    let sendError = null;
    try {
        const provider = resolveProvider(null); // env SMS_API_* (global sender)
        sendResult = await provider.sendSms(admin.phone, `Your SeloraX SMS Admin login OTP is ${otp}`, {
            event_topic: 'admin.otp',
        });
    } catch (e) {
        sendError = e;
    }

    // Track every admin SMS (success or failure). Redacted; never stores the OTP.
    await logAdminSms({
        admin_id: admin.admin_id,
        phone: admin.phone,
        purpose: 'login_otp',
        status: sendResult?.success ? 'sent' : 'failed',
        provider: 'anbernet',
        provider_response: sendResult?.provider_response ?? null,
        error: sendError ? sendError.message : (sendResult && !sendResult.success ? 'send_failed' : null),
    });

    if (sendResult?.success) return { sent: true };

    // Send failed. In production this is a hard failure; in dev, allow login to
    // proceed with the console-logged OTP so local testing isn't blocked.
    if (process.env.NODE_ENV === 'production') {
        const err = new Error('Could not send OTP SMS. Try again shortly.');
        err.code = 'otp_send_failed';
        throw err;
    }
    return { sent: true };
}

/**
 * Record an admin-panel SMS (login OTP today). Best-effort: a logging failure
 * must never block login. provider_response is redacted; the OTP is never stored.
 */
async function logAdminSms({ admin_id, phone, purpose, status, provider, provider_response, error }) {
    try {
        const safe = provider_response == null ? null : JSON.stringify(redactSecrets(provider_response));
        await db.query(/*sql*/`
            INSERT INTO sms_admin_logs (admin_id, phone, purpose, status, provider, provider_response, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [admin_id || null, phone, purpose || 'login_otp', status, provider || null, safe, error || null]);
    } catch (e) {
        console.error('[SMS Admin] log write failed:', e.code || e.message);
    }
}

async function listAdminLogs({ limit = 50, offset = 0 } = {}) {
    const [rows] = await db.query(/*sql*/`
        SELECT log_id, admin_id, phone, purpose, status, provider, error, created_at
        FROM sms_admin_logs
        ORDER BY created_at DESC, log_id DESC
        LIMIT ? OFFSET ?
    `, [Number(limit) || 50, Number(offset) || 0]);
    return rows;
}

/**
 * Verify an OTP and, on success, return { admin, token }.
 */
async function verifyOtp(phone, otp) {
    const admin = await findByPhone(phone);
    if (!admin) { const e = new Error('No admin account for this phone.'); e.code = 'admin_not_found'; throw e; }
    if (!admin.is_active) { const e = new Error('This admin account is disabled.'); e.code = 'admin_disabled'; throw e; }
    if (!admin.otp || !admin.otp_valid_till) { const e = new Error('Request an OTP first.'); e.code = 'otp_not_requested'; throw e; }
    if (Date.now() > Number(admin.otp_valid_till)) { const e = new Error('OTP expired. Request a new one.'); e.code = 'otp_expired'; throw e; }
    if (String(otp) !== String(admin.otp)) { const e = new Error('Incorrect OTP.'); e.code = 'otp_invalid'; throw e; }

    await db.query(`UPDATE sms_admins SET otp = NULL, otp_valid_till = NULL, last_login = NOW() WHERE admin_id = ?`, [admin.admin_id]);

    const token = jwt.sign(
        { admin_id: admin.admin_id, role: admin.role, phone: admin.phone, isSmsAdmin: true },
        jwtSecret(),
        { expiresIn: TOKEN_TTL }
    );
    return { admin: publicAdmin({ ...admin, last_login: new Date() }), token };
}

function verifyToken(token) {
    return jwt.verify(token, jwtSecret());
}

// ── Admin management (super_admin only, enforced at the router) ──────────────
async function listAdmins() {
    const [rows] = await db.query(/*sql*/`
        SELECT admin_id, name, phone, role, is_active, last_login, created_at
        FROM sms_admins ORDER BY role = 'super_admin' DESC, created_at ASC
    `);
    return rows.map(r => ({ ...r, is_active: !!r.is_active }));
}

async function createAdmin({ name, phone, role, created_by }) {
    const local = toLocalPhone(phone);
    if (!local) { const e = new Error('Invalid Bangladeshi phone number.'); e.code = 'invalid_phone'; throw e; }
    const finalRole = role === 'super_admin' ? 'super_admin' : 'admin';

    try {
        const [res] = await db.query(/*sql*/`
            INSERT INTO sms_admins (name, phone, role, created_by) VALUES (?, ?, ?, ?)
        `, [name || null, local, finalRole, created_by || null]);
        return publicAdmin(await findById(res.insertId));
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            const dup = new Error('An admin with this phone already exists.');
            dup.code = 'duplicate_phone';
            throw dup;
        }
        throw e;
    }
}

async function countActiveSuperAdmins(excludeId) {
    const [rows] = await db.query(/*sql*/`
        SELECT COUNT(*) AS n FROM sms_admins
        WHERE role = 'super_admin' AND is_active = 1 AND admin_id <> ?
    `, [excludeId || 0]);
    return rows[0].n;
}

/**
 * Update an admin. Guards against removing the last active super_admin (whether
 * by demotion or deactivation), which would lock everyone out of admin control.
 */
async function updateAdmin(id, { name, role, is_active }) {
    const admin = await findById(id);
    if (!admin) { const e = new Error('Admin not found.'); e.code = 'not_found'; throw e; }

    const willBeSuper = role === undefined ? admin.role === 'super_admin' : role === 'super_admin';
    const willBeActive = is_active === undefined ? !!admin.is_active : !!is_active;

    if (admin.role === 'super_admin' && (!willBeSuper || !willBeActive)) {
        if (await countActiveSuperAdmins(id) === 0) {
            const e = new Error('Cannot demote or disable the last active super admin.');
            e.code = 'last_super_admin';
            throw e;
        }
    }

    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(name || null); }
    if (role !== undefined) { sets.push('role = ?'); params.push(role === 'super_admin' ? 'super_admin' : 'admin'); }
    if (is_active !== undefined) { sets.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (sets.length) {
        params.push(id);
        await db.query(`UPDATE sms_admins SET ${sets.join(', ')} WHERE admin_id = ?`, params);
    }
    return publicAdmin(await findById(id));
}

async function deleteAdmin(id) {
    const admin = await findById(id);
    if (!admin) { const e = new Error('Admin not found.'); e.code = 'not_found'; throw e; }
    if (admin.role === 'super_admin' && await countActiveSuperAdmins(id) === 0) {
        const e = new Error('Cannot delete the last active super admin.');
        e.code = 'last_super_admin';
        throw e;
    }
    await db.query(`DELETE FROM sms_admins WHERE admin_id = ?`, [id]);
    return { deleted: true, admin_id: id };
}

module.exports = {
    COOKIE_NAME,
    TOKEN_TTL,
    toLocalPhone,
    generateOtp,
    findByPhone,
    findById,
    publicAdmin,
    requestOtp,
    verifyOtp,
    verifyToken,
    logAdminSms,
    listAdminLogs,
    listAdmins,
    createAdmin,
    updateAdmin,
    deleteAdmin,
    countActiveSuperAdmins,
};
