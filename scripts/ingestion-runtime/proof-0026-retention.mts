// PRODUCTION EVIDENCE PROOF for 0026. A real PACKET import through the live
// route, finalized, then read back to confirm the whole chain survives:
//
//     source -> segment -> raw model result -> fact/semantic ledger
//
// Before 0026 finalize cleared all four. Disposable user, cleanup verified.
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
if (!process.env.FLOWGUIDE_RT_CONFIRM) { console.error("FLOWGUIDE_RT_CONFIRM=1 required"); process.exit(1); }
const TAG = "flowguide-0026-" + process.pid;
// Two records with a two-line Website field and bare domains — the ice-cream
// shape, so this also proves Steps 2-3 on the live route.
const SOURCE = `Harborview Kitchen
Address
88 Marine Dr, Astoria, OR 97103
Phone
(503) 555-0110
Website
harborviewkitchen.example.com

Ridgeline Roofing
Address
412 Wall St, Bend, OR 97701
Phone
(541) 555-0143
Website
www.ridgelineroofing.example.com
`;
const users: string[] = [];
try {
  const { data: u, error } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(errText(error));
  const uid = (u as { id: string }).id; users.push(uid);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: uid, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  const cookie = `flowguide_session=${token}`;
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) }, signal: AbortSignal.timeout(120_000) });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
  };

  const org = await api("/api/ingest/organize", { method: "POST", body: JSON.stringify({
    rawText: SOURCE, packetType: "general", requestKey: crypto.randomUUID() }) });
  check("a real PACKET import starts", org.status === 201 && !!org.data.packetId,
    `status ${org.status} ${JSON.stringify(org.data).slice(0, 140)}`);
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
  const fin = await api(`/api/ingest/${RUN}/finalize`, { method: "POST", body: "{}" });
  check("it FINALIZES", fin.ok, `status ${fin.status} ${JSON.stringify(fin.data).slice(0, 140)}`);

  // ---- the whole chain, read back AFTER finalize --------------------------
  const { data: runRow } = await svc.from("ingestion_runs")
    .select("status, source_text, evidence_purge_after, packet_id, packet_deleted_at").eq("id", RUN).single();
  const rr = runRow as Record<string, any>;
  const { data: cRows } = await svc.from("ingestion_chunks")
    .select("ordinal, status, segment_text, result, fact_ledger").eq("run_id", RUN).order("ordinal");
  const chunks = (cRows ?? []) as any[];
  const done = chunks.filter((c) => c.status === "completed");

  check("run is finalized", rr.status === "finalized", String(rr.status));
  check("SOURCE retained after finalize", rr.source_text !== null,
    rr.source_text === null ? "CLEARED — 0026 did not take effect" : `${String(rr.source_text).length} chars`);
  check("expiry stamped (bounded, not indefinite)", rr.evidence_purge_after !== null, String(rr.evidence_purge_after));
  check("SEGMENTS retained", done.length > 0 && done.every((c) => c.segment_text !== null),
    done.map((c) => `#${c.ordinal}=${c.segment_text === null ? "CLEARED" : "kept"}`).join(" "));
  check("RAW MODEL RESULTS retained", done.every((c) => c.result !== null),
    done.map((c) => `#${c.ordinal}=${c.result === null ? "CLEARED" : "kept"}`).join(" "));
  check("FACT LEDGER retained", done.every((c) => c.fact_ledger?.counts),
    done.map((c) => `#${c.ordinal}=${c.fact_ledger ? "kept" : "CLEARED"}`).join(" "));
  check("SEMANTIC ACCOUNTING retained", done.every((c) => c.fact_ledger?.accounting?.v === 1), "");

  const acc = done.reduce((t: any, c: any) => {
    const k = c.fact_ledger.accounting.counts;
    for (const f of Object.keys(k)) t[f] = (t[f] ?? 0) + k[f];
    return t;
  }, {});
  console.log(`      accounting: ${JSON.stringify(acc)}`);
  check("accounting identities hold on the live route",
    acc.recognized === acc.attributed + acc.attributionUnresolved && acc.unaccounted === 0,
    JSON.stringify(acc));

  // Steps 2-3 on the live route: two-line Website + bare domain.
  const claimed = done.some((c) => JSON.stringify(c.fact_ledger.accounting).includes("\"accepted\""));
  check("two-line Website / bare domain reached accounting", claimed && acc.recognized >= 6,
    `recognized=${acc.recognized}`);

  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", org.data.packetId);
  const sids = (secs ?? []).map((s: any) => s.id);
  const { data: items } = sids.length ? await svc.from("items").select("id").in("section_id", sids) : { data: [] };
  check("the packet still composed normally — behaviour unchanged", (items ?? []).length > 0,
    `${(items ?? []).length} items`);

  summary("0026 — evidence retained through finalize, on production");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    await svc.from("ingestion_runs").delete().eq("user_id", id);
    for (const p of (ps ?? []) as { id: string }[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { data: left } = await svc.from("users").select("id").like("email", `${TAG}%`);
  console.log(`cleanup: ${(left ?? []).length} row(s) remaining — ${(left ?? []).length === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
