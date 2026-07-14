/**
 * Auth for the /internal/* namespace — platform-to-platform calls from SeloraX-Backend
 * (e.g. the merchant manual "Send SMS" button) that need to bill this app's SMS credit
 * pool. Guarded by a shared-secret header, not user session — the platform is trusted.
 *
 * Env: INTERNAL_API_SECRET (set on both this app and SeloraX-Backend as
 *      MESSAGING_INTERNAL_SECRET). Refuses the call in production when the env is
 *      unset — never silently allow unauthenticated internal traffic.
 */
module.exports = function internalAuth(req, res, next) {
    const configured = (process.env.INTERNAL_API_SECRET || '').trim();
    if (!configured) {
        console.error('[internalAuth] INTERNAL_API_SECRET is not set — refusing /internal call.');
        return res.status(503).send({
            message: 'Internal auth not configured on this messaging instance.',
            status: 503,
            code: 'internal_auth_unconfigured',
        });
    }

    const provided = String(req.header('X-Internal-Secret') || '').trim();
    if (!provided || provided !== configured) {
        return res.status(401).send({
            message: 'Invalid internal secret.',
            status: 401,
            code: 'invalid_internal_secret',
        });
    }
    next();
};
