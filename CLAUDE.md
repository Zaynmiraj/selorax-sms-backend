# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SeloraX Messaging is an SMS notification microservice for the SeloraX e-commerce marketplace. It runs as a standalone Express app that integrates with the SeloraX platform via OAuth client credentials (similar to Shopify app architecture). It sends SMS notifications to customers on order events and allows merchants to manage templates, wallets, and manual SMS sending.

## Architecture

### Request Flow

```
Platform webhook/frontend → Express routes → auth middleware → models → MySQL/Platform API
```

### Authentication (middlewares/auth.js)

Three auth modes, checked in order:
1. **Session Token (local):** `X-Session-Token` header verified with `SESSION_SIGNING_KEY` JWT (HS256). Fastest path.
2. **Session Token (platform):** Same header, verified via HTTP call to platform's `/api/apps/session/verify` using `client_id + client_secret`. Results cached 5 min in-memory.
3. **Legacy JWT:** `x-auth-token` header + `x-store-id` header, verified with `JWT_SECRET`. Backwards-compatible.

Auth populates `req.user` (`store_id`, `installation_id`, `app_id`) and `req.installation`.

### Platform API Communication (services/platform-api.js)

All platform calls authenticate via `X-Client-Id` + `X-Client-Secret` + `X-Store-Id` headers (Shopify offline-token pattern). No per-store access tokens are stored locally.

### Key Data Flow

- **Wallet operations** (balance, debit, top-up) go through the **SeloraX Platform Billing API** — the app does not directly manage wallet tables. See `services/platform-billing.js` → `services/platform-api.js`.
- **SMS pricing** is stored locally in `app_messaging_pricing` table.
- **Settings, templates, and logs** are stored in the app's own MySQL tables.

### Webhook Processing (routers/webhooks.js)

Platform sends `order.status_changed` webhooks signed with HMAC-SHA256 (`X-SeloraX-Signature` header, format `sha256=<hex>`, signs `timestamp.rawBody`). HMAC verification uses the raw request body bytes (captured via `express.json({ verify })`) to avoid re-serialization mismatches. The webhook handler validates BD phone numbers (`01X-XXXXXXXX`), checks for duplicate sends (same order+event in last 5 min), maps order statuses to template event topics via `STATUS_TO_EVENT_TOPIC`, renders `{{variable}}` placeholders, then calls the SMS send flow (balance check → send → log → deduct).

### SMS Providers (services/sms-providers/)

Provider resolution: if merchant has `use_own_provider` + `api_key` in settings, their keys are used; otherwise platform default env vars. Currently only BulkSMS BD adapter exists. The adapter auto-detects Unicode/Bangla text and sends `type=unicode` instead of `type=text` when non-GSM-7 characters are present.

### Database

MySQL with `mysql2` connection pool (startup/db.js). Tables prefixed with `app_messaging_`:
- `app_messaging_settings` — per-store config (provider, auto-SMS toggle)
- `app_messaging_templates` — SMS templates with `{{variable}}` placeholders, keyed by `(installation_id, event_topic)`
- `app_messaging_logs` — SMS delivery logs
- `app_messaging_pricing` — per-provider SMS pricing
- `app_messaging_wallets`, `app_messaging_transactions`, `app_messaging_payment_sessions` — defined in migration but wallet ops now go through platform API

Migration files are in `migrations/` and must be run manually.

### Route Structure

All routes under `/api/messaging`:
- `/settings`, `/templates`, `/send`, `/logs`, `/stats` — core messaging (routers/messaging.js)
- `/wallet`, `/wallet/transactions`, `/wallet/pricing` — wallet info (routers/wallet.js)
- `/payment/topup`, `/payment/verify/:charge_id` — billing charges (routers/payment.js)
- `/oauth/token`, `/oauth/revoke` — platform install/uninstall hooks (routers/oauth.js)
- `/webhooks/receive` — inbound platform webhooks (routers/webhooks.js)
- `/health` — health check (startup/routes.js)

### Error Handling

Route handlers are wrapped in `asyncMiddleware` (try/catch → next(error)). Global error handler in `middlewares/error.js` returns 500.

## Commands

- **Dev server:** `yarn dev` (uses nodemon, auto-restarts on changes)
- **Production:** `yarn start` (or `yarn start:bun` for Bun runtime)
- **No build step** — plain Node.js, no transpilation

There are no tests or linting configured in this project.

## Environment

See `.env.example` for all required variables. Key groups:
- **Server:** `PORT` (default 5002), `NODE_ENV`
- **MySQL:** `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_PORT`
- **SeloraX Platform:** `SELORAX_CLIENT_ID`, `SELORAX_CLIENT_SECRET`, `SELORAX_API_URL`
- **Auth:** `JWT_SECRET`, `SESSION_SIGNING_KEY` (optional), `WEBHOOK_SIGNING_SECRET`
- **SMS Provider:** `SMS_API_ENDPOINT`, `SMS_API_KEY`, `SMS_API_SENDER_ID`
### OAuth Install/Uninstall (routers/oauth.js)

- **Install (`POST /oauth/token`):** Verifies HMAC if signing key is set, creates a settings row via `ensureSettings`.
- **Uninstall (`POST /oauth/revoke`):** Deactivates settings (`is_enabled=0`, `auto_sms_enabled=0`) and all templates (`is_active=0`) for the store, preventing further webhook-triggered SMS sends.
