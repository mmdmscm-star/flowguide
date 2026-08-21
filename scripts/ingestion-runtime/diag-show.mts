import { readFileSync } from "node:fs";
const runs = [1, 2].map((n) => JSON.parse(readFileSync(`/tmp/diag-run${n}.json`, "utf8")));
const want = (process.env.NAME ?? "").toLowerCase();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
for (const r of runs) {
  const p = r.proposals.find((x: any) => norm(String(x.payload?.title ?? "")).includes(norm(want).slice(0, 12)));
  if (!p) { console.log(`\nrun ${r.n}: no proposal matching "${want}"`); continue; }
  const y = p.payload;
  console.log(`\n${"=".repeat(66)}\nrun ${r.n} — ${y.title}   (chunk ${p.ordinal}, idx ${p.idx})`);
  console.log(`  details (${(y.details ?? []).length}):`);
  for (const d of y.details ?? []) console.log(`      ${String(d.label ?? "").padEnd(30)} ${d.value ?? ""}`);
  console.log(`  notes: ${y.notes ? JSON.stringify(y.notes) : "—"}`);
  console.log(`  description: ${String(y.description ?? "—").slice(0, 120)}`);
}
