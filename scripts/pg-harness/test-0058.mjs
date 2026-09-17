// 0058 against real PostgreSQL 17: Sendset Responses. Refusals that reveal
// nothing, the publication marker compared in SQL at microsecond precision,
// validation before lookup, the atomic submission+line insert, exact
// per-Sendset limits under genuine two-connection interleavings, the
// notification allowance, the revision/publication invariants, grants, the
// cascade, the rollback, and mutants of the migration.
//
// Local harness only (README.md). Connects to the Unix socket in $PGHARNESS_DIR.
//
//   scripts/pg-harness/harness.sh replay pre0058 0057
//   node scripts/pg-harness/test-0058.mjs [path/to/0058.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0058_sendset_responses.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0058_sendset_responses_down.sql"), "utf8");
const TEMPLATE = "pre0058";
const OWNER = "00000000-0000-4000-8000-000000000001";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const connect = async (database) => {
  const c = new pg.Client({ host: SOCKET, port: PORT, user: "postgres", database });
  await c.connect();
  c.pid = (await c.query("select pg_backend_pid() as p")).rows[0].p;   // read up front: a blocked connection cannot answer
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
/** Wait until `pid` is blocked on a lock; null if it never is. */
async function waitingOnLock(watcher, pid, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { rows } = await watcher.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function sendset(c) {
  const { rows: [p] } = await c.query(
    `insert into public.packets (user_id, slug, title)
     values ($1, 'r-' || substr(md5(random()::text), 1, 12), 'T') returning id, slug`, [OWNER]);
  const { rows: [s] } = await c.query(`insert into public.sections (packet_id, title) values ($1, 'S') returning id`, [p.id]);
  const { rows: [i] } = await c.query(`insert into public.items (section_id, title) values ($1, 'Item') returning id`, [s.id]);
  return { id: p.id, slug: p.slug, sectionId: s.id, itemId: i.id, owner: OWNER };
}
const token = async (c, ss) => (await c.query("select public.packet_publish_token($1, $2) as t", [ss.owner, ss.id])).rows[0].t;
const snapshot = (ss) => ({ slug: ss.slug, sections: [{ id: ss.sectionId, title: "S", items: [{ id: ss.itemId, title: "Item" }] }], professional: { name: "" } });
const publish = async (c, ss) => c.query(
  "select public.publish_packet($1, $2, $3, $4::smallint, $5, $6)",
  [ss.owner, ss.id, JSON.stringify(await token(c, ss)), 1, JSON.stringify(snapshot(ss)), JSON.stringify({})]);
const unpublish = (c, ss) => c.query("select public.unpublish_packet($1, $2)", [ss.owner, ss.id]);
const enable = (c, ss) => c.query("update public.packets set response_actions = '{respond}' where id = $1", [ss.id]);

/** THE MARKER, AS THE PAGE WOULD RENDER IT: PostgREST's JSON text, never a Date.
 *  (Selecting published_at directly would hand back a JS Date and drop the
 *  microseconds — the exact hazard the marker's contract forbids.) */
const marker = async (c, ss) => (await c.query(
  "select to_json(published_at) #>> '{}' as m from public.packet_publications where packet_id = $1", [ss.id])).rows[0]?.m;
const liveText = async (c, ss) => (await c.query(
  "select published_at::text as t from public.packet_publications where packet_id = $1", [ss.id])).rows[0]?.t;

const respond = (c, slug, m, { name = "Lisa", contact = null, note = "Hello" } = {}) =>
  c.query("select public.record_sendset_response($1, $2, $3, $4, $5) as r", [slug, m, name, contact, note]);
const tryRespond = (c, slug, m, opts = {}) =>
  attempt(c, "select public.record_sendset_response($1, $2, $3, $4, $5) as r",
    [slug, m, opts.name ?? "Lisa", opts.contact ?? null, opts.note ?? "Hello"]);
const refusedWith = (r, code, detail) => !r.ok && r.err.code === code && r.err.detail === detail;

// ---------------------------------------------------------------------------
async function main() {
  // --- REFUSALS THAT REVEAL NOTHING ---------------------------------------
  {
    const db = await freshDb("r58_refuse");
    const c = await connect(db);
    const ss = await sendset(c);
    const GOOD = "2026-09-17T10:00:00.123456+00:00";

    ok(refusedWith(await tryRespond(c, ss.slug, GOOD), "PT404", "not_accepting"), "a draft with responses off is refused");
    await enable(c, ss);
    ok(refusedWith(await tryRespond(c, ss.slug, GOOD), "PT404", "not_accepting"), "a DRAFT with Respond enabled is still refused");
    await c.query("update public.packets set response_actions = '{}' where id = $1", [ss.id]);
    await publish(c, ss);
    ok(refusedWith(await tryRespond(c, ss.slug, await marker(c, ss)), "PT404", "not_accepting"), "a published Sendset with responses OFF is refused");
    ok(refusedWith(await tryRespond(c, "no-such-slug-ever", GOOD), "PT404", "not_accepting"),
      "an unknown slug is refused with the SAME detail as responses-off");
    await enable(c, ss);
    const m = await marker(c, ss);
    await unpublish(c, ss);
    ok(refusedWith(await tryRespond(c, ss.slug, m), "PT404", "not_accepting"), "an unpublished Sendset is refused");
    ok((await c.query("select count(*)::int as n from public.sendset_responses")).rows[0].n === 0, "no refusal stored anything");
    await c.end();
  }

  // --- VALIDATION BEFORE LOOKUP -------------------------------------------
  {
    const db = await freshDb("r58_validate");
    const c = await connect(db);
    for (const [label, m] of [["prose", "yesterday"], ["a space, not T", "2026-09-17 10:00:00+00"],
                              ["out of range", "2026-13-45T10:00:00Z"], ["seven fraction digits", "2026-09-17T10:00:00.1234567Z"],
                              ["empty", ""]]) {
      const r = await tryRespond(c, "no-such-slug-ever", m);
      ok(refusedWith(r, "PT400", "marker_invalid"), `a malformed marker (${label}) is refused before any lookup`);
    }
    ok(refusedWith(await tryRespond(c, "no-such-slug-ever", null), "PT400", "marker_invalid"), "a missing marker is refused before any lookup");
    for (const note of ["", "   ", " \n\t "]) {
      ok(refusedWith(await tryRespond(c, "no-such-slug-ever", "2026-09-17T10:00:00Z", { note }), "PT400", "note_required"),
        `a blank message (${JSON.stringify(note)}) is refused before any lookup`);
    }
    await c.end();
  }

  // --- THE SUCCESSFUL PATH, AND THE MARKER ---------------------------------
  {
    const db = await freshDb("r58_marker");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    const m1 = await marker(c, ss);
    const live1 = await liveText(c, ss);

    const r = (await respond(c, ss.slug, m1, { name: "  Lisa  ", contact: "   ", note: "\n  Is 2 available?  \n" })).rows[0].r;
    const { rows: [row] } = await c.query(
      `select owner_user_id, live_publication_published_at::text as live, rendered_publication_was_current as cur,
              responder_name, responder_contact, notification_due, notified_at
         from public.sendset_responses where id = $1`, [r.responseId]);
    const lines = (await c.query("select target_kind, target_item_id, target_label, action, note from public.sendset_response_lines where response_id = $1", [r.responseId])).rows;

    ok(row.owner_user_id === OWNER && r.ownerUserId === OWNER, "the response belongs to the Sendset's owner");
    ok(row.live === live1, "the SERVER-READ published_at is stored");
    ok(row.cur === true, "a marker from the current publication is recorded as current");
    ok(row.responder_name === "Lisa" && row.responder_contact === null, "identity is trimmed, and a blank contact is stored as null");
    ok(row.notification_due === true && row.notified_at === null && r.notificationDue === true, "the first response is due a notification");
    ok(lines.length === 1, "exactly one line per submission");
    ok(lines[0].target_kind === "sendset" && lines[0].target_item_id === null && lines[0].target_label === null
       && lines[0].action === "respond" && lines[0].note === "Is 2 available?", "the line is one trimmed Sendset-level respond");

    // EQUALITY IS OF INSTANTS, IN SQL — not of strings.
    const utcZ = (await c.query("select to_char($1::timestamptz at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as z", [m1])).rows[0].z;
    ok(utcZ !== m1, `CONTROL: the Z-form marker is a different string (${utcZ} vs ${m1})`);
    const rz = (await respond(c, ss.slug, utcZ)).rows[0].r;
    ok((await c.query("select rendered_publication_was_current as cur from public.sendset_responses where id = $1", [rz.responseId])).rows[0].cur === true,
      "the same instant written differently still compares as current");

    // THE JAVASCRIPT DATE HAZARD. Round-tripping through Date drops microseconds.
    const frac = (m1.match(/\.(\d+)/) ?? [])[1] ?? "";
    ok(frac.length > 3, `CONTROL: this publication has sub-millisecond precision (.${frac}), so the next check is not vacuous`);
    const truncated = new Date(m1).toISOString();
    const rt = (await respond(c, ss.slug, truncated)).rows[0].r;
    ok((await c.query("select rendered_publication_was_current as cur from public.sendset_responses where id = $1", [rt.responseId])).rows[0].cur === false,
      `a marker passed through JS Date (${truncated}) no longer matches — the hazard is real`);

    // A STALE PAGE IS ACCEPTED, AND SAYS SO.
    await c.query("update public.items set title = 'Item edited' where id = $1", [ss.itemId]);
    await publish(c, ss);
    const live2 = await liveText(c, ss);
    ok(live2 !== live1, "CONTROL: Republish changed published_at");
    const rs = (await respond(c, ss.slug, m1, { note: "Typed before the update" })).rows[0].r;
    const { rows: [stale] } = await c.query(
      "select live_publication_published_at::text as live, rendered_publication_was_current as cur from public.sendset_responses where id = $1", [rs.responseId]);
    ok(stale.cur === false, "a response from the previous publication is accepted and recorded as not current");
    ok(stale.live === live2, "and stores the publication that was live when it arrived, not the one the page claimed");
    await c.end();
  }

  // --- ATOMICITY: a failed line leaves no submission -----------------------
  {
    const db = await freshDb("r58_atomic");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    await c.query(`create function public.fail_line() returns trigger language plpgsql as $$ begin raise exception 'injected line failure'; end $$;
                   create trigger fail_line before insert on public.sendset_response_lines for each row execute function public.fail_line();`);
    const r = await tryRespond(c, ss.slug, await marker(c, ss));
    ok(!r.ok && /injected line failure/.test(r.err.message), "CONTROL: the line insert was made to fail");
    ok((await c.query("select count(*)::int as n from public.sendset_responses")).rows[0].n === 0,
      "no submission survives a failed line insert");
    await c.end();
  }

  // --- EXACT PER-SENDSET LIMIT UNDER A REAL INTERLEAVING --------------------
  {
    const db = await freshDb("r58_ratelimit");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    const m = await marker(c, ss);
    for (let i = 0; i < 19; i++) await respond(c, ss.slug, m, { note: `n${i}` });

    const a = await connect(db), b = await connect(db);
    await a.query("begin");
    await a.query("select public.record_sendset_response($1, $2, 'A', null, 'twentieth')", [ss.slug, m]);   // #20, lock held
    const bResult = attempt(b, "select public.record_sendset_response($1, $2, 'B', null, 'twenty-first')", [ss.slug, m]);
    ok(await waitingOnLock(c, b.pid), "a second response to the SAME Sendset waits on the row lock");
    await a.query("commit");
    const br = await bResult;
    ok(refusedWith(br, "PT429", "rate_limited"), "and, once the first commits, is refused at the limit");
    ok((await c.query("select count(*)::int as n from public.sendset_responses where packet_id = $1", [ss.id])).rows[0].n === 20,
      "exactly 20 stored, never 21");

    // A DIFFERENT Sendset is not blocked by that lock.
    const other = await sendset(c);
    await publish(c, other);
    await enable(c, other);
    await a.query("begin");
    await a.query("select public.record_sendset_response($1, $2, 'A', null, 'x')", [other.slug, await marker(c, other)]);
    const third = await sendset(c);
    await publish(c, third);
    await enable(c, third);
    const tm = await marker(c, third);
    const t0 = Date.now();
    const tr = await attempt(b, "select public.record_sendset_response($1, $2, 'B', null, 'y')", [third.slug, tm]);
    ok(tr.ok && Date.now() - t0 < 1000, "responses to a DIFFERENT Sendset are not serialised behind it");
    await a.query("commit");
    await a.end(); await b.end();
    await c.end();
  }

  // --- THE NOTIFICATION ALLOWANCE -----------------------------------------
  {
    const db = await freshDb("r58_notify");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    const m = await marker(c, ss);
    const dues = [];
    for (let i = 0; i < 7; i++) dues.push((await respond(c, ss.slug, m, { note: `n${i}` })).rows[0].r.notificationDue);
    ok(JSON.stringify(dues) === JSON.stringify([true, true, true, true, true, false, false]),
      `five emails per Sendset per hour, then none (${dues.join(",")})`);
    ok((await c.query("select count(*)::int as n from public.sendset_responses where packet_id = $1", [ss.id])).rows[0].n === 7,
      "a response beyond the email allowance is still STORED");

    const { rows: [due] } = await c.query("select id from public.sendset_responses where notification_due order by created_at limit 1");
    const { rows: [notDue] } = await c.query("select id from public.sendset_responses where not notification_due limit 1");
    await c.query("select public.mark_sendset_response_notified($1)", [due.id]);
    const t1 = (await c.query("select notified_at::text as t from public.sendset_responses where id = $1", [due.id])).rows[0].t;
    ok(t1 !== null, "a due response can be marked notified");
    await new Promise((r) => setTimeout(r, 20));
    await c.query("select public.mark_sendset_response_notified($1)", [due.id]);
    ok((await c.query("select notified_at::text as t from public.sendset_responses where id = $1", [due.id])).rows[0].t === t1,
      "marking twice never overwrites the first time");
    await c.query("select public.mark_sendset_response_notified($1)", [notDue.id]);
    ok((await c.query("select notified_at from public.sendset_responses where id = $1", [notDue.id])).rows[0].notified_at === null,
      "a response that was not due cannot be marked notified");
    await c.end();
  }

  // --- THE GLOBAL CEILING ---------------------------------------------------
  {
    const db = await freshDb("r58_global");
    const c = await connect(db);
    const filler = await sendset(c);
    await c.query(
      `insert into public.sendset_responses
         (packet_id, owner_user_id, live_publication_published_at, rendered_publication_was_current, notification_due)
       select $1, $2, now(), true, false from generate_series(1, 300)`, [filler.id, OWNER]);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    ok(refusedWith(await tryRespond(c, ss.slug, await marker(c, ss)), "PT429", "rate_limited"),
      "the global hourly ceiling refuses a response to an otherwise quiet Sendset");
    await c.end();
  }

  // --- REVISION AND PUBLICATION INVARIANTS ----------------------------------
  {
    const db = await freshDb("r58_invariants");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    const state = async () => (await c.query(
      `select p.draft_rev, p.content_rev, p.updated_at::text as updated, pub.content::text as content, pub.published_at::text as published
         from public.packets p join public.packet_publications pub on pub.packet_id = p.id where p.id = $1`, [ss.id])).rows[0];
    const before = await state();

    await enable(c, ss);
    const afterToggle = await state();
    ok(afterToggle.draft_rev === before.draft_rev && afterToggle.content_rev === before.content_rev,
      "enabling responses moves neither draft_rev nor content_rev");
    ok(afterToggle.content === before.content && afterToggle.published === before.published,
      "enabling responses leaves the publication untouched");

    const m = await marker(c, ss);
    for (let i = 0; i < 3; i++) await respond(c, ss.slug, m, { note: `n${i}` });
    const afterResponses = await state();
    ok(afterResponses.draft_rev === before.draft_rev && afterResponses.content_rev === before.content_rev,
      "responses move neither draft_rev nor content_rev");
    ok(afterResponses.content === before.content && afterResponses.published === before.published,
      "responses leave the publication's content and published_at untouched");
    ok(afterResponses.updated === afterToggle.updated, "the row lock a response takes writes nothing to the Sendset");

    // Responses and configuration never enter the frozen copy.
    await c.query("update public.items set title = 'edited' where id = $1", [ss.itemId]);
    await publish(c, ss);
    const { rows: [pub] } = await c.query("select content from public.packet_publications where packet_id = $1", [ss.id]);
    const text = JSON.stringify(pub.content);
    ok(!/response_actions|responseActions|sendset_response|responder_|Hello|n0|n1|n2/.test(text),
      "a Republish after responses carries no response or response configuration into the publication");

    // The control: a real edit still moves draft_rev.
    await c.query("update public.packets set client_title = 'heading' where id = $1", [ss.id]);
    ok((await state()).draft_rev > afterResponses.draft_rev, "CONTROL: a real edit still moves draft_rev");
    await c.end();
  }

  // --- GRANTS ---------------------------------------------------------------
  {
    const db = await freshDb("r58_grants");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    const m = await marker(c, ss);
    const { r } = (await respond(c, ss.slug, m)).rows[0];

    ok((await attempt(c, "begin; set local role anon; select 1; commit;")).ok, "CONTROL: the anon role itself works");
    for (const role of ["anon", "authenticated"]) {
      for (const [label, sql] of [
        ["read responses", "select count(*) from public.sendset_responses"],
        ["read lines", "select count(*) from public.sendset_response_lines"],
        ["insert a response", `insert into public.sendset_responses (packet_id, owner_user_id, live_publication_published_at, rendered_publication_was_current, notification_due) values ('${ss.id}', '${OWNER}', now(), true, true)`],
        ["call record_sendset_response", `select public.record_sendset_response('${ss.slug}', '${m}', 'x', null, 'y')`],
        ["call mark_sendset_response_notified", "select public.mark_sendset_response_notified(gen_random_uuid())"],
        ["call delete_sendset", `select public.delete_sendset('${OWNER}', '${ss.id}', 1)`],
      ]) {
        const res = await attempt(c, `begin; set local role ${role}; ${sql}; commit;`);
        ok(!res.ok && /permission denied/.test(res.err.message), `${role} cannot ${label}`);
      }
    }
    ok((await attempt(c, "begin; set local role service_role; select count(*) from public.sendset_responses; commit;")).ok,
      "service_role can read responses");
    for (const [label, sql] of [
      ["insert a response directly", `insert into public.sendset_responses (packet_id, owner_user_id, live_publication_published_at, rendered_publication_was_current, notification_due) values ('${ss.id}', '${OWNER}', now(), true, true)`],
      ["update a response directly", "update public.sendset_responses set responder_name = 'forged'"],
      ["delete a response directly", "delete from public.sendset_responses"],
      ["insert a line directly", `insert into public.sendset_response_lines (response_id, target_kind, action, note) values (gen_random_uuid(), 'sendset', 'respond', 'x')`],
    ]) {
      const res = await attempt(c, `begin; set local role service_role; ${sql}; commit;`);
      ok(!res.ok && /permission denied/.test(res.err.message), `service_role cannot ${label} — every write goes through a function`);
    }
    ok((await attempt(c, `begin; set local role service_role; select public.record_sendset_response('${ss.slug}', '${m}', 'SR', null, 'via function'); commit;`)).ok,
      "service_role can record a response through the function");

    await c.end();
  }

  // --- DELETION: no response is destroyed without an exact acknowledgement ----
  {
    const db = await freshDb("r58_delete");
    const c = await connect(db);
    const counts = async (ss) => (await c.query(
      `select (select count(*)::int from public.packets where id = $1) as sendset,
              (select count(*)::int from public.sendset_responses where packet_id = $1) as responses,
              (select count(*)::int from public.sendset_response_lines l join public.sendset_responses r on r.id = l.response_id where r.packet_id = $1) as lines,
              (select count(*)::int from public.packet_publications where packet_id = $1) as publication`, [ss.id])).rows[0];
    const del = (conn, ss, ack) => attempt(conn, "select public.delete_sendset($1, $2, $3) as r", [ss.owner, ss.id, ack]);
    const withResponses = async (n) => {
      const ss = await sendset(c); await publish(c, ss); await enable(c, ss);
      const m = await marker(c, ss);
      for (let i = 0; i < n; i++) await respond(c, ss.slug, m, { note: `n${i}` });
      return ss;
    };

    // Zero responses: no acknowledgement.
    const empty = await sendset(c);
    const e = await del(c, empty, null);
    ok(e.ok && e.res.rows[0].r.responses === 0 && (await counts(empty)).sendset === 0,
      "a Sendset with no responses deletes without any acknowledgement");

    // Responses present.
    const three = await withResponses(3);
    for (const [label, ack] of [["no acknowledgement", null], ["too few", 2], ["too many", 4], ["zero", 0]]) {
      const r = await del(c, three, ack);
      ok(refusedWith(r, "PT409", "responses_changed") && r.err.hint === "3",
        `with 3 responses, ${label} is refused with the true count (hint ${r.ok ? "—" : r.err.hint})`);
    }
    const kept = await counts(three);
    ok(kept.sendset === 1 && kept.responses === 3 && kept.lines === 3 && kept.publication === 1, "and every refusal deleted nothing");

    // Owner scoping: not yours and not real are one answer.
    const stranger = await attempt(c, "select public.delete_sendset($1, $2, 3)", ["00000000-0000-4000-8000-00000000beef", three.id]);
    const missing = await attempt(c, "select public.delete_sendset($1, $2, 3)", [OWNER, "00000000-0000-4000-8000-00000000dead"]);
    ok(refusedWith(stranger, "PT404", "not_found") && refusedWith(missing, "PT404", "not_found"),
      "another owner's Sendset and a nonexistent one get the SAME refusal");
    ok((await counts(three)).sendset === 1, "and the stranger deleted nothing");

    // Every other deletion path is refused by the database itself.
    for (const [label, sql, args] of [
      ["a plain DELETE", "delete from public.packets where id = $1", [three.id]],
      ["a DELETE as service_role", `begin; set local role service_role; delete from public.packets where id = '${three.id}'; commit;`, undefined],
      ["deleting the owner's account", "delete from public.users where id = $1", [OWNER]],
    ]) {
      const r = await attempt(c, sql, args);
      ok(!r.ok && r.err.code === "23503", `${label} of a Sendset with responses is refused by the foreign key (${r.ok ? "succeeded" : r.err.code})`);
    }
    ok((await counts(three)).responses === 3, "CONTROL: all three responses survived every refused path");

    // The exact count.
    const done = await del(c, three, 3);
    const gone = await counts(three);
    ok(done.ok && done.res.rows[0].r.responses === 3, "the exact acknowledged count succeeds");
    ok(gone.sendset === 0 && gone.responses === 0 && gone.lines === 0 && gone.publication === 0,
      "and removes the Sendset, its publication, its responses and their lines");

    // --- THE RACE: a response arrives between the creator's count and the delete.
    {
      const ss = await withResponses(2);
      const a = await connect(db), b = await connect(db);
      await a.query("begin");
      await a.query("select public.record_sendset_response($1, $2, 'Late', null, 'arrived during deletion')", [ss.slug, await marker(c, ss)]);
      // The creator acknowledged 2 — the count they were shown — and presses delete.
      const pending = del(b, ss, 2);
      ok(await waitingOnLock(c, b.pid), "RACE: delete_sendset waits while a response insert holds the Sendset");
      await a.query("commit");
      const r = await pending;
      ok(refusedWith(r, "PT409", "responses_changed") && r.err.hint === "3",
        `RACE: the delete sees the response that arrived and refuses (hint ${r.ok ? "—" : r.err.hint})`);
      const after = await counts(ss);
      ok(after.sendset === 1 && after.responses === 3, "RACE: nothing was deleted, including the new response");
      await a.end(); await b.end();
    }

    // --- THE OTHER ORDER: delete holds the lock first; a response arrives after.
    {
      const ss = await withResponses(1);
      const m = await marker(c, ss);
      const a = await connect(db), b = await connect(db);
      await a.query("begin");
      await a.query("select public.delete_sendset($1, $2, 1)", [ss.owner, ss.id]);   // counted 1, deleted, lock still held
      const pending = attempt(b, "select public.record_sendset_response($1, $2, 'After', null, 'too late')", [ss.slug, m]);
      ok(await waitingOnLock(c, b.pid), "RACE: a response insert waits while delete_sendset holds the Sendset");
      await a.query("commit");
      const r = await pending;
      ok(refusedWith(r, "PT404", "not_accepting"), "RACE: once the delete commits, the response is refused — not orphaned");
      ok((await c.query("select count(*)::int as n from public.sendset_responses where packet_id = $1", [ss.id])).rows[0].n === 0,
        "RACE: no response exists for a deleted Sendset");
      await a.end(); await b.end();
    }

    // --- A PLAIN DELETE RACING AN UNCOMMITTED RESPONSE: RESTRICT holds too.
    {
      const ss = await sendset(c); await publish(c, ss); await enable(c, ss);
      const a = await connect(db), b = await connect(db);
      await a.query("begin");
      await a.query("select public.record_sendset_response($1, $2, 'Only', null, 'the first one')", [ss.slug, await marker(c, ss)]);
      // Before A commits, this Sendset has ZERO committed responses.
      const pending = attempt(b, "delete from public.packets where id = $1", [ss.id]);
      ok(await waitingOnLock(c, b.pid), "RACE: a plain DELETE waits on the uncommitted response's row lock");
      await a.query("commit");
      const r = await pending;
      ok(!r.ok && r.err.code === "23503", `RACE: once it commits, the plain DELETE is refused (${r.ok ? "succeeded" : r.err.code})`);
      ok((await counts(ss)).responses === 1, "RACE: the response that arrived is intact");
      await a.end(); await b.end();
    }
    await c.end();
  }

  // --- THE ROLLBACK -----------------------------------------------------------
  {
    const db = await freshDb("r58_rollback");
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    await respond(c, ss.slug, await marker(c, ss));
    const refused = await attempt(c, ROLLBACK);
    ok(!refused.ok && /ROLLBACK 0058 REFUSED: 1 response/.test(refused.err.message), "the rollback refuses while a response exists");
    ok(!!(await c.query("select to_regclass('public.sendset_responses') as t")).rows[0].t, "and changed nothing");

    await c.query("delete from public.sendset_responses");
    const done = await attempt(c, ROLLBACK);
    ok(done.ok, "with no responses, the rollback runs");
    const { rows: [left] } = await c.query(`
      select to_regclass('public.sendset_responses') as r, to_regclass('public.sendset_response_lines') as l,
             to_regprocedure('public.record_sendset_response(text,text,text,text,text)') as f1,
             to_regprocedure('public.mark_sendset_response_notified(uuid)') as f2,
             (select count(*)::int from information_schema.columns where table_schema='public' and table_name='packets' and column_name='response_actions') as col,
             (select count(*)::int from public.packets where id = '${ss.id}') as sendset`);
    ok(!left.r && !left.l && !left.f1 && !left.f2 && left.col === 0, "every 0058 object is gone");
    ok(left.sendset === 1, "the Sendset itself is untouched");
    await c.end();
  }

  // --- MUTANTS ---------------------------------------------------------------
  // (a) Each must ABORT the migration: the in-transaction proof is what fails.
  const aborting = [
    ["the anon/authenticated table revoke is dropped",
      (s) => s.replace("revoke all on public.sendset_responses      from public, anon, authenticated, service_role;", ""),
      /table privilege\(s\) held by an unprivileged role/],
    ["service_role is granted ALL on responses",
      (s) => s.replace("grant select on public.sendset_responses      to service_role;", "grant all on public.sendset_responses to service_role;"),
      /service_role can write the responses tables directly/],
    ["the function revoke is dropped",
      (s) => s.replace("revoke all on function public.record_sendset_response(text, text, text, text, text) from public, anon, authenticated;", ""),
      /function grant\(s\) held by an unprivileged role/],
    ["'approve' is allowed as a response action",
      (s) => s.replace("check (response_actions <@ array['respond']::text[]);", "check (response_actions <@ array['respond','approve']::text[]);"),
      /an unknown response action was accepted/],
    ["a Respond no longer requires a message",
      (s) => s.replace("constraint sendset_response_lines_respond_has_note check (action <> 'respond' or note is not null),", ""),
      /a Respond without a message was accepted/],
    ["notified_at can be set on a response that was not due",
      (s) => s.replace("constraint sendset_responses_notified_only_when_due check (notified_at is null or notification_due)", "constraint sendset_responses_placeholder check (true)"),
      /a response not due a notification was marked notified/],
    ["row level security is not enabled on the lines",
      (s) => s.replace("alter table public.sendset_response_lines enable row level security;", ""),
      /row level security is not enabled/],
    ["responses CASCADE when their Sendset is deleted",
      (s) => s.replace("references public.packets(id) on delete restrict,", "references public.packets(id) on delete cascade,"),
      /a plain DELETE destroyed a Sendset that had responses/],
    ["responses CASCADE when their owner's account is deleted",
      (s) => s.replace("references public.users(id)   on delete restrict,", "references public.users(id)   on delete cascade,"),
      /deleting an account destroyed responses addressed to it|foreign keys on sendset_responses are ON DELETE RESTRICT/],
    ["delete_sendset accepts an acknowledgement at LEAST the count",
      (s) => s.replace("(p_acknowledged_responses is null or p_acknowledged_responses <> v_count)", "(p_acknowledged_responses is null or p_acknowledged_responses < v_count)"),
      /delete_sendset accepted acknowledgement 3 for 2 responses/],
    ["delete_sendset tells 'not yours' apart from 'does not exist'",
      (s) => s.replace(
        "   where id = p_packet_id\n     and user_id = p_owner\n     for update;\n  if v_id is null then",
        "   where id = p_packet_id\n     and user_id = p_owner\n     for update;\n  if v_id is null and exists (select 1 from public.packets where id = p_packet_id) then\n    raise exception 'delete: not yours' using errcode = 'PT403', detail = 'forbidden';\n  end if;\n  if v_id is null then"),
      /delete_sendset let a non-owner through/],
    ["delete_sendset is executable by anon and authenticated",
      (s) => s.replace("revoke all on function public.delete_sendset(uuid, uuid, integer)                      from public, anon, authenticated;", ""),
      /function grant\(s\) held by an unprivileged role/],
  ];
  for (const [i, [name, mutate, reason]] of aborting.entries()) {
    const sql = mutate(MIGRATION);
    ok(sql !== MIGRATION, `MUTANT prepared: ${name}`);
    const db = await freshDb(`r58_mut_a${i}`, { sql: null });
    const c = await connect(db);
    const r = await attempt(c, sql);
    // THE REASON, not merely a failure: a mutant that aborts on some unrelated
    // error would otherwise pass while the proof it targets had stopped working.
    ok(!r.ok && reason.test(r.err.message), `MUTANT aborts the migration FOR ITS OWN REASON: ${name}${r.ok ? "" : ` — ${r.err.message.slice(0, 70)}`}`);
    await c.end();
  }

  // (b) Each APPLIES (it breaks behaviour, not a table property), and a focused
  // behavioural check must then fail — shown here as the check detecting it.
  {
    const noLock = MIGRATION.replace("   where slug = p_slug\n     for no key update;", "   where slug = p_slug;");
    ok(noLock !== MIGRATION, "MUTANT prepared: the Sendset row lock is removed");
    const db = await freshDb("r58_mut_nolock", { sql: noLock });
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    const m = await marker(c, ss);
    for (let i = 0; i < 19; i++) await respond(c, ss.slug, m, { note: `n${i}` });
    const a = await connect(db), b = await connect(db);
    await a.query("begin");
    await a.query("select public.record_sendset_response($1, $2, 'A', null, 'twentieth')", [ss.slug, m]);
    const waited = await waitingOnLock(c, b.pid, 400);
    const br = await attempt(b, "select public.record_sendset_response($1, $2, 'B', null, 'twenty-first')", [ss.slug, m]);
    await a.query("commit");
    const n = (await c.query("select count(*)::int as n from public.sendset_responses where packet_id = $1", [ss.id])).rows[0].n;
    ok(!waited && br.ok && n === 21, `MUTANT detected: without the lock the limit is exceeded (${n} stored)`);
    await a.end(); await b.end(); await c.end();
  }
  {
    const alwaysCurrent = MIGRATION.replace("v_rendered = v_live, v_name", "true, v_name");
    ok(alwaysCurrent !== MIGRATION, "MUTANT prepared: the marker comparison always reports current");
    const db = await freshDb("r58_mut_cur", { sql: alwaysCurrent });
    const c = await connect(db);
    const ss = await sendset(c);
    await publish(c, ss);
    await enable(c, ss);
    const old = await marker(c, ss);
    await c.query("update public.items set title = 'edited' where id = $1", [ss.itemId]);
    await publish(c, ss);
    const { r } = (await respond(c, ss.slug, old)).rows[0];
    const cur = (await c.query("select rendered_publication_was_current as cur from public.sendset_responses where id = $1", [r.responseId])).rows[0].cur;
    ok(cur === true, "MUTANT detected: a stale marker is wrongly recorded as current");
    await c.end();
  }
  {
    // Move the marker check below the lookup: a malformed marker on an unknown
    // slug would then answer not_accepting instead of marker_invalid.
    const start = MIGRATION.indexOf("  -- THE MARKER'S SHAPE, before it is cast");
    const end = MIGRATION.indexOf("  -- A Respond is a message.");
    const block = MIGRATION.slice(start, end);
    const lookupEnd = MIGRATION.indexOf("  -- LIMITS. No identifier");
    const lateValidation = MIGRATION.slice(0, start) + MIGRATION.slice(end, lookupEnd) + block + MIGRATION.slice(lookupEnd);
    ok(start > 0 && end > start && lookupEnd > end && lateValidation !== MIGRATION, "MUTANT prepared: marker validation runs after the lookup");
    const db = await freshDb("r58_mut_late", { sql: lateValidation });
    const c = await connect(db);
    const r = await tryRespond(c, "no-such-slug-ever", "yesterday");
    ok(refusedWith(r, "PT404", "not_accepting"), "MUTANT detected: a malformed marker now gets a lookup-dependent answer");
    await c.end();
  }

  {
    // WHICH LAYER IS PROTECTING WHAT. Remove the lock from delete_sendset and
    // replay the race: RESTRICT still prevents any response being destroyed,
    // but the refusal becomes a raw foreign-key error instead of the exact,
    // explicable responses_changed. The lock is what makes the ANSWER right;
    // the foreign key is what makes the DATA safe.
    const noDeleteLock = MIGRATION.replace("   where id = p_packet_id\n     and user_id = p_owner\n     for update;", "   where id = p_packet_id\n     and user_id = p_owner;");
    ok(noDeleteLock !== MIGRATION, "MUTANT prepared: delete_sendset takes no lock");
    const db = await freshDb("r58_mut_nodellock", { sql: noDeleteLock });
    const c = await connect(db);
    const ss = await sendset(c); await publish(c, ss); await enable(c, ss);
    const m = await marker(c, ss);
    for (let i = 0; i < 2; i++) await respond(c, ss.slug, m, { note: `n${i}` });
    const a = await connect(db), b = await connect(db);
    await a.query("begin");
    await a.query("select public.record_sendset_response($1, $2, 'Late', null, 'arrived during deletion')", [ss.slug, m]);
    const pending = attempt(b, "select public.delete_sendset($1, $2, 2)", [ss.owner, ss.id]);
    await waitingOnLock(c, b.pid, 1500);
    await a.query("commit");
    const r = await pending;
    const left = (await c.query("select count(*)::int as n from public.sendset_responses where packet_id = $1", [ss.id])).rows[0].n;
    ok(!refusedWith(r, "PT409", "responses_changed"),
      `MUTANT detected: without the lock the refusal is no longer responses_changed (${r.ok ? "succeeded" : r.err.code})`);
    ok(!r.ok && left === 3, `and yet RESTRICT still destroyed nothing (${left} responses remain) — the data guarantee does not depend on the lock`);
    await a.end(); await b.end(); await c.end();
  }
  for (const db of created) await admin.query(`drop database if exists "${db}"`);
  await admin.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
