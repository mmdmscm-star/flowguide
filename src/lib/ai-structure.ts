import type { createServerClient } from "./supabase";

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
  // An item may legitimately have MULTIPLE associated people (co-owners, an agent
  // and coordinator, a doctor and office manager, …). Every supplied person must
  // be preserved in order; never merge two people or drop extras.
  contacts?: {
    name?: string | null;
    role?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
  }[] | null;
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
        // Enforce privacy routing at the request level, not only via account
        // settings. Route this packet's data ONLY to a provider endpoint that
        // both refuses to log/train on it (data_collection: "deny") and honors
        // zero data retention (zdr). If no endpoint for STRUCTURE_MODEL
        // qualifies, OpenRouter returns an error instead of silently falling
        // back to a non-compliant provider — we detect and surface that below.
        provider: {
          data_collection: "deny",
          zdr: true,
        },
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error(`[${tag}] OpenRouter HTTP error:`, aiRes.status, errText);

      // Detect the case where NO provider endpoint satisfies our privacy routing
      // (data_collection: "deny" + zdr). OpenRouter has no dedicated
      // machine-readable error *type* for this, but its error body is a stable
      // shape — {"error":{"code":<int>,"message":<str>,"metadata":{…}}} — where
      // `code` mirrors the HTTP status. Its whole "no usable / no allowed
      // endpoint" routing family returns 404 (a bad model id is 400, rate limit
      // 429, etc). Because THIS request pins only the privacy constraints (no
      // provider `only`), a 404 here means no endpoint met the data policy. So
      // we prefer the structured `error.code`, and keep a string scan as a
      // defensive fallback if the body isn't the documented JSON shape.
      let structuredCode: number | null = null;
      try {
        const parsed = JSON.parse(errText);
        if (typeof parsed?.error?.code === "number") structuredCode = parsed.error.code;
      } catch {
        // Non-JSON error body — fall through to the string-based fallback.
      }
      const lower = errText.toLowerCase();
      const noEligibleEndpoint =
        structuredCode === 404 ||
        aiRes.status === 404 ||
        lower.includes("no endpoints") ||
        lower.includes("no allowed providers") ||
        lower.includes("data policy");
      if (noEligibleEndpoint) {
        return {
          ok: false,
          status: 503,
          error: "no_private_endpoint",
          message:
            "Organizing is unavailable right now: no AI provider currently meets FlowGuide’s privacy requirements (no logging, zero data retention) for this model. Your text was not organized, and nothing was sent to a non-compliant provider.",
        };
      }

      // Billing/auth failures are PERMANENT for this key — retrying cannot fix
      // them. Flattening them to a generic 502 made the ingestion orchestrator
      // treat them as transient: it retried, then subdivided, then subdivided
      // again until split_depth was exhausted and the whole import died with
      // "too small to subdivide further". Surface them as their own condition so
      // the caller fails fast with something the professional can act on.
      const billingOrAuth = structuredCode === 402 || aiRes.status === 402
        ? "credits" : structuredCode === 401 || aiRes.status === 401 || structuredCode === 403 || aiRes.status === 403
        ? "auth" : null;
      if (billingOrAuth) {
        return {
          ok: false,
          status: 402,
          error: billingOrAuth === "credits" ? "ai_credits_exhausted" : "ai_key_rejected",
          message: billingOrAuth === "credits"
            ? "The AI account is out of credits, so this couldn't be organized. Add credits and retry — your text was not lost."
            : "The AI service rejected FlowGuide's credentials, so this couldn't be organized. Your text was not lost.",
        };
      }

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
    // Log only non-content diagnostics. The model output is derived from the
    // professional's (and their client's) private source text, so it must never
    // be written to the function logs — even truncated. finish_reason and the
    // error message are safe; the raw content is not.
    console.error(`[${tag}] AI parse failure:`, errMsg);
    console.error(`[${tag}] finish_reason:`, aiData?.choices?.[0]?.finish_reason);
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

        // Preserve EVERY supplied person, in order. Never silently drop extras.
        const contactRows = (item.contacts || [])
          .filter((c) => c && (c.name || c.phone || c.email || c.website))
          .map((c, ci) => ({
            item_id: newItem.id,
            name: c.name || "",
            role: c.role || "",
            phone: c.phone || "",
            email: c.email || "",
            website: c.website || "",
            sort_order: ci,
          }));
        if (contactRows.length > 0) {
          const { error } = await supabase.from("item_contacts").insert(contactRows);
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

// ============================================================
// Append items into an EXISTING section as one unit — "Add items with AI".
//
// One RPC call to insert_items_into_section (migration 0006). The function
// validates the section belongs to the packet, determines the next sort_order
// inside the transaction (locking the section row so concurrent adds can't
// collide), inserts every item + child records, and appends the source text to
// the packet's raw_input — all committed together or not at all. The route does
// NOT compute a sort offset; ordering is owned by the transaction.
// ============================================================
export async function insertItemsIntoSection(
  supabase: ReturnType<typeof createServerClient>,
  packetId: string,
  sectionId: string,
  items: unknown[],
  rawAppend: string
): Promise<void> {
  const { error } = await supabase.rpc("insert_items_into_section", {
    p_packet_id: packetId,
    p_section_id: sectionId,
    p_items: items,
    p_raw_append: rawAppend,
  });
  if (error) throw error;
}
