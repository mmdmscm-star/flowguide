// 0053 against real PostgreSQL 17: only publish_packet and unpublish_packet may
// change a Sendset's status.
//
// Local harness only (README.md).
//
//   scripts/pg-harness/harness.sh replay pre0053 0052
//   node scripts/pg-harness/test-0053.mjs [path/to/0053.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0053_packet_status_single_door.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0053_packet_status_single_door_down.sql"), "utf8");
const ROLLBACK_0052 = readFileSync(join(ROOT, "supabase/rollbacks/0052_publication_infrastructure_down.sql"), "utf8");
const TEMPLATE = "pre0053";
const OWNER = "00000000-0000-4000-8000-000000000001";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const connect = async (database) => {
  const c = new pg.Client({ host: SOCKET, port: PORT, user: "postgres", database });
  await c.connect();
  c.pid = (await c.query("select pg_backend_pid() as p")).rows[0].p;
  return c;
};
const admin = await connect("postgres");
const created = new Set();
async function freshDb(name, { sql = MIGRATION, apply = true } = {}) {
  await admin.query(`drop database if exists "${name}"`);
  await admin.query(`create database "${name}" template "${TEMPLATE}"`);
  created.add(name);
  if (apply) { const c = await connect(name); await c.query(sql); await c.end(); }
  return name;
}
const attempt = async (c, sql, params) => {
  try { return { ok: true, res: await c.query(sql, params) }; }
  catch (e) { try { await c.query("rollback"); } catch { /* not in a transaction */ } return { ok: false, err: e }; }
};
const refused = (r) => !r.ok && r.err.code === "PT403" && r.err.detail === "status_single_door";

async function sendset(c, owner = OWNER) {
  const { rows: [p] } = await c.query(
    `insert into public.packets (user_id, slug, title) values ($1, 'h-' || substr(md5(random()::text), 1, 12), 'T') returning id, slug`, [owner]);
  const { rows: [s] } = await c.query(`insert into public.sections (packet_id, title) values ($1, 'S') returning id`, [p.id]);
  await c.query(`insert into public.items (section_id, title) values ($1, 'Item')`, [s.id]);
  return { id: p.id, slug: p.slug, owner };
}
const token = async (c, ss) => (await c.query("select public.packet_publish_token($1, $2) as t", [ss.owner, ss.id])).rows[0].t;
const publishSql = "select public.publish_packet($1, $2, $3, 1::smallint, $4, '{}'::jsonb)";
const publish = async (c, ss) => attempt(c, publishSql, [ss.owner, ss.id, JSON.stringify(await token(c, ss)), JSON.stringify({ slug: ss.slug })]);
const unpublish = (c, ss) => attempt(c, "select public.unpublish_packet($1, $2)", [ss.owner, ss.id]);
const statusOf = async (c, ss) => (await c.query("select status from public.packets where id = $1", [ss.id])).rows[0]?.status;

async function withDb(name, fn, opts) {
  const db = await freshDb(name, opts);
  const conns = await Promise.all([connect(db), connect(db)]);
  try { await fn(...conns); } finally { await Promise.all(conns.map((c) => c.end())); }
}

// ===========================================================================
console.log("\n== 1. Direct status writes are refused");
await withDb("t53_direct", async (c) => {
  const ss = await sendset(c);
  ok(refused(await attempt(c, "update public.packets set status = 'published' where id = $1", [ss.id])) && (await statusOf(c, ss)) === "draft",
    "direct UPDATE draft → published is refused");
  ok(refused(await attempt(c, "insert into public.packets (user_id, slug, title, status) values ($1, 'born-pub', 'x', 'published')", [OWNER])),
    "INSERT as published is refused");
  ok((await attempt(c, "insert into public.packets (user_id, slug, title, status) values ($1, 'born-draft', 'x', 'draft')", [OWNER])).ok,
    "INSERT with an explicit draft status is allowed");
  ok((await attempt(c, "insert into public.packets (user_id, slug, title) values ($1, 'born-default', 'x')", [OWNER])).ok,
    "INSERT relying on the default is allowed");

  ok((await publish(c, ss)).ok && (await statusOf(c, ss)) === "published", "publish_packet publishes");
  ok(refused(await attempt(c, "update public.packets set status = 'draft' where id = $1", [ss.id])) && (await statusOf(c, ss)) === "published",
    "direct UPDATE published → draft is refused");
  ok((await attempt(c, "update public.packets set personal_note = 'still editable', status = status where id = $1", [ss.id])).ok,
    "an ordinary update that leaves status unchanged is allowed");
  ok((await attempt(c, "update public.packets set title = 'renamed' where id = $1", [ss.id])).ok, "an update not naming status is allowed");
  ok((await publish(c, ss)).ok, "republishing through publish_packet still works");
  ok((await unpublish(c, ss)).ok && (await statusOf(c, ss)) === "draft", "unpublish_packet unpublishes");

  const other = await sendset(c);
  ok(refused(await attempt(c, `begin; select set_config('app.publication_authorized_packet', '${other.id}', true);
      update public.packets set status = 'published' where id = '${ss.id}'; commit;`)),
    "authorisation naming another Sendset does not open this one");
  ok(refused(await attempt(c, `begin; select set_config('app.publication_authorized_packet', 'yes', true);
      update public.packets set status = 'published' where id = '${ss.id}'; commit;`)),
    "any non-id authorisation value is refused");
  const after = await attempt(c, `begin;
      select public.publish_packet('${ss.owner}', '${ss.id}', public.packet_publish_token('${ss.owner}', '${ss.id}'), 1::smallint, '{"slug":"${ss.slug}"}'::jsonb, '{}'::jsonb);
      update public.packets set status = 'draft' where id = '${ss.id}'; commit;`);
  ok(refused(after) && (await statusOf(c, ss)) === "draft",
    "the authorisation does not outlive publish_packet: a direct update later in the same transaction is refused (and the whole transaction rolls back)");

  const asService = await attempt(c, `begin; set local role service_role; update public.packets set status = 'published' where id = '${ss.id}'; commit;`);
  ok(refused(asService), "service_role's direct update is refused too");
});

// ===========================================================================
console.log("\n== 2. Every other path that touches Sendsets still works");
await withDb("t53_paths", async (c) => {
  const organize = await attempt(c, `select public.create_organize_run($1, 'general', 'h-organize-' || substr(md5(random()::text), 1, 8), 'abcd', 'h', 4, 'rk-' || gen_random_uuid(), 'seg-v4',
      '[{"ordinal":0,"source_start":0,"source_end":4,"segment_text":"abcd","segment_hash":"h"}]'::jsonb) as r`, [OWNER]);
  ok(organize.ok, "create_organize_run still creates its draft Sendset" + (organize.ok ? "" : ` — ${organize.err.message}`));

  const ss = await sendset(c);
  ok((await attempt(c, "select public.convert_packet_to_blocks($1)", [ss.id])).ok, "converting to blocks (a composition_mode change) still works");
  ok((await publish(c, ss)).ok, "a block-composed Sendset still publishes");

  const run = await attempt(c, `insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status)
      values ($1, (select id from public.packets where slug like 'h-organize-%' limit 1), 'append', 'h', 'seg-v4', 'finalized') returning id`, [OWNER]);
  ok(run.ok, "import runs still attach");

  ok((await attempt(c, "delete from public.packets where id = $1", [ss.id])).ok, "deleting a published Sendset is allowed (a delete is not a status change)");
  const { rows: [u] } = await c.query("insert into public.users (email) values ('gone-' || gen_random_uuid() || '@example.com') returning id");
  const gone = await sendset(c, u.id);
  await c.query("insert into public.professional_profiles (user_id, name, phone) values ($1, 'G', '555-0100')", [u.id]);
  await publish(c, gone);
  ok((await attempt(c, "delete from public.users where id = $1", [u.id])).ok, "deleting an account cascades through its published Sendsets");

  const blocked = await sendset(c);
  await c.query(`insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status) values ($1, $2, 'append', 'h', 'seg-v4', 'active')`, [OWNER, blocked.id]);
  const pb = await publish(c, blocked);
  ok(!pb.ok && pb.err.detail === "import_blocks", "a blocking import still refuses publish_packet, before the door is reached");
});

// ===========================================================================
console.log("\n== 3. Two connections: the authorisation is private to its transaction");
await withDb("t53_isolation", async (a, b) => {
  const ss = await sendset(a);
  await a.query("begin");
  await a.query("select set_config('app.publication_authorized_packet', $1, true)", [ss.id]);
  const r = await attempt(b, "update public.packets set status = 'published' where id = $1", [ss.id]);
  await a.query("rollback");
  ok(refused(r), "another session's authorisation for this Sendset does not authorise this session");
});

// ===========================================================================
console.log("\n== 4. Grants, rerun, rollback");
await withDb("t53_rollback", async (c) => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    const x = await attempt(c, `begin; set local role ${role}; select public.enforce_packet_status_single_door(); commit;`);
    ok(!x.ok && /permission denied/.test(x.err.message), `${role} cannot execute the trigger function`);
  }
  const twice = await attempt(c, MIGRATION);
  ok(!twice.ok && /MIGRATION 0053 ABORTED/.test(twice.err.message), "0053 refuses to run twice");
  const guarded = await attempt(c, ROLLBACK_0052);
  ok(!guarded.ok && /ROLLBACK 0052 REFUSED/.test(guarded.err.message), "0052's rollback refuses while 0053's door exists");

  const ss = await sendset(c);
  await publish(c, ss);
  const before = (await c.query("select status, published_at::text, updated_at::text from public.packets where id = $1", [ss.id])).rows[0];
  const down = await attempt(c, ROLLBACK);
  const afterRows = (await c.query("select status, published_at::text, updated_at::text from public.packets where id = $1", [ss.id])).rows[0];
  ok(down.ok && JSON.stringify(before) === JSON.stringify(afterRows), "rollback drops the door and touches no row");
  ok((await attempt(c, "update public.packets set status = 'draft' where id = $1", [ss.id])).ok, "after rollback a direct write is no longer refused");
  ok((await attempt(c, MIGRATION)).ok, "0053 re-applies after rollback");
});

await withDb("t53_precondition", async (c) => {
  await c.query(`create function public.rogue_publisher(p uuid) returns void language sql as $f$ update public.packets set status = 'published' where id = p $f$`);
  const r = await attempt(c, MIGRATION);
  ok(!r.ok && /rogue_publisher/.test(r.err.message), "0053 refuses to install while another function changes a status, and names it");
}, { apply: false });

// ===========================================================================
console.log("\n== 5. Mutants: caught by the migration itself or by a targeted check");
const directUpdateAllowed = async (db, sql) => {
  const c = await connect(db);
  try { const ss = await sendset(c); await publish(c, ss); return (await attempt(c, sql.replaceAll("$ID", ss.id))).ok; } finally { await c.end(); }
};
const MUTANTS = [
  ["no INSERT coverage", (s) => s.replace("  before insert or update of status on public.packets", "  before update of status on public.packets"),
    async (db) => { const c = await connect(db); try { return (await attempt(c, "insert into public.packets (user_id, slug, title, status) values ($1, 'm-pub', 'x', 'published')", [OWNER])).ok; } finally { await c.end(); } }],
  ["authorisation not bound to the id", (s) => s.split("current_setting('app.publication_authorized_packet', true) is distinct from new.id::text").join("coalesce(current_setting('app.publication_authorized_packet', true), '') = ''"),
    (db) => directUpdateAllowed(db, "begin; select set_config('app.publication_authorized_packet', 'x', true); update public.packets set status = 'draft' where id = '$ID'; commit;")],
  ["only publishing is guarded", (s) => s.replace("  elsif new.status is distinct from old.status", "  elsif new.status = 'published' and new.status is distinct from old.status"),
    (db) => directUpdateAllowed(db, "update public.packets set status = 'draft' where id = '$ID'")],
  ["no trigger", (s) => s.replace(/create trigger trg_packet_status_single_door[\s\S]*?execute function public\.enforce_packet_status_single_door\(\);\n/, ""), null],
  ["trigger function executable by service_role", (s) => s.replace("revoke all on function public.enforce_packet_status_single_door() from public, anon, authenticated, service_role;",
    "revoke all on function public.enforce_packet_status_single_door() from public, anon, authenticated;\ngrant execute on function public.enforce_packet_status_single_door() to service_role;"), null],
  ["trigger function SECURITY DEFINER", (s) => s.split("create function public.enforce_packet_status_single_door() returns trigger\nlanguage plpgsql security invoker").join("create function public.enforce_packet_status_single_door() returns trigger\nlanguage plpgsql security definer"), null],
  ["precondition ignores other writers", (s) => s.replace("  if v_others is not null then", "  if false then"),
    async (db) => {
      const c = await connect(db);
      try { await c.query("drop trigger trg_packet_status_single_door on public.packets; drop function public.enforce_packet_status_single_door()");
            await c.query(`create function public.rogue_publisher(p uuid) returns void language sql as $f$ update public.packets set status = 'published' where id = p $f$`);
            return (await attempt(c, s_mutated)).ok; } finally { await c.end(); }
    }],
];
let s_mutated = "";
for (const [name, mutate, detect] of MUTANTS) {
  const mutated = mutate(MIGRATION);
  s_mutated = mutated;
  if (mutated === MIGRATION) { ok(false, `mutant did not apply: ${name}`); continue; }
  const db = await freshDb("t53_mutant", { apply: false });
  const c = await connect(db);
  const r = await attempt(c, mutated);
  await c.end();
  if (!r.ok) { ok(true, `mutant caught by the migration: ${name} — ${r.err.message.slice(0, 90)}`); continue; }
  const seen = detect ? await detect(db) : false;
  ok(seen, `mutant caught by the harness: ${name}${seen ? "" : " (NOT CAUGHT)"}`);
}

for (const name of created) await admin.query(`drop database if exists "${name}"`);
await admin.end();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
