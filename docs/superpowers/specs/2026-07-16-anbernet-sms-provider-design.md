# Anbernet SMS Provider — Design

**Date:** 2026-07-16
**Status:** Awaiting approval
**Scope:** `selorax-sms-backend` only. Phase 1 of 2 (admin panel deferred).

## Goal

Move all SMS sending in the SeloraX Messaging app from BulkSMS BD to Anbernet,
now that we are an Anbernet vendor. The SeloraX main backend is **not** in scope.

## Constraints

1. **The app is live.** 1,295 SMS sent, most recent 2026-07-16. Real merchants,
   real prepaid credits. A wrong success-check burns customer credits on messages
   that never arrive.
2. **No data loss.** Customers already hold `sms_credits` balances.
3. **A wrong credential can IP-ban the server** (vendor docs, §2). That takes SMS
   down for all 38 stores and cannot be fixed from our side.
4. Must be reversible fast.

## Non-goals (Phase 1)

- Admin panel (Phase 2 — deferred by request).
- DLR polling (`/dlrcheck`). The app has no delivery-status concept today.
- Incoming SMS (`inmsg.anbernet.com`).
- `passchange` / `tokenchange` — credential rotation belongs in the vendor portal,
  never in the send path.
- Batch sending. Anbernet accepts a `receivers` array; the current interface is
  one-phone-per-call and logging is per-phone. Keeping it unchanged reduces risk.
  Revisit for campaigns later.
- Deleting `bulksms.js`. It stays as the rollback path.

## Current state (verified, not assumed)

| Fact | Evidence |
|---|---|
| `resolveProvider()` **ignores** the provider name — hardcodes `BulkSmsProvider` in both branches | `services/sms-providers/index.js:8-24` |
| `settings.provider` is decorative — only echoed to the frontend, never used for logic | only ref is the column list in `models/messaging.js:136` |
| `getPricePerSms()` is **dead code** — exported, never called | grep: definition + export only |
| All 38 stores: `provider='bulksms'`, `use_own_provider=0`, `sender_id=NULL` | `app_messaging_settings` |
| All stores therefore use the platform env keys (`SMS_API_*`) | ditto |
| Campaigns tag `event_topic: 'campaign'` exactly | `services/campaign-sender.js:99` |
| Traffic: ~95% transactional, ~5% campaign; campaigns dormant since 2026-05-13 | `app_messaging_logs`, `app_messaging_campaigns` |
| Main backend's OTP SMS is independent (`utils/helpers.js`, own `SMS_API_*`) | separate repo/process |
| Main backend *can* route pay-link SMS through this app via `MESSAGING_INTERNAL_URL` | `SeloraX-Backend-2/utils/messaging-sms.js` — **unset locally; verify in prod** |

## Design

```
messaging.sendSms(store_id, installation_id, phone, message, { event_topic, … })
  └─ resolveProvider(settings)
       ├─ settings.store_id ∈ SMS_PROVIDER_CANARY_STORE_IDS ? 'anbernet'
       └─ else env SMS_PROVIDER (default 'bulksms')
            ├─ bulksms.js   (unchanged — rollback)
            └─ anbernet.js  (new)
```

### Provider selection

Precedence is **canary allowlist → global env default**:

```js
SMS_PROVIDER=bulksms                  // global default, unchanged during canary
SMS_PROVIDER_CANARY_STORE_IDS=2       // these stores use anbernet
```

Deliberately **not** keyed off `settings.provider`: every one of the 38 rows already
says `'bulksms'`, so honouring that column would silently pin everyone to BulkSMS and
make the env flag dead. And `use_own_provider` means "merchant supplied their own
keys" — overloading it for a rollout canary would be a lie in the data model.

The allowlist mirrors the main backend's existing `EXCLUDE_UNPAID_PENDING_STORE_IDS`
convention, is env-only (no schema change), and gets deleted once the global flip
lands.

### `services/sms-providers/anbernet.js`

Same interface as the BulkSMS adapter so no caller changes:
`sendSms(phone, message, opts) → { success, sms_type, provider_response }`

| Concern | Decision | Why |
|---|---|---|
| Auth | `account` + `api_key` | Vendor supports `api_key` OR `password`+`token`. One secret beats two, and avoids storing the account password. |
| Endpoint | `POST {BASE}/sendsms` (JSON) | Avoids URL-encoding pitfalls with Bangla in query strings. |
| Sender ID | `settings.sender_id || ANBERNET_SENDER_ID` | Column exists and is empty; per-store override lands free and feeds the Phase 2 panel. Max 11 chars. |
| Recipients | `[ normalizeBd(phone) ]` — single-element array | Anbernet needs `88XXXXXXXXXX`; app stores `01XXXXXXXXX`. **Without this every send fails with `1004`.** |
| `transtype` | `event_topic === 'campaign' ? 'P' : 'T'` | Derived, so no caller changes. Order automations are transactional. |
| `campaignId` | `ANBERNET_CAMPAIGN_ID`, only sent when `P` | Vendor requires it for promotional; admin-approved. |
| Promotional w/o campaign id | **Fail fast**, do not send | Sending marketing as `T` risks sender-ID blacklisting and vendor suspension. |
| Success | `body.status === 'success'` | **Not** BulkSMS's `response_code == 202`. Getting this wrong logs failures as `sent` and deducts credits. |
| `messageid` | Store in `provider_response` | Needed if we add DLR later. |
| Timeout | 30s (`AbortSignal.timeout`) | Matches existing adapter. |
| Unicode | No parameter sent | Vendor advertises Unicode but documents no flag — presumably auto-detected. **Must verify with a live Bangla test.** `calculateSmsParts()` still governs credit cost and is unchanged. |

### Phone normalization

```
01760505055    → 8801760505055
8801760505055  → 8801760505055   (unchanged)
+8801760505055 → 8801760505055
```
Anything else → reject before the network call (never send junk to a banning API).
The app's existing validator is `/^(?:\+?880|0)1[3-9]\d{8}$/`.

### Failure handling — the IP-ban guard

| Response | Classification | Behaviour |
|---|---|---|
| `401` Wrong credentials | **FATAL** | Never retry. Trip a process-level circuit breaker: stop all sends, log loudly. |
| `403` Too many failed attempts | **FATAL — already banned** | Same. |
| `1002` insufficient balance | Fatal (vendor account dry) | No retry; retrying cannot help. |
| `1005` TPS limit | Retryable | Existing scheduler backoff is fine. |
| Network/timeout | Retryable | Existing behaviour. |
| `status !== 'success'` | Failed send | Logged `failed`, **no credit deducted** (existing logic). |

This matters because `scheduler.js` retries 3× and `campaign-sender.js` loops
batches of 20 — with bad credentials that becomes a rapid stream of failed auth,
which is exactly what triggers the documented ban.

## Configuration

```bash
SMS_PROVIDER=bulksms                                     # flip to 'anbernet' at step 6
SMS_PROVIDER_CANARY_STORE_IDS=                           # e.g. "2" — forced to anbernet; empty in steady state
ANBERNET_BASE_URL=https://rapi.anbernet.com:9978/api/v1  # OPEN: rapi vs wapi
ANBERNET_ACCOUNT=
ANBERNET_API_KEY=
ANBERNET_SENDER_ID=                                      # global default, ≤11 chars, pre-registered
ANBERNET_CAMPAIGN_ID=                                    # blank until an approved campaign exists
```

`SMS_API_*` (BulkSMS) stays in `.env` — untouched, so rollback needs no re-entry.

## Database changes

**None.** No `ALTER`, no `CREATE`, no `DROP`, no `INSERT`, no `UPDATE` to customer
data. Every column required already exists. `app_messaging_pricing` is untouched
because its only reader (`getPricePerSms`) is dead code.

This is the core safety property: the change is code + env only, so data loss is
structurally impossible rather than merely avoided.

## Rollout

1. Add Anbernet env vars, leave `SMS_PROVIDER=bulksms`. Deploy. **Nothing changes.**
2. Verify credentials out-of-band with a single `/balance` call (read-only, cannot
   send or bill). Confirms account + api_key + base URL + that port 9978/9956 is
   reachable from the server.
3. Canary: `SMS_PROVIDER_CANARY_STORE_IDS=<our own test store>`, global default
   still `bulksms`. Only that store moves; the other 37 are untouched.
4. Send one real transactional SMS to our own handset. Verify: received, correct
   sender ID, credit deducted exactly once, log row `sent`.
5. Repeat with Bangla text to confirm Unicode.
6. Flip globally: `SMS_PROVIDER=anbernet`, clear the canary list. Watch
   `app_messaging_logs` for a `failed` spike.

## Rollback

Set `SMS_PROVIDER=bulksms`, restart. ~10 seconds, no redeploy, no data migration.
Note: nodemon does **not** watch `.env` — restart the process explicitly.

## Verification

No test framework exists in this repo (`tests/` are raw scripts). Plan:
- A standalone `tests/anbernet-adapter.js` exercising pure functions
  (`normalizeBd`, transtype derivation, success parsing, error classification)
  against recorded fixtures — **no network**.
- One scripted live `/balance` check.
- One live send to our own number before any merchant traffic.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Wrong success-check → credits burned on undelivered SMS | **High** | `status === 'success'`, verified against a real send before rollout |
| Bad credentials → IP ban → all 38 stores down | **High** | Fatal-on-401, no retry, circuit breaker; `/balance` probe before enabling |
| Un-normalized phones → 100% failure (`1004`) | High | Normalize + reject invalid pre-flight |
| Port 9978/9956 blocked outbound in prod | Medium | Probe with `/balance` from the prod host at step 2 |
| Bangla arrives garbled (no unicode flag) | Medium | Live Bangla test at step 5 before global flip |
| Campaigns silently sent as `T` | Medium | Derived `transtype`; fail fast when `P` lacks a campaign id |
| Prod `MESSAGING_INTERNAL_URL` set → main-app pay-link SMS silently moves to Anbernet | Medium | **Check prod env before flipping** |
| Vendor error-code table unverified | Low | Classify on HTTP status + `status` field; treat codes as advisory |

## Open questions

1. **`rapi:9978` or `wapi:9956`?** Identical documented surfaces. `wapi` documents
   the `403` ban response and an extra `ACCEPTD` DLR state, hinting it is newer.
   **Blocking** — must come from Anbernet, not from guessing.
2. **Which store is the canary?** Needs to be one we own and can hold a handset for.
   Store 2 ("Pocotep") is the local dev default — confirm it is safe to send a real
   SMS from, or name another.
3. **Sender IDs (plural)** — per-store brands, or a transactional/promotional split?
   Phase 1 ships the global default either way.
4. **Is `MESSAGING_INTERNAL_URL` set in production?** Decides whether main-app
   pay-link SMS also moves to Anbernet.
