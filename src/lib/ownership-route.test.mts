// Route-level invariants for the ownership gate and its resolution surface.
// Run: node --test src/lib/ownership-route.test.mts
//
// These are properties of the WIRING, not of any function, so they are asserted
// against the route sources the way test-faults.test.mts pins the chunk route's
// call site. Each one is a mistake that type-checks perfectly and that no unit
// test would notice, because the damage is in what the code is connected to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const OWNERSHIP_ROUTE = "src/app/api/packets/[id]/ownership/route.ts";
const PUBLISH_ROUTE = "src/app/api/packets/[id]/publish/route.ts";

/** Every .ts/.tsx file under src/, so "only this route does X" can be asserted
 *  rather than assumed — the previous commit claimed a single publish door by
 *  hand, and a claim like that decays the moment someone adds a file. */
function sourceFiles(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    // iCloud conflict copies ("route 2.ts") are gitignored and never built, so they are not source.
    return /\.(ts|tsx|mts)$/.test(name) && !name.includes(".test.") && !/ \d+\.[a-z]+$/.test(name) ? [full] : [];
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
test("the ownership check runs BEFORE the call that publishes", () => {
  const src = read(PUBLISH_ROUTE);
  const token = src.indexOf('rpc("packet_publish_token"');
  const check = src.indexOf("loadPacketOwnership(");
  const update = src.indexOf('rpc("publish_packet"');
  assert.ok(check > 0, "the publish route must recompute ownership");
  assert.ok(update > 0, "the publish route must be the thing that publishes");
  assert.ok(check < update, "a gate after the write is not a gate");
  // 0052: the token is read BEFORE the gate, so publish_packet can refuse
  // anything that changed after the gate looked.
  assert.ok(token > 0 && token < check, "the publish token must be read before the ownership check");
});

test("a throw in the check publishes nothing and blames nobody", () => {
  // A throw IS the unavailable case. The earlier version of this route swallowed
  // it and published, which is the precise failure the decline/unavailable split
  // exists to prevent: an outage reported as a clean check.
  const src = read(PUBLISH_ROUTE);
  const check = src.indexOf("loadPacketOwnership(");
  const catchAt = src.indexOf("} catch", check);
  assert.ok(catchAt > check, "the ownership check must sit inside try/catch");

  const handler = src.slice(catchAt, catchAt + 600);
  assert.match(handler, /ownership_unavailable/, "a throw must surface as unavailable");
  assert.match(handler, /status: 503/, "and as retryable, not as success");
  assert.doesNotMatch(handler.slice(0, handler.indexOf("return")), /^\s*\}\s*$/m,
    "the catch must not simply fall through to the publish");
});

test("an unavailable check is neither a pass nor an accusation", () => {
  // The invariant, stated as code: a legitimate inability to prove ownership may
  // be nonblocking; a technical failure to PERFORM the check must never
  // masquerade as a successful clean check.
  const src = read(PUBLISH_ROUTE);
  const guard = src.indexOf("ownership.unavailable");
  const update = src.indexOf('rpc("publish_packet"');
  assert.ok(guard > 0, "the publish route must inspect the unavailable state");
  assert.ok(guard < update, "and do so before publishing");

  const branch = src.slice(guard, src.indexOf("ownership.declines", guard));
  assert.match(branch, /503/, "unavailable must be retryable, not a 200 and not a 409");
  assert.doesNotMatch(branch, /findings/, "and must not accuse: there are no findings to show");
});

test("a decline still publishes — it is an answer, not an outage", () => {
  // Blocking on a decline traps every packet imported before 0014, every prose
  // source, and every replaced source behind a check none of them can satisfy.
  const src = read(PUBLISH_ROUTE);
  const declines = src.indexOf("ownership.declines.length > 0");
  const blocking = src.indexOf("ownership.blocking.length > 0");
  assert.ok(declines > 0 && blocking > declines);

  const branch = src.slice(declines, blocking);
  assert.match(branch, /console\.warn/, "a decline is logged");
  assert.doesNotMatch(branch, /return NextResponse/, "and never returned as a refusal");
});

test("publishing has exactly one door, and it is the publish route", () => {
  // Scoped to code that can actually WRITE. A client component setting
  // status: "published" in React state after a successful response is local
  // echo, not a second door — legacy-packet-editor.tsx does exactly that.
  const server = sourceFiles().filter((f) => {
    const rel = f.slice(ROOT.length + 1);
    return rel.startsWith("src/app/api/") || rel.startsWith("src/lib/");
  });
  const rel = (f: string) => f.slice(ROOT.length + 1);
  // 0052: no TypeScript writes a status at all. publish_packet and
  // unpublish_packet own every change, and only the publish route calls them.
  const writers = server.filter((f) => /status:\s*["'](published|draft)["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(writers.map(rel), [], "server code writes a packet status directly");
  for (const fn of ["publish_packet", "unpublish_packet", "packet_publish_token"]) {
    const callers = server.filter((f) => readFileSync(f, "utf8").includes(`rpc("${fn}"`));
    assert.deepEqual(callers.map(rel), [PUBLISH_ROUTE], `${fn} is reachable from somewhere other than the publish route`);
  }
});

test("only publish_packet publishes from the database, and only after binding the gates' verdict", () => {
  // THE PRINCIPLE, not the old literal. The gate is TypeScript (it needs
  // detectSourceRecords and segmentHash), so a database function can never run
  // it. What it CAN do is refuse to publish anything other than what the gate
  // checked: 0052's publish_packet locks the Sendset, recomputes the publish
  // token and compares it with the one the route read before its gates — and
  // only then assigns status = 'published', in the same transaction as the
  // frozen copy. That one function is allowed. Any other assignment is not.
  //
  // Only ASSIGNMENTS count. block_publish_during_ingest READS
  // new.status = 'published' to decide whether to raise, which is a trigger
  // doing its job, not a second door.
  const dir = join(ROOT, "supabase/migrations");
  const PUBLISHER = "0052_publication_infrastructure.sql";
  let publisherSeen = false;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    let sql = readFileSync(join(dir, name), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    if (name === PUBLISHER) {
      const start = sql.indexOf("create function public.publish_packet(");
      const bodyStart = sql.indexOf("as $$", start);
      const end = sql.indexOf("$$;", bodyStart);
      assert.ok(start >= 0 && bodyStart > start && end > bodyStart, "0052 must define publish_packet");
      const body = sql.slice(bodyStart, end);
      const lock = body.search(/from public\.packets where id = p_packet_id for update/);
      const recompute = body.indexOf("v_token := public.packet_publish_token(p_owner, p_packet_id);");
      const compare = body.indexOf("if v_token is distinct from p_expected_token then");
      const firstWrite = body.search(/\b(insert into|update|delete from)\s+public\./i);
      const assign = body.search(/update public\.packets\s+set status = 'published'/);
      assert.ok(lock >= 0 && lock < recompute && recompute < compare, "publish_packet must lock, then recompute, then compare");
      assert.ok(firstWrite > compare, "publish_packet writes nothing before the token comparison");
      assert.ok(assign > compare, "the status assignment comes after the comparison");
      assert.match(sql, /grant execute on function public\.publish_packet\(uuid, uuid, jsonb, smallint, jsonb, jsonb\) to service_role;/);
      assert.doesNotMatch(sql, /grant execute on function public\.publish_packet\([^)]*\) to [^;]*(anon|authenticated|public)/i);
      sql = sql.slice(0, start) + sql.slice(end + 3);    // the one allowed door is checked; scan the rest
      publisherSeen = true;
    }
    for (const stmt of sql.split(";")) {
      if (!/update\s+(public\.)?packets\b/i.test(stmt)) continue;
      assert.doesNotMatch(
        stmt, /\bset\b[\s\S]*\bstatus\s*=\s*'published'/i,
        `${name} publishes a packet outside publish_packet`,
      );
    }
  }
  assert.ok(publisherSeen, `${PUBLISHER} was not found, so the one allowed door was never checked`);
});

test("the database refuses every status change except through the two doors (0053)", () => {
  // The route rule above is about today's source. 0053 makes the database refuse
  // a status change that publish_packet / unpublish_packet did not authorise for
  // that exact Sendset — both directions, and inserts that are not drafts.
  const door = read("supabase/migrations/0053_packet_status_single_door.sql");
  assert.match(door, /create trigger trg_packet_status_single_door\s+before insert or update of status on public\.packets/);
  assert.equal((door.match(/current_setting\('app\.publication_authorized_packet', true\) is distinct from new\.id::text/g) ?? []).length, 2,
    "both the insert and the update branch must bind the authorisation to this Sendset's id");
  assert.match(door, /if tg_op = 'INSERT' then\s+if new\.status is distinct from 'draft'/);
  assert.match(door, /elsif new\.status is distinct from old\.status/, "only publishing, not unpublishing, would be guarded");
  const doors = read("supabase/migrations/0052_publication_infrastructure.sql");
  for (const fn of ["publish_packet", "unpublish_packet"]) {
    const start = doors.indexOf(`create function public.${fn}(`);
    const body = doors.slice(start, doors.indexOf("$$;", doors.indexOf("as $$", start)));
    const set = body.indexOf("perform set_config('app.publication_authorized_packet', p_packet_id::text, true);");
    const write = body.search(/update public\.packets\s+set status/);
    const clear = body.indexOf("perform set_config('app.publication_authorized_packet', '', true);");
    assert.ok(set > 0 && set < write && write < clear, `${fn} must authorise, write the status, then clear the authorisation`);
  }
});

// ---------------------------------------------------------------------------
// The resolution surface
// ---------------------------------------------------------------------------
test("the three RPCs are reachable only from the ownership route", () => {
  // 0016 revokes all three from anon and authenticated, so this route is the
  // whole attack surface. Any other caller is a second policy.
  for (const rpc of ["move_item_photos", "set_item_media_decision", "clear_item_media_decision"]) {
    const callers = sourceFiles().filter((f) => readFileSync(f, "utf8").includes(`"${rpc}"`));
    assert.deepEqual(
      callers.map((f) => f.slice(ROOT.length + 1)),
      [OWNERSHIP_ROUTE],
      `${rpc} must have exactly one call site`,
    );
  }
});

test("a Move destination is re-derived, never taken from the request", () => {
  // The dangerous version of this endpoint accepts toItemId and passes it
  // straight to the RPC. That RPC verifies ownership, draft status and same
  // packet — all of which a stray request satisfies — so it would happily file
  // any photo onto any item in the packet under the banner of fixing ownership.
  const src = read(OWNERSHIP_ROUTE);
  const compare = src.indexOf("proposed.proposedItemId !== toItemId");
  const call = src.indexOf('rpc("move_item_photos"');
  assert.ok(compare > 0, "the destination must be compared against a fresh recompute");
  assert.ok(call > compare, "and compared BEFORE the move is performed");
});

test("undoing a Keep is not gated on a finding being visible", () => {
  // While a Keep stands, its finding is suppressed — that is what a Keep IS. So
  // requiring a current finding to clear one would make every Keep permanent
  // and turn the undo into decoration.
  const src = read(OWNERSHIP_ROUTE);
  const unkeep = src.indexOf('action === "unkeep"');
  const rpc = src.indexOf('rpc("clear_item_media_decision"');
  assert.ok(unkeep > 0 && rpc > unkeep);
  const body = src.slice(unkeep, rpc);
  assert.doesNotMatch(body, /stale_finding/, "the undo must not require a live finding");
  assert.doesNotMatch(body, /availableActions|actions\.includes/, "nor an offered action");
});

test("every write refuses a packet that is no longer a draft", () => {
  const src = read(OWNERSHIP_ROUTE);
  const post = src.indexOf("export async function POST");
  const firstAction = src.indexOf('action === "move"');
  assert.ok(post > 0 && firstAction > post);
  assert.match(
    src.slice(post, firstAction),
    /status !== "draft"/,
    "the draft check must precede every action rather than being repeated per branch",
  );
});

test("neither handler describes a packet the caller does not own", () => {
  const src = read(OWNERSHIP_ROUTE);
  for (const handler of ["export async function GET", "export async function POST"]) {
    const start = src.indexOf(handler);
    assert.ok(start > 0, `${handler} must exist`);
    const owns = src.indexOf("ownedPacket(", start);
    const compute = src.indexOf("currentState(", start);
    assert.ok(owns > start, `${handler} must verify ownership`);
    assert.ok(owns < compute, `${handler} must verify ownership before recomputing anything`);
  }
});


// ---------------------------------------------------------------------------
// Durable reversibility
// ---------------------------------------------------------------------------
test("the editor's decisions surface is the same component as the publish panel", () => {
  // A second surface describing the same findings would drift from this one the
  // first time either changed. The editor mounts the SAME component in a
  // different default state.
  const loader = read("src/components/OwnershipDecisions.tsx");
  assert.match(loader, /from "\.\/OwnershipResolution"/, "must reuse, not fork");

  const files = sourceFiles().filter((f) => /"Keep here"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    files.map((f) => f.slice(ROOT.length + 1)),
    ["src/components/OwnershipResolution.tsx"],
    "exactly one component may describe what can be done about a finding",
  );
});

test("the undo is driven by decisions, not by findings", () => {
  // A Keep suppresses its own finding, so an undo derived from findings can
  // never show one. Reversibility has to hang off the decision rows themselves.
  const panel = read("src/components/OwnershipResolution.tsx");
  assert.match(panel, /state\.kept/, "the kept list must come from server state");
  assert.doesNotMatch(panel, /useState<OwnershipFinding\[\]>/,
    "and must not be reconstructed from what this session happened to do");
});

test("the editor surface appears only when a decision exists", () => {
  const loader = read("src/components/OwnershipDecisions.tsx");
  assert.match(loader, /state\.kept\.length === 0\) return null/,
    "a professional who never kept anything sees no ownership section");
});

test("both editors mount it, so reversibility does not depend on composition mode", () => {
  for (const editor of ["legacy-packet-editor.tsx", "block-packet-editor.tsx"]) {
    const src = read(`src/components/editor/${editor}`);
    assert.match(src, /<OwnershipDecisions packetId=\{packetId\} \/>/, `${editor} must mount it`);
  }
});
// ---------------------------------------------------------------------------
// 0016's privilege boundary, asserted against the migration source.
//
// 0015 existed because access was reachable that nobody had granted on purpose.
// A new table and three SECURITY DEFINER functions are exactly the shape that
// reintroduces it, so these are pinned here as well as inside the migration's
// own verify block — the migration catches it at apply time, this catches it at
// edit time, before anyone pastes anything into a SQL editor.
// ---------------------------------------------------------------------------
const MIGRATION = read("supabase/migrations/0016_ownership_resolution.sql");
const RPCS = ["move_item_photos", "set_item_media_decision", "clear_item_media_decision"];

test("the table is revoked from PUBLIC, not just from anon and authenticated", () => {
  // A privilege held by PUBLIC is held by every role and appears as a grant to
  // neither of those two. Revoking only from them leaves the door open.
  assert.match(MIGRATION, /revoke all on table public\.item_media_decisions from public;/);
  assert.match(MIGRATION, /revoke all on table public\.item_media_decisions from anon, authenticated;/);
});

test("the service role is granted explicitly, not left to default privileges", () => {
  // bypassrls skips POLICIES, not GRANTS. Depending on ALTER DEFAULT PRIVILEGES
  // means the only legitimate caller works or does not depending on how the
  // project was set up — and under the new trust policy that failure is a
  // permanent 503 rather than a visible error.
  assert.match(MIGRATION, /grant select, insert, delete on table public\.item_media_decisions to service_role;/);
});

test("RLS is enabled and the migration adds no policy", () => {
  assert.match(MIGRATION, /alter table public\.item_media_decisions enable row level security;/);
  assert.doesNotMatch(MIGRATION, /create policy/i, "a policy would make rows reachable without a grant");
});

test("every function is revoked from PUBLIC, anon and authenticated", () => {
  // Functions DEFAULT to EXECUTE for PUBLIC. Omitting the revoke does not leave
  // them locked; it leaves them open.
  for (const rpc of RPCS) {
    assert.match(MIGRATION, new RegExp(`revoke all on function public\\.${rpc}\\([^)]*\\) from public;`),
      `${rpc} must be revoked from PUBLIC`);
    assert.match(MIGRATION, new RegExp(`revoke all on function public\\.${rpc}\\([^)]*\\) from anon, authenticated;`),
      `${rpc} must be revoked from anon and authenticated`);
  }
});

test("every function is SECURITY DEFINER with a pinned, empty search_path", () => {
  // An unpinned search_path on a SECURITY DEFINER function is privilege
  // escalation waiting for a schema it did not expect.
  for (const rpc of RPCS) {
    const at = MIGRATION.indexOf(`create or replace function public.${rpc}(`);
    assert.ok(at > 0, `${rpc} must be defined`);
    const body = MIGRATION.slice(at, MIGRATION.indexOf("as $$", at));
    assert.match(body, /security definer/, `${rpc} must be SECURITY DEFINER`);
    assert.match(body, /set search_path = ''/, `${rpc} must pin an empty search_path`);
  }
});

test("the verify block tests privileges by EFFECT, not by grant rows", () => {
  const verify = MIGRATION.slice(MIGRATION.indexOf("do $verify$"));
  assert.match(verify, /has_function_privilege\(/, "function reachability must be tested by effect");
  assert.match(verify, /has_table_privilege\(/, "table reachability must be tested by effect");

  // The original draft read grant rows for anon/authenticated, which passes
  // while both hold everything through PUBLIC. Checked against executable SQL
  // only — the comment explaining that mistake is allowed to name it.
  const sql = verify.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sql, /role_table_grants/,
    "a grant-row search cannot see a privilege held through PUBLIC");
});

test("the verify block checks PUBLIC through the ACL, since it is not a real role", () => {
  // has_*_privilege('public', ...) raises: PUBLIC is a pseudo-role with no
  // pg_roles entry. Grantee OID 0 is how it appears in an ACL.
  const verify = MIGRATION.slice(MIGRATION.indexOf("do $verify$"));
  assert.doesNotMatch(verify, /has_(function|table)_privilege\('public'/,
    "passing 'public' to has_*_privilege makes the migration fail on itself");
  assert.match(verify, /aclexplode/, "PUBLIC must be checked through the ACL");
  assert.match(verify, /grantee = 0/, "grantee 0 is PUBLIC");
  // A NULL proacl means DEFAULT privileges, and functions default to EXECUTE
  // for PUBLIC — so an empty ACL is the dangerous case, not the safe one.
  assert.match(verify, /proacl is null/,
    "a NULL function ACL means PUBLIC can execute, and must fail the check");
});

test("the verify block proves the legitimate caller still works", () => {
  // A lockdown that also locks out the only intended caller is not a success;
  // it is a 503 discovered in production.
  const verify = MIGRATION.slice(MIGRATION.indexOf("do $verify$"));
  assert.match(verify, /has_table_privilege\('service_role'/);
});

// ---------------------------------------------------------------------------
// The acceptance script's own reads.
//
// Its three fixture packets deliberately share one photo url — that is what
// makes "the Move did not reach into the other packets" a real check. The cost
// is that any read of item_photos BY URL alone sees all three at once. That is
// not a hypothetical: it produced a FAIL on a correct Move, whose detail showed
// three rows on three item_ids that turned out to be one per packet.
//
// A false failure on a correct system is worse than no check. It burns the
// run it appears in, and the next person to see it is likelier to loosen the
// assertion than to find the scoping bug.
// ---------------------------------------------------------------------------
test("every photo read in the acceptance script is scoped to known items", () => {
  const script = read("scripts/ingestion-runtime/verify-ownership-gate.mts");
  const reads = script.match(/from\("item_photos"\)[\s\S]{0,240}?;/g) ?? [];
  assert.ok(reads.length > 0, "the script must read item_photos at all");

  for (const r of reads) {
    if (!r.includes(".select(")) continue;   // the fixture INSERT is not a read
    assert.match(r, /\.in\("item_id"/,
      `a photo read scoped only by url spans all three fixture packets:\n${r}`);
  }
});

test("the acceptance script proves the Move stayed inside its own packet", () => {
  // move_item_photos asserts same-packet internally. This is the end-to-end
  // version of that claim, and it is only meaningful because the fixture url is
  // shared — so if someone makes the urls unique per packet to "fix" a scoping
  // bug, this check quietly stops testing anything.
  const script = read("scripts/ingestion-runtime/verify-ownership-gate.mts");
  assert.match(script, /did not reach into the other packets/,
    "the cross-packet non-interference check must exist");
  assert.match(script, /const SOURCE = GATE_SOURCE;/,
    "and it depends on all fixtures sharing one source, hence one photo url");
});


test("the scoping guard would have caught the read that failed", () => {
  // A guard that cannot fail is decoration. This is the exact expression that
  // shipped, checked against the same rule.
  const shipped = 'await svc.from("item_photos")\n      .select("item_id, url").eq("url", PHOTO_A);';
  assert.doesNotMatch(shipped, /\.in\("item_id"/,
    "the original read had no item scoping — the guard must reject it");
});
