// FAIL-CLOSED CONTROL. Enforcement is forced to throw. The raw model result
// must NOT reach staging, the chunk must be marked failed, and the evidence
// must survive for diagnosis.
import { svc, check, summary, errText } from "./lib.mts";
import { readFileSync } from "node:fs";
const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const TAG = "flowguide-failclosed-" + process.pid;
const SOURCE = readFileSync("/tmp/flagged-source.txt", "utf8");
const users: string[] = [];
try {
  const { data: u } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
  const uid = (u as any).id; users.push(uid);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: uid, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  const cookie = `flowguide_session=${token}`;
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) }, signal: AbortSignal.timeout(120_000) });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
  };
  const org = await api("/api/ingest/organize", { method: "POST", body: JSON.stringify({
    rawText: SOURCE, packetType: "general", requestKey: crypto.randomUUID() }) });
  const RUN = org.data.runId as string;
  const first = await api(`/api/ingest/${RUN}/chunks/0`, { method: "POST" });

  check("the chunk request FAILS rather than succeeding", !first.ok, `status ${first.status}`);
  check("it reports a contract enforcement failure", first.data?.error === "contract_enforcement_failed",
    JSON.stringify(first.data).slice(0, 120));
  check("it is marked PERMANENT, so it is not retried into a loop", first.data?.permanent === true, "");

  const { data: rows } = await svc.from("ingestion_chunks")
    .select("ordinal, status, result, error, fact_ledger").eq("run_id", RUN).eq("ordinal", 0).single();
  const c = rows as any;
  check("THE RAW MODEL RESULT WAS NOT STAGED", c.result === null,
    c.result === null ? "" : "unprotected model output reached staging");
  check("the chunk is marked failed", c.status === "failed", String(c.status));
  check("the failure reason is recorded", /contract enforcement failed/.test(String(c.error)), String(c.error).slice(0, 90));
  check("EVIDENCE PRESERVED for diagnosis", Boolean(c.fact_ledger?.enforcementError) && Boolean(c.fact_ledger?.rawResult),
    c.fact_ledger ? Object.keys(c.fact_ledger).join(",") : "no ledger");
  check("the segment survives too", Boolean(c.fact_ledger?.segmentText), "");

  const fin = await api(`/api/ingest/${RUN}/finalize`, { method: "POST", body: "{}" });
  check("the run does NOT finalize into a packet with unprotected content", !fin.ok, `status ${fin.status}`);
  summary("Fail-closed control");
} catch (e) {
  console.error("HALTED:", errText(e) || (e as Error)?.message);
  process.exitCode = 1;
} finally {
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    await svc.from("ingestion_runs").delete().eq("user_id", id);
    for (const p of (ps ?? []) as any[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { data: left } = await svc.from("users").select("id").like("email", `${TAG}%`);
  console.log(`cleanup: ${(left ?? []).length} row(s) remaining — ${(left ?? []).length === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
