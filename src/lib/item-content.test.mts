// Focused tests for the shared item-content persistence helper (R2-B).
// Run: node --test src/lib/item-content.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyItemContentUpdate } from "./item-content.ts";

// Minimal chainable, awaitable mock that records every operation.
function mockSupabase() {
  const calls: { op: string; table: string | null; value?: unknown }[] = [];
  const chain: Record<string, unknown> = {
    _table: null as string | null,
    from(t: string) { (chain as { _table: string })._table = t; calls.push({ op: "from", table: t }); return chain; },
    update(v: unknown) { calls.push({ op: "update", table: chain._table as string, value: v }); return chain; },
    delete() { calls.push({ op: "delete", table: chain._table as string }); return chain; },
    insert(v: unknown) { calls.push({ op: "insert", table: chain._table as string, value: v }); return chain; },
    eq() { return chain; },
    then(resolve: (v: { error: null }) => void) { resolve({ error: null }); },
  };
  return { supabase: chain, calls };
}

const opsOn = (calls: { op: string; table: string | null }[], table: string) =>
  calls.filter((c) => c.table === table && c.op !== "from").map((c) => c.op);

test("core fields → single items.update with only content columns", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, "item-1", { title: "T", description: "D", notes: "N", address: "A" });
  const upd = calls.find((c) => c.op === "update" && c.table === "items");
  assert.ok(upd, "items.update called");
  assert.deepEqual((upd as { value: unknown }).value, { title: "T", description: "D", notes: "N", address: "A" });
});

test("details/links replace = delete then insert with sort_order", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, "item-1", {
    details: [{ label: "Care", value: "AL" }],
    links: [{ url: "https://x.test", label: "Site" }],
  });
  assert.deepEqual(opsOn(calls, "item_details"), ["delete", "insert"]);
  assert.deepEqual(opsOn(calls, "item_links"), ["delete", "insert"]);
  const det = calls.find((c) => c.op === "insert" && c.table === "item_details") as { value: { sort_order: number }[] };
  assert.equal(det.value[0].sort_order, 0);
});

test("photos: only http(s) URLs are stored", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, "item-1", {
    photos: [{ url: "https://ok.test/a.jpg" }, { url: "javascript:evil" }, { url: "not-a-url" }],
  });
  const ins = calls.find((c) => c.op === "insert" && c.table === "item_photos") as { value: { url: string }[] };
  assert.equal(ins.value.length, 1, "only the http url is stored");
  assert.equal(ins.value[0].url, "https://ok.test/a.jpg");
});

test("one contact → delete + insert; empty array → delete only", async () => {
  {
    const { supabase, calls } = mockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyItemContentUpdate(supabase as any, "item-1", { contacts: [{ name: "Jo", phone: "555" }] });
    assert.deepEqual(opsOn(calls, "item_contacts"), ["delete", "insert"]);
    const ins = calls.find((c) => c.op === "insert" && c.table === "item_contacts") as { value: { sort_order: number }[] };
    assert.equal(ins.value.length, 1, "one row written");
    assert.equal(ins.value[0].sort_order, 0);
  }
  {
    const { supabase, calls } = mockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyItemContentUpdate(supabase as any, "item-1", { contacts: [] });
    assert.deepEqual(opsOn(calls, "item_contacts"), ["delete"], "empty list clears without insert");
  }
});

test("multiple contacts → every person preserved, in order, with per-person fields", async () => {
  const { supabase, calls } = mockSupabase();
  // Two co-owners of the same community — the exact case that used to drop the second.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, "item-1", {
    contacts: [
      { name: "Helen", role: "Co-owner", phone: "(415) 205-3276" },
      { name: "Joel", role: "Co-owner", phone: "(415) 203-3624" },
    ],
  });
  const ins = calls.find((c) => c.op === "insert" && c.table === "item_contacts") as {
    value: { name: string; role: string; phone: string; sort_order: number }[];
  };
  assert.equal(ins.value.length, 2, "BOTH people written — the second is never dropped");
  assert.deepEqual(ins.value.map((r) => r.name), ["Helen", "Joel"], "entered order preserved");
  assert.deepEqual(ins.value.map((r) => r.sort_order), [0, 1], "sort_order is deterministic");
  // Each person keeps their OWN phone — no cross-assignment.
  assert.equal(ins.value[0].phone, "(415) 205-3276");
  assert.equal(ins.value[1].phone, "(415) 203-3624");
  assert.deepEqual(ins.value.map((r) => r.role), ["Co-owner", "Co-owner"], "roles stored only as given");
});

test("blank contact rows are dropped even amid real ones (no empty rows saved)", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, "item-1", {
    contacts: [
      { name: "Helen", phone: "(415) 205-3276" },
      { name: "", role: "", phone: "", email: "", website: "" }, // blank while editing
      { name: "Joel", phone: "(415) 203-3624" },
    ],
  });
  const ins = calls.find((c) => c.op === "insert" && c.table === "item_contacts") as { value: { name: string; sort_order: number }[] };
  assert.equal(ins.value.length, 2, "the blank row is not persisted");
  assert.deepEqual(ins.value.map((r) => r.name), ["Helen", "Joel"]);
  assert.deepEqual(ins.value.map((r) => r.sort_order), [0, 1], "sort_order re-densified after dropping blank");
});

test("omitted fields touch nothing; NEVER writes items sort_order/section_id or composition tables", async () => {
  const { supabase, calls } = mockSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await applyItemContentUpdate(supabase as any, "item-1", { title: "Only title" });
  // no child-table ops
  for (const t of ["item_links", "item_details", "item_photos", "item_contacts", "sections", "packet_blocks", "packets"]) {
    assert.deepEqual(opsOn(calls, t), [], `${t} untouched`);
  }
  // the single items.update carries only content, never sort_order/section_id
  const upd = calls.find((c) => c.op === "update" && c.table === "items") as { value: Record<string, unknown> };
  assert.ok(!("sort_order" in upd.value) && !("section_id" in upd.value), "no order/membership columns");
});
