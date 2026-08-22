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
  return segment(source, DEFAULT_BUDGET).map((s, i) => ({
    ordinal: i, start: s.start, end: s.end, text: s.text, isLead: s.start === 0,
  }));
}

// ------------------------------------------------------------ the prompts ---
export function promptFor(arm: "A" | "B" | "C", packetType: string, isLead: boolean): string {
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
