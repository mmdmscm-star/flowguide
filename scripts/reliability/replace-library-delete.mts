// STEP 6 of the controlled Library replacement: remove the ORIGINAL 65.
//
// Deletion is by the explicit pre-import id list and nothing else — never by
// title, age, creation time, count, or "everything except the new set". Any of
// those would delete whatever happened to match, which is not the same thing.
//
// Refuses unless the library is exactly the two known cohorts and nothing else.
import { svc } from "../ingestion-runtime/lib.mts";
import { readFileSync } from "node:fs";
import { photosIn } from "../../src/lib/photo-attribution.ts";

const OLD_IDS: string[] = JSON.parse(readFileSync(process.env.TMPDIR! + "OLD_IDS.json", "utf8"));
const NEW_IDS: string[] = JSON.parse(readFileSync(process.env.TMPDIR! + "NEW_IDS.json", "utf8"));
const SRC = readFileSync(process.env.TMPDIR! + "master-source-corrected.txt", "utf8");

const { data: owner } = await svc.from("users").select("id").eq("email", "mmdmscm@gmail.com").single();
const UID = (owner as { id: string }).id;
const idsNow = async () => ((await svc.from("library_items").select("id").eq("user_id", UID)).data ?? [])
  .map((r: { id: string }) => String(r.id));

// ---- preconditions -------------------------------------------------------
const before = await idsNow();
const fail = (m: string) => { console.error(`REFUSING TO DELETE: ${m}`); process.exit(1); };
// Re-runnable as a verification pass once the deletion has happened: the
// library is then the new cohort alone, and there is nothing left to delete.
const VERIFY_ONLY = before.length === 65 && before.every((id) => NEW_IDS.includes(id));
if (VERIFY_ONLY) console.log("already replaced — running FINAL VERIFICATION only, deleting nothing");
if (!VERIFY_ONLY) {
if (OLD_IDS.length !== 65) fail(`old id list holds ${OLD_IDS.length}`);
if (NEW_IDS.length !== 65) fail(`new id list holds ${NEW_IDS.length}`);
if (OLD_IDS.some((id) => NEW_IDS.includes(id))) fail("the two id lists overlap");
if (before.length !== 130) fail(`library holds ${before.length}, expected the 130-record overlap`);
const expected = new Set([...OLD_IDS, ...NEW_IDS]);
if (before.some((id) => !expected.has(id))) fail("the library holds a record in neither cohort");
if (!OLD_IDS.every((id) => before.includes(id))) fail("an original is already missing");
if (!NEW_IDS.every((id) => before.includes(id))) fail("a new record is missing");
console.log("preconditions: 130 records = exactly the 65 originals + the 65 new, disjoint");

// ---- delete, by id list only ---------------------------------------------
const { error } = await svc.from("library_items").delete().eq("user_id", UID).in("id", OLD_IDS);
if (error) { console.error("delete failed:", JSON.stringify(error)); process.exit(1); }
console.log(`deleted by explicit id list: ${OLD_IDS.length} ids`);
}

// ---- final verification --------------------------------------------------
let bad = 0;
const ck = (n: string, ok: boolean, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok || !d ? "" : `  — ${d}`}`); };

const { data: all } = await svc.from("library_items").select("*").eq("user_id", UID);
const rows = (all ?? []) as Record<string, unknown>[];
const ids = rows.map((r) => String(r.id));

ck("[F] exactly 65 records remain", rows.length === 65, String(rows.length));
ck("[F] every remaining id is in the new 65", ids.every((id) => NEW_IDS.includes(id)),
  JSON.stringify(ids.filter((id) => !NEW_IDS.includes(id)).slice(0, 5)));
ck("[F] none of the old 65 remain", !ids.some((id) => OLD_IDS.includes(id)),
  JSON.stringify(ids.filter((id) => OLD_IDS.includes(id)).slice(0, 5)));
ck("[F] the whole new cohort survived", NEW_IDS.every((id) => ids.includes(id)),
  JSON.stringify(NEW_IDS.filter((id) => !ids.includes(id)).slice(0, 5)));

const pairs = rows.flatMap((r) => (r.photos as string[]) ?? []);
ck("[F] 344 community-photo pairs", pairs.length === 344, String(pairs.length));
ck("[F] 343 distinct photo URLs", new Set(pairs).size === 343, String(new Set(pairs).size));

// per-community identity against an INDEPENDENT reading of the source headers
const lines = SRC.split("\n");
const isHead = (l: string) => /^[^\s].* [—–] .+$/.test(l) && !l.includes(":") && l.length < 80 && !/\$/.test(l);
const HL = "The Reserve at Fountaingrove 200 Fountaingrove";
let used = false; const heads: { t: string; i: number }[] = [];
for (let i = 0; i < lines.length; i++) {
  const an = !used && lines[i].startsWith(HL); if (an) used = true;
  if (isHead(lines[i]) || an) heads.push({ t: lines[i].trim(), i });
}
const key = (t: string) => t.split(/\s[—–]\s/)[0].replace(/\([^)]*\)/g, "").replace(/\d+.*$/, "")
  .toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 22);
const truth = new Map<string, string[]>();
heads.forEach((h, k) => truth.set(key(h.t),
  photosIn(lines.slice(h.i, k + 1 < heads.length ? heads[k + 1].i : lines.length).join("\n"))));
const wrong: string[] = [];
for (const [k, want] of truth) {
  const r = rows.find((x) => key(String(x.title)) === k);
  const have = ((r?.photos as string[]) ?? []);
  if (JSON.stringify([...have].sort()) !== JSON.stringify([...want].sort()))
    wrong.push(`${k}: has ${have.length} want ${want.length}`);
}
ck("[F] all 65 match their source photo sets exactly", wrong.length === 0 && truth.size === 65,
  `${truth.size} communities, ${wrong.length} wrong: ${JSON.stringify(wrong.slice(0, 4))}`);

const g = rows.find((r) => String(r.title).startsWith("Greenwood"));
const m = rows.find((r) => String(r.title).startsWith("St Michael"));
const D = /locally owned and operated assisted living and memory care/i;
ck("[F] Greenwood retains the corrected description", D.test(String(g?.description ?? "")), "");
ck("[F] St Michael's contains no Greenwood description", !D.test(String(m?.description ?? "")),
  String(m?.description ?? "").slice(0, 70));

const c = rows.find((r) => String(r.title).toLowerCase().includes("vallejo hills"));
const facing = `${String(c?.description ?? "")} ${JSON.stringify(c?.details ?? [])}`;
ck("[F] Cogir of Vallejo Hills keeps the waitlist information client-facing", /waitlist/i.test(facing), "");
ck("[F] ...and the assessment information", /assessment required/i.test(facing), "");
ck("[F] ...with nothing of it hidden in the private note", !/waitlist|assessment/i.test(String(c?.notes ?? "")), "");

const w = rows.find((r) => String(r.title).toLowerCase().includes("windsong"));
const wd = (w?.details as Array<{ label?: string }>) ?? [];
ck("[F] Windsong keeps both shared-studio rows separate",
  wd.filter((d) => /shared studio/i.test(String(d.label))).length === 2, JSON.stringify(wd.length));
ck("[F] Windsong carries no blended range", !JSON.stringify(wd).includes("$5,200-$6,250"), "");

// ---- residue -------------------------------------------------------------
const { data: openRuns } = await svc.from("ingestion_runs").select("id,status,destination")
  .in("status", ["active", "finalizing", "needs_review"]);
ck("[F] no open import or ingestion runs anywhere", (openRuns ?? []).length === 0, JSON.stringify(openRuns));
const { data: disposables } = await svc.from("users").select("id,email").like("email", "%@disposable.invalid");
ck("[F] no disposable test users remain", (disposables ?? []).length === 0,
  JSON.stringify((disposables ?? []).map((u: { email: string }) => u.email)));
const { count: leftoverProps } = await svc.from("library_import_proposals").select("id", { count: "exact", head: true });
ck("[F] no import proposals left staged", (leftoverProps ?? 0) === 0, String(leftoverProps));
const { data: otherLib } = await svc.from("library_items").select("user_id").neq("user_id", UID);
ck("[F] no library rows belong to anyone else", (otherLib ?? []).length === 0, String((otherLib ?? []).length));

console.log(bad ? `\nFINAL VERIFICATION: ${bad} FAILED` : "\nFINAL VERIFICATION: clean");
process.exit(bad ? 1 : 0);
