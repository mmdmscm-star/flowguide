// THE EXPERIMENT DRIVER.
//
//   FLOWGUIDE_EXP_CONFIRM=1 npx tsx scripts/experiments/context-aware/run.mts
//
// Offline. Touches no database, no packet, no production configuration. Every
// raw response is written to out/ before anything is scored, so a scoring bug
// costs a rerun of the scorer and not of the model.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { corpora, chunksOf, buildSourceMap, promptFor, callModel, MODEL, root, type Call } from "./lib.mts";
import { itemsOf, score, acrossReps, type Score } from "./ruler.mts";

if (!process.env.FLOWGUIDE_EXP_CONFIRM) {
  console.error("Refusing to run: this spends real model calls. Re-run with FLOWGUIDE_EXP_CONFIRM=1.");
  process.exit(2);
}
const REPS = Number(process.env.REPS ?? 3);
const ARMS = (process.env.ARMS ?? "A,B,C").split(",") as ("A" | "B" | "C")[];
const ONLY = process.env.CORPUS ?? "";
const OUT = `${root}/scripts/experiments/context-aware/out`;
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

interface RunRecord {
  arm: string; corpus: string; rep: number;
  calls: number; promptTokens: number; completionTokens: number; ms: number; cost: number;
  malformed: number; malformedDetail: string[];
  items: unknown[];
}

async function oneRun(arm: "A" | "B" | "C", c: { key: string; text: string; packetType: string }, rep: number): Promise<RunRecord> {
  const raw: Array<{ ordinal: number; system: string; user: string; call: Call }> = [];
  let items: unknown[] = [];
  const malformedDetail: string[] = [];

  if (arm === "C") {
    const system = promptFor("C", c.packetType, true);
    const call = await callModel(system, c.text);
    raw.push({ ordinal: 0, system, user: c.text, call });
    if (call.ok) items = itemsOf(call.parsed);
    else malformedDetail.push(`whole-source: ${call.error}`);
  } else {
    // A and B share these boundaries BY CONSTRUCTION - one function, one call.
    const chunks = chunksOf(c.text);
    const map = arm === "B" ? buildSourceMap(c.text) : "";
    for (const ch of chunks) {
      const system = promptFor(arm, c.packetType, ch.isLead);
      // B's ONLY difference: deterministic run-level context ahead of the same
      // segment text. Same boundaries, same per-chunk call, same instructions.
      const user = arm === "B"
        ? `${map}\n\nSEGMENT ${ch.ordinal + 1} OF ${chunks.length} (structure only this text):\n${ch.text}`
        : ch.text;
      const call = await callModel(system, user);
      raw.push({ ordinal: ch.ordinal, system, user, call });
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
      userChars: r.user.length, content: r.call.content })),
  }, null, 2));

  return {
    arm, corpus: c.key, rep,
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
  for (const arm of ARMS) {
    for (let rep = 1; rep <= REPS; rep++) {
      process.stdout.write(`${c.key}/${arm}/r${rep} … `);
      const r = await oneRun(arm, c, rep);
      const s = score(c.text, r.items as any[], r.malformed);
      all.push({ ...r, score: s });
      console.log(`${r.calls} calls, ${r.items.length} items, ${s.accepted} accepted, ${s.wouldBeRepaired} would-repair, ${r.malformed} malformed, ${(r.ms / 1000).toFixed(1)}s`);
    }
  }
}

writeFileSync(`${OUT}/scores.json`, JSON.stringify(all.map((r) => ({
  arm: r.arm, corpus: r.corpus, rep: r.rep, calls: r.calls,
  promptTokens: r.promptTokens, completionTokens: r.completionTokens, ms: r.ms, cost: r.cost,
  score: r.score,
})), null, 2));
console.log(`\nwrote ${OUT}/scores.json and ${all.length} raw transcripts`);
