# Green-Acres → CRM Lead Bridge

## Overview

A Cloudflare Worker that automatically captures real estate leads from the Green-Acres platform and pushes them into the Infinity Realty CRM. Supports two intake paths: Cloudflare Email Routing (primary) and HTTP webhook (fallback/Zapier).

---

## System Architecture

```
Green-Acres Platform
       │
       ▼
  Zoho Mail (leads@zoho)
       │
       ▼
  Zapier (Premium)
  ├── Step 1: Trigger — New Email in Zoho Mail (polls every 2 min)
  ├── Step 2: Filter — Only continue if From = no-reply-en@email.green-acres.com
  └── Step 3: Email by Zapier — Forward to leads@crm-leads.infinityrealty.ae
       │
       ▼
  Cloudflare Email Routing
  (crm-leads.infinityrealty.ae MX → Cloudflare)
       │
       ▼
  Cloudflare Worker: greenacres-leads-2-crm
  (src/index.js — email handler)
       │
       ▼
  CRM API: POST https://erp.infinityrealty.ae/api/crm/external/leads
       │
       ▼
  Lead created in CRM & assigned to agent (round-robin)
```

### Alternative path (HTTP webhook, e.g. direct Zapier POST):
```
Zapier → POST https://greenacres-leads-2-crm.yogesh-gupta38.workers.dev → Worker (fetch handler) → CRM
```

---

## Infrastructure

| Component | Details |
|-----------|---------|
| Worker name | `greenacres-leads-2-crm` |
| Worker URL | `https://greenacres-leads-2-crm.yogesh-gupta38.workers.dev` |
| Cloudflare account | `yogesh.gupta38@gmail.com` (ID: `bbf7434dcd145d7edec9a4318079d66f`) |
| Email routing address | `leads@crm-leads.infinityrealty.ae` |
| CRM endpoint | `https://erp.infinityrealty.ae/api/crm/external/leads` |
| Runtime | Cloudflare Workers (V8, edge) |
| Deployment tool | Wrangler CLI (`npx wrangler deploy`) |

---

## Environment Variables

Set in Cloudflare Dashboard → Workers & Pages → `greenacres-leads-2-crm` → Settings → Variables and Secrets.

| Variable | Type | Value |
|----------|------|-------|
| `CRM_API_URL` | Plain text (var) | `https://erp.infinityrealty.ae/api/crm/external/leads` |
| `CRM_API_KEY` | Secret | Set via dashboard — do NOT hardcode |

To set the secret via CLI:
```bash
npx wrangler secret put CRM_API_KEY
```

---

## Code Structure

```
greenAcres-worker/
├── src/
│   └── index.js          # Main worker (all logic)
├── wrangler.toml         # Cloudflare Worker config
├── package.json          # Project metadata + scripts
├── lead_endpoint.md      # CRM API integration spec
└── CLAUDE.md             # This file
```

### `src/index.js` — Function Reference

#### `fetch(request, env)` — HTTP Handler
Handles POST requests from Zapier webhooks or any HTTP client.

- `GET /` → health check, returns `"Green-Acres CRM Worker is running"`
- `POST /` → accepts JSON, form-urlencoded, or multipart payloads
  - Required field: `body_html` (HTML email body)
  - Optional: `subject`, `from`
- Parses lead → optionally fetches property page for classification → posts to CRM
- Returns JSON: `{ success, lead: { contact_name, phone, email, city, property_category, price } }`

#### `email(message, env, ctx)` — Email Handler
Triggered by Cloudflare Email Routing when an email arrives at `leads@crm-leads.infinityrealty.ae`.

- Accepts email if any of the following match:
  - Envelope `from` contains `green-acres.com`
  - `From` header contains `green-acres.com`
  - Raw email body contains `green-acres.com`
  - Subject contains `"request for information"`
- Rejects all other emails with `setReject()`
- Extracts HTML body from raw MIME email → parses → posts to CRM

> **Note:** Zapier's "Email by Zapier" sends from Zapier's own address, so the multi-condition check above is necessary to accept forwarded emails.

#### `postToCRM(leadData, env)`
Maps parsed lead fields to CRM API schema and POSTs.

Field mapping:
| Parsed field | CRM field |
|---|---|
| `contact_name` | `name` (required) |
| `phone` | `phone` |
| `email` | `email` |
| `country` | `country` |
| `city` | `emirate` |
| `area_name` | `location` |
| `property_category` | `category` (lowercase) |
| `bedrooms` | `beds` |
| `price` | `budget_min` (number, commas stripped) |
| — | `lead_source: "greenAcres"` |
| message + property details | `notes` |

Auth header: `x-api-key: env.CRM_API_KEY`

#### `extractHtmlBody(rawEmail)`
Extracts HTML part from raw MIME email. Handles:
- `quoted-printable` encoding (via `decodeQuotedPrintable`)
- `base64` encoding (via `atob`)
- Plain HTML fallback

#### `parseGreenAcresEmail(htmlBody, subject)`
Parses a Green-Acres lead notification email. Extracts:

From subject line (`Request for information - Villa - Buy - Al Badaia 245m² 2,634,000`):
- `property_type`, `transaction_type`, `area_m2`

From HTML body:
- `contact_name`, `phone`, `email`, `message`, `country`
- `city`, `area_name`, `surface_m2`, `rooms`, `bedrooms`
- `price` (formatted number with commas, or followed by AED)
- `property_title` (from green header `rgb(8, 81, 67)`)
- `property_url` (from "more details" link)
- `profile_analysis_url` (from "click here" link)
- `property_ref` (from "Ref:" label)

Metadata: `source: "Green-Acres"`, `received_at: ISO timestamp`

#### `classifyProperty(text)`
Keyword classifier returning lowercase CRM-compatible values:
- `"townhouse"` or `"town house"` → `"townhouse"`
- `"villa"` → `"villa"`
- `"apartment"`, `"flat"`, `"studio"`, `"penthouse"`, `"duplex"` → `"apartment"`
- No match → `null` (field omitted from CRM payload)

#### `fetchPropertyPage(url)`
Fetches the Green-Acres property listing page and returns plain text for enhanced classification. Used as fallback when `classifyProperty` returns `null`.

---

## CRM API Reference

**Endpoint:** `POST https://erp.infinityrealty.ae/api/crm/external/leads`

**Auth:** `x-api-key` header

**Required fields:** `name`

**Response codes:**
- `201` — Lead created, `{ success, action: "created", lead_id, assigned_to }`
- `200` — Duplicate phone, `{ success, action: "queued_duplicate", existing_lead_id }`
- `401` — Invalid/missing API key
- `400` — Validation error (missing name, invalid category, bad JSON)
- `500` — Server error

**Valid category values:** `"apartment"` | `"townhouse"` | `"villa"` (lowercase only)

**Behavior:**
- Leads assigned round-robin to agents with auto-assign enabled
- Duplicate detection via phone number
- Default lead status: `intake`
- Assigned agent receives in-app notification

---

## Zapier Configuration

**Zap:** Green-Acres Lead → CRM

| Step | App | Action | Config |
|------|-----|--------|--------|
| 1 | Zoho Mail | New Email | Polls every 2 min |
| 2 | Filter by Zapier | Filter conditions | From Address **exactly matches** `no-reply-en@email.green-acres.com` |
| 3 | Email by Zapier | Send Outbound Email | To: `leads@crm-leads.infinityrealty.ae`, Subject + Body mapped from step 1 |

---

## Cloudflare Email Routing Setup

1. Domain `crm-leads.infinityrealty.ae` has MX records pointing to Cloudflare
2. Email Routing enabled in Cloudflare Dashboard → domain → Email → Email Routing
3. Routing rule: `leads@crm-leads.infinityrealty.ae` → **Send to Worker** → `greenacres-leads-2-crm`

---

## Deployment

```bash
# Install wrangler if needed
npm install -g wrangler

# Login
npx wrangler login

# Deploy
npx wrangler deploy

# View live logs
npx wrangler tail --format=pretty
```

---

## Testing

### Health check
```bash
curl https://greenacres-leads-2-crm.yogesh-gupta38.workers.dev
# → "Green-Acres CRM Worker is running"
```

### Test full lead (HTTP path)
```bash
curl -X POST https://greenacres-leads-2-crm.yogesh-gupta38.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Request for information - Villa - Buy - Al Badaia 245m² 2,634,000",
    "body_html": "<html><body><div>Contact name John Smith</div><div><a href=\"tel:+971501234567\">+971501234567</a></div><div><a href=\"mailto:john@test.com\">john@test.com</a></div><div>Mr or Mrs John Smith (UAE)</div><div>Sharjah : Al Badaia - Hab surface: 245 m² - 4 room - 3 bedroom</div><div>2,634,000 AED</div></body></html>",
    "from": "no-reply-en@email.green-acres.com"
  }'
```

### Test CRM endpoint directly
```bash
curl -X POST "https://erp.infinityrealty.ae/api/crm/external/leads" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <CRM_API_KEY>" \
  -d '{"name": "Test Lead", "phone": "+971501111111", "lead_source": "greenAcres"}'
```

---

## Green-Acres Email Format

Green-Acres sends lead notifications from `no-reply-en@email.green-acres.com`.

**Subject format:**
```
Request for information - {PropertyType} - {TransactionType} - {AreaName} {Size}m² {Price}
```

**Body contains:**
- Contact name, phone (tel: link), email (mailto: link)
- Buyer message
- Country in parentheses: `Mr or Mrs Name (UAE)`
- Property line: `Sharjah : Al Badaia - Hab surface: 245 m² - 4 room - 3 bedroom`
- Price followed by AED
- Property title in a green header (`rgb(8, 81, 67)`)
- "More details" link to the property listing
- Property reference: `Ref: GA-XXXXX`
