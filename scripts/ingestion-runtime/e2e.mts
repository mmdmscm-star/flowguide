// END-TO-END acceptance driver: real HTTP routes, real configured model, real
// database. Mirrors the client orchestrator in src/lib/useIngestion.ts so the
// code path under test is the one the editor actually uses.
//
// Containment matches the rest of this directory: one disposable user, removed
// by FK cascade in cleanup.mts.
import { svc, root, check, summary, errText } from "./lib.mts";
import { writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
const FAULTS = process.env.FLOWGUIDE_TEST_FAULT_FILE!;
const { makeSource } = await import(`${root}/docs/investigations/fixtures/senior-placement-source.mjs`);

const TAG = "flowguide-rt-" + process.pid;
// Every spec must carry the opt-in key or the app ignores the file entirely.
export const setFaults = (spec: object) =>
  writeFileSync(FAULTS, JSON.stringify({ flowguideFaultInjection: true, ...spec }));
setFaults({});

// ---------------------------------------------------------------- session
const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = user.id as string;
const token = crypto.randomUUID();
const exp = new Date(Date.now() + 864e5).toISOString();
const { error: serr } = await svc.from("sessions").insert({ user_id: UID, token, expires_at: exp });
if (serr) { console.error("session:", errText(serr)); process.exit(1); }
const COOKIE = `flowguide_session=${token}`;
console.log(`disposable user ${UID}  (${TAG})\nbase ${BASE}\n`);

// ---------------------------------------------------------------- safety cap
// A REAL 401/402/403 means the provider account is rejected or out of credits.
// Retrying cannot help and every further chunk request burns nothing but time,
// so the whole pass halts at the first one. Injected permanent faults (scenario
// 11) carry a marker and are exempt.
export class PermanentProviderFailure extends Error {}
const INJECTED_PERMANENT = "Injected permanent provider failure";
let realModelCalls = 0;
export const modelCalls = () => realModelCalls;
export const countModelCall = () => { realModelCalls++; };

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if ([401, 402, 403].includes(r.status)) {
    const msg = String(data?.message ?? data?.error ?? "");
    if (!msg.includes(INJECTED_PERMANENT)) {
      throw new PermanentProviderFailure(
        `HALTED: real provider ${r.status} on ${path} — ${msg.slice(0, 160)}. ` +
        `Made ${realModelCalls} real model calls before halting.`,
      );
    }
  }
  return { status: r.status, data };
}

// ---------------------------------------------------------------- driver
type Metrics = {
  label: string; chars: number; initialChunks: number; finalLeaves: number; adaptive: number;
  chunkMs: number[]; totalMs: number; statuses: Record<string, number>; splits: number;
  retries: number; finalizeCalls: number; modelCalls: number;
};
function newMetrics(label: string, chars: number): Metrics {
  return { label, chars, initialChunks: 0, finalLeaves: 0, adaptive: 0, chunkMs: [], totalMs: 0, statuses: {}, splits: 0, retries: 0, finalizeCalls: 0, modelCalls: 0 };
}
const bump = (m: Metrics, s: number) => { m.statuses[s] = (m.statuses[s] || 0) + 1; };

// Mirrors useIngestion.drive(). maxSteps bounds a stuck run; stopAfter lets a
// test halt mid-run to prove resume.
async function drive(runId: string, m: Metrics, opts: { stopAfterCompleted?: number; maxSteps?: number } = {}) {
  const seenCompleted = new Set<number>();
  for (let step = 0; step < (opts.maxSteps ?? 400); step++) {
    const st = await api(`/api/ingest/${runId}`);
    bump(m, st.status);
    if (!st.data?.run) return { outcome: "lost" as const };
    const run = st.data.run, leaves = st.data.chunks as any[];
    if (run.status === "finalized") return { outcome: "finalized" as const };
    if (run.status === "discarded") return { outcome: "discarded" as const };

    for (const c of leaves) if (c.status === "completed") seenCompleted.add(c.ordinal);
    m.finalLeaves = leaves.length;
    if (opts.stopAfterCompleted && seenCompleted.size >= opts.stopAfterCompleted) {
      return { outcome: "stopped" as const, completed: seenCompleted.size, leaves };
    }

    const next = leaves.find((c: any) => c.status === "pending" || c.status === "failed");
    if (!next) {
      m.finalizeCalls++;
      const t = performance.now();
      const fin = await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
      m.totalMs += performance.now() - t;
      bump(m, fin.status);
      return fin.data?.ok ? { outcome: "finalized" as const } : { outcome: "finalize_failed" as const, error: fin.data?.error || fin.data?.message, status: fin.status };
    }

    const t0 = performance.now();
    const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" });
    const ms = performance.now() - t0;
    bump(m, r.status);
    if (r.status === 200 && r.data?.status === "completed") { m.chunkMs.push(ms); m.modelCalls++; countModelCall(); continue; }
    if (r.status === 200 && r.data?.status === "split") { m.splits++; m.adaptive++; continue; }
    if (r.status === 200 && r.data?.status === "processing") { m.retries++; await new Promise((x) => setTimeout(x, 1500)); continue; }
    if (r.status >= 500 || r.status === 409) { m.retries++; await new Promise((x) => setTimeout(x, 1200)); continue; }
    // 4xx chunk_failed — the orchestrator surfaces this to the user; the chunk is
    // 'failed' and will be re-driven (and auto-split on attempt 2).
    m.retries++;
    if (m.retries > 40) return { outcome: "error" as const, error: r.data?.message || r.data?.error, status: r.status };
    await new Promise((x) => setTimeout(x, 400));
  }
  return { outcome: "no_converge" as const };
}

// ---------------------------------------------------------------- fidelity
async function packetContent(packetId: string) {
  const { data: secs } = await svc.from("sections").select("id, title, sort_order").eq("packet_id", packetId).order("sort_order");
  const empty = { secs: secs ?? [], items: [] as any[], links: [] as any[], contacts: [] as any[], details: [] as any[] };
  const ids = (secs ?? []).map((s: any) => s.id);
  if (!ids.length) return empty;
  const { data: items } = await svc.from("items")
    .select("id, title, address, description, notes, section_id, sort_order").in("section_id", ids);
  const iids = (items ?? []).map((i: any) => i.id);
  if (!iids.length) return { ...empty, secs: secs ?? [] };
  const [{ data: links }, { data: contacts }, { data: details }] = await Promise.all([
    svc.from("item_links").select("item_id, url, label").in("item_id", iids),
    svc.from("item_contacts").select("item_id, name, role, phone").in("item_id", iids),
    svc.from("item_details").select("item_id, label, value").in("item_id", iids),
  ]);
  return { secs: secs ?? [], items: items ?? [], links: links ?? [], contacts: contacts ?? [], details: details ?? [] };
}

const results: Metrics[] = [];
function report(m: Metrics) {
  results.push(m);
  const s = [...m.chunkMs].sort((a, b) => a - b);
  console.log(`    chars=${m.chars}  initialChunks=${m.initialChunks}  leaves=${m.finalLeaves}  splits=${m.splits}  retries=${m.retries}`);
  console.log(`    model calls=${m.modelCalls}  slowest chunk=${s.length ? s[s.length - 1].toFixed(0) : "-"}ms  median=${s.length ? s[Math.floor(s.length / 2)].toFixed(0) : "-"}ms`);
  console.log(`    total elapsed=${(m.totalMs / 1000).toFixed(1)}s  HTTP=${JSON.stringify(m.statuses)}`);
}

async function organize(label: string, source: string, opts: { stopAfterCompleted?: number } = {}) {
  const m = newMetrics(label, source.length);
  const t0 = performance.now();
  const res = await api(`/api/ingest/organize`, {
    method: "POST",
    body: JSON.stringify({ rawText: source, packetType: "senior_living", requestKey: `${TAG}-${label}` }),
  });
  bump(m, res.status);
  check(`[${label}] organize accepted (201)`, res.status === 201, `${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  if (res.status !== 201) return { m, packetId: null, runId: null, outcome: "start_failed" as const };
  m.initialChunks = res.data.totalChunks;
  const out = await drive(res.data.runId, m, opts);
  m.totalMs += performance.now() - t0;
  return { m, packetId: res.data.packetId as string, runId: res.data.runId as string, outcome: out.outcome, driveInfo: out };
}

export { api, drive, packetContent, newMetrics, bump, report, organize, results, UID, TAG, COOKIE, BASE, makeSource, check, summary, svc, errText };
