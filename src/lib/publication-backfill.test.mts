// The 0054 backfill: the script (scripts/publication-backfill) against an
// in-memory database, and source rules binding the migration to publish_packet.
// Real-Postgres behaviour, concurrency and mutants: scripts/pg-harness/test-0054.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { backfillOne, canonicalJson, identityForLiveRender, listCandidates, rollbackSql } from "../../scripts/publication-backfill/lib.ts";
import { getLiveRowsPublishedPacket } from "./queries.ts";

type Row = Record<string, unknown>;
type Call = { kind: "rpc" | "from"; name: string; args?: Row };

// The query-builder calls the assembly makes, plus rpc, over rows — recording order.
function fakeDb(tables: Record<string, Row[]>, rpc: (name: string, args: Row) => { data?: unknown; error?: unknown }, failing: string[] = []) {
  const calls: Call[] = [];
  const db = {
    calls,
    rpc: async (name: string, args: Row) => { calls.push({ kind: "rpc", name, args }); const r = rpc(name, args); return { data: r.data ?? null, error: r.error ?? null }; },
    from(table: string) {
      calls.push({ kind: "from", name: table });
      let rows = [...(tables[table] ?? [])];
      const fail = failing.includes(table);
      const done = () => fail ? { data: null, error: { message: `${table} unavailable` } } : { data: rows, error: null };
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => { rows = rows.filter((r) => r[col] === v); return q; },
        in: (col: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[col])); return q; },
        order: (col: string) => { rows = [...rows].sort((a, b) => Number(a[col]) - Number(b[col])); return q; },
        single: async () => fail ? done() : rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "not one row" } },
        maybeSingle: async () => fail ? done() : { data: rows[0] ?? null, error: null },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(done()).then(resolve),
      };
      return q;
    },
  };
  return db;
}

const P = "10000000-0000-4000-8000-000000000001";
const S1 = "20000000-0000-4000-8000-000000000001";
const I1 = "30000000-0000-4000-8000-000000000001";
const PUBLISHED_AT = "2026-06-01T10:00:00.123456+00:00";
const PROFILE = { user_id: "u1", name: "Dana Whitfield", email: "dana@example.com", phone: "555-0100", business_name: "Whitfield & Co",
  logo_url: null, headshot_url: null, footer_label: "Your planner", website_url: null, links: [{ label: "Site", url: "https://example.com" }] };

function tables(packet: Row = {}, profile: Row | null = PROFILE): Record<string, Row[]> {
  return {
    packets: [{ id: P, user_id: "u1", slug: "harbor-7k2", status: "published", title: "INTERNAL name", client_title: "Three places",
      client_name: "the Smiths", personal_note: "See these first.", map_url: null, composition_mode: "legacy", show_quick_nav: true,
      style_treatment: "default", identity_mode: "default", professional_snapshot: null, published_at: PUBLISHED_AT, draft_rev: 7, ...packet }],
    sections: [{ id: S1, packet_id: P, title: "First", description: "", sort_order: 0 }],
    items: [{ id: I1, section_id: S1, title: "Harbor House", address: "41 Mill St", description: "Two bedrooms.", notes: "PRIVATE: negotiate", highlight: "Best view", sort_order: 0 }],
    item_photos: [], item_links: [], item_details: [{ item_id: I1, label: "Rent", value: "$2,400", sort_order: 0 }], item_contacts: [],
    packet_blocks: [], professional_profiles: profile ? [profile] : [],
    packet_publications: [],
  };
}
const TOKEN = { format: 1, status: "published", published_at: "1748772000.123456", draft_rev: 7, identity_mode: "default",
  professional_snapshot: null, identity_from_profile: true, profile_exists: true, identity_rev: 3, has_publication: false };
const DIGEST = "a".repeat(64);

function world(t = tables(), { token = TOKEN as Row | null, backfill = ((): { data?: unknown; error?: unknown } => ({ data: { publishedAt: PUBLISHED_AT, sourceDraftRev: 7, contentSha256: DIGEST } })) as (args: Row) => { data?: unknown; error?: unknown }, failing = [] as string[] } = {}) {
  const db = fakeDb(t, (name, args) => {
    if (name === "packet_backfill_token") return { data: token };
    if (name === "backfill_packet_publication") {
      const r = backfill(args);
      if (!r.error) t.packet_publications.push({ packet_id: args.p_packet_id, content: JSON.parse(JSON.stringify(args.p_content)), published_at: PUBLISHED_AT });
      return r;
    }
    throw new Error(`unexpected rpc ${name}`);
  }, failing);
  return { db, t };
}
const rpcs = (db: { calls: Call[] }, name: string) => db.calls.filter((c) => c.kind === "rpc" && c.name === name);

// ---------------------------------------------------------------------------
test("canonicalJson ignores key order at every depth and nothing else", () => {
  const a = { slug: "s", sections: [{ id: "1", items: [{ title: "t", id: "2" }] }], professional: { name: "n", links: [] } };
  const b = { professional: { links: [], name: "n" }, sections: [{ items: [{ id: "2", title: "t" }], id: "1" }], slug: "s" };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), "fixture: the bytes differ");
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.notEqual(canonicalJson({ x: [1, 2] }), canonicalJson({ x: [2, 1] }), "array order is content");
  assert.notEqual(canonicalJson({ x: "1" }), canonicalJson({ x: 1 }), "types are content");
  assert.equal(canonicalJson({ x: undefined, y: 1 }), canonicalJson({ y: 1 }), "an undefined key is absent, as in stored JSON");
  assert.notEqual(canonicalJson({ x: null }), canonicalJson({}), "a null is not an absence");
});

test("dry run: builds and compares, calls only the token, writes nothing", async () => {
  const { db, t } = world();
  const o = await backfillOne(db, P, { apply: false });
  assert.deepEqual(o, { packetId: P, outcome: "would_backfill" });
  assert.equal(rpcs(db, "backfill_packet_publication").length, 0);
  assert.equal(t.packet_publications.length, 0);
});

test("apply: the token is read before anything the copy is built from, and handed back unchanged", async () => {
  const { db, t } = world();
  const o = await backfillOne(db, P, { apply: true });
  assert.equal(o.outcome, "backfilled");
  assert.equal(db.calls[0].name, "packet_backfill_token", "the token must precede every read");
  const [call] = rpcs(db, "backfill_packet_publication");
  assert.deepEqual(call.args!.p_expected_token, TOKEN);
  assert.equal(call.args!.p_format_version, 1);
  // The copy is the live page minus the internal title, with the live profile's card.
  const live = await getLiveRowsPublishedPacket("harbor-7k2", fakeDb(tables(), () => ({})) as never);
  const { title: _t, ...recipient } = live as unknown as Row;
  void _t;
  assert.equal(canonicalJson(call.args!.p_content), canonicalJson(JSON.parse(JSON.stringify(recipient))));
  const content = call.args!.p_content as { professional: { businessName: string }; sections: { items: Row[] }[] };
  assert.equal(content.professional.businessName, "Whitfield & Co", "the frozen card is the live profile the page shows");
  assert.ok(!("title" in content) && !JSON.stringify(content).includes("PRIVATE"), "no internal title or private note");
  assert.deepEqual((o as { manifest: Row }).manifest, { packet_id: P, published_at: PUBLISHED_AT, source_draft_rev: 7, content_sha256: DIGEST });
  assert.equal(t.packet_publications.length, 1);
});

test("the database is handed the token from BEFORE the build, so an edit during the build is refused", async () => {
  // The token the fake returns moves on every read, as it would if the Sendset
  // were edited while the copy was being built. Re-reading it before the write
  // would bind the write to the edited state instead of to what was built.
  const t = tables();
  let reads = 0;
  const db = fakeDb(t, (name) => {
    if (name === "packet_backfill_token") return { data: { ...TOKEN, draft_rev: 7 + reads++ } };
    return { data: { publishedAt: PUBLISHED_AT, sourceDraftRev: 7, contentSha256: DIGEST } };
  });
  await backfillOne(db, P, { apply: true });
  assert.equal(rpcs(db, "packet_backfill_token").length, 1, "the token is read exactly once");
  assert.equal((rpcs(db, "backfill_packet_publication")[0].args!.p_expected_token as Row).draft_rev, 7);
});

test("a stored identity snapshot is frozen as stored, and the profile is not even read", async () => {
  const stored = { name: "Frozen Pro", businessName: "Old Co", footerLabel: "Advisor", links: [] };
  const { db } = world(tables({ professional_snapshot: stored }), { token: { ...TOKEN, professional_snapshot: stored, identity_from_profile: false, profile_exists: null, identity_rev: null } });
  const o = await backfillOne(db, P, { apply: true });
  assert.equal(o.outcome, "backfilled");
  const content = rpcs(db, "backfill_packet_publication")[0].args!.p_content as { professional: Row };
  assert.equal(content.professional.businessName, "Old Co");
});

test("a copy that differs from the live page is refused before any write", async () => {
  // A null snapshot with profile links null: the live page renders no links key,
  // the route's identity shape renders links []. Not what recipients see → refuse.
  const { db, t } = world(tables({}, { ...PROFILE, links: null }));
  const o = await backfillOne(db, P, { apply: true });
  assert.deepEqual(o, { packetId: P, outcome: "refused", reason: "differs_from_live_page" });
  assert.equal(rpcs(db, "backfill_packet_publication").length, 0);
  assert.equal(t.packet_publications.length, 0);
});

test("non-candidates are skipped without reading or writing", async () => {
  for (const [token, reason] of [[null, "not_found"], [{ ...TOKEN, status: "draft" }, "not_published"], [{ ...TOKEN, has_publication: true }, "publication_exists"]] as const) {
    const { db } = world(tables(), { token: token as Row | null });
    assert.deepEqual(await backfillOne(db, P, { apply: true }), { packetId: P, outcome: "skipped", reason });
    assert.deepEqual(db.calls.map((c) => c.name), ["packet_backfill_token"]);
  }
});

test("database refusals are reported, never retried, and leave no manifest entry", async () => {
  for (const details of ["changed", "invalid_snapshot"]) {
    const { db } = world(tables(), { backfill: () => ({ error: { message: "refused", details, code: "PT409" } }) });
    const o = await backfillOne(db, P, { apply: true });
    assert.equal(o.outcome, "refused");
    assert.equal((o as { reason: string }).reason, details);
    assert.ok(!("manifest" in o));
    assert.equal(rpcs(db, "backfill_packet_publication").length, 1);
  }
  const { db } = world(tables(), { backfill: () => ({ error: { message: "exists", details: "publication_exists", code: "PT409" } }) });
  assert.deepEqual(await backfillOne(db, P, { apply: true }), { packetId: P, outcome: "skipped", reason: "publication_exists" });
});

test("a failed read refuses the Sendset instead of freezing an absence", async () => {
  const { db } = world(tables(), { failing: ["item_details"] });
  const o = await backfillOne(db, P, { apply: true });
  assert.equal(o.outcome, "refused");
  assert.equal((o as { reason: string }).reason, "build_failed");
  assert.equal(rpcs(db, "backfill_packet_publication").length, 0);
});

test("a stored row that reads back differently is flagged, with its manifest entry kept for rollback", async () => {
  const t = tables();
  const db = fakeDb(t, (name, args) => {
    if (name === "packet_backfill_token") return { data: TOKEN };
    t.packet_publications.push({ packet_id: args.p_packet_id, content: { slug: "tampered" }, published_at: PUBLISHED_AT });
    return { data: { publishedAt: PUBLISHED_AT, sourceDraftRev: 7, contentSha256: DIGEST } };
  });
  const o = await backfillOne(db, P, { apply: true });
  assert.equal(o.outcome, "stored_but_unverified");
  assert.equal((o as { reason: string }).reason, "read_back_differs");
  assert.ok("manifest" in o);
});

test("a read-back that only reorders keys verifies (jsonb reorders them)", async () => {
  const t = tables();
  const reverse = (v: unknown): unknown => Array.isArray(v) ? v.map(reverse)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse((v as Row)[k])])) : v;
  const db = fakeDb(t, (name, args) => {
    if (name === "packet_backfill_token") return { data: TOKEN };
    t.packet_publications.push({ packet_id: args.p_packet_id, content: reverse(JSON.parse(JSON.stringify(args.p_content))), published_at: PUBLISHED_AT });
    return { data: { publishedAt: PUBLISHED_AT, sourceDraftRev: 7, contentSha256: DIGEST } };
  });
  assert.equal((await backfillOne(db, P, { apply: true })).outcome, "backfilled");
});

test("identityForLiveRender mirrors the live reader's three cases", () => {
  assert.deepEqual(identityForLiveRender({ professional_snapshot: {} }, PROFILE), {});
  assert.deepEqual(identityForLiveRender({ professional_snapshot: { name: "S" } }, PROFILE), { name: "S" });
  assert.deepEqual(identityForLiveRender({ professional_snapshot: null }, null), {});
  assert.equal(identityForLiveRender({ professional_snapshot: null }, PROFILE).businessName, "Whitfield & Co");
});

test("candidates are published Sendsets without a publication", async () => {
  const t = tables();
  t.packets.push({ ...t.packets[0], id: "p-draft", status: "draft" }, { ...t.packets[0], id: "p-has" }, { ...t.packets[0], id: "p-a" });
  t.packet_publications.push({ packet_id: "p-has" });
  assert.deepEqual(await listCandidates(fakeDb(t, () => ({})) as never), [P, "p-a"].sort());
});

test("rollback SQL deletes only rows whose stored digest AND published_at still match, to the microsecond", () => {
  const entry = { packet_id: P, published_at: PUBLISHED_AT, source_draft_rev: 7, content_sha256: DIGEST };
  const sql = rollbackSql([entry]);
  assert.match(sql, /encode\(sha256\(convert_to\(x\.content::text, 'UTF8'\)\), 'hex'\) = m\.content_sha256/);
  assert.match(sql, /and x\.published_at = m\.published_at/);
  assert.ok(sql.includes(`'${PUBLISHED_AT}'::timestamptz`), "the manifest timestamp must pass through untouched, microseconds included");
  assert.doesNotMatch(sql, /update public\.packets\b|delete from public\.packets\b/, "rollback touches no Sendset");
  assert.throws(() => rollbackSql([]), /empty manifest/);
  for (const bad of [{ packet_id: "x'); drop table public.packets; --" }, { content_sha256: "nothex" }, { published_at: "2026-06-01'; --" }]) {
    assert.throws(() => rollbackSql([{ ...entry, ...bad }]), /malformed manifest entry/);
  }
});

// ---------------------------------------------------------------------------
// Source rules
// ---------------------------------------------------------------------------
const M52 = readFileSync("supabase/migrations/0052_publication_infrastructure.sql", "utf8");
const M54 = readFileSync("supabase/migrations/0054_publication_backfill.sql", "utf8");
const body = (sql: string, fn: string) => {
  const start = sql.indexOf(`create function public.${fn}(`);
  assert.ok(start >= 0, `${fn} not found`);
  const open = sql.indexOf("as $$", start);
  return sql.slice(open, sql.indexOf("$$;", open));
};
const validationBlock = (fnBody: string) => {
  const from = fnBody.indexOf("-- THE SNAPSHOT MUST BE A RECIPIENT-SAFE COPY OF THIS SENDSET.");
  const to = fnBody.indexOf("-- THE WRITE.");
  assert.ok(from > 0 && to > from, "validation block markers missing");
  return fnBody.slice(from, to);
};

test("the backfill's snapshot validation is publish_packet's, verbatim", () => {
  const publish = validationBlock(body(M52, "publish_packet"))
    .replace(/  if jsonb_typeof\(p_professional_snapshot\) is distinct from 'object' then[\s\S]*?end if;\n/, "")
    .replace(/\s+/g, " ");
  const backfill = validationBlock(body(M54, "backfill_packet_publication")).replaceAll("'backfill: ", "'publish: ").replace(/\s+/g, " ");
  assert.ok(publish.length > 500, "the publish block was not found in full");
  assert.equal(backfill, publish);
  // And the CHECK-violation mapping around the write is the same too.
  for (const fn of [body(M52, "publish_packet"), body(M54, "backfill_packet_publication")]) {
    assert.match(fn, /exception when check_violation then\s+raise exception '\w+: the snapshot is not recipient-safe \(%\)', sqlerrm using errcode = 'PT400', detail = 'invalid_snapshot';/);
  }
});

test("the backfill locks, refuses, recomputes and compares before its one write, and never touches a Sendset row", () => {
  const b = body(M54, "backfill_packet_publication");
  const lock = b.search(/from public\.packets where id = p_packet_id for update/);
  const notPublished = b.indexOf("detail = 'not_published'");
  const exists = b.indexOf("detail = 'publication_exists'");
  const recompute = b.indexOf("v_token := public.packet_backfill_token(p_packet_id);");
  const compare = b.indexOf("if v_token is distinct from p_expected_token then");
  const writes = [...b.matchAll(/\b(insert into|update|delete from)\s+public\.(\w+)/gi)];
  assert.ok(lock >= 0 && lock < notPublished && notPublished < exists && exists < recompute && recompute < compare);
  assert.deepEqual(writes.map((w) => `${w[1].toLowerCase()} ${w[2]}`), ["insert into packet_publications"], "exactly one write, and it is the new row");
  assert.ok(writes[0].index! > compare, "nothing is written before the token comparison");
  assert.doesNotMatch(b, /on conflict/i, "a backfill never updates an existing publication");
  assert.doesNotMatch(b, /set_config\(/, "a backfill never authorises a status change");
  assert.match(b, /v_pk\.published_at\);/, "the publication keeps the Sendset's published_at");
  assert.doesNotMatch(b, /now\(\)/, "no fresh timestamp");
  assert.match(b, /v_dep := case when v_pk\.identity_mode = 'default' then 'account_profile' else 'sendset' end;/, "dependency derived as publish_packet derives it");
  const token = body(M54, "packet_backfill_token");
  for (const key of ["status", "published_at", "draft_rev", "identity_mode", "professional_snapshot", "identity_rev", "profile_exists", "has_publication"]) {
    assert.match(token, new RegExp(`'${key}',`), `the backfill token does not carry ${key}`);
  }
});

test("both functions are service_role only", () => {
  for (const sig of ["packet_backfill_token(uuid)", "backfill_packet_publication(uuid, jsonb, smallint, jsonb)"]) {
    const esc = sig.replace(/[()]/g, "\\$&");
    assert.match(M54, new RegExp(`revoke all on function public\\.${esc} from public, anon, authenticated, service_role;`));
    assert.match(M54, new RegExp(`grant execute on function public\\.${esc} to service_role;`));
    assert.doesNotMatch(M54, new RegExp(`grant execute on function public\\.${esc} to [^;]*(anon|authenticated|public)`, "i"));
  }
});

test("only the backfill script calls the backfill functions; no app code does", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|mts)$/.test(p) && !/\.test\./.test(p) && !/ \d+\.[a-z]+$/.test(p)) files.push(p); } };
  walk("src");
  assert.deepEqual(files.filter((f) => /backfill_packet_publication|packet_backfill_token/.test(readFileSync(f, "utf8"))), []);
});

test("the CLI is a dry run unless told otherwise, and never overwrites a manifest", () => {
  const cli = readFileSync("scripts/publication-backfill/cli.mts", "utf8");
  assert.match(cli, /const apply = args\.includes\("--apply"\);/);
  assert.match(cli, /if \(apply && !manifestPath\)/);
  assert.match(cli, /if \(apply && existsSync\(manifestPath!\)\)/);
  assert.match(cli, /backfillOne\(db, id, \{ apply \}\)/);
  assert.match(cli, /if \("manifest" in o\) \{ manifest\.push\(o\.manifest\); save\(\); \}/, "a stored row is recorded before the next Sendset runs");
});
