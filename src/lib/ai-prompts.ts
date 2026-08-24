// Shared AI-structuring prompts for the resilient ingestion pipeline. One place
// so the three entry points (organize / append / section_append) stay
// consistent. Each per-chunk call structures ONE bounded segment.

const URL_RULES = `URL CLASSIFICATION — route each URL by pattern:
- IMAGE (unsplash/imgur/cloudinary or .jpg/.jpeg/.png/.webp/.gif or /image/ or /photo/) -> "photos"
- VIDEO (youtube/youtu.be/vimeo or .mp4) -> "links" label "Video"
- PDF (.pdf or /brochure /flyer /document) -> "links" label "Brochure"
- MAP (google.com/maps, goo.gl/maps) -> "links" label "View on Map"
- ALL OTHER -> "links" label "Website"`;

// PRIVATE NOTE HAS A STRICT MEANING NOW.
//
// `ambiguous -> notes` used to send anything the model could not place into a
// field the recipient never sees. A real import put thirteen "Why it made the
// list" paragraphs — prose written FOR the client — into it. Uncertainty is not
// privacy, and a private field is not an overflow bin.
const NOTES_RULE = `notes is PRIVATE and is for the professional only. Put something there ONLY when the source itself says it is private, internal, confidential or not for the client. Never put ordinary information there because you are unsure where it belongs — if you cannot place something, leave it in description rather than notes.`;

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

// The escape hatch. A segment can be the TAIL of an entry that began in an
// earlier segment — a run of photos with no identifying text of its own. With no
// legal way to say "there is nothing here", the model composed an entity from
// the only string available: the image filename. That is exactly how
// `Primrose Photo 4` and `Drake T Community Property` reached client packets.
// The validator has always accepted an empty result; the model was never told.
const NOTHING_RULE = `If this segment has no entry of its own — only photos, URLs or a fragment continuing something that started earlier — return an EMPTY list. Returning nothing is a valid, expected answer. NEVER build a title out of a URL, filename or image path.`;

// LOSSLESS ORGANIZATION.
//
// Offline measurement showed the model compressing on its own initiative:
// keeping one value where the source listed several, replacing an enumeration
// with a summary. Not truncation and not randomness - an editorial judgement
// that some of what the source said was redundant.
//
// Every rule here is a general statement about not reducing factual content.
// None names a field, a domain or a kind of value: a rule that had to know what
// the document was about would be teaching the answer rather than setting a
// contract, and would not survive the next vertical.
//
// Paired offline runs, senior-living corpus, three repetitions, replicated:
// source-backed placement 71.5% -> 77.1%, omissions 19.7 -> 15.7, with
// fabrication, unauthorized private notes, misbinding and malformed output all
// flat at zero, item counts unchanged, no new within-item duplication, and
// output tokens at 1.02x. Controls unchanged.
//
// FROZEN as measured. Changing this wording invalidates that measurement.
const LOSSLESS_RULES = `LOSSLESS ORGANIZATION - this applies to the whole source:
- Every distinct factual claim stated in the source must still be represented in your output.
- Where several values of the same kind are given, they are separate facts. Keep all of them; do not choose one as representative.
- Enumerations of facts must be preserved as the individual facts they are. Do not replace a list of values with a summary, a range, or a description of the list.
- Apparent redundancy is not permission to omit. Two values that look similar, or that seem to serve the same purpose, are still two facts.
- You may reorganize how information is presented and grouped. You may not reduce how much factual content is present.`;

// organize LEAD chunk: also captures a packet title + optional client name.
export function organizeLeadPrompt(packetType: string): string {
  const g = TYPE_GUIDANCE[packetType] || "";
  return `You organize raw text into a structured recommendation packet. Structure ONLY the provided segment.
Extract a short packet title, an optional clientName if a client/recipient is named, and sections of items.
- ${ITEM_FIELDS}
${g ? "\n" + g + "\n" : ""}
${URL_RULES}

Rules: preserve ALL specifics (addresses, phones, prices, hours, names); do not invent; full street addresses -> address; keep every person + their own phone/email; keep titles < 60 chars; a label for every link.
${NOTES_RULE}
${NOTHING_RULE}

Respond with ONLY valid JSON (no markdown):
{ "title": "string", "clientName": "string or null", "sections": ${SECTION_SCHEMA.slice(1)}

${LOSSLESS_RULES}`;
}

// organize non-lead + all append chunks: sections only (appended to the packet).
export function sectionsPrompt(packetType: string): string {
  const g = TYPE_GUIDANCE[packetType] || "";
  return `You organize raw text into structured recommendation sections+items. Structure ONLY the provided segment; it will be appended to an existing packet — do not repeat existing content.
- ${ITEM_FIELDS}
${g ? "\n" + g + "\n" : ""}
${URL_RULES}

Rules: preserve ALL specifics; do not invent; full addresses -> address; keep every person + their own phone/email; titles < 60 chars; a label for every link.
${NOTES_RULE}
${NOTHING_RULE}
If a section heading is provided as context, use it as the section title so items group consistently.

Respond with ONLY valid JSON (no markdown): ${SECTION_SCHEMA}

${LOSSLESS_RULES}`;
}

// section_append chunks: items only, into the already-chosen section.
export function itemsOnlyPrompt(): string {
  return `You extract structured ITEMS from raw text to add to ONE existing section the professional already chose. Structure ONLY the provided segment.
Return ONLY items — no sections, titles, or grouping.
- ${ITEM_FIELDS}
${URL_RULES}

Rules: do not invent; preserve all specifics; keep every person + their own phone/email; titles < 60 chars.
${NOTES_RULE}
${NOTES_RULE}
${NOTHING_RULE}
Respond with ONLY valid JSON (no markdown), items is the ONLY top-level key:
{ "items": [ { "title": "string", "address": "string?", "description": "string?", "notes": "string?", "details": [{"label":"string","value":"string"}], "links": [{"url":"string","label":"string"}], "photos": ["string"], "contacts": [{"name":"string?","role":"string?","phone":"string?","email":"string?","website":"string?"}] } ] }`;
}
