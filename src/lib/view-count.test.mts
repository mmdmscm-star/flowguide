// COUNTING PAGE OPENS, HONESTLY.
//
// `packets.viewed` was one-way and binary: 32 of 34 published Sendsets had
// reached true, it could not tell one open from forty, and until 2026-08 the
// professional's own visits set it. 0057 replaces it with an integer.
//
// What these hold is the shape of the thing — the GET writes nothing, the
// browser asks, the owner is excluded twice, the endpoint says nothing about
// whether a slug exists, and no identifier is involved anywhere. The database
// behaviour (atomicity, published-only, Republish, duplicate, the revision
// invariant) is proved against real Postgres in scripts/pg-harness/test-0057.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { viewCountLabel } from "../components/dashboard/dashboard-workspace.tsx";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments stripped: these are about what the code DOES, and a
 *  sentence in a comment must not satisfy one. */
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

const RECIPIENT = codeOf("src/app/p/[slug]/page.tsx");
const PRINT = codeOf("src/app/p/[slug]/print/page.tsx");
const PREVIEW_PAGE = codeOf("src/app/preview/[id]/page.tsx");
const ENDPOINT = codeOf("src/app/api/p/[slug]/view/route.ts");
const BEACON = codeOf("src/components/record-view.tsx");
const DASHBOARD = codeOf("src/components/dashboard/dashboard-workspace.tsx");
const PACKETS_API = codeOf("src/app/api/packets/route.ts");
const DUPLICATE = codeOf("src/app/api/packets/[id]/duplicate/route.ts");
const MIGRATION = raw("supabase/migrations/0057_packet_view_count.sql");

// ---------------------------------------------------------------------------
// THE READ PATH WRITES NOTHING
// ---------------------------------------------------------------------------

test("GET /p/[slug] has no view side effect", () => {
  // The defect this replaces: a page that counted while rendering counted every
  // server-side fetch of the URL, including a messaging app's link preview.
  assert.ok(!/markPacketViewed/.test(RECIPIENT));
  assert.ok(!/markPacketViewed/.test(codeOf("src/lib/queries.ts")),
    "the old write survives in the query layer");
  for (const write of [/\.update\(/, /\.insert\(/, /\.rpc\(/, /\.delete\(/]) {
    assert.doesNotMatch(RECIPIENT, write, "the recipient page writes during render");
  }
  // And the count is not reachable from the page's own data either.
  assert.ok(!/view_count/.test(RECIPIENT), "the recipient page reads the count it must not write");
});

test("the count is asked for by the BROWSER, once per document", () => {
  assert.match(BEACON, /"use client"/, "the beacon runs on the server, where an unfurl fetch would reach it");
  assert.match(BEACON, /method: "POST"/);
  assert.match(BEACON, /\/api\/p\/\$\{encodeURIComponent\(slug\)\}\/view/);
  // AT MOST ONE PER SLUG PER DOCUMENT LIFECYCLE. A module-level Set dies with
  // the tab, so a reload counts again and an incidental remount does not.
  assert.match(BEACON, /^const counted = new Set<string>\(\);$/m,
    "the guard is not module-scoped, so a remount would count again");
  assert.match(BEACON, /if \(counted\.has\(slug\)\) return;\s*counted\.add\(slug\);/,
    "the guard does not run before the request");
  // NOTHING IDENTIFIES A VISITOR. No storage of any kind, in either direction.
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie",
                           "navigator.userAgent", "crypto.randomUUID", "fingerprint"]) {
    assert.ok(!BEACON.includes(forbidden), `the beacon touches ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// WHO IS NOT COUNTED
// ---------------------------------------------------------------------------

test("demos, Preview, print and unavailable pages never mount the beacon", () => {
  for (const [name, src] of [["print", PRINT], ["preview", PREVIEW_PAGE],
                             ["not-found", codeOf("src/app/p/[slug]/not-found.tsx")]] as const) {
    assert.ok(!src.includes("RecordView"), `${name} counts a view`);
  }
  // The recipient page mounts it only for a real published Sendset that is not
  // a demo. An unpublished slug never reaches the mount at all: notFound()
  // returns first.
  assert.match(RECIPIENT, /const countThisOpen = !isPublicDemo\(slug\) && isSupabaseConfigured && !ownedId;/);
  assert.ok(RECIPIENT.indexOf("if (!packet) notFound();") < RECIPIENT.indexOf("countThisOpen"),
    "the page decides to count before it has decided the Sendset exists");
});

test("THE OWNER IS EXCLUDED TWICE, in the page and again at the endpoint", () => {
  // Belt and braces on purpose: the page's decision travels as "did we render
  // the beacon", which a professional could simply ignore by posting directly.
  assert.match(RECIPIENT, /!ownedId/, "the page would count the owner's own visit");
  assert.match(ENDPOINT, /const session = await getSession\(\)/, "the endpoint does not know who is asking");
  assert.match(ENDPOINT, /\.eq\("user_id", session\.userId\)/, "the endpoint does not check ownership");
  const owner = ENDPOINT.slice(ENDPOINT.indexOf("getSession()"));
  assert.ok(owner.indexOf("if (owned) return") < owner.indexOf("record_packet_view"),
    "the owner check runs after the increment");
});

// ---------------------------------------------------------------------------
// WHAT THE ENDPOINT SAYS, AND DOES NOT SAY
// ---------------------------------------------------------------------------

test("the endpoint reveals nothing about whether a slug exists", () => {
  // One response, every time: a real Sendset, a draft, a demo, a slug that
  // never existed, the owner's own visit. Anything else is an oracle.
  assert.match(ENDPOINT, /new NextResponse\(null, \{ status: 204 \}\)/);
  const codes = [...ENDPOINT.matchAll(/status: (\d{3})/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(codes)], ["204"], `the endpoint answers with ${codes.join(", ")}`);
  assert.ok(!/NextResponse\.json/.test(ENDPOINT), "the endpoint returns a body a caller could read");
  // A failure is swallowed, not reported to the recipient's browser.
  assert.match(ENDPOINT, /if \(error\) console\.error/);
});

test("a cross-origin POST is turned away, and is not called security", () => {
  assert.match(ENDPOINT, /sec-fetch-site/, "no same-origin check at all");
  assert.match(ENDPOINT, /origin/, "no Origin fallback");
  // The claim in the file must stay modest. This is abuse reduction, not proof
  // that a view was a person.
  const prose = raw("src/app/api/p/[slug]/view/route.ts");
  assert.match(prose, /not a security boundary|not a defence/i,
    "the same-origin check is described as something it is not");
  assert.ok(!/bots? (do not|don't|cannot) execute/i.test(prose),
    "the file claims automated clients cannot reach it");
});

// ---------------------------------------------------------------------------
// THE NUMBER, AS THE PROFESSIONAL READS IT
// ---------------------------------------------------------------------------

test("0 views / 1 view / N views", () => {
  assert.equal(viewCountLabel(0), "0 views");
  assert.equal(viewCountLabel(1), "1 view");
  assert.equal(viewCountLabel(2), "2 views");
  assert.equal(viewCountLabel(12), "12 views");
  assert.equal(viewCountLabel(101), "101 views");
});

test("the dashboard says views, and claims nothing about people", () => {
  assert.match(DASHBOARD, /viewCountLabel\(packet\.view_count\)/, "the badge is not the count");
  assert.match(PACKETS_API, /status, view_count, created_at/, "the dashboard is not given the count");
  for (const overclaim of ["unique", "visitor", "recipients opened", "people", "engagement", "readers"]) {
    assert.ok(!new RegExp(`\\b${overclaim}\\b`, "i").test(DASHBOARD),
      `the dashboard claims "${overclaim}"`);
  }
  // Zero is shown, not hidden. "No one has opened this yet" is worth reading.
  assert.ok(!/view_count > 0 \?\s*viewCountLabel/.test(DASHBOARD),
    "the count is hidden until it is non-zero");
});

// ---------------------------------------------------------------------------
// THE LEGACY COLUMN IS INERT
// ---------------------------------------------------------------------------

test("`viewed` is no longer read or written by application code", () => {
  const files = ["src/lib/queries.ts", "src/app/p/[slug]/page.tsx", "src/app/api/packets/route.ts",
                 "src/app/api/packets/[id]/duplicate/route.ts",
                 "src/components/dashboard/dashboard-workspace.tsx",
                 "src/app/api/p/[slug]/view/route.ts"];
  for (const f of files) {
    const src = codeOf(f);
    assert.ok(!/\bviewed\b/.test(src), `${f} still reads or writes the legacy column`);
  }
  // It is deliberately NOT dropped yet: reverting the application must leave a
  // working binary badge behind it.
  assert.ok(!/drop column .*viewed/i.test(MIGRATION), "0057 drops the legacy column");
  assert.match(raw("supabase/rollbacks/0057_packet_view_count_down.sql"), /packets\.viewed is gone/,
    "the rollback does not check that the legacy column is still there");
});

test("a duplicate starts at zero, by the column default and nothing else", () => {
  assert.ok(!/view_count/.test(DUPLICATE), "the duplicate route assigns a count");
  assert.ok(!/\bviewed\b/.test(codeOf("src/app/api/packets/[id]/duplicate/route.ts")),
    "the duplicate route still writes the legacy boolean");
  assert.match(MIGRATION, /add column view_count integer not null default 0;/);
});

// ---------------------------------------------------------------------------
// THE MIGRATION'S OWN PROMISES
// ---------------------------------------------------------------------------

test("only the server may increment, and only a published Sendset", () => {
  assert.match(MIGRATION, /security definer set search_path = ''/);
  assert.match(MIGRATION, /update public\.packets\s*\n\s*set view_count = view_count \+ 1/);
  assert.match(MIGRATION, /and status = 'published';/, "an unpublished Sendset could be counted");
  for (const role of ["public", "anon", "authenticated"]) {
    assert.match(MIGRATION, new RegExp(`revoke all on function public\\.record_packet_view\\(text\\) from ${role};`),
      `${role} keeps EXECUTE, which is how a SECURITY DEFINER write becomes public`);
  }
  assert.match(MIGRATION, /grant execute on function public\.record_packet_view\(text\) to service_role;/);
  // 0015 had to remove a policy called "Public can mark packets as viewed".
  // Nothing here may grant anon a write of any kind.
  assert.ok(!/create policy/i.test(MIGRATION), "0057 creates a policy");
});

test("THE HARD INVARIANT is proved inside the migration's own transaction", () => {
  // A view must never make a published Sendset look like it has unpublished
  // changes. Both revision triggers compare explicit column tuples, so a new
  // column is excluded by construction — and "by construction" is exactly what
  // stops being true when someone edits a tuple.
  assert.match(MIGRATION, /a view moved draft_rev/);
  assert.match(MIGRATION, /a view moved content_rev/);
  assert.match(MIGRATION, /draft_rev stopped responding to a real edit/,
    "the invariant would pass even if the trigger stopped working entirely");
  // And the proof cleans up after itself.
  assert.match(MIGRATION, /delete from public\.packets where id = pk;/);
  assert.match(MIGRATION, /delete from public\.users where id = u;/);
});
