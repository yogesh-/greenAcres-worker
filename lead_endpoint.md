CRM External Lead API — Integration Guide
Endpoint

POST https://erp.infinityrealty.ae/api/crm/external/leads
Authentication
All requests require an API key in the x-api-key header:


x-api-key: 9754654833773752723a9a91b8876da9a5638f2171db9310b6ee7a8b7bcf27e0
Request
Headers:


Content-Type: application/json
x-api-key: <API_KEY>
Body (JSON):


{
  "name": "Ahmed Khan",              // REQUIRED — lead's full name
  "phone": "+971501234567",           // optional — enables duplicate detection
  "email": "ahmed@example.com",       // optional
  "alternate_phone": "+971509876543", // optional
  "country": "UAE",                   // optional
  "emirate": "Dubai",                 // optional — Dubai, Abu Dhabi, Sharjah, etc.
  "project": "Dubai Creek Harbour",   // optional — property project name
  "developer": "Emaar",              // optional — developer name
  "budget_min": 1500000,             // optional — number, no commas
  "budget_max": 2500000,             // optional — number, no commas
  "category": "apartment",           // optional — "apartment" | "townhouse" | "villa"
  "beds": "2",                       // optional — string
  "location": "Creek Beach",         // optional — area/community
  "lead_source": "website",          // optional — defaults to "api" if omitted
  "notes": "Interested in 2BR"       // optional — free text
}
Only name is required. Everything else is optional.

Responses
201 — Lead created successfully:


{
  "success": true,
  "action": "created",
  "lead_id": 1234,
  "assigned_to": 5,
  "lead_source": "website"
}
assigned_to is the user ID of the agent it was round-robin assigned to. If null, no agents were available and the lead went to the unassigned pool.

200 — Duplicate phone detected, queued for admin review:


{
  "success": true,
  "action": "queued_duplicate",
  "existing_lead_id": 999,
  "recommended_action": "merge",
  "message": "A lead with this phone number already exists. Queued for admin review."
}
This is NOT an error. The lead was received but an existing lead with the same phone number was found. An admin will review and resolve it.

401 — Authentication failed:


{ "error": "Missing x-api-key header" }
// or
{ "error": "Invalid API key" }
400 — Validation error:


{ "error": "name is required" }
// or
{ "error": "Invalid category. Must be one of: apartment, townhouse, villa" }
// or
{ "error": "Invalid JSON body" }
500 — Server error:


{ "error": "Failed to create lead" }
curl Examples
Basic lead:


curl -X POST https://erp.infinityrealty.ae/api/crm/external/leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: 9754654833773752723a9a91b8876da9a5638f2171db9310b6ee7a8b7bcf27e0" \
  -d '{"name": "Ahmed Khan", "phone": "+971501234567", "lead_source": "website"}'
Full lead:


curl -X POST https://erp.infinityrealty.ae/api/crm/external/leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: 9754654833773752723a9a91b8876da9a5638f2171db9310b6ee7a8b7bcf27e0" \
  -d '{
    "name": "Ahmed Khan",
    "phone": "+971501234567",
    "email": "ahmed@example.com",
    "country": "UAE",
    "emirate": "Dubai",
    "project": "Dubai Creek Harbour",
    "developer": "Emaar",
    "budget_min": 1500000,
    "budget_max": 2500000,
    "category": "apartment",
    "beds": "2",
    "location": "Creek Beach",
    "lead_source": "property_finder",
    "notes": "Interested in 2BR with creek view"
  }'
Minimal lead (name only):


curl -X POST https://erp.infinityrealty.ae/api/crm/external/leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: 9754654833773752723a9a91b8876da9a5638f2171db9310b6ee7a8b7bcf27e0" \
  -d '{"name": "Walk-in Client"}'
JavaScript/TypeScript Example

async function createLead(leadData: {
  name: string;
  phone?: string;
  email?: string;
  lead_source?: string;
  emirate?: string;
  project?: string;
  developer?: string;
  budget_min?: number;
  budget_max?: number;
  category?: 'apartment' | 'townhouse' | 'villa';
  beds?: string;
  location?: string;
  notes?: string;
}) {
  const res = await fetch('https://erp.infinityrealty.ae/api/crm/external/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': '9754654833773752723a9a91b8876da9a5638f2171db9310b6ee7a8b7bcf27e0',
    },
    body: JSON.stringify(leadData),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Failed to create lead');
  }

  // data.action will be "created" or "queued_duplicate"
  return data;
}

// Usage
const result = await createLead({
  name: 'Ahmed Khan',
  phone: '+971501234567',
  email: 'ahmed@example.com',
  lead_source: 'website',
  emirate: 'Dubai',
});

console.log(result);
// { success: true, action: "created", lead_id: 1234, assigned_to: 5, lead_source: "website" }
Behavior Notes
Round-robin: Leads are automatically assigned to CRM team members who have auto-assign enabled, cycling through them evenly.
Duplicate detection: If phone is provided and matches an existing lead, the submission is queued for admin review instead of creating a duplicate. This is returned as a 200 (not an error).
No phone = no duplicate check: If you omit phone, the lead is always created.
Pool fallback: If no agents have auto-assign enabled, the lead is created but unassigned (goes to the lead pool for manual pickup).
Lead status: All leads are created with status intake.
Notifications: The assigned agent receives an in-app notification.