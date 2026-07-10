import { createServerClient } from "./supabase";

// ============================================================
// Shared AI-structuring integrity layer.
//
// Both the "new packet" (structure) and "add with AI" (append) routes run the
// same risky path: send raw text to a model, parse structured JSON, write it to
// the database. This module centralizes the two places where silent data loss
// used to hide, so the two routes can never drift apart:
//
//   1. callStructuringModel — refuses truncated output (fail closed).
//   2. insertStructuredSections — all-or-nothing DB write (rolls back on error).
// ============================================================

export const STRUCTURE_MODEL = "anthropic/claude-sonnet-4";

// Hard, honest limits. These are NOT silent truncation points — callers reject
// oversize input up front with an explanation, and truncated output is rejected
// below. Tunable; kept bounded so a single pass stays within the route timeout.
export const MAX_INPUT_CHARS = 30000;
export const MAX_OUTPUT_TOKENS = 24000;

export interface StructuredItem {
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

export interface StructuredSection {
  title: string;
  description?: string | null;
  items: StructuredItem[];
}

export type ModelResult =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { ok: true; data: any }
  | { ok: false; status: number; error: string; message?: string };

// ============================================================
// Call the model and return parsed JSON — or fail closed.
//
// The caller MUST enforce MAX_INPUT_CHARS before calling; this function never
// truncates the input. It rejects any response whose generation was cut short
// (finish_reason === "length"), even if the partial JSON happens to parse — an
// incomplete packet must never be accepted.
// ============================================================
export async function callStructuringModel(opts: {
  systemPrompt: string;
  rawText: string;
  apiKey: string;
  tag: string; // "structure" | "append" — for log correlation
}): Promise<ModelResult> {
  const { systemPrompt, rawText, apiKey, tag } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        model: STRUCTURE_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: rawText }, // never sliced — caller gates on MAX_INPUT_CHARS
        ],
        temperature: 0.3,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error(`[${tag}] OpenRouter HTTP error:`, aiRes.status, errText);
      return { ok: false, status: 502, error: "AI service error. Please try again." };
    }

    aiData = await aiRes.json();
    const finishReason = aiData?.choices?.[0]?.finish_reason;
    content = aiData?.choices?.[0]?.message?.content;

    // FAIL CLOSED on truncated output. `finish_reason === "length"` means the
    // model hit the output-token ceiling mid-generation; the result is
    // incomplete even when the JSON parses cleanly. Reject before parsing so we
    // never save a partial packet.
    if (finishReason === "length") {
      console.error(`[${tag}] Output truncated (finish_reason=length). Rejecting to avoid an incomplete packet.`);
      return {
        ok: false,
        status: 422,
        error: "output_truncated",
        message:
          "This was too large to finish organizing in one pass. Split it into smaller parts and use “Add with AI” to combine them.",
      };
    }

    if (!content) {
      console.error(`[${tag}] No content in AI response. finish_reason:`, finishReason);
      return { ok: false, status: 502, error: "No response from AI. Please try again." };
    }

    // Strip markdown code fences if present, then parse.
    const cleaned = content.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    return { ok: true, data: JSON.parse(cleaned) };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`[${tag}] AI parse failure:`, errMsg);
    console.error(`[${tag}] finish_reason:`, aiData?.choices?.[0]?.finish_reason);
    console.error(`[${tag}] raw content (first 500 chars):`, content?.slice(0, 500));
    console.error(`[${tag}] raw content (last 200 chars):`, content?.slice(-200));
    return { ok: false, status: 502, error: "AI returned invalid data. Please try again." };
  }
}

// ============================================================
// Insert sections/items (+ details/links/photos/contacts) as one unit.
//
// Supabase's JS client can't wrap multiple statements in a real transaction
// without a stored procedure, so this uses a compensating cleanup: it tracks
// every section it creates and, on ANY error, deletes them — the FK cascade
// removes their items/details/links/photos/contacts — before re-throwing. The
// caller sees a thrown error and no partial structure survives.
//
// Unlike the previous implementation, a failed insert THROWS rather than being
// silently skipped, so a dropped section/item can never pass unnoticed.
// ============================================================
export async function insertStructuredSections(
  supabase: ReturnType<typeof createServerClient>,
  packetId: string,
  sections: StructuredSection[],
  sortOffset: number
): Promise<void> {
  const createdSectionIds: string[] = [];

  try {
    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];

      const { data: newSection, error: sErr } = await supabase
        .from("sections")
        .insert({
          packet_id: packetId,
          title: section.title || `Section ${sortOffset + si + 1}`,
          description: section.description || "",
          sort_order: sortOffset + si,
        })
        .select()
        .single();

      if (sErr || !newSection) throw sErr || new Error("Section insert returned no row");
      createdSectionIds.push(newSection.id);

      const items = section.items || [];
      for (let ii = 0; ii < items.length; ii++) {
        const item = items[ii];

        const { data: newItem, error: iErr } = await supabase
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

        if (iErr || !newItem) throw iErr || new Error("Item insert returned no row");

        if (item.details && item.details.length > 0) {
          const { error } = await supabase.from("item_details").insert(
            item.details.map((d, di) => ({
              item_id: newItem.id,
              label: d.label,
              value: d.value,
              sort_order: di,
            }))
          );
          if (error) throw error;
        }

        const validLinks = (item.links || []).filter((l) => l.url && l.url.startsWith("http"));
        if (validLinks.length > 0) {
          const { error } = await supabase.from("item_links").insert(
            validLinks.map((l, li) => ({
              item_id: newItem.id,
              url: l.url,
              label: l.label || "",
              sort_order: li,
            }))
          );
          if (error) throw error;
        }

        const validPhotos = (item.photos || []).filter((url) => url && url.startsWith("http"));
        if (validPhotos.length > 0) {
          const { error } = await supabase.from("item_photos").insert(
            validPhotos.map((url, pi) => ({
              item_id: newItem.id,
              url,
              storage_path: "",
              sort_order: pi,
            }))
          );
          if (error) throw error;
        }

        const c = item.contact;
        if (c && (c.name || c.phone || c.email || c.website)) {
          const { error } = await supabase.from("item_contacts").insert({
            item_id: newItem.id,
            name: c.name || "",
            phone: c.phone || "",
            email: c.email || "",
            website: c.website || "",
          });
          if (error) throw error;
        }
      }
    }
  } catch (e) {
    // All-or-nothing: remove everything this call created so no partial
    // structure survives the failure. Descendants cascade from sections.
    if (createdSectionIds.length > 0) {
      await supabase.from("sections").delete().in("id", createdSectionIds);
    }
    throw e;
  }
}
