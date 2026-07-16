import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { callStructuringModel, insertStructuredSections, MAX_INPUT_CHARS } from "@/lib/ai-structure";

// Give a large single-pass structuring call more headroom than the 30s default.
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

const BASE_PROMPT = `You organize raw text into structured recommendation items. The output will be APPENDED to an existing packet, so only structure the NEW input provided — do not reference or repeat any existing content.

Given raw input from a professional, extract and organize:
- Sections (logical groupings of related items)
- Items within each section, each with:
  - title (required): the name of the recommendation/option
  - address: a physical street address if mentioned for this item
  - description: a brief summary
  - notes: any caveats, personal opinions, or additional context
  - details: key-value pairs (e.g. "Price" → "$2,500/mo", "Hours" → "9am-5pm")
  - links: URLs with labels (see URL classification rules below)
  - photos: image URLs only (see URL classification rules below)
  - contacts: an ORDERED array of the people/businesses associated with this item. An item may legitimately have SEVERAL people (co-owners, an agent and a coordinator, a doctor and an office manager). Add EVERY person the source lists as a SEPARATE contact entry, in order. NEVER merge two people into one contact, and NEVER assign one person's phone/email/website to another. Each: { name, role (ONLY if stated), phone, email, website (ONLY that specific person's own site) }. A community/business website is an item-level link, NOT a person's website.

TABULAR DATA: The input may be pasted from a spreadsheet or CSV. If you detect tab-separated or comma-separated rows with a header row, treat each row as an item. Use column headers to map values to the correct fields.

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
- Extract phone numbers, emails, and websites into contacts, keeping each person's own fields with that person. If two people are listed for the same item, output TWO contacts — never drop the second.
- Keep titles concise (under 60 characters)
- Always provide a label for every link`;

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

Group communities in one section (e.g. "Additional Communities") and support services in a separate section.`,

  "real-estate": `
ADDITIONAL CONTEXT: This input is about real estate listings or property recommendations.

Look specifically for:
- Property addresses (extract as the address field)
- Listing prices (extract as detail: "Price" → "$XXX,XXX")
- Square footage, bedrooms, bathrooms (extract as details)
- Lot size, HOA fees, year built (extract as details)
- Agent or listing contacts
- Property websites or listing URLs
- Any image/photo URLs

Group properties by type or area if the input suggests natural groupings.`,

  "general": "",
};

const OUTPUT_SCHEMA = `
Respond with ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
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
          "contacts": [
            {
              "name": "string or null",
              "role": "string or null (ONLY if the source states it, e.g. Co-owner)",
              "phone": "string or null",
              "email": "string or null",
              "website": "string or null (ONLY a site belonging to this person)"
            }
          ]
        }
      ]
    }
  ]
}`;

interface StructuredItem {
  title: string;
  address?: string | null;
  description?: string | null;
  notes?: string | null;
  details?: { label: string; value: string }[];
  links?: { url: string; label?: string | null }[];
  photos?: string[];
  contacts?: {
    name?: string | null;
    role?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
  }[] | null;
}

interface StructuredSection {
  title: string;
  description?: string | null;
  items: StructuredItem[];
}

export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json();
  const { rawText } = body;

  if (!rawText || typeof rawText !== "string" || rawText.trim().length < 10) {
    return NextResponse.json({ error: "Please paste more text to organize." }, { status: 400 });
  }

  const trimmed = rawText.trim();

  // Fail closed on oversize input — never silently truncate.
  if (trimmed.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      {
        error: "input_too_large",
        message: `This is too large to add in one pass (${trimmed.length.toLocaleString()} characters; limit ${MAX_INPUT_CHARS.toLocaleString()}). Add it in smaller parts instead.`,
      },
      { status: 413 }
    );
  }

  const supabase = createServerClient();

  const { data: packet } = await supabase
    .from("packets")
    .select("id, packet_type, raw_input")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();

  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get the highest existing section sort_order
  const { data: existingSections } = await supabase
    .from("sections")
    .select("sort_order")
    .eq("packet_id", id)
    .order("sort_order", { ascending: false })
    .limit(1);

  const sectionOffset = existingSections && existingSections.length > 0
    ? existingSections[0].sort_order + 1
    : 0;

  // Build prompt
  const typeKey = packet.packet_type || "general";
  const guidance = TYPE_GUIDANCE[typeKey] || "";
  const systemPrompt = BASE_PROMPT + (guidance ? "\n" + guidance : "") + "\n" + OUTPUT_SCHEMA;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured" }, { status: 500 });
  }

  const result = await callStructuringModel({
    systemPrompt,
    rawText: trimmed,
    apiKey,
    tag: "append",
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status }
    );
  }

  const structured = result.data as { sections: StructuredSection[] };
  if (!structured || !Array.isArray(structured.sections)) {
    console.error("[append] AI response missing sections array");
    return NextResponse.json({ error: "AI returned invalid data. Please try again." }, { status: 502 });
  }

  // ============================================================
  // Hydrate — insert-only and all-or-nothing. insertStructuredSections rolls
  // back the sections it created (and their descendants) if anything fails, so
  // a failed "Add with AI" never leaves a half-appended batch. Existing content
  // is never touched. Raw input is appended only after the new items land, so
  // the source record stays consistent with what was actually saved.
  // ============================================================
  try {
    await insertStructuredSections(supabase, id, structured.sections, sectionOffset);

    const timestamp = new Date().toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const delimiter = `\n\n--- Added ${timestamp} ---\n\n`;
    const updatedRawInput = (packet.raw_input || "") + delimiter + trimmed;

    await supabase
      .from("packets")
      .update({ raw_input: updatedRawInput })
      .eq("id", id);
  } catch (e) {
    console.error("[append] Hydrate error:", e);
    return NextResponse.json({ error: "Failed to save new items." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
