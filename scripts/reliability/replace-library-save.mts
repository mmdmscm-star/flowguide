// STEPS 4 and 5 of the controlled Library replacement.
//
// Saves the proposal set through the REAL production save gates, then verifies
// the new records BEFORE anything is deleted. Deletes nothing itself.
//
// On any save failure it stops immediately, leaves all 65 originals untouched,
// and removes only records created during THIS attempt — identified by
// difference against the explicit pre-import id list, never by title, age, or
// "everything except the new ones".
import { svc, errText } from "../ingestion-runtime/lib.mts";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";
const OWNER_EMAIL = "mmdmscm@gmail.com";
const DOC = JSON.parse(readFileSync(process.argv[2], "utf8")) as { runId: string; proposals: Record<string, unknown>[] };
const OLD_IDS: string[] = JSON.parse(readFileSync(process.env.TMPDIR! + "OLD_IDS.json", "utf8"));

const { data: owner, error: oe } = await svc.from("users").select("id").eq("email", OWNER_EMAIL).single();
if (oe) { console.error(errText(oe)); process.exit(1); }
const UID = (owner as { id: string }).id;

const live = async () => ((await svc.from("library_items").select("id").eq("user_id", UID)).data ?? []).map((r: { id: string }) => r.id);
const before = await live();
if (before.length !== 65 || OLD_IDS.length !== 65) { console.error(`refusing: baseline ${before.length}, id list ${OLD_IDS.length}`); process.exit(1); }
if ([...before].sort().join() !== [...OLD_IDS].sort().join()) { console.error("refusing: live ids differ from the pre-import id list"); process.exit(1); }
console.log(`baseline confirmed: 65 records, ids match the pre-import list`);

const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 6 * 3600e3).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`); };

async function rollback(reason: string) {
  const now = await live();
  const created = now.filter((id) => !OLD_IDS.includes(id));
  console.error(`\nSTOPPING: ${reason}`);
  console.error(`removing ONLY the ${created.length} records created by this attempt`);
  if (created.length) await svc.from("library_items").delete().in("id", created);
  const after = await live();
  console.error(`library now: ${after.length} records; all originals present: ${OLD_IDS.every((id) => after.includes(id))}`);
  await svc.from("sessions").delete().eq("token", token);
  process.exit(1);
}

try {
  // ---- STEP 4: save through the real gates -------------------------------
  const ids = DOC.proposals.map((p) => String(p.id));
  console.log(`\nSTEP 4 — saving ${ids.length} proposals through the production gates`);
  const res = await api(`/api/library/import/${DOC.runId}/save`, { method: "POST", body: JSON.stringify({ proposalIds: ids }) });
  const body = await res.json();
  const results = (body?.results ?? []) as { title: string; outcome: string; message?: string; libraryItemId?: string }[];
  const notSaved = results.filter((r) => r.outcome !== "saved");
  console.log(`  saved=${body?.saved} blocked=${body?.blocked} results=${results.length}`);
  for (const r of notSaved) console.log(`    NOT SAVED  ${r.title}: ${r.outcome} ${r.message ?? ""}`);
  if (res.status !== 200) await rollback(`save responded ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (body?.saved !== 65 || notSaved.length) await rollback(`${notSaved.length} proposal(s) did not save`);

  // ---- STEP 5: verify the new set BEFORE any deletion ---------------------
  console.log(`\nSTEP 5 — verifying the new records before deletion`);
  const { data: all } = await svc.from("library_items").select("*").eq("user_id", UID);
  const rows = (all ?? []) as Record<string, unknown>[];
  const newRows = rows.filter((r) => !OLD_IDS.includes(String(r.id)));
  const newIds = newRows.map((r) => String(r.id)).sort();
  writeFileSync(process.env.TMPDIR! + "NEW_IDS.json", JSON.stringify(newIds, null, 1));

  check("[5] exactly 65 new records", newRows.length === 65, String(newRows.length));
  check("[5] all 65 originals still present", OLD_IDS.every((id) => rows.some((r) => String(r.id) === id)), "");
  check("[5] library holds 130 during the overlap", rows.length === 130, String(rows.length));
  check("[5] new and old id sets are disjoint", newIds.every((id) => !OLD_IDS.includes(id)), "");

  const pairs = newRows.flatMap((r) => (r.photos as string[]) ?? []);
  check("[5] 344 community-photo pairs", pairs.length === 344, String(pairs.length));
  check("[5] 343 distinct URLs", new Set(pairs).size === 343, String(new Set(pairs).size));
  const dupUrl = [...new Set(pairs)].filter((u) => pairs.filter((x) => x === u).length > 1);
  const holders = newRows.filter((r) => ((r.photos as string[]) ?? []).includes(dupUrl[0])).map((r) => String(r.title));
  check("[5] the shared photo sits on exactly two records", dupUrl.length === 1 && holders.length === 2,
    `${JSON.stringify(dupUrl)} -> ${JSON.stringify(holders)}`);
  console.log(`        shared photo on: ${JSON.stringify(holders)}`);

  const titles = newRows.map((r) => String(r.title));
  const oldTitles = rows.filter((r) => OLD_IDS.includes(String(r.id))).map((r) => String(r.title));
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  const missingT = oldTitles.filter((t) => !titles.some((n) => key(n) === key(t)));
  check("[5] every original community is represented in the new set", missingT.length === 0, JSON.stringify(missingT));
  check("[5] no duplicate titles in the new set", new Set(titles).size === 65, "");

  for (const name of ["Windsong", "Reserve", "Cogir of North Bay"]) {
    const r = newRows.find((x) => String(x.title).toLowerCase().includes(name.toLowerCase()));
    check(`[5] ${name} present`, !!r, "");
    if (r) console.log(`        ${String(r.title)}: details=${((r.details as unknown[]) ?? []).length} contacts=${((r.contacts as unknown[]) ?? []).length} links=${((r.links as unknown[]) ?? []).length} photos=${((r.photos as unknown[]) ?? []).length}`);
  }
  const windsong = newRows.find((x) => String(x.title).toLowerCase().includes("windsong"));
  if (windsong) console.log(`        Windsong details: ${JSON.stringify(windsong.details)}`);

  check("[5] every new record has a title", newRows.every((r) => String(r.title ?? "").trim().length > 0), "");
  const withContacts = newRows.filter((r) => ((r.contacts as unknown[]) ?? []).length).length;
  const withLinks = newRows.filter((r) => ((r.links as unknown[]) ?? []).length).length;
  const withDetails = newRows.filter((r) => ((r.details as unknown[]) ?? []).length).length;
  const withPhotos = newRows.filter((r) => ((r.photos as unknown[]) ?? []).length).length;
  console.log(`        coverage — contacts:${withContacts}/65 links:${withLinks}/65 details:${withDetails}/65 photos:${withPhotos}/65`);
  const totalContacts = newRows.flatMap((r) => (r.contacts as unknown[]) ?? []).length;
  console.log(`        total contacts:${totalContacts} links:${newRows.flatMap((r) => (r.links as unknown[]) ?? []).length} details:${newRows.flatMap((r) => (r.details as unknown[]) ?? []).length}`);

  console.log(`\nOLD IDS (${OLD_IDS.length}) -> ${process.env.TMPDIR}OLD_IDS.json`);
  console.log(`NEW IDS (${newIds.length}) -> ${process.env.TMPDIR}NEW_IDS.json`);
  if (bad) await rollback(`${bad} verification check(s) failed`);
  console.log(`\nSTEP 5 VERIFICATION: clean — the originals are still present and untouched.`);
  console.log(`Deletion is STEP 6 and is deliberately not performed here.`);
} finally {
  await svc.from("sessions").delete().eq("token", token);
}
