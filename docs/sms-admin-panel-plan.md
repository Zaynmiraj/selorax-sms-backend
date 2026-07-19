# SeloraX SMS Admin Panel — Build Plan

**Goal:** An owner/operator admin panel for the SeloraX SMS app, living at `/admin` inside
the existing `selorax-sms-frontend`. It manages the sender-ID catalog, per-store sender-ID
assignment, and admin users. Two roles. SeloraX-style phone→OTP login over an httpOnly cookie.

First super admin seeded: **01731620933**.

---

## Hard constraint — do NOT break the existing customer flow

Store owners already use the embedded app (send, automations, campaigns, billing) and rely on
the automated webhook SMS (order.confirmed, etc.). The admin panel is added with strict
isolation so none of that changes:

| Existing path | Touched? | Guarantee |
|---|---|---|
| Iframe embed / app-bridge auth | No | Root layout gets one additive `isAdmin` guard; the embedded branch is unchanged. The dashboard never loads `/admin`, and `/admin` is never in an iframe (`window.self !== window.top` stays false). |
| `/api/messaging/*` (send, automations, campaigns, billing, webhooks) | No | Admin is a separate route tree `/api/admin/*` with its own middleware. |
| Anbernet send path / webhook SMS | No | Not modified. Admin login OTP calls the provider directly, bypassing store credits + billing/logs. |
| Existing DB tables | No ALTER | Two brand-new tables only. |
| Per-store `sender_id` | Written, not schema-changed | Column already exists and is already read by `resolveProvider`. Admin assigns only validated, catalog (Anbernet-approved) values. |
| Unassigned stores' sender | Identical unless opted in | New global-default fallback fires only if a super_admin flags an `is_global_default` catalog row; otherwise behavior equals today (env `SMS_API_SENDER_ID` remains the ultimate backstop). Cached + unit-tested. |

---

## Auth flow (self-contained; mirrors the SeloraX super-admin flow)

```
/admin/login → phone → OTP sent via THIS app's Anbernet (no store credits)
             → verify 4-digit OTP
             → JWT (own secret SMS_ADMIN_JWT_SECRET, HS256, 24h)
             → httpOnly cookie  sms_admin_token  (sameSite=None, secure, path=/)
             → credentials:include on every /api/admin request
middleware smsAdminAuth: read cookie → verify → re-fetch sms_admins WHERE is_active=1 → req.admin
requireRole('super_admin') gates the admin-management routes
```

Roles:

| Capability | super_admin | admin |
|---|---|---|
| Sender-ID catalog CRUD, assign per store | ✅ | ✅ |
| Stores list, credits, logs | ✅ | ✅ |
| Manage admins (create by phone, disable, set role) | ✅ | ❌ |

---

## Schema — two new tables, zero existing-column changes

```
sms_admins   admin_id, name, phone(uniq), role('super_admin'|'admin'),
             otp, otp_valid_till, password_hash?, is_active, last_login, created_at, updated_at
             seed: ('01731620933','super_admin',is_active=1)

sms_sender_ids  sender_id_pk, value, type('numeric'|'alnum'), label,
                is_global_default, is_active, created_at, updated_at
```

---

## Build inventory

### Backend (`selorax-sms-backend`)
- `migrations/010_admin_and_sender_ids.sql` — two tables + seed super_admin
- `models/sms-admin.js` — OTP send/verify (Anbernet direct), JWT mint, admin CRUD
- `models/sms-sender-ids.js` — catalog CRUD + cached global default
- `middlewares/smsAdminAuth.js` — verify cookie JWT + `requireRole`
- `routers/admin/{index,auth,admins,sender-ids,stores}.js` mounted at `/api/admin`
- `models/messaging.js` `getSettings` — additive, cached global-default fallback
- `tests/sms-admin.test.js` — sender-id validation + global-default fallback + OTP/JWT
- env: `SMS_ADMIN_JWT_SECRET`

### Frontend (`selorax-sms-frontend`)
- `app/layout.js` — the one additive `isAdmin` guard
- `app/admin/layout.js` — `SmsAdminProvider` + `RequireSmsAdmin` + admin sidebar
- `app/admin/{login,sender-ids,stores,admins}/page.js`
- `contexts/SmsAdminContext.js`, `lib/adminApi.js`, `components/admin/AdminSidebar.js`
- reuses existing `components/ui/*`, `Logo.js`, toasts — nothing to copy

---

## Phases
- **Phase 1 (this build):** login + roles + guard · sender-ID catalog CRUD · assign per store (validated + global default) · manage admins.
- **Phase 2:** per-store credits view + manual top-up · cross-store send log.
- **Phase 3:** enable/disable store · resend failed · Anbernet balance widget · admin audit log.

## Deploy
- Backend (DigitalOcean): add `SMS_ADMIN_JWT_SECRET`. Anbernet creds already set. Apply migration 010 to `selorax_sms`.
- Frontend (Vercel): reuse existing `NEXT_PUBLIC_SMS_API_URL`; no new build config.
