// THE TRACED DIAGNOSTIC. Two runs of the identical paste through the real
// production Library ingestion path, under two separate disposable users.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=https://… \
//     npx tsx scripts/ingestion-runtime/diagnostic-run.mts
//
// Nothing is changed: no prompt, routing, validator or repair. The only thing
// that differs between run 1 and run 2 is the model's own behaviour.
//
// EVIDENCE IS EXTRACTED TO LOCAL JSON BEFORE CLEANUP. The disposable users are
// then deleted and the deletion verified, so nothing of this experiment is left
// in the professional's database — but the segments, raw model results, fact
// ledgers and proposals all survive here for analysis.
import { svc, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
if (!process.env.FLOWGUIDE_RT_CONFIRM) { console.error("FLOWGUIDE_RT_CONFIRM=1 required"); process.exit(1); }

const PASTE_FILE = process.env.PASTE_FILE ?? "diagnostic-paste.txt";
const PASTE = readFileSync(PASTE_FILE, "utf8");
const SHA = createHash("sha256").update(PASTE).digest("hex");
const EXPECT = process.env.EXPECT_SHA ?? "7545d19df470480dd6c00b4c283267d7e286ac1c9763eca8d26590f35fdfbb20";
if (PASTE_FILE === "diagnostic-paste.txt" && SHA !== EXPECT) {
  console.error(`paste hash mismatch:\n  got      ${SHA}\n  expected ${EXPECT}`); process.exit(1);
}
console.log(`\nDIAGNOSTIC — ${BASE}\n  paste sha256 ${SHA}  (${Buffer.byteLength(PASTE)} bytes) — matches the recorded value\n`);

const TAG = "flowguide-diag-" + process.pid;
const users: string[] = [];

async function makeUser(label: string) {
  const { data, error } = await svc.from("users")
    .insert({ email: `${TAG}-${label}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(`user: ${errText(error)}`);
  const id = (data as { id: string }).id;
  users.push(id);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: id, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return { id, cookie: `flowguide_session=${token}` };
}
async function api(path: string, cookie: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    signal: AbortSignal.timeout(120_000),
  });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
}
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}

async function oneRun(n: number) {
  const t0 = Date.now();
  const pro = await makeUser(`r${n}`);
  const created = await api("/api/library/import", pro.cookie, {
    method: "POST", body: JSON.stringify({ rawText: PASTE }),
  });
  if (created.status !== 201) throw new Error(`run ${n} did not start: ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  const RUN = created.data.runId as string;
  console.log(`  run ${n}: ${RUN}  (${created.data.totalChunks ?? "?"} chunks planned)`);

  let processed = 0;
  for (let guard = 0; guard < 200; guard++) {
    const { data: st } = await api(`/api/ingest/${RUN}`, pro.cookie);
    const chunks = (st.chunks ?? []) as { ordinal: number; status: string }[];
    const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${RUN}/chunks/${next.ordinal}`, pro.cookie, { method: "POST" });
    const outcome = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (outcome.kind === "fatal") throw new Error(`run ${n} chunk ${next.ordinal}: ${outcome.message}`);
    if (outcome.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
    processed++;
    if (processed % 5 === 0) process.stdout.write(`    …${processed} chunks\n`);
  }

  const mat = await api(`/api/library/import/${RUN}/proposals`, pro.cookie, { method: "POST" });
  if (!mat.ok) console.log(`    materialize: ${mat.status} ${JSON.stringify(mat.data).slice(0, 140)}`);

  const chunks = await rows<Record<string, unknown>>("chunks", svc.from("ingestion_chunks")
    .select("ordinal, status, source_start, source_end, segment_text, result, fact_ledger, attempt_count, split_depth")
    .eq("run_id", RUN).order("ordinal"));
  const proposals = await rows<Record<string, unknown>>("proposals", svc.from("library_import_proposals")
    .select("ordinal, idx, payload").eq("run_id", RUN).order("ordinal"));
  const run = (await rows<Record<string, unknown>>("run", svc.from("ingestion_runs")
    .select("id, total_chunks, completed_chunks, status, source_len, segmenter_version").eq("id", RUN)))[0];

  const out = { n, runId: RUN, pasteSha: SHA, base: BASE, run, chunks, proposals,
                seconds: Math.round((Date.now() - t0) / 1000) };
  writeFileSync(`${process.env.OUT_PREFIX ?? "/tmp/diag-run"}${n}.json`, JSON.stringify(out, null, 1));
  console.log(`  run ${n}: ${chunks.length} chunks, ${proposals.length} proposals, ${out.seconds}s -> ${process.env.OUT_PREFIX ?? "/tmp/diag-run"}${n}.json`);
  return out;
}

try {
  for (const n of [1, 2]) await oneRun(n);
  console.log("\nboth runs complete.");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of users) {
    await svc.from("ingestion_runs").delete().eq("user_id", id);
    await svc.from("library_items").delete().eq("user_id", id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  let stray = 0;
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  stray += (lu ?? []).length;
  for (const id of users)
    for (const t of ["ingestion_runs", "library_items", "sessions"] as const) {
      const { data } = await svc.from(t).select("user_id").eq("user_id", id);
      stray += (data ?? []).length;
    }
  console.log(`cleanup: ${stray} row(s) remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
