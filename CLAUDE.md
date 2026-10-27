# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SeloraX Messaging is an SMS notification microservice for the SeloraX e-commerce marketplace. It runs as a standalone Express app that integrates with the SeloraX platform via OAuth client credentials (Shopify-app-style). It sends SMS on order events, manages merchant automations/campaigns, and handles SMS-package billing through the platform.

## Commands

- **Dev server:** `yarn dev` (nodemon, auto-restart)
- **Production:** `yarn start` (or `yarn start:bun` for Bun runtime)
- **Tests:** `yarn test` (`node --test tests/*.test.js`). `tests/platform-adapter.test.js` is
  fully offline (`fetch` mocked); the others load the DB module, so dependencies must be installed.
- No build step, no linter.

Migrations in `migrations/` (currently `003`–`013`) must be applied manually, in order, against the shared platform MySQL database.

## Architecture

### Process model

`index.js` boots the Express app, connects MySQL, and starts two long-lived background pollers:
- **`services/scheduler.js`** — polls `app_messaging_scheduled` every 10s, dispatches due jobs, retries with quadratic backoff (1, 4, 9 min; max 3 attempts). Also runs an auto-renewal check every 60s that creates a new package purchase when `sms_credits <= auto_renew_threshold` for stores with `auto_renew_enabled`.
- **`services/campaign-sender.js`** — polls `app_messaging_campaigns` every 5s, transitions `scheduled`→`sending`, sends recipients in batches of 20, stops and marks remaining recipients `failed` if the store runs out of credits mid-send.

SIGINT/SIGTERM trigger graceful shutdown: stop pollers, close server, end MySQL connection, hard-exit after 10s.

### Authentication (`middlewares/auth.js`)

Three modes, checked in order:
1. **Session token (local):** `X-Session-Token` JWT verified with `SESSION_SIGNING_KEY` (HS256) — fastest path, no network.
2. **Session token (platform):** Same header, verified via HTTP `POST {SELORAX_API_URL}/apps/session/verify` using `client_id + client_secret`. Results cached 5 min in-memory (map cleaned every 2 min).
3. **Legacy JWT:** `x-auth-token` header + `x-store-id` header verified with `JWT_SECRET` (backwards-compat).

Auth populates `req.user` (`store_id`, `installation_id`, `app_id`) and `req.installation`. Dev shortcut: set `NODE_ENV=development` + `DEV_BYPASS_AUTH=true` (+ optional `DEV_STORE_ID`) to skip auth entirely.

### Platform API (`services/platform-api.js`, `services/platform-billing.js`)

All outbound platform calls send `X-Client-Id` + `X-Client-Secret` + `X-Store-Id` headers (Shopify offline-token pattern) — **no per-store access tokens are stored locally**. Billing wrapper exposes `createWalletTopupCharge`, `getCharge`, wallet balance/debit, and wallet transactions.

### Billing model

SMS credits are **owned by this app**, stored in `app_messaging_settings.sms_credits`. The platform wallet is only used for payment processing:
1. `routers/payment.js` → `models/messaging-payment.js` creates a top-up charge via platform billing and writes a `pending` row in `app_messaging_purchases`.
2. When `/payment/verify/:charge_id` is called (or auto-renewal hits) and the charge reports `active`/`completed`, `creditPurchase()` performs an atomic `UPDATE ... status='pending' → 'credited'` guard, then increments `sms_credits`.
3. Two purchase paths: fixed packages (`app_messaging_packages`, same price for every store) and **custom** purchases (max 100k) at the store's **price per SMS** (`models/sms-pricing.js`): the store's own `app_messaging_settings.sms_unit_price` if an admin set one, else the admin-set default `app_messaging_config.default_sms_unit_price`, else `0.70`. Both are set by a **super_admin** in the admin panel (`PUT /api/admin/pricing`, `PATCH /api/admin/stores/:id/sms-price`); input is plain-decimal only, 0 < price ≤ 100, ≤ 4 decimals. Custom rows set `purchase_type='custom'` and snapshot `custom_label` + `unit_price`. `GET /wallet` and `GET /payment/packages` return the store's `custom_unit_price`; the dashboard widget values credits at it. Needs migration `013` (code tolerates it missing: everyone on 0.70).

SMS sending deducts credits through `models/messaging-wallet.js` (`deductCredit`) with a guarded `UPDATE ... WHERE sms_credits >= ?` so concurrent sends cannot go negative.

### Automations vs. templates

The app has **two template systems** co-existing:
- `app_messaging_automations` (migration 006) — event-driven, one row per `(store_id, event_key)`, with `is_active`, `delivery_mode` (`instant`/`delayed`/`off`), `delay_minutes`, `template_text`. This is what the webhook path uses.
- `app_messaging_templates` — the legacy table still exposed via `/api/messaging/templates`. Not consulted by the webhook flow anymore.

`models/messaging-automations.js` seeds eight `DEFAULT_AUTOMATIONS` (`order.confirmed`, `order.shipped`, `order.delivered`, `order.cancelled`, `order.refunded`, `order.payment_received`, `customer.welcome`, `customer.updated`) on first access. `WEBHOOK_EVENT_MAP` translates platform webhook topics — notably `order.status_changed` + `order.status` — into these event keys.

### Webhook flow (`routers/webhooks.js`)

`POST /api/messaging/webhooks/receive` is called by the platform with headers `X-SeloraX-Signature` (`sha256=<hex>`), `X-SeloraX-Webhook-Event`, `X-SeloraX-Timestamp`. Signature is HMAC-SHA256 over `timestamp.rawBody`; the raw body is captured by `express.json({ verify })` in `startup/routes.js` to avoid re-serialization drift.

The signing secret is **per-store**, stored in `app_messaging_settings.webhook_signing_secret` (migration 008). If missing, `ensureWebhookSigningSecret()` generates a 16-byte hex secret and saves it. `WEBHOOK_SIGNING_SECRET` env is used only as a fallback.

After signature passes:
1. Skip if `is_enabled=0` or `auto_sms_enabled=0`.
2. `automations.resolveEventKey(topic, order.status)` → event key; skip if no mapping or no active automation for the store.
3. Extract and validate BD phone (`/^(?:\+?880|0)1[3-9]\d{8}$/`).
4. Dedupe: skip if a `sent` log exists for the same `(store_id, event_topic, resource_id)` within the last 5 min.
5. Render `{{variable}}` placeholders from order payload.
6. On `order.cancelled`, call `scheduler.cancelJobsForOrder(store_id, orderId)` to void pending scheduled SMS for that order.
7. If `delivery_mode='delayed'` and `delay_minutes>0`: `scheduler.scheduleJob(...)`. Otherwise send immediately via `messaging.sendSms`.

### Campaigns (`routers/campaigns.js`, `models/messaging-campaigns.js`)

Three audience types: `manual` (raw phone list), `csv` (same as manual, different UI), `filter` (fetch from platform `/apps/v1/customers`). `/audience/customers` has a DB fallback that reads `${PLATFORM_DATABASE}.users` directly if the platform API fails — this assumes the app shares the platform's MySQL database.

Create flow validates phones, deduplicates, checks `sms_credits >= recipients * calculateSmsParts(message)` (returns 402 otherwise), inserts the campaign and all recipients. Sending is picked up asynchronously by `campaign-sender.js`.

`calculateSmsParts()` in `models/messaging.js` is a flat rule: `ceil(length / 70)` credits, whatever the encoding.

### Sending SMS: through the SeloraX Messages platform (`services/sms-providers/platform.js`)

This app no longer talks to any gateway. Every SMS is a `POST {MESSAGING_PLATFORM_URL}/api/v1/messages`
with our **partner** API key and `store_ref = store_id` (no `store_ref` for the admin login OTP).
The platform (repo `selorax-messaging-platform`) picks that store's **sender ID and gateway** —
both set per store in the platform's `/admin` → organization → "Partner stores" — and charges the
partner wallet (postpaid). **Store SMS credits stay here** (`messaging-wallet.js`): `sendSms()`
checks credits, sends, logs, and deducts only on success, exactly as before.

- `sendSms()` in the adapter never throws; returns `{ success, sms_type, provider_response }`.
  Platform `sent` **and `unknown`** count as success (an unknown SMS may have gone out and is
  charged to us). Failures carry an `error` code (`no_sender_id`, `platform_insufficient_funds`,
  `sending_unavailable`, `invalid_receiver`, `suppressed`, `rate_limited`, `auth_failed`,
  `network_error`, …) which `models/messaging.js` `sendSms()` now returns to callers.
- Up to 3 attempts (max 2 timeouts) with the **same `Idempotency-Key`** on timeout / network
  error / 5xx / 409 — the platform replays or never recorded it, so these retries cannot
  double-send. Timeout 40 s, deliberately ABOVE the platform's 30 s gateway timeout.
- Outcome classes (`services/sms-providers/platform.js`):
  - **`indeterminate`** (timeout/dropped connection, final 409/504, unreadable 200): MAY have gone
    out. Logged `failed`, not billed, `sendSms()` returns `indeterminate: true`; never
    auto-retried, counted as "sent" by the webhook 5-min dedupe, and the manual retry routes refuse
    it (`409 possibly_sent`; bulk skips it).
  - **`SYSTEMIC_ERRORS`** (`not_configured`, `auth_failed`, `partner_not_enabled` = 422 on
    store_ref, `platform_unreachable` = never connected incl. TLS/connect timeout,
    `platform_unavailable` = 502/503/404, `platform_error`, `rate_limited`, `sending_unavailable`, …):
    nothing sent, nothing billed. Callers that pass `holdOnSystemic` (scheduler, campaign sender,
    order webhook) get `{ held: true }` and **no log row is written** — so an outage never leaves
    retryable "failed" rows a merchant could resend. The scheduler re-queues in 2 min without
    spending an attempt (gives up after 24 h); campaigns keep recipients `pending` and pause 60 s;
    an instant order webhook is queued as a scheduler job instead of being lost. Both pollers idle
    while `MESSAGING_PLATFORM_URL`/`_API_KEY` are unset. Manual sends report the error.
  - An earlier timeout/409/dropped connection followed by a final 5xx/429/404 is still
    `indeterminate` (that answer can't prove the first attempt didn't send).
  - Scheduler jobs stuck `processing` for 60 min (restart mid-send) are finished as `failed`
    ("may have been sent"), never resent. `/send` answers `202 possibly_sent`, `/internal/send-sms`
    `code: possibly_sent`, for indeterminate outcomes.
  - The platform's per-SMS price is NOT stored in `provider_response` (merchants can read logs).
  - **`PERMANENT_ERRORS`** (`invalid_receiver`, `suppressed`): failed at once, never retried.
- Campaign sends (`event_topic: 'campaign'`) go as `promotional: true`.
- Install/uninstall (`routers/oauth.js`) best-effort `PUT /api/v1/stores/{store_id}` with the
  store's name/domain and `active` so it shows up in the platform admin.
- `provider_response` stores `{ provider:'platform', status, message_id, batch_id, sender_id, … }`
  plus `meta` (`retried_from_log_id` lives in `meta.metadata`). Never the API key.
- **Removed:** the direct Anbernet adapter, the local sender-ID catalog/fallback
  (`sms_sender_ids`, `/api/admin/sender-ids`, `PATCH /api/admin/stores/:id/sender-id`) and
  `SMS_API_*`. The `sms_sender_ids` table and `app_messaging_settings.sender_id` column are still in
  the DB, unused. `scripts/export-for-platform.js` (read-only) exported them for the platform's
  `scripts/import-partner-stores.ts`.

### Route map

All routes under `/api/messaging` (mounted in `startup/routes.js`):
- `/settings`, `/templates`, `/send`, `/logs`, `/stats` — `routers/messaging.js`
- `/wallet`, `/wallet/transactions`, `/wallet/pricing` — `routers/wallet.js`
- `/payment/packages`, `/payment/topup`, `/payment/verify/:charge_id`, `/payment/purchases` — `routers/payment.js`
- `/scheduled`, `/scheduled/:job_id/cancel` — `routers/scheduled.js`
- `/automations`, `/automations/:id` — `routers/automations.js`
- `/campaigns`, `/campaigns/audience/customers`, `/campaigns/:id`, `/campaigns/:id/send`, `/campaigns/:id/cancel` — `routers/campaigns.js`
- `/oauth/token`, `/oauth/revoke` — `routers/oauth.js` (no auth middleware; HMAC-verified if `SESSION_SIGNING_KEY` is set)
- `/webhooks/receive` — `routers/webhooks.js` (no auth middleware; HMAC-verified per request)

`/health` is at the root. `/api/*` has a 500 req/min rate limiter. Global error handler is `middlewares/error.js`. All handlers wrap in `asyncMiddleware` (try/catch → `next(error)`).

### OAuth lifecycle (`routers/oauth.js`)

- **Install (`POST /oauth/token`):** Optional HMAC check, then `ensureSettings()` to create the settings row + webhook signing secret.
- **Uninstall (`POST /oauth/revoke`):** Optional HMAC check, then `is_enabled=0`, `auto_sms_enabled=0`, deactivate all templates, and `scheduler.cancelAllForStore()` to kill pending jobs.

### Database

MySQL via `mysql2` connection pool (`startup/db.js`). All app tables prefixed `app_messaging_`:

| Table | Purpose |
|---|---|
| `app_messaging_settings` | Per-store config: provider, toggles, `sms_credits`, `webhook_signing_secret`, auto-renewal fields |
| `app_messaging_templates` | Legacy templates (still queryable, not used by webhooks) |
| `app_messaging_automations` | Event-driven automations (current webhook target) |
| `app_messaging_logs` | Delivery logs |
| `app_messaging_pricing` | Per-provider SMS pricing |
| `app_messaging_scheduled` | Delayed SMS jobs consumed by `scheduler.js` |
| `app_messaging_packages` | Purchasable SMS packages |
| `app_messaging_purchases` | Pending/credited purchase rows |
| `app_messaging_campaigns`, `app_messaging_campaign_recipients` | Bulk campaigns |

## Environment

See `.env.example` — it lists exactly the variables the source reads, no more.
Groups:
- **Server:** `PORT` (default 5002), `NODE_ENV`, `DASHBOARD_URL`
- **MySQL:** `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_PORT`, `PLATFORM_DATABASE` (defaults to `selorax_dev`; campaigns `users`-table fallback, admin store-name lookups, platform webhook secrets)
- **Platform:** `SELORAX_API_URL`, `SELORAX_CLIENT_ID`, `SELORAX_CLIENT_SECRET`, `SELORAX_APP_ID` (numeric; platform webhook-secret lookup), `SELORAX_APP_SLUG` (default `selorax-messaging`)
- **Auth:** `JWT_SECRET`, `SESSION_SIGNING_KEY` (optional — enables local session-token verification), `WEBHOOK_SIGNING_SECRET` (fallback only; prefer per-store secrets), `INTERNAL_API_SECRET` (guards `/internal/*`; unset ⇒ 503), `SMS_ADMIN_JWT_SECRET` (admin cookie; falls back to `JWT_SECRET`)
- **SMS sending (SeloraX Messages platform):** `MESSAGING_PLATFORM_URL`, `MESSAGING_PLATFORM_API_KEY` (partner key)
- **Dev-only:** `DEV_BYPASS_AUTH=true`, `DEV_STORE_ID` (requires `NODE_ENV=development`)

`APP_BASE_URL` and the `EPS_*` group are **not read by any source file** — payments
go through the platform billing API (`services/platform-billing.js`), not EPS. They
survive commented out at the bottom of `.env.example` only so a deployed `.env` that
still carries them is not mistaken for misconfiguration.
