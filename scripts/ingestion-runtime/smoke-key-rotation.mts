// ONE SMALL PRODUCTION INGESTION SMOKE — does the deployed app still reach
// OpenRouter after the key rotation?
//
// Deliberately minimal: one disposable user, one small source that plans to a
// SINGLE chunk, one real Organize through the deployed routes. The key itself
// is never read, printed or inspected here — the only question asked is whether
// the provider answers, and the only evidence used is the packet that results.
//
// e2e.mts halts the whole pass on a real 401/402/403, which is exactly the
// shape a bad key takes.
import { organize, packetContent, check, summary, modelCalls, BASE } from "./e2e.mts";

console.log(`[smoke] one small Organize against ${BASE}\n`);
const { makeSource } = await import("../../docs/investigations/fixtures/senior-placement-source.mjs");
const src = makeSource(2);

const started = Date.now();
const r = await organize("keyrotation", src);
const secs = ((Date.now() - started) / 1000).toFixed(1);

check("the run finalized", r.outcome === "finalized", String(r.outcome));
check("it was a single-chunk run", r.m.initialChunks === 1, `${r.m.initialChunks}`);
// THE POINT OF THE SMOKE: a run can finalize having called nothing. If no real
// model call happened, this proves nothing about the key.
check("A REAL MODEL CALL WAS MADE", modelCalls() >= 1, `${modelCalls()} calls`);

const c = await packetContent(r.packetId!);
check("the provider returned usable structure", c.items.length >= 2, `${c.items.length} items`);
// Distinctive fixture values, not a count — an empty or defaulted result would
// otherwise read as success.
const titles = c.items.map((i: { title: string }) => i.title).join(" | ");
check("items carry real titles, not placeholders", c.items.every((i: { title: string }) => i.title?.trim()), titles);

console.log(`\n  ${r.m.initialChunks} chunk, ${modelCalls()} model call(s), ${c.items.length} items, ${secs}s`);
console.log(`  titles: ${titles.slice(0, 160)}`);
process.exit(summary("PRODUCTION INGESTION SMOKE (post key rotation)") > 0 ? 1 : 0);
