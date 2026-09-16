// 0057 against real PostgreSQL 17: the page-open counter. Published-only
// counting, genuine concurrent increments over two connections, survival across
// Republish and unpublish, a duplicate starting at zero, the revision
// invariant, the grants, the rollback, and mutants of the migration.
//
// Local harness only (README.md). Connects to the Unix socket in $PGHARNESS_DIR.
//
//   scripts/pg-harness/harness.sh replay pre0057 0056
//   node scripts/pg-harness/test-0057.mjs [path/to/0057.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0057_packet_view_count.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0057_packet_view_count_down.sql"), "utf8");
const TEMPLATE = "pre0057";
const OWNER = "00000000-0000-4000-8000-000000000001";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const connect = async (database) => {
  const c = new pg.Client({ host: SOCKET, port: PORT, user: "postgres", database });
  await c.connect();
  return c;
};
const attempt = async (c, sql, args) => {
  try { return { ok: true, res: await c.query(sql, args) }; }
  catch (err) { try { await c.query("rollback"); } catch { /* not in a txn */ } return { ok: false, err }; }
};

const admin = await connect("postgres");
const created = new Set();
async function freshDb(name, { apply = true, sql = MIGRATION } = {}) {
  await admin.query(`drop database if exists "${name}"`);
  await admin.query(`create database "${name}" template "${TEMPLATE}"`);
  created.add(name);
  if (apply) { const c = await connect(name); await c.query(sql); await c.end(); }
  return name;
}

/** A Sendset with enough of a body to be published. */
async function sendset(c, { owner = OWNER } = {}) {
  const { rows: [p] } = await c.query(
    `insert into public.packets (user_id, slug, title)
     values ($1, 'v-' || substr(md5(random()::text), 1, 12), 'T') returning id, slug`, [owner]);
  const { rows: [s] } = await c.query(`insert into public.sections (packet_id, title) values ($1, 'S') returning id`, [p.id]);
  const { rows: [i] } = await c.query(`insert into public.items (section_id, title) values ($1, 'Item') returning id`, [s.id]);
  return { id: p.id, slug: p.slug, sectionId: s.id, itemId: i.id, owner };
}
const token = async (c, ss) => (await c.query("select public.packet_publish_token($1, $2) as t", [ss.owner, ss.id])).rows[0].t;
const snapshot = (ss) => ({ slug: ss.slug, sections: [{ id: ss.sectionId, title: "S", items: [{ id: ss.itemId, title: "Item" }] }], professional: { name: "" } });
const publish = async (c, ss) => c.query(
  "select public.publish_packet($1, $2, $3, $4::smallint, $5, $6) as r",
  [ss.owner, ss.id, JSON.stringify(await token(c, ss)), 1, JSON.stringify(snapshot(ss)), JSON.stringify({})]);
const unpublish = (c, ss) => c.query("select public.unpublish_packet($1, $2) as r", [ss.owner, ss.id]);
const view = (c, slug) => c.query("select public.record_packet_view($1)", [slug]);
const count = async (c, ss) => (await c.query("select view_count from public.packets where id = $1", [ss.id])).rows[0].view_count;
const revs = async (c, ss) => (await c.query("select draft_rev, content_rev from public.packets where id = $1", [ss.id])).rows[0];

// ---------------------------------------------------------------------------
async function main() {
  // --- counting, and who is not counted -----------------------------------
  {
    const db = await freshDb("v57_count");
    const c = await connect(db);
    const ss = await sendset(c);

    ok(await count(c, ss) === 0, "a new Sendset starts at 0 views");
    await view(c, ss.slug);
    ok(await count(c, ss) === 0, "a DRAFT does not count a view");

    await publish(c, ss);
    ok(await count(c, ss) === 0, "publishing does not invent a view");
    await view(c, ss.slug);
    await view(c, ss.slug);
    await view(c, ss.slug);
    ok(await count(c, ss) === 3, "three opens count three — repeats count");

    // A slug nobody has ever used is a silent no-op, not an error the caller
    // could use to learn whether a slug exists.
    const missing = await attempt(c, "select public.record_packet_view($1)", ["no-such-slug-at-all"]);
    ok(missing.ok, "an unknown slug raises nothing");

    // --- Republish and unpublish preserve it -------------------------------
    await c.query("update public.items set title = 'Item edited' where id = $1", [ss.itemId]);
    await publish(c, ss);
    ok(await count(c, ss) === 3, "Republish preserves the count");

    await unpublish(c, ss);
    ok(await count(c, ss) === 3, "unpublish preserves the count");
    await view(c, ss.slug);
    ok(await count(c, ss) === 3, "an unpublished Sendset counts nothing while it is down");
    await publish(c, ss);
    ok(await count(c, ss) === 3, "publishing again preserves the count");
    await view(c, ss.slug);
    ok(await count(c, ss) === 4, "and counting resumes");

    // --- a duplicate is a different Sendset --------------------------------
    // The route copies columns by name; what matters here is that a fresh row
    // takes the column default rather than inheriting a count.
    const { rows: [dup] } = await c.query(
      `insert into public.packets (user_id, slug, title, client_name, personal_note)
       select user_id, 'dup-' || substr(md5(random()::text), 1, 10), title, client_name, personal_note
         from public.packets where id = $1 returning id, view_count`, [ss.id]);
    ok(dup.view_count === 0, "a duplicate starts at 0 views");

    await c.end();
  }

  // --- THE HARD INVARIANT -------------------------------------------------
  {
    const db = await freshDb("v57_revs");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);

    const before = await revs(c, ss);
    const pubBefore = (await c.query("select content::text as c, published_at::text as t from public.packet_publications where packet_id = $1", [ss.id])).rows[0];

    for (let i = 0; i < 5; i++) await view(c, ss.slug);
    const after = await revs(c, ss);
    const pubAfter = (await c.query("select content::text as c, published_at::text as t from public.packet_publications where packet_id = $1", [ss.id])).rows[0];

    ok(before.draft_rev === after.draft_rev, `views do not move draft_rev (${before.draft_rev} -> ${after.draft_rev})`);
    ok(before.content_rev === after.content_rev, `views do not move content_rev (${before.content_rev} -> ${after.content_rev})`);
    ok(pubBefore.c === pubAfter.c && pubBefore.t === pubAfter.t, "views do not touch the frozen publication");

    // The control: a real edit still moves draft_rev, so the three checks above
    // are not passing because the triggers stopped working.
    await c.query("update public.packets set client_title = 'heading' where id = $1", [ss.id]);
    ok((await revs(c, ss)).draft_rev > after.draft_rev, "a real edit still moves draft_rev");
    await c.end();
  }

  // --- CONCURRENCY, over two real connections ------------------------------
  {
    const db = await freshDb("v57_concurrent");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);

    // Twenty interleaved increments from two connections. A read-then-write
    // implementation loses some of these; `set view_count = view_count + 1`
    // does not, because the read happens under the row lock the UPDATE takes.
    const a = await connect(db), b = await connect(db);
    const rounds = [];
    for (let i = 0; i < 10; i++) rounds.push(view(a, ss.slug), view(b, ss.slug));
    await Promise.all(rounds);
    ok(await count(c, ss) === 20, `twenty concurrent opens counted ${await count(c, ss)}, expected 20`);
    await a.end(); await b.end();

    // And two increments inside overlapping transactions serialise rather than
    // both reading the same starting value.
    const t1 = await connect(db), t2 = await connect(db);
    await t1.query("begin");
    await t1.query("select public.record_packet_view($1)", [ss.slug]);
    const pending = t2.query("select public.record_packet_view($1)", [ss.slug]);   // blocks on the row lock
    await new Promise((r) => setTimeout(r, 150));
    await t1.query("commit");
    await pending;
    ok(await count(c, ss) === 22, `two overlapping transactions counted ${await count(c, ss)}, expected 22`);
    await t1.end(); await t2.end();
    await c.end();
  }

  // --- grants --------------------------------------------------------------
  {
    const db = await freshDb("v57_grants");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);

    for (const role of ["anon", "authenticated"]) {
      const r = await attempt(c, `begin; set local role ${role}; select public.record_packet_view('${ss.slug}'); commit;`);
      ok(!r.ok && /permission denied/.test(r.err.message), `${role} cannot execute record_packet_view`);
    }
    // A control: the role exists and can do something, so "permission denied"
    // above is about this function and not about a role that cannot connect.
    const control = await attempt(c, "begin; set local role anon; select 1; commit;");
    ok(control.ok, "CONTROL: the anon role itself works");

    // service_role can, which is the only caller the application has.
    const sr = await attempt(c, `begin; set local role service_role; select public.record_packet_view('${ss.slug}'); commit;`);
    ok(sr.ok, "service_role may execute record_packet_view");
    ok(await count(c, ss) === 1, "and its call counted");
    await c.end();
  }

  // --- the rollback --------------------------------------------------------
  {
    const db = await freshDb("v57_rollback");
    const c = await connect(db);
    await c.query(ROLLBACK);
    const { rows: [r] } = await c.query(`
      select (select count(*) from information_schema.columns
               where table_schema='public' and table_name='packets' and column_name='view_count') as col,
             (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname='record_packet_view') as fn,
             (select count(*) from information_schema.columns
               where table_schema='public' and table_name='packets' and column_name='viewed') as legacy`);
    ok(Number(r.col) === 0 && Number(r.fn) === 0, "the rollback removes the column and the function");
    ok(Number(r.legacy) === 1, "the rollback leaves the legacy boolean in place to revert to");
    await c.end();
  }

  // --- mutants: a proof that cannot fail proves nothing ---------------------
  const mutants = [
    ["the PUBLIC revoke is dropped",
      (s) => s.replace("revoke all on function public.record_packet_view(text) from public;", "")],
    ["the column defaults to 1",
      (s) => s.replace("add column view_count integer not null default 0;", "add column view_count integer not null default 1;")],
    ["the published-only filter is removed",
      (s) => s.replace("   where slug = p_slug\n     and status = 'published';", "   where slug = p_slug;")],
    ["the proof stops checking draft_rev",
      (s) => s.replace("if d1 <> d0 then raise exception '0057 PROOF: a view moved draft_rev % -> %', d0, d1; end if;", "")],
  ];
  for (const [name, mutate] of mutants) {
    const sql = mutate(MIGRATION);
    ok(sql !== MIGRATION, `MUTANT prepared: ${name}`);
    const db = `v57_mut_${mutants.findIndex(([n]) => n === name)}`;
    await admin.query(`drop database if exists "${db}"`);
    await admin.query(`create database "${db}" template "${TEMPLATE}"`);
    created.add(db);
    const c = await connect(db);
    const r = await attempt(c, sql);
    if (name === "the proof stops checking draft_rev") {
      // This one must still APPLY — it removes an assertion, not behaviour. It
      // is here to show the remaining proof is what catches the others.
      ok(r.ok, `MUTANT applies (it only weakens the proof): ${name}`);
    } else {
      ok(!r.ok, `MUTANT aborts the migration: ${name}`);
    }
    await c.end();
  }

  for (const db of created) await admin.query(`drop database if exists "${db}"`);
  await admin.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
