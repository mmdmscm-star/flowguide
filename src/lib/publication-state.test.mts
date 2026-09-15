// "PUBLISHED" VS "SAVED · CHANGES NOT PUBLISHED" — EXACT, BY VALUE.
//
// getPublicationState builds the copy a Republish pressed now would freeze and
// compares it with the stored publication as a value. These tests move things
// a recipient sees (must say "changed"), things they do not (must stay
// "current" even though revisions move and bytes differ), and the identity
// cases where a naive comparison would be wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPublicationSnapshot } from "./queries.ts";
import { getPublicationState } from "./publication-state.ts";
import { resolvePublishIdentity } from "./publish-identity.ts";

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, failing: string[] = []) {
  return {
    from(table: string) {
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
  } as never;
}

const OWNER = "u1";
const P = "10000000-0000-4000-8000-000000000001";
const S1 = "20000000-0000-4000-8000-000000000001";
const I1 = "30000000-0000-4000-8000-000000000001", I2 = "30000000-0000-4000-8000-000000000002";
const PROFILE = { user_id: OWNER, name: "Dana Whitfield", email: "dana@example.com", phone: "555-0100", business_name: "Whitfield & Co",
  logo_url: null, headshot_url: null, footer_label: null, website_url: null, links: [] };

function tables(packet: Row = {}, profile: Row | null = PROFILE): Record<string, Row[]> {
  return {
    packets: [{ id: P, user_id: OWNER, slug: "harbor-7k2", status: "published", title: "Internal", client_title: "Three places",
      client_name: "the Smiths", personal_note: "See these first.", map_url: null, composition_mode: "legacy", show_quick_nav: true,
      style_treatment: "default", identity_mode: "default", custom_identity: null, professional_snapshot: null, draft_rev: 4, ...packet }],
    sections: [{ id: S1, packet_id: P, title: "First", description: "", sort_order: 0 }],
    items: [
      { id: I1, section_id: S1, title: "Harbor House", address: "41 Mill St", description: "Two bedrooms.", notes: "PRIVATE", highlight: "Best view", sort_order: 0 },
      { id: I2, section_id: S1, title: "The Loft", address: "", description: "", notes: "", highlight: null, sort_order: 1 },
    ],
    item_photos: [{ item_id: I1, url: "https://p.example/a.jpg", sort_order: 0 }, { item_id: I1, url: "https://p.example/b.jpg", sort_order: 1 }],
    item_links: [], item_details: [{ item_id: I1, label: "Rent", value: "$2,400", sort_order: 0 }], item_contacts: [], packet_blocks: [],
    professional_profiles: profile ? [profile] : [],
    packet_publications: [],
  };
}
const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as Row)[k])])) : v;

/** Publish exactly as the route does, storing the copy as jsonb would return it. */
async function publish(t: Record<string, Row[]>, { skipProfileCheck = false } = {}) {
  const { professionalSnapshot } = resolvePublishIdentity(t.packets[0], t.professional_profiles[0] ?? null, skipProfileCheck);
  const content = await buildPublicationSnapshot(fakeDb(t), P, professionalSnapshot);
  t.packets[0].professional_snapshot = professionalSnapshot;
  t.packet_publications = [{ packet_id: P, format_version: 1, content: reverseKeys(JSON.parse(JSON.stringify(content))) }];
}
const state = async (t: Record<string, Row[]>, failing: string[] = []) => getPublicationState(fakeDb(t, failing), P, OWNER);
const CURRENT = { published: true, publication: "current" };
const CHANGED = { published: true, publication: "changed" };

test("right after publishing: current, although the stored copy's bytes differ", async () => {
  const t = tables();
  await publish(t);
  assert.deepEqual(await state(t), CURRENT);
});

test("anything a recipient sees, changed: 'changed'; changed back: 'current' again", async () => {
  const edits: [string, (t: Record<string, Row[]>) => void][] = [
    ["an item title", (t) => { t.items[0].title = "Harbor House II"; }],
    ["a photo removed", (t) => { t.item_photos.pop(); }],
    ["photos reordered", (t) => { t.item_photos[0].sort_order = 2; }],
    ["a detail value", (t) => { t.item_details[0].value = "$2,500"; }],
    ["the personal note", (t) => { t.packets[0].personal_note = "New note"; }],
    ["the client title", (t) => { t.packets[0].client_title = ""; }],
    ["the style treatment", (t) => { t.packets[0].style_treatment = "warm"; }],
    ["the map link", (t) => { t.packets[0].map_url = "https://maps.example.com/x"; }],
    ["quick nav", (t) => { t.packets[0].show_quick_nav = false; }],
    ["the account profile (default identity)", (t) => { t.professional_profiles[0] = { ...PROFILE, phone: "555-0199" }; }],
    ["the identity mode", (t) => { t.packets[0].identity_mode = "none"; }],
  ];
  for (const [label, edit] of edits) {
    const t = tables();
    await publish(t);
    const before = JSON.parse(JSON.stringify(t));
    edit(t);
    assert.deepEqual(await state(t), CHANGED, `${label}: not reported as a change`);
    const restored = { ...before, packet_publications: t.packet_publications };
    assert.deepEqual(await state(restored), CURRENT, `${label}: undoing it still reports a change`);
  }
});

test("what recipients never see does not count as a change, whatever the revisions say", async () => {
  const t = tables();
  await publish(t);
  t.packets[0].draft_rev = 99;                       // conservative counters over-count
  t.items[0].notes = "PRIVATE, rewritten";           // private notes never reach a publication
  t.packets[0].title = "Renamed internally";         // nor does the internal name
  t.items = t.items.map((i) => ({ ...i }));          // identical rewrite of every row
  assert.deepEqual(await state(t), CURRENT);
});

test("a stored card is compared with what a republish would freeze, per identity mode", async () => {
  const none = tables({ identity_mode: "none" });
  await publish(none);
  none.professional_profiles[0] = { ...PROFILE, name: "Someone Else" };
  assert.deepEqual(await state(none), CURRENT, "a no-identity Sendset does not change with the profile");

  const custom = tables({ identity_mode: "custom", custom_identity: { name: "Custom", phone: "555-0111" } });
  await publish(custom);
  custom.professional_profiles[0] = { ...PROFILE, name: "Someone Else" };
  assert.deepEqual(await state(custom), CURRENT, "a custom identity does not change with the profile");
  custom.packets[0].custom_identity = { name: "Custom", phone: "555-0112" };
  assert.deepEqual(await state(custom), CHANGED, "editing the custom identity is a change");
});

test("published without contact details: current while the gap remains, changed once it is filled", async () => {
  const t = tables({}, { ...PROFILE, email: null, phone: null });
  await publish(t, { skipProfileCheck: true });
  assert.deepEqual(t.packets[0].professional_snapshot, {}, "fixture: 'publish anyway' froze no card");
  assert.deepEqual(await state(t), CURRENT, "a republish would also have to publish anyway, so nothing differs");
  t.professional_profiles[0] = { ...PROFILE };
  assert.deepEqual(await state(t), CHANGED, "with a complete profile a republish would add the card");
});

test("a Sendset backfilled with an older stored card shows 'changed' when the profile has moved on", async () => {
  // The four production Sendsets whose cards predate the July profile edit.
  const t = tables({ professional_snapshot: { name: "Dana (July)", email: "old@example.com", phone: "", businessName: "", logoUrl: "", headshotUrl: "", footerLabel: "Your Advisor", websiteUrl: "", links: [] } });
  const content = await buildPublicationSnapshot(fakeDb(t), P, t.packets[0].professional_snapshot as Row);
  t.packet_publications = [{ packet_id: P, format_version: 1, content }];
  assert.deepEqual(await state(t), CHANGED);
});

test("draft, missing publication, someone else's Sendset", async () => {
  assert.deepEqual(await state(tables({ status: "draft" })), { published: false });
  assert.deepEqual(await state(tables()), { published: true, publication: "missing" });
  assert.equal(await getPublicationState(fakeDb(tables()), P, "someone-else"), null);
});

test("when it cannot tell, it throws rather than guessing", async () => {
  const t = tables();
  await publish(t);
  await assert.rejects(state(t, ["item_photos"]), /could not read photos/);
  await assert.rejects(state(t, ["professional_profiles"]), /could not read the profile/);
  await assert.rejects(state(t, ["packet_publications"]), /publication could not be read/);
});

test("the comparison is the builder's copy against the stored copy, by value — not revisions, not bytes", () => {
  const src = readFileSync("src/lib/publication-state.ts", "utf8").replace(/\/\/[^\n]*/g, "");
  assert.match(src, /buildPublicationSnapshot\(db, packetId, republishIdentity\(packet, profile\)\)/);
  assert.match(src, /canonicalJson\(next\) === canonicalJson\(publication\.content\)/);
  assert.doesNotMatch(src, /draft_rev|identity_rev|source_draft_rev|JSON\.stringify/);
  const route = readFileSync("src/app/api/packets/[id]/publication-state/route.ts", "utf8");
  assert.match(route, /getSession\(\)/);
  assert.match(route, /getPublicationState\(createServerClient\(\), id, session\.userId\)/, "the owner is the session's, never the request's");
  assert.match(route, /status: 503/);
  assert.match(route, /"Cache-Control": "no-store"/);
});
