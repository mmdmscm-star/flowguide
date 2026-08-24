import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPackets, isPublished } from "./packet-filter.ts";

const P = (title: string, client: string, slug: string, status = "draft") =>
  ({ title, client_name: client, slug, status });
const LIST = [
  P("Senior Living Options", "the Alvarez family", "abc-1", "published"),
  P("Memory Care Shortlist", "the Johnson family", "def-2"),
  P("Assisted Living Tours", "Margaret Chen", "ghi-3", "published"),
  P("Respite Care", "", "jkl-4"),
];

test("an empty query and All returns everything, untouched", () => {
  assert.deepEqual(filterPackets(LIST, "", "all"), LIST);
  assert.deepEqual(filterPackets(LIST, "   ", "all"), LIST);
});

test("ORDER IS PRESERVED — filtering removes, it never re-sorts", () => {
  // The API returns updated_at desc; re-sorting here would silently override it.
  const out = filterPackets(LIST, "", "published");
  assert.deepEqual(out.map((p) => p.slug), ["abc-1", "ghi-3"]);
  const all = filterPackets(LIST, "a", "all");
  assert.deepEqual(all.map((p) => p.slug), LIST.filter((p) => all.includes(p)).map((p) => p.slug));
});

test("matches title, client name and slug, case-insensitively", () => {
  assert.equal(filterPackets(LIST, "MEMORY", "all").length, 1);
  assert.equal(filterPackets(LIST, "alvarez", "all").length, 1);
  assert.equal(filterPackets(LIST, "ghi-3", "all").length, 1);
});

test("search and status combine rather than override", () => {
  // "living" hits two, but only one of them is published.
  assert.equal(filterPackets(LIST, "living", "all").length, 2);
  assert.equal(filterPackets(LIST, "living", "published").length, 2);
  assert.equal(filterPackets(LIST, "memory", "published").length, 0);
  assert.equal(filterPackets(LIST, "memory", "draft").length, 1);
});

test("an empty client name is not a match for everything", () => {
  // "".includes(anything-nonempty) is false, but a careless implementation that
  // tested the other way round would make blank-client packets match all queries.
  assert.equal(filterPackets(LIST, "respite", "all")[0].slug, "jkl-4");
  assert.equal(filterPackets(LIST, "zzz", "all").length, 0);
});

test("anything not published counts as a draft", () => {
  // A status nobody anticipated should appear under Drafts, not vanish from
  // every view.
  const odd = [P("Odd one", "x", "odd-1", "archived_someday")];
  assert.equal(filterPackets(odd, "", "draft").length, 1);
  assert.equal(filterPackets(odd, "", "published").length, 0);
  assert.equal(isPublished(odd[0]), false);
});

test("no matches is an empty list, never the whole list", () => {
  // The dashboard shows a different state for this than for an empty account,
  // and that distinction depends on this returning [].
  assert.deepEqual(filterPackets(LIST, "nothing matches this", "all"), []);
  assert.deepEqual(filterPackets([], "", "all"), []);
});
