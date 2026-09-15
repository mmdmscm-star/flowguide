// The publish-route switch (0052): the frozen snapshot is what the recipient
// page renders, the route binds its gates to publish_packet with the token, and
// readers still read live rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildPublicationSnapshot, getPublishedPacket, PUBLICATION_FORMAT_VERSION } from "./queries.ts";

// ---------------------------------------------------------------------------
// An in-memory stand-in for the Supabase query builder: exactly the calls the
// assembly makes (select / eq / in / order / single / maybeSingle), over rows.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, failing: string[] = []) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const fail = failing.includes(table);
      const done = () => fail
        ? { data: null, error: { message: `${table} unavailable` } }
        : { data: rows, error: null };
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
  } as never;
}

const IDENTITY = { name: "Dana Whitfield", email: "dana@example.com", phone: "(206) 555-0100", businessName: "Whitfield & Co", footerLabel: "Your planner", links: [{ label: "Site", url: "https://example.com" }] };
const P = "10000000-0000-4000-8000-000000000001";
const S1 = "20000000-0000-4000-8000-000000000001", S2 = "20000000-0000-4000-8000-000000000002";
const I1 = "30000000-0000-4000-8000-000000000001", I2 = "30000000-0000-4000-8000-000000000002", I3 = "30000000-0000-4000-8000-000000000003";

function legacyTables(overrides: Row = {}): Record<string, Row[]> {
  return {
    packets: [{ id: P, user_id: "u1", slug: "harbor-view-7k2", status: "published", title: "INTERNAL — Smith options",
      client_title: "Three places to start", client_name: "the Smiths", personal_note: "These are the ones I'd see first.",
      map_url: "https://www.google.com/maps/d/viewer?mid=DISTINCT", composition_mode: "legacy", show_quick_nav: false,
      style_treatment: "warm", professional_snapshot: IDENTITY, ...overrides }],
    sections: [
      { id: S2, packet_id: P, title: "Also worth a look", description: "", sort_order: 1 },
      { id: S1, packet_id: P, title: "First choices", description: "Walkable to the water.", sort_order: 0 },
    ],
    items: [
      { id: I2, section_id: S1, title: "The Loft", address: "", description: "Top floor.", notes: "PRIVATE: owner is difficult", highlight: null, sort_order: 1 },
      { id: I1, section_id: S1, title: "Harbor House", address: "41 Mill St", description: "Two bedrooms.", notes: "PRIVATE: negotiate", highlight: "Best view", sort_order: 0 },
      { id: I3, section_id: S2, title: "Cedar Row", address: "", description: "", notes: "", highlight: "", sort_order: 2 },
    ],
    item_photos: [
      { item_id: I1, url: "https://photos.example.com/b.jpg", sort_order: 1 },
      { item_id: I1, url: "https://photos.example.com/a.jpg", sort_order: 0 },
    ],
    item_links: [{ item_id: I2, url: "https://listing.example.com/loft", label: "Listing", sort_order: 0 }],
    item_details: [
      { item_id: I1, label: "Rent", value: "$2,400", sort_order: 0 },
      { item_id: I1, label: "Pets", value: "Cats only", sort_order: 1 },
    ],
    item_contacts: [{ item_id: I3, name: "Jo", role: "Leasing", phone: "555-0102", email: "", website: "", sort_order: 0 }],
    packet_blocks: [],
    professional_profiles: [],
  };
}

const withoutTitle = (packet: Record<string, unknown>) => {
  const { title: _t, ...rest } = packet;
  void _t;
  return JSON.parse(JSON.stringify(rest));
};
function deepKeys(v: unknown, found: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, found));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { found.push(k); deepKeys(x, found); }
  return found;
}

test("the frozen snapshot is exactly what the recipient page renders, minus the internal title", async () => {
  const db = fakeDb(legacyTables());
  const live = await getPublishedPacket("harbor-view-7k2", db);
  const snap = await buildPublicationSnapshot(db, P, IDENTITY);
  assert.ok(live, "fixture did not render");
  assert.deepEqual(snap, withoutTitle(live as never));
  // Distinctive values arrived, so equality is not two empty objects agreeing.
  assert.equal(snap.clientTitle, "Three places to start");
  assert.equal(snap.sections[0].items[0].highlight, "Best view");
  assert.deepEqual(snap.sections[0].items[0].photos, ["https://photos.example.com/a.jpg", "https://photos.example.com/b.jpg"]);
  assert.equal(snap.professional.businessName, "Whitfield & Co");
  assert.equal(snap.styleTreatment, "warm");
  assert.equal(snap.showQuickNav, false);
});

test("the snapshot satisfies what publish_packet and packet_publications require", async () => {
  const snap = await buildPublicationSnapshot(fakeDb(legacyTables()), P, IDENTITY);
  const keys = deepKeys(snap);
  assert.ok(!("title" in snap), "a top-level title would be refused (0050)");
  assert.ok(!keys.includes("notes"), "a private note reached the snapshot");
  assert.ok(!JSON.stringify(snap).includes("PRIVATE"), "private note text reached the snapshot");
  assert.equal(snap.slug, "harbor-view-7k2", "publish_packet checks the slug");
  assert.deepEqual(snap.sections.map((s) => s.id), [S1, S2], "publish_packet checks every section id belongs to the Sendset");
  assert.deepEqual(snap.sections.flatMap((s) => s.items.map((i) => i.id)), [I1, I2, I3]);
  assert.equal(PUBLICATION_FORMAT_VERSION, 1);
});

test("a Sendset published without branding freezes the same card the page shows", async () => {
  const db = fakeDb(legacyTables({ professional_snapshot: {} }));
  const live = await getPublishedPacket("harbor-view-7k2", db);
  assert.deepEqual(await buildPublicationSnapshot(db, P, {}), withoutTitle(live as never));
});

test("a block-composed Sendset freezes its block body the same way", async () => {
  const B1 = "40000000-0000-4000-8000-000000000001", B2 = "40000000-0000-4000-8000-000000000002", B3 = "40000000-0000-4000-8000-000000000003";
  const tables = legacyTables({ composition_mode: "blocks" });
  tables.packet_blocks = [
    { id: B2, packet_id: P, position: 1, block_type: "item", item_id: I1, heading_text: null, heading_subtext: null },
    { id: B1, packet_id: P, position: 0, block_type: "heading", item_id: null, heading_text: "Start here", heading_subtext: "Closest first" },
    { id: B3, packet_id: P, position: 2, block_type: "item", item_id: I3, heading_text: null, heading_subtext: null },
  ];
  const db = fakeDb(tables);
  const live = await getPublishedPacket("harbor-view-7k2", db);
  const snap = await buildPublicationSnapshot(db, P, IDENTITY);
  assert.deepEqual(snap, withoutTitle(live as never));
  assert.deepEqual(snap.blocks?.map((b) => b.id), [B1, B2, B3]);
  assert.ok(!deepKeys(snap).includes("notes"));
});

test("the snapshot builds for a draft, which the live reader still refuses", async () => {
  const db = fakeDb(legacyTables({ status: "draft" }));
  assert.equal(await getPublishedPacket("harbor-view-7k2", db), null, "the reader must keep filtering to published");
  const snap = await buildPublicationSnapshot(db, P, IDENTITY);
  assert.equal(snap.sections.length, 2, "a first publish snapshots the draft's working rows");
});

test("a failed read fails the snapshot, but not the live page", async () => {
  for (const table of ["sections", "items", "item_photos", "item_links", "item_details", "item_contacts"]) {
    const db = fakeDb(legacyTables(), [table]);
    await assert.rejects(buildPublicationSnapshot(db, P, IDENTITY), new RegExp(`could not read`), `${table} failure was frozen`);
    assert.ok(await getPublishedPacket("harbor-view-7k2", db), `the live page stopped tolerating a ${table} hiccup`);
  }
  const blocks = legacyTables({ composition_mode: "blocks" });
  await assert.rejects(buildPublicationSnapshot(fakeDb(blocks, ["packet_blocks"]), P, IDENTITY), /could not read blocks/);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------
const codeOf = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const ROUTE = "src/app/api/packets/[id]/publish/route.ts";
const route = codeOf(ROUTE);
const handler = route.slice(route.indexOf("export async function POST"));

test("publish: token, gates in their order, snapshot, then publish_packet", () => {
  const at = (needle: string) => {
    const i = handler.indexOf(needle);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  const order = [
    'rpc("packet_publish_token"',
    "await importGate(supabase, id, session.userId)",
    '"Packet needs a title"',
    'composition_mode === "blocks"',
    "identityGap(contact)",
    "loadPacketOwnership(id, supabase)",
    "ownership.unavailable",
    "ownership.blocking.length > 0",
    "buildPublicationSnapshot(supabase, id, professionalSnapshot)",
    'rpc("publish_packet"',
  ].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `step ${i} is out of order`);
  const call = handler.slice(handler.indexOf('rpc("publish_packet"'), handler.indexOf('rpc("publish_packet"') + 300);
  assert.match(call, /p_expected_token: publishToken/, "the token read before the gates must be the one checked");
  assert.match(call, /p_content: snapshot/);
  assert.match(call, /p_professional_snapshot: professionalSnapshot/, "professional_snapshot is preserved");
  assert.match(call, /p_format_version: PUBLICATION_FORMAT_VERSION/);
});

test("publish: a token that cannot be read refuses; no token means not found", () => {
  const tok = handler.slice(handler.indexOf('rpc("packet_publish_token"'), handler.indexOf("await importGate("));
  assert.match(tok, /if \(tokenErr\) \{[\s\S]*status: 503/);
  assert.match(tok, /if \(!publishToken\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);
});

test("publish: a snapshot that cannot be built refuses before publish_packet", () => {
  const build = handler.slice(handler.indexOf("buildPublicationSnapshot("), handler.indexOf('rpc("publish_packet"'));
  assert.match(build, /catch \(e\) \{[\s\S]*status: 503/);
});

test("publish: database refusals are mapped deliberately", () => {
  const errs = handler.slice(handler.indexOf("if (publishErr) {"), handler.indexOf('if (action === "unpublish")'));
  assert.match(errs, /publishErr\.code === "PT409" && detail === "changed"\) \{\s*return NextResponse\.json\(\{ error: "changed_while_publishing", message: CHANGED_WHILE_PUBLISHING \}, \{ status: 409 \}\)/);
  assert.match(route, /export const CHANGED_WHILE_PUBLISHING = "This Sendset changed while publishing\. Try again\.";/);
  assert.match(errs, /detail === "import_blocks"\) \{\s*const refusal = await importGate\(supabase, id, session\.userId\);/,
    "a blocking import answers with the import gate's own response");
  assert.match(errs, /detail === "title_required"\) \{\s*return NextResponse\.json\(\{ error: "Packet needs a title" \}, \{ status: 400 \}\)/);
  assert.match(errs, /publishErr\.code === "PT404"\) \{\s*return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);
  assert.match(errs, /error: "publish_failed", message: "Couldn't publish this Sendset\. Please try again\." \}, \{ status: 500 \}/);
  // Logged in full, never returned.
  for (const response of errs.match(/NextResponse\.json\([\s\S]*?\}\s*,\s*\{ status: \d+ \}\)/g) ?? []) {
    assert.doesNotMatch(response, /publishErr|tokenErr/, "the database's words must not reach the professional");
  }
  assert.match(errs, /console\.error\("\[publish\] publish_packet refused", \{[^}]*message: publishErr\.message/);
});

test("unpublish goes through unpublish_packet and nothing writes a status", () => {
  const un = handler.slice(handler.indexOf('if (action === "unpublish")'));
  assert.match(un, /rpc\("unpublish_packet", \{\s*p_owner: session\.userId,\s*p_packet_id: id,\s*\}\)/);
  assert.doesNotMatch(route, /\.from\("packets"\)\s*\.update\(/, "the publish route still updates packets directly");
  assert.doesNotMatch(route, /status:\s*"(published|draft)"/);
});

test("the editor does not claim an unpublish that failed", () => {
  const editor = codeOf("src/components/editor/legacy-packet-editor.tsx");
  const fn = editor.slice(editor.indexOf("async function unpublishPacket()"), editor.indexOf("async function unpublishPacket()") + 900);
  const guard = fn.indexOf("if (!res.ok)");
  const flip = fn.indexOf('status: "draft"');
  assert.ok(guard > 0 && flip > guard, "the local status must only change after a successful response");
});

test("readers still render live rows; nothing reads packet_publications yet", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) && !/ \d+\.[a-z]+$/.test(p)) files.push(p); } };
  walk("src");
  const readers = files.filter((f) => /packet_publications/.test(codeOf(f)));
  assert.deepEqual(readers, [], "a reader was switched to packet_publications before the backfill");
  const q = codeOf("src/lib/queries.ts");
  const reader = q.slice(q.indexOf("export async function getPublishedPacket"), q.indexOf("type Db ="));
  assert.match(reader, /\.eq\("slug", slug\)\s*\.eq\("status", "published"\)/, "getPublishedPacket stopped reading the live published row");
  for (const f of ["src/app/p/[slug]/page.tsx", "src/app/p/[slug]/print/page.tsx", "src/app/api/packets/[id]/email/route.ts"]) {
    assert.match(codeOf(f), /getPublishedPacket\(/, `${f} no longer renders through getPublishedPacket`);
  }
});
