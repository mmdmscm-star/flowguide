// 0055 against real PostgreSQL 17: single-use invite codes and atomic account creation.
//
// Local harness only (README.md).
//
//   scripts/pg-harness/harness.sh replay pre0055 0054
//   node scripts/pg-harness/test-0055.mjs [path/to/0055.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0055_early_access.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0055_early_access_down.sql"), "utf8");
const TEMPLATE = "pre0055";

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
async function withDb(name, fn, opts) {
  const db = await freshDb(name, opts);
  const conns = await Promise.all([connect(db), connect(db)]);
  try { await fn(...conns); } finally { await Promise.all(conns.map((x) => x.end())); }
}

const hash = (code) => createHash("sha256").update(code, "utf8").digest("hex");
async function invite(c, label = "harness") {
  const code = `CODE-${randomUUID()}`;
  const { rows: [r] } = await c.query("insert into public.invite_codes (code_hash, label) values ($1, $2) returning id", [hash(code), label]);
  return { id: r.id, code, hash: hash(code) };
}
async function link(c, email = `new-${randomUUID()}@example.com`, { expiresIn = "10 minutes", used = false } = {}) {
  const token = randomUUID();
  await c.query(`insert into public.magic_links (email, token, expires_at, used) values ($1, $2, now() + $3::interval, $4)`, [email, token, expiresIn, used]);
  return { email, token };
}
const redeemSql = "select public.redeem_invite($1, $2) as r";
const redeem = (c, l, codeHash) => attempt(c, redeemSql, [l.token, codeHash]);
const refused = (r, code, detail) => !r.ok && r.err.code === code && r.err.detail === detail;
const state = async (c, inv, l) => (await c.query(`select
    (select count(*)::int from public.users where email = $3) as users,
    (select count(*)::int from public.professional_profiles where email = $3) as profiles,
    (select used_at is not null from public.invite_codes where id = $1) as invite_used,
    (select used_by from public.invite_codes where id = $1) as used_by,
    (select used from public.magic_links where token = $2) as link_used`, [inv.id, l.token, l.email])).rows[0];

// ===========================================================================
console.log("\n== 1. Grants and catalog");
await withDb("t55_grants", async (c) => {
  for (const role of ["anon", "authenticated"]) {
    for (const [what, sql] of [
      ["read invites", "select * from public.invite_codes"],
      ["insert an invite", `insert into public.invite_codes (code_hash, label) values ('${"a".repeat(64)}', 'x')`],
      ["read requests", "select * from public.early_access_requests"],
      ["insert a request", "insert into public.early_access_requests (name, email, use_case) values ('n', 'n@example.com', 'u')"],
      ["redeem", `select public.redeem_invite('t', '${"a".repeat(64)}')`],
    ]) {
      const r = await attempt(c, `begin; set local role ${role}; ${sql}; commit;`);
      ok(!r.ok && /permission denied/.test(r.err.message), `${role} cannot ${what}`);
    }
  }
  const inv = await invite(c);
  const svc = async (sql) => attempt(c, `begin; set local role service_role; ${sql}; commit;`);
  ok((await svc(`insert into public.invite_codes (code_hash, label) values ('${"b".repeat(64)}', 'svc')`)).ok, "service_role can create an invite (hash + label)");
  ok((await svc(`select id, label, used_at, revoked_at from public.invite_codes`)).ok, "service_role can list invites");
  ok((await svc(`update public.invite_codes set revoked_at = now() where id = '${inv.id}'`)).ok, "service_role can revoke");
  const markUsed = await svc(`update public.invite_codes set used_at = now() where id = '${(await invite(c)).id}'`);
  ok(!markUsed.ok && /permission denied/.test(markUsed.err.message), "service_role cannot mark an invite used directly");
  const del = await svc(`delete from public.invite_codes where id = '${inv.id}'`);
  ok(!del.ok && /permission denied/.test(del.err.message), "service_role cannot delete invites");
  const chosenId = await svc(`insert into public.invite_codes (id, code_hash, label) values (gen_random_uuid(), '${"c".repeat(64)}', 'x')`);
  ok(!chosenId.ok, "service_role cannot write columns beyond hash and label");
  ok((await svc(`insert into public.early_access_requests (name, email, use_case) values ('Jo', 'jo@example.com', 'Venue lists')`)).ok, "service_role can store a request");
  ok((await svc(`delete from public.early_access_requests where email = 'jo@example.com'`)).ok, "service_role can delete a request");
  const updReq = await svc(`update public.early_access_requests set name = 'x'`);
  ok(!updReq.ok && /permission denied/.test(updReq.err.message), "requests cannot be edited");
  const svcRedeem = await attempt(c, `begin; set local role service_role; select public.redeem_invite('${(await link(c)).token}', '${(await invite(c)).hash}'); commit;`);
  ok(svcRedeem.ok, `service_role can redeem${svcRedeem.ok ? "" : ` — ${svcRedeem.err.message}`}`);

  for (const [what, sql] of [
    ["a plaintext code", `insert into public.invite_codes (code_hash, label) values ('SEND-ABCDE-FGHJK', 'x')`],
    ["an empty label", `insert into public.invite_codes (code_hash, label) values ('${"d".repeat(64)}', '  ')`],
    ["a duplicate hash", `insert into public.invite_codes (code_hash, label) values ('${"b".repeat(64)}', 'dup')`],
    ["a request with a malformed email", `insert into public.early_access_requests (name, email, use_case) values ('n', 'not-an-email', 'u')`],
    ["a request with an empty use case", `insert into public.early_access_requests (name, email, use_case) values ('n', 'n@example.com', '')`],
    ["a request with a 2001-character use case", `insert into public.early_access_requests (name, email, use_case) values ('n', 'n@example.com', repeat('x', 2001))`],
  ]) {
    ok(!(await attempt(c, sql)).ok, `the table refuses ${what}`);
  }
  const job = (await c.query("select schedule, command, active from cron.job where jobname = 'sendset-purge-early-access-requests'")).rows[0];
  ok(job?.active && /delete from public\.early_access_requests where created_at < now\(\) - interval '90 days'/.test(job.command), "the 90-day purge is scheduled");
  await c.query("insert into public.early_access_requests (name, email, use_case, created_at) values ('old', 'old@example.com', 'u', now() - interval '91 days'), ('new', 'new@example.com', 'u', now() - interval '89 days')");
  await c.query(job.command);
  const left = (await c.query("select array_agg(name order by name) as n from public.early_access_requests where email in ('old@example.com', 'new@example.com')")).rows[0].n;
  ok(JSON.stringify(left) === JSON.stringify(["new"]), "the purge deletes requests older than 90 days and keeps newer ones");
});

// ===========================================================================
console.log("\n== 2. Redemption");
await withDb("t55_redeem", async (c) => {
  const inv = await invite(c), l = await link(c);
  const r = await redeem(c, l, inv.hash);
  const s = await state(c, inv, l);
  ok(r.ok && r.res.rows[0].r.created === true, "a valid code and link create an account");
  ok(s.users === 1 && s.profiles === 1 && s.invite_used && s.used_by === r.res.rows[0].r.userId && s.link_used, "user, empty profile, invite used by that user, link used — together");

  const again = await redeem(c, await link(c), inv.hash);
  ok(refused(again, "PT403", "invite_invalid"), "the same code refused for a second new email");

  const existing = await link(c, l.email);
  const signIn = await redeem(c, existing, "not-even-a-hash");
  ok(signIn.ok && signIn.res.rows[0].r.created === false && signIn.res.rows[0].r.userId === r.res.rows[0].r.userId,
    "an email that already has an account signs in, whatever code is sent");
  const spare = await invite(c);
  const existing2 = await link(c, l.email);
  await redeem(c, existing2, spare.hash);
  ok(!(await state(c, spare, existing2)).invite_used, "…and a valid code sent with it is not consumed");

  for (const [label, mk] of [
    ["unknown code", async () => hash("never-issued")],
    ["malformed hash", async () => "abc"],
    ["null code", async () => null],
    ["revoked code", async () => { const x = await invite(c); await c.query("update public.invite_codes set revoked_at = now() where id = $1", [x.id]); return x.hash; }],
  ]) {
    const nl = await link(c);
    const res = await attempt(c, redeemSql, [nl.token, await mk()]);
    const after = (await c.query("select (select count(*)::int from public.users where email = $1) as users, (select used from public.magic_links where token = $2) as used", [nl.email, nl.token])).rows[0];
    ok(refused(res, "PT403", "invite_invalid") && after.users === 0 && after.used === false,
      `${label}: refused with the same answer, no account, the link still usable for a retry`);
  }

  for (const [label, opts] of [["expired link", { expiresIn: "-1 minute" }], ["used link", { used: true }]]) {
    const good = await invite(c);
    const bad = await link(c, undefined, opts);
    const res = await redeem(c, bad, good.hash);
    ok(refused(res, "PT401", "link_invalid") && !(await state(c, good, bad)).invite_used && (await state(c, good, bad)).users === 0,
      `${label}: refused before any code is consumed`);
  }
  const unknownLink = await redeem(c, { token: "no-such-token", email: "x@example.com" }, (await invite(c)).hash);
  ok(refused(unknownLink, "PT401", "link_invalid"), "an unknown link token is refused");

  // Revoking only an unused invite.
  const used = inv;
  const rev = await attempt(c, "update public.invite_codes set revoked_at = now() where id = $1", [used.id]);
  ok(!rev.ok && /invite_codes_used_or_revoked/.test(rev.err.message), "a used invite cannot also be revoked");
});

// ===========================================================================
console.log("\n== 3. A failed signup never burns a code");
await withDb("t55_failure", async (c) => {
  const inv = await invite(c), l = await link(c);
  await c.query(`create function public._fail_profile() returns trigger language plpgsql as $f$ begin raise exception 'profile insert failed'; end $f$;
                 create trigger _fail_profile before insert on public.professional_profiles for each row execute function public._fail_profile();`);
  const r = await redeem(c, l, inv.hash);
  const s = await state(c, inv, l);
  ok(!r.ok && /profile insert failed/.test(r.err.message) && s.users === 0 && !s.invite_used && s.link_used === false,
    "a failure after the user insert rolls back the user, the invite and the link");
  await c.query("drop trigger _fail_profile on public.professional_profiles; drop function public._fail_profile()");
  const retry = await redeem(c, l, inv.hash);
  ok(retry.ok && retry.res.rows[0].r.created, "the same link and code then succeed");
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
await withDb("t55_race", async (a, b) => {
  const watcher = await connect(a.database);
  try {
    // One code, two new people at once.
    let inv = await invite(a); let la = await link(a), lb = await link(a);
    await a.query("begin"); await a.query(redeemSql, [la.token, inv.hash]);
    let p = settle(b.query(redeemSql, [lb.token, inv.hash]));
    ok(await waiting(watcher, b.pid), "a second redemption of the same code waits on the first");
    await a.query("commit");
    let r = await p;
    ok(!r.ok && r.err.detail === "invite_invalid", "…and is refused once the first commits");
    const count = (await a.query("select count(*)::int as n from public.users where email in ($1, $2)", [la.email, lb.email])).rows[0].n;
    ok(count === 1, "exactly one account from one code");

    // The first attempt fails: the second gets the code.
    inv = await invite(a); la = await link(a); lb = await link(a);
    await a.query("begin"); await a.query(redeemSql, [la.token, inv.hash]);
    p = settle(b.query(redeemSql, [lb.token, inv.hash]));
    ok(await waiting(watcher, b.pid), "a redemption waits on one that has not finished");
    await a.query("rollback");
    r = await p;
    ok(r.ok && r.res.rows[0].r.created && (await state(a, inv, lb)).used_by === r.res.rows[0].r.userId, "…and succeeds when the first rolls back: an unfinished signup does not burn the code");

    // One new email, two links, two codes, at once.
    const email = `same-${randomUUID()}@example.com`;
    const inv1 = await invite(a), inv2 = await invite(a);
    la = await link(a, email); lb = await link(a, email);
    await a.query("begin"); await a.query(redeemSql, [la.token, inv1.hash]);
    p = settle(b.query(redeemSql, [lb.token, inv2.hash]));
    ok(await waiting(watcher, b.pid), "a second signup for the same email waits on the first");
    await a.query("commit");
    r = await p;
    const users = (await a.query("select count(*)::int as n from public.users where email = $1", [email])).rows[0].n;
    ok(r.ok && r.res.rows[0].r.created === false && users === 1, "…then signs in to the account the first created");
    ok((await state(a, inv1, la)).invite_used && !(await state(a, inv2, lb)).invite_used, "…consuming only the first code");

    // The same link in two tabs at once.
    inv = await invite(a); la = await link(a);
    const inv3 = await invite(a);
    await a.query("begin"); await a.query(redeemSql, [la.token, inv.hash]);
    p = settle(b.query(redeemSql, [la.token, inv3.hash]));
    ok(await waiting(watcher, b.pid), "the same link redeemed twice at once waits");
    await a.query("commit");
    r = await p;
    ok(!r.ok && r.err.detail === "link_invalid" && !(await state(a, inv3, la)).invite_used, "…and the second is refused without touching its code");

    // Revoking while a redemption is in flight.
    inv = await invite(a); la = await link(a);
    await b.query("begin"); await b.query("update public.invite_codes set revoked_at = now() where id = $1", [inv.id]);
    p = settle(a.query(redeemSql, [la.token, inv.hash]));
    ok(await waiting(watcher, a.pid), "a redemption waits on an uncommitted revoke");
    await b.query("commit");
    r = await p;
    ok(!r.ok && r.err.detail === "invite_invalid", "…and is refused once the revoke commits");
  } finally { await watcher.end(); }
});

// ===========================================================================
console.log("\n== 5. Rerun, rollback, re-apply");
await withDb("t55_rollback", async (c) => {
  const twice = await attempt(c, MIGRATION);
  ok(!twice.ok && /MIGRATION 0055 ABORTED/.test(twice.err.message), "0055 refuses to run twice");
  const inv = await invite(c), l = await link(c);
  await redeem(c, l, inv.hash);
  const outstanding = await invite(c);
  const blocked = await attempt(c, ROLLBACK);
  ok(!blocked.ok && /ROLLBACK 0055 REFUSED: 1 unused/.test(blocked.err.message), "the rollback refuses while an unused invite exists");
  await c.query("update public.invite_codes set revoked_at = now() where id = $1", [outstanding.id]);
  const usersBefore = (await c.query("select string_agg(md5(row(u.*)::text), ',' order by id) as d from public.users u")).rows[0].d;
  const down = await attempt(c, ROLLBACK);
  const usersAfter = (await c.query("select string_agg(md5(row(u.*)::text), ',' order by id) as d from public.users u")).rows[0].d;
  ok(down.ok && usersBefore === usersAfter, "rollback drops 0055 and leaves accounts created through invites intact");
  ok((await c.query("select count(*)::int as n from cron.job where jobname = 'sendset-purge-early-access-requests'")).rows[0].n === 0, "rollback unschedules the purge");
  const re = await attempt(c, MIGRATION);
  ok(re.ok, `0055 re-applies after rollback${re.ok ? "" : ` — ${re.err.message}`}`);
});
await withDb("t55_pre", async (c) => {
  await c.query("create table public.invite_codes (id int)");
  const r = await attempt(c, MIGRATION);
  ok(!r.ok && /already exists/.test(r.err.message), "0055 refuses to install over an existing invite_codes");
}, { apply: false });

// ===========================================================================
console.log("\n== 6. Mutants: caught by the migration itself or by a targeted check");
const onDb = async (db, fn) => { const c = await connect(db); try { return await fn(c); } finally { await c.end(); } };
const raceDoubleSpend = async (db) => {
  const a = await connect(db), b = await connect(db);
  try {
    const inv = await invite(a); const la = await link(a), lb = await link(a);
    await a.query("begin"); await a.query(redeemSql, [la.token, inv.hash]);
    const p = settle(b.query(redeemSql, [lb.token, inv.hash]));
    await new Promise((r) => setTimeout(r, 300));
    await a.query("commit");
    await p;
    return (await a.query("select count(*)::int as n from public.users where email in ($1, $2)", [la.email, lb.email])).rows[0].n > 1;
  } finally { await a.end(); await b.end(); }
};
const MUTANTS = [
  ["no row lock on the invite", (s) => s.split("   where code_hash = p_code_hash and used_at is null and revoked_at is null\n     for update;").join("   where code_hash = p_code_hash and used_at is null and revoked_at is null;"), raceDoubleSpend],
  ["used codes accepted", (s) => s.split("   where code_hash = p_code_hash and used_at is null and revoked_at is null").join("   where code_hash = p_code_hash and revoked_at is null"), null],
  ["revoked codes accepted", (s) => s.split("   where code_hash = p_code_hash and used_at is null and revoked_at is null").join("   where code_hash = p_code_hash and used_at is null"),
    // The used_or_revoked CHECK still stops the write, so no account is created
    // either way; what the mutant loses is the clean, uninformative refusal.
    (db) => onDb(db, async (c) => { const x = await invite(c); await c.query("update public.invite_codes set revoked_at = now() where id = $1", [x.id]);
      const r = await redeem(c, await link(c), x.hash); return r.ok || !refused(r, "PT403", "invite_invalid"); })],
  ["expired links accepted", (s) => s.split("if v_link.id is null or v_link.used or v_link.expires_at <= now() then").join("if v_link.id is null or v_link.used then"),
    (db) => onDb(db, async (c) => (await redeem(c, await link(c, undefined, { expiresIn: "-1 minute" }), (await invite(c)).hash)).ok)],
  ["existing account consumes a code", (s) => s.split("  -- An account already exists: sign in to it. The code is not looked at.\n  select id into v_user from public.users where email = v_link.email;\n  if v_user is not null then\n    update public.magic_links set used = true where id = v_link.id;\n    return jsonb_build_object('userId', v_user, 'created', false);\n  end if;\n").join(""),
    (db) => onDb(db, async (c) => { const l = await link(c); await redeem(c, l, (await invite(c)).hash);
      const l2 = await link(c, l.email); return !(await redeem(c, l2, "not-even-a-hash")).ok; })],
  // NOT a mutant: marking the link used before validating the code is
  // unobservable, because the refusal's exception rolls that write back with
  // everything else. The property is asserted directly in section 2 instead
  // ("the link still usable for a retry").
  ["invite not marked used", (s) => s.split("  update public.invite_codes set used_at = now(), used_by = v_user where id = v_invite;\n").join(""), null],
  ["executable by anon", (s) => s.split("grant execute on function public.redeem_invite(text, text) to service_role;").join("grant execute on function public.redeem_invite(text, text) to service_role, anon;"), null],
  ["service_role may set used_at", (s) => s.split("grant update (revoked_at) on public.invite_codes to service_role;").join("grant update (revoked_at, used_at) on public.invite_codes to service_role;"), null],
  ["SECURITY INVOKER", (s) => s.split("create function public.redeem_invite(p_magic_token text, p_code_hash text) returns jsonb\nlanguage plpgsql security definer").join("create function public.redeem_invite(p_magic_token text, p_code_hash text) returns jsonb\nlanguage plpgsql security invoker"), null],
  ["purge keeps a year", (s) => s.split("interval '90 days'$cron$").join("interval '365 days'$cron$"), null],
  ["no RLS on requests", (s) => s.split("alter table public.early_access_requests enable row level security;\n").join(""), null],
  ["race on email not handled", (s) => s.split("  exception when unique_violation then\n").join("  exception when division_by_zero then\n"),
    async (db) => {
      const a = await connect(db), b = await connect(db);
      try {
        const email = `m-${randomUUID()}@example.com`; const i1 = await invite(a), i2 = await invite(a);
        const la = await link(a, email), lb = await link(a, email);
        await a.query("begin"); await a.query(redeemSql, [la.token, i1.hash]);
        const p = settle(b.query(redeemSql, [lb.token, i2.hash]));
        await new Promise((r) => setTimeout(r, 300));
        await a.query("commit");
        return !(await p).ok;
      } finally { await a.end(); await b.end(); }
    }],
];
for (const [name, mutate, detect] of MUTANTS) {
  const mutated = mutate(MIGRATION);
  if (mutated === MIGRATION) { ok(false, `mutant did not apply: ${name}`); continue; }
  const db = await freshDb("t55_mutant", { apply: false });
  const r = await onDb(db, (c) => attempt(c, mutated));
  if (!r.ok) { ok(true, `mutant caught by the migration: ${name} — ${r.err.message.slice(0, 90)}`); continue; }
  const seen = detect ? await detect(db) : false;
  ok(seen, `mutant caught by the harness: ${name}${seen ? "" : " (NOT CAUGHT)"}`);
}

for (const name of created) await admin.query(`drop database if exists "${name}"`);
await admin.end();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
