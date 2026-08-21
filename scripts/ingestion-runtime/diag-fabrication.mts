import { readFileSync } from "node:fs";
import { findUnbacked } from "../../src/lib/source-backed.ts";
const runs = [1, 2].map((n) => JSON.parse(readFileSync(`/tmp/diag-run${n}.json`, "utf8")));
for (const r of runs) {
  let total = 0; const shown: string[] = [];
  for (const c of r.chunks) {
    if (!c.segment_text || !c.result) continue;
    const items = [...(c.result.items ?? []), ...((c.result.sections ?? []).flatMap((s: any) => s.items ?? []))];
    const u = findUnbacked(c.segment_text, items);
    total += u.length;
    for (const x of u) if (shown.length < 8) shown.push(`chunk ${c.ordinal} · ${x.field}: ${String(x.value).slice(0, 60)}`);
  }
  console.log(`  run ${r.n}: ${total} unbacked URL/email/phone/website value(s)`);
  for (const s of shown) console.log(`      ${s}`);
}
