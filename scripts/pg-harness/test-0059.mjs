// 0059 against real PostgreSQL 17: item actions held by a capability. What the
// migration's own proof cannot cover, because a migration may not publish a
// Sendset: minting on a first action, a capability seeing only its own lines,
// per-line staleness across a Republish, a removed item refusing new actions
// while remaining withdrawable, both publication shapes, the limits that are
// exact and the ones that are not, the counters that are counters rather than
// logs, correspondence carrying on unchanged beside it, the rollback, and
// mutants of the migration.
//
// Local harness only (README.md). Connects to the Unix socket in $PGHARNESS_DIR.
//
//   scripts/pg-harness/harness.sh replay pre0059 0058
//   node scripts/pg-harness/test-0059.mjs [path/to/0059.sql]
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0059_sendset_item_actions.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0059_sendset_item_actions_down.sql"), "utf8");
const TEMPLATE = "pre0059";
const OWNER = "00000000-0000-4000-8000-000000000001";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const connect = async (database) => {
  const c = new pg.Client({ host: SOCKET, port: PORT, user: "postgres", database });
  await c.connect();
  c.pid = (await c.query("select pg_backend_pid() as p")).rows[0].p;
  return c;
};
const attempt = async (c, sql, args) => {
  try { return { ok: true, res: await c.query(sql, args) }; }
  catch (err) { try { await c.query("rollback"); } catch { /* not in a transaction */ } return { ok: false, err }; }
};
const admin = await connect("postgres");
const created = new Set();
async function freshDb(name, { sql = MIGRATION } = {}) {
  await admin.query(`drop database if exists "${name}"`);
  await admin.query(`create database "${name}" template "${TEMPLATE}"`);
  created.add(name);
  if (sql !== null) { const c = await connect(name); await c.query(sql); await c.end(); }
  return name;
}
async function waitingOnLock(watcher, pid, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { rows } = await watcher.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

// --- a Sendset, its publication, and the capability helpers ------------------
async function sendset(c) {
  const { rows: [p] } = await c.query(
    `insert into public.packets (user_id, slug, title)
     values ($1, 'a-' || substr(md5(random()::text), 1, 12), 'T') returning id, slug`, [OWNER]);
  const { rows: [s] } = await c.query(`insert into public.sections (packet_id, title) values ($1, 'S') returning id`, [p.id]);
  const { rows: [i1] } = await c.query(`insert into public.items (section_id, title) values ($1, 'Harbor House') returning id`, [s.id]);
  const { rows: [i2] } = await c.query(`insert into public.items (section_id, title) values ($1, 'The Loft') returning id`, [s.id]);
  return { id: p.id, slug: p.slug, sectionId: s.id, itemA: i1.id, itemB: i2.id, owner: OWNER };
}
const token = async (c, ss) => (await c.query("select public.packet_publish_token($1, $2) as t", [ss.owner, ss.id])).rows[0].t;
/** The legacy snapshot shape: sections of items. `items` decides what is in it. */
const legacySnapshot = (ss, items) => ({
  slug: ss.slug, clientTitle: "", clientName: "", professional: { name: "" },
  sections: [{ id: ss.sectionId, title: "S", items }],
});
/** The block snapshot shape: an ordered body, an item nested inside its block. */
async function blockSnapshot(c, ss, items) {
  // THROUGH THE PRODUCT'S OWN DOOR: 0053 refuses a direct composition_mode
  // write, and publish_packet (0052) refuses a snapshot naming block or item
  // ids that are not this Sendset's. So the Sendset is really converted, and
  // the snapshot really names its blocks.
  await c.query("select public.convert_packet_to_blocks($1)", [ss.id]);
  const { rows } = await c.query(
    "select id, item_id from public.packet_blocks where packet_id = $1 and block_type = 'item' order by position", [ss.id]);
  const blocks = [];
  for (const it of items) {
    const b = rows.find((x) => x.item_id === it.id);
    if (!b) throw new Error(`no block for item ${it.id}`);
    blocks.push({ id: b.id, kind: "item", item: it });
  }
  return {
    slug: ss.slug, clientTitle: "", clientName: "", compositionMode: "blocks", professional: { name: "" },
    sections: [], blocks,
  };
}
const publish = async (c, ss, content) => c.query(
  "select public.publish_packet($1, $2, $3, $4::smallint, $5, $6)",
  [ss.owner, ss.id, JSON.stringify(await token(c, ss)), 1, JSON.stringify(content), JSON.stringify({})]);
const unpublish = (c, ss) => c.query("select public.unpublish_packet($1, $2)", [ss.owner, ss.id]);
const accept = (c, ss, actions) => c.query("update public.packets set response_actions = $2 where id = $1", [ss.id, actions]);

/** THE MARKER, AS THE PAGE WOULD RENDER IT: PostgREST's JSON text, never a Date. */
const marker = async (c, ss) => (await c.query(
  "select to_json(published_at) #>> '{}' as m from public.packet_publications where packet_id = $1", [ss.id])).rows[0]?.m;

const cap = () => randomBytes(32);
const setAction = (c, slug, m, hash, itemId, o = {}) =>
  c.query("select public.set_sendset_item_action($1, $2, $3, $4, $5, $6, $7) as r",
    [slug, m, hash, o.name ?? "Lisa", o.contact ?? null, itemId, o.action ?? "like"]);
const trySet = (c, slug, m, hash, itemId, o = {}) =>
  attempt(c, "select public.set_sendset_item_action($1, $2, $3, $4, $5, $6, $7) as r",
    [slug, m, hash, o.name === undefined ? "Lisa" : o.name, o.contact ?? null, itemId, o.action ?? "like"]);
const clearAction = (c, slug, hash, itemId, action = "like") =>
  c.query("select public.clear_sendset_item_action($1, $2, $3, $4) as r", [slug, hash, itemId, action]);
const tryClear = (c, slug, hash, itemId, action = "like") =>
  attempt(c, "select public.clear_sendset_item_action($1, $2, $3, $4) as r", [slug, hash, itemId, action]);
const readActions = async (c, slug, hash) =>
  (await c.query("select public.read_sendset_session_actions($1, $2) as r", [slug, hash])).rows[0].r;
const refusedWith = (r, code, detail) => !r.ok && r.err.code === code && r.err.detail === detail;
const countRows = async (c, table, where = "true", args = []) =>
  (await c.query(`select count(*)::int as n from public.${table} where ${where}`, args)).rows[0].n;

// ---------------------------------------------------------------------------
async function main() {
  // --- REFUSALS THAT REVEAL NOTHING, AND VALIDATION BEFORE LOOKUP ------------
  {
    const db = await freshDb("r59_refuse");
    const c = await connect(db);
    const ss = await sendset(c);
    const GOOD = "2026-09-17T10:00:00.123456+00:00";
    const h = cap();

    ok(refusedWith(await trySet(c, ss.slug, GOOD, h, ss.itemA), "PT404", "not_accepting"), "a draft is refused");
    await accept(c, ss, ["like"]);
    ok(refusedWith(await trySet(c, ss.slug, GOOD, h, ss.itemA), "PT404", "not_accepting"), "a DRAFT that accepts Like is still refused");
    await accept(c, ss, []);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    ok(refusedWith(await trySet(c, ss.slug, await marker(c, ss), h, ss.itemA), "PT404", "not_accepting"),
      "a published Sendset with Like OFF is refused");
    await accept(c, ss, ["respond"]);
    ok(refusedWith(await trySet(c, ss.slug, await marker(c, ss), h, ss.itemA), "PT404", "not_accepting"),
      "a Sendset that accepts only Respond is refused");
    ok(refusedWith(await trySet(c, "no-such-slug-ever", GOOD, h, ss.itemA), "PT404", "not_accepting"),
      "an unknown slug is refused with the SAME detail");

    // EVERY SHAPE CHECK PRECEDES THE LOOKUP: each is asked about a slug that
    // does not exist, and each still answers about the argument.
    ok(refusedWith(await trySet(c, "no-such-slug-ever", "yesterday", h, ss.itemA), "PT400", "marker_invalid"),
      "a malformed marker is refused before any lookup");
    ok(refusedWith(await trySet(c, "no-such-slug-ever", GOOD, randomBytes(16), ss.itemA), "PT400", "session_invalid"),
      "a capability that is not 256 bits is refused before any lookup");
    ok(refusedWith(await trySet(c, "no-such-slug-ever", GOOD, h, ss.itemA, { name: "  " }), "PT400", "name_required"),
      "a missing name is refused before any lookup — so it cannot tell a prober the slug exists");
    ok(refusedWith(await trySet(c, "no-such-slug-ever", GOOD, h, ss.itemA, { action: "approve" }), "PT400", "action_invalid"),
      "an unknown action is refused before any lookup");
    ok(refusedWith(await trySet(c, "no-such-slug-ever", GOOD, h, null), "PT400", "target_invalid"),
      "a missing target is refused before any lookup");

    await accept(c, ss, ["like"]);
    const m = await marker(c, ss);
    await unpublish(c, ss);
    ok(refusedWith(await trySet(c, ss.slug, m, h, ss.itemA), "PT404", "not_accepting"), "an unpublished Sendset is refused");
    ok(await countRows(c, "sendset_responses") === 0 && await countRows(c, "sendset_action_rate") === 0,
      "no refusal stored anything, not even a counter");
    await c.end();
  }

  // --- THE CAPABILITY HOLDS ONE SUBMISSION, AND SEES ONLY ITS OWN ------------
  {
    const db = await freshDb("r59_capability");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }, { id: ss.itemB, title: "The Loft" }]));
    await accept(c, ss, ["like"]);
    const m = await marker(c, ss);
    const lisa = cap(), mark = cap();

    const first = (await setAction(c, ss.slug, m, lisa, ss.itemA)).rows[0].r;
    ok(first.created === true && first.label === "Harbor House" && first.wasCurrent === true,
      "the first action mints the capability's submission and freezes the published label");
    const second = (await setAction(c, ss.slug, m, lisa, ss.itemB, { name: "Lisa" })).rows[0].r;
    ok(second.created === false && second.responseId === first.responseId,
      "a second action reuses the same submission");
    ok(await countRows(c, "sendset_responses") === 1 && await countRows(c, "sendset_response_lines") === 1 + 1,
      "one submission, one line per hearted item");

    const { rows: [row] } = await c.query("select * from public.sendset_responses");
    ok(row.kind === "actions" && row.session_hash.equals(lisa) && row.responder_name === "Lisa",
      "the submission is an action session holding the capability's hash");
    ok(row.live_publication_published_at === null && row.rendered_publication_was_current === null
       && row.notification_due === false && row.notified_at === null,
      "it carries no submission-level marker and is never due a notification");

    // Somebody else, same Sendset, same item.
    await setAction(c, ss.slug, m, mark, ss.itemA, { name: "Mark" });
    ok(await countRows(c, "sendset_responses") === 2, "a second capability is a second submission, not a merge");

    const mine = await readActions(c, ss.slug, lisa);
    ok(mine.signature.name === "Lisa" && mine.actions.length === 2, "a capability reads its own two actions");
    ok(mine.actions.every((a) => a.inCurrent === true && a.wasCurrent === true), "both are current");
    ok(!("contact" in mine.signature), "the read never hands back a contact detail");
    const theirs = await readActions(c, ss.slug, mark);
    ok(theirs.actions.length === 1 && theirs.signature.name === "Mark", "and only its own");
    const empty = (r) => r !== null && r.signature === null && Array.isArray(r.actions) && r.actions.length === 0;
    ok(empty(await readActions(c, ss.slug, cap())), "an unknown capability reads empty");
    ok(empty(await readActions(c, "no-such-slug-ever", lisa)), "and an unknown slug answers identically");
    ok(empty(await readActions(c, ss.slug, randomBytes(8))), "a malformed capability is answered, not raised at");

    // Re-hearting is idempotent, not a second line.
    await setAction(c, ss.slug, m, lisa, ss.itemA);
    ok(await countRows(c, "sendset_response_lines", "response_id = $1", [first.responseId]) === 2,
      "re-setting an action already held creates no second line");

    // A SIGNATURE IS NOT REWRITABLE by a later call from the same browser.
    await setAction(c, ss.slug, m, lisa, ss.itemA, { name: "Somebody Else", contact: "x@example.invalid" });
    const { rows: [after] } = await c.query("select responder_name, responder_contact from public.sendset_responses where id = $1", [first.responseId]);
    ok(after.responder_name === "Lisa" && after.responder_contact === null,
      "a later call cannot rename the submission or add a contact to it");

    // updated_at moves on an addition AND on a withdrawal; created_at does not.
    const before = (await c.query("select created_at, updated_at from public.sendset_responses where id = $1", [first.responseId])).rows[0];
    await new Promise((r) => setTimeout(r, 10));
    const cleared = (await clearAction(c, ss.slug, lisa, ss.itemB)).rows[0].r;
    const afterClear = (await c.query("select created_at, updated_at from public.sendset_responses where id = $1", [first.responseId])).rows[0];
    ok(cleared.removed === true, "a withdrawal removes the line");
    ok(afterClear.updated_at > before.updated_at && String(afterClear.created_at) === String(before.created_at),
      "and moves updated_at without touching created_at");
    ok((await readActions(c, ss.slug, lisa)).actions.length === 1, "the withdrawn action is gone from the capability's own view");

    // CLEARING SOMEBODY ELSE'S LINE IS UNADDRESSABLE, not merely refused.
    const theirLine = await countRows(c, "sendset_response_lines", "response_id <> $1", [first.responseId]);
    const r = (await clearAction(c, ss.slug, lisa, ss.itemA)).rows[0].r;   // Lisa's own
    ok(r.removed === true, "a capability may withdraw its own line");
    ok(await countRows(c, "sendset_response_lines", "response_id <> $1", [first.responseId]) === theirLine,
      "and the other capability's line for the same item is untouched");
    ok((await clearAction(c, ss.slug, cap(), ss.itemA)).rows[0].r.removed === false,
      "an unknown capability withdraws nothing, and is not told anything");
    await c.end();
  }

  // --- PER-LINE STALENESS, ACROSS A REPUBLISH -------------------------------
  {
    const db = await freshDb("r59_staleness");
    const c = await connect(db);
    const ss = await sendset(c);
    const items = [{ id: ss.itemA, title: "Harbor House" }, { id: ss.itemB, title: "The Loft" }];
    await publish(c, ss, legacySnapshot(ss, items));
    await accept(c, ss, ["like"]);
    const m1 = await marker(c, ss);
    const h = cap();

    await setAction(c, ss.slug, m1, h, ss.itemA);
    const stale = (await setAction(c, ss.slug, "2020-01-01T00:00:00Z", h, ss.itemB)).rows[0].r;
    ok(stale.wasCurrent === false, "a heart from a stale page is ACCEPTED and recorded as not current");

    const lines = () => c.query(`select l.target_item_id, l.target_label, l.rendered_publication_was_current as cur,
                                        to_json(l.live_publication_published_at) #>> '{}' as m
                                   from public.sendset_response_lines l order by l.target_label`);
    const before = (await lines()).rows;
    ok(before.every((l) => l.m === m1), "both lines carry the publication that was live when they were written");

    // A Republish: a new publication, and a new marker.
    await publish(c, ss, legacySnapshot(ss, items));
    const m2 = await marker(c, ss);
    ok(m2 !== m1, "the Republish moved the marker");
    await setAction(c, ss.slug, m2, h, ss.itemB);
    const after = (await lines()).rows;
    const a = after.find((l) => l.target_item_id === ss.itemA), b = after.find((l) => l.target_item_id === ss.itemB);
    ok(a.m === m1 && b.m === m2,
      "the OLD line keeps its own marker and the new one carries the new publication — staleness is per line");
    ok(b.cur === true, "and the refreshed line is current again");

    // THE JAVASCRIPT DATE HAZARD, on the line's own marker.
    const viaDate = new Date(m2).toISOString();
    ok(viaDate !== m2, `the marker loses precision through a JS Date (${m2} -> ${viaDate})`);
    const r = (await setAction(c, ss.slug, viaDate, h, ss.itemA)).rows[0].r;
    ok(r.wasCurrent === false, "a marker passed through a Date no longer matches — which is why it never is");
    await c.end();
  }

  // --- AN ITEM REMOVED BY A REPUBLISH ---------------------------------------
  {
    const db = await freshDb("r59_removed");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }, { id: ss.itemB, title: "The Loft" }]));
    await accept(c, ss, ["like"]);
    const h = cap();
    const m1 = await marker(c, ss);
    await setAction(c, ss.slug, m1, h, ss.itemA);
    await setAction(c, ss.slug, m1, h, ss.itemB);

    // The Loft is gone from the Sendset.
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House renamed" }]));
    const m2 = await marker(c, ss);

    ok(refusedWith(await trySet(c, ss.slug, m2, h, ss.itemB), "PT409", "target_absent"),
      "a NEW action on a removed item is refused");
    ok(await countRows(c, "sendset_response_lines", "target_item_id = $1", [ss.itemB]) === 1,
      "and the line they already had is still there");

    const mine = await readActions(c, ss.slug, h);
    const gone = mine.actions.find((x) => x.itemId === ss.itemB);
    const here = mine.actions.find((x) => x.itemId === ss.itemA);
    ok(gone && gone.inCurrent === false && gone.label === "The Loft",
      "the responder still sees it, labelled from the frozen tombstone");
    ok(here.inCurrent === true && here.label === "Harbor House renamed",
      "while a surviving item shows its CURRENT title, not the frozen one");

    // THE WHOLE POINT: acting on something else does not disturb it.
    await setAction(c, ss.slug, m2, h, ss.itemA);
    ok(await countRows(c, "sendset_response_lines", "target_item_id = $1", [ss.itemB]) === 1,
      "hearting another item did not silently erase the tombstoned line");

    // A deliberate withdrawal is still allowed.
    ok((await clearAction(c, ss.slug, h, ss.itemB)).rows[0].r.removed === true,
      "the responder may withdraw an action on a removed item");
    ok(await countRows(c, "sendset_response_lines", "target_item_id = $1", [ss.itemB]) === 0, "and it is gone");

    // Deleting the item itself cannot take a line with it.
    await setAction(c, ss.slug, m2, h, ss.itemA);
    await c.query("delete from public.items where id = $1", [ss.itemA]);
    ok(await countRows(c, "sendset_response_lines", "target_item_id = $1", [ss.itemA]) === 1,
      "deleting the item row leaves the line standing — there is no foreign key to cascade");
    await c.end();
  }

  // --- LIKE SWITCHED OFF: NEW EXPRESSION STOPS, WITHDRAWAL DOES NOT ---------
  {
    const db = await freshDb("r59_like_off");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }, { id: ss.itemB, title: "The Loft" }]));
    await accept(c, ss, ["like"]);
    const m1 = await marker(c, ss);
    const h = cap(), stranger = cap();
    await setAction(c, ss.slug, m1, h, ss.itemA);
    await setAction(c, ss.slug, m1, h, ss.itemB);

    // The Loft leaves the Sendset, and then the creator switches Like off.
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    const m2 = await marker(c, ss);
    await accept(c, ss, ["respond"]);

    // NOTHING NEW.
    ok(refusedWith(await trySet(c, ss.slug, m2, h, ss.itemA), "PT404", "not_accepting"),
      "with Like off, an existing capability cannot set a new action");
    ok(refusedWith(await trySet(c, ss.slug, m2, stranger, ss.itemA), "PT404", "not_accepting"),
      "and no new capability can be minted");
    ok(await countRows(c, "sendset_responses") === 1, "so no submission was created by either attempt");

    // WHAT THEY ALREADY SAID IS STILL THEIRS.
    const mine = await readActions(c, ss.slug, h);
    ok(mine.signature.name === "Lisa" && mine.actions.length === 2,
      "the capability still reads its own two likes while Like is off");
    ok(mine.actions.find((a) => a.itemId === ss.itemB).inCurrent === false,
      "including the one whose item the Sendset no longer carries");

    // AND THEY MAY TAKE IT BACK — including the one with no item left.
    ok((await clearAction(c, ss.slug, h, ss.itemB)).rows[0].r.removed === true,
      "a like on a removed item can still be withdrawn while Like is off");
    ok((await clearAction(c, ss.slug, h, ss.itemA)).rows[0].r.removed === true,
      "and so can one whose item is still there");
    ok((await readActions(c, ss.slug, h)).actions.length === 0, "both are gone from their own view");

    // BUT THEY CANNOT PUT IT BACK.
    ok(refusedWith(await trySet(c, ss.slug, m2, h, ss.itemA), "PT404", "not_accepting"),
      "a withdrawn like cannot be re-added while Like is off");

    // A browser holding nothing is still told nothing, and still creates nothing.
    const isEmpty = (r) => r !== null && r.signature === null && Array.isArray(r.actions) && r.actions.length === 0;
    ok(isEmpty(await readActions(c, ss.slug, stranger)), "an unknown capability reads empty, as always");
    ok((await clearAction(c, ss.slug, stranger, ss.itemA)).rows[0].r.removed === false, "and withdraws nothing");
    ok(await countRows(c, "sendset_responses") === 1 && await countRows(c, "sendset_response_lines") === 0,
      "no capability was minted by reading or withdrawing");

    // An unpublished Sendset is a different matter: there is no page at all.
    await unpublish(c, ss);
    ok(isEmpty(await readActions(c, ss.slug, h)), "an unpublished Sendset reads empty");
    ok(refusedWith(await tryClear(c, ss.slug, h, ss.itemA), "PT404", "not_accepting"),
      "and refuses a withdrawal with the answer everything else gets");

    // Switching Like back on restores new expression.
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    await accept(c, ss, ["like"]);
    ok((await trySet(c, ss.slug, await marker(c, ss), h, ss.itemA)).ok,
      "and with Like switched back on, the same capability can act again");
    await c.end();
  }

  // --- BOTH PUBLICATION SHAPES ----------------------------------------------
  {
    const db = await freshDb("r59_shapes");
    const c = await connect(db);
    const ss = await sendset(c);
    const blockItem = { id: ss.itemA, title: "The Foundry at Mill Street" };
    await publish(c, ss, await blockSnapshot(c, ss, [blockItem]));
    await accept(c, ss, ["like"]);
    const m = await marker(c, ss);
    const h = cap();
    const r = (await setAction(c, ss.slug, m, h, ss.itemA)).rows[0].r;
    ok(r.created === true && r.label === "The Foundry at Mill Street",
      "an item nested in a BLOCK publication is found, and its label frozen");
    ok(refusedWith(await trySet(c, ss.slug, m, h, ss.itemB), "PT409", "target_absent"),
      "an item that is in no block is refused");
    ok((await readActions(c, ss.slug, h)).actions[0].inCurrent === true, "and reads back as present");
    await c.end();
  }

  // --- LIMITS, AND WHAT IS EXACT ABOUT THEM ---------------------------------
  {
    const db = await freshDb("r59_limits");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    await accept(c, ss, ["like"]);
    const m = await marker(c, ss);

    // MINTING is counted from the durable rows it creates — no counter needed.
    await c.query(`insert into public.sendset_responses
                     (packet_id, owner_user_id, kind, session_hash, responder_name, notification_due, updated_at)
                   select $1, $2, 'actions', decode(md5(random()::text) || md5(random()::text), 'hex'), 'Filler', false, now() from generate_series(1, 200)`,
      [ss.id, ss.owner]);
    ok(refusedWith(await trySet(c, ss.slug, m, cap(), ss.itemA), "PT429", "rate_limited"),
      "the 201st capability on one Sendset in an hour is refused");
    await c.query("update public.sendset_responses set created_at = now() - interval '61 minutes' where responder_name = 'Filler'");
    const minted = await trySet(c, ss.slug, m, cap(), ss.itemA);
    ok(minted.ok, "and allowed again once that hour has passed");

    // MUTATIONS are counted by two overwritten counters.
    const h = cap();
    await setAction(c, ss.slug, m, h, ss.itemA);
    ok(await countRows(c, "sendset_action_rate", "packet_id = $1", [ss.id]) === 1,
      "the Sendset has exactly ONE counter row");
    for (let i = 0; i < 5; i++) await setAction(c, ss.slug, m, h, ss.itemA);
    ok(await countRows(c, "sendset_action_rate", "packet_id = $1", [ss.id]) === 1,
      "and still exactly one after six mutations — a counter, not a log");
    ok(await countRows(c, "sendset_response_lines", "response_id = (select id from public.sendset_responses where session_hash = $1)", [h]) === 1,
      "six mutations left one line: nothing records that anything happened six times");

    await c.query("update public.sendset_responses set mutations_in_window = 100, mutation_window_start = now() where session_hash = $1", [h]);
    ok(refusedWith(await trySet(c, ss.slug, m, h, ss.itemA), "PT429", "rate_limited"), "a capability's own hourly ceiling");
    ok(refusedWith(await tryClear(c, ss.slug, h, ss.itemA), "PT429", "rate_limited"), "which a withdrawal shares");
    await c.query("update public.sendset_responses set mutation_window_start = now() - interval '61 minutes' where session_hash = $1", [h]);
    ok((await trySet(c, ss.slug, m, h, ss.itemA)).ok, "the window rolls");
    const reset = (await c.query("select mutations_in_window from public.sendset_responses where session_hash = $1", [h])).rows[0];
    ok(reset.mutations_in_window === 1, "and the counter is OVERWRITTEN, not appended to");

    // Per Sendset, and the global ceiling derived from the same rows.
    await c.query("update public.sendset_action_rate set mutations = 2000, window_start = now() where packet_id = $1", [ss.id]);
    ok(refusedWith(await trySet(c, ss.slug, m, h, ss.itemA), "PT429", "rate_limited"), "the Sendset's hourly ceiling");
    await c.query("update public.sendset_action_rate set mutations = 0 where packet_id = $1", [ss.id]);

    const other = await sendset(c);
    await c.query("insert into public.sendset_action_rate (packet_id, window_start, mutations) values ($1, now(), 10000)", [other.id]);
    ok(refusedWith(await trySet(c, ss.slug, m, h, ss.itemA), "PT429", "rate_limited"),
      "the global ceiling is the sum of those same counters — no separate hot row");
    await c.query("update public.sendset_action_rate set window_start = now() - interval '61 minutes' where packet_id = $1", [other.id]);
    ok((await trySet(c, ss.slug, m, h, ss.itemA)).ok, "and an expired window stops counting toward it");

    // NOTHING ELSE IS STORED ABOUT ANY OF IT.
    const { rows: cols } = await c.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name='sendset_action_rate' order by 1`);
    ok(JSON.stringify(cols.map((x) => x.column_name)) === JSON.stringify(["mutations", "packet_id", "window_start"]),
      "the counter holds a Sendset, a window and a number — and nothing about anybody");
    await c.end();
  }

  // --- THE MINT LIMIT IS EXACT, UNDER A REAL INTERLEAVING -------------------
  {
    const db = await freshDb("r59_race");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    await accept(c, ss, ["like"]);
    const m = await marker(c, ss);
    await c.query(`insert into public.sendset_responses
                     (packet_id, owner_user_id, kind, session_hash, responder_name, notification_due, updated_at)
                   select $1, $2, 'actions', decode(md5(random()::text) || md5(random()::text), 'hex'), 'Filler', false, now() from generate_series(1, 199)`,
      [ss.id, ss.owner]);

    const a = await connect(db), b = await connect(db);
    await a.query("begin");
    await a.query("select public.set_sendset_item_action($1, $2, $3, 'A', null, $4, 'like')", [ss.slug, m, cap(), ss.itemA]);
    const pending = attempt(b, "select public.set_sendset_item_action($1, $2, $3, 'B', null, $4, 'like')", [ss.slug, m, cap(), ss.itemA]);
    ok(await waitingOnLock(c, b.pid, 2000), "a second mint WAITS on the Sendset row lock");
    await a.query("commit");
    const r = await pending;
    ok(refusedWith(r, "PT429", "rate_limited"), "and is refused once the first commits — the mint ceiling is exact");
    ok(await countRows(c, "sendset_responses", "packet_id = $1 and kind = 'actions'", [ss.id]) === 200,
      "exactly 200 capabilities exist");
    await a.end(); await b.end(); await c.end();
  }

  // --- CORRESPONDENCE CARRIES ON, BESIDE IT AND UNCHANGED -------------------
  {
    const db = await freshDb("r59_messages");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    await accept(c, ss, ["respond", "like"]);
    const m = await marker(c, ss);
    const h = cap();

    const msg = (await c.query("select public.record_sendset_response($1, $2, 'Lisa', null, 'Is Saturday still open?') as r", [ss.slug, m])).rows[0].r;
    await setAction(c, ss.slug, m, h, ss.itemA);

    const { rows } = await c.query("select kind, session_hash, notification_due, updated_at, live_publication_published_at as marker from public.sendset_responses order by kind");
    const actions = rows.find((r) => r.kind === "actions"), message = rows.find((r) => r.kind === "message");
    ok(message.session_hash === null && message.updated_at === null && message.marker !== null && message.notification_due === true,
      "the message keeps 0058's shape exactly: no capability, never updated, its own marker, due a notification");
    ok(actions.session_hash !== null && actions.updated_at !== null && actions.marker === null && actions.notification_due === false,
      "and the action session carries the other shape");

    await c.query("select public.mark_sendset_response_notified($1)", [msg.responseId]);
    ok((await c.query("select notified_at from public.sendset_responses where id = $1", [msg.responseId])).rows[0].notified_at !== null,
      "the message is still notified as before");
    await c.query("select public.mark_sendset_response_notified($1)", [actions.id ?? msg.responseId]);
    ok(await countRows(c, "sendset_responses", "kind = 'actions' and notified_at is not null") === 0,
      "and an action session can never be marked notified");

    // The message's line did not acquire item-action semantics.
    const { rows: [line] } = await c.query("select action, parent_kind, target_kind, note, live_publication_published_at as m from public.sendset_response_lines where action = 'respond'");
    ok(line.parent_kind === "message" && line.target_kind === "sendset" && line.m === null && line.note !== null,
      "the respond line is unchanged: a Sendset target, words, and no marker of its own");

    // DELETION: one number, covering both kinds, and every other path refused.
    const total = await countRows(c, "sendset_responses", "packet_id = $1", [ss.id]);
    ok(total === 2, "the Sendset holds two submissions of different kinds");
    const plain = await attempt(c, "delete from public.packets where id = $1", [ss.id]);
    ok(!plain.ok && plain.err.code === "23503", "a plain DELETE is still refused by RESTRICT");
    const wrong = await attempt(c, "select public.delete_sendset($1, $2, 1)", [ss.owner, ss.id]);
    ok(refusedWith(wrong, "PT409", "responses_changed") && wrong.err.hint === "2",
      "delete_sendset still refuses the wrong count, and reports the true one");
    await c.query("select public.delete_sendset($1, $2, $3)", [ss.owner, ss.id, total]);
    ok(await countRows(c, "sendset_responses") === 0 && await countRows(c, "sendset_response_lines") === 0
       && await countRows(c, "sendset_action_rate") === 0,
      "the acknowledged delete removes both kinds, their lines, and the counter");
    await c.end();
  }

  // --- ATOMICITY ------------------------------------------------------------
  {
    const db = await freshDb("r59_atomic");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    await accept(c, ss, ["like"]);
    const m = await marker(c, ss);
    await c.query(`create function zz_fail() returns trigger language plpgsql as $$ begin raise exception 'line insert failed'; end $$;
                   create trigger zz_fail_lines before insert on public.sendset_response_lines for each row execute function zz_fail();`);
    const r = await trySet(c, ss.slug, m, cap(), ss.itemA);
    ok(!r.ok, "with the line insert failing, the call fails");
    ok(await countRows(c, "sendset_responses") === 0,
      "and NO capability was minted — the submission and its first line are one transaction");
    await c.query("drop trigger zz_fail_lines on public.sendset_response_lines");
    await c.end();
  }

  // --- THE ROLLBACK ---------------------------------------------------------
  {
    const db = await freshDb("r59_rollback");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }]));
    await accept(c, ss, ["respond", "like"]);
    const m = await marker(c, ss);
    await c.query("select public.record_sendset_response($1, $2, 'Lisa', 'lisa@example.invalid', 'Words that must survive') as r", [ss.slug, m]);
    const digest = async () => (await c.query(`
      select md5(coalesce(string_agg(h, ',' order by h), '')) as d from (
        select md5(concat_ws('|', r.id, r.packet_id, r.owner_user_id, r.live_publication_published_at,
                             r.rendered_publication_was_current, coalesce(r.responder_name,''),
                             coalesce(r.responder_contact,''), r.notification_due, r.created_at,
                             coalesce(r.notified_at::text,''), l.action, l.note)) as h
          from public.sendset_responses r join public.sendset_response_lines l on l.response_id = r.id) s`)).rows[0].d;
    const before = await digest();

    await setAction(c, ss.slug, m, cap(), ss.itemA);
    let refused = await attempt(c, ROLLBACK);
    ok(!refused.ok && /ROLLBACK 0059 REFUSED: 1 action session/.test(refused.err.message),
      "the rollback refuses while an action session exists");
    await c.query("delete from public.sendset_responses where kind = 'actions'");
    refused = await attempt(c, ROLLBACK);
    ok(!refused.ok && /still accept item actions/.test(refused.err.message),
      "and while a Sendset still accepts Like, because 0058's CHECK could not hold it");
    await accept(c, ss, ["respond"]);

    const done = await attempt(c, ROLLBACK);
    ok(done.ok, "with neither, the rollback runs");
    ok(await digest() === before, "and the correspondence is byte-for-byte what it was");
    const { rows: [left] } = await c.query(`
      select to_regclass('public.sendset_action_rate') as t,
             to_regprocedure('public.set_sendset_item_action(text,text,bytea,text,text,uuid,text)') as f,
             (select count(*)::int from information_schema.columns
               where table_schema='public' and table_name='sendset_responses' and column_name in ('kind','session_hash','updated_at')) as cols,
             (select is_nullable from information_schema.columns
               where table_schema='public' and table_name='sendset_responses' and column_name='live_publication_published_at') as nullable`);
    ok(!left.t && !left.f && left.cols === 0 && left.nullable === "NO", "every 0059 object is gone and 0058's NOT NULL is back");
    ok((await attempt(c, "update public.packets set response_actions = '{like}' where id = $1", [ss.id])).ok === false,
      "and 'like' is no longer an accepted value");
    await c.end();
  }

  // --- MUTANTS: each must ABORT the migration, for its own reason ------------
  const aborting = [
    ["the two shapes are not constrained",
      (s) => s.replace(/  add constraint sendset_responses_shape check \([\s\S]*?and notified_at is null\)\),\n/, ""),
      /an invalid action session was accepted|a message was given a capability/],
    ["a capability may be any length",
      (s) => s.replace("check (session_hash is null or octet_length(session_hash) = 32),", "check (true),"),
      /a capability that is not 256 bits was accepted/],
    ["one capability may hold two submissions",
      (s) => s.replace(/create unique index sendset_responses_capability[\s\S]*?where session_hash is not null;/,
        "create index sendset_responses_capability on public.sendset_responses (packet_id) where session_hash is not null;"),
      /one capability holds two submissions/],
    ["a like may hang under a message",
      (s) => s.replace("check ((action = 'like') = (parent_kind = 'actions'))", "check (true)"),
      /a like was hung under a message|a respond was written into an action session/],
    ["a like may carry words and no marker",
      (s) => s.replace(/  add constraint sendset_response_lines_like_shape check \([\s\S]*?rendered_publication_was_current is not null\)\),\n/, ""),
      /an invalid like line was accepted/],
    ["a respond line may acquire a marker of its own",
      (s) => s.replace(/  add constraint sendset_response_lines_respond_shape check \([\s\S]*?rendered_publication_was_current is null\)\);/,
        "  add constraint sendset_response_lines_respond_shape check (true);"),
      /a respond line acquired item-action semantics/],
    ["the rate counter is readable by anon",
      (s) => s.replace("revoke all on public.sendset_action_rate from public, anon, authenticated, service_role;",
        "revoke all on public.sendset_action_rate from public; grant select on public.sendset_action_rate to anon;"),
      /privilege\(s\) on the rate counter/],
    ["the item-action functions are executable by anon",
      (s) => s.replace("revoke all on function public.set_sendset_item_action(text, text, bytea, text, text, uuid, text) from public, anon, authenticated;", ""),
      /function grant\(s\) held by an unprivileged role/],
    ["the rate counter blocks deleting its Sendset",
      (s) => s.replace("packet_id    uuid        primary key references public.packets(id) on delete cascade,",
        "packet_id    uuid        primary key references public.packets(id) on delete restrict,"),
      /the rate counter does not cascade with its Sendset/],
    ["the migration quietly edits an existing submission",
      (s) => s.replace("-- 2. WHAT A PUBLISHED PAGE ACCEPTS.",
        "-- 2. WHAT A PUBLISHED PAGE ACCEPTS.\nupdate public.sendset_responses set responder_contact = 'edited by the migration';"),
      /an existing submission changed/],
    ["the before/after comparison has nothing to compare",
      (s) => s.replace(/do \$fixture\$[\s\S]*?end \$fixture\$;/, ""),
      /the before\/after comparison has nothing to compare/],
  ];
  for (const [i, [name, mutate, reason]] of aborting.entries()) {
    const sql = mutate(MIGRATION);
    ok(sql !== MIGRATION, `MUTANT prepared: ${name}`);
    const db = await freshDb(`r59_mut_a${i}`, { sql: null });
    const c = await connect(db);
    const r = await attempt(c, sql);
    ok(!r.ok && reason.test(r.err.message),
      `MUTANT aborts the migration FOR ITS OWN REASON: ${name}${r.ok ? " — IT DID NOT ABORT" : ` — ${r.err.message.slice(0, 70)}`}`);
    await c.end();
  }

  // --- MUTANTS: behaviour that only a published Sendset can show -------------
  const behavioural = [
    ["set does not check the publication for the item",
      (s) => s.replace(/  v_item := public\.sendset_publication_item\(v_content, p_item_id\);\n  if v_item is null then[\s\S]*?end if;\n/,
        "  v_item := coalesce(public.sendset_publication_item(v_content, p_item_id), jsonb_build_object('label', 'X'));\n"),
      async (c, ss, m, h) => {
        const r = await trySet(c, ss.slug, m, h, "00000000-0000-4000-8000-0000000000ff");
        return [r.ok, "a heart on an item that is in no publication was accepted"];
      }],
    ["clear is not scoped to the capability's own submission",
      (s) => s.replace("   where response_id = v_resp.id\n     and target_kind = 'item'", "   where target_kind = 'item'"),
      async (c, ss, m, h) => {
        const other = cap();
        await setAction(c, ss.slug, m, other, ss.itemA, { name: "Mark" });
        await clearAction(c, ss.slug, h, ss.itemA);
        const left = await countRows(c, "sendset_response_lines");
        return [left === 0, `one capability withdrew another's line (${left} lines left)`];
      }],
    ["read is not scoped to the capability",
      (s) => s.replace("   where l.response_id = v_resp.id and l.action = 'like'", "   where l.action = 'like'"),
      async (c, ss, m, h) => {
        await setAction(c, ss.slug, m, cap(), ss.itemB, { name: "Mark" });
        const mine = await readActions(c, ss.slug, h);
        return [mine.actions.length > 1, `a capability read ${mine.actions.length} actions, not only its own`];
      }],
    ["the signature is rewritten by every call",
      (s) => s.replace("    v_created := true;\n  end if;",
        "    v_created := true;\n  end if;\n  update public.sendset_responses set responder_name = v_name where id = v_resp.id;"),
      async (c, ss, m, h) => {
        await setAction(c, ss.slug, m, h, ss.itemB, { name: "Somebody Else" });
        const n = (await c.query("select responder_name from public.sendset_responses where session_hash = $1", [h])).rows[0].responder_name;
        return [n !== "Lisa", `a later call renamed the submission to ${n}`];
      }],
    ["the line's marker is taken from the browser instead of the publication",
      (s) => s.replace("  values (v_resp.id, 'actions', 'item', p_item_id, left(v_item->>'label', 500), p_action,\n          v_live, v_rendered = v_live)",
        "  values (v_resp.id, 'actions', 'item', p_item_id, left(v_item->>'label', 500), p_action,\n          v_rendered, true)"),
      async (c, ss, m, h) => {
        await setAction(c, ss.slug, "2020-01-01T00:00:00Z", h, ss.itemB);
        const { rows: [l] } = await c.query(
          "select to_json(live_publication_published_at) #>> '{}' as m, rendered_publication_was_current as cur from public.sendset_response_lines where target_item_id = $1", [ss.itemB]);
        return [l.m !== m || l.cur === true, `a stale page's own claim was stored (${l.m}, current=${l.cur})`];
      }],
    ["clear is gated on the creator's Like switch",
      (s) => s.replace("  select id, status into v_packet\n    from public.packets\n   where slug = p_slug\n     for no key update;\n\n  if v_packet.id is null or v_packet.status <> 'published' then", "  select id, status, response_actions into v_packet\n    from public.packets\n   where slug = p_slug\n     for no key update;\n\n  if v_packet.id is null or v_packet.status <> 'published'\n     or not ('like' = any (v_packet.response_actions)) then"),
      async (c, ss, m, h) => {
        await accept(c, ss, []);
        const r = await tryClear(c, ss.slug, h, ss.itemA);
        const left = await countRows(c, "sendset_response_lines");
        return [!r.ok || left === 1, `with Like off a withdrawal no longer worked (${r.ok ? "left " + left : r.err.detail})`];
      }],
    ["read is gated on the creator's Like switch",
      (s) => s.replace("  select id, status into v_packet from public.packets where slug = p_slug;\n  if v_packet.id is null or v_packet.status <> 'published' then", "  select id, status, response_actions into v_packet from public.packets where slug = p_slug;\n  if v_packet.id is null or v_packet.status <> 'published'\n     or not ('like' = any (v_packet.response_actions)) then"),
      async (c, ss, m, h) => {
        await accept(c, ss, []);
        const mine = await readActions(c, ss.slug, h);
        return [mine.actions.length === 0, "with Like off a capability could no longer see what it had already said"];
      }],
    ["set is NOT gated on the creator's Like switch",
      (s) => s.replace("  if v_packet.id is null\n     or v_packet.status <> 'published'\n     or not ('like' = any (v_packet.response_actions)) then", "  if v_packet.id is null\n     or v_packet.status <> 'published' then"),
      async (c, ss, m, h) => {
        await accept(c, ss, []);
        const again = await trySet(c, ss.slug, m, h, ss.itemB);
        const minted = await trySet(c, ss.slug, m, cap(), ss.itemB, { name: "Stranger" });
        return [again.ok || minted.ok, "with Like off a new action or a new capability was still accepted"];
      }],
    ["mutations are not counted",
      (s) => s.replace("  update public.sendset_action_rate set mutations = mutations + 1 where packet_id = v_packet.id;\n\n  return jsonb_build_object(\n    'responseId'", "\n  return jsonb_build_object(\n    'responseId'"),
      async (c, ss, m, h) => {
        for (let i = 0; i < 3; i++) await setAction(c, ss.slug, m, h, ss.itemA);
        const n = (await c.query("select mutations from public.sendset_action_rate where packet_id = $1", [ss.id])).rows[0]?.mutations ?? 0;
        return [n === 0, `the Sendset counter stayed at ${n} after four mutations`];
      }],
  ];
  for (const [i, [name, mutate, check]] of behavioural.entries()) {
    const sql = mutate(MIGRATION);
    ok(sql !== MIGRATION, `MUTANT prepared: ${name}`);
    const db = await freshDb(`r59_mut_b${i}`, { sql });
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss, legacySnapshot(ss, [{ id: ss.itemA, title: "Harbor House" }, { id: ss.itemB, title: "The Loft" }]));
    await accept(c, ss, ["like"]);
    const m = await marker(c, ss);
    const h = cap();
    await setAction(c, ss.slug, m, h, ss.itemA);
    const [detected, what] = await check(c, ss, m, h);
    ok(detected, `MUTANT detected: ${what}`);
    await c.end();
  }

  for (const db of created) await admin.query(`drop database if exists "${db}"`);
  await admin.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
