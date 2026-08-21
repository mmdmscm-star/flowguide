// WHAT THE DEPLOYED PROCESS ACTUALLY DOES.
//
// A configuration listing says what someone intended. This says what the
// running server does, which is the only thing a rollback record can be built
// on: it drives one small real packet import and reads the retained evidence.
//
// Run it BEFORE changing the flag to record the state, and AFTER to verify the
// change took effect in the process that serves traffic.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=https://... npx tsx <this>
//
// Bounded and disposable: one throwaway user and one packet, removed in the
// finally block. It reports; it asserts nothing, because "enforcement is off"
// is the correct answer before the change and the wrong one after it.
import { svc, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE) { console.error("FLOWGUIDE_BASE_URL is required"); process.exit(2); }
const TAG = "flowguide-probe-" + process.pid;

// Three records with a private-note-shaped line that grants no privacy anywhere.
const SOURCE = [
  "1. Alpha House", "Address: 1 Alpha Way, Seattle WA", "Phone: (206) 555-0101", "alphahouse.com",
  "They are wonderful with families and the director will meet you on a weekend.",
  "", "2. Beta Place", "Address: 2 Beta Rd, Tacoma WA", "Phone: (253) 555-0102", "betaplace.com",
  "The staff go out of their way for visitors who arrive after hours.",
  "", "3. Gamma Court", "Address: 3 Gamma Ave, Everett WA", "Phone: (425) 555-0103", "gammacourt.com",
  "Families consistently mention how easy the move-in process was.",
].join("\n");

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
  if (org.status !== 201) throw new Error(`organize: ${org.status} ${JSON.stringify(org.data).slice(0, 200)}`);
  const RUN = org.data.runId as string;

  let permanentFailure: string | null = null;
  for (let g = 0; g < 40; g++) {
    const { data: st } = await api(`/api/ingest/${RUN}`);
    const next = ((st.chunks ?? []) as any[]).find((c) => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${RUN}/chunks/${next.ordinal}`, { method: "POST" });
    if (r.data?.error === "contract_enforcement_failed") { permanentFailure = String(r.data?.message ?? "unknown"); break; }
    const o = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (o.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${o.message}`);
    if (o.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
  }

  const { data: cs } = await svc.from("ingestion_chunks")
    .select("ordinal, error, review_units, fact_ledger").eq("run_id", RUN).neq("status", "split");
  const rows = (cs ?? []) as Array<{ ordinal: number; error: string; review_units: any[] | null; fact_ledger: any }>;
  const tel = rows.map((c) => c.fact_ledger?.enforcement).filter(Boolean);
  const sum = (k: string) => tel.reduce((n: number, t: any) => n + (t?.[k] ?? 0), 0);
  const units = rows.flatMap((c) => c.review_units ?? []);

  const fin = await api(`/api/ingest/${RUN}/finalize`, { method: "POST", body: "{}" });
  const { data: runRow } = await svc.from("ingestion_runs")
    .select("status, review, packet_id").eq("id", RUN).single();
  const run = runRow as any;

  console.log(JSON.stringify({
    base: BASE,
    runId: RUN,
    enforcementEnabled: tel.length > 0,
    scopes: [...new Set(tel.map((t: any) => t.scope ?? "(none recorded)"))],
    chunks: rows.length,
    chunksWithTelemetry: tel.length,
    counts: {
      accepted: sum("accepted"), repaired: sum("repaired"), stripped: sum("stripped"),
      privacyRejected: sum("privacyRejected"), sourceUnresolved: sum("sourceUnresolved"),
      attributionUnresolved: sum("attributionUnresolved"), itemsGoverned: sum("itemsGoverned"),
    },
    reviewRequiredUnits: units.length,
    permanentEnforcementFailure: permanentFailure,
    chunkErrors: rows.map((c) => c.error).filter(Boolean),
    finalizeOk: !!fin.data?.ok,
    runStatus: run?.status,
    reviewFailures: (run?.review?.failures ?? []).length,
  }, null, 2));
} finally {
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    for (const p of (ps ?? []) as any[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { count } = await svc.from("users").select("id", { count: "exact", head: true }).like("email", `${TAG}%`);
  console.log(`cleanup: ${count ?? 0} users remaining`);
}
