// STEP 1 PRODUCTION PROOF. One bounded real import through the live route, then
// read the accounting the ROUTE wrote and check the identities there.
//
// The offline gate proved the maths on captured evidence. This proves the same
// maths on the actual code path, with the real source_text, real chunk offsets
// and real model output.
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";
import { readFileSync } from "node:fs";
import { recordEnvelopes } from "../../src/lib/attribution.ts";
import { createHash } from "node:crypto";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
if (!process.env.FLOWGUIDE_RT_CONFIRM) { console.error("FLOWGUIDE_RT_CONFIRM=1 required"); process.exit(1); }
// A bounded subset taken at RECORD boundaries, not physical lines. The paste is
// 547 physical lines for 20 records because multiline cells are quoted, so
// slicing lines tears a record in half and the source stops being a table at
// all — which is exactly what happened on the first attempt.
const FULL_TEXT = readFileSync("diagnostic-paste.txt", "utf8");
const ENV = recordEnvelopes(FULL_TEXT);
if (!ENV) { console.error("source is not structurally a table"); process.exit(1); }
const TAKE = 5;
const PASTE = FULL_TEXT.slice(ENV[0].start, ENV[Math.min(TAKE, ENV.length) - 1].end);
const TAG = "flowguide-acct-" + process.pid;
console.log(`\nStep 1 accounting proof — ${BASE}\n  ${ENV.length} records in the full paste, using the first ${TAKE} (${PASTE.length} bytes)`);
console.log(`  sha256(subset) ${createHash("sha256").update(PASTE).digest("hex").slice(0, 16)}…\n`);

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

  const created = await api("/api/library/import", { method: "POST", body: JSON.stringify({ rawText: PASTE }) });
  check("the import starts", created.status === 201, JSON.stringify(created.data).slice(0, 140));
  const RUN = created.data.runId as string;
  for (let g = 0; g < 60; g++) {
    const { data: st } = await api(`/api/ingest/${RUN}`);
    const next = ((st.chunks ?? []) as any[]).find((c) => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${RUN}/chunks/${next.ordinal}`, { method: "POST" });
    const o = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (o.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${o.message}`);
    if (o.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
  }

  const { data: rows, error: cErr } = await svc.from("ingestion_chunks")
    .select("ordinal, status, fact_ledger").eq("run_id", RUN).order("ordinal");
  if (cErr) throw new Error(errText(cErr));
  const chunks = (rows ?? []) as { ordinal: number; status: string; fact_ledger: any }[];
  const done = chunks.filter((c) => c.status === "completed");

  check("every completed chunk carries accounting written BY THE ROUTE",
    done.length > 0 && done.every((c) => c.fact_ledger?.accounting?.v === 1),
    done.map((c) => `#${c.ordinal}=${c.fact_ledger?.accounting ? "ok" : "MISSING"}`).join(" "));

  check("the fact ledger is still present alongside it",
    done.every((c) => c.fact_ledger?.counts && typeof c.fact_ledger.counts.detected === "number"), "");

  const tot = done.reduce((t, c) => {
    const k = c.fact_ledger.accounting.counts;
    for (const f of Object.keys(k)) (t as any)[f] = ((t as any)[f] ?? 0) + k[f];
    return t;
  }, {} as Record<string, number>);
  console.log(`      route accounting: ${JSON.stringify(tot)}`);

  check("identity 1 — recognized = attributed + attribution_unresolved",
    tot.recognized === tot.attributed + tot.attributionUnresolved,
    `${tot.recognized} vs ${tot.attributed} + ${tot.attributionUnresolved}`);
  check("identity 2 — attributed = accepted + repaired + content + source unresolved",
    tot.attributed === tot.accepted + tot.repaired + tot.contentUnresolved + tot.sourceUnresolved,
    `${tot.attributed} vs ${tot.accepted}+${tot.repaired}+${tot.contentUnresolved}+${tot.sourceUnresolved}`);
  check("NOTHING UNACCOUNTED on the real route", tot.unaccounted === 0, `unaccounted=${tot.unaccounted}`);
  check("structural attribution was available for this source",
    done.every((c) => c.fact_ledger.accounting.attributionAvailable === true), "");
  check("the accounting recognized real source units", tot.recognized > 20, `recognized=${tot.recognized}`);

  // Proposals materialize on an explicit POST — the same call the review screen
  // makes. Omitting it reads as "behaviour changed" when nothing changed.
  const mat = await api(`/api/library/import/${RUN}/proposals`, { method: "POST" });
  check("proposals materialize", mat.ok, `status ${mat.status}`);
  const props = await svc.from("library_import_proposals").select("id").eq("run_id", RUN);
  check("the import still produced proposals — behaviour unchanged",
    ((props.data ?? []).length) > 0, `${(props.data ?? []).length} proposals`);

  summary("Step 1 — observe-only accounting on the real route");
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
  const { data: left } = await svc.from("users").select("id").like("email", `${TAG}%`);
  console.log(`cleanup: ${(left ?? []).length} row(s) remaining — ${(left ?? []).length === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
