# Anbernet SMS Gateway — API Reference

Reference copy of the vendor documentation from anbernet.com, saved 2026-07-16.
Source: Anbernet portal → SMS Gateway → API Reference. API keys are generated from
the portal's **API Keys** page.

Capabilities: REST, GET & POST, JSON responses, Unicode SMS.

---

## 1. Base URLs

Two gateways expose an identical `/api/v1` surface:

| Host | Port | Base |
|---|---|---|
| `rapi.anbernet.com` | 9978 | `https://rapi.anbernet.com:9978/api/v1` |
| `wapi.anbernet.com` | 9956 | `https://wapi.anbernet.com:9956/api/v1` |

Incoming SMS is a separate host: `https://inmsg.anbernet.com` (standard TLS port).

> ⚠️ **Unresolved:** the docs do not state the difference between `rapi` and `wapi`,
> nor which is primary. `wapi` documents an extra `403 Too many failed attempts`
> ban response and an extra DLR state (`ACCEPTD`) that `rapi` does not.
> Non-standard ports (9978 / 9956) may be blocked by outbound firewalls.

## 2. Authentication

Two credential schemes appear in the docs:

1. **account + password + token** — used by `balance`, `passchange`, `tokenchange`,
   `dlrcheck`, and the primary `sendsms` examples.
2. **account + api_key** — used by the later `sendsms` examples on both hosts.

Error code `1001` reads "Check account / api_key / token", implying both are valid.

> ⚠️ **Unresolved:** which scheme is preferred/supported for `sendsms`, and whether
> `api_key` replaces the `password`+`token` pair entirely.

**Failure behaviour (critical):**
- `401` → `{"message": "Wrong credentials"}`
- `403` (wapi) → `{"message": "Too many failed attempts"}`
- Docs state: **"Wrong credentials will trigger IP ban after multiple failures."**

Tokens are 40 chars (`secrets.token_hex(20)`). Passwords are stored PBKDF2-SHA256.

---

## 3. Send SMS — `POST|GET /api/v1/sendsms`

### POST (JSON)

```bash
curl -X POST https://rapi.anbernet.com:9978/api/v1/sendsms \
  -H "Content-Type: application/json" \
  -d '{
    "account": "your_account",
    "password": "your_password",
    "token": "your_token",
    "senderid": "YOURSID",
    "receivers": ["8801760505055", "8801777706703"],
    "msgdata": "Your message here",
    "flashon": 0,
    "transtype": "T",
    "campaignId": null
  }'
```

API-key variant:

```bash
curl -X POST https://rapi.anbernet.com:9978/api/v1/sendsms \
  -H "Content-Type: application/json" \
  -d '{"account":"your_account","api_key":"YOUR_API_KEY","senderid":"YOURSID",
       "receivers":["8801760505055"],"msgdata":"Your message here",
       "flashon":false,"transtype":"T","campaignId":""}'
```

### GET (query string)

```bash
curl -X GET "https://rapi.anbernet.com:9978/api/v1/sendsms?account=your_account&password=your_password&token=your_token&senderid=YOURSID&receivers=8801760505055,8801777706703&msgdata=Your%20message%20here&flashon=0&transtype=T&campaignId="
```

`receivers` is **comma-separated** in GET, an **array** in POST. `msgdata` must be URL-encoded in GET.

### Success response

```json
{
  "status": "success",
  "account": "your_account",
  "total": 2,
  "messageids": [
    {"receiver": "8801760505055", "messageid": "550e8400-e29b-41d4-a716-446655440000"},
    {"receiver": "8801777706703", "messageid": "660e8400-e29b-41d4-a716-446655440001"}
  ]
}
```

Success is signalled by the **string** `status: "success"` — not a numeric code.
Each recipient gets its own `messageid` (UUID), used later for DLR lookup.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `account` | string | Yes | — | Account name |
| `password` | string | Yes* | — | Account password (*or `api_key`) |
| `token` | string | Yes* | — | API token (*or `api_key`) |
| `api_key` | string | Yes* | — | Alternative to password+token |
| `senderid` | string | Yes | — | Sender ID, **max 11 chars**, must be registered |
| `receivers` | array / CSV | Yes | — | Phone numbers, format `88XXXXXXXXXX` |
| `msgdata` | string | Yes | — | SMS content |
| `flashon` | bool/int | No | `false` / `0` | Flash SMS flag |
| `transtype` | string | No | `"T"` | `T`=Transactional, `P`=Promotional |
| `campaignId` | string | Conditional | `""` | **Required when `transtype="P"`** |

### Validation rules

- `transtype="T"` (Transactional) → `campaignId` NOT required.
- `transtype="P"` (Promotional) → `campaignId` **REQUIRED**, and the campaign must be
  approved by an admin (see error `1007`).

> ⚠️ **Unresolved:** there is no `unicode`/`type` parameter despite "Unicode SMS"
> being advertised — presumably auto-detected. Unconfirmed for Bangla.
>
> ⚠️ **Unresolved:** partial-failure semantics for a multi-recipient `receivers`
> batch are undocumented (what `status`/`total` look like if some numbers fail).

---

## 4. Delivery report — `POST|GET /api/v1/dlrcheck`

```bash
curl -X POST https://rapi.anbernet.com:9978/api/v1/dlrcheck \
  -H "Content-Type: application/json" \
  -d '{"account":"your_account","password":"your_password","token":"your_token",
       "messageid":"550e8400-e29b-41d4-a716-446655440000"}'
```

```json
{
  "dlrurl": "550e8400-e29b-41d4-a716-446655440000",
  "receiver": "8801760505055",
  "status": "DELIVERED",
  "datetime": "2024-01-15 14:30:25",
  "smscid": "smscid_12345"
}
```

Status values: `DELIVERED`, `ACCEPTD` (accepted by SMSC, initial state — wapi only),
`PENDING`, `FAILED`, `NOT_FOUND`. Not found returns `{"status": "NOT_FOUND"}`.

---

## 5. Balance — `POST|GET /api/v1/balance`

```bash
curl -X POST https://rapi.anbernet.com:9978/api/v1/balance \
  -H "Content-Type: application/json" \
  -d '{"account":"your_account","password":"your_password","token":"your_token"}'
```

```json
{ "Balance Status": "your_account:1234.5678" }
```

Returns a **string** of the form `account:balance` — must be split on `:` and parsed.
The value is **money**, not an SMS count. `401` → `{"message": "Wrong credentials"}`.

---

## 6. Credential management (portal-side; not used by the app)

- `POST|GET /api/v1/passchange` — `{account, old_password, new_password, token}`
  → `{"Password Changed Successfully for Account": "account"}` /
    `{"Password was not Changed for Account": "account"}`
- `POST|GET /api/v1/tokenchange` — `{account, password, token}`
  → `{"Token Changed Successfully for Account": "account:new_token"}` /
    `{"Token was not Changed for Account": "account"}`
  New token = `secrets.token_hex(20)` (40 chars).

> Deliberately **not** implemented in the app — rotating credentials from inside the
> send path is all risk, no benefit. Do it from the portal.

---

## 7. Incoming SMS — `inmsg.anbernet.com`

Separate host and separate credential set (`portal_password`, `incoming_password`).

- `GET /api/incoming/messages` — `{account, portal_password, msisdn, incoming_password}`
  → `{"messages": [{id, msisdn, senderid, destaddr, message, arrivaldate, smsstatus, messageid}], "count": 1}`
- `DELETE /api/incoming/messages` — deletes **ALL** messages for that msisdn
- `DELETE /api/incoming/messages/{id}` — deletes one (body still needs all 4 credentials)
- `POST /api/incoming/change_password` — `{account, portal_password, msisdn, old_password, new_password}`

Errors: `400` missing params, `401` invalid portal credentials, `404` not found,
`503` external API unreachable.

> Out of scope for the SeloraX messaging app (no inbound-SMS feature exists).

---

## 8. Status / error codes

| Code | Meaning | Action |
|---|---|---|
| 9000 | SMS accepted | Save `serverTxnId` for DLR polling |
| 1001 | Authentication failed | Check account / api_key / token |
| 1002 | Insufficient balance | Top up account |
| 1003 | Invalid sender ID | Use a registered sender ID |
| 1004 | Invalid receiver | Check MSISDN format (`88XXXXXXXXXX`) |
| 1005 | TPS limit exceeded | Reduce rate or contact support |
| 1006 | No route | Contact support |
| 1007 | Campaign not approved | Await admin approval |
| 1008 | Missing required parameter | Check all required fields |
| 1009 | Content blocked | Remove blocked words from message |
| 9001 | MNO rejected | Check `mnoResponseMessage` |

> ⚠️ **Unresolved / inconsistent:** this table is not reflected in any documented
> response body. The `sendsms` examples return `status: "success"` (a string), never
> a `9000` code, and reference `messageid` rather than the `serverTxnId` this table
> mentions. `mnoResponseMessage` appears nowhere else. Treat the numeric codes as
> unverified until observed against the live API.

---

## 9. Integration notes for SeloraX messaging

Facts that bear directly on the adapter (`services/sms-providers/`):

1. **Phone format is `88XXXXXXXXXX`** (e.g. `8801760505055`) — no `+`, no leading `0`.
   The app validates/stores BD numbers as `01XXXXXXXXX` (`/^(?:\+?880|0)1[3-9]\d{8}$/`),
   so numbers **must be normalized to the `880` form** before sending or they fail
   with code `1004`.
2. **Success detection is `status === "success"`**, unlike BulkSMS's
   `response_code == 202`. Getting this wrong logs failed sends as `sent` and
   burns customer credits.
3. **Campaigns are Promotional.** `campaign-sender.js` sends bulk marketing SMS,
   which is `transtype="P"` → requires a pre-approved `campaignId`. The app has no
   such concept. Order automations are Transactional (`T`) and unaffected.
4. **Batch-native.** `receivers` accepts many numbers in one call; the current
   adapter interface is one-phone-per-call.
5. **`1005 TPS limit exceeded`** — a rate limit exists but is unquantified.
   `campaign-sender.js` sends in batches of 20.
6. **401 must be treated as fatal, never retried** — the scheduler's 3× retry and
   the campaign batch loop could otherwise trigger the documented IP ban and take
   down SMS for every store.
7. Sender ID is **max 11 chars** and must be pre-registered.
8. Balance is money, not credits — it does not map onto
   `app_messaging_settings.sms_credits`, which the app owns independently.
