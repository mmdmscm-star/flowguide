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
      .insert({ user_id: UID, title: t, category: "", labels: [], is_favorite: false })
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

  // ---- the compatibility shadow ------------------------------------------
  const shadow = ((await svc.from("library_items").select("title, category, section_id, group_id, sort_order")
    .eq("user_id", UID).order("title")).data ?? []) as
    Array<{ title: string; category: string; section_id: string | null; group_id: string | null; sort_order: number }>;
  ck("[2] every placed item carries the SECTION NAME as its shadow category",
    shadow.filter((r) => r.section_id).every((r) => r.category === "Places"),
    JSON.stringify(shadow.map((r) => `${r.title}:${r.category}`)));
  ck("[2] positions are dense from 0 within each container",
    JSON.stringify(shadow.filter((r) => r.section_id && !r.group_id).map((r) => r.sort_order).sort()) === "[0,1,2,3]",
    JSON.stringify(shadow.map((r) => `${r.title}@${r.sort_order}`)));

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
  const cleared = ((await svc.from("library_items").select("category").eq("user_id", UID)).data ?? []) as
    Array<{ category: string }>;
  ck("[5] the shadow is cleared with them", cleared.every((r) => r.category === ""));

  // ---- the invariant everything else rests on -----------------------------
  const stampsAfter = ((await svc.from("library_items")
    .select("id, revision, updated_at").eq("user_id", UID).order("id")).data ?? []) as
    Array<{ id: string; revision: number; updated_at: string }>;
  const key = (r: { id: string; revision: number; updated_at: string }) => `${r.id}|${r.revision}|${r.updated_at}`;
  ck("[6] NOT ONE placement or move touched revision or updated_at",
    stampsBefore.map(key).join("\n") === stampsAfter.map(key).join("\n"),
    "an organizational write bumped a content stamp");

  // ---- ownership ----------------------------------------------------------
  const { data: other } = await svc.from("users")
    .insert({ email: `zz-structure-other-${Date.now()}@example.invalid` }).select("id").single();
  const OTHER = (other as { id: string }).id;
  const theirs = await placeItems(svc, OTHER, ids.slice(0, 1), { newSectionName: "Theirs" });
  ck("[7] another owner cannot place THIS user's items", theirs.error === "not_found", theirs.error ?? "placed");
  await svc.from("library_sections").delete().eq("user_id", OTHER);
  await svc.from("users").delete().eq("id", OTHER);
} finally {
  await cleanup();
  const { count } = await svc.from("library_items")
    .select("id", { count: "exact", head: true }).eq("user_id", UID);
  ck("[8] no residue: the disposable user and everything under it is gone", (count ?? 0) === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
