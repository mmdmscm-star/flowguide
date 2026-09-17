// THE READER SWITCH DOES NOT CHANGE WHAT A RECIPIENT GETS.
//
// Before: getPublishedPacket assembled the working rows (now
// getLiveRowsPublishedPacket). After: it returns the frozen publication. For a
// Sendset whose publication was frozen from those same rows — by publish or by
// the 0054 backfill — the two must be the same recipient output: equal as data
// (bar the internal title, which a recipient never had a use for) and equal as
// rendered markup on the web page's components, on paper and in email. The
// stored copy is key-reversed on the way in, as jsonb would return it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPublicationSnapshot, getLiveRowsPublishedPacket, getPublishedPacket } from "./queries.ts";
import { canonicalJson } from "./canonical-json.ts";
import { identityForLiveRender } from "../../scripts/publication-backfill/lib.ts";
import { resolvePublishIdentity } from "./publish-identity.ts";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";
import { PrintPacket } from "../components/print/print-packet.tsx";
import { PacketHeader } from "../components/packet-header.tsx";
import { PersonalNote } from "../components/personal-note.tsx";
import { SectionGroup } from "../components/section-group.tsx";
import { PacketBlockBody } from "../components/packet-block-body.tsx";
import { ProfessionalFooter } from "../components/professional-footer.tsx";
import type { Packet } from "./types.ts";

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

const P = "10000000-0000-4000-8000-000000000001";
const S1 = "20000000-0000-4000-8000-000000000001", S2 = "20000000-0000-4000-8000-000000000002";
const I1 = "30000000-0000-4000-8000-000000000001", I2 = "30000000-0000-4000-8000-000000000002", I3 = "30000000-0000-4000-8000-000000000003";
const B1 = "40000000-0000-4000-8000-000000000001", B2 = "40000000-0000-4000-8000-000000000002", B3 = "40000000-0000-4000-8000-000000000003", B4 = "40000000-0000-4000-8000-000000000004";
const PROFILE = { user_id: "u1", name: "Dana Whitfield", email: "dana@example.com", phone: "(206) 555-0100", business_name: "Whitfield & Co",
  logo_url: "https://img.example.com/logo.png", headshot_url: null, footer_label: "Your planner", website_url: "https://whitfield.example.com",
  links: [{ label: "Reviews", url: "https://reviews.example.com" }] };
const STORED = { name: "Dana W. (as published)", email: "old@example.com", phone: "", businessName: "Old Co", logoUrl: "", headshotUrl: "https://img.example.com/h.jpg", footerLabel: "Advisor", websiteUrl: "", links: [] };

function tables(packet: Row = {}): Record<string, Row[]> {
  return {
    packets: [{ id: P, user_id: "u1", slug: "harbor-view-7k2", status: "published", title: "INTERNAL — Smith options",
      client_title: "Three places to start", client_name: "the Smiths", personal_note: "These are the ones I'd see first.\n\nCall me.",
      map_url: "https://www.google.com/maps/d/viewer?mid=DISTINCT", composition_mode: "legacy", show_quick_nav: true,
      style_treatment: "warm", identity_mode: "default", custom_identity: null, professional_snapshot: STORED, ...packet }],
    sections: [
      { id: S2, packet_id: P, title: "Also worth a look", description: "", sort_order: 1 },
      { id: S1, packet_id: P, title: "First choices", description: "Walkable to the water.", sort_order: 0 },
    ],
    items: [
      { id: I2, section_id: S1, title: "The Loft", address: "", description: "Top floor.\nNo lift.", notes: "PRIVATE: owner is difficult", highlight: null, sort_order: 1 },
      { id: I1, section_id: S1, title: "Harbor House", address: "41 Mill St", description: "Two bedrooms.", notes: "PRIVATE: negotiate", highlight: "Best view", sort_order: 0 },
      { id: I3, section_id: S2, title: "Cedar Row", address: "9 Cedar Row", description: "", notes: "", highlight: "", sort_order: 2 },
    ],
    item_photos: [
      { item_id: I1, url: "https://photos.example.com/b.jpg", sort_order: 1 },
      { item_id: I1, url: "https://photos.example.com/a.jpg", sort_order: 0 },
      { item_id: I3, url: "https://photos.example.com/c.jpg", sort_order: 0 },
    ],
    item_links: [{ item_id: I2, url: "https://listing.example.com/loft", label: "Listing", sort_order: 0 }],
    item_details: [
      { item_id: I1, label: "Rent", value: "$2,400", sort_order: 0 },
      { item_id: I1, label: "Pets", value: "Cats only", sort_order: 1 },
    ],
    item_contacts: [{ item_id: I3, name: "Jo", role: "Leasing", phone: "555-0102", email: "jo@example.com", website: "", sort_order: 0 }],
    packet_blocks: [
      { id: B2, packet_id: P, position: 1, block_type: "item", item_id: I1, heading_text: null, heading_subtext: null },
      { id: B1, packet_id: P, position: 0, block_type: "heading", item_id: null, heading_text: "Start here", heading_subtext: "Closest first" },
      { id: B3, packet_id: P, position: 2, block_type: "subheading", item_id: null, heading_text: "Further out", heading_subtext: null },
      { id: B4, packet_id: P, position: 3, block_type: "item", item_id: I3, heading_text: null, heading_subtext: null },
    ],
    professional_profiles: [PROFILE],
    packet_publications: [],
  };
}

const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as Row)[k])])) : v;

/** Freeze the copy the way the backfill does (identity the live page shows), stored as jsonb would return it. */
async function freezeAsBackfill(t: Record<string, Row[]>) {
  const db = fakeDb(t);
  const packet = t.packets[0];
  const content = await buildPublicationSnapshot(db, P, identityForLiveRender(packet, t.professional_profiles[0] ?? null));
  t.packet_publications = [{ packet_id: P, format_version: 1, content: reverseKeys(JSON.parse(JSON.stringify(content))) }];
}

const withoutTitle = (p: Packet) => { const { title: _t, ...rest } = p; void _t; return JSON.parse(JSON.stringify(rest)); };

/** Everything a recipient receives, rendered: the page's components, paper, email. */
function recipientOutput(packet: Packet): Record<string, string> {
  const r = (el: React.ReactElement) => renderToStaticMarkup(el);
  const LIVE = "https://sendset.io/p/harbor-view-7k2";
  return {
    header: r(React.createElement(PacketHeader, { title: packet.clientTitle, clientName: packet.clientName, professional: packet.professional })),
    note: packet.personalNote ? r(React.createElement(PersonalNote, { note: packet.personalNote })) : "",
    body: packet.compositionMode === "blocks"
      ? r(React.createElement(PacketBlockBody, { blocks: packet.blocks ?? [] }))
      : packet.sections.map((s) => r(React.createElement(SectionGroup, { key: s.id, section: s, showQuickNav: packet.showQuickNav !== false }))).join(""),
    footer: packet.professional.name ? r(React.createElement(ProfessionalFooter, { professional: packet.professional })) : "",
    page_fields: JSON.stringify([packet.mapUrl, packet.styleTreatment, packet.showQuickNav, packet.compositionMode, packet.slug]),
    print: r(React.createElement(PrintPacket, { packet, liveUrl: LIVE } as never)),
    email: packet.compositionMode === "blocks" ? "" : renderPacketEmail(packet, { liveUrl: LIVE }),
    email_text: packet.compositionMode === "blocks" ? "" : renderPacketEmailText(packet, { liveUrl: LIVE }),
  };
}

const CASES: [string, Row, Row | null][] = [
  ["legacy, identity stored at publish", {}, PROFILE],
  ["legacy, null snapshot (the live profile's card)", { professional_snapshot: null }, PROFILE],
  ["legacy, null snapshot and no profile row", { professional_snapshot: null }, null],
  ["legacy, published without branding ({})", { professional_snapshot: {}, identity_mode: "none" }, PROFILE],
  ["legacy, custom identity", { identity_mode: "custom", custom_identity: { name: "Custom Name", phone: "555-0199" }, professional_snapshot: { name: "Custom Name", email: "", phone: "555-0199", businessName: "", logoUrl: "", headshotUrl: "", footerLabel: "", websiteUrl: "", links: [] } }, PROFILE],
  ["blocks", { composition_mode: "blocks" }, PROFILE],
  ["quick nav off, default treatment", { show_quick_nav: false, style_treatment: "default", map_url: null, personal_note: null }, PROFILE],
];

for (const [label, packetOverrides, profile] of CASES) {
  test(`switching readers changes nothing a recipient gets — ${label}`, async () => {
    const t = tables(packetOverrides);
    t.professional_profiles = profile ? [profile] : [];
    const before = await getLiveRowsPublishedPacket("harbor-view-7k2", fakeDb(t));
    await freezeAsBackfill(t);
    const after = await getPublishedPacket("harbor-view-7k2", fakeDb(t));
    assert.ok(before && after);
    assert.notEqual(JSON.stringify(t.packet_publications[0].content), JSON.stringify(withoutTitle(before!)), "fixture: the stored copy's key order differs");
    assert.equal(canonicalJson(withoutTitle(after!)), canonicalJson(withoutTitle(before!)), "recipient data differs");
    assert.equal(after!.title, "", "the internal title is not part of what a recipient is given");
    assert.deepEqual(recipientOutput(after!), recipientOutput(before!), "rendered recipient output differs");
    // Distinctive values arrived, so equality is not two empty renders agreeing.
    const out = recipientOutput(after!);
    assert.match(out.body, /Harbor House/);
    assert.match(out.print, /Harbor House/);
    assert.doesNotMatch(Object.values(out).join(""), /PRIVATE|INTERNAL — Smith/, "a private note or the internal title reached recipient output");
  });
}

test("a Sendset published through the route freezes what its page rendered, too", async () => {
  // The route's identity rule rather than the backfill's: for a Sendset just
  // published, professional_snapshot is what the route stored.
  const t = tables({ professional_snapshot: null });
  const { professionalSnapshot } = resolvePublishIdentity(t.packets[0], PROFILE, false);
  t.packets[0].professional_snapshot = professionalSnapshot;
  const before = await getLiveRowsPublishedPacket("harbor-view-7k2", fakeDb(t));
  const content = await buildPublicationSnapshot(fakeDb(t), P, professionalSnapshot);
  t.packet_publications = [{ packet_id: P, format_version: 1, content: reverseKeys(content) }];
  const after = await getPublishedPacket("harbor-view-7k2", fakeDb(t));
  assert.deepEqual(recipientOutput(after!), recipientOutput(before!));
});

test("after the switch, edits to the working rows do not reach recipients until Republish", async () => {
  const t = tables();
  await freezeAsBackfill(t);
  const published = recipientOutput((await getPublishedPacket("harbor-view-7k2", fakeDb(t)))!);
  t.items[1].title = "Harbor House (edited, unpublished)";
  t.packets[0].personal_note = "An unpublished note.";
  t.professional_profiles[0] = { ...PROFILE, name: "Renamed Later" };
  const again = recipientOutput((await getPublishedPacket("harbor-view-7k2", fakeDb(t)))!);
  assert.deepEqual(again, published, "the page, print or email picked up an unpublished change");
  const live = recipientOutput((await getLiveRowsPublishedPacket("harbor-view-7k2", fakeDb(t)))!);
  assert.match(live.body, /edited, unpublished/, "control: the working rows did change");
});

test("renderers never read the internal title", async () => {
  const t = tables();
  const a = (await getLiveRowsPublishedPacket("harbor-view-7k2", fakeDb(t)))!;
  assert.deepEqual(recipientOutput({ ...a, title: "" }), recipientOutput({ ...a, title: "SECRET INTERNAL NAME" }));
  const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const f of ["src/app/p/[slug]/page.tsx", "src/app/p/[slug]/print/page.tsx", "src/app/api/packets/[id]/email/route.ts",
                   "src/components/print/print-packet.tsx", "src/lib/email-render.ts"]) {
    assert.doesNotMatch(code(f), /packet\.title\b/, `${f} reads the internal title`);
  }
});

test("rollout fallback: a published Sendset with no publication renders its live rows, and says so", async () => {
  const t = tables();
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const got = await getPublishedPacket("harbor-view-7k2", fakeDb(t));
    const live = await getLiveRowsPublishedPacket("harbor-view-7k2", fakeDb(t));
    assert.deepEqual(recipientOutput(got!), recipientOutput(live!));
    assert.equal(got!.title, "");
  } finally { console.error = original; }
  assert.equal(errors.length, 1, "the fallback must log exactly once per render");
  assert.match(String(errors[0][0]), /\[publication-reader\] published Sendset has no publication/);
  assert.deepEqual(errors[0][1], { packetId: P });
});

test("fail closed: an unreadable or unknown publication is an error, never the working rows", async () => {
  const t = tables();
  await freezeAsBackfill(t);
  await assert.rejects(getPublishedPacket("harbor-view-7k2", fakeDb(t, ["packet_publications"])), /publication could not be read/);
  t.packet_publications[0].format_version = 2;
  await assert.rejects(getPublishedPacket("harbor-view-7k2", fakeDb(t)), /publication format 2/);
});

test("an unpublished Sendset renders nothing, whatever rows exist", async () => {
  const t = tables({ status: "draft" });
  await freezeAsBackfill(t);   // a stale row cannot exist (unpublish deletes it); if it did, it must not show
  assert.equal(await getPublishedPacket("harbor-view-7k2", fakeDb(t)), null);
});

test("web, print and email all load through the publication reader", () => {
  // The recipient page uses getPublishedPacketForPage — the same reader, which
  // also returns the response marker from the same publication row.
  for (const f of ["src/app/p/[slug]/page.tsx", "src/app/p/[slug]/print/page.tsx", "src/app/api/packets/[id]/email/route.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /getPublishedPacket(ForPage)?\(/, `${f} no longer loads the publication`);
    assert.doesNotMatch(src, /getLiveRowsPublishedPacket|getPacketForEditor/, `${f} renders working rows to a recipient`);
  }
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) && !/ \d+\.[a-z]+$/.test(p)) files.push(p); } };
  walk("src");
  const liveRowReaders = files.filter((f) => /getLiveRowsPublishedPacket\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(liveRowReaders.sort(), [join("src", "lib", "queries.ts")], "only the fallback may render working rows as a published Sendset");
  const pubReaders = files.filter((f) => /packet_publications/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
  assert.deepEqual(pubReaders.sort(), [join("src", "lib", "queries.ts")], "packet_publications is read outside the one reader");
});
