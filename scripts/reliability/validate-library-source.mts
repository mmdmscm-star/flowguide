// FULL EXACT-SOURCE VALIDATION of the Library importer.
// Drives the real production import path under a DISPOSABLE user and stops at
// the proposals stage — nothing is ever saved into the real Library.
import { svc, errText } from "../ingestion-runtime/lib.mts";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";
const SRC = readFileSync(process.argv[2], "utf8");
const OUT = process.argv[3];
const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as any).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now()+864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers||{}) } });

try {
  console.log(`source: ${SRC.length} chars`);
  const start = await api("/api/library/import", { method: "POST", body: JSON.stringify({ rawText: SRC }) });
  const sd = await start.json();
  if (start.status !== 201) { console.error(`start ${start.status}: ${JSON.stringify(sd).slice(0,200)}`); process.exit(1); }
  const runId = sd.runId;
  console.log(`run ${String(runId).slice(0,8)}  chunks=${sd.totalChunks}`);

  let done = 0, failed = 0;
  for (let step = 0; step < 400; step++) {
    const st = await (await api(`/api/ingest/${runId}`)).json();
    const run = st?.run; if (!run) { console.log("run lost"); break; }
    const chunks = (st.chunks ?? []) as any[];
    done = chunks.filter(c => c.status === "completed").length;
    if (["finalized","discarded","needs_review"].includes(String(run.status))) break;
    const next = chunks.find(c => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" });
    if (r.status >= 500) failed++;
    if (step % 10 === 0) process.stdout.write(`\r  chunks completed: ${done}/${chunks.length}   `);
  }
  console.log(`\n  chunks completed: ${done}  (server errors: ${failed})`);

  const pr = await api(`/api/library/import/${runId}/proposals`, { method: "POST" });
  console.log(`proposals POST: ${pr.status}`);
  const listed = await (await api(`/api/library/import/${runId}/proposals`)).json();
  const props = (listed?.proposals ?? listed?.data ?? []) as any[];
  console.log(`proposals produced: ${props.length}   continuation merges applied: ${(await pr.clone?.().json?.().catch(() => ({})))?.merged ?? "n/a"}`);
  writeFileSync(OUT, JSON.stringify({ runId, proposals: props }, null, 2));
  console.log(`raw proposals -> ${OUT}`);
} finally {
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`cleanup: ${count ?? 0} library rows for the disposable user — ${count ? "NOT CLEAN" : "clean"}`);
}
