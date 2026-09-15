// 0054 against real PostgreSQL 17: the publication backfill door.
//
// Local harness only (README.md). Needs tsx for the backfill library's rollback
// SQL and canonical JSON:
//
//   scripts/pg-harness/harness.sh replay pre0054 0053
//   node --import tsx scripts/pg-harness/test-0054.mjs [path/to/0054.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0054_publication_backfill.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0054_publication_backfill_down.sql"), "utf8");
const { rollbackSql, canonicalJson } = await import(join(ROOT, "scripts/publication-backfill/lib.ts"));
const TEMPLATE = "pre0054";
const OWNER = "00000000-0000-4000-8000-000000000001";
const OLD_PUBLISHED_AT = "2026-06-01T10:00:00.123456Z";

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
const refusedWith = (r, code, detail) => !r.ok && r.err.code === code && r.err.detail === detail;
async function withDb(name, fn, opts) {
  const db = await freshDb(name, opts);
  const conns = await Promise.all([connect(db), connect(db)]);
  try { await fn(...conns); } finally { await Promise.all(conns.map((x) => x.end())); }
}

// --- fixtures ---------------------------------------------------------------
async function user(c, { profile = true } = {}) {
  const { rows: [u] } = await c.query("insert into public.users (email) values ('h-' || gen_random_uuid() || '@example.com') returning id");
  if (profile) await c.query("insert into public.professional_profiles (user_id, name, email, phone, links) values ($1, 'Harness Pro', 'pro@example.com', '555-0100', '[]')", [u.id]);
  return u.id;
}
async function sendset(c, owner = OWNER, { items = 2 } = {}) {
  const { rows: [p] } = await c.query(
    `insert into public.packets (user_id, slug, title) values ($1, 'h-' || substr(md5(random()::text), 1, 12), 'Internal name') returning id, slug`, [owner]);
  const { rows: [s] } = await c.query(`insert into public.sections (packet_id, title) values ($1, 'Section') returning id`, [p.id]);
  for (let i = 0; i < items; i++) await c.query(`insert into public.items (section_id, title, sort_order, notes) values ($1, 'Item ' || $2::text, $2::int, 'PRIVATE')`, [s.id, i]);
  return { id: p.id, slug: p.slug, owner };
}
// The recipient copy's id skeleton, as the TypeScript builder shapes it.
async function contentOf(c, ss) {
  const { rows: [p] } = await c.query("select slug, composition_mode from public.packets where id = $1", [ss.id]);
  if (p.composition_mode === "blocks") {
    const { rows } = await c.query("select id, block_type, item_id from public.packet_blocks where packet_id = $1 order by position", [ss.id]);
    return { slug: p.slug, sections: [], blocks: rows.map((b) => b.block_type === "item" ? { id: b.id, kind: "item", item: { id: b.item_id, title: "t" } } : { id: b.id, kind: b.block_type, text: "h" }) };
  }
  const { rows: secs } = await c.query("select id, title from public.sections where packet_id = $1 order by sort_order", [ss.id]);
  const sections = [];
  for (const s of secs) {
    const { rows: its } = await c.query("select id, title from public.items where section_id = $1 order by sort_order", [s.id]);
    sections.push({ id: s.id, title: s.title, items: its.map((i) => ({ id: i.id, title: i.title })) });
  }
  return { slug: p.slug, clientTitle: "For you", sections, professional: { name: "Harness Pro" } };
}
const token = async (c, id) => (await c.query("select public.packet_backfill_token($1) as t", [id])).rows[0].t;
const publishToken = async (c, ss) => (await c.query("select public.packet_publish_token($1, $2) as t", [ss.owner, ss.id])).rows[0].t;
const publish = async (c, ss, content, identity = {}) => attempt(c,
  "select public.publish_packet($1, $2, $3, 1::smallint, $4, $5) as r",
  [ss.owner, ss.id, JSON.stringify(await publishToken(c, ss)), JSON.stringify(content ?? { slug: ss.slug }), JSON.stringify(identity)]);
const backfillSql = "select public.backfill_packet_publication($1, $2, 1::smallint, $3) as r";
const backfill = async (c, id, { tok, content, format } = {}) => attempt(c,
  format ? `select public.backfill_packet_publication($1, $2, ${format}::smallint, $3) as r` : backfillSql,
  [id, JSON.stringify(tok === undefined ? await token(c, id) : tok), JSON.stringify(content)]);
const packetRow = async (c, id) => (await c.query("select md5(row(p.*)::text) as m from public.packets p where id = $1", [id])).rows[0]?.m;
const pubRow = async (c, id) => (await c.query("select x.*, md5(row(x.*)::text) as m, encode(sha256(convert_to(x.content::text, 'UTF8')), 'hex') as sha from public.packet_publications x where packet_id = $1", [id])).rows[0];

// A Sendset shaped like one published before 0052: published through the door,
// then its publication removed and its identity snapshot set as it was stored.
async function prePublished(c, { owner = OWNER, snapshot = null, mode = "default", blocks = false, custom = null } = {}) {
  const ss = await sendset(c, owner);
  if (mode !== "default") await c.query("update public.packets set identity_mode = $1, custom_identity = $2 where id = $3", [mode, custom && JSON.stringify(custom), ss.id]);
  if (blocks) await c.query("select public.convert_packet_to_blocks($1)", [ss.id]);
  const p = await publish(c, ss);
  if (!p.ok) throw new Error(`fixture publish failed: ${p.err.message}`);
  await c.query("delete from public.packet_publications where packet_id = $1", [ss.id]);
  const value = snapshot === null ? null : snapshot === "json-null" ? "null" : JSON.stringify(snapshot);
  await c.query("update public.packets set professional_snapshot = $1::jsonb, published_at = $2 where id = $3", [value, OLD_PUBLISHED_AT, ss.id]);
  return ss;
}

// ===========================================================================
console.log("\n== 1. Backfills each kind of pre-0052 Sendset exactly as designed");
await withDb("t54_happy", async (c) => {
  const noProfileOwner = await user(c, { profile: false });
  await c.query("update public.professional_profiles set name = 'Harness Owner renamed' where user_id = $1", [OWNER]);   // identity_rev 1
  const { rows: [{ identity_rev: ownerRev }] } = await c.query("select identity_rev from public.professional_profiles where user_id = $1", [OWNER]);
  ok(Number(ownerRev) === 1, "fixture: the owner's identity_rev is non-zero, so a recorded 0 would be visible");
  const kinds = [
    ["default, stored identity", { snapshot: { name: "Frozen Pro", links: [] } }, "account_profile", "null"],
    ["default, null snapshot (live profile)", { snapshot: null }, "account_profile", String(ownerRev)],
    ["default, JSON null snapshot", { snapshot: "json-null" }, "account_profile", String(ownerRev)],
    ["default, null snapshot, no profile row", { snapshot: null, owner: noProfileOwner }, "account_profile", "null"],
    ["none, {}", { snapshot: {}, mode: "none" }, "sendset", "null"],
    ["custom", { snapshot: { name: "Custom" }, mode: "custom", custom: { name: "Custom" } }, "sendset", "null"],
    ["blocks", { snapshot: { name: "Frozen Pro" }, blocks: true }, "account_profile", "null"],
  ];
  const others = await prePublished(c, { snapshot: {} });
  await publish(c, others);   // an ordinary publication that must never change
  const otherBefore = (await pubRow(c, others.id)).m;
  for (const [label, opts, dep, identityRev] of kinds) {
    const ss = await prePublished(c, opts);
    const content = await contentOf(c, ss);
    const tok = await token(c, ss.id);
    const before = await packetRow(c, ss.id);
    const { rows: [pk] } = await c.query("select draft_rev, published_at, status, professional_snapshot from public.packets where id = $1", [ss.id]);
    const r = await backfill(c, ss.id, { tok, content });
    const row = await pubRow(c, ss.id);
    ok(r.ok, `${label}: backfilled${r.ok ? "" : ` — ${r.err.message}`}`);
    if (!r.ok) continue;
    ok(canonicalJson(row.content) === canonicalJson(content), `${label}: stored content equals the copy by value`);
    ok(row.published_at.toISOString() === new Date(pk.published_at).toISOString() && row.published_at.toISOString() === "2026-06-01T10:00:00.123Z"
       && (await c.query("select published_at = $2::timestamptz as same from public.packet_publications where packet_id = $1", [ss.id, OLD_PUBLISHED_AT])).rows[0].same,
      `${label}: publication.published_at is the Sendset's own, to the microsecond`);
    ok(Number(row.source_draft_rev) === Number(pk.draft_rev) && row.format_version === 1, `${label}: source_draft_rev and format`);
    ok(row.identity_dependency === dep && String(row.source_identity_rev) === identityRev,
      `${label}: identity_dependency ${dep}, source_identity_rev ${identityRev} (got ${row.identity_dependency}, ${row.source_identity_rev})`);
    ok((await packetRow(c, ss.id)) === before, `${label}: the Sendset row is byte-identical (status, published_at, snapshot, updated_at, draft_rev…)`);
    ok(r.res.rows[0].r.contentSha256 === row.sha, `${label}: the returned digest is the stored jsonb's`);
    ok(tok.identity_from_profile === (opts.snapshot === null || opts.snapshot === "json-null"), `${label}: the token knows where the card comes from`);
  }
  ok((await pubRow(c, others.id)).m === otherBefore, "an existing publication elsewhere is untouched");
});

// ===========================================================================
console.log("\n== 2. Refusals write nothing");
await withDb("t54_refuse", async (c) => {
  const checkNothing = async (label, ss, r, code, detail) => {
    ok(refusedWith(r, code, detail) && !(await pubRow(c, ss.id)), `${label}: ${code} ${detail}${r.ok ? " (ACCEPTED)" : r.err.detail === detail ? "" : ` (got ${r.err.code} ${r.err.detail}: ${r.err.message})`}`);
  };
  const ghost = { id: "00000000-0000-4000-8000-00000000dead" };
  await checkNothing("a missing Sendset", ghost, await backfill(c, ghost.id, { tok: null, content: { slug: "x" } }), "PT404", "not_found");

  const draft = await sendset(c);
  await checkNothing("a draft", draft, await backfill(c, draft.id, { content: await contentOf(c, draft) }), "PT409", "not_published");

  const noDate = await prePublished(c, { snapshot: {} });
  await c.query("update public.packets set published_at = null where id = $1", [noDate.id]);
  await checkNothing("published with no published_at", noDate, await backfill(c, noDate.id, { content: await contentOf(c, noDate) }), "PT409", "not_published");

  const existing = await prePublished(c, { snapshot: {} });
  await publish(c, existing, await contentOf(c, existing));
  const pubBefore = (await pubRow(c, existing.id)).m, pkBefore = await packetRow(c, existing.id);
  const ex1 = await backfill(c, existing.id, { content: { ...(await contentOf(c, existing)), clientTitle: "overwrite attempt" } });
  const ex2 = await backfill(c, existing.id, { tok: { stale: true }, content: { slug: "wrong", title: "internal" } });
  ok(refusedWith(ex1, "PT409", "publication_exists") && refusedWith(ex2, "PT409", "publication_exists")
     && (await pubRow(c, existing.id)).m === pubBefore && (await packetRow(c, existing.id)) === pkBefore,
    "an existing publication is refused (even with a stale token and bad content) and stays byte-identical");

  const stale = async (label, setup, opts = {}) => {
    const ss = await prePublished(c, { snapshot: null, ...opts });
    const tok = await token(c, ss.id);
    const content = await contentOf(c, ss);
    await setup(ss);
    const before = await packetRow(c, ss.id);
    const r = await backfill(c, ss.id, { tok, content: { ...content, slug: (await c.query("select slug from public.packets where id = $1", [ss.id])).rows[0].slug } });
    await checkNothing(`stale token — ${label}`, ss, r, "PT409", "changed");
    ok((await packetRow(c, ss.id)) === before, `stale token — ${label}: the Sendset row is untouched`);
  };
  await stale("an item edit", (ss) => c.query("update public.items set title = 'edited' where section_id in (select id from public.sections where packet_id = $1)", [ss.id]));
  await stale("a personal note edit", (ss) => c.query("update public.packets set personal_note = 'new' where id = $1", [ss.id]));
  await stale("a photo added", (ss) => c.query("insert into public.item_photos (item_id, url) select i.id, 'https://p.example/x.jpg' from public.items i join public.sections s on s.id = i.section_id where s.packet_id = $1 limit 1", [ss.id]));
  await stale("the identity snapshot changed", (ss) => c.query("update public.packets set professional_snapshot = '{\"name\":\"Other\"}' where id = $1", [ss.id]));
  await stale("the live profile changed (null snapshot)", (ss) => c.query("update public.professional_profiles set footer_label = 'Changed' where user_id = $1", [ss.owner]));
  await stale("the profile was deleted (null snapshot)", async (ss) => { await c.query("delete from public.professional_profiles where user_id = $1", [ss.owner]); },
    { owner: await user(c) });
  await stale("published_at changed", (ss) => c.query("update public.packets set published_at = now() where id = $1", [ss.id]));
  await stale("identity_mode changed", (ss) => c.query("update public.packets set identity_mode = 'none' where id = $1", [ss.id]));
  const nullTok = await prePublished(c, { snapshot: {} });
  await checkNothing("a null expected token", nullTok, await backfill(c, nullTok.id, { tok: null, content: await contentOf(c, nullTok) }), "PT409", "changed");

  const stored = await prePublished(c, { snapshot: { name: "Frozen" } });
  const storedTok = await token(c, stored.id);
  await c.query("update public.professional_profiles set phone = '555-0199' where user_id = $1", [OWNER]);
  ok((await backfill(c, stored.id, { tok: storedTok, content: await contentOf(c, stored) })).ok,
    "a profile edit does NOT refuse a Sendset whose card is its stored snapshot (the page never reads the profile)");

  const invalid = async (label, mutate, { format, blocks } = {}) => {
    const ss = await prePublished(c, { snapshot: {}, blocks });
    const content = mutate(await contentOf(c, ss), ss);
    await checkNothing(`invalid snapshot — ${label}`, ss, await backfill(c, ss.id, { content, format }), "PT400", "invalid_snapshot");
  };
  const elsewhere = await prePublished(c, { snapshot: {} });
  const foreign = await contentOf(c, elsewhere);
  const foreignBlocks = await contentOf(c, await prePublished(c, { snapshot: {}, blocks: true }));
  await invalid("wrong slug", (x) => ({ ...x, slug: elsewhere.slug }));
  await invalid("a foreign section id", (x) => ({ ...x, sections: [{ ...x.sections[0], id: foreign.sections[0].id }] }));
  await invalid("a foreign item id", (x) => ({ ...x, sections: [{ ...x.sections[0], items: [foreign.sections[0].items[0]] }] }));
  await invalid("a foreign block id", (x) => ({ ...x, blocks: [foreignBlocks.blocks[0], ...x.blocks.slice(1)] }), { blocks: true });
  await invalid("a foreign item inside a block", (x) => ({ ...x, blocks: [{ ...x.blocks[0], item: { id: foreign.sections[0].items[0].id } }, ...x.blocks.slice(1)] }), { blocks: true });
  await invalid("the internal title", (x) => ({ ...x, title: "Internal name" }));
  await invalid("a private note, nested", (x) => ({ ...x, sections: [{ ...x.sections[0], items: [{ ...x.sections[0].items[0], notes: "PRIVATE" }] }] }));
  await invalid("format 2", (x) => x, { format: 2 });
  await invalid("not an object", () => [1, 2]);
  const broken = await prePublished(c, { snapshot: {}, blocks: true });
  const brokenContent = await contentOf(c, broken);
  await c.query("set session_replication_role = replica");   // fixture only: break block consistency behind the triggers
  await c.query("delete from public.packet_blocks where packet_id = $1 and position = 0", [broken.id]);
  await c.query("set session_replication_role = origin");
  const br = await backfill(c, broken.id, { content: { ...brokenContent, blocks: brokenContent.blocks.slice(1) } });
  ok(!br.ok && /consistency/.test(br.err.message) && !(await pubRow(c, broken.id)), "an inconsistent block Sendset is refused by assert_packet_block_consistency");
});

// ===========================================================================
console.log("\n== 3. Same rules as publish_packet, and no door is opened");
await withDb("t54_parity", async (c) => {
  const cases = [
    ["wrong slug", (x) => ({ ...x, slug: "not-this-one" })],
    ["foreign item", (x, f) => ({ ...x, sections: [{ ...x.sections[0], items: [f.sections[0].items[0]] }] })],
    ["foreign section", (x, f) => ({ ...x, sections: [{ ...x.sections[0], id: f.sections[0].id }] })],
    ["title key", (x) => ({ ...x, title: "t" })],
    ["notes key", (x) => ({ ...x, sections: [{ ...x.sections[0], items: [{ ...x.sections[0].items[0], notes: "n" }] }] })],
    ["array", () => []],
  ];
  const f = await contentOf(c, await sendset(c));
  for (const [label, mutate] of cases) {
    const viaBackfill = await prePublished(c, { snapshot: {} });
    const viaPublish = await sendset(c);
    const b = await backfill(c, viaBackfill.id, { content: mutate(await contentOf(c, viaBackfill), f) });
    const p = await publish(c, viaPublish, mutate(await contentOf(c, viaPublish), f));
    ok(!b.ok && !p.ok && b.err.code === p.err.code && b.err.detail === p.err.detail && b.err.detail === "invalid_snapshot",
      `${label}: backfill and publish_packet refuse identically (${b.err?.code}/${b.err?.detail} vs ${p.err?.code}/${p.err?.detail})`);
  }
  const good = await prePublished(c, { snapshot: {} });
  const r = await attempt(c, `begin;
      select public.backfill_packet_publication('${good.id}', public.packet_backfill_token('${good.id}'), 1::smallint, '${JSON.stringify(await contentOf(c, good))}'::jsonb);
      select coalesce(current_setting('app.publication_authorized_packet', true), '') as flag;
      update public.packets set status = 'draft' where id = '${good.id}';
      commit;`);
  ok(!r.ok && r.err.code === "PT403" && r.err.detail === "status_single_door", "after a backfill in the same transaction, a direct status write is still refused by 0053 (the backfill opened no door)");
  const again = await backfill(c, good.id, { content: await contentOf(c, good) });
  ok(again.ok && (await c.query("select status from public.packets where id = $1", [good.id])).rows[0].status === "published", "…and that whole transaction rolled back, so the backfill can run");
});

// ===========================================================================
console.log("\n== 4. Grants");
await withDb("t54_grants", async (c) => {
  const ss = await prePublished(c, { snapshot: {} });
  for (const role of ["anon", "authenticated"]) {
    const t = await attempt(c, `begin; set local role ${role}; select public.packet_backfill_token('${ss.id}'); commit;`);
    const b = await attempt(c, `begin; set local role ${role}; select public.backfill_packet_publication('${ss.id}', null, 1::smallint, '{}'); commit;`);
    ok(!t.ok && /permission denied/.test(t.err.message) && !b.ok && /permission denied/.test(b.err.message), `${role} can execute neither function`);
  }
  const content = JSON.stringify(await contentOf(c, ss));
  const svc = await attempt(c, `begin; set local role service_role;
      select public.backfill_packet_publication('${ss.id}', public.packet_backfill_token('${ss.id}'), 1::smallint, '${content}'::jsonb); commit;`);
  ok(svc.ok && !!(await pubRow(c, ss.id)), "service_role backfills end to end (it holds only SELECT on packet_publications itself)");
  const direct = await attempt(c, `begin; set local role service_role; insert into public.packet_publications (packet_id, format_version, content, source_draft_rev, identity_dependency) values ('${(await prePublished(c, { snapshot: {} })).id}', 1, '{}', 0, 'sendset'); commit;`);
  ok(!direct.ok && /permission denied/.test(direct.err.message), "control: service_role still cannot insert a publication directly");
});

// ===========================================================================
console.log("\n== 5. The manifest digest ignores key order; rollback SQL removes only unchanged rows");
await withDb("t54_digest", async (c) => {
  const ss = await prePublished(c, { snapshot: {} });
  const base = await contentOf(c, ss);
  const reverseKeys = (v) => Array.isArray(v) ? v.map(reverseKeys)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])])) : v;
  const reordered = reverseKeys(base);
  ok(JSON.stringify(reordered) !== JSON.stringify(base) && canonicalJson(reordered) === canonicalJson(base),
    "fixture: the two copies differ in bytes but not in value (canonicalJson agrees)");
  const a = await backfill(c, ss.id, { content: base });
  const shaA = a.ok && a.res.rows[0].r.contentSha256;
  await c.query("delete from public.packet_publications where packet_id = $1", [ss.id]);
  const b = await backfill(c, ss.id, { content: reordered });
  const shaB = b.ok && b.res.rows[0].r.contentSha256;
  ok(a.ok && b.ok && /^[0-9a-f]{64}$/.test(shaA) && shaA === shaB, "the same copy sent with different key order gets the same manifest digest");
  const changed = await backfill(c, (await prePublished(c, { snapshot: {} })).id, { content: { ...base, slug: "x" } });
  ok(!changed.ok, "(control: content for another slug is refused, not digested)");

  // Rollback: four manifest rows in four states.
  const untouched = await prePublished(c, { snapshot: {} });
  const republishedSame = await prePublished(c, { snapshot: {} });
  const republishedDifferent = await prePublished(c, { snapshot: {} });
  const unpublished = await prePublished(c, { snapshot: {} });
  const manifest = [];
  for (const s of [untouched, republishedSame, republishedDifferent, unpublished]) {
    const r = await backfill(c, s.id, { content: await contentOf(c, s) });
    const m = r.res.rows[0].r;
    manifest.push({ packet_id: s.id, published_at: m.publishedAt, source_draft_rev: m.sourceDraftRev, content_sha256: m.contentSha256 });
  }
  await publish(c, republishedSame, await contentOf(c, republishedSame));       // same content, new published_at
  await publish(c, republishedDifferent, { ...(await contentOf(c, republishedDifferent)), clientTitle: "Changed" });
  await c.query("select public.unpublish_packet($1, $2)", [unpublished.owner, unpublished.id]);
  const statuses = async () => (await c.query("select id, status, published_at::text from public.packets order by id")).rows;
  const statusBefore = JSON.stringify(await statuses());
  const keptBefore = [(await pubRow(c, republishedSame.id)).m, (await pubRow(c, republishedDifferent.id)).m];
  const sql = rollbackSql(manifest);
  const results = await c.query(sql);
  const result = [].concat(results).find((x) => x.command === "SELECT" && x.rows[0] && "deleted" in x.rows[0]).rows[0];
  ok(Number(result.deleted) === 1 && Number(result.kept_changed) === 2 && Number(result.already_absent) === 1,
    `rollback SQL: deleted 1 unchanged, kept 2 republished, 1 already absent (got ${JSON.stringify(result)})`);
  ok(!(await pubRow(c, untouched.id)) && (await pubRow(c, republishedSame.id)).m === keptBefore[0] && (await pubRow(c, republishedDifferent.id)).m === keptBefore[1],
    "rollback SQL: the republished rows are byte-identical, including one whose content equals the backfill");
  ok(JSON.stringify(await statuses()) === statusBefore, "rollback SQL changes no Sendset");
  ok(manifest.every((m) => !/"/.test(m.published_at)) && (() => { try { rollbackSql([{ ...manifest[0], packet_id: "x'); drop table public.packets; --" }]); return false; } catch { return true; } })(),
    "rollback SQL refuses a malformed manifest entry instead of interpolating it");
});

// ===========================================================================
console.log("\n== 6. Two connections");
const waiting = async (c, pid) => {
  for (let i = 0; i < 100; i++) {
    const { rows: [r] } = await c.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
};
const settle = (p) => p.then((res) => ({ ok: true, res }), (err) => ({ ok: false, err }));
await withDb("t54_concurrency", async (a, b) => {
  const watcher = await connect(a.database);
  try {
    // A backfill holds the lock: an edit waits, then lands after it.
    let ss = await prePublished(a, { snapshot: null });
    await a.query("begin");
    await a.query(backfillSql, [ss.id, JSON.stringify(await token(a, ss.id)), JSON.stringify(await contentOf(a, ss))]);
    let p = settle(b.query("update public.items set title = 'after' where section_id in (select id from public.sections where packet_id = $1)", [ss.id]));
    ok(await waiting(watcher, b.pid), "an item edit waits on an uncommitted backfill");
    await a.query("commit"); await p;
    const { rows: [x] } = await a.query("select p.draft_rev, x.source_draft_rev from public.packets p join public.packet_publications x on x.packet_id = p.id where p.id = $1", [ss.id]);
    ok(Number(x.draft_rev) > Number(x.source_draft_rev), "…and commits after it: the copy predates the edit, which draft_rev shows");

    // An edit holds the lock between token read and backfill: the backfill waits, then refuses.
    const edits = [
      ["an item edit", (s) => b.query("update public.items set title = 'mid' where section_id in (select id from public.sections where packet_id = $1)", [s.id]), { snapshot: null }],
      ["a live-profile edit (null snapshot)", (s) => b.query("update public.professional_profiles set name = 'mid' where user_id = $1", [s.owner]), { snapshot: null }],
      ["an identity snapshot edit", (s) => b.query("update public.packets set professional_snapshot = '{\"name\":\"mid\"}' where id = $1", [s.id]), { snapshot: {} }],
    ];
    for (const [label, edit, opts] of edits) {
      ss = await prePublished(a, opts);
      const tok = await token(a, ss.id), content = await contentOf(a, ss);
      await b.query("begin"); await edit(ss);
      p = settle(a.query(backfillSql, [ss.id, JSON.stringify(tok), JSON.stringify(content)]));
      ok(await waiting(watcher, a.pid), `the backfill waits on ${label}`);
      await b.query("commit");
      const r = await p;
      ok(!r.ok && r.err.detail === "changed" && !(await pubRow(a, ss.id)), `…and refuses once ${label} commits`);
    }

    // publish_packet holds the lock: the backfill waits, then finds the publication.
    ss = await prePublished(a, { snapshot: {} });
    let tok = await token(a, ss.id), content = await contentOf(a, ss);
    await b.query("begin");
    await b.query("select public.publish_packet($1, $2, public.packet_publish_token($1, $2), 1::smallint, $3, '{}')", [ss.owner, ss.id, JSON.stringify({ ...content, clientTitle: "From publish" })]);
    p = settle(a.query(backfillSql, [ss.id, JSON.stringify(tok), JSON.stringify(content)]));
    ok(await waiting(watcher, a.pid), "the backfill waits on an uncommitted publish_packet");
    await b.query("commit");
    let r = await p;
    ok(!r.ok && r.err.detail === "publication_exists" && (await pubRow(a, ss.id)).content.clientTitle === "From publish", "…and refuses: the publish's copy stands");

    // The backfill holds the lock: publish_packet waits, then republishes over it.
    ss = await prePublished(a, { snapshot: {} });
    await a.query("begin");
    await a.query(backfillSql, [ss.id, JSON.stringify(await token(a, ss.id)), JSON.stringify(await contentOf(a, ss))]);
    const pubTok = await publishToken(b, ss);
    p = settle(b.query("select public.publish_packet($1, $2, $3, 1::smallint, $4, '{}')", [ss.owner, ss.id, JSON.stringify(pubTok), JSON.stringify({ ...(await contentOf(b, ss)), clientTitle: "Republished" })]));
    ok(await waiting(watcher, b.pid), "publish_packet waits on an uncommitted backfill");
    await a.query("commit");
    r = await p;
    ok(r.ok && (await pubRow(a, ss.id)).content.clientTitle === "Republished", "…then republishes over the backfilled copy (publish stays authoritative)");

    // unpublish_packet holds the lock: the backfill waits, then refuses.
    ss = await prePublished(a, { snapshot: {} });
    tok = await token(a, ss.id); content = await contentOf(a, ss);
    await b.query("begin"); await b.query("select public.unpublish_packet($1, $2)", [ss.owner, ss.id]);
    p = settle(a.query(backfillSql, [ss.id, JSON.stringify(tok), JSON.stringify(content)]));
    ok(await waiting(watcher, a.pid), "the backfill waits on an uncommitted unpublish");
    await b.query("commit");
    r = await p;
    ok(!r.ok && r.err.detail === "not_published" && !(await pubRow(a, ss.id)), "…and refuses: the Sendset is a draft");

    // Two backfills of the same Sendset: one row.
    ss = await prePublished(a, { snapshot: {} });
    tok = await token(a, ss.id); content = await contentOf(a, ss);
    await a.query("begin"); await a.query(backfillSql, [ss.id, JSON.stringify(tok), JSON.stringify(content)]);
    p = settle(b.query(backfillSql, [ss.id, JSON.stringify(tok), JSON.stringify({ ...content, clientTitle: "second" })]));
    ok(await waiting(watcher, b.pid), "a second backfill waits on the first");
    await a.query("commit");
    r = await p;
    ok(!r.ok && r.err.detail === "publication_exists" && (await pubRow(a, ss.id)).content.clientTitle === "For you", "…and refuses: exactly one row, the first");
  } finally { await watcher.end(); }
});

// ===========================================================================
console.log("\n== 7. Rerun, rollback, re-apply, preconditions");
await withDb("t54_rollback", async (c) => {
  const twice = await attempt(c, MIGRATION);
  ok(!twice.ok && /MIGRATION 0054 ABORTED/.test(twice.err.message), "0054 refuses to run twice");
  const ss = await prePublished(c, { snapshot: {} });
  await backfill(c, ss.id, { content: await contentOf(c, ss) });
  const all = async () => (await c.query("select (select string_agg(md5(row(x.*)::text), ',' order by packet_id) from public.packet_publications x) as pubs, (select string_agg(md5(row(p.*)::text), ',' order by id) from public.packets p) as pks")).rows[0];
  const before = await all();
  const down = await attempt(c, ROLLBACK);
  ok(down.ok && JSON.stringify(await all()) === JSON.stringify(before), "rollback drops the functions and touches no row (the backfilled publication survives)");
  ok((await c.query("select to_regprocedure('public.backfill_packet_publication(uuid,jsonb,smallint,jsonb)') as a, to_regprocedure('public.packet_backfill_token(uuid)') as b")).rows.every((r) => r.a === null && r.b === null), "both functions are gone");
  const re = await attempt(c, MIGRATION);
  ok(re.ok, `0054 re-applies after rollback, its proof included${re.ok ? "" : ` — ${re.err.message}`}`);
});
await withDb("t54_pre_door", async (c) => {
  await c.query("drop trigger trg_packet_status_single_door on public.packets");
  const r = await attempt(c, MIGRATION);
  ok(!r.ok && /0053/.test(r.err.message), "0054 refuses to install without 0053's door");
}, { apply: false });
await withDb("t54_pre_publish", async (c) => {
  await c.query("drop function public.publish_packet(uuid, uuid, jsonb, smallint, jsonb, jsonb)");
  const r = await attempt(c, MIGRATION);
  ok(!r.ok && /publish_packet/.test(r.err.message), "0054 refuses to install without publish_packet to copy its rules from");
}, { apply: false });

// ===========================================================================
console.log("\n== 8. Mutants: caught by the migration itself or by a targeted check");
const onDb = async (db, fn) => { const c = await connect(db); try { return await fn(c); } finally { await c.end(); } };
const staleAccepted = (edit, opts = { snapshot: null }) => (db) => onDb(db, async (c) => {
  const ss = await prePublished(c, opts);
  const tok = await token(c, ss.id), content = await contentOf(c, ss);
  await edit(c, ss);
  return (await backfill(c, ss.id, { tok, content })).ok;
});
const BODY = (s) => s;   // readability
const MUTANTS = [
  ["no existing-publication check, upsert instead", (s) => s
      .split("  if exists (select 1 from public.packet_publications x where x.packet_id = p_packet_id) then\n    raise exception 'backfill: this Sendset already has a publication' using errcode = 'PT409', detail = 'publication_exists';\n  end if;\n").join("")
      .split("            v_pk.published_at);\n  exception when check_violation").join("            v_pk.published_at)\n    on conflict (packet_id) do update set content = excluded.content;\n  exception when check_violation")
      .split("'has_publication', exists (select 1 from public.packet_publications x where x.packet_id = p.id)").join("'has_publication', false"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: {} });
      await publish(c, ss, await contentOf(c, ss));
      const before = (await pubRow(c, ss.id)).m;
      await backfill(c, ss.id, { content: { ...(await contentOf(c, ss)), clientTitle: "overwritten" } });
      return (await pubRow(c, ss.id)).m !== before;
    })],
  ["no token comparison", (s) => s.split("  if v_token is distinct from p_expected_token then\n    raise exception 'backfill: this Sendset changed after the copy was built'").join("  if false then\n    raise exception 'backfill: this Sendset changed after the copy was built'"),
    staleAccepted((c, ss) => c.query("update public.items set title = 'edited' where section_id in (select id from public.sections where packet_id = $1)", [ss.id]))],
  ["token omits the identity snapshot", (s) => s.split("    'professional_snapshot', p.professional_snapshot,\n").join(""),
    staleAccepted((c, ss) => c.query("update public.packets set professional_snapshot = '{\"name\":\"Other\"}' where id = $1", [ss.id]), { snapshot: {} })],
  ["token omits the live profile's identity_rev", (s) => s.split("    'identity_rev', case when coalesce(jsonb_typeof(p.professional_snapshot), 'null') = 'null'\n                         then (select f.identity_rev from public.professional_profiles f where f.user_id = p.user_id) end,\n").join(""),
    staleAccepted((c, ss) => c.query("update public.professional_profiles set footer_label = 'x' where user_id = $1", [ss.owner]))],
  ["token treats JSON null as a stored card", (s) => s.split("coalesce(jsonb_typeof(p.professional_snapshot), 'null') = 'null'").join("p.professional_snapshot is null"),
    staleAccepted((c, ss) => c.query("update public.professional_profiles set footer_label = 'x' where user_id = $1", [ss.owner]), { snapshot: "json-null" })],
  ["token omits published_at", (s) => s.split("    'published_at', extract(epoch from p.published_at)::text,\n").join(""),
    staleAccepted((c, ss) => c.query("update public.packets set published_at = now() where id = $1", [ss.id]))],
  ["published_at = now()", (s) => s.split("                 then (v_token ->> 'identity_rev')::bigint end,\n            v_pk.published_at);").join("                 then (v_token ->> 'identity_rev')::bigint end,\n            now());"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: {} });
      await backfill(c, ss.id, { content: await contentOf(c, ss) });
      return !(await c.query("select x.published_at = p.published_at as same from public.packet_publications x join public.packets p on p.id = x.packet_id where p.id = $1", [ss.id])).rows[0].same;
    })],
  ["no status check", (s) => s.split("  if v_pk.status is distinct from 'published' or v_pk.published_at is null then").join("  if v_pk.published_at is null then"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: {} });
      await c.query("select public.unpublish_packet($1, $2)", [ss.owner, ss.id]);
      await c.query("update public.packets set published_at = now() where id = $1", [ss.id]);
      return (await backfill(c, ss.id, { content: await contentOf(c, ss) })).ok;
    })],
  ["touches the Sendset row", (s) => s.split("  -- The digest of the STORED jsonb").join("  update public.packets set professional_snapshot = coalesce(professional_snapshot, '{}') where id = p_packet_id;\n  -- The digest of the STORED jsonb"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: null });
      const before = await packetRow(c, ss.id);
      await backfill(c, ss.id, { content: await contentOf(c, ss) });
      return (await packetRow(c, ss.id)) !== before;
    })],
  ["writes a status", (s) => s.split("  -- The digest of the STORED jsonb").join("  perform set_config('app.publication_authorized_packet', p_packet_id::text, true);\n  update public.packets set status = 'draft' where id = p_packet_id;\n  perform set_config('app.publication_authorized_packet', '', true);\n  -- The digest of the STORED jsonb"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: {} });
      await backfill(c, ss.id, { content: await contentOf(c, ss) });
      return (await c.query("select status from public.packets where id = $1", [ss.id])).rows[0].status !== "published";
    })],
  ["records the profile revision for a stored card", (s) => s.split("case when v_dep = 'account_profile' and (v_token ->> 'identity_from_profile')::boolean\n                 then (v_token ->> 'identity_rev')::bigint end").join("case when v_dep = 'account_profile' then (select f.identity_rev from public.professional_profiles f join public.packets p on p.user_id = f.user_id where p.id = p_packet_id) end"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: { name: "Frozen" } });
      await backfill(c, ss.id, { content: await contentOf(c, ss) });
      return (await pubRow(c, ss.id)).source_identity_rev !== null;
    })],
  ["dependency not from identity_mode", (s) => s.split("v_dep := case when v_pk.identity_mode = 'default' then 'account_profile' else 'sendset' end;").join("v_dep := 'account_profile';"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: {}, mode: "none" });
      await backfill(c, ss.id, { content: await contentOf(c, ss) });
      return (await pubRow(c, ss.id)).identity_dependency !== "sendset";
    })],
  ["foreign-id validation dropped", (s) => s.split("  if v_foreign > 0 then\n    raise exception 'backfill: the snapshot names").join("  if false then\n    raise exception 'backfill: the snapshot names"), null],
  ["slug validation dropped", (s) => s.split("or p_content ->> 'slug' is distinct from v_pk.slug then\n    raise exception 'backfill:").join("then\n    raise exception 'backfill:"), null],
  ["executable by authenticated", (s) => s.split("grant execute on function public.backfill_packet_publication(uuid, jsonb, smallint, jsonb) to service_role;").join("grant execute on function public.backfill_packet_publication(uuid, jsonb, smallint, jsonb) to service_role, authenticated;"), null],
  ["SECURITY INVOKER backfill", (s) => s.split(") returns jsonb\nlanguage plpgsql security definer set search_path = '' as $$\ndeclare\n  v_pk record; v_token jsonb;").join(") returns jsonb\nlanguage plpgsql security invoker set search_path = '' as $$\ndeclare\n  v_pk record; v_token jsonb;"), null],
  ["CHECK violation not mapped", (s) => s.split("  exception when check_violation then\n    raise exception 'backfill: the snapshot is not recipient-safe").join("  exception when division_by_zero then\n    raise exception 'backfill: the snapshot is not recipient-safe"),
    (db) => onDb(db, async (c) => {
      const ss = await prePublished(c, { snapshot: {} });
      const r = await backfill(c, ss.id, { content: { ...(await contentOf(c, ss)), title: "internal" } });
      return !(!r.ok && r.err.detail === "invalid_snapshot");
    })],
];
for (const [name, mutate, detect] of MUTANTS) {
  const mutated = BODY(mutate(MIGRATION));
  if (mutated === MIGRATION) { ok(false, `mutant did not apply: ${name}`); continue; }
  const db = await freshDb("t54_mutant", { apply: false });
  const r = await onDb(db, (c) => attempt(c, mutated));
  if (!r.ok) { ok(true, `mutant caught by the migration: ${name} — ${r.err.message.slice(0, 90)}`); continue; }
  const seen = detect ? await detect(db) : false;
  ok(seen, `mutant caught by the harness: ${name}${seen ? "" : " (NOT CAUGHT)"}`);
}

for (const name of created) await admin.query(`drop database if exists "${name}"`);
await admin.end();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
