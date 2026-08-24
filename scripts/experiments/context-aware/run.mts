// THE EXPERIMENT DRIVER.
//
//   FLOWGUIDE_EXP_CONFIRM=1 npx tsx scripts/experiments/context-aware/run.mts
//
// Offline. Touches no database, no packet, no production configuration. Every
// raw response is written to out/ before anything is scored, so a scoring bug
// costs a rerun of the scorer and not of the model.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { corpora, chunksOf, buildSourceMap, buildStructuralContext, contaminationCheck,
  promptFor, callModel, orientationCall, withOrientation, MODEL, root, type Call } from "./lib.mts";
import { itemsOf, score, acrossReps, type Score } from "./ruler.mts";

if (!process.env.FLOWGUIDE_EXP_CONFIRM) {
  console.error("Refusing to run: this spends real model calls. Re-run with FLOWGUIDE_EXP_CONFIRM=1.");
  process.exit(2);
}
const REPS = Number(process.env.REPS ?? 3);
const ARMS = (process.env.ARMS ?? "A,B,C").split(",") as ("A" | "A2" | "B" | "B2" | "B3" | "O" | "C" | "C2")[];
const ONLY = process.env.CORPUS ?? "";
const OUT = `${root}/scripts/experiments/context-aware/out`;
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

interface RunRecord {
  arm: string; corpus: string; rep: number;
  calls: number; promptTokens: number; completionTokens: number; ms: number; cost: number;
  malformed: number; malformedDetail: string[];
  /** Did any of the metadata block reach the generated content? */
  mapLeakage: string[];
  /** Arm O only: the orientation call, reported separately from chunk work. */
  orientation?: { brief: string; ms: number; promptTokens: number; completionTokens: number; cost: number };
  items: unknown[];
}

// Strings that exist ONLY in the B2 metadata block. If any appears in generated
// output, the block stopped being metadata and became material.
const LEAK_MARKERS = [
  /\bR\d{2}\b/, /METADATA/i, /delimiter/i, /\bsegment \d+ of \d+/i,
  /handled by other segments/i, /shape of the full source/i,
];

async function oneRun(arm: "A" | "A2" | "B" | "B2" | "B3" | "O" | "C" | "C2", c: { key: string; text: string; packetType: string }, rep: number): Promise<RunRecord> {
  const raw: Array<{ ordinal: number; system: string; user: string; chunkText: string; call: Call }> = [];
  let items: unknown[] = [];
  const malformedDetail: string[] = [];
  let orientation: RunRecord["orientation"];

  if (arm === "C" || arm === "C2") {
    const system = promptFor(arm, c.packetType, true);
    const call = await callModel(system, c.text);
    raw.push({ ordinal: 0, system, user: c.text, chunkText: c.text, call });
    if (call.ok) items = itemsOf(call.parsed);
    else malformedDetail.push(`whole-source: ${call.error}`);
  } else {
    // Every chunked arm shares these boundaries BY CONSTRUCTION.
    const chunks = chunksOf(c.text);
    // ORIENTATION FIRST, once, before any chunk of this repetition. Each
    // repetition gets its OWN brief - reusing one across repetitions would hide
    // exactly the variability the experiment is trying to measure.
    if (arm === "O") {
      const o = await orientationCall(c.text);
      orientation = { brief: String(o.content ?? ""), ms: o.ms,
        promptTokens: o.promptTokens, completionTokens: o.completionTokens, cost: o.cost };
      if (!o.ok || !orientation.brief.trim()) {
        throw new Error(`orientation call failed: ${o.error ?? "empty brief"}`);
      }
    }
    const map = arm === "B" ? buildSourceMap(c.text) : "";
    for (const ch of chunks) {
      const system = promptFor(arm, c.packetType, ch.isLead);
      // The ONLY difference between arms: what precedes the identical segment
      // text. Same boundaries, same per-chunk call, same instructions.
      let user = ch.text;
      if (arm === "B") {
        user = `${map}\n\nSEGMENT ${ch.ordinal + 1} OF ${chunks.length} (structure only this text):\n${ch.text}`;
      } else if (arm === "O") {
        user = withOrientation(orientation!.brief, ch.text);
      } else if (arm === "B2" || arm === "B3") {
        const block = buildStructuralContext(c.text, ch, chunks.length, arm);
        // CHECKED, NOT PROMISED. If any 12-character run of the block occurs in
        // the source, the block is carrying copyable content and the arm is
        // invalid - so the run stops rather than producing a number nobody
        // should trust.
        const hits = contaminationCheck(block, c.text);
        if (hits.length) {
          throw new Error(`B2 context block contains source-derived text (${hits.length} runs, e.g. ${JSON.stringify(hits[0])})`);
        }
        user = `${block}\n\n--- SOURCE TEXT FOR THIS SEGMENT (the only content to structure) ---\n${ch.text}`;
      }
      const call = await callModel(system, user);
      raw.push({ ordinal: ch.ordinal, system, user, chunkText: ch.text, call });
      if (call.ok) items = items.concat(itemsOf(call.parsed));
      else malformedDetail.push(`chunk ${ch.ordinal}: ${call.error}`);
    }
  }

  // RAW FIRST. Written before a single number is computed.
  writeFileSync(`${OUT}/raw-${c.key}-${arm}-r${rep}.json`, JSON.stringify({
    model: MODEL, arm, corpus: c.key, rep,
    calls: raw.map((r) => ({ ordinal: r.ordinal, ok: r.call.ok, error: r.call.error,
      finishReason: r.call.finishReason, ms: r.call.ms,
      promptTokens: r.call.promptTokens, completionTokens: r.call.completionTokens,
      cost: r.call.cost, provider: r.call.provider,
      userChars: r.user.length, chunkText: r.chunkText, content: r.call.content })),
    orientation,
  }, null, 2));

  // Checked on the RAW content, before parsing or scoring.
  const generated = raw.map((r) => r.call.content ?? "").join("\n");
  const mapLeakage = LEAK_MARKERS.filter((re) => re.test(generated)).map((re) => re.source);

  return {
    arm, corpus: c.key, rep, mapLeakage, orientation,
    calls: raw.length,
    promptTokens: raw.reduce((n, r) => n + r.call.promptTokens, 0),
    completionTokens: raw.reduce((n, r) => n + r.call.completionTokens, 0),
    ms: raw.reduce((n, r) => n + r.call.ms, 0),
    cost: raw.reduce((n, r) => n + r.call.cost, 0),
    malformed: malformedDetail.length, malformedDetail,
    items,
  };
}

const all: Array<RunRecord & { score: Score }> = [];
for (const c of (await corpora()).filter((x) => !ONLY || x.key === ONLY)) {
  for (let rep = 1; rep <= REPS; rep++) {
    // Odd repetitions run the arms in order, even repetitions reversed.
    const order = rep % 2 === 1 ? ARMS : [...ARMS].reverse();
    for (const arm of order) {
      process.stdout.write(`${c.key}/${arm}/r${rep} … `);
      const r = await oneRun(arm, c, rep);
      const s = score(c.text, r.items as any[], r.malformed);
      all.push({ ...r, score: s });
      console.log(`${r.calls} calls, ${r.items.length} items, ${s.accepted} accepted, ${s.wouldBeRepaired} would-repair, ${r.malformed} malformed, leak ${r.mapLeakage.length}, ${(r.ms / 1000).toFixed(1)}s`);
    }
  }
}

writeFileSync(`${OUT}/scores.json`, JSON.stringify(all.map((r) => ({
  arm: r.arm, corpus: r.corpus, rep: r.rep, calls: r.calls,
  promptTokens: r.promptTokens, completionTokens: r.completionTokens, ms: r.ms, cost: r.cost,
  mapLeakage: r.mapLeakage, orientation: r.orientation, score: r.score,
})), null, 2));
console.log(`\nwrote ${OUT}/scores.json and ${all.length} raw transcripts`);
