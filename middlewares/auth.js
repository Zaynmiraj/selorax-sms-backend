const jwt = require('jsonwebtoken');

const SESSION_SIGNING_KEY = process.env.SESSION_SIGNING_KEY;

/**
 * Auth middleware — supports two modes:
 *
 * 1. Session Token (Shopify-style): X-Session-Token header
 *    JWT signed with the app's session_signing_key (HMAC-SHA256).
 *    Claims contain { sub: store_id, sid: installation_id, app_id }.
 *    No DB lookup needed — token is self-contained + signed.
 *
 * 2. Legacy JWT (backwards-compatible): x-auth-token header + x-store-id header
 *    Verified with shared JWT_SECRET. Used during migration.
 */
module.exports = async function (req, res, next) {
    // ── Mode 1: Session Token ──
    const sessionToken = req.header('X-Session-Token') || req.header('x-session-token');
    if (sessionToken && SESSION_SIGNING_KEY) {
        let payload;
        try {
            payload = jwt.verify(sessionToken, SESSION_SIGNING_KEY, { algorithms: ['HS256'] });
        } catch (e) {
            return res.status(401).send({ message: 'Invalid or expired session token.', status: 401 });
        }

        const store_id = Number(payload.sub);
        const installation_id = Number(payload.sid);

        if (!store_id || !installation_id) {
            return res.status(401).send({ message: 'Invalid session token claims.', status: 401 });
        }

        // Session token is self-contained and signed by the platform.
        // No DB lookup needed — the token proves the installation is valid.
        req.user = { store_id, installation_id, app_id: payload.app_id };
        req.installation = { installation_id, store_id, status: 'active' };
        return next();
    }

    // ── Mode 2: Legacy JWT (backwards-compatible) ──
    const token = req.header('x-auth-token') || req.cookies?.['x-auth-token'];
    if (!token) {
        return res.status(401).send({ message: 'Access denied. No token provided.', status: 401 });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
        return res.status(401).send({ message: 'Invalid token.', status: 401 });
    }

    const store_id = req.header('x-store-id') || req.query.store_id;
    if (!store_id) {
        return res.status(400).send({ message: 'x-store-id header is required.', status: 400 });
    }

    req.user = { ...decoded, store_id: Number(store_id) };
    req.installation = { store_id: Number(store_id), status: 'active' };
    next();
};
