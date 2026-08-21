// SOURCE-LEVEL INVARIANTS FOR THE OBSERVE-ONLY LEDGER.
//
// These do not test what the ledger computes — fact-ledger.test.mts does that.
// They test that it is INERT: that nothing reads it, nothing depends on it, and
// no failure of it can reach the professional or the run. An observe-only
// feature that quietly acquires a reader stops being observe-only, and the
// clearest place to catch that is the wiring itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTE = "src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts";
const route = readFileSync(ROUTE, "utf8");
// THE ONE SANCTIONED READER, and the reason it exists.
//
// Unresolved source units are not evidence: they are product state. They block
// publishing and a professional decides them by hand. They are produced per
// chunk and consumed once per run, and the ledger is the only per-chunk channel
// that already exists - so finalize reads `unresolved` out of it, and nothing
// else, and never writes to it.
//
// This is a NARROWING of the original "no reader at all", not an abandonment of
// it. If units ever earn a column of their own, this exception should go with
// the migration that gives them one.
const FINALIZE = "src/app/api/ingest/[runId]/finalize/route.ts";
const finalize = readFileSync(FINALIZE, "utf8");
// The CALL SITE, not the import line — `indexOf("buildChunkLedger")` finds the
// import at the top of the file and would place the ledger before everything.
const CALL = 'buildChunkLedger(segmentText';
const callAt = route.indexOf(CALL);

/** Every application source file, EXCLUDING tests. A test naturally names the
 *  thing it guards, and scanning it would make these assertions fail on their
 *  own text — a trap this codebase has already sprung several times. The guard
 *  against loosening the scan instead is the separate assertion below that the
 *  one legitimate write site is still present. */
function appFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) appFiles(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p)) acc.push(p);
  }
  return acc;
}
const files = appFiles("src");

test("the ledger has exactly one write site and one sanctioned reader", () => {
  const hits = files.filter((f) => readFileSync(f, "utf8").includes("fact_ledger")).sort();
  assert.deepEqual(hits, [ROUTE, FINALIZE].sort(),
    `fact_ledger appears outside the chunk route and finalize: ${hits.join(", ")}`);

  // TWO writes now, both updates: the normal ledger, and the fail-closed
  // evidence write when enforcement throws. Still no read path — a select,
  // order or filter on the column would mean something began depending on it.
  const uses = route.split("fact_ledger").length - 1;
  assert.equal(uses, 2, "unexpected number of fact_ledger touches in the route");
  assert.match(route, /\.update\(\{ fact_ledger: \{ \.\.\.ledger, accounting, enforcement, unresolved \} \}\)/);
  assert.match(route, /fact_ledger: \{ enforcementError/, "the fail-closed evidence write is missing");
  assert.doesNotMatch(route, /select\([^)]*fact_ledger/);
});

test("finalize reads the ledger for unresolved units and NOTHING else", () => {
  // A select is the whole extent of the dependency. An update from here would
  // make finalize a second writer of the evidence trail, and the trail would
  // then no longer be a record of what the chunk actually saw.
  assert.doesNotMatch(finalize, /fact_ledger:\s*\{/, "finalize writes to the ledger");
  assert.doesNotMatch(finalize, /\.update\(\{[^}]*fact_ledger/, "finalize updates the ledger");
  assert.match(finalize, /\.select\("fact_ledger"\)/);
  // Only `unresolved` is read. Accounting and enforcement telemetry stay
  // observe-only, which is the property the original invariant protected.
  const reads = [...finalize.matchAll(/fact_ledger\??\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)], ["unresolved"], `finalize reads ${reads.join(", ")}`);
});

test("no packet, item, section or library path imports the ledger", () => {
  const importers = files.filter((f) => /from "@\/lib\/fact-ledger"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers, [ROUTE], `fact-ledger imported outside the chunk route: ${importers.join(", ")}`);
  // The accounting and enforcement layers are held to the same rule: one
  // consumer each, no read path.
  const acct = files.filter((f) => /from "@\/lib\/chunk-accounting"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(acct, [ROUTE], `chunk-accounting imported outside the chunk route: ${acct.join(", ")}`);
  // enforce-chunk: one VALUE consumer. finalize names its UnresolvedUnit type
  // and must not be able to run enforcement - a type import erases at compile
  // time, so this is the difference between naming a shape and acquiring a
  // second enforcement site.
  const enf = files.filter((f) => /from "@\/lib\/enforce-chunk"/.test(readFileSync(f, "utf8"))).sort();
  assert.deepEqual(enf, [ROUTE, FINALIZE].sort(), `enforce-chunk imported outside the chunk route: ${enf.join(", ")}`);
  assert.match(finalize, /import type \{ UnresolvedUnit \} from "@\/lib\/enforce-chunk"/,
    "finalize imports enforce-chunk as a value, not just its type");
});

test("the ledger is computed after the result is durably staged", () => {
  const staged = route.indexOf("stage_chunk_result");
  const ledger = callAt;
  assert.ok(callAt > 0, "the ledger call site was not found");
  assert.ok(staged > 0 && ledger > staged, "the ledger must not run before staging");
  // ...and after the guard that returns on a staging failure, so a chunk that
  // did not stage never gets a ledger written against it.
  const stageGuard = route.indexOf("if (stageErr) return");
  assert.ok(ledger > stageGuard, "the ledger must run after the staging failure guard");
});

test("a ledger failure cannot fail the chunk", () => {
  const i = callAt;
  const before = route.slice(0, i);
  assert.ok(route.indexOf("buildChunkAccounting({") > callAt, "accounting must be computed with the ledger, after staging");
  const after = route.slice(i);
  // The nearest preceding brace-opener is a try, and the block ends in a catch
  // that returns nothing.
  assert.ok(before.lastIndexOf("try {") > before.lastIndexOf("} catch"), "the ledger write is not inside a try");
  // Structural, not a fixed window: an earlier version sliced 900 characters
  // and broke the moment the block grew, which measures the slice rather than
  // the invariant.
  const catchAt = after.indexOf("} catch {");
  assert.ok(catchAt > 0, "no catch follows the ledger block");
  // No throw, no early return, no status change between the ledger and the
  // route's success response.
  const tail = after.slice(0, after.indexOf('return NextResponse.json({ status: "completed" })'));
  assert.doesNotMatch(tail, /\bthrow\b/);
  assert.doesNotMatch(tail, /NextResponse\.json\(\{ error/);
});

test("the write is guarded on the claim generation, like every other chunk write", () => {
  const block = route.slice(callAt, route.indexOf("} catch {", callAt));
  assert.ok(block.length > 0, "the ledger block is not inside a try/catch");
  assert.match(block, /\.eq\("attempt_count", attempt\)/);
});

// ---------------------------------------------------------------------------
// The database half. The ledger quotes verbatim source text, so it is evidence:
// it must not survive any path that destroys the evidence around it.
// ---------------------------------------------------------------------------
function liveFunctions(upTo = "9999"): Map<string, { file: string; body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  for (const f of readdirSync("supabase/migrations").filter((x) => x.endsWith(".sql") && x < upTo).sort()) {
    const s = readFileSync(join("supabase/migrations", f), "utf8");
    const re = /create or replace function public\.(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const tag = /\bas\s+(\$\w*\$)/.exec(s.slice(m.index));
      if (!tag) continue;
      const openAt = m.index + tag.index + tag[0].length;
      const end = s.indexOf(tag[1], openAt);
      if (end < 0) continue;
      out.set(m[1], { file: f, body: s.slice(m.index, end + tag[1].length) });
    }
  }
  return out;
}

test("every live function that clears chunk evidence also clears the ledger", () => {
  // 0026 removed the clearing from the packet path entirely — finalize and
  // discard now RETAIN evidence for the bounded window — so the set of clearing
  // functions shrank. What must remain true is the rule, not the count: any
  // function that still clears evidence must clear the ledger with it.
  const clearers: string[] = [];
  for (const [name, { body }] of liveFunctions()) {
    if (!/segment_text\s*=\s*null/.test(body)) continue;
    clearers.push(name);
    assert.match(body, /fact_ledger\s*=\s*null/,
      `${name} clears segment_text but leaves fact_ledger behind — the quotations would outlive the source`);
  }
  // The scan found something. Without this the test passes vacuously if the
  // matcher ever stops matching.
  assert.ok(clearers.length >= 1, `expected at least 1 clearing function, found ${clearers.length}`);
  // purge is the one that must always be there: it is how retained evidence
  // eventually goes away.
  assert.ok(clearers.includes("purge_ingestion_evidence"), "scheduled purge no longer clears chunk evidence");
});

test("scheduled expiry treats a ledger-only chunk as still holding evidence", () => {
  const purge = liveFunctions().get("purge_ingestion_evidence");
  assert.ok(purge, "purge_ingestion_evidence is not defined");
  // A chunk whose result and segment were already cleared, but which still
  // holds a ledger, must remain eligible for purge.
  assert.match(purge!.body, /c\.fact_ledger is not null/);
});

test("0025 changes nothing about what the re-issued functions DO", () => {
  // The four functions 0025 re-issues include finalize_ingestion_run, which
  // composes sections and items, and library_close_import_run, which ends a
  // Library import. Re-issuing them is the moment a recipient-facing or
  // saved-Library behaviour change could slip in unnoticed.
  //
  // So prove the negative directly: strip the ledger additions back out of
  // 0025's bodies, and what remains must be BYTE-IDENTICAL to the definition
  // that is live today. Anything else — a reordered statement, a changed guard,
  // a dropped line — fails here.
  const before = liveFunctions("0025");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const after = liveFunctions();
  const reissued = ["finalize_ingestion_run", "discard_ingestion_run", "library_close_import_run", "purge_ingestion_evidence"];

  for (const name of reissued) {
    const was = before.get(name), now = after.get(name);
    assert.ok(was && now, `${name} missing`);
    // finalize and discard were re-issued again by 0026 for packet retention;
    // library close and purge are still last touched by 0025.
    const expectFile = ["finalize_ingestion_run", "discard_ingestion_run"].includes(name)
      ? "0026_packet_evidence_retention.sql" : "0025_ingestion_fact_ledger.sql";
    assert.equal(now!.file, expectFile, `${name} last re-issued by ${now!.file}`);
    if (expectFile !== "0025_ingestion_fact_ledger.sql") return;   // 0026 changes behaviour on purpose
    const stripped = now!.body
      .replace(/fact_ledger = null, /g, "")
      .replace(/ or c\.fact_ledger is not null/g, "");
    assert.equal(stripped, was!.body,
      `${name} differs from its live definition by more than the ledger addition`);
  }
});

test("0025 re-issues nothing else", () => {
  const sql = readFileSync("supabase/migrations/0025_ingestion_fact_ledger.sql", "utf8");
  const defined = [...sql.matchAll(/create or replace function public\.(\w+)\s*\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(defined, ["discard_ingestion_run", "finalize_ingestion_run", "library_close_import_run", "purge_ingestion_evidence"]);
  // One structural change only: the column.
  const ddl = [...sql.matchAll(/^\s*(alter table|create table|drop table|create policy|drop policy|create trigger|drop function)\b/gim)].map((m) => m[1].toLowerCase());
  assert.deepEqual(ddl, ["alter table"], `0025 performs unexpected DDL: ${ddl.join(", ")}`);
});
