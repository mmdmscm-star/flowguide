import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// runtime.mts and cleanup.mts WRITE TO AND DELETE FROM the configured database.
// They are contained (everything hangs off a disposable @disposable.invalid user
// and is removed by FK cascade), but they must never run by accident — e.g. from
// a test runner glob or CI. Require an explicit opt-in.
if (!process.env.FLOWGUIDE_RT_CONFIRM) {
  console.error(
    "Refusing to run: this harness writes to the database in .env.local.\n" +
    "Re-run with FLOWGUIDE_RT_CONFIRM=1 once you have confirmed the target."
  );
  process.exit(2);
}

export const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
for (const line of readFileSync(`${root}/.env.local`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const svc = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export const anon = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export const TABLES = [
  "packets", "sections", "items", "packet_blocks", "professionals",
  "ingestion_runs", "ingestion_chunks",
];

export async function census() {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { count, error } = await svc.from(t).select("*", { count: "exact", head: true });
    out[t] = error ? -1 : (count ?? 0);
  }
  return out;
}

// Identity fingerprint of genuine rows, so restoration is proven by content,
// not just by count (a delete+insert pair would keep counts equal).
export async function fingerprint() {
  const out: Record<string, string[]> = {};
  for (const t of ["packets", "sections", "items", "packet_blocks", "ingestion_runs", "ingestion_chunks"]) {
    const { data, error } = await svc.from(t).select("id").order("id");
    out[t] = error ? [`ERR:${error.message}`] : (data ?? []).map((r: any) => r.id).sort();
  }
  return out;
}

export function diffIds(before: Record<string, string[]>, after: Record<string, string[]>) {
  const d: Record<string, { added: string[]; removed: string[] }> = {};
  for (const t of Object.keys(before)) {
    const b = new Set(before[t]), a = new Set(after[t]);
    const added = [...a].filter((x) => !b.has(x));
    const removed = [...b].filter((x) => !a.has(x));
    if (added.length || removed.length) d[t] = { added, removed };
  }
  return d;
}

let pass = 0, fail = 0;
const failures: string[] = [];
export function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
export function summary(label: string) {
  console.log(`\n${label}: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  return fail;
}
export const errText = (e: any) => (e ? `${e.message ?? ""} ${e.hint ?? ""} ${e.details ?? ""}`.trim() : "");
