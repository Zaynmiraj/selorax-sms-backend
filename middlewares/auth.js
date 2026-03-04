const jwt = require('jsonwebtoken');

const SESSION_SIGNING_KEY = process.env.SESSION_SIGNING_KEY;
const SELORAX_API_URL = process.env.SELORAX_API_URL;
const SELORAX_CLIENT_ID = process.env.SELORAX_CLIENT_ID;
const SELORAX_CLIENT_SECRET = process.env.SELORAX_CLIENT_SECRET;

// In-memory cache for platform-verified session tokens
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cleanup expired cache entries every 2 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tokenCache) {
        if (now > entry.expiresAt) tokenCache.delete(key);
    }
}, 2 * 60 * 1000).unref();

/**
 * Verify a session token via the platform's /api/apps/session/verify endpoint.
 * Uses client_id + client_secret for authentication — no SESSION_SIGNING_KEY needed.
 * Caches successful results to avoid excessive HTTP round-trips.
 */
async function verifyViaPlatform(sessionToken) {
    const cached = tokenCache.get(sessionToken);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    const res = await fetch(`${SELORAX_API_URL}/apps/session/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_token: sessionToken,
            client_id: SELORAX_CLIENT_ID,
            client_secret: SELORAX_CLIENT_SECRET,
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { valid: false, error: err.message || 'Verification failed' };
    }

    const body = await res.json();
    const result = {
        valid: true,
        store_id: body.data.store_id,
        installation_id: body.data.installation_id,
        app_id: body.data.app_id,
    };

    // Cache successful verification
    tokenCache.set(sessionToken, {
        data: result,
        expiresAt: Date.now() + TOKEN_CACHE_TTL,
    });

    return result;
}

/**
 * Auth middleware — supports three modes:
 *
 * 1a. Session Token (local): X-Session-Token header verified locally with SESSION_SIGNING_KEY env var.
 *     Fastest — no HTTP call. Use when SESSION_SIGNING_KEY is set in .env.
 *
 * 1b. Session Token (platform): X-Session-Token header verified via platform's /api/apps/session/verify.
 *     Auto-linked — no SESSION_SIGNING_KEY needed. Uses client_id + client_secret.
 *     Results cached for 5 min to avoid excessive HTTP calls.
 *
 * 2.  Legacy JWT (backwards-compatible): x-auth-token header + x-store-id header.
 *     Verified with shared JWT_SECRET. Used during migration.
 */
module.exports = async function (req, res, next) {
    // ── Mode 1: Session Token ──
    const sessionToken = req.header('X-Session-Token') || req.header('x-session-token');
    if (sessionToken) {
        // 1a: Local verification (fast path — when SESSION_SIGNING_KEY is set)
        if (SESSION_SIGNING_KEY) {
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

            req.user = { store_id, installation_id, app_id: payload.app_id };
            req.installation = { installation_id, store_id, status: 'active' };
            return next();
        }

        // 1b: Platform verification (auto-linked — no SESSION_SIGNING_KEY needed)
        if (SELORAX_API_URL && SELORAX_CLIENT_ID && SELORAX_CLIENT_SECRET) {
            try {
                const result = await verifyViaPlatform(sessionToken);
                if (!result.valid) {
                    return res.status(401).send({ message: result.error || 'Invalid session token.', status: 401 });
                }

                req.user = { store_id: result.store_id, installation_id: result.installation_id, app_id: result.app_id };
                req.installation = { installation_id: result.installation_id, store_id: result.store_id, status: 'active' };
                return next();
            } catch (e) {
                console.error('[Auth] Platform verification error:', e.message);
                return res.status(500).send({ message: 'Session verification failed.', status: 500 });
            }
        }

        return res.status(401).send({ message: 'Session token verification not configured. Set SESSION_SIGNING_KEY or SELORAX_CLIENT_ID + SELORAX_CLIENT_SECRET.', status: 401 });
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
