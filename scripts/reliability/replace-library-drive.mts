// STEP 2 of the controlled Library replacement: drive the real import to
// PROPOSALS ONLY, under the real owner's account.
//
// Deletes nothing and saves nothing. The run and its proposals are left in
// place deliberately — step 4 saves through the real gates, and the original
// 65 records are not touched until step 6.
//
// Bounded: a wall clock, a step cap, and bounded capacity/budget waits. It
// stops rather than looping.
import { svc, errText } from "../ingestion-runtime/lib.mts";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";
const OWNER_EMAIL = "mmdmscm@gmail.com";
const SRC = readFileSync(process.argv[2], "utf8");
const OUT = process.argv[3];
const DEADLINE = Date.now() + Number(process.env.FG_WALL_CLOCK_MS ?? 45 * 60_000);
const INTER_CHUNK_MS = 1200;

const { data: owner, error: oe } = await svc.from("users").select("id,email").eq("email", OWNER_EMAIL).single();
if (oe) { console.error(errText(oe)); process.exit(1); }
const UID = (owner as { id: string }).id;

// Refuse to start if anything is already open on the account — a second active
// import is exactly the state the lifecycle guard exists to prevent.
const { data: open } = await svc.from("ingestion_runs").select("id,status")
  .eq("user_id", UID).in("status", ["active", "finalizing", "needs_review"]);
if ((open ?? []).length) { console.error("refusing: run already open", JSON.stringify(open)); process.exit(1); }

const { count: before } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
console.log(`owner ${OWNER_EMAIL}  existing library records: ${before}`);
if (before !== 65) { console.error(`refusing: expected the 65-record baseline, found ${before}`); process.exit(1); }

const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 6 * 3600e3).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });

let runId = "";
let halted = "";
try {
  console.log(`source: ${SRC.length} chars`);
  const start = await api("/api/library/import", { method: "POST", body: JSON.stringify({ rawText: SRC }) });
  const sd = await start.json();
  if (start.status !== 201) { console.error(`start ${start.status}: ${JSON.stringify(sd).slice(0, 300)}`); process.exit(1); }
  runId = sd.runId;
  console.log(`run ${runId}  chunks=${sd.totalChunks}`);
  writeFileSync(OUT.replace(/\.json$/, "") + "-runid.txt", runId);

  let done = 0, failed = 0, waits = 0, capacityWaits = 0;
  for (let step = 0; step < 500; step++) {
    if (Date.now() > DEADLINE) { halted = "wall_clock"; console.log("\n  WALL CLOCK reached — stopping"); break; }
    const st = await (await api(`/api/ingest/${runId}`)).json();
    const run = st?.run; if (!run) { halted = "run_lost"; break; }
    const chunks = (st.chunks ?? []) as { ordinal: number; status: string }[];
    done = chunks.filter((c) => c.status === "completed").length;
    if (["finalized", "discarded", "needs_review"].includes(String(run.status))) break;
    const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
    if (!next) {
      const busy = chunks.filter((c) => c.status === "processing").length;
      if (busy && waits < 40) { waits++; await new Promise((r) => setTimeout(r, 4000)); continue; }
      break;
    }
    const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" });
    if (r.status >= 500) failed++;
    if (r.status === 429) {
      const b = await r.json().catch(() => ({}));
      const wait = Math.min(Number(b?.retryAfterSeconds ?? 120), 180) * 1000;
      capacityWaits++;
      console.log(`\n  capacity 429 on chunk ${next.ordinal} (${capacityWaits}) — waiting ${wait / 1000}s`);
      if (capacityWaits > 12) { halted = "capacity_exhausted"; break; }
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (r.status === 402) {
      const b = await r.json().catch(() => ({}));
      console.log(`\n  402 on chunk ${next.ordinal}: ${String(b?.message ?? "").slice(0, 120)}`);
      halted = b?.permanent === true ? "credits_exhausted" : "capacity_402";
      break;
    }
    if (INTER_CHUNK_MS) await new Promise((res) => setTimeout(res, INTER_CHUNK_MS));
    process.stdout.write(`\r  chunks completed: ${done}/${chunks.length}   `);
  }
  console.log(`\n  chunks completed: ${done}  (server errors: ${failed})  halted: ${halted || "no"}`);

  const pr = await api(`/api/library/import/${runId}/proposals`, { method: "POST" });
  const pbody = await pr.json().catch(() => ({}));
  console.log(`proposals POST: ${pr.status}  merged: ${pbody?.merged ?? "n/a"}`);
  const listed = await (await api(`/api/library/import/${runId}/proposals`)).json();
  const props = (listed?.proposals ?? listed?.data ?? []) as unknown[];
  console.log(`proposals produced: ${props.length}`);
  writeFileSync(OUT, JSON.stringify({ runId, halted, merged: pbody?.merged ?? null, proposals: props }, null, 2));
  console.log(`proposals -> ${OUT}`);
} finally {
  // The session is the only thing created for this step; the run and proposals
  // must survive into step 4.
  await svc.from("sessions").delete().eq("token", token);
  const { count: after } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`library records untouched: ${after} (was ${before})`);
  if (after !== before) console.log("!!! LIBRARY COUNT CHANGED — investigate before continuing");
}
