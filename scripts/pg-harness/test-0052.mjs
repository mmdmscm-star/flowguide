// 0052 against real PostgreSQL 17: the publish token, atomic publish/unpublish,
// the lock-only triggers, genuine two-connection interleavings, the rollback,
// and mutants of the migration.
//
// Local harness only (README.md). Connects to the Unix socket in $PGHARNESS_DIR.
//
//   scripts/pg-harness/harness.sh replay pre0052 0051
//   node scripts/pg-harness/test-0052.mjs [path/to/0052.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0052_publication_infrastructure.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0052_publication_infrastructure_down.sql"), "utf8");
const TEMPLATE = "pre0052";
const OWNER = "00000000-0000-4000-8000-000000000001";
const PHOTO = "https://photos.example.com/a.jpg";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const connect = async (database) => {
  const c = new pg.Client({ host: SOCKET, port: PORT, user: "postgres", database });
  await c.connect();
  c.pid = (await c.query("select pg_backend_pid() as p")).rows[0].p;   // read up front: a blocked connection cannot answer
  return c;
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
const attempt = async (c, sql, params) => {
  try { return { ok: true, res: await c.query(sql, params) }; }
  catch (e) { try { await c.query("rollback"); } catch { /* not in a transaction */ } return { ok: false, err: e }; }
};
const pending = (promise) => promise.then((res) => ({ ok: true, res }), (err) => ({ ok: false, err }));
async function waitsOnLock(watch, pid, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const { rows } = await watch.query("select wait_event from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid]);
    if (rows.length) return rows[0].wait_event;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function sendset(c, { owner = OWNER, identity = "default" } = {}) {
  const { rows: [p] } = await c.query(
    `insert into public.packets (user_id, slug, title, identity_mode, custom_identity)
     values ($1, 'h-' || substr(md5(random()::text), 1, 12), 'T', $2::text,
             case when $2::text = 'custom' then '{"name":"C","phone":"555-0102"}'::jsonb end) returning id, slug`, [owner, identity]);
  const { rows: [s] } = await c.query(`insert into public.sections (packet_id, title) values ($1, 'S') returning id`, [p.id]);
  const { rows: [i] } = await c.query(`insert into public.items (section_id, title) values ($1, 'Item') returning id`, [s.id]);
  await c.query(`insert into public.item_photos (item_id, url) values ($1, $2)`, [i.id, PHOTO]);
  return { id: p.id, slug: p.slug, sectionId: s.id, itemId: i.id, owner };
}
const token = async (c, ss, owner = ss.owner) => (await c.query("select public.packet_publish_token($1, $2) as t", [owner, ss.id])).rows[0].t;
const snapshot = (ss, extra = {}) => ({ slug: ss.slug, sections: [{ id: ss.sectionId, title: "S", items: [{ id: ss.itemId, title: "Item", photos: [PHOTO] }] }], professional: { name: "" }, ...extra });
const publishSql = "select public.publish_packet($1, $2, $3, $4::smallint, $5, $6) as r";
const publishArgs = (ss, tok, { content = snapshot(ss), format = 1, identity = {}, owner = ss.owner } = {}) =>
  [owner, ss.id, JSON.stringify(tok), format, JSON.stringify(content), JSON.stringify(identity)];
const publish = (c, ss, tok, opts) => c.query(publishSql, publishArgs(ss, tok, opts));
const unpublish = (c, ss) => c.query("select public.unpublish_packet($1, $2) as r", [ss.owner, ss.id]);
const live = async (c, ss) => (await c.query(
  `select p.status, p.published_at::text as p_published_at, p.professional_snapshot::text as identity,
          pub.content::text as content, pub.published_at::text as pub_published_at,
          pub.source_draft_rev, pub.identity_dependency, pub.source_identity_rev, pub.format_version
     from public.packets p left join public.packet_publications pub on pub.packet_id = p.id where p.id = $1`, [ss.id])).rows[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function withDb(name, fn, opts) {
  const db = await freshDb(name, opts);
  const conns = await Promise.all([connect(db), connect(db), connect(db)]);
  try { await fn(...conns); } finally { await Promise.all(conns.map((c) => c.end())); }
}

// ===========================================================================
console.log("\n== 1. The token");
await withDb("t52_token", async (c) => {
  const ss = await sendset(c);
  const t0 = await token(c, ss);
  ok(same(t0, await token(c, ss)), "deterministic: two reads of an unchanged Sendset are equal");
  ok((await token(c, ss, "00000000-0000-4000-8000-00000000dead")) === null, "null for another owner");
  ok(t0.identity_dependency === "account_profile" && t0.profile_exists === true && t0.identity_rev !== null && t0.blocking_run === false && t0.title_present === true,
    "carries status, identity dependency and profile, blocking run, title");

  const moves = [
    ["raw_input", `update public.packets set raw_input = 'source text' where id = '${ss.id}'`],
    ["item origin (FK set-null style)", `update public.items set origin_emit_index = 7 where id = '${ss.itemId}'`],
    ["a photo", `insert into public.item_photos (item_id, url) values ('${ss.itemId}', 'https://photos.example.com/b.jpg')`],
    ["a Keep", `insert into public.item_media_decisions (item_id, url) values ('${ss.itemId}', '${PHOTO}')`],
    ["undoing a Keep", `delete from public.item_media_decisions where item_id = '${ss.itemId}'`],
    ["the title emptied", `update public.packets set title = '' where id = '${ss.id}'`],
    ["the title restored", `update public.packets set title = 'T' where id = '${ss.id}'`],
    ["the profile", `update public.professional_profiles set phone = '555-0199' where user_id = '${OWNER}'`],
    ["client-visible content", `update public.items set description = 'new words' where id = '${ss.itemId}'`],
  ];
  let prev = await token(c, ss);
  for (const [what, sql] of moves) {
    await c.query(sql);
    const next = await token(c, ss);
    ok(!same(prev, next), `changes when ${what} changes`);
    prev = next;
  }

  const { rows: [run] } = await c.query(
    `insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, source_len, segmenter_version, status, review)
     values ($1, $2, 'append', 'h', 10, 'seg-v4', 'finalized', '{"ok":true}') returning id`, [OWNER, ss.id]);
  await c.query(`update public.items set origin_run_id = $1, origin_chunk_ordinal = 0 where id = $2`, [run.id, ss.itemId]);
  await c.query(`insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_hash, status) values ($1, 0, 0, 10, 'h', 'completed')`, [run.id]);
  prev = await token(c, ss);
  await c.query(`update public.ingestion_runs set source_offset_base = 3 where id = $1`, [run.id]);
  let next = await token(c, ss); ok(!same(prev, next), "changes when a source run's provenance changes"); prev = next;
  await c.query(`update public.ingestion_chunks set source_end = 9 where run_id = $1`, [run.id]);
  next = await token(c, ss); ok(!same(prev, next), "changes when a source chunk's range changes"); prev = next;
  await c.query(`update public.ingestion_runs set status = 'needs_review', review = '{"ok":false}' where id = $1`, [run.id]);
  next = await token(c, ss); ok(!same(prev, next) && next.blocking_run === true, "changes when an import starts blocking"); prev = next;
  await c.query(`update public.ingestion_runs set status = 'finalized', review = '{"ok":true}' where id = $1`, [run.id]);
  prev = await token(c, ss);

  await c.query(`update public.items set notes = 'private' where id = $1`, [ss.itemId]);
  await c.query(`update public.packets set viewed = true where id = $1`, [ss.id]);
  ok(same(prev, await token(c, ss)), "does NOT change for a private note or a view");

  const custom = await sendset(c, { identity: "custom" });
  const tc = await token(c, custom);
  await c.query(`update public.professional_profiles set name = 'Renamed' where user_id = $1`, [OWNER]);
  ok(tc.identity_dependency === "sendset" && tc.profile_exists === null && same(tc, await token(c, custom)),
    "a custom-identity Sendset's token ignores the account profile");
});

// ===========================================================================
console.log("\n== 2. Publish, republish, unpublish");
await withDb("t52_publish", async (c) => {
  const ss = await sendset(c);
  const identity = { name: "Harness Owner", phone: "555-0100" };
  const r1 = (await publish(c, ss, await token(c, ss), { identity })).rows[0].r;
  let s = await live(c, ss);
  ok(s.status === "published" && s.content && same(JSON.parse(s.identity), identity) && s.format_version === 1,
    "first publish writes the status, the frozen copy and the identity snapshot together");
  ok(s.pub_published_at === s.p_published_at && s.identity_dependency === "account_profile" && s.source_identity_rev !== null
     && Number(s.source_draft_rev) === Number(r1.sourceDraftRev), "source revisions and published_at come from the same transaction");
  ok((await c.query("select current_setting('app.publication_authorized_packet', true) as v")).rows[0].v !== ss.id,
    "the authorization flag does not outlive the call");

  await c.query(`update public.items set description = 'republished words' where id = $1`, [ss.itemId]);
  const content2 = snapshot(ss, { personalNote: "second" });
  await new Promise((r) => setTimeout(r, 10));
  await publish(c, ss, await token(c, ss), { content: content2 });
  const s2 = await live(c, ss);
  ok(isDeepStrictEqual(JSON.parse(s2.content), content2) && JSON.parse(s2.content).personalNote === "second"
     && s2.pub_published_at > s.pub_published_at && s2.p_published_at === s2.pub_published_at
     && Number(s2.source_draft_rev) > Number(s.source_draft_rev),
    "republish replaces the copy, and published_at moves on every successful publish");

  const custom = await sendset(c, { identity: "custom" });
  await publish(c, custom, await token(c, custom));
  const sc = await live(c, custom);
  ok(sc.identity_dependency === "sendset" && sc.source_identity_rev === null, "a custom-identity publication records no profile revision");

  const { rows: [u] } = await c.query("insert into public.users (email) values ('no-profile-' || gen_random_uuid() || '@example.com') returning id");
  const bare = await sendset(c, { owner: u.id });
  await publish(c, bare, await token(c, bare));
  const sb = await live(c, bare);
  ok(sb.identity_dependency === "account_profile" && sb.source_identity_rev === null, "a default Sendset with no profile row records a NULL revision");

  await unpublish(c, ss);
  const su = await live(c, ss);
  ok(su.status === "draft" && su.content === null, "unpublish removes the status and the frozen copy");
  const again = await attempt(c, "select public.unpublish_packet($1, $2)", [ss.owner, ss.id]);
  ok(again.ok && (await live(c, ss)).status === "draft", "unpublishing a draft is a no-op, not an error");
  const other = await attempt(c, "select public.unpublish_packet($1, $2)", ["00000000-0000-4000-8000-00000000dead", custom.id]);
  ok(!other.ok && other.err.code === "PT404" && (await live(c, custom)).status === "published", "another owner cannot unpublish");

  // Block composition.
  const blk = await sendset(c);
  await c.query("select public.convert_packet_to_blocks($1)", [blk.id]);
  const { rows: blocks } = await c.query("select id, block_type, item_id from public.packet_blocks where packet_id = $1 order by position", [blk.id]);
  const blockContent = { slug: blk.slug, sections: [], blocks: blocks.map((b) => b.block_type === "item"
    ? { id: b.id, kind: "item", item: { id: b.item_id, title: "Item" } } : { id: b.id, kind: b.block_type, text: "S" }) };
  const rb = await attempt(c, publishSql, publishArgs(blk, await token(c, blk), { content: blockContent }));
  ok(rb.ok && (await live(c, blk)).status === "published", "a block-composed Sendset publishes");
});

// ===========================================================================
console.log("\n== 3. Every refusal leaves the live publication byte-for-byte");
await withDb("t52_refusals", async (c) => {
  const ss = await sendset(c);
  const other = await sendset(c);
  await publish(c, ss, await token(c, ss), { identity: { name: "Live" } });
  const before = await live(c, ss);

  const refusals = [
    ["a stale token", async () => { const t = await token(c, ss); await c.query(`update public.items set title = 'Moved on' where id = $1`, [ss.itemId]); return publishArgs(ss, t); }, "PT409", "changed"],
    ["another owner", async () => publishArgs(ss, await token(c, ss), { owner: "00000000-0000-4000-8000-00000000dead" }), "PT404", "not_found"],
    ["a blocking import", async () => {
      await c.query(`insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status) values ($1, $2, 'append', 'h', 'seg-v4', 'active')`, [OWNER, ss.id]);
      return publishArgs(ss, await token(c, ss)); }, "PT409", "import_blocks"],
    ["a missing title", async () => {
      await c.query(`delete from public.ingestion_runs where packet_id = $1`, [ss.id]);
      await c.query(`update public.packets set title = '  ' where id = $1`, [ss.id]);
      return publishArgs(ss, await token(c, ss)); }, "PT400", "title_required"],
    ["another Sendset's slug", async () => {
      await c.query(`update public.packets set title = 'T' where id = $1`, [ss.id]);
      return publishArgs(ss, await token(c, ss), { content: snapshot(ss, { slug: other.slug }) }); }, "PT400", "invalid_snapshot"],
    ["another Sendset's item", async () => publishArgs(ss, await token(c, ss), { content: { slug: ss.slug, sections: [{ id: ss.sectionId, items: [{ id: other.itemId }] }] } }), "PT400", "invalid_snapshot"],
    ["another Sendset's section", async () => publishArgs(ss, await token(c, ss), { content: { slug: ss.slug, sections: [{ id: other.sectionId, items: [] }] } }), "PT400", "invalid_snapshot"],
    ["a private note in the copy", async () => publishArgs(ss, await token(c, ss), { content: snapshot(ss, { sections: [{ id: ss.sectionId, items: [{ id: ss.itemId, notes: "private" }] }] }) }), "PT400", "invalid_snapshot"],
    ["the internal title in the copy", async () => publishArgs(ss, await token(c, ss), { content: snapshot(ss, { title: "Internal" }) }), "PT400", "invalid_snapshot"],
    ["an unknown snapshot format", async () => publishArgs(ss, await token(c, ss), { format: 2 }), "PT400", "invalid_snapshot"],
    ["a non-object identity snapshot", async () => [...publishArgs(ss, await token(c, ss)).slice(0, 5), JSON.stringify(["x"])], "PT400", "invalid_snapshot"],
  ];
  for (const [what, args, code, detail] of refusals) {
    const r = await attempt(c, publishSql, await args());
    const after = await live(c, ss);
    const kept = after.content === before.content && after.pub_published_at === before.pub_published_at
      && after.status === "published" && after.identity === before.identity && after.p_published_at === before.p_published_at;
    ok(!r.ok && r.err.code === code && r.err.detail === detail && kept, `refused (${code} ${detail}) and live copy untouched: ${what}`);
  }
});

// ===========================================================================
console.log("\n== 4. Grants and cascades");
await withDb("t52_grants", async (c) => {
  const ss = await sendset(c);
  for (const role of ["anon", "authenticated"]) {
    for (const [fn, args] of [["packet_publish_token", "$1, $2"], ["unpublish_packet", "$1, $2"]]) {
      const r = await attempt(c, `begin; set local role ${role}; select public.${fn}('${OWNER}', '${ss.id}'); commit;`);
      ok(!r.ok && /permission denied/.test(r.err.message), `${role} cannot execute ${fn}`);
    }
    const r = await attempt(c, `begin; set local role ${role}; select public.publish_packet('${OWNER}', '${ss.id}', '{}', 1::smallint, '{}', '{}'); commit;`);
    ok(!r.ok && /permission denied/.test(r.err.message), `${role} cannot execute publish_packet`);
  }
  await c.query("begin; set local role service_role");
  const tr = await attempt(c, "select public.packet_publish_token($1, $2) as t", [OWNER, ss.id]);
  ok(tr.ok, "service_role can read the token" + (tr.ok ? "" : ` — ${tr.err.message}`));
  if (tr.ok) {
    const r = await attempt(c, publishSql, publishArgs(ss, tr.res.rows[0].t));
    ok(r.ok, "service_role publishes with it" + (r.ok ? "" : ` — ${r.err.message}`));
    if (r.ok) await c.query("commit");
  }
  for (const fn of ["lock_packets_for_media_decision", "lock_packets_for_profile"]) {
    const x = await attempt(c, `begin; set local role service_role; select public.${fn}(); commit;`);
    ok(!x.ok && /permission denied/.test(x.err.message), `service_role cannot execute ${fn}()`);
  }

  await c.query(`insert into public.item_media_decisions (item_id, url) values ($1, $2)`, [ss.itemId, PHOTO]);
  const del = await attempt(c, "delete from public.packets where id = $1", [ss.id]);
  ok(del.ok && !(await c.query("select 1 from public.packet_publications where packet_id = $1", [ss.id])).rowCount,
    "deleting a published Sendset with a Keep cascades cleanly (the lock trigger finds nothing to lock)");
  const { rows: [u] } = await c.query("insert into public.users (email) values ('gone-' || gen_random_uuid() || '@example.com') returning id");
  await c.query("insert into public.professional_profiles (user_id, name) values ($1, 'Gone')", [u.id]);
  const gone = await sendset(c, { owner: u.id });
  await publish(c, gone, await token(c, gone));
  const du = await attempt(c, "delete from public.users where id = $1", [u.id]);
  ok(du.ok, "deleting an account with a profile and a published Sendset cascades cleanly");
});

// ===========================================================================
console.log("\n== 5. Two connections");
async function race(name, fn, opts) { await withDb(name, async (a, b, w) => fn(a, b, w), opts); }
const DECISION_INS = "insert into public.item_media_decisions (item_id, url) values ($1, $2)";
const DECISION_DEL = "delete from public.item_media_decisions where item_id = $1";

await race("t52_r1", async (a, b, w) => {
  const ss = await sendset(w); const t0 = await token(w, ss);
  await a.query("begin"); await a.query(DECISION_INS, [ss.itemId, PHOTO]);
  const p = pending(publish(b, ss, t0)); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await p;
  ok(waited && !r.ok && r.err.detail === "changed" && (await live(w, ss)).status === "draft", `Keep in flight, then publish: publish waited (${waited}) and refused`);
});
await race("t52_r2", async (a, b, w) => {
  const ss = await sendset(w); const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const k = pending(a.query(DECISION_INS, [ss.itemId, PHOTO])); const waited = await waitsOnLock(w, a.pid);
  await b.query("commit"); const r = await k;
  ok(waited && r.ok && (await live(w, ss)).status === "published", `publish in flight, then Keep: the Keep waited (${waited}) and landed after`);
});
await race("t52_r3", async (a, b, w) => {
  const ss = await sendset(w); const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const r = await attempt(a, DECISION_INS, [ss.itemId, PHOTO]);
  await b.query("commit");
  ok(r.ok, "CONTROL without the lock trigger: the Keep commits while the publish is still open");
}, { sql: MIGRATION.replace(/create trigger trg_lock_packets_for_media_decision[\s\S]*?execute function public\.lock_packets_for_media_decision\(\);\n/, "")
          .replace(/select count\(\*\) into n from pg_trigger t[\s\S]*?if n <> 2 then raise exception[^\n]*\n/, "") });
await race("t52_r4", async (a, b, w) => {
  const ss = await sendset(w); await w.query(DECISION_INS, [ss.itemId, PHOTO]); const t0 = await token(w, ss);
  await a.query("begin"); await a.query(DECISION_DEL, [ss.itemId]);
  const p = pending(publish(b, ss, t0)); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await p;
  ok(waited && !r.ok && r.err.detail === "changed", `undo-Keep in flight, then publish: publish waited (${waited}) and refused`);
});
await race("t52_r5", async (a, b, w) => {
  const ss = await sendset(w); await w.query(DECISION_INS, [ss.itemId, PHOTO]); const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const d = pending(a.query(DECISION_DEL, [ss.itemId])); const waited = await waitsOnLock(w, a.pid);
  await b.query("commit"); const r = await d;
  ok(waited && r.ok, `publish in flight, then undo-Keep: it waited (${waited}) and landed after`);
});
for (const [label, publishIndex] of [["NEW", 1], ["OLD", 0]]) {
  await race(`t52_r6_${label}`, async (a, b, w) => {
    const s = [await sendset(w), await sendset(w)];
    await w.query(DECISION_INS, [s[0].itemId, PHOTO]);
    const target = s[publishIndex]; const t = await token(w, target);
    await b.query("begin"); await publish(b, target, t);
    const mv = pending(a.query("update public.item_media_decisions set item_id = $1 where item_id = $2", [s[1].itemId, s[0].itemId]));
    const waited = await waitsOnLock(w, a.pid); await b.query("commit"); const r = await mv;
    ok(waited && r.ok, `moving a Keep between Sendsets waits on the ${label} owner's publish (${waited})`);
  });
}
await race("t52_r7", async (a, b, w) => {
  const ss = await sendset(w); const t0 = await token(w, ss);
  await a.query("begin"); await a.query("update public.professional_profiles set phone = '555-0199' where user_id = $1", [OWNER]);
  const p = pending(publish(b, ss, t0)); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await p;
  ok(waited && !r.ok && r.err.detail === "changed", `profile update in flight, then publish: publish waited (${waited}) and refused`);
});
await race("t52_r8", async (a, b, w) => {
  const ss = await sendset(w); const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const u = pending(a.query("update public.professional_profiles set phone = '555-0199' where user_id = $1", [OWNER]));
  const waited = await waitsOnLock(w, a.pid); await b.query("commit"); const r = await u;
  ok(waited && r.ok, `publish in flight, then profile update: it waited (${waited}) and landed after`);
});
await race("t52_r9", async (a, b, w) => {
  const { rows: [u] } = await w.query("insert into public.users (email) values ('first-' || gen_random_uuid() || '@example.com') returning id");
  const ss = await sendset(w, { owner: u.id }); const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const ins = pending(a.query("insert into public.professional_profiles (user_id, name, phone) values ($1, 'New', '555-0103')", [u.id]));
  const waited = await waitsOnLock(w, a.pid); await b.query("commit"); const r = await ins;
  ok(waited && r.ok, `publish in flight, then a FIRST profile insert: it waited (${waited})`);
});
await race("t52_r10", async (a, b, w) => {
  const { rows: [u] } = await w.query("insert into public.users (email) values ('first2-' || gen_random_uuid() || '@example.com') returning id");
  const ss = await sendset(w, { owner: u.id }); const t0 = await token(w, ss);
  await a.query("begin"); await a.query("insert into public.professional_profiles (user_id, name, phone) values ($1, 'New', '555-0103')", [u.id]);
  const p = pending(publish(b, ss, t0)); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await p;
  ok(waited && !r.ok && r.err.detail === "changed", `first profile insert in flight, then publish: publish waited (${waited}) and refused`);
});
await race("t52_r11", async (a, b, w) => {
  const ss = await sendset(w, { identity: "custom" });
  await w.query("update public.packets set identity_mode = 'default', custom_identity = null where id = $1", [ss.id]);
  const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const u = pending(a.query("update public.professional_profiles set name = 'Renamed' where user_id = $1", [OWNER]));
  const waited = await waitsOnLock(w, a.pid); await b.query("commit"); const r = await u;
  ok(waited && r.ok, `a Sendset just switched custom→default still serialises with profile writes (${waited})`);
});
await race("t52_r11b", async (a, b, w) => {
  const ss = await sendset(w, { identity: "custom" }); const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const u = pending(a.query("update public.professional_profiles set name = 'Renamed' where user_id = $1", [OWNER]));
  const waited = await waitsOnLock(w, a.pid); await b.query("commit"); await u;
  ok(waited, `profile writes serialise with EVERY Sendset of the owner, custom ones included (${waited}) — a mode filter would be read from a snapshot`);
});
await race("t52_r12", async (a, b, w) => {
  const ss = await sendset(w);
  const { rows: [run] } = await w.query(`insert into public.ingestion_runs (user_id, packet_id, entry_point, source_text, source_hash, source_len, segmenter_version, status, total_chunks)
     values ($1, $2, 'append', 'abcdefghij', 'h', 10, 'seg-v4', 'active', 1) returning id`, [OWNER, ss.id]);
  await w.query(`insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_hash, status) values ($1, 0, 0, 10, 'h', 'processing')`, [run.id]);
  const t0 = await token(w, ss);
  await a.query("begin"); await a.query("update public.ingestion_chunks set status = 'split' where run_id = $1", [run.id]);
  const r = await attempt(b, publishSql, publishArgs(ss, t0));
  await a.query("rollback");
  ok(!r.ok && r.err.detail === "import_blocks", "active chunk being mutated: publish refuses on the active run");
  await w.query("update public.ingestion_runs set status = 'finalized', review = '{\"ok\": true}' where id = $1", [run.id]);
  const split = await attempt(w, "select public.split_chunk($1, $2, 0, 0, '[]'::jsonb)", [run.id, OWNER]);
  ok(!split.ok && /not active/.test(split.err.message), "and a finalized run's chunks cannot be split afterwards");
});
await race("t52_r13", async (a, b, w) => {
  const ss = await sendset(w); const t0 = await token(w, ss);
  await a.query("begin"); await publish(a, ss, t0);
  const u = pending(unpublish(b, ss)); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await u; const s = await live(w, ss);
  ok(waited && r.ok && s.status === "draft" && s.content === null, `publish then unpublish: unpublish waited (${waited}) and removed both`);
});
await race("t52_r14", async (a, b, w) => {
  const ss = await sendset(w); await publish(w, ss, await token(w, ss)); const t1 = await token(w, ss);
  await a.query("begin"); await unpublish(a, ss);
  const p = pending(publish(b, ss, t1)); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await p; const s = await live(w, ss);
  ok(waited && !r.ok && r.err.detail === "changed" && s.status === "draft" && s.content === null,
    `unpublish then republish: republish waited (${waited}), refused, nothing resurrected`);
});
await race("t52_r15", async (a, b, w) => {
  const ss = await sendset(w); await publish(w, ss, await token(w, ss)); const before = await live(w, ss);
  const t1 = await token(w, ss);
  await a.query("update public.items set title = 'Edited after the token' where id = $1", [ss.itemId]);
  const r = await attempt(b, publishSql, publishArgs(ss, t1));
  const after = await live(w, ss);
  ok(!r.ok && r.err.detail === "changed" && same(after, before), "content edited after the route's token: refused, live copy byte-for-byte");
});
await race("t52_r16", async (a, b, w) => {
  const ss = await sendset(w); await publish(w, ss, await token(w, ss)); const before = await live(w, ss);
  const t1 = await token(w, ss);
  await a.query("begin"); await a.query("update public.items set title = 'Edit in flight' where id = $1", [ss.itemId]);
  const p = pending(publish(b, ss, t1)); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await p;
  ok(waited && !r.ok && r.err.detail === "changed" && same(await live(w, ss), before),
    `edit in flight, then republish: republish waited (${waited}), refused, live copy byte-for-byte`);
});
await race("t52_r17", async (a, b, w) => {
  const ss = await sendset(w); await publish(w, ss, await token(w, ss));
  const t = await token(w, ss);
  await a.query("begin"); await publish(a, ss, t, { content: snapshot(ss, { personalNote: "tab A" }) });
  const p = pending(publish(b, ss, t, { content: snapshot(ss, { personalNote: "tab B" }) })); const waited = await waitsOnLock(w, b.pid);
  await a.query("commit"); const r = await p; const s = await live(w, ss);
  ok(waited && r.ok && JSON.parse(s.content).personalNote === "tab B",
    `two tabs republishing identical inputs serialise (${waited}); the later one wins, never a mix`);
});
await race("t52_r18", async (a, b, w) => {
  const ss = await sendset(w); const t0 = await token(w, ss);
  await b.query("begin"); await publish(b, ss, t0);
  const create = pending(a.query(`select public.create_ingestion_run($1, $2, 'append', null, 'text', 'h', 4, 'seg-v4',
     '[{"ordinal":0,"source_start":0,"source_end":4,"segment_text":"text","segment_hash":"h"}]'::jsonb)`, [OWNER, ss.id]));
  const waited = await waitsOnLock(w, a.pid); await b.query("commit"); const r = await create;
  ok(waited && !r.ok && /not draft/.test(r.err.message), `publish in flight, then an import starts: it waited (${waited}) and was refused on the published Sendset`);
});

// ===========================================================================
console.log("\n== 6. Rollback");
await withDb("t52_rollback", async (c) => {
  const ss = await sendset(c); await publish(c, ss, await token(c, ss));
  const before = await live(c, ss);
  const down = await attempt(c, ROLLBACK);
  ok(down.ok && same(await live(c, ss), before), "rollback drops the 0052 objects and touches no row" + (down.ok ? "" : ` — ${down.err.message}`));
  const trig = await attempt(c, "insert into public.item_media_decisions (item_id, url) values ($1, $2)", [ss.itemId, PHOTO]);
  ok(trig.ok, "after rollback the pre-0052 write paths still work");
  const reapply = await attempt(c, MIGRATION);
  ok(reapply.ok, "0052 re-applies after rollback" + (reapply.ok ? "" : ` — ${reapply.err.message}`));
  const twice = await attempt(c, MIGRATION);
  ok(!twice.ok && /MIGRATION 0052 ABORTED/.test(twice.err.message), "0052 refuses to run twice");
  await c.query(`create function public._single_door_stand_in() returns trigger language plpgsql as $f$
    begin if current_setting('app.publication_authorized_packet', true) is distinct from new.id::text then raise exception 'no'; end if; return new; end $f$;
    create trigger trg_stand_in before update of status on public.packets for each row execute function public._single_door_stand_in();`);
  const guarded = await attempt(c, ROLLBACK);
  ok(!guarded.ok && /ROLLBACK 0052 REFUSED/.test(guarded.err.message), "rollback refuses while a trigger enforcing the publication flag exists (0053)");
});

// ===========================================================================
console.log("\n== 7. Mutants: each is caught by the migration itself or by a targeted harness check");
// detect(db) returns true when the harness observes the defect the mutant introduces.
async function observe(db, fn) {
  const conns = await Promise.all([connect(db), connect(db), connect(db)]);
  try { return await fn(...conns); } finally { await Promise.all(conns.map((c) => c.end())); }
}
const tokenIgnores = (sql) => (db) => observe(db, async (c) => {
  const ss = await sendset(c); const before = await token(c, ss);
  await c.query(sql.replaceAll("$ITEM", ss.itemId).replaceAll("$PACKET", ss.id));
  return same(before, await token(c, ss));
});
const lockDoesNotWait = (setup) => (db) => observe(db, async (a, b, w) => {
  const { target, write } = await setup(w);
  await b.query("begin"); await publish(b, target, await token(w, target));
  const p = pending(a.query(write.sql, write.params));
  const waited = await waitsOnLock(w, a.pid, 20);
  await b.query("commit"); await p;
  return !waited;
});
const MUTANTS = [
  ["token omits media decisions", (s) => s.replace(/,\n      'decisions', coalesce\([\s\S]*?'\[\]'::jsonb\)\n    \) as j/, "\n    ) as j"),
    tokenIgnores(`insert into public.item_media_decisions (item_id, url) values ('$ITEM', '${PHOTO}')`)],
  ["token omits raw_input", (s) => s.replace("      'raw_input', (select raw_input from p),\n", ""),
    tokenIgnores(`update public.packets set raw_input = 'changed' where id = '$PACKET'`)],
  ["token omits source chunks", (s) => s.replace(/      'chunks', coalesce\([\s\S]*?'\[\]'::jsonb\),\n/, ""),
    (db) => observe(db, async (c) => {
      const ss = await sendset(c);
      const { rows: [run] } = await c.query(`insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, source_len, segmenter_version, status, review)
        values ($1, $2, 'append', 'h', 10, 'seg-v4', 'finalized', '{"ok":true}') returning id`, [OWNER, ss.id]);
      await c.query(`update public.items set origin_run_id = $1 where id = $2`, [run.id, ss.itemId]);
      await c.query(`insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_hash, status) values ($1, 0, 0, 10, 'h', 'completed')`, [run.id]);
      const before = await token(c, ss);
      await c.query(`update public.ingestion_chunks set source_end = 8 where run_id = $1`, [run.id]);
      return same(before, await token(c, ss));
    })],
  ["token omits the profile revision", (s) => s.replace(/'identity_rev', \(select case when identity_mode = 'default'\n\s+then \(select f\.identity_rev from public\.professional_profiles f where f\.user_id = p_owner\) end from p\),/, "'identity_rev', null,"),
    tokenIgnores(`update public.professional_profiles set phone = '555-0177' where user_id = '${OWNER}'`)],
  ["publish skips the token comparison", (s) => s.replace("  if v_token is distinct from p_expected_token then", "  if false then"),
    (db) => observe(db, async (c) => {
      const ss = await sendset(c); const t = await token(c, ss);
      await c.query("update public.items set title = 'x' where id = $1", [ss.itemId]);
      return (await attempt(c, publishSql, publishArgs(ss, t))).ok;
    })],
  ["publish forgets the blocking import", (s) => s.replace("  if (v_token ->> 'blocking_run')::boolean then", "  if false then"),
    (db) => observe(db, async (c) => {
      const ss = await sendset(c);
      await c.query(`insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status) values ($1, $2, 'append', 'h', 'seg-v4', 'active')`, [OWNER, ss.id]);
      return (await attempt(c, publishSql, publishArgs(ss, await token(c, ss)))).ok;
    })],
  ["publish accepts foreign item ids", (s) => s.replace("  if v_foreign > 0 then", "  if false then"),
    (db) => observe(db, async (c) => {
      const ss = await sendset(c), other = await sendset(c);
      return (await attempt(c, publishSql, publishArgs(ss, await token(c, ss), { content: { slug: ss.slug, sections: [{ id: ss.sectionId, items: [{ id: other.itemId }] }] } }))).ok;
    })],
  ["no lock on media decisions", (s) => s.replace(/create trigger trg_lock_packets_for_media_decision[\s\S]*?execute function public\.lock_packets_for_media_decision\(\);\n/, ""),
    lockDoesNotWait(async (w) => { const ss = await sendset(w); return { target: ss, write: { sql: DECISION_INS, params: [ss.itemId, PHOTO] } }; })],
  ["media decision locks only the NEW owner", (s) => s.replace("  if tg_op <> 'INSERT' then v_items := v_items || old.item_id; end if;\n", ""),
    lockDoesNotWait(async (w) => {
      const s0 = await sendset(w), s1 = await sendset(w); await w.query(DECISION_INS, [s0.itemId, PHOTO]);
      return { target: s0, write: { sql: "update public.item_media_decisions set item_id = $1 where item_id = $2", params: [s1.itemId, s0.itemId] } };
    })],
  ["profile lock filters by identity mode", (s) => s.replace("   where p.user_id = any (v_users)\n", "   where p.user_id = any (v_users) and p.identity_mode = 'default'\n"),
    lockDoesNotWait(async (w) => ({ target: await sendset(w, { identity: "custom" }),
      write: { sql: "update public.professional_profiles set name = 'Renamed' where user_id = $1", params: [OWNER] } }))],
  ["profile lock only on UPDATE", (s) => s.replace("  before insert or update or delete on public.professional_profiles", "  before update on public.professional_profiles"),
    lockDoesNotWait(async (w) => {
      const { rows: [u] } = await w.query("insert into public.users (email) values ('m-' || gen_random_uuid() || '@example.com') returning id");
      return { target: await sendset(w, { owner: u.id }), write: { sql: "insert into public.professional_profiles (user_id, name) values ($1, 'New')", params: [u.id] } };
    })],
  ["publish executable by authenticated", (s) => s.replace("grant execute on function public.publish_packet(uuid, uuid, jsonb, smallint, jsonb, jsonb) to service_role;",
    "grant execute on function public.publish_packet(uuid, uuid, jsonb, smallint, jsonb, jsonb) to service_role, authenticated;"), null],
  ["token SECURITY INVOKER (service_role could not ask packet_has_blocking_run)",
    (s) => s.split("language sql stable security definer set search_path = '' as $$\n  with p as").join("language sql stable security invoker set search_path = '' as $$\n  with p as"), null],
  ["unpublish keeps the copy", (s) => s.replace("  delete from public.packet_publications where packet_id = p_packet_id;\n", ""),
    (db) => observe(db, async (c) => {
      const ss = await sendset(c); await publish(c, ss, await token(c, ss)); await unpublish(c, ss);
      return (await live(c, ss)).content !== null;
    })],
];
for (const [name, mutate, detect] of MUTANTS) {
  const mutated = mutate(MIGRATION);
  if (mutated === MIGRATION) { ok(false, `mutant did not apply: ${name}`); continue; }
  const db = await freshDb("t52_mutant", { apply: false });
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
