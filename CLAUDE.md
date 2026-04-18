# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SeloraX Messaging is an SMS notification microservice for the SeloraX e-commerce marketplace. It runs as a standalone Express app that integrates with the SeloraX platform via OAuth client credentials (Shopify-app-style). It sends SMS on order events, manages merchant automations/campaigns, and handles SMS-package billing through the platform.

## Commands

- **Dev server:** `yarn dev` (nodemon, auto-restart)
- **Production:** `yarn start` (or `yarn start:bun` for Bun runtime)
- **No build step, no tests, no linter configured.**

Migrations in `migrations/` (currently `003`–`008`) must be applied manually, in order, against the shared platform MySQL database.

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
3. Two purchase paths: fixed packages (`app_messaging_packages`) and **custom** purchases at `CUSTOM_SMS_UNIT_PRICE = 0.70` (max 100k). Custom rows set `purchase_type='custom'` and store `custom_label` + `unit_price`.

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

`calculateSmsParts()` in `models/messaging.js` detects GSM-7 vs. Unicode and returns the multi-part count (160/153 for GSM-7, 70/67 for Unicode).

### SMS providers (`services/sms-providers/`)

Only BulkSMS BD exists today. Provider resolution: if `settings.use_own_provider` is set with `api_key`, use merchant keys; otherwise use the platform env defaults (`SMS_API_ENDPOINT`, `SMS_API_KEY`, `SMS_API_SENDER_ID`). The adapter auto-detects non-GSM-7 characters and sends `type=unicode` instead of `type=text`.

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

See `.env.example`. Groups:
- **Server:** `PORT` (default 5002), `NODE_ENV`, `APP_BASE_URL`, `DASHBOARD_URL`, `SELORAX_APP_SLUG`
- **MySQL:** `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_PORT`, `PLATFORM_DATABASE` (defaults to `selorax_dev`, used by the campaigns `users`-table fallback)
- **Platform:** `SELORAX_CLIENT_ID`, `SELORAX_CLIENT_SECRET`, `SELORAX_API_URL`
- **Auth:** `JWT_SECRET`, `SESSION_SIGNING_KEY` (optional — enables local session-token verification), `WEBHOOK_SIGNING_SECRET` (fallback only; prefer per-store secrets)
- **Default SMS provider (BulkSMS BD):** `SMS_API_ENDPOINT`, `SMS_API_KEY`, `SMS_API_SENDER_ID`
- **EPS Payment Gateway:** `EPS_BASE_URL`, `EPS_PG_URL`, `EPS_MERCHANT_ID`, `EPS_STORE_ID`, `EPS_USERNAME`, `EPS_PASSWORD`, `EPS_HASH_KEY`
- **Dev-only:** `DEV_BYPASS_AUTH=true`, `DEV_STORE_ID` (requires `NODE_ENV=development`)
