// 0028: THE CHANNEL, THROUGH THE LIVE ROUTE.
//
// proof-review-units.mts proves the resolution lifecycle with a hand-built
// chunk. This one proves the part that harness cannot: that the REAL chunk
// route, running the real model with enforcement on, writes review-required
// units into `ingestion_chunks.review_units`, and that finalize picks them up
// from there.
//
// Requires a server started with FLOWGUIDE_ENFORCE_CONTRACT=1. Bounded and
// disposable: one packet under one throwaway user, removed in the finally.
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";
import { isResolvable, unresolvedCount } from "../../src/lib/review-units.ts";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const SOURCE = readFileSync(process.env.SRC_FILE ?? "/tmp/flagged-source.txt", "utf8");
const TAG = "flowguide-0028-" + process.pid;
const HELD = "They are wonderful with families and the director will meet you on a weekend.";

// FORCE THE PROPOSAL. Since the prompt was fixed the model no longer routes
// recipient-intended prose into the private field on demand - which is exactly
// why fault injection exists for every other provider behaviour we cannot
// summon. The note is applied to the REAL model result, so what follows is the
// real validation, enforcement, staging and finalize path.
//
// This is the difference between "the model happened to misbehave today" and
// "the wiring carries a rejection end to end", and only the second is a gate.
const FAULTS = process.env.FLOWGUIDE_TEST_FAULT_FILE;
if (!FAULTS) { console.error("FLOWGUIDE_TEST_FAULT_FILE is required for this proof"); process.exit(2); }
writeFileSync(FAULTS, JSON.stringify({
  flowguideFaultInjection: true, privateNote: { "0": HELD },
}));

const users: string[] = [];
try {
  const { data: u, error } = await svc.from("users")
    .insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(errText(error));
  const uid = (u as { id: string }).id; users.push(uid);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: uid, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(120_000) });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) as any };
  };

  const org = await api("/api/ingest/organize", { method: "POST", body: JSON.stringify({
    rawText: SOURCE, packetType: "general", requestKey: crypto.randomUUID() }) });
  check("a real packet import starts", org.status === 201, JSON.stringify(org.data).slice(0, 120));
  const RUN = org.data.runId as string;

  for (let g = 0; g < 60; g++) {
    const { data: st } = await api(`/api/ingest/${RUN}`);
    const next = ((st.chunks ?? []) as any[]).find((c) => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${RUN}/chunks/${next.ordinal}`, { method: "POST" });
    const o = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (o.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${o.message}`);
    if (o.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
  }

  // ---- the chunk side, BEFORE finalize ------------------------------------
  const { data: chunks } = await svc.from("ingestion_chunks")
    .select("ordinal, review_units, fact_ledger").eq("run_id", RUN).neq("status", "split");
  const rows = (chunks ?? []) as Array<{ ordinal: number; review_units: any[] | null; fact_ledger: any }>;
  check("the run produced chunks at all", rows.length > 0, `${rows.length} leaf chunks`);
  const withUnits = rows.filter((c) => (c.review_units ?? []).length > 0);
  const allUnits = withUnits.flatMap((c) => c.review_units ?? []);
  // ABSENCE READS AS SUCCESS: if this source stopped producing held units, every
  // assertion below would pass over an empty set and prove nothing.
  // Telemetry in the detail line: "no units" has two very different causes -
  // the wiring is broken, or the model simply behaved this run - and a proof
  // that cannot tell them apart sends you looking in the wrong place.
  const tel = rows.map((c) => c.fact_ledger?.enforcement).filter(Boolean);
  const rejected = tel.reduce((n: number, t: any) => n + (t?.privacyRejected ?? 0), 0);
  const governed = tel.reduce((n: number, t: any) => n + (t?.itemsGoverned ?? 0), 0);
  check("the live chunk route wrote review units to the NEW column",
    allUnits.length > 0,
    `${allUnits.length} units across ${withUnits.length} chunk(s); ` +
    `telemetry: privacyRejected=${rejected}, itemsGoverned=${governed}, chunks with telemetry=${tel.length}`);
  if (!allUnits.length) {
    throw new Error(rejected > 0
      ? `WIRING: enforcement rejected ${rejected} placement(s) but nothing reached review_units`
      : `MODEL: enforcement ran on ${governed} item(s) and rejected nothing this run`);
  }

  check("the forced private note is the unit that was held",
    allUnits.some((u) => String(u.text ?? "").includes("meet you on a weekend")),
    JSON.stringify(allUnits.map((u) => String(u.text).slice(0, 40))).slice(0, 160));
  check("every unit carries a stable id and a classified code",
    allUnits.every((u) => /^u_[0-9a-f]{16}$/.test(u.id) && u.code === "privacy_rejected"),
    JSON.stringify(allUnits.map((u) => [u.id, u.code])).slice(0, 160));
  check("every unit carries its record provenance and verbatim text",
    allUnits.every((u) => typeof u.record === "number" && typeof u.chunk === "number" && String(u.text ?? "").length > 0),
    JSON.stringify(allUnits[0]).slice(0, 160));
  check("ids are unique across the run", new Set(allUnits.map((u) => u.id)).size === allUnits.length,
    `${new Set(allUnits.map((u) => u.id)).size} of ${allUnits.length}`);

  // The ledger still records everything, including the observed-only telemetry
  // that must NEVER become a question.
  const ledgerUnits = rows.flatMap((c) => c.fact_ledger?.unresolved ?? []);
  check("the ledger still holds the full telemetry", ledgerUnits.length >= allUnits.length,
    `${ledgerUnits.length} ledger units vs ${allUnits.length} review units`);
  const observed = ledgerUnits.filter((u: any) => u.kind === "source-unresolved");
  check("observed-unresolved telemetry stayed OUT of the review channel",
    observed.every((o: any) => !allUnits.some((u) => u.text === o.text)),
    `${observed.length} observed unit(s), none promoted`);

  // ---- finalize aggregates from that column -------------------------------
  const fin = await api(`/api/ingest/${RUN}/finalize`, { method: "POST", body: "{}" });
  check("finalize returns a review verdict", fin.data?.review !== undefined,
    JSON.stringify(fin.data).slice(0, 140));

  const { data: runRow } = await svc.from("ingestion_runs")
    .select("status, review, packet_id").eq("id", RUN).single();
  const run = runRow as { status: string; review: any; packet_id: string };
  const persisted = (run.review?.failures ?? []).filter(isResolvable);
  check("the run is held for review", run.status === "needs_review", run.status);
  check("every chunk unit reached the run's review",
    persisted.length === new Set(allUnits.map((u) => u.id)).size,
    `${persisted.length} persisted of ${allUnits.length} produced`);
  check("...by ID, not by re-derivation",
    persisted.every((f: any) => allUnits.some((u) => u.id === f.id)),
    JSON.stringify(persisted.map((f: any) => f.id)).slice(0, 160));
  check("...and all are outstanding", unresolvedCount(run.review?.failures) >= persisted.length,
    String(unresolvedCount(run.review?.failures)));

  // The whole 0028 boundary: the units in review came from the product column.
  // Every ledger-only unit (the observed telemetry) must be absent.
  check("no observed-only telemetry appears as a question",
    observed.every((o: any) => !JSON.stringify(run.review).includes(String(o.text).slice(0, 40))),
    `${observed.length} observed unit(s) checked`);

  const pub = await api(`/api/packets/${run.packet_id}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }) });
  check("publishing is blocked until the units are decided",
    !pub.ok && pub.data?.error === "import_needs_review", `${pub.status} ${JSON.stringify(pub.data).slice(0, 100)}`);
} finally {
  // The fault file is disarmed before anything else, so a failure above cannot
  // leave injection armed for the next thing that runs.
  if (FAULTS) writeFileSync(FAULTS, JSON.stringify({ flowguideFaultInjection: true }));
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    for (const p of (ps ?? []) as any[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { count } = await svc.from("users").select("id", { count: "exact", head: true }).like("email", `${TAG}%`);
  console.log(`\ncleanup: ${count ?? 0} users remaining`);
}
summary("0028 channel — live route");
