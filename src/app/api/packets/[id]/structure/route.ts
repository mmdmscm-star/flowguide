import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

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
}`;

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

  const supabase = createServerClient();

  // Verify packet ownership
  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();

  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Build the prompt with type-specific guidance
  const typeKey = packetType || "general";
  const guidance = TYPE_GUIDANCE[typeKey] || "";
  const systemPrompt = BASE_PROMPT + (guidance ? "\n" + guidance : "") + "\n" + OUTPUT_SCHEMA;

  // Call Claude via OpenRouter
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured" }, { status: 500 });
  }

  let structured: StructuredPacket;
  let aiData: any = null;
  let content: string | null = null;
  try {
    const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: rawText.trim().slice(0, 15000) },
        ],
        temperature: 0.3,
        max_tokens: 8000,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("[structure] OpenRouter HTTP error:", aiRes.status, errText);
      return NextResponse.json({ error: "AI service error. Please try again." }, { status: 502 });
    }

    aiData = await aiRes.json();
    content = aiData.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[structure] No content in AI response. finish_reason:", aiData?.choices?.[0]?.finish_reason);
      return NextResponse.json({ error: "No response from AI. Please try again." }, { status: 502 });
    }

    // Parse the JSON — strip markdown code fences if present
    const cleaned = content.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    structured = JSON.parse(cleaned);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[structure] AI parse failure:", errMsg);
    console.error("[structure] finish_reason:", aiData?.choices?.[0]?.finish_reason);
    console.error("[structure] raw content (first 500 chars):", content?.slice(0, 500));
    console.error("[structure] raw content (last 200 chars):", content?.slice(-200));
    return NextResponse.json({ error: "AI returned invalid data. Please try again." }, { status: 502 });
  }

  // ============================================================
  // Hydrate: update packet + create sections/items/sub-fields
  // ============================================================
  try {
    // Update packet title, client name, and save raw input
    await supabase
      .from("packets")
      .update({
        title: structured.title || "Untitled Packet",
        client_name: structured.clientName || "",
        raw_input: rawText.trim(),
      })
      .eq("id", id);

    // Create sections and items
    for (let si = 0; si < structured.sections.length; si++) {
      const section = structured.sections[si];

      const { data: newSection } = await supabase
        .from("sections")
        .insert({
          packet_id: id,
          title: section.title || `Section ${si + 1}`,
          description: section.description || "",
          sort_order: si,
        })
        .select()
        .single();

      if (!newSection) continue;

      for (let ii = 0; ii < section.items.length; ii++) {
        const item = section.items[ii];

        const { data: newItem } = await supabase
          .from("items")
          .insert({
            section_id: newSection.id,
            title: item.title || `Item ${ii + 1}`,
            address: item.address || "",
            description: item.description || "",
            notes: item.notes || "",
            sort_order: ii,
          })
          .select()
          .single();

        if (!newItem) continue;

        // Insert details
        if (item.details && item.details.length > 0) {
          await supabase.from("item_details").insert(
            item.details.map((d, di) => ({
              item_id: newItem.id,
              label: d.label,
              value: d.value,
              sort_order: di,
            }))
          );
        }

        // Insert links
        if (item.links && item.links.length > 0) {
          const validLinks = item.links.filter((l) => l.url && l.url.startsWith("http"));
          if (validLinks.length > 0) {
            await supabase.from("item_links").insert(
              validLinks.map((l, li) => ({
                item_id: newItem.id,
                url: l.url,
                label: l.label || "",
                sort_order: li,
              }))
            );
          }
        }

        // Insert photos
        if (item.photos && item.photos.length > 0) {
          const validPhotos = item.photos.filter((url) => url && url.startsWith("http"));
          console.log(`[structure] Item "${item.title}" has ${validPhotos.length} photos:`, validPhotos);
          if (validPhotos.length > 0) {
            const { error: photoErr } = await supabase.from("item_photos").insert(
              validPhotos.map((url, pi) => ({
                item_id: newItem.id,
                url,
                storage_path: "",
                sort_order: pi,
              }))
            );
            if (photoErr) console.error(`[structure] Photo insert error for "${item.title}":`, photoErr);
          }
        } else {
          console.log(`[structure] Item "${item.title}" has NO photos in AI output`);
        }

        // Insert contact
        if (item.contact && (item.contact.name || item.contact.phone || item.contact.email || item.contact.website)) {
          await supabase.from("item_contacts").insert({
            item_id: newItem.id,
            name: item.contact.name || "",
            phone: item.contact.phone || "",
            email: item.contact.email || "",
            website: item.contact.website || "",
          });
        }
      }
    }
  } catch (e) {
    console.error("Hydrate error:", e);
    return NextResponse.json({ error: "Failed to save structured data." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
