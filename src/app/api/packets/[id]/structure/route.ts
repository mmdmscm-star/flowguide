import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { callStructuringModel, insertStructuredSections, MAX_INPUT_CHARS } from "@/lib/ai-structure";

// Give a large single-pass structuring call more headroom than the 30s default.
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

// ============================================================
// Base prompt — generic structuring rules
// ============================================================
const BASE_PROMPT = `You organize raw text into a structured recommendation packet. A packet contains sections, and each section contains items. Items can have an address, details, links, photos, and contact info.

Given raw input from a professional, extract and organize:
- A packet title (short, descriptive)
- An optional client name if one is mentioned
- Sections (logical groupings of related items)
- Items within each section, each with:
  - title (required): the name of the recommendation/option
  - address: a physical street address if mentioned for this item
  - description: a brief summary
  - notes: any caveats, personal opinions, or additional context
  - details: key-value pairs (e.g. "Price" → "$2,500/mo", "Hours" → "9am-5pm")
  - links: URLs with labels (see URL classification rules below)
  - photos: image URLs only (see URL classification rules below)
  - contact: name, phone, email, or website for a person/business related to this item

TABULAR DATA: The input may be pasted from a spreadsheet or CSV. If you detect tab-separated or comma-separated rows with a header row, treat each row as an item. Use column headers to map values to the correct fields (e.g. a "Name" column → item title, "Address" column → address field, "Price" column → detail, "Website" column → link, "Photo" column → photo).

URL CLASSIFICATION — route each URL to the correct field based on its pattern:
- IMAGE URLs (contains unsplash.com, imgur.com, cloudinary.com, or ends in .jpg, .jpeg, .png, .webp, .gif, or has /image/ or /photo/ in the path) → put in "photos" array
- VIDEO URLs (contains youtube.com, youtu.be, vimeo.com, or ends in .mp4) → put in "links" with label "Virtual Tour" or "Video"
- PDF/DOCUMENT URLs (ends in .pdf, or contains /brochure, /flyer, /document) → put in "links" with label "Brochure" or "PDF"
- MAP URLs (contains google.com/maps, goo.gl/maps, maps.app.goo.gl) → put in "links" with label "View on Map"
- ALL OTHER URLs (.com, .org, etc.) → put in "links" with label "Website"

General rules:
- Group related items into sections with clear, short titles
- Preserve ALL specific details from the input (addresses, phone numbers, prices, hours, names)
- Do not invent information that is not in the input
- If something is ambiguous or doesn't fit a structured field, put it in notes
- Extract full street addresses into the "address" field (not into details)
- Extract phone numbers, emails, and websites into contact fields
- Keep titles concise (under 60 characters)
- If the input mentions a client or recipient by name, extract it as clientName
- Always provide a label for every link`;

// ============================================================
// Packet-type-specific guidance
// ============================================================
const TYPE_GUIDANCE: Record<string, string> = {
  "senior-placement": `
ADDITIONAL CONTEXT: This input is about senior living recommendations for a family.

Look specifically for:
- Community names (these become item titles)
- Full street addresses for each community
- Monthly pricing (extract as a detail: "Monthly Cost" → "$X,XXX")
- Care levels: independent living, assisted living, memory care, continuing care (extract as detail: "Care Level" → "...")
- Memory care availability (extract as detail: "Memory Care" → "Yes/No/Available")
- Pet policies (extract as detail: "Pet Policy" → "...")
- Tour notes or impressions (put in notes field)
- Family preferences or requirements (put in the description or notes)
- Contact people at each community (admissions directors, etc.)
- Phone numbers, emails, websites for each community
- Any image/photo URLs

Group communities in one section (e.g. "Recommended Communities") and support services (attorneys, care managers, movers) in a separate section (e.g. "Support Services").

For support services, extract: business name, contact person, specialty, hourly rates or fees, phone, email, website.`,

  "real-estate": `
ADDITIONAL CONTEXT: This input is about real estate listings or property recommendations.

Look specifically for:
- Property addresses (extract as the address field)
- Listing prices (extract as detail: "Price" → "$XXX,XXX")
- Square footage (extract as detail: "Sq Ft" → "X,XXX")
- Bedrooms and bathrooms (extract as details)
- Lot size, HOA fees, year built (extract as details)
- Agent or listing contacts
- Open house dates (extract as detail)
- MLS numbers (extract as detail)
- Property websites or listing URLs
- Any image/photo URLs

Group properties by type or area if the input suggests natural groupings.`,

  "general": "",
};

// ============================================================
// JSON schema for AI output
// ============================================================
const OUTPUT_SCHEMA = `
Respond with ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "title": "string",
  "clientName": "string or null",
  "sections": [
    {
      "title": "string",
      "description": "string or null",
      "items": [
        {
          "title": "string",
          "address": "string or null",
          "description": "string or null",
          "notes": "string or null",
          "details": [{ "label": "string", "value": "string" }],
          "links": [{ "url": "string", "label": "string or null" }],
          "photos": ["string"],
          "contact": {
            "name": "string or null",
            "phone": "string or null",
            "email": "string or null",
            "website": "string or null"
          }
        }
      ]
    }
  ]
}

COMPACT OUTPUT RULES — keep the response small:
- Omit any field whose value would be null, an empty string, or an empty array
- Omit "contact" entirely when none of its fields have real values
- Always include "title", "sections", every section's "items", and every item's "title"
- Never drop or shorten actual records to save space — compactness applies to formatting only, never to content`;

// ============================================================
// Types
// ============================================================
interface StructuredItem {
  title: string;
  address?: string | null;
  description?: string | null;
  notes?: string | null;
  details?: { label: string; value: string }[];
  links?: { url: string; label?: string | null }[];
  photos?: string[];
  contact?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
  } | null;
}

interface StructuredSection {
  title: string;
  description?: string | null;
  items: StructuredItem[];
}

interface StructuredPacket {
  title: string;
  clientName?: string | null;
  sections: StructuredSection[];
}

// ============================================================
// Handler
// ============================================================
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json();
  const { rawText, packetType } = body;

  if (!rawText || typeof rawText !== "string" || rawText.trim().length < 10) {
    return NextResponse.json({ error: "Please paste more text to organize." }, { status: 400 });
  }

  const trimmed = rawText.trim();

  // Fail closed on oversize input — never silently truncate. Reject with an
  // explanation so the professional can split the input instead of losing part
  // of it without knowing.
  if (trimmed.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      {
        error: "input_too_large",
        message: `This is too large to organize in one pass (${trimmed.length.toLocaleString()} characters; limit ${MAX_INPUT_CHARS.toLocaleString()}). Split it into smaller parts and use "Add with AI" to combine them.`,
      },
      { status: 413 }
    );
  }

  const supabase = createServerClient();

  // Verify packet ownership
  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();

  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Preserve the professional's source immediately, before any AI call, so it
  // survives a structuring failure — the packet is never left with no record of
  // what was pasted.
  await supabase.from("packets").update({ raw_input: trimmed }).eq("id", id);

  // Build the prompt with type-specific guidance
  const typeKey = packetType || "general";
  const guidance = TYPE_GUIDANCE[typeKey] || "";
  const systemPrompt = BASE_PROMPT + (guidance ? "\n" + guidance : "") + "\n" + OUTPUT_SCHEMA;

  // Call Claude via OpenRouter
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured" }, { status: 500 });
  }

  const result = await callStructuringModel({
    systemPrompt,
    rawText: trimmed,
    apiKey,
    tag: "structure",
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status }
    );
  }

  const structured = result.data as StructuredPacket;
  if (!structured || !Array.isArray(structured.sections)) {
    console.error("[structure] AI response missing sections array");
    return NextResponse.json({ error: "AI returned invalid data. Please try again." }, { status: 502 });
  }

  // ============================================================
  // Hydrate — all-or-nothing. insertStructuredSections rolls back every row it
  // created if anything fails, so no partial structure survives. Packet title /
  // client name are set only after the structure lands.
  // ============================================================
  try {
    await insertStructuredSections(supabase, id, structured.sections, 0);

    await supabase
      .from("packets")
      .update({
        title: structured.title || "Untitled Packet",
        client_name: structured.clientName || "",
      })
      .eq("id", id);
  } catch (e) {
    console.error("[structure] Hydrate error:", e);
    return NextResponse.json({ error: "Failed to save structured data." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
