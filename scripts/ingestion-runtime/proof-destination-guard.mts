// THE DESTINATION GUARD, THROUGH THE LIVE ROUTES.
//
// The same source, the same flag, the same forced unauthorized private-note
// proposal - sent down both paths. The contract must act on one and be
// completely absent from the other.
//
//   LIBRARY  -> the note survives, stays visible to its owner, no review state
//   PACKET   -> the note is rejected, held in review_units, publishing blocked
//
// WHY THE LIBRARY IS EXCLUDED AND NOT MERELY UNPROTECTED
// A Library import closes through `library_close_import_run`, which clears the
// transport channel. A unit held there would be stripped and then discarded
// with nobody having seen it. Without enforcement the note is shown to its
// owner as "Private note - Only you see this", so declining PRESERVES content;
// enforcing without surfacing would turn a visible note into a deletion.
//
// Requires a server started with FLOWGUIDE_ENFORCE_CONTRACT=1 and
// FLOWGUIDE_TEST_FAULT_FILE set. Bounded and disposable throughout.
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";
import { isResolvable } from "../../src/lib/review-units.ts";
import { writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const TAG = "flowguide-guard-" + process.pid;
const NOTE = "They are wonderful with families and the director will meet you on a weekend.";

const SOURCE = [
  "1. Alpha House", "Address: 1 Alpha Way, Seattle WA", "Phone: (206) 555-0101", "alphahouse.com",
  "", "2. Beta Place", "Address: 2 Beta Rd, Tacoma WA", "Phone: (253) 555-0102", "betaplace.com",
  "", "3. Gamma Court", "Address: 3 Gamma Ave, Everett WA", "Phone: (425) 555-0103", "gammacourt.com",
].join("\n");

const FAULTS = process.env.FLOWGUIDE_TEST_FAULT_FILE;
if (!FAULTS) { console.error("FLOWGUIDE_TEST_FAULT_FILE is required"); process.exit(2); }
// Ordinals 0-3: whichever chunk the source lands in, its first item comes back
// carrying an unauthorized private note. Nothing in SOURCE grants privacy.
const arm = () => writeFileSync(FAULTS, JSON.stringify({
  flowguideFaultInjection: true,
  privateNote: { "0": NOTE, "1": NOTE, "2": NOTE, "3": NOTE },
}));
const disarm = () => writeFileSync(FAULTS, JSON.stringify({ flowguideFaultInjection: true }));

const users: string[] = [];
const libIds: string[] = [];

async function makeUser(label: string) {
  const { data, error } = await svc.from("users")
    .insert({ email: `${TAG}-${label}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(errText(error));
  const id = (data as { id: string }).id; users.push(id);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: id, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return { id, cookie: `flowguide_session=${token}` };
}
const api = async (path: string, cookie: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) }, signal: AbortSignal.timeout(120_000) });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) as any };
};
async function drive(runId: string, cookie: string) {
  for (let g = 0; g < 60; g++) {
    const { data: st } = await api(`/api/ingest/${runId}`, cookie);
    const next = ((st.chunks ?? []) as any[]).find((c) => c.status === "pending" || c.status === "failed");
    if (!next) return;
    const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, cookie, { method: "POST" });
    const o = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (o.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${o.message}`);
    if (o.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
  }
}
const chunksOf = async (runId: string) => {
  const { data } = await svc.from("ingestion_chunks")
    .select("ordinal, result, review_units, fact_ledger").eq("run_id", runId).neq("status", "split");
  return (data ?? []) as Array<{ ordinal: number; result: any; review_units: any[] | null; fact_ledger: any }>;
};

try {
  arm();

  // =========================================================== LIBRARY =====
  const lib = await makeUser("lib");
  const created = await api("/api/library/import", lib.cookie, {
    method: "POST", body: JSON.stringify({ rawText: SOURCE }),
  });
  check("a Library import starts", created.status === 201, JSON.stringify(created.data).slice(0, 140));
  const LRUN = created.data.runId as string;
  await drive(LRUN, lib.cookie);

  const lc = await chunksOf(LRUN);
  const lStaged = lc.flatMap((c) =>
    (c.result?.items ?? []).concat((c.result?.sections ?? []).flatMap((s: any) => s.items ?? [])));
  // ABSENCE READS AS SUCCESS: with nothing staged, "the note survived" and "the
  // note never existed" are the same empty check.
  check("the Library run staged items", lStaged.length > 0, `${lStaged.length} staged items`);
  const noted = lStaged.filter((i: any) => String(i?.notes ?? "").includes("meet you on a weekend"));
  check("the forced private note SURVIVED the Library path unchanged",
    noted.length > 0 && noted[0].notes === NOTE,
    `${noted.length} item(s) carry it; ${JSON.stringify(noted[0]?.notes ?? null).slice(0, 80)}`);

  const lTel = lc.map((c) => c.fact_ledger?.enforcement).filter(Boolean);
  check("enforcement recorded that it DECLINED, rather than saying nothing",
    lTel.length > 0 && lTel.every((t: any) => t.scope === "out-of-scope"),
    JSON.stringify(lTel.map((t: any) => t.scope)));
  check("no semantic stripping occurred on the Library path",
    lTel.every((t: any) => t.stripped === 0 && t.itemsGoverned === 0 && t.privacyRejected === 0),
    JSON.stringify(lTel).slice(0, 160));
  check("review_units is empty on every Library chunk",
    lc.every((c) => c.review_units === null || (c.review_units ?? []).length === 0),
    JSON.stringify(lc.map((c) => c.review_units)).slice(0, 120));

  const { data: lrun } = await svc.from("ingestion_runs").select("status, review").eq("id", LRUN).single();
  check("no packet review state was created for the Library run",
    (((lrun as any)?.review?.failures) ?? []).length === 0 && (lrun as any)?.status !== "needs_review",
    `${(lrun as any)?.status} ${JSON.stringify((lrun as any)?.review).slice(0, 100)}`);

  // ...and the creator can actually SEE it, which is the whole reason the
  // Library is safer without enforcement than with it.
  const mat = await api(`/api/library/import/${LRUN}/proposals`, lib.cookie, { method: "POST" });
  const props = (mat.data.proposals ?? []) as Array<{ id: string; title: string }>;
  check("Library proposals materialise as usual", props.length > 0, `${props.length} proposals`);
  const save = await api(`/api/library/import/${LRUN}/save`, lib.cookie, {
    method: "POST", body: JSON.stringify({ proposalIds: props.map((p) => p.id) }) });
  const savedIds = ((save.data.results ?? []) as any[]).filter((r) => r.outcome === "saved").map((r) => r.libraryItemId);
  libIds.push(...savedIds);
  check("the entries save to the Library", savedIds.length > 0, JSON.stringify(save.data).slice(0, 140));

  const { data: savedRows } = await svc.from("library_items")
    .select("id, title, notes").in("id", savedIds.length ? savedIds : ["00000000-0000-0000-0000-000000000000"]);
  const keeper = (savedRows ?? []).find((r: any) => String(r.notes ?? "").includes("meet you on a weekend"));
  check("the note is VISIBLE TO THE CREATOR on the saved Library entry",
    !!keeper && keeper.notes === NOTE, JSON.stringify(keeper?.notes ?? null).slice(0, 90));

  // ============================================================ PACKET =====
  const pk = await makeUser("packet");
  const org = await api("/api/ingest/organize", pk.cookie, { method: "POST", body: JSON.stringify({
    rawText: SOURCE, packetType: "general", requestKey: crypto.randomUUID() }) });
  check("a packet import starts", org.status === 201, JSON.stringify(org.data).slice(0, 140));
  const PRUN = org.data.runId as string;
  await drive(PRUN, pk.cookie);

  const pc = await chunksOf(PRUN);
  const pTel = pc.map((c) => c.fact_ledger?.enforcement).filter(Boolean);
  check("enforcement RAN on the packet path", pTel.length > 0 && pTel.every((t: any) => t.scope === "enforced"),
    JSON.stringify(pTel.map((t: any) => t.scope)));
  check("the unauthorized private note was REJECTED",
    pTel.reduce((n: number, t: any) => n + (t.privacyRejected ?? 0), 0) > 0,
    JSON.stringify(pTel.map((t: any) => t.privacyRejected)));

  const pStaged = pc.flatMap((c) =>
    (c.result?.items ?? []).concat((c.result?.sections ?? []).flatMap((s: any) => s.items ?? [])));
  check("no staged packet item still carries it in the private field",
    pStaged.every((i: any) => !String(i?.notes ?? "").includes("meet you on a weekend")),
    JSON.stringify(pStaged.map((i: any) => i?.notes ?? null)).slice(0, 120));
  check("...and it was NOT auto-placed into Description",
    pStaged.every((i: any) => !String(i?.description ?? "").includes("meet you on a weekend")),
    "descriptions clean");

  const pUnits = pc.flatMap((c) => c.review_units ?? []);
  check("the prose entered the dedicated review_units channel",
    pUnits.some((u: any) => String(u.text ?? "").includes("meet you on a weekend")),
    `${pUnits.length} unit(s)`);

  const fin = await api(`/api/ingest/${PRUN}/finalize`, pk.cookie, { method: "POST", body: "{}" });
  check("finalize returns a review verdict", fin.data?.review !== undefined, JSON.stringify(fin.data).slice(0, 120));

  const { data: prun } = await svc.from("ingestion_runs")
    .select("status, review, packet_id").eq("id", PRUN).single();
  const persisted = (((prun as any)?.review?.failures) ?? []).filter(isResolvable);
  check("finalize persisted it into creator review", persisted.length === pUnits.length && persisted.length > 0,
    `${persisted.length} persisted of ${pUnits.length}`);
  check("the packet run is held for review", (prun as any)?.status === "needs_review", (prun as any)?.status);

  const pub = await api(`/api/packets/${(prun as any).packet_id}/publish`, pk.cookie, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }) });
  check("publishing is blocked until explicit resolution",
    !pub.ok && pub.data?.error === "import_needs_review", `${pub.status} ${JSON.stringify(pub.data).slice(0, 90)}`);

  // The same input, the same flag, opposite outcomes - by destination alone.
  check("SAME source and flag, opposite outcomes, decided only by destination",
    noted.length > 0 && pUnits.length > 0,
    `library kept ${noted.length} note(s); packet held ${pUnits.length} unit(s)`);
} finally {
  disarm();
  for (const id of libIds) await svc.from("library_items").delete().eq("id", id);
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    for (const p of (ps ?? []) as any[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("library_items").delete().eq("user_id", id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { count: u } = await svc.from("users").select("id", { count: "exact", head: true }).like("email", `${TAG}%`);
  console.log(`\ncleanup: ${u ?? 0} users remaining`);
}
summary("destination guard — library vs packet");
