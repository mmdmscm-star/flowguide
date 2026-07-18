// Cleanup + baseline restoration proof.
// SAFETY: deletes ONLY users whose email ends in @disposable.invalid AND begins
// with the harness prefix. Every test row hangs off such a user, so the FK
// cascade removes exactly the harness footprint. Genuine rows are never targeted.
import { svc, census, fingerprint, diffIds, check, summary, errText } from "./lib.mts";
import { readFileSync } from "node:fs";

const base = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));

const { data: victims, error: verr } = await svc
  .from("users").select("id, email").like("email", "flowguide-rt-%@disposable.invalid");
if (verr) { console.error("lookup failed:", errText(verr)); process.exit(1); }
console.log(`disposable users to remove: ${victims?.length ?? 0}`);
for (const v of victims ?? []) console.log(`  ${v.id}  ${v.email}`);

// Refuse to proceed if anything looks non-disposable.
const unsafe = (victims ?? []).filter((v: any) => !/^flowguide-rt-\d+(-other)?@disposable\.invalid$/.test(v.email));
if (unsafe.length) { console.error("ABORT — non-disposable email matched:", unsafe); process.exit(1); }

for (const v of victims ?? []) {
  // magic_links key off email, not a user FK, so they do not cascade.
  await svc.from("magic_links").delete().eq("email", v.email);
  const { error } = await svc.from("users").delete().eq("id", v.id);
  if (error) console.error(`  delete ${v.id} failed: ${errText(error)}`);
}
// Any magic link minted for a disposable address, even if its user is already gone.
await svc.from("magic_links").delete().like("email", "flowguide-rt-%@disposable.invalid");

console.log("\n=== BASELINE RESTORATION ===");
const after = await census();
const afterFp = await fingerprint();
console.log("before:", JSON.stringify(base.census));
console.log("after :", JSON.stringify(after));

for (const [t, n] of Object.entries(base.census)) {
  check(`${t} count restored (${n})`, after[t] === n, `expected ${n}, got ${after[t]}`);
}
// Identity-level proof: no genuine row added or removed, not merely equal counts.
const d = diffIds(base.fingerprint, afterFp);
check("no row-identity drift in any table", Object.keys(d).length === 0, JSON.stringify(d).slice(0, 300));

const { count: leftRuns } = await svc.from("ingestion_runs").select("*", { count: "exact", head: true });
const { count: leftChunks } = await svc.from("ingestion_chunks").select("*", { count: "exact", head: true });
check("no ingestion_runs left behind", leftRuns === 0, `${leftRuns}`);
check("no ingestion_chunks left behind", leftChunks === 0, `${leftChunks}`);
const { count: leftUsers } = await svc.from("users").select("*", { count: "exact", head: true }).like("email", "%@disposable.invalid");
check("no disposable users left behind", leftUsers === 0, `${leftUsers}`);
const { count: leftLinks } = await svc.from("magic_links").select("*", { count: "exact", head: true }).like("email", "%@disposable.invalid");
check("no disposable magic links left behind", leftLinks === 0, `${leftLinks}`);
const { count: leftSessions } = await svc.from("sessions").select("*", { count: "exact", head: true });
console.log(`  sessions remaining (genuine): ${leftSessions}`);
// No staged source text may survive anywhere.
const { data: staleRuns } = await svc.from("ingestion_runs").select("id, source_text");
check("no staged source text anywhere", (staleRuns ?? []).every((r: any) => !r.source_text), `${(staleRuns ?? []).filter((r: any) => r.source_text).length} runs still hold source`);

process.exit(summary("CLEANUP") > 0 ? 1 : 0);
