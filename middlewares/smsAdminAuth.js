/**
 * Auth guard for the /api/admin panel routes. Entirely separate from the
 * per-store session-token auth in middlewares/auth.js — different cookie,
 * different secret, different identity table.
 *
 * Mirrors the SeloraX super-admin pattern: verify the JWT, then re-fetch the
 * admin from the DB every request so a disabled admin loses access immediately.
 */
const smsAdmin = require('../models/sms-admin');

module.exports = async function smsAdminAuth(req, res, next) {
    const token = req.cookies?.[smsAdmin.COOKIE_NAME] || req.header('x-admin-token');
    if (!token) {
        return res.status(401).send({ message: 'Not authenticated.', status: 401, code: 'unauthorized' });
    }

    let decoded;
    try {
        decoded = smsAdmin.verifyToken(token);
    } catch (e) {
        res.clearCookie(smsAdmin.COOKIE_NAME);
        return res.status(401).send({ message: 'Session expired. Please log in again.', status: 401, code: 'unauthorized' });
    }

    if (!decoded?.isSmsAdmin || !decoded?.admin_id) {
        return res.status(403).send({ message: 'Forbidden.', status: 403, code: 'forbidden' });
    }

    let admin;
    try {
        admin = await smsAdmin.findById(decoded.admin_id);
    } catch (e) {
        return res.status(500).send({ message: 'Auth lookup failed.', status: 500 });
    }

    if (!admin || !admin.is_active) {
        res.clearCookie(smsAdmin.COOKIE_NAME);
        return res.status(403).send({ message: 'Account is no longer active.', status: 403, code: 'forbidden' });
    }

    req.admin = admin;
    next();
};

/**
 * Restrict a route to specific roles. Use AFTER smsAdminAuth.
 *   Router.post('/admins', smsAdminAuth, requireRole('super_admin'), handler)
 */
module.exports.requireRole = function requireRole(...roles) {
    return function (req, res, next) {
        if (!req.admin) {
            return res.status(401).send({ message: 'Not authenticated.', status: 401, code: 'unauthorized' });
        }
        if (!roles.includes(req.admin.role)) {
            return res.status(403).send({ message: 'You do not have permission for this action.', status: 403, code: 'forbidden' });
        }
        next();
    };
};
