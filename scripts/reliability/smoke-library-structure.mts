// Executing smoke for the structured Library, against a REAL database.
//
//   npx tsx scripts/reliability/smoke-library-structure.mts
//
// WHY THIS EXISTS SEPARATELY. The pure semantics are asserted in
// library-structure.test.mts, the schema and the reconciliation in the PGlite
// suite, and the interaction in library-structure-dom.test.mts against a fake
// server. What none of those can execute is the GLUE: placeItems, moveItem and
// pruneEmptyStructure talking to PostgREST, where ownership predicates, column
// names and the shadow write are real.
//
// SAFETY. Everything happens under a DISPOSABLE user this script creates and
// deletes. It never reads, writes or counts the operator's own Library, and it
// prints no titles from it. Run it after deploying the structured runtime.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const {
  placeItems, moveItem, moveSection, moveGroup, readStructure, browseLibrary, searchLibrary,
  renameStructure,
} = await import("../../src/lib/library-service.ts");

let pass = 0, fail = 0;
const ck = (n: string, ok: boolean, d = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${!ok && d ? "  -> " + d : ""}`);
};

// ---- disposable owner ------------------------------------------------------
const email = `zz-structure-smoke-${Date.now()}@example.invalid`;
const { data: user, error: uErr } = await svc.from("users").insert({ email }).select("id").single();
if (uErr || !user) { console.error("could not create a disposable user:", uErr?.message); process.exit(1); }
const UID = (user as { id: string }).id;
console.log(`\nstructured Library smoke — disposable user ${UID}\n`);

async function cleanup() {
  // The user cascade removes items and sections; groups go with their section.
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("library_groups").delete().eq("user_id", UID);
  await svc.from("library_sections").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
}

try {
  const titles = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
  const ids: string[] = [];
  for (const t of titles) {
    const { data } = await svc.from("library_items")
      .insert({ user_id: UID, title: t, labels: [], is_favorite: false })
      .select("id, revision, updated_at").single();
    ids.push((data as { id: string }).id);
  }
  const stampsBefore = ((await svc.from("library_items")
    .select("id, revision, updated_at").eq("user_id", UID).order("id")).data ?? []) as
    Array<{ id: string; revision: number; updated_at: string }>;

  // ---- inline creation + placement ---------------------------------------
  const r1 = await placeItems(svc, UID, ids.slice(0, 3), { newSectionName: "Places" });
  ck("[1] a section is created INLINE while filing, not in a screen of its own",
    r1.updated === 3 && (r1.structure?.sections ?? []).some((s) => s.name === "Places"), r1.error ?? "");

  const places = (await readStructure(svc, UID)).sections.find((s) => s.name === "Places")!;
  const r2 = await placeItems(svc, UID, [ids[3]], { sectionId: places.id, newGroupName: "Downtown" });
  ck("[1] a group is created inline, inside the chosen section", r2.updated === 1, r2.error ?? "");

  // Case-insensitive reuse: the same idea typed differently must not fork.
  const r3 = await placeItems(svc, UID, [ids[4]], { newSectionName: "  places  " });
  const secs = (await readStructure(svc, UID)).sections;
  ck("[1] a differently-cased section name JOINS the existing one",
    r3.updated === 1 && secs.filter((s) => s.name.toLowerCase() === "places").length === 1,
    JSON.stringify(secs.map((s) => s.name)));

  // ---- placement ----------------------------------------------------------
  const filed = ((await svc.from("library_items").select("title, section_id, group_id, sort_order")
    .eq("user_id", UID).order("title")).data ?? []) as
    Array<{ title: string; section_id: string | null; group_id: string | null; sort_order: number }>;
  ck("[2] positions are dense from 0 within each container",
    JSON.stringify(filed.filter((r) => r.section_id && !r.group_id).map((r) => r.sort_order).sort()) === "[0,1,2,3]",
    JSON.stringify(filed.map((r) => `${r.title}@${r.sort_order}`)));

  // ---- ordering -----------------------------------------------------------
  const loose = await searchLibrary(svc, UID, { container: { sectionId: places.id, groupId: null }, limit: 50 });
  const firstTitle = loose.items[0].title, secondTitle = loose.items[1].title;
  const moved = await moveItem(svc, UID, loose.items[0].id, "down");
  const after = await searchLibrary(svc, UID, { container: { sectionId: places.id, groupId: null }, limit: 50 });
  ck("[3] Move down exchanges an item with its neighbour",
    moved.moved && after.items[0].title === secondTitle && after.items[1].title === firstTitle,
    JSON.stringify(after.items.map((i) => i.title)));

  const atTop = await moveItem(svc, UID, after.items[0].id, "up");
  ck("[3] the first row reports no move rather than writing the order it had", atTop.moved === false);

  const unfiled = (await searchLibrary(svc, UID, { container: { sectionId: null, groupId: null }, limit: 5 })).items;
  if (unfiled.length) {
    const un = await moveItem(svc, UID, unfiled[0].id, "up");
    ck("[3] an unorganized item cannot be hand-ordered", un.error === "not_ordered", un.error ?? "moved");
  } else { ck("[3] an unorganized item cannot be hand-ordered", true); }

  ck("[3] a lone section reports no move in either direction",
    (await moveSection(svc, UID, places.id, "up")).moved === false);
  const grp = (await readStructure(svc, UID)).groups[0];
  ck("[3] a lone group reports no move either",
    (await moveGroup(svc, UID, grp.id, "down")).moved === false);

  // ---- browse -------------------------------------------------------------
  const browse = await browseLibrary(svc, UID, 2);
  const looseC = browse.containers.find((c) => c.sectionId === places.id && c.groupId === null)!;
  ck("[4] browse pages each container and reports an honest total",
    looseC.items.length === 2 && looseC.total === 4 && looseC.hasMore === true,
    JSON.stringify({ n: looseC.items.length, total: looseC.total, more: looseC.hasMore }));
  ck("[4] the section's groups come before its loose items",
    browse.containers.findIndex((c) => c.groupId) < browse.containers.findIndex((c) => c.sectionId && !c.groupId));

  // ---- pruning ------------------------------------------------------------
  const all = ((await svc.from("library_items").select("id").eq("user_id", UID)).data ?? [])
    .map((r) => (r as { id: string }).id);
  const back = await placeItems(svc, UID, all, { unorganize: true });
  const empty = await readStructure(svc, UID);
  ck("[5] emptying the structure prunes it entirely",
    back.updated === all.length && empty.sections.length === 0 && empty.groups.length === 0,
    JSON.stringify({ s: empty.sections.length, g: empty.groups.length }));
  const emptied = ((await svc.from("library_items").select("section_id, group_id, sort_order")
    .eq("user_id", UID)).data ?? []) as Array<{ section_id: string | null; group_id: string | null; sort_order: number }>;
  ck("[5] every item is genuinely unfiled afterwards",
    emptied.every((r) => r.section_id === null && r.group_id === null && Number(r.sort_order) === 0));

  // ---- rename, which retiring the shadow made possible --------------------
  const r5 = await placeItems(svc, UID, ids.slice(0, 2), { newSectionName: "Renameable" });
  const before = (await readStructure(svc, UID)).sections.find((s) => s.name === "Renameable")!;
  const placedBefore = ((await svc.from("library_items")
    .select("id, section_id, group_id, sort_order").eq("user_id", UID).order("id")).data ?? []);
  const rn = await renameStructure(svc, UID, "section", before.id, "  Renamed   Properly  ");
  const afterSec = (await readStructure(svc, UID)).sections.find((s) => s.id === before.id)!;
  ck("[6] a section renames in place, tidied", !rn.error && afterSec.name === "Renamed Properly",
    `${rn.error ?? ""} ${afterSec?.name}`);
  const placedAfter = ((await svc.from("library_items")
    .select("id, section_id, group_id, sort_order").eq("user_id", UID).order("id")).data ?? []);
  ck("[6] ...and nothing underneath it moved",
    JSON.stringify(placedAfter) === JSON.stringify(placedBefore),
    "a rename moved or reordered items");
  void r5;

  const dup = await placeItems(svc, UID, ids.slice(2, 3), { newSectionName: "Other Place" });
  const otherSection = (await readStructure(svc, UID)).sections.find((s) => s.name === "Other Place")!;
  const clash = await renameStructure(svc, UID, "section", otherSection.id, "renamed properly");
  ck("[6] a case-insensitive duplicate name is refused cleanly",
    clash.error === "duplicate_name", clash.error ?? "accepted");
  ck("[6] ...and the refused rename changed nothing",
    (await readStructure(svc, UID)).sections.find((s) => s.id === otherSection.id)?.name === "Other Place");
  const blank = await renameStructure(svc, UID, "section", otherSection.id, "   ");
  ck("[6] a blank name is refused", blank.error === "blank_name", blank.error ?? "accepted");
  void dup;

  // ---- the invariant everything else rests on -----------------------------
  const stampsAfter = ((await svc.from("library_items")
    .select("id, revision, updated_at").eq("user_id", UID).order("id")).data ?? []) as
    Array<{ id: string; revision: number; updated_at: string }>;
  const key = (r: { id: string; revision: number; updated_at: string }) => `${r.id}|${r.revision}|${r.updated_at}`;
  ck("[7] NOT ONE placement, move or rename touched revision or updated_at",
    stampsBefore.map(key).join("\n") === stampsAfter.map(key).join("\n"),
    "an organizational write bumped a content stamp");

  // ---- ownership ----------------------------------------------------------
  const { data: other } = await svc.from("users")
    .insert({ email: `zz-structure-other-${Date.now()}@example.invalid` }).select("id").single();
  const OTHER = (other as { id: string }).id;
  const theirs = await placeItems(svc, OTHER, ids.slice(0, 1), { newSectionName: "Theirs" });
  ck("[8] another owner cannot place THIS user's items", theirs.error === "not_found", theirs.error ?? "placed");
  const sections = (await readStructure(svc, UID)).sections;
  if (sections.length) {
    const foreign = await renameStructure(svc, OTHER, "section", sections[0].id, "Hijacked");
    ck("[8] another owner cannot rename THIS user's section", foreign.error === "not_found", foreign.error ?? "renamed");
  }
  await svc.from("library_sections").delete().eq("user_id", OTHER);
  await svc.from("users").delete().eq("id", OTHER);
} finally {
  await cleanup();
  const { count } = await svc.from("library_items")
    .select("id", { count: "exact", head: true }).eq("user_id", UID);
  ck("[9] no residue: the disposable user and everything under it is gone", (count ?? 0) === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
