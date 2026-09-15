// 0054 backfill CLI. DRY RUN BY DEFAULT.
//
//   node --env-file=.env.local --import tsx scripts/publication-backfill/cli.mts
//       dry run: lists candidates, builds and compares every copy, writes nothing
//   node --env-file=.env.local --import tsx scripts/publication-backfill/cli.mts --apply --manifest <new file>
//       stores the copies, one Sendset at a time, and records each stored row
//   node --import tsx scripts/publication-backfill/cli.mts rollback-sql <manifest> > rollback.sql
//       prints the manifest-bound SQL that removes backfilled rows (run as postgres)
//
// Prints ids and outcomes only — never Sendset content, names or contact values.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { backfillOne, listCandidates, rollbackSql, type ManifestEntry, type Outcome } from "./lib.ts";

const args = process.argv.slice(2);

if (args[0] === "rollback-sql") {
  const manifest = JSON.parse(readFileSync(args[1], "utf8")) as ManifestEntry[];
  process.stdout.write(rollbackSql(manifest));
  process.exit(0);
}

const apply = args.includes("--apply");
const manifestPath = args.includes("--manifest") ? args[args.indexOf("--manifest") + 1] : undefined;
if (apply && !manifestPath) { console.error("--apply requires --manifest <path to a new file>"); process.exit(2); }
if (apply && existsSync(manifestPath!)) { console.error(`refusing to overwrite an existing manifest: ${manifestPath}`); process.exit(2); }

const { createServerClient } = await import("../../src/lib/supabase.ts");
const db = createServerClient();

const candidates = await listCandidates(db);
console.log(`${apply ? "APPLY" : "DRY RUN"}: ${candidates.length} candidate(s)`);

const outcomes: Outcome[] = [];
const manifest: ManifestEntry[] = [];
const save = () => { if (apply) writeFileSync(manifestPath!, JSON.stringify(manifest, null, 1) + "\n"); };
save();
for (const id of candidates) {
  const o = await backfillOne(db, id, { apply });
  outcomes.push(o);
  if ("manifest" in o) { manifest.push(o.manifest); save(); }   // recorded as soon as the row exists
  console.log(`${id.slice(0, 8)} ${o.outcome}${"reason" in o ? ` (${o.reason})` : ""}`);
  if (o.outcome === "stored_but_unverified") { console.error("STOPPING: a stored row could not be verified."); break; }
}

const tally: Record<string, number> = {};
for (const o of outcomes) tally[o.outcome] = (tally[o.outcome] ?? 0) + 1;
console.log(JSON.stringify({ candidates: candidates.length, ...tally }));
process.exit(outcomes.every((o) => o.outcome === (apply ? "backfilled" : "would_backfill")) ? 0 : 1);
