// 0051 against real PostgreSQL 17: behaviour, genuine two-connection
// interleavings, rollback, and mutants of the migration itself.
//
// Local harness only (see README.md). Every connection goes to the Unix socket
// in $PGHARNESS_DIR; there is no way to point this at production.
//
//   scripts/pg-harness/harness.sh replay pre0051 0050
//   node scripts/pg-harness/test-0051.mjs [path/to/0051.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION_PATH = process.argv[2] ?? join(ROOT, "supabase/migrations/0051_finalize_review_pending.sql");
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0051_finalize_review_pending_down.sql"), "utf8");
const TEMPLATE = "pre0051";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };

const connect = async (database) => {
  const c = new pg.Client({ host: SOCKET, port: PORT, user: "postgres", database });
  await c.connect();
  return c;
};
const admin = await connect("postgres");
async function freshDb(name, { apply = false } = {}) {
  await admin.query(`drop database if exists "${name}"`);
  await admin.query(`create database "${name}" template "${TEMPLATE}"`);
  if (apply) { const c = await connect(name); await c.query(MIGRATION); await c.end(); }
  return name;
}
const tryQuery = async (c, sql, params) => {
  try { return { ok: true, res: await c.query(sql, params) }; }
  catch (e) {
    // A failed script can leave the session inside its own aborted BEGIN.
    try { await c.query("rollback"); } catch { /* not in a transaction */ }
    return { ok: false, err: e };
  }
};
const OWNER = "00000000-0000-4000-8000-000000000001";

// A draft packet with one section, and an active append run whose single chunk
// covers the whole source and has completed — everything finalize requires.
async function packetWithReadyRun(c, label) {
  const { rows: [p] } = await c.query(
    `insert into public.packets (user_id, slug, title) values ($1, $2, $3) returning id, structural_rev`,
    [OWNER, `h-${label}-${Math.random().toString(36).slice(2, 10)}`, label]);
  await c.query(`insert into public.sections (packet_id, title) values ($1, 'Existing')`, [p.id]);
  const { rows: [b] } = await c.query(
    `select structural_rev,
            (select count(*) from public.sections where packet_id = $1)::int as secs,
            (select count(*) from public.items i join public.sections s on s.id = i.section_id where s.packet_id = $1)::int as items,
            content_rev
       from public.packets where id = $1`, [p.id]);
  const source = "0123456789";
  const { rows: [run] } = await c.query(
    `insert into public.ingestion_runs (user_id, packet_id, entry_point, source_text, source_hash, source_len,
                                        segmenter_version, status, total_chunks, baseline_section_count,
                                        baseline_item_count, baseline_content_rev, baseline_structural_rev)
     values ($1, $2, 'append', $3, 'h', $4, 'seg-v4', 'active', 1, $5, $6, $7, $8) returning id`,
    [OWNER, p.id, source, source.length, b.secs, b.items, b.content_rev, b.structural_rev]);
  await c.query(
    `insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_hash, status, result)
     values ($1, 0, 0, $2, 'h', 'completed', $3)`,
    [run.id, source.length, JSON.stringify({ sections: [{ title: "Imported", items: [{ title: "New item" }] }] })]);
  return { packetId: p.id, runId: run.id };
}
const runState = async (c, runId) => (await c.query(`select status, review from public.ingestion_runs where id = $1`, [runId])).rows[0];
const finalize = (c, runId) => c.query(`select public.finalize_ingestion_run($1, $2) as r`, [runId, OWNER]);
// The route's verdict write, exactly as src/app/api/ingest/[runId]/finalize/route.ts issues it.
const recordVerdict = (c, runId, verdict) => c.query(
  `update public.ingestion_runs set ${verdict.status ? "status = $3, " : ""}review = $2
    where id = $1 and user_id = '${OWNER}' and status = 'finalized' and review -> 'ok' is null returning id`,
  verdict.status ? [runId, JSON.stringify(verdict.review), verdict.status] : [runId, JSON.stringify(verdict.review)]);

// ---------------------------------------------------------------------------
console.log("\n== 1. Behaviour after 0051 (one connection)");
{
  const db = await freshDb("t51_behaviour", { apply: true });
  const c = await connect(db);

  const { packetId, runId } = await packetWithReadyRun(c, "clean");
  const { rows: [{ r: fin }] } = await finalize(c, runId);
  let s = await runState(c, runId);
  ok(fin.reused === false && fin.items === 1, "a real finalize applies the run's content");
  ok(s.status === "finalized" && s.review?.pending === true && Object.keys(s.review).length === 1,
    "finalize commits review = {pending: true} with `finalized`");

  let pub = await tryQuery(c, `update public.packets set status = 'published' where id = $1`, [packetId]);
  ok(!pub.ok && /still being checked/.test(pub.err.message), "publishing a Sendset whose import is pending is refused");

  const second = await tryQuery(c,
    `insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status)
     values ($1, $2, 'append', 'h', 'seg-v4', 'active')`, [OWNER, packetId]);
  ok(!second.ok && second.err.code === "23505", "a second import cannot start while the first is pending");

  const { rows: [{ r: replay }] } = await finalize(c, runId);
  ok(replay.reused === true && (await runState(c, runId)).review?.pending === true,
    "a replayed finalize returns reused and leaves the marker for the route to replace");

  const written = await recordVerdict(c, runId, { review: { ok: true, summary: "", exit: "", failures: [] } });
  s = await runState(c, runId);
  ok(written.rowCount === 1 && s.review.ok === true && !("pending" in s.review), "the route's clean verdict replaces the marker");

  const again = await recordVerdict(c, runId, { status: "needs_review", review: { ok: false, failures: [{ code: "late" }] } });
  ok(again.rowCount === 0 && (await runState(c, runId)).status === "finalized", "a later verdict cannot overwrite a decided review");

  await finalize(c, runId);
  ok((await runState(c, runId)).review.ok === true, "a replay after the decision does not re-mark the run");

  pub = await tryQuery(c, `update public.packets set status = 'published' where id = $1`, [packetId]);
  ok(pub.ok, "once the verdict is recorded, publishing proceeds");

  const nr = await packetWithReadyRun(c, "needs-review");
  await finalize(c, nr.runId);
  await recordVerdict(c, nr.runId, { status: "needs_review", review: { ok: false, summary: "1 photo is missing", failures: [{ code: "media_missing" }] } });
  pub = await tryQuery(c, `update public.packets set status = 'published' where id = $1`, [nr.packetId]);
  ok((await runState(c, nr.runId)).status === "needs_review" && !pub.ok, "a needs_review verdict still blocks publishing");

  const legacy = await packetWithReadyRun(c, "legacy");
  await c.query(`update public.ingestion_runs set status = 'finalized', review = '{}' where id = $1`, [legacy.runId]);
  pub = await tryQuery(c, `update public.packets set status = 'published' where id = $1`, [legacy.packetId]);
  ok(pub.ok, "a run finalized before 0051 (review {}) does not block");

  const rerun = await tryQuery(c, MIGRATION);
  ok(!rerun.ok && /MIGRATION 0051 ABORTED/.test(rerun.err.message), "0051 refuses to run twice");
  await c.end();
}

// ---------------------------------------------------------------------------
console.log("\n== 2. Before 0051 the gap is real (one connection)");
{
  const db = await freshDb("t51_before");
  const c = await connect(db);
  const { packetId, runId } = await packetWithReadyRun(c, "gap");
  await finalize(c, runId);
  const s = await runState(c, runId);
  const pub = await tryQuery(c, `update public.packets set status = 'published' where id = $1`, [packetId]);
  ok(s.status === "finalized" && JSON.stringify(s.review) === "{}" && pub.ok,
    "pre-0051: straight after finalize, before any verdict, publishing succeeds");
  await c.end();
}

// ---------------------------------------------------------------------------
console.log("\n== 3. Two connections: finalize in flight vs publish");
async function interleaveFinalizeAndPublish(db) {
  const setup = await connect(db);
  const { packetId, runId } = await packetWithReadyRun(setup, "race");
  await setup.end();
  const a = await connect(db), b = await connect(db), watch = await connect(db);
  const { rows: [{ pid: bPid }] } = await b.query("select pg_backend_pid() as pid");

  await a.query("begin");
  await finalize(a, runId);                        // holds the run and packet row locks, uncommitted

  const bPublish = tryQuery(b, `update public.packets set status = 'published' where id = $1`, [packetId]);
  let waiting = null;
  for (let i = 0; i < 50 && !waiting; i++) {
    const { rows: [w] } = await watch.query(
      `select wait_event_type, wait_event from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [bPid]);
    if (w) waiting = w; else await new Promise((r) => setTimeout(r, 20));
  }
  await a.query("commit");
  const result = await bPublish;
  const state = await runState(watch, runId);
  const { rows: [pk] } = await watch.query(`select status from public.packets where id = $1`, [packetId]);
  await Promise.all([a.end(), b.end(), watch.end()]);
  return { waiting, result, state, packetStatus: pk.status };
}
{
  const before = await interleaveFinalizeAndPublish(await freshDb("t51_race_before"));
  ok(before.waiting?.wait_event_type === "Lock", `pre-0051: publish waited on finalize's lock (${before.waiting?.wait_event})`);
  ok(before.result.ok && before.packetStatus === "published",
    "pre-0051: the moment finalize committed, the waiting publish went through with no verdict recorded");

  const after = await interleaveFinalizeAndPublish(await freshDb("t51_race_after", { apply: true }));
  ok(after.waiting?.wait_event_type === "Lock", `0051: publish waited on finalize's lock (${after.waiting?.wait_event})`);
  ok(!after.result.ok && /still being checked/.test(after.result.err.message) && after.packetStatus === "draft"
     && after.state.review?.pending === true,
    "0051: when finalize committed, the waiting publish saw the pending marker and was refused");
}

// ---------------------------------------------------------------------------
console.log("\n== 4. Two connections: verdict write in flight vs publish");
{
  const db = await freshDb("t51_verdict", { apply: true });
  const setup = await connect(db);
  const { packetId, runId } = await packetWithReadyRun(setup, "verdict");
  await finalize(setup, runId);
  await setup.end();
  const a = await connect(db), b = await connect(db);
  await a.query("begin");
  await recordVerdict(a, runId, { review: { ok: true, summary: "", exit: "", failures: [] } }); // uncommitted
  const during = await tryQuery(b, `update public.packets set status = 'published' where id = $1`, [packetId]);
  ok(!during.ok && /still being checked/.test(during.err.message),
    "while the clean verdict is uncommitted, publish still sees pending and is refused");
  await a.query("commit");
  const after = await tryQuery(b, `update public.packets set status = 'published' where id = $1`, [packetId]);
  ok(after.ok, "after the verdict commits, the same publish succeeds");
  await Promise.all([a.end(), b.end()]);
}

// ---------------------------------------------------------------------------
console.log("\n== 5. Rollback");
{
  const db = await freshDb("t51_rollback", { apply: true });
  const c = await connect(db);
  const { runId } = await packetWithReadyRun(c, "rb");
  await finalize(c, runId);
  const refused = await tryQuery(c, ROLLBACK);
  ok(!refused.ok && /ROLLBACK 0051 REFUSED/.test(refused.err.message), "rollback refuses while a run is pending");
  await recordVerdict(c, runId, { review: { ok: true } });
  const down = await tryQuery(c, ROLLBACK);
  ok(down.ok, "rollback succeeds once no run is pending" + (down.ok ? "" : ` — ${down.err.message}`));
  const reapply = await tryQuery(c, MIGRATION);
  ok(reapply.ok, "0051 re-applies after rollback" + (reapply.ok ? "" : ` — ${reapply.err.message}`));
  await c.end();
}

// ---------------------------------------------------------------------------
console.log("\n== 6. Mutants of the migration must abort and leave nothing");
const FRAG = `review = '{"pending": true}'::jsonb, `;
const MUTANTS = [
  ["finalize never sets the marker", (s) => s.replace(`set status = 'finalized', ${FRAG}finalized_at`, "set status = 'finalized', finalized_at")],
  ["finalize also sets the marker on a replay", (s) => s.replace(
    "if v_run.status = 'finalized' then return jsonb_build_object('status','finalized','reused',true); end if;",
    "if v_run.status = 'finalized' then update public.ingestion_runs set review = '{\"pending\": true}'::jsonb where id = p_run_id; return jsonb_build_object('status','finalized','reused',true); end if;")],
  ["helper ignores pending", (s) => s.replace(
    "            or (r.status = 'finalized' and r.review -> 'pending' = 'true'::jsonb))\n  )", "            )\n  )")],
  ["guard keeps its own status list", (s) => s.replace("    if public.packet_has_blocking_run(new.id) then",
    "    if exists (select 1 from public.ingestion_runs where packet_id = new.id and status in ('active','finalizing','needs_review')) then")],
  ["index ignores pending", (s) => s.replace(
    "    and (status in ('active', 'finalizing', 'needs_review')\n         or (status = 'finalized' and review -> 'pending' = 'true'::jsonb));",
    "    and status in ('active', 'finalizing', 'needs_review');")],
  ["no CHECK on the marker", (s) => s.replace(/alter table public\.ingestion_runs\n  add constraint ingestion_runs_review_pending_shape\n  check \([^;]*;\n/, "")],
  ["CHECK allows pending on any status", (s) => s.replace("(review -> 'pending' = 'true'::jsonb and status = 'finalized')", "(review -> 'pending' = 'true'::jsonb)")],
  ["helper executable by service_role", (s) => s.replace(
    "revoke all on function public.packet_has_blocking_run(uuid) from public, anon, authenticated, service_role;",
    "revoke all on function public.packet_has_blocking_run(uuid) from public, anon, authenticated;\ngrant execute on function public.packet_has_blocking_run(uuid) to service_role;")],
  ["helper SECURITY DEFINER", (s) => s.split("language sql stable security invoker").join("language sql stable security definer")],
  ["finalize grant widened", (s) => s.replace("\n-- ---------------------------------------------------------------------------\n-- 4. THE PUBLISH GUARD",
    "\ngrant execute on function public.finalize_ingestion_run(uuid, uuid) to authenticated;\n-- ---------------------------------------------------------------------------\n-- 4. THE PUBLISH GUARD")],
];
for (const [name, mutate] of MUTANTS) {
  const mutated = mutate(MIGRATION);
  if (mutated === MIGRATION) { ok(false, `mutant did not apply: ${name}`); continue; }
  const db = await freshDb("t51_mutant");
  const c = await connect(db);
  const r = await tryQuery(c, mutated);
  const { rows: [left] } = await c.query(
    `select to_regprocedure('public.packet_has_blocking_run(uuid)') is null as helper_absent,
            (select md5(prosrc) from pg_proc where oid = 'public.finalize_ingestion_run(uuid,uuid)'::regprocedure) = 'ebd3c4e438d0c04c760b11611cbd73e6' as finalize_untouched`);
  ok(!r.ok && left.helper_absent && left.finalize_untouched,
    `mutant aborts and leaves nothing: ${name}${r.ok ? " (APPLIED!)" : " — " + r.err.message.slice(0, 100)}`);
  await c.end();
}

for (const name of ["t51_behaviour", "t51_before", "t51_race_before", "t51_race_after", "t51_verdict", "t51_rollback", "t51_mutant"]) {
  await admin.query(`drop database if exists "${name}"`);
}
await admin.end();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
