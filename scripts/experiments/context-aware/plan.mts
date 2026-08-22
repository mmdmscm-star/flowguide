// Dry run: sizes and chunk plans, no model calls. Run before spending money.
import { corpora, chunksOf, buildSourceMap, promptFor, MODEL } from "./lib.mts";
console.log(`model: ${MODEL}\n`);
let callsA = 0;
for (const c of await corpora()) {
  const ch = chunksOf(c.text);
  const map = buildSourceMap(c.text);
  callsA += ch.length;
  console.log(`${c.key.padEnd(10)} chars ${String(c.text.length).padStart(6)}  chunks ${ch.length}  sourcemap ${map.length} chars`);
  console.log(`  chunk sizes: ${ch.map((x) => x.text.length).join(", ")}`);
}
console.log(`\nper repetition: A=${callsA} calls, B=${callsA} calls, C=3 calls`);
console.log(`three repetitions: ${(callsA * 2 + 3) * 3} model calls total`);
