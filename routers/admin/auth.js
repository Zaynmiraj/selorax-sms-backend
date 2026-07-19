/**
 * /api/admin/auth — phone→OTP login for the admin panel.
 *
 * Transport mirrors the SeloraX super-admin flow: an httpOnly cookie
 * (sms_admin_token). In production the cookie is Secure + SameSite=None so it
 * works cross-site (Vercel frontend ↔ DO backend). In dev it is SameSite=Lax +
 * insecure so it works over http on localhost (same-site, different port).
 */
const express = require('express');
const { default: rateLimit } = require('express-rate-limit');
const Router = express.Router();
const asyncMiddleware = require('../../middlewares/asyncMiddleware');
const smsAdminAuth = require('../../middlewares/smsAdminAuth');
const smsAdmin = require('../../models/sms-admin');

const isProd = process.env.NODE_ENV === 'production';

function setAuthCookie(res, token) {
    res.cookie(smsAdmin.COOKIE_NAME, token, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'None' : 'Lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000, // 24h — matches token TTL
    });
}

const otpLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { message: 'Too many OTP requests. Wait a minute.', status: 429 } });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, message: { message: 'Too many attempts. Wait a minute.', status: 429 } });

// POST /api/admin/auth/login  { phone }  → determines next step
Router.post('/login', otpLimiter, asyncMiddleware(async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).send({ message: 'Phone is required.', status: 400, code: 'missing_field' });
    try {
        const admin = await smsAdmin.findByPhone(phone);
        if (!admin) { const e = new Error('No admin account for this phone.'); e.code = 'admin_not_found'; throw e; }
        if (!admin.is_active) { const e = new Error('This admin account is disabled.'); e.code = 'admin_disabled'; throw e; }

        if (admin.password_hash) {
            return res.send({ message: 'Password required.', status: 200, step: 'password' });
        } else {
            await smsAdmin.requestOtp(phone);
            return res.send({ message: 'OTP sent.', status: 200, step: 'otp' });
        }
    } catch (e) {
        const map = { admin_not_found: 404, admin_disabled: 403, otp_send_failed: 502 };
        return res.status(map[e.code] || 400).send({ message: e.message, status: map[e.code] || 400, code: e.code || 'error' });
    }
}));

// POST /api/admin/auth/forgot-password { phone } -> forces OTP send
Router.post('/forgot-password', otpLimiter, asyncMiddleware(async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).send({ message: 'Phone is required.', status: 400, code: 'missing_field' });
    try {
        await smsAdmin.requestOtp(phone);
        return res.send({ message: 'OTP sent.', status: 200, step: 'otp' });
    } catch (e) {
        const map = { admin_not_found: 404, admin_disabled: 403, otp_send_failed: 502 };
        return res.status(map[e.code] || 400).send({ message: e.message, status: map[e.code] || 400, code: e.code || 'error' });
    }
}));

// POST /api/admin/auth/verify-otp  { phone, otp }  → sets cookie
Router.post('/verify-otp', verifyLimiter, asyncMiddleware(async (req, res) => {
    const { phone, otp } = req.body || {};
    if (!phone || !otp) return res.status(400).send({ message: 'Phone and OTP are required.', status: 400, code: 'missing_field' });
    try {
        const { admin, token } = await smsAdmin.verifyOtp(phone, otp);
        setAuthCookie(res, token);
        // token also returned so non-browser clients (curl/tests) can use x-admin-token.
        return res.send({ message: 'Logged in.', status: 200, admin, access_token: token });
    } catch (e) {
        const map = { admin_not_found: 404, admin_disabled: 403, otp_not_requested: 400, otp_expired: 401, otp_invalid: 401 };
        return res.status(map[e.code] || 400).send({ message: e.message, status: map[e.code] || 400, code: e.code || 'error' });
    }
}));

// POST /api/admin/auth/login-with-password  { phone, password }
Router.post('/login-with-password', verifyLimiter, asyncMiddleware(async (req, res) => {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).send({ message: 'Phone and password are required.', status: 400, code: 'missing_field' });
    try {
        const { admin, token } = await smsAdmin.verifyPassword(phone, password);
        setAuthCookie(res, token);
        return res.send({ message: 'Logged in.', status: 200, admin, access_token: token });
    } catch (e) {
        const map = { admin_not_found: 404, admin_disabled: 403, no_password: 400, invalid_password: 401 };
        return res.status(map[e.code] || 400).send({ message: e.message, status: map[e.code] || 400, code: e.code || 'error' });
    }
}));

// POST /api/admin/auth/set-password  { password } -> sets password for logged in admin
Router.post('/set-password', smsAdminAuth, asyncMiddleware(async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).send({ message: 'Password is required.', status: 400, code: 'missing_field' });
    try {
        const admin = await smsAdmin.setPassword(req.admin.admin_id, password);
        return res.send({ message: 'Password set successfully.', status: 200, admin });
    } catch (e) {
        const map = { invalid_password_length: 400 };
        return res.status(map[e.code] || 400).send({ message: e.message, status: map[e.code] || 400, code: e.code || 'error' });
    }
}));

// GET /api/admin/auth/me
Router.get('/me', smsAdminAuth, asyncMiddleware(async (req, res) => {
    return res.send({ status: 200, admin: smsAdmin.publicAdmin(req.admin) });
}));

// POST /api/admin/auth/logout
Router.post('/logout', asyncMiddleware(async (req, res) => {
    res.clearCookie(smsAdmin.COOKIE_NAME, { path: '/', sameSite: isProd ? 'None' : 'Lax', secure: isProd });
    return res.send({ message: 'Logged out.', status: 200 });
}));

module.exports = Router;
