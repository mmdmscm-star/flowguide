// Source-fidelity regression for multiple contacts per item (migration 0011).
//
// The defect: a community authored with TWO people (co-owners, each with a phone)
// lost the second person because an item could hold only ONE contact. This test
// pins the AI ingestion path (insertStructuredSections — shared by "Organize with
// AI" and "Add with AI") on the exact fixture:
//
//   Serenity Board & Care — 407 Calistoga Road, Santa Rosa, CA 95409
//     Helen  (Co-owner)  (415) 205-3276
//     Joel   (Co-owner)  (415) 203-3624
//     Website: https://example.com   (the COMMUNITY's site — item-level link)
//
// Expected: ONE item, TWO ordered contacts (each keeping their own phone + role),
// and the community website as ONE item-level link — never duplicated onto a
// person and never dropped.
//
// Run: node --test src/lib/ai-contacts-fidelity.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { insertStructuredSections, type StructuredSection } from "./ai-structure.ts";

// A mock that records every insert and hands back synthetic ids for the parent
// rows (sections/items) that the code reads back via .select().single().
function mockSupabase() {
  const inserts: { table: string; rows: unknown }[] = [];
  let seq = 0;
  const chain = {
    _table: "" as string,
    from(t: string) { this._table = t; return this; },
    delete() { return this; },
    in() { return Promise.resolve({ error: null }); },
    insert(rows: unknown) {
      const table = this._table;
      inserts.push({ table, rows });
      // sections/items are read back for their id; child tables are fire-and-forget.
      const needsId = table === "sections" || table === "items";
      const result = needsId
        ? { data: { id: `${table}-${++seq}` }, error: null }
        : { error: null };
      return {
        select() { return { single() { return Promise.resolve(result); } }; },
        // child-table inserts are awaited directly
        then(res: (v: unknown) => void) { res(result); },
      };
    },
  };
  return { supabase: chain, inserts };
}

// The fixture exactly as the AI schema now emits it (contacts is an ordered array;
// the community website is an item-level link, not a person's website).
const FIXTURE: StructuredSection[] = [
  {
    title: "Board & Care Homes",
    items: [
      {
        title: "Serenity Board & Care",
        address: "407 Calistoga Road, Santa Rosa, CA 95409",
        links: [{ url: "https://example.com", label: "Website" }],
        contacts: [
          { name: "Helen", role: "Co-owner", phone: "(415) 205-3276" },
          { name: "Joel", role: "Co-owner", phone: "(415) 203-3624" },
        ],
      },
    ],
  },
];

test("Serenity fixture → 1 item, 2 ordered contacts, community website stays a single item-level link", async () => {
  const { supabase, inserts } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await insertStructuredSections(supabase as any, "packet-1", FIXTURE, 0);

  // Exactly one item.
  const itemInserts = inserts.filter((i) => i.table === "items");
  assert.equal(itemInserts.length, 1, "one community → one item (never split into duplicates)");

  // Both people preserved, in order, each with their OWN phone and role.
  const contactInsert = inserts.find((i) => i.table === "item_contacts");
  assert.ok(contactInsert, "contacts were written");
  const rows = contactInsert!.rows as {
    name: string; role: string; phone: string; website: string; sort_order: number;
  }[];
  assert.equal(rows.length, 2, "BOTH co-owners saved — the second is never dropped");
  assert.deepEqual(rows.map((r) => r.name), ["Helen", "Joel"], "source order preserved");
  assert.deepEqual(rows.map((r) => r.sort_order), [0, 1], "deterministic ordering");
  assert.equal(rows[0].phone, "(415) 205-3276", "Helen keeps her own phone");
  assert.equal(rows[1].phone, "(415) 203-3624", "Joel keeps his own phone (no cross-assignment)");
  assert.deepEqual(rows.map((r) => r.role), ["Co-owner", "Co-owner"], "roles stored only as stated");

  // The community website is an item-level link, present exactly once and NOT
  // copied onto either person.
  const linkInsert = inserts.find((i) => i.table === "item_links");
  assert.ok(linkInsert, "the community website was written as a link");
  const linkRows = linkInsert!.rows as { url: string }[];
  assert.equal(linkRows.length, 1, "one item-level website link");
  assert.equal(linkRows[0].url, "https://example.com");
  assert.ok(rows.every((r) => !r.website), "the community site is NOT duplicated onto a contact");
});

test("blank contact entries never become empty rows", async () => {
  const { supabase, inserts } = mockSupabase();
  const withBlank: StructuredSection[] = [
    {
      title: "S",
      items: [
        {
          title: "Item",
          contacts: [
            { name: "Helen", phone: "(415) 205-3276" },
            { name: "", role: "", phone: "", email: "", website: "" },
            { name: "Joel", phone: "(415) 203-3624" },
          ],
        },
      ],
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await insertStructuredSections(supabase as any, "packet-1", withBlank, 0);
  const contactInsert = inserts.find((i) => i.table === "item_contacts");
  const rows = contactInsert!.rows as { name: string; sort_order: number }[];
  assert.equal(rows.length, 2, "blank contact dropped");
  assert.deepEqual(rows.map((r) => r.name), ["Helen", "Joel"]);
  assert.deepEqual(rows.map((r) => r.sort_order), [0, 1], "sort_order re-densified");
});
