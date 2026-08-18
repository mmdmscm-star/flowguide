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
    return /\.(ts|tsx|mts)$/.test(name) && !name.includes(".test.") ? [full] : [];
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
test("the ownership check runs BEFORE the update that publishes", () => {
  const src = read(PUBLISH_ROUTE);
  const check = src.indexOf("loadPacketOwnership(");
  const update = src.indexOf('status: "published"');
  assert.ok(check > 0, "the publish route must recompute ownership");
  assert.ok(update > 0, "the publish route must be the thing that publishes");
  assert.ok(check < update, "a gate after the write is not a gate");
});

test("a throw in the check cannot become a failure to publish", () => {
  // Fail-open is the deliberate posture: a packet whose provenance cannot be
  // read must publish normally rather than be trapped behind a check it can
  // never satisfy. That only holds if the call is actually wrapped.
  const src = read(PUBLISH_ROUTE);
  const check = src.indexOf("loadPacketOwnership(");
  const tryStart = src.lastIndexOf("try {", check);
  const catchAfter = src.indexOf("} catch", check);
  assert.ok(tryStart > 0 && catchAfter > check, "the ownership check must sit inside try/catch");
});

test("publishing has exactly one door, and it is the publish route", () => {
  // Scoped to code that can actually WRITE. A client component setting
  // status: "published" in React state after a successful response is local
  // echo, not a second door — legacy-packet-editor.tsx does exactly that.
  const server = sourceFiles().filter((f) => {
    const rel = f.slice(ROOT.length + 1);
    return rel.startsWith("src/app/api/") || rel.startsWith("src/lib/");
  });
  const writers = server.filter((f) => /status:\s*["']published["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    writers.map((f) => f.slice(ROOT.length + 1)),
    [PUBLISH_ROUTE],
    "a second writer of status='published' would bypass the ownership gate entirely",
  );
});

test("no RPC publishes a packet behind the route's back", () => {
  // The gate cannot live in the database — it needs detectSourceRecords and
  // segmentHash, which are TypeScript — so a SECURITY DEFINER function that set
  // status='published' would be unreachable by it, and unreviewable from src/.
  //
  // Only ASSIGNMENTS count. block_publish_during_ingest (0012) READS
  // new.status = 'published' to decide whether to raise, which is the trigger
  // doing its job, not a second door.
  const dir = join(ROOT, "supabase/migrations");
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, name), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of sql.split(";")) {
      if (!/update\s+(public\.)?packets\b/i.test(stmt)) continue;
      assert.doesNotMatch(
        stmt, /\bset\b[\s\S]*\bstatus\s*=\s*'published'/i,
        `${name} must not publish a packet from inside the database`,
      );
    }
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
