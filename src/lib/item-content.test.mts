// Focused tests for the shared item-content persistence helper. It now delegates
// to ONE atomic RPC (update_item_content), so these assert the exact RPC name +
// parameter mapping — including presence semantics (omitted field -> null ->
// unchanged) that let the legacy editor autosave one field group at a time while
// each request stays atomic. The transactional behavior itself is proven from
// the SQL in block-item-rpc.test.mts.
// Run: node --test src/lib/item-content.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyItemContentUpdate } from "./item-content.ts";

// Mock that records the single rpc(name, params) call.
function mockSupabase(error: { message: string } | null = null) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  const supabase = {
    rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, params });
      return Promise.resolve({ error });
    },
  };
  return { supabase, calls };
}

test("calls the single atomic RPC update_item_content with ctx mapped to params", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, { itemId: "item-1", ownerId: "user-9", packetId: "pk-3", requireMode: "blocks" }, { title: "T" });
  assert.equal(calls.length, 1, "exactly one RPC call (atomic, single round-trip)");
  assert.equal(calls[0].name, "update_item_content");
  const p = calls[0].params;
  assert.equal(p.p_item_id, "item-1");
  assert.equal(p.p_owner_id, "user-9");
  assert.equal(p.p_packet_id, "pk-3");
  assert.equal(p.p_require_mode, "blocks");
});

test("presence semantics: omitted fields become null (left unchanged); provided are passed", async () => {
  const { supabase, calls } = mockSupabase();
  // Legacy autosave of a single field group (title only).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, { itemId: "item-1", ownerId: "u", requireMode: "legacy" }, { title: "Only title" });
  const p = calls[0].params;
  assert.equal(p.p_title, "Only title", "provided field passed");
  assert.equal(p.p_description, null, "omitted core field -> null -> unchanged");
  assert.equal(p.p_notes, null);
  assert.equal(p.p_address, null);
  assert.equal(p.p_details, null, "omitted child -> null -> untouched");
  assert.equal(p.p_links, null);
  assert.equal(p.p_photos, null);
  assert.equal(p.p_contacts, null);
  assert.equal(p.p_packet_id, null, "no packet cross-check when not supplied");
  assert.equal(p.p_require_mode, "legacy");
});

test("empty string is a real value (not treated as absent)", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, { itemId: "i", ownerId: "u" }, { title: "", address: "" });
  const p = calls[0].params;
  assert.equal(p.p_title, "", "empty string passed through -> sets the column empty");
  assert.equal(p.p_address, "");
});

test("contacts array is passed verbatim as p_contacts (ordered, every person)", async () => {
  const { supabase, calls } = mockSupabase();
  const contacts = [
    { name: "Helen", role: "Co-owner", phone: "(415) 205-3276" },
    { name: "Joel", role: "Co-owner", phone: "(415) 203-3624" },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, { itemId: "i", ownerId: "u" }, { contacts });
  assert.deepEqual(calls[0].params.p_contacts, contacts, "both contacts handed to the RPC in order");
});

test("empty contacts array means REPLACE-with-none (passed as [], not null)", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, { itemId: "i", ownerId: "u" }, { contacts: [] });
  assert.deepEqual(calls[0].params.p_contacts, [], "[] clears contacts; null would have left them untouched");
});

test("RPC error is surfaced as { error }", async () => {
  const { supabase } = mockSupabase({ message: "item content: contacts must be a JSON array" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await applyItemContentUpdate(supabase as any, { itemId: "i", ownerId: "u" }, { contacts: [] });
  assert.equal(res.error, "item content: contacts must be a JSON array");
});
