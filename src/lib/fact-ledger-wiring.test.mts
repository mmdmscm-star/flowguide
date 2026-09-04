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
// 0028 GAVE THE UNITS THEIR OWN COLUMN, so the exception 0027 needed is gone
// and the original rule stands again: the ledger has ONE writer and NO reader.
// `ingestion_chunks.review_units` carries product state; `fact_ledger` carries
// evidence; finalize reads the first and cannot see the second.
const FINALIZE = "src/app/api/ingest/[runId]/finalize/route.ts";

/** Comments stripped. Every file here EXPLAINS the ledger boundary, and the
 *  explanation names the column - so a scan of raw text matches its own
 *  rationale and can never pass. The fix is to narrow the scan, never to
 *  loosen the pattern. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}
const finalize = codeOf(FINALIZE);
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

test("the ledger has exactly one write site and no read site", () => {
  const hits = files.filter((f) => codeOf(f).includes("fact_ledger"));
  assert.deepEqual(hits, [ROUTE], `fact_ledger appears outside the chunk route: ${hits.join(", ")}`);

  // TWO writes now, both updates: the normal ledger, and the fail-closed
  // evidence write when enforcement throws. Still no read path — a select,
  // order or filter on the column would mean something began depending on it.
  // Counted in CODE. The route now explains the two-column split in prose, and
  // counting the explanation as a touch made a comment look like a dependency.
  const uses = codeOf(ROUTE).split("fact_ledger").length - 1;
  assert.equal(uses, 2, "unexpected number of fact_ledger touches in the route");
  // ONE update, TWO columns: evidence and product state describe the same
  // chunk and are written together, but they are separate columns so a change
  // to what we record for diagnosis cannot change what a professional is asked.
  assert.match(codeOf(ROUTE),
    /\.update\(\{ fact_ledger: \{ \.\.\.ledger, accounting, enforcement, unresolved \},\s*review_units: reviewUnits\.length \? reviewUnits : null \}\)/);
  assert.match(route, /fact_ledger: \{ enforcementError/, "the fail-closed evidence write is missing");
  assert.doesNotMatch(route, /select\([^)]*fact_ledger/);
});

test("product behaviour reads review_units and never the ledger", () => {
  // The whole point of 0028. If this ever fails, evidence has become
  // load-bearing again and a change to what we record for diagnosis can change
  // what a professional is asked to decide.
  assert.doesNotMatch(finalize, /fact_ledger/, "finalize can see the evidence ledger again");
  assert.match(finalize, /\.select\("review_units"\)/);
  // The units channel is READ by finalize and WRITTEN only by the chunk route,
  // which is the same one-writer discipline the ledger has.
  const writers = files.filter((f) => /review_units:\s/.test(codeOf(f)));
  assert.deepEqual(writers, [ROUTE], `review_units written outside the chunk route: ${writers.join(", ")}`);
});

test("no packet, item, section or library path imports the ledger", () => {
  const importers = files.filter((f) => /from "@\/lib\/fact-ledger"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers, [ROUTE], `fact-ledger imported outside the chunk route: ${importers.join(", ")}`);
  // The accounting and enforcement layers are held to the same rule: one
  // consumer each, no read path.
  const acct = files.filter((f) => /from "@\/lib\/chunk-accounting"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(acct, [ROUTE], `chunk-accounting imported outside the chunk route: ${acct.join(", ")}`);
  const enf = files.filter((f) => /from "@\/lib\/enforce-chunk"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(enf, [ROUTE], `enforce-chunk imported outside the chunk route: ${enf.join(", ")}`);
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
    // Case-insensitive: a mechanically re-issued function comes out of
    // pg_get_functiondef as CREATE OR REPLACE FUNCTION, and a lowercase-only
    // scanner silently skips it - reporting the PREVIOUS definition as live and
    // passing every assertion about a migration it never read.
    const re = /create or replace function public\.(\w+)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const tag = /\bas\s+(\$\w*\$)/i.exec(s.slice(m.index));
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
    // review_units holds verbatim source text too. A clearer that misses it
    // would leave a third copy of the source outside every lifecycle.
    assert.match(body, /review_units\s*=\s*null/,
      `${name} clears segment_text but leaves review_units behind`);
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
  assert.match(purge!.body, /c\.review_units is not null/,
    "a chunk holding only review_units would never become eligible for purge");
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
    // finalize was re-issued again by 0034 (the structural_rev guard); discard
    // by 0026 for packet retention; library close and purge are still last
    // touched by 0025.
    // Every one of the four has been deliberately re-issued since 0025. The
    // `return` bug below hid that: these expectations had been stale since
    // 0028 landed and nothing failed, because the loop exited on the first
    // entry. Corrected to what is actually live.
    // 0045 re-issued the two that actually CLEAR source_text, so they could
    // clear source_image_url in the same statement. finalize and discard were
    // deliberately left alone: since 0026 they stamp evidence_purge_after and
    // clear nothing, so there was nothing in them to change.
    const expectFile =
      name === "finalize_ingestion_run" ? "0034_structural_rev.sql"
      : name === "discard_ingestion_run" ? "0026_packet_evidence_retention.sql"
      : "0045_ingestion_run_source_origin.sql";
    assert.equal(now!.file, expectFile, `${name} last re-issued by ${now!.file}`);
    // `continue`, NOT `return`. This was a `return`, which exited the whole
    // test on the first entry — finalize — so the byte-identical comparison
    // below never ran for ANY function. The guard read as four checks and was
    // none.
    //
    // WHAT THIS TEST STILL PROVES: that no function is re-issued without
    // someone updating this map. That is the useful half, and it now runs for
    // all four. The byte-identical comparison below is inert today because
    // every one of them has since been re-issued on purpose; it revives the
    // moment a function is left at 0025 again.
    if (expectFile !== "0025_ingestion_fact_ledger.sql") continue;
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
