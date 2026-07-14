import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { callStructuringModel, insertItemsIntoSection, MAX_INPUT_CHARS } from "@/lib/ai-structure";

// Give the single-pass structuring call headroom, like the other AI routes.
export const maxDuration = 60;

type Context = { params: Promise<{ id: string; sectionId: string }> };

// ============================================================
// Operation 1: "Add items with AI" to an EXISTING section — deterministic
// section continuation.
//
// The destination section is fixed by the URL. The full pasted text is sent to
// an ITEMS-ONLY prompt; the model returns items only (never sections), which are
// inserted atomically into the chosen section (sort_order and the raw_input
// append are done inside the RPC transaction). No new sections are ever created.
//
// SCOPE / HONEST LIMITATION: this path does NOT yet prove semantic completeness
// for arbitrary input. It guarantees well-formed, items-only output inserted
// atomically into the selected section, and it rejects truncated/malformed/
// unexpected model output — but it does not verify that every source record
// became exactly one item. Exact source-record accounting (for clean,
// losslessly parsed tabular input) is a separate deferred follow-up.
// ============================================================

const ITEMS_ONLY_PROMPT = `You extract structured ITEMS from raw text to add to ONE existing section of a packet that the professional has already chosen.

Return ONLY items. Do NOT create sections, section titles, groupings, or any placement decision — the destination section is already decided.

Each item may include:
- title (required): the name of the recommendation/option
- address: a physical street address if present
- description: a brief summary
- notes: caveats, opinions, or extra context
- details: key-value pairs [{ "label": string, "value": string }]
- links: URLs with labels [{ "url": string, "label": string }]
- photos: image URLs only
- contact: { name, phone, email, website } for a related person/business

URL classification:
- IMAGE URLs (unsplash/imgur/cloudinary, or ending .jpg/.jpeg/.png/.webp/.gif) -> "photos"
- ALL OTHER URLs -> "links" with a label

Rules:
- Do not invent information not present in the input.
- Preserve all specific details (addresses, phones, prices, hours, names).
- Keep titles concise (under 60 characters).

Respond with ONLY valid JSON in this exact shape (no markdown, no extra keys):
{ "items": [ { "title": "string", "address": "string?", "description": "string?", "notes": "string?", "details": [{"label":"string","value":"string"}], "links": [{"url":"string","label":"string"}], "photos": ["string"], "contact": {"name":"string?","phone":"string?","email":"string?","website":"string?"} } ] }

Omit any empty field. Do NOT include section titles, section ids, groupings, or any field other than those listed above. "items" must be the only top-level key.`;

const ALLOWED_ITEM_KEYS = new Set([
  "title", "address", "description", "notes", "details", "links", "photos", "contact",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Strict items-only validation. We do NOT strip unexpected structure and
// continue — any unexpected shape (a "sections" key, section fields on an item,
// a missing title, wrong types) is rejected so nothing is written.
function validateItemsOnly(parsed: unknown): { ok: true; items: unknown[] } | { ok: false; error: string } {
  if (!isPlainObject(parsed)) return { ok: false, error: "model_output_not_object" };
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "items") {
    return { ok: false, error: `unexpected_top_level_fields:${keys.filter((k) => k !== "items").join(",") || "shape"}` };
  }
  if (!Array.isArray(parsed.items)) return { ok: false, error: "items_not_array" };
  if (parsed.items.length === 0) return { ok: false, error: "no_items" };

  for (const raw of parsed.items) {
    if (!isPlainObject(raw)) return { ok: false, error: "item_not_object" };
    for (const k of Object.keys(raw)) {
      if (!ALLOWED_ITEM_KEYS.has(k)) return { ok: false, error: `unexpected_item_field:${k}` };
    }
    if (typeof raw.title !== "string" || !raw.title.trim()) return { ok: false, error: "item_missing_title" };
    if ("details" in raw && !Array.isArray(raw.details)) return { ok: false, error: "details_not_array" };
    if ("links" in raw && !Array.isArray(raw.links)) return { ok: false, error: "links_not_array" };
    if ("photos" in raw && !Array.isArray(raw.photos)) return { ok: false, error: "photos_not_array" };
    if ("contact" in raw && raw.contact !== null && !isPlainObject(raw.contact)) {
      return { ok: false, error: "contact_not_object" };
    }
  }
  return { ok: true, items: parsed.items };
}

export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, sectionId } = await context.params;

  // The section is identified SOLELY by the URL. The body carries only rawText.
  const body = await request.json();
  const { rawText } = body;

  if (!rawText || typeof rawText !== "string" || rawText.trim().length < 10) {
    return NextResponse.json({ error: "Please paste more text to add." }, { status: 400 });
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

  // Ownership: packet belongs to the caller.
  const { data: packet } = await supabase
    .from("packets")
    .select("id")
    .eq("id", id)
    .eq("user_id", session.userId)
    .single();
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The target section must belong to THIS packet (route-level authz; the RPC
  // re-checks as defense in depth).
  const { data: section } = await supabase
    .from("sections")
    .select("id")
    .eq("id", sectionId)
    .eq("packet_id", id)
    .single();
  if (!section) return NextResponse.json({ error: "Section not found in this packet" }, { status: 404 });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI service not configured" }, { status: 500 });

  // Full input to an items-only prompt. callStructuringModel rejects truncated
  // output (finish_reason === "length") and unparseable JSON before we get here.
  const result = await callStructuringModel({
    systemPrompt: ITEMS_ONLY_PROMPT,
    rawText: trimmed,
    apiKey,
    tag: "append-section",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
  }

  // Strict shape check — reject anything that isn't clean items-only output.
  const validated = validateItemsOnly(result.data);
  if (!validated.ok) {
    console.error("[append-section] rejected model output:", validated.error);
    return NextResponse.json(
      {
        error: validated.error,
        message: "The AI response wasn't a clean list of items, so nothing was added. Please try again.",
      },
      { status: 422 }
    );
  }

  // Preserve the professional's source text exactly, appended atomically inside
  // the RPC (same transaction as the item inserts).
  const timestamp = new Date().toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
  const rawAppend = `\n\n--- Added ${timestamp} ---\n\n${trimmed}`;

  try {
    await insertItemsIntoSection(supabase, id, sectionId, validated.items, rawAppend);
  } catch (e) {
    // A DB error from the RPC — the transaction rolls back, so nothing was
    // inserted and raw_input was not appended.
    console.error("[append-section] insert error:", e);
    return NextResponse.json({ error: "Failed to save new items." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, added: validated.items.length });
}
