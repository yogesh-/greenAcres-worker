/**
 * Green-Acres → CRM Lead Bridge
 * Cloudflare Worker (Hybrid: HTTP Webhook + Email Routing)
 *
 * Option A: Zapier sends POST with subject + body_html
 * Option B: Cloudflare Email Routing forwards email directly
 *
 * Both paths parse the lead and POST to your CRM.
 */

// ============================================================
// MAIN HANDLERS
// ============================================================

export default {
  // --- HTTP Handler (for Zapier webhook) ---
  async fetch(request, env) {
    // Health check
    if (request.method === "GET") {
      return new Response("Green-Acres CRM Worker is running", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      let payload;
      const contentType = request.headers.get("Content-Type") || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const formData = await request.formData();
        payload = Object.fromEntries(formData);
      } else if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        payload = Object.fromEntries(formData);
      } else {
        payload = await request.json();
      }
      const subject = payload.subject || "";
      const htmlBody = payload.body_html || payload.content || "";
      const from = payload.from || "";

      console.log(`[HTTP] Processing: ${subject}`);

      if (!htmlBody) {
        return Response.json({ error: "No body_html provided" }, { status: 400 });
      }

      // Parse and post
      const leadData = parseGreenAcresEmail(htmlBody, subject);

      // Classify — fallback to fetching property page only when subject gave no usable type
      if (!leadData.property_category && !leadData.property_type && leadData.property_url) {
        console.log("Fetching property page for classification...");
        const pageText = await fetchPropertyPage(leadData.property_url);
        if (pageText) {
          const classified = classifyProperty(pageText.toLowerCase());
          if (classified) {
            leadData.property_category = classified;
          }
        }
      }

      console.log("Extracted lead:", JSON.stringify(leadData, null, 2));

      const crmResult = await postToCRM(leadData, env);

      return Response.json({
        success: crmResult.ok,
        lead: {
          contact_name: leadData.contact_name,
          phone: leadData.phone,
          email: leadData.email,
          city: leadData.city,
          property_category: leadData.property_category,
          price: leadData.price,
        },
      });
    } catch (err) {
      console.error(`[HTTP] Error: ${err.message}`);
      return Response.json({ error: err.message }, { status: 500 });
    }
  },

  // --- Email Handler (for Cloudflare Email Routing) ---
  async email(message, env, ctx) {
    try {
      const rawEmail = await new Response(message.raw).text();
      const subject = message.headers.get("subject") || "";

      // Accept if from green-acres.com directly, or if subject matches their pattern
      const from = message.from || "";
      const headerFrom = message.headers.get("from") || "";
      const isGreenAcres =
        from.includes("green-acres.com") ||
        headerFrom.includes("green-acres.com") ||
        rawEmail.includes("green-acres.com") ||
        subject.toLowerCase().includes("request for information");

      if (!isGreenAcres) {
        console.log(`[Email] Rejected: not a Green-Acres email (from: ${from})`);
        message.setReject("Not a Green-Acres email");
        return;
      }

      console.log(`[Email] Processing: ${subject}`);

      const htmlBody = extractHtmlBody(rawEmail);
      if (!htmlBody) {
        console.error("No HTML body found");
        return;
      }

      const leadData = parseGreenAcresEmail(htmlBody, subject);

      if (!leadData.property_category && !leadData.property_type && leadData.property_url) {
        const pageText = await fetchPropertyPage(leadData.property_url);
        if (pageText) {
          const classified = classifyProperty(pageText.toLowerCase());
          if (classified) leadData.property_category = classified;
        }
      }

      console.log("Extracted lead:", JSON.stringify(leadData, null, 2));
      await postToCRM(leadData, env);
    } catch (err) {
      console.error(`[Email] Error: ${err.message}`);
    }
  },
};

// ============================================================
// CRM POSTER
// ============================================================

async function postToCRM(leadData, env) {
  // Map parsed fields to CRM API schema
  const crmPayload = {
    name: leadData.contact_name || "Unknown",
    phone: leadData.phone || undefined,
    email: leadData.email || undefined,
    country: leadData.country || undefined,
    emirate: leadData.city || undefined,
    location: leadData.area_name || undefined,
    developer: leadData.developer || undefined,
    category: leadData.property_category
      ? leadData.property_category.toLowerCase()
      : undefined,
    beds: leadData.bedrooms || undefined,
    budget_min: leadData.price
      ? Number(leadData.price.replace(/,/g, ""))
      : undefined,
    lead_source: "greenAcres",
    notes: [
      leadData.message,
      leadData.property_title
        ? `Property: ${leadData.property_title}`
        : null,
      leadData.property_url
        ? `URL: ${leadData.property_url}`
        : null,
      leadData.property_ref
        ? `Ref: ${leadData.property_ref}`
        : null,
      leadData.property_type
        ? `Type: ${leadData.property_type}`
        : null,
      leadData.transaction_type
        ? `Transaction: ${leadData.transaction_type}`
        : null,
      leadData.surface_m2
        ? `Surface: ${leadData.surface_m2} m²`
        : null,
      leadData.rooms ? `Rooms: ${leadData.rooms}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };

  // Remove undefined fields
  Object.keys(crmPayload).forEach(
    (k) => crmPayload[k] === undefined && delete crmPayload[k]
  );

  console.log("CRM payload:", JSON.stringify(crmPayload, null, 2));

  const response = await fetch(env.CRM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.CRM_API_KEY,
    },
    body: JSON.stringify(crmPayload),
  });

  if (response.ok) {
    console.log(`✅ Lead posted: ${crmPayload.name}`);
  } else {
    const errText = await response.text();
    console.error(`❌ CRM returned ${response.status}: ${errText}`);
  }

  return response;
}

// ============================================================
// HTML BODY EXTRACTOR (for Email Routing path)
// ============================================================

function extractHtmlBody(rawEmail) {
  const htmlMatch = rawEmail.match(
    /Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\.\r?\n|$)/i
  );

  if (htmlMatch) {
    let html = htmlMatch[1];
    if (rawEmail.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
      html = decodeQuotedPrintable(html);
    }
    if (rawEmail.match(/Content-Transfer-Encoding:\s*base64/i)) {
      try {
        html = atob(html.replace(/\s/g, ""));
      } catch (e) {}
    }
    return html;
  }

  if (rawEmail.includes("<html") || rawEmail.includes("<table")) {
    return rawEmail;
  }

  return null;
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

// ============================================================
// EMAIL PARSER
// ============================================================

const EMIRATES = [
  "Abu Dhabi",
  "Dubai",
  "Sharjah",
  "Ajman",
  "Ras Al Khaimah",
  "Umm Al Quwain",
  "Fujairah",
];

const DEVELOPERS = [
  "Emaar",
  "Damac",
  "Binghatti",
  "Ora Developers",
  "Ora Properties",
  "Reportage",
  "Danube",
  "Nakheel",
  "Azizi",
  "Samana",
  "Sobha",
  "Dubai South",
];

function matchDeveloper(text) {
  const t = text.toLowerCase();
  for (const dev of DEVELOPERS) {
    if (t.includes(dev.toLowerCase())) return dev;
  }
  return null;
}

function matchEmirate(text) {
  const t = text.toLowerCase();
  // Try exact list first, including user-provided variant spelling
  const aliases = { "ras al khaima": "Ras Al Khaimah", "rak": "Ras Al Khaimah" };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (t.includes(alias)) return canonical;
  }
  for (const emirate of EMIRATES) {
    if (t.includes(emirate.toLowerCase())) return emirate;
  }
  return null;
}

function parseGreenAcresEmail(htmlBody, subject) {
  const data = {};

  // --- Extract from Subject Line ---
  // "Request for information - House - Buy - Al Badaia 245m² 2,634,000"
  const subjectParts = subject.split(" - ");
  if (subjectParts.length >= 4) {
    data.property_type = subjectParts[1].trim();
    data.transaction_type = subjectParts[2].trim();
    const lastPart = subjectParts[3].trim();
    const areaMatch = lastPart.match(/([\d,.]+)\s*m²/);
    if (areaMatch) data.area_m2 = areaMatch[1];
  }

  // Strip HTML tags for text-based parsing
  const textContent = htmlBody
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x200E;/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

  // --- Contact Info ---

  const nameMatch = textContent.match(
    /Contact\s+name\s+([\s\S]*?)(?=Phone|E-mail|Message|$)/i
  );
  if (nameMatch) data.contact_name = nameMatch[1].trim();

  const telMatch = htmlBody.match(/href="tel:([^"]+)"/);
  if (telMatch) {
    data.phone = telMatch[1];
  } else {
    const phoneText = textContent.match(/Phone\s+number\s+([\d\s+()-]+)/i);
    if (phoneText) data.phone = phoneText[1].trim();
  }

  const mailMatch = htmlBody.match(/href="mailto:([^"]+)"/);
  if (mailMatch) data.email = mailMatch[1];

  const msgMatch = textContent.match(
    /Message\s+([\s\S]*?)(?=Contact\s+name|$)/i
  );
  if (msgMatch) data.message = msgMatch[1].trim();

  // Country: "Mr or Mrs Name (Country)"
  const countryMatch = textContent.match(/Mr or Mrs .+?\((.+?)\)/);
  if (countryMatch) data.country = countryMatch[1].trim();

  // Property Reference
  const refMatch = textContent.match(/Ref[.:]?\s*([\w-]+)/);
  if (refMatch) data.property_ref = refMatch[1].trim();

  // --- Property Details ---
  // "Sharjah : Al Badaia - Hab surface: 245 m² - 4 room - 4 bedroom"
  // "Abu Dhabi : Al Manhal - Hab surface: 305 m² - Land: 390 m² - 4 room - 4 bedroom"
  const propMatch = textContent.match(
    /([A-Z][a-zA-Z\s]+?)\s*:\s*([A-Z][a-zA-Z\s]+?)\s*-\s*Hab surface:\s*([\d,.]+)\s*m²(\s*-\s*Land:\s*[\d,.]+\s*m²)?\s*-\s*(\d+)\s*room\s*-\s*(\d+)\s*bedroom/
  );
  if (propMatch) {
    data.city = matchEmirate(propMatch[1].trim()) || propMatch[1].trim();
    data.area_name = propMatch[2].trim();
    data.surface_m2 = propMatch[3].trim();
    data.has_land = !!propMatch[4]; // presence of Land field → villa or townhouse
    data.rooms = propMatch[5].trim();
    data.bedrooms = propMatch[6].trim();
  }

  // Fallback: if regex missed city, scan full text for a known emirate
  if (!data.city) {
    data.city = matchEmirate(textContent) || undefined;
  }

  // Price — must contain commas (formatted number) or be followed by AED/currency
  const priceMatch = textContent.match(/([\d,]+,[\d]+)\s*(?:AED)?/) ||
    textContent.match(/([\d]{5,})\s*AED/);
  if (priceMatch) data.price = priceMatch[1].trim();

  // Property title
  const titleMatch = htmlBody.match(
    /background-color:\s*rgb\(8,\s*81,\s*67\)[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
  );
  if (titleMatch)
    data.property_title = titleMatch[1].replace(/<[^>]+>/g, "").trim();

  // Property URL
  const detailsMatch = htmlBody.match(
    /<a[^>]*href="([^"]*)"[^>]*>[\s\S]*?more details[\s\S]*?<\/a>/i
  );
  if (detailsMatch) data.property_url = detailsMatch[1];

  // Profile analysis link
  const profileMatch = htmlBody.match(
    /<a[^>]*href="([^"]*)"[^>]*>[\s\S]*?click here[\s\S]*?<\/a>/i
  );
  if (profileMatch) data.profile_analysis_url = profileMatch[1];

  // Combined text for classification
  const searchable = [data.property_title || "", subject, textContent]
    .join(" ")
    .toLowerCase();

  // --- Developer ---
  data.developer = matchDeveloper(searchable) || undefined;

  // --- Classify ---
  // has_land is a hard signal — property has a plot, so it's villa or townhouse
  if (data.has_land) {
    const type = (data.property_type || "").toLowerCase();
    data.property_category =
      type.includes("townhouse") || type.includes("town house")
        ? "townhouse"
        : "villa";
  } else {
    data.property_category = classifyProperty(searchable);
  }

  // --- Metadata ---
  data.source = "Green-Acres";
  data.received_at = new Date().toISOString();

  return data;
}

// ============================================================
// PROPERTY CLASSIFIER
// ============================================================

function classifyProperty(text) {
  if (text.includes("townhouse") || text.includes("town house"))
    return "townhouse";
  if (text.includes("villa")) return "villa";
  if (
    ["apartment", "flat", "studio", "penthouse", "duplex"].some((kw) =>
      text.includes(kw)
    )
  )
    return "apartment";
  return null;
}

async function fetchPropertyPage(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });
    if (response.ok) {
      const html = await response.text();
      return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }
  } catch (e) {
    console.warn(`Failed to fetch property page: ${e.message}`);
  }
  return "";
}