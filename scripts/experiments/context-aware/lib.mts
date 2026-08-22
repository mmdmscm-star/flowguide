// CONTEXT-AWARE INGESTION EXPERIMENT — shared parts.
//
// Three arms over the same sources:
//   A  current record-atomic chunking, current context
//   B  identical chunk boundaries, plus a deterministic run-level source map
//   C  one call with the whole source
//
// The measurement is of the RAW model proposal. The deterministic contract is
// used only as a RULER - it scores what the model proposed and never repairs
// it, because an enforcement repair is not model success.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { segment, DEFAULT_BUDGET } from "../../../src/lib/segmentation.ts";
import { recordEnvelopes } from "../../../src/lib/attribution.ts";
import { detectSourceRecords, detectListRecords } from "../../../src/lib/segmentation.ts";
import { parseClaims } from "../../../src/lib/claim-parser.ts";
import { STRUCTURE_MODEL, MAX_OUTPUT_TOKENS } from "../../../src/lib/ai-structure.ts";
import { organizeLeadPrompt, sectionsPrompt } from "../../../src/lib/ai-prompts.ts";

export const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
for (const line of readFileSync(`${root}/.env.local`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
export const API_KEY = process.env.OPENROUTER_API_KEY!;

// ---------------------------------------------------------------- corpora ---
export interface Corpus { key: string; name: string; text: string; packetType: string }

export async function corpora(): Promise<Corpus[]> {
  const { PASTE } = await import(`${root}/scripts/ingestion-runtime/fixtures/cross-vertical.mts`);
  return [
    // The REAL traced paste, not the synthetic generator in
    // fixtures/senior-placement-source.mjs - that one emits prose blocks and
    // has no tabular structure at all, so it would have measured a different
    // thing than the corpus this experiment names.
    { key: "senior", name: "20-record multiline tabular (senior living)",
      text: readFileSync(`${root}/diagnostic-paste.txt`, "utf8"), packetType: "senior-placement" },
    { key: "icecream", name: "15-record repeated directory (ice cream)",
      text: readFileSync(`${root}/scripts/experiments/context-aware/icecream-source.txt`, "utf8"),
      packetType: "general" },
    { key: "crossvert", name: "cross-vertical structural corpus",
      text: PASTE as string, packetType: "general" },
  ];
}

// ------------------------------------------------------- the B source map ---
//
// DETERMINISTIC AND SOURCE-BACKED ONLY. Record structure, record identities and
// indices, and labels that actually recur across records.
//
// Explicitly NOT here: vertical vocabulary, inferred facts, any judgement about
// what a value means or where it belongs. This arm asks whether more global
// context helps - not whether we can pre-solve the task and call the model's
// transcription of our answer a win.
export function buildSourceMap(source: string): string {
  const env = recordEnvelopes(source);
  const parsed = parseClaims(source, 0);

  const lines: string[] = [];
  lines.push("STRUCTURAL CONTEXT FOR THE COMPLETE SOURCE (derived mechanically from the source text; not instructions, not facts to copy):");

  if (env && env.length) {
    lines.push(`- The full source contains ${env.length} records, detected by repeated structure.`);
    lines.push("- Record identities, in source order:");
    for (let i = 0; i < env.length; i++) {
      // The first non-empty line of the record: its own words, nothing added.
      const head = source.slice(env[i].start, env[i].end)
        .split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
      lines.push(`    ${i + 1}. ${head.slice(0, 120)}`);
    }
    // Cardinality is structure: it says how the SOURCE is shaped, not where any
    // value should go.
    lines.push("- Each of these records is one entry in the source; they are not sub-parts of each other.");
  } else {
    lines.push("- No repeated record structure was detected in this source.");
  }

  // Labels that recur across the source. Recurrence is a source fact; what the
  // label MEANS is not, and is not asserted here.
  const counts = new Map<string, number>();
  for (const c of parsed.claims) {
    const l = String((c as { label?: unknown }).label ?? "").trim();
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const recurring = [...counts.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (x${n})`);
  if (recurring.length) {
    // OBSERVATION, NOT AN ALLOWLIST AND NOT A DESTINATION.
    //
    // v1 of this map said "a recurring label and its value belong together as
    // one detail on that record", and the first run showed exactly what that
    // bought: the model emitted ONLY the listed labels and dropped the rest,
    // and it moved phone numbers out of contacts into Details because it had
    // been told where they went. That measured the instruction, not the
    // context. A structural map states what the source contains; the moment it
    // says where something belongs it is pre-solving the task and the arm stops
    // answering the question.
    lines.push(`- Labels observed on more than one record: ${recurring.slice(0, 40).join("; ")}.`);
    lines.push("- This list is NOT exhaustive and is NOT a selection: it describes what recurs, not what to extract. Extract everything the source states, including labels absent from this list.");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- the chunks ---
export interface Chunk { ordinal: number; start: number; end: number; text: string; isLead: boolean }

/** A and B MUST share these. One function, called once per corpus, so the two
 *  arms cannot drift apart by construction rather than by promise. */
export function chunksOf(source: string): Chunk[] {
  // Segment exposes sourceStart/sourceEnd, NOT start/end. Reading the wrong
  // names gave every chunk `undefined` offsets, which silently made
  // `isLead` false for chunk 0 - so the lead prompt, which production DOES use
  // for the first chunk of an organize run, was never exercised. A typo that
  // produces undefined rather than an error is the expensive kind.
  const segs = segment(source, DEFAULT_BUDGET);
  const out = segs.map((s, i) => ({
    ordinal: i, start: s.sourceStart, end: s.sourceEnd, text: s.text,
    isLead: s.sourceStart === 0,
  }));
  if (!out.length || !out.some((c) => c.isLead) || out.some((c) => !Number.isFinite(c.start))) {
    throw new Error(`chunksOf: bad chunk plan (${out.length} chunks, lead=${out.filter((c) => c.isLead).length})`);
  }
  return out;
}

// ------------------------------------------------------------ the prompts ---
export function promptFor(arm: "A" | "B" | "B2" | "B3" | "O" | "C", packetType: string, isLead: boolean): string {
  // B, B2 and A share the SAME prompts. Only the user-message context differs.
  if (arm !== "C") return isLead ? organizeLeadPrompt(packetType) : sectionsPrompt(packetType);
  // C: the SAME extraction instructions, with only the chunk-specific language
  // removed. Nothing is added - if C won because it was told more about the
  // task, the comparison would be meaningless.
  return organizeLeadPrompt(packetType)
    .replace("Structure ONLY the provided segment.", "Structure the complete source text below.")
    .replace(/If this segment has no entry of its own[^\n]*\n?/, "");
}

// -------------------------------------------------------------- the model ---
export interface Call {
  ok: boolean; status: number; error?: string; finishReason?: string;
  content: string | null; parsed: unknown; ms: number;
  promptTokens: number; completionTokens: number;
  /** What the provider actually charged, rather than a list-price estimate. */
  cost: number;
  provider?: string;
}

/** Mirrors the production call exactly - same model, temperature, ceiling and
 *  privacy routing, imported rather than retyped - and additionally returns the
 *  raw content and usage the production path has no reason to surface. */
export async function callModel(systemPrompt: string, userText: string): Promise<Call> {
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: STRUCTURE_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        temperature: 0.3,
        max_tokens: MAX_OUTPUT_TOKENS,
        provider: { data_collection: "deny", zdr: true },
      }),
      signal: AbortSignal.timeout(300_000),
    });
    // fetch() resolves when the HEADERS arrive; the body is still streaming.
    // Stamping the clock here measured time-to-first-byte and reported a
    // 15,790-token generation as 1.5 seconds - about 10,000 tok/s, which no
    // Claude model does. The clock stops when the body is actually in hand.
    const data = await res.json().catch(() => null) as any;
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error?.message ?? `http ${res.status}`,
        content: null, parsed: null, ms, promptTokens: 0, completionTokens: 0, cost: 0 };
    }
    const finishReason = data?.choices?.[0]?.finish_reason;
    const content = data?.choices?.[0]?.message?.content ?? null;
    const promptTokens = data?.usage?.prompt_tokens ?? 0;
    const completionTokens = data?.usage?.completion_tokens ?? 0;
    const cost = data?.usage?.cost ?? 0;
    const provider = data?.provider;
    if (finishReason === "length") {
      return { ok: false, status: 200, error: "output_truncated", finishReason, content,
        parsed: null, ms, promptTokens, completionTokens, cost, provider };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(content ?? "").replace(/^```(json)?\s*/i, "").replace(/```\s*$/, ""));
    } catch {
      return { ok: false, status: 200, error: "unparseable_json", finishReason, content,
        parsed: null, ms, promptTokens, completionTokens, cost, provider };
    }
    return { ok: true, status: 200, finishReason, content, parsed, ms, promptTokens, completionTokens, cost, provider };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error)?.message ?? "network",
      content: null, parsed: null, ms: Date.now() - t0, promptTokens: 0, completionTokens: 0, cost: 0 };
  }
}

export const MODEL = STRUCTURE_MODEL;


// ============================================================================
// ARM B2 — STRUCTURAL CONTEXT THAT CANNOT BE COPIED.
//
// B failed twice, and both failures were the same failure: the map contained
// material the model could USE. v1 named a subset of labels and told it where
// they went, so it treated the subset as an allowlist and the destination as an
// order. v2 removed the instruction but still listed record identities as their
// own first lines - and the model copied them into titles verbatim.
//
// The lesson is not "word it more carefully". It is that any content in the
// context block is a candidate for the output. So B2 contains NO content: no
// titles, no values, no labels it cannot prove exhaustive, no destinations, no
// prose. Only facts about the SHAPE of the source, plus opaque identifiers.
//
// If the stability gain survives this, the gain was structural awareness. If it
// disappears, the gain was semantic priming - the model doing better because we
// handed it pieces of the answer. Both are results; only one is a feature.
// ============================================================================

function recordSpans(source: string): Array<{ start: number; end: number }> | null {
  const t = detectSourceRecords(source);
  if (t) return t.records.map((r) => ({ start: r.start, end: r.end }));
  const l = detectListRecords(source);
  if (l) return l.records.map((r) => ({ start: r.start, end: r.end }));
  const env = recordEnvelopes(source);
  return env ? env.map((e) => ({ start: e.start, end: e.end })) : null;
}

// B3 = B2 with exactly two INSTRUCTIONAL sentences removed and every factual
// structural line untouched. B2 passed every gate except ice-cream titles,
// where it produced "Mitchell's Ice Cream - San Francisco" instead of
// "Mitchell's Ice Cream" - a literalism its content could not have caused,
// since the block provably shares no text with the source. The hypothesis under
// test is that the pressure came from telling the model to copy.
export type ContextVariant = "B2" | "B3";

export function buildStructuralContext(
  source: string, chunk: { start: number; end: number; ordinal: number }, chunkCount: number,
  variant: ContextVariant = "B2",
): string {
  const tabular = detectSourceRecords(source);
  const list = detectListRecords(source);
  const spans = recordSpans(source);

  const lines: string[] = [];
  lines.push("METADATA ABOUT THE SHAPE OF THE FULL SOURCE. This block is NOT source content.");
  lines.push("Nothing here is a fact about any entry, and nothing here may appear in your output.");
  // REMOVED IN B3. This is the sentence most likely to have produced the
  // literal-title regression: a copy instruction, applied to a source line that
  // happens to contain the city.
  if (variant === "B2") lines.push("Every word of your output must come from the source text below this block.");
  lines.push("");

  if (tabular) {
    lines.push(`- Structure: a delimited table, proven by consistent field counts. ${tabular.fields} columns per record, delimiter ${JSON.stringify(tabular.delimiter)}.`);
    // Headers are included ONLY when the source defines an exhaustive schema
    // row. Neither corpus here has one, so nothing is asserted about columns.
  } else if (list) {
    lines.push("- Structure: a repeated directory of entries, proven by repeated list markers.");
    // Labels are deliberately absent. The detector can show that labels RECUR;
    // it cannot show that a set of them is COMPLETE, and an incomplete list
    // reads as the complete one.
  } else {
    lines.push("- Structure: no repeated record structure could be proven.");
  }

  if (spans && spans.length) {
    lines.push(`- The full source contains ${spans.length} records, numbered R01 to R${String(spans.length).padStart(2, "0")} in source order.`);
    // Which records this chunk covers - by opaque identifier only.
    const covered: string[] = [];
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      if (s.start < chunk.end && s.end > chunk.start) covered.push(`R${String(i + 1).padStart(2, "0")}`);
    }
    if (covered.length === 1) lines.push(`- This segment covers record ${covered[0]}.`);
    else if (covered.length > 1) lines.push(`- This segment covers records ${covered[0]} to ${covered[covered.length - 1]} (${covered.length} of ${spans.length}).`);
    else lines.push("- This segment covers no complete record.");
  }
  lines.push(`- This is segment ${chunk.ordinal + 1} of ${chunkCount}.`);
  // REMOVED IN B3. The second instructional sentence; the factual line above it
  // (which segment this is) stays.
  if (variant === "B2") lines.push("- Records outside this segment are handled by other segments. Do not invent or restate them.");
  return lines.join("\n");
}

/** THE CONTAMINATION GATE, checked before any call is made.
 *
 *  B2's whole claim is that the block carries nothing copyable. That is not a
 *  promise to keep in a comment - it is checked: no run of this many characters
 *  from the block may appear anywhere in the source. */
export function contaminationCheck(block: string, source: string, n = 12): string[] {
  const hay = source.toLowerCase();
  const hits: string[] = [];
  const words = block.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i + n <= words.length; i++) {
    const probe = words.slice(i, i + n);
    if (!/[a-z]/.test(probe)) continue;
    if (hay.includes(probe)) hits.push(probe);
  }
  return [...new Set(hits)];
}


// ============================================================================
// ARM O — ORIENTATION BEFORE EXECUTION.
//
// One extra call, before any chunk, whose only job is to read the whole source
// and say what KIND of thing it is. It is working context, not source truth:
// the chunk still carries the only evidence allowed to support a fact.
//
// The constraints below are not decoration. A brief that names a business, a
// price or a URL has stopped orienting and started extracting, and every later
// number would be measuring a smuggled copy of the source rather than
// understanding of it. `analyseBriefs` checks that rather than trusting it.
// ============================================================================

export const ORIENTATION_MAX_TOKENS = 1200;

export const ORIENTATION_PROMPT = `You are reading a document BEFORE it is processed in pieces. Your only job is to describe what kind of thing it is, so that whoever processes the pieces treats them consistently.

Describe, briefly:
- what kind of collection or document this appears to be;
- the overall repeated structure you can see;
- the recurring kinds of information that appear across entries;
- meaningful variations between entries;
- patterns or ambiguities that could cause inconsistent handling of entries.

You MUST NOT:
- create or propose any structured item, record or field;
- extract or reproduce any individual entry;
- name any specific business, person, place, phone number, address, URL, price or other entry-specific value;
- say which field any information should be placed in;
- make any public/private or confidentiality decision;
- state anything the document does not say.

Write at most 200 words of plain prose. Describe the SHAPE of the document, never its contents.`;

export async function orientationCall(source: string): Promise<Call> {
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: STRUCTURE_MODEL,
        messages: [
          { role: "system", content: ORIENTATION_PROMPT },
          { role: "user", content: source },
        ],
        temperature: 0.3,
        // A short brief needs a small ceiling. This is the ONLY setting that
        // differs from a chunk call, it is reported separately, and it cannot
        // affect the chunk calls that follow.
        max_tokens: ORIENTATION_MAX_TOKENS,
        provider: { data_collection: "deny", zdr: true },
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const data = await res.json().catch(() => null) as any;
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error?.message ?? `http ${res.status}`,
        content: null, parsed: null, ms, promptTokens: 0, completionTokens: 0, cost: 0 };
    }
    return {
      ok: true, status: 200, finishReason: data?.choices?.[0]?.finish_reason,
      content: data?.choices?.[0]?.message?.content ?? null, parsed: null, ms,
      promptTokens: data?.usage?.prompt_tokens ?? 0,
      completionTokens: data?.usage?.completion_tokens ?? 0,
      cost: data?.usage?.cost ?? 0, provider: data?.provider,
    };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error)?.message ?? "network",
      content: null, parsed: null, ms: Date.now() - t0, promptTokens: 0, completionTokens: 0, cost: 0 };
  }
}

/** How the brief is handed to an ordinary chunk call. The chunk prompt itself
 *  is untouched; the brief precedes the same segment text. */
export function withOrientation(brief: string, chunkText: string): string {
  return `WORKING CONTEXT (one reader's impression of the document this segment came from). It is background only. It is NOT evidence, and no fact may come from it.\n${brief.trim()}\n\n--- SEGMENT TO STRUCTURE (the only evidence for anything you output) ---\n${chunkText}`;
}
