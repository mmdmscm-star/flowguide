// Shared AI-structuring prompts for the resilient ingestion pipeline. One place
// so the three entry points (organize / append / section_append) stay
// consistent. Each per-chunk call structures ONE bounded segment.

const URL_RULES = `URL CLASSIFICATION — route each URL by pattern:
- IMAGE (unsplash/imgur/cloudinary or .jpg/.jpeg/.png/.webp/.gif or /image/ or /photo/) -> "photos"
- VIDEO (youtube/youtu.be/vimeo or .mp4) -> "links" label "Video"
- PDF (.pdf or /brochure /flyer /document) -> "links" label "Brochure"
- MAP (google.com/maps, goo.gl/maps) -> "links" label "View on Map"
- ALL OTHER -> "links" label "Website"`;

const ITEM_FIELDS = `Each item: title (required), address, description, notes,
details [{label,value}], links [{url,label}], photos [url], contacts (ORDERED
array of people/businesses; every person a SEPARATE entry, never merged, never
cross-assigned; each { name, role (only if stated), phone, email, website (only
that person's own site) }; a community/business site is an item-level link).`;

const SECTION_SCHEMA = `{
  "sections": [ { "title": "string", "description": "string or null",
    "items": [ { "title": "string", "address": "string or null", "description": "string or null",
      "notes": "string or null", "details": [{"label":"string","value":"string"}],
      "links": [{"url":"string","label":"string or null"}], "photos": ["string"],
      "contacts": [{"name":"string or null","role":"string or null","phone":"string or null","email":"string or null","website":"string or null"}] } ] } ] }`;

const TYPE_GUIDANCE: Record<string, string> = {
  "senior-placement": `Senior living context: community names -> item titles; full addresses; monthly cost, care level, memory care, pet policy as details; tour notes -> notes; contacts (admissions/directors) with phones/emails/websites.`,
  "real-estate": `Real-estate context: property address -> address; price, sq ft, beds/baths, lot, HOA, year as details; agent/listing contacts; listing URLs.`,
  general: "",
};

// organize LEAD chunk: also captures a packet title + optional client name.
export function organizeLeadPrompt(packetType: string): string {
  const g = TYPE_GUIDANCE[packetType] || "";
  return `You organize raw text into a structured recommendation packet. Structure ONLY the provided segment.
Extract a short packet title, an optional clientName if a client/recipient is named, and sections of items.
- ${ITEM_FIELDS}
${g ? "\n" + g + "\n" : ""}
${URL_RULES}

Rules: preserve ALL specifics (addresses, phones, prices, hours, names); do not invent; ambiguous -> notes; full street addresses -> address; keep every person + their own phone/email; keep titles < 60 chars; a label for every link.

Respond with ONLY valid JSON (no markdown):
{ "title": "string", "clientName": "string or null", "sections": ${SECTION_SCHEMA.slice(1)}`;
}

// organize non-lead + all append chunks: sections only (appended to the packet).
export function sectionsPrompt(packetType: string): string {
  const g = TYPE_GUIDANCE[packetType] || "";
  return `You organize raw text into structured recommendation sections+items. Structure ONLY the provided segment; it will be appended to an existing packet — do not repeat existing content.
- ${ITEM_FIELDS}
${g ? "\n" + g + "\n" : ""}
${URL_RULES}

Rules: preserve ALL specifics; do not invent; ambiguous -> notes; full addresses -> address; keep every person + their own phone/email; titles < 60 chars; a label for every link.
If a section heading is provided as context, use it as the section title so items group consistently.

Respond with ONLY valid JSON (no markdown): ${SECTION_SCHEMA}`;
}

// section_append chunks: items only, into the already-chosen section.
export function itemsOnlyPrompt(): string {
  return `You extract structured ITEMS from raw text to add to ONE existing section the professional already chose. Structure ONLY the provided segment.
Return ONLY items — no sections, titles, or grouping.
- ${ITEM_FIELDS}
${URL_RULES}

Rules: do not invent; preserve all specifics; keep every person + their own phone/email; titles < 60 chars.
Respond with ONLY valid JSON (no markdown), items is the ONLY top-level key:
{ "items": [ { "title": "string", "address": "string?", "description": "string?", "notes": "string?", "details": [{"label":"string","value":"string"}], "links": [{"url":"string","label":"string"}], "photos": ["string"], "contacts": [{"name":"string?","role":"string?","phone":"string?","email":"string?","website":"string?"}] } ] }`;
}
