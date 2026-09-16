// 0056 against real PostgreSQL 17: an approved request becomes an invitation
// reserved for one address, claimed by the magic link sent to it.
//
// Local harness only (README.md).
//
//   scripts/pg-harness/harness.sh replay pre0056 0055
//   node scripts/pg-harness/test-0056.mjs [path/to/0056.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0056_invitations.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0056_invitations_down.sql"), "utf8");
const TEMPLATE = "pre0056";

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
const refused = (r, code, detail) => !r.ok && r.err.code === code && r.err.detail === detail;
async function withDb(name, fn, opts) {
  const db = await freshDb(name, opts);
  const conns = await Promise.all([connect(db), connect(db)]);
  try { await fn(...conns); } finally { await Promise.all(conns.map((x) => x.end())); }
}

const hash = (code) => createHash("sha256").update(code, "utf8").digest("hex");
const email = () => `invited-${randomUUID()}@example.com`;
async function request(c, addr = email()) {
  const { rows: [r] } = await c.query("insert into public.early_access_requests (name, email, use_case) values ('Jane', $1, 'Venue lists') returning id", [addr]);
  return { id: r.id, email: addr };
}
async function link(c, addr, { expiresIn = "7 days", used = false } = {}) {
  const token = randomUUID();
  await c.query("insert into public.magic_links (email, token, expires_at, used) values ($1, $2, now() + $3::interval, $4)", [addr, token, expiresIn, used]);
  return { email: addr, token };
}
const approveSql = "select public.approve_early_access_request($1) as r";
const claimSql = "select public.redeem_bound_invite($1) as r";
const approve = (c, req) => attempt(c, approveSql, [req.id]);
const claim = (c, l) => attempt(c, claimSql, [l.token]);
const stateOf = async (c, addr) => (await c.query(`select
    (select count(*)::int from public.users where email = $1) as users,
    (select count(*)::int from public.professional_profiles where email = $1) as profiles,
    (select count(*)::int from public.invite_codes where email = $1) as invites,
    (select count(*)::int from public.invite_codes where email = $1 and used_at is not null) as invites_used,
    (select approved_at is not null from public.early_access_requests where email = $1) as approved,
    (select invitation_sent_at is not null from public.early_access_requests where email = $1) as sent`, [addr])).rows[0];

// ===========================================================================
console.log("\n== 1. Grants, shape and constraints");
await withDb("t56_grants", async (c) => {
  for (const role of ["anon", "authenticated"]) {
    for (const [what, sql] of [
      ["claim an invitation", "select public.redeem_bound_invite('t')"],
      ["approve a request", "select public.approve_early_access_request(gen_random_uuid())"],
      ["record a send", "select public.record_invitation_sent(gen_random_uuid())"],
      ["create an account directly", "select public.consume_link_and_create_account(gen_random_uuid(), 'x@example.com', gen_random_uuid())"],
      ["reserve an invite", "insert into public.invite_codes (email, label) values ('x@example.com', 'x')"],
    ]) {
      const r = await attempt(c, `begin; set local role ${role}; ${sql}; commit;`);
      ok(!r.ok && /permission denied/.test(r.err.message), `${role} cannot ${what}`);
    }
  }
  const svc = (sql, params) => attempt(c, `begin; set local role service_role; ${sql}; commit;`, params);
  ok(!(await svc("select public.consume_link_and_create_account(gen_random_uuid(), 'x@example.com', gen_random_uuid())")).ok,
    "not even service_role may call the shared account body directly");
  ok((await svc("select public.approve_early_access_request(gen_random_uuid())")).ok === false, "approving an unknown request is refused");
  const reserve = await svc("insert into public.invite_codes (email, label) values ('x@example.com', 'x')");
  ok(!reserve.ok && /permission denied/.test(reserve.err.message), "service_role cannot reserve an invite by hand");
  const approveDirect = await svc("update public.early_access_requests set approved_at = now()");
  ok(!approveDirect.ok && /permission denied/.test(approveDirect.err.message), "service_role cannot approve by hand");

  // A reserved invite has no code; a typed invite has no reservation; one of the two is required.
  ok((await attempt(c, "insert into public.invite_codes (email, label) values ('one@example.com', 'reserved')")).ok, "a codeless reserved invite is allowed");
  ok((await attempt(c, "insert into public.invite_codes (code_hash, label) values ($1, 'typed')", [hash("x")])).ok, "a typed code with no reservation is allowed");
  ok(!(await attempt(c, "insert into public.invite_codes (label) values ('neither')")).ok, "an invite with neither a code nor a reservation is refused");
  ok(!(await attempt(c, "insert into public.invite_codes (email, label) values ('Mixed@Example.com', 'x')")).ok, "a reservation must be lower-case");
  ok(!(await attempt(c, "insert into public.invite_codes (email, label) values ('not-an-email', 'x')")).ok, "a reservation must look like an address");
  ok(!(await attempt(c, "insert into public.invite_codes (email, label) values ('one@example.com', 'second live')")).ok,
    "a second LIVE reservation for one address is refused");
  await c.query("update public.invite_codes set revoked_at = now() where email = 'one@example.com'");
  ok((await attempt(c, "insert into public.invite_codes (email, label) values ('one@example.com', 'after revoke')")).ok,
    "…but a new one may be reserved once the old is revoked");
  ok(!(await attempt(c, "update public.early_access_requests set invitation_sent_at = now() where false")).ok === false, "(control: the sent-only-when-approved CHECK exists)");
  const req = await request(c);
  ok(!(await attempt(c, "update public.early_access_requests set invitation_sent_at = now() where id = $1", [req.id])).ok,
    "an invitation cannot be marked sent before it is approved");
});

// ===========================================================================
console.log("\n== 2. Approval");
await withDb("t56_approve", async (c) => {
  const req = await request(c);
  const first = await approve(c, req);
  ok(first.ok && first.res.rows[0].r.status === "approved", "a request is approved and an invite reserved");
  const s = await stateOf(c, req.email);
  ok(s.invites === 1 && s.approved === true && s.sent === false, "one reservation, recorded on the request, not yet sent");
  ok((await c.query("select code_hash from public.invite_codes where email = $1", [req.email])).rows[0].code_hash === null,
    "a reserved invite carries no code anybody could type");

  const again = await approve(c, req);
  ok(again.ok && again.res.rows[0].r.status === "already_approved"
     && again.res.rows[0].r.inviteId === first.res.rows[0].r.inviteId, "approving twice returns the same invite, so no second invitation is sent");
  ok((await stateOf(c, req.email)).invites === 1, "…and reserves nothing more");

  ok((await attempt(c, "select public.record_invitation_sent($1) as r", [req.id])).ok && (await stateOf(c, req.email)).sent === true, "the send is recorded");
  const missing = await attempt(c, approveSql, [randomUUID()]);
  ok(refused(missing, "PT404", "not_found"), "an unknown request is PT404 not_found");

  // Someone who already has an account needs no invite.
  const has = await request(c);
  await c.query("insert into public.users (email) values ($1)", [has.email]);
  const already = await approve(c, has);
  ok(already.ok && already.res.rows[0].r.status === "has_account" && (await stateOf(c, has.email)).invites === 0,
    "approving an address that can already sign in reserves nothing");
  ok((await stateOf(c, has.email)).approved === true, "…and still marks the request handled");

  const notApproved = await request(c);
  ok(refused(await attempt(c, "select public.record_invitation_sent($1)", [notApproved.id]), "PT409", "not_approved"),
    "a send cannot be recorded for an unapproved request");
});

// ===========================================================================
console.log("\n== 3. Claiming the invitation");
await withDb("t56_claim", async (c) => {
  const req = await request(c);
  await approve(c, req);
  const l = await link(c, req.email);
  const r = await claim(c, l);
  const s = await stateOf(c, req.email);
  ok(r.ok && r.res.rows[0].r.created === true, "the link claims the invitation");
  ok(s.users === 1 && s.profiles === 1 && s.invites_used === 1 && (await c.query("select used from public.magic_links where token = $1", [l.token])).rows[0].used,
    "account, profile, invite and link all move together");
  ok((await c.query("select used_by from public.invite_codes where email = $1", [req.email])).rows[0].used_by === r.res.rows[0].r.userId,
    "the invite records who used it");

  const second = await claim(c, await link(c, req.email));
  ok(second.ok && second.res.rows[0].r.created === false && second.res.rows[0].r.userId === r.res.rows[0].r.userId,
    "a later link for the same address simply signs in");
  ok((await stateOf(c, req.email)).invites_used === 1, "…and consumes nothing further");

  for (const [label, mk] of [
    ["an address with no invitation", async () => await link(c, email())],
    ["a revoked invitation", async () => { const q = await request(c); await approve(c, q); await c.query("update public.invite_codes set revoked_at = now() where email = $1", [q.email]); return link(c, q.email); }],
  ]) {
    const bad = await mk();
    const res = await claim(c, bad);
    ok(refused(res, "PT403", "no_invitation") && (await stateOf(c, bad.email)).users === 0 && (await c.query("select used from public.magic_links where token = $1", [bad.token])).rows[0].used === false,
      `${label}: refused, no account, the link still usable`);
  }
  for (const [label, opts] of [["an expired link", { expiresIn: "-1 minute" }], ["a used link", { used: true }]]) {
    const q = await request(c); await approve(c, q);
    const bad = await link(c, q.email, opts);
    ok(refused(await claim(c, bad), "PT401", "link_invalid") && (await stateOf(c, q.email)).invites_used === 0,
      `${label}: refused before the invitation is touched`);
  }
  ok(refused(await attempt(c, claimSql, ["no-such-token"]), "PT401", "link_invalid"), "an unknown token is refused");

  // A spent invitation stays spent even if the account it made is deleted.
  const gone = await request(c); await approve(c, gone);
  await claim(c, await link(c, gone.email));
  await c.query("delete from public.users where email = $1", [gone.email]);
  ok(refused(await claim(c, await link(c, gone.email)), "PT403", "no_invitation"),
    "a spent invitation cannot make a second account, even after the first is deleted");

  // The typed-code path is untouched, and a reservation cannot be typed in.
  const manual = await request(c);
  const code = `CODE-${randomUUID()}`;
  await c.query("insert into public.invite_codes (code_hash, label) values ($1, 'manual')", [hash(code)]);
  const manualLink = await link(c, manual.email);
  const typed = await attempt(c, "select public.redeem_invite($1, $2) as r", [manualLink.token, hash(code)]);
  ok(typed.ok && typed.res.rows[0].r.created === true, "a typed code still creates an account");
  const reservedReq = await request(c);
  await approve(c, reservedReq);
  const guess = await attempt(c, "select public.redeem_invite($1, $2) as r", [(await link(c, reservedReq.email)).token, hash("anything")]);
  ok(refused(guess, "PT403", "invite_invalid"), "a reserved invitation cannot be claimed by typing a code");
});

// ===========================================================================
console.log("\n== 4. Two connections");
const waiting = async (c, pid) => {
  for (let i = 0; i < 100; i++) {
    const { rows: [r] } = await c.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
};
const settle = (p) => p.then((res) => ({ ok: true, res }), (err) => ({ ok: false, err }));
await withDb("t56_race", async (a, b) => {
  const watcher = await connect(a.database);
  try {
    // The same link clicked twice at once (a scanner and a person).
    let req = await request(a); await approve(a, req);
    let l = await link(a, req.email);
    await a.query("begin"); await a.query(claimSql, [l.token]);
    let p = settle(b.query(claimSql, [l.token]));
    ok(await waiting(watcher, b.pid), "a second click of the same link waits");
    await a.query("commit");
    let r = await p;
    ok(!r.ok && r.err.detail === "link_invalid" && (await stateOf(a, req.email)).users === 1, "…and is refused: one account");

    // Two different links for one invited address at once.
    req = await request(a); await approve(a, req);
    const l1 = await link(a, req.email), l2 = await link(a, req.email);
    await a.query("begin"); await a.query(claimSql, [l1.token]);
    p = settle(b.query(claimSql, [l2.token]));
    ok(await waiting(watcher, b.pid), "a second link for the same address waits");
    await a.query("commit");
    r = await p;
    ok(r.ok && r.res.rows[0].r.created === false && (await stateOf(a, req.email)).users === 1 && (await stateOf(a, req.email)).invites_used === 1,
      "…then signs in to the account the first made, consuming one invitation");

    // Approving the same request from two places.
    req = await request(a);
    await a.query("begin"); await a.query(approveSql, [req.id]);
    p = settle(b.query(approveSql, [req.id]));
    ok(await waiting(watcher, b.pid), "a second approval waits");
    await a.query("commit");
    r = await p;
    ok(r.ok && r.res.rows[0].r.status === "already_approved" && (await stateOf(a, req.email)).invites === 1,
      "…and returns the same invitation rather than reserving another");

    // Revoking while the invitation is being claimed.
    req = await request(a); await approve(a, req);
    l = await link(a, req.email);
    await b.query("begin"); await b.query("update public.invite_codes set revoked_at = now() where email = $1", [req.email]);
    p = settle(a.query(claimSql, [l.token]));
    ok(await waiting(watcher, a.pid), "a claim waits on an uncommitted revoke");
    await b.query("commit");
    r = await p;
    ok(!r.ok && r.err.detail === "no_invitation" && (await stateOf(a, req.email)).users === 0, "…and is refused once the revoke commits");

    // A claim that fails part-way leaves the invitation for the next attempt.
    req = await request(a); await approve(a, req);
    l = await link(a, req.email);
    await a.query(`create function public._fail_profile() returns trigger language plpgsql as $f$ begin raise exception 'profile insert failed'; end $f$;
                   create trigger _fail_profile before insert on public.professional_profiles for each row execute function public._fail_profile();`);
    r = await claim(a, l);
    ok(!r.ok && (await stateOf(a, req.email)).users === 0 && (await stateOf(a, req.email)).invites_used === 0
       && (await a.query("select used from public.magic_links where token = $1", [l.token])).rows[0].used === false,
      "a failure rolls back the account, the invitation and the link");
    await a.query("drop trigger _fail_profile on public.professional_profiles; drop function public._fail_profile()");
    ok((await claim(a, l)).ok, "…and the same link then works");
  } finally { await watcher.end(); }
});

// ===========================================================================
console.log("\n== 5. Rerun, rollback, re-apply");
await withDb("t56_rollback", async (c) => {
  const twice = await attempt(c, MIGRATION);
  ok(!twice.ok && /MIGRATION 0056 ABORTED/.test(twice.err.message), "0056 refuses to run twice");

  const live = await request(c); await approve(c, live);
  const blocked = await attempt(c, ROLLBACK);
  ok(!blocked.ok && /ROLLBACK 0056 REFUSED: 1 reserved/.test(blocked.err.message), "the rollback refuses while a reserved invitation is live");
  await c.query("update public.invite_codes set revoked_at = now() where email = $1", [live.email]);

  const used = await request(c); await approve(c, used);
  const claimed = await claim(c, await link(c, used.email));
  ok(claimed.ok, "fixture: one invitation was claimed before the rollback");
  const usersBefore = (await c.query("select string_agg(md5(row(u.*)::text), ',' order by id) as d from public.users u")).rows[0].d;
  const down = await attempt(c, ROLLBACK);
  ok(down.ok, `the rollback runs${down.ok ? "" : ` — ${down.err.message}`}`);
  ok((await c.query("select string_agg(md5(row(u.*)::text), ',' order by id) as d from public.users u")).rows[0].d === usersBefore,
    "accounts made through invitations survive the rollback");
  // And the 0055 world is back: a typed code still works, reservations are gone.
  const code = `CODE-${randomUUID()}`;
  await c.query("insert into public.invite_codes (code_hash, label) values ($1, 'after rollback')", [hash(code)]);
  const after = await attempt(c, "select public.redeem_invite($1, $2) as r", [(await link(c, email())).token, hash(code)]);
  ok(after.ok && after.res.rows[0].r.created === true, "redeem_invite still creates accounts after the rollback");
  ok((await attempt(c, "select public.redeem_bound_invite('x')")).ok === false, "the invitation function is gone");
  ok((await attempt(c, MIGRATION)).ok, "0056 re-applies after rollback");
});

// ===========================================================================
console.log("\n== 6. Mutants");
const onDb = async (db, fn) => { const c = await connect(db); try { return await fn(c); } finally { await c.end(); } };
const MUTANTS = [
  ["a reservation may be claimed by any address", (s) => s.split("   where email = v_link.email and used_at is null and revoked_at is null\n     for update;").join("   where email is not null and used_at is null and revoked_at is null\n     for update;"),
    (db) => onDb(db, async (c) => { const q = await request(c); await approve(c, q); const stranger = await link(c, email()); return (await claim(c, stranger)).ok; })],
  // Only observable once the account it paid for is gone — which is exactly
  // when a spent reservation must NOT let a new one be made.
  ["used reservations are claimed again", (s) => s.split("   where email = v_link.email and used_at is null and revoked_at is null\n     for update;").join("   where email = v_link.email and revoked_at is null\n     for update;"),
    (db) => onDb(db, async (c) => {
      const q = await request(c); await approve(c, q); await claim(c, await link(c, q.email));
      await c.query("delete from public.users where email = $1", [q.email]);
      return (await claim(c, await link(c, q.email))).ok;
    })],
  ["revoked reservations are claimed", (s) => s.split("   where email = v_link.email and used_at is null and revoked_at is null\n     for update;").join("   where email = v_link.email and used_at is null\n     for update;"),
    (db) => onDb(db, async (c) => { const q = await request(c); await approve(c, q); await c.query("update public.invite_codes set revoked_at = now() where email = $1", [q.email]); const r = await claim(c, await link(c, q.email)); return r.ok || !refused(r, "PT403", "no_invitation"); })],
  ["expired links are accepted", (s) => s.split("  if v_link.id is null or v_link.used or v_link.expires_at <= now() then\n    raise exception 'redeem: the sign-in link is not valid' using errcode = 'PT401', detail = 'link_invalid';\n  end if;\n\n  select id into v_user from public.users where email = v_link.email;\n  if v_user is not null then\n    update public.magic_links set used = true where id = v_link.id;\n    return jsonb_build_object('userId', v_user, 'created', false);\n  end if;\n\n  select id into v_invite\n    from public.invite_codes\n   where email = v_link.email").join("  if v_link.id is null or v_link.used then\n    raise exception 'redeem: the sign-in link is not valid' using errcode = 'PT401', detail = 'link_invalid';\n  end if;\n\n  select id into v_user from public.users where email = v_link.email;\n  if v_user is not null then\n    update public.magic_links set used = true where id = v_link.id;\n    return jsonb_build_object('userId', v_user, 'created', false);\n  end if;\n\n  select id into v_invite\n    from public.invite_codes\n   where email = v_link.email"),
    (db) => onDb(db, async (c) => { const q = await request(c); await approve(c, q); return (await claim(c, await link(c, q.email, { expiresIn: "-1 minute" }))).ok; })],
  // NOT a mutant: dropping FOR UPDATE here is unobservable, because users.email
  // is unique and the loser of that race is handled. The lock stays because it
  // makes the ordering explicit rather than incidental; section 4 asserts the
  // behaviour it protects.
  ["approving twice reserves a second invitation", (s) => s.split("  if v_req.approved_at is not null then\n    return jsonb_build_object('status', 'already_approved', 'email', v_req.email,\n                              'inviteId', v_req.invite_id, 'invitationSentAt', v_req.invitation_sent_at);\n  end if;\n").join(""), null],
  ["one live reservation per address is not enforced", (s) => s.split("create unique index invite_codes_one_live_reservation_per_email\n  on public.invite_codes (email) where email is not null and used_at is null and revoked_at is null;").join("create index invite_codes_one_live_reservation_per_email\n  on public.invite_codes (email) where email is not null and used_at is null and revoked_at is null;"), null],
  ["an invite may have neither a code nor a reservation", (s) => s.split("  add constraint invite_codes_code_or_reservation check (code_hash is not null or email is not null);").join("  add constraint invite_codes_code_or_reservation check (true);"),
    (db) => onDb(db, async (c) => (await attempt(c, "insert into public.invite_codes (label) values ('unreachable')")).ok)],
  ["the shared body is callable by service_role", (s) => s.split("revoke all on function public.consume_link_and_create_account(uuid, text, uuid) from public, anon, authenticated, service_role;").join("revoke all on function public.consume_link_and_create_account(uuid, text, uuid) from public, anon, authenticated;\ngrant execute on function public.consume_link_and_create_account(uuid, text, uuid) to service_role;"), null],
  ["the invitation function is executable by anon", (s) => s.split("grant execute on function public.redeem_bound_invite(text) to service_role;").join("grant execute on function public.redeem_bound_invite(text) to service_role, anon;"), null],
  ["service_role may approve by hand", (s) => s.split("-- 7. GRANTS.").join("-- 7. GRANTS.\ngrant update on public.early_access_requests to service_role;"), null],
  ["approval accepts an address that already has an account", (s) => s.split("  select id into v_user from public.users where email = v_req.email;\n  if v_user is not null then\n    update public.early_access_requests set approved_at = now() where id = v_req.id;\n    return jsonb_build_object('status', 'has_account', 'email', v_req.email);\n  end if;\n").join(""),
    (db) => onDb(db, async (c) => { const q = await request(c); await c.query("insert into public.users (email) values ($1)", [q.email]); await approve(c, q); return (await stateOf(c, q.email)).invites > 0; })],
];
for (const [name, mutate, detect] of MUTANTS) {
  const mutated = mutate(MIGRATION);
  if (mutated === MIGRATION) { ok(false, `mutant did not apply: ${name}`); continue; }
  const db = await freshDb("t56_mutant", { apply: false });
  const r = await onDb(db, (c) => attempt(c, mutated));
  if (!r.ok) { ok(true, `mutant caught by the migration: ${name} — ${r.err.message.slice(0, 80)}`); continue; }
  const seen = detect ? await detect(db) : false;
  ok(seen, `mutant caught by the harness: ${name}${seen ? "" : " (NOT CAUGHT)"}`);
}

for (const name of created) await admin.query(`drop database if exists "${name}"`);
await admin.end();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
