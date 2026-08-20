// Corpus v2 — multi-sample, with the dimensions v1 could not measure.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=http://localhost:3000 \
//     SAMPLES=3 npx tsx scripts/ingestion-runtime/diagnose-corpus-v2.mts
import { svc, errText } from "./lib.mts";
import { RECORDS, SOURCE, TOTALS, type Shape } from "./fixtures/semantic-corpus-v2.mts";
import { haystacks, classify, squash, type Dest, type Outcome } from "./fixtures/score.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const SAMPLES = Number(process.env.SAMPLES ?? 3);
const TAG = "flowguide-c2-" + process.pid;
const users: string[] = [];

interface Row { run: number; rec: string; group: string; fact: string; expect: Dest;
  rule: string; shape: Shape; outcome: Outcome; actual?: Dest[];
  chunk: number; occupancy: number; recLen: number; density: number; }

// A transient network failure is not a result. The first attempt at three
// samples lost two COMPLETED runs because a fetch threw on the last chunk of the
// third — the harness was less resilient than the pipeline it was measuring.
async function api(path: string, cookie: string, init: RequestInit = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, { ...init,
        headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
        signal: AbortSignal.timeout(120_000) });
      return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
    } catch {
      if (attempt === 3) return { status: 0, ok: false, data: { error: "network" } };
      await new Promise((x) => setTimeout(x, 4000 * (attempt + 1)));
    }
  }
  return { status: 0, ok: false, data: { error: "network" } };
}

async function oneRun(run: number): Promise<Row[]> {
  const { data: u, error } = await svc.from("users")
    .insert({ email: `${TAG}-r${run}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(errText(error));
  const UID = (u as any).id; users.push(UID);
  const tok = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: UID, token: tok,
    expires_at: new Date(Date.now() + 864e5).toISOString() });
  const C = `flowguide_session=${tok}`;

  const created = await api("/api/library/import", C, { method: "POST", body: JSON.stringify({ rawText: SOURCE }) });
  if (!created.ok) throw new Error(`create: ${JSON.stringify(created.data)}`);
  const RUN = created.data.runId as string;
  for (let g = 0; g < 90; g++) {
    const { data: st } = await api(`/api/ingest/${RUN}`, C);
    const chunks = (st.chunks ?? []) as { ordinal: number; status: string }[];
    const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${RUN}/chunks/${next.ordinal}`, C, { method: "POST" });
    const o = r.status === 0 ? ({ kind: "retry" } as const)
            : classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (o.kind === "fatal") throw new Error(`run ${run} chunk ${next.ordinal}: ${o.message}`);
    if (o.kind === "retry") await new Promise((x) => setTimeout(x, 6000));
    process.stdout.write(".");
  }
  const mat = await api(`/api/library/import/${RUN}/proposals`, C, { method: "POST" });
  for (const p of (mat.data.proposals ?? []) as any[])
    await api(`/api/library/import/${RUN}/proposals/${p.id}`, C, { method: "PATCH", body: JSON.stringify({ selected: true }) });
  await api(`/api/library/import/${RUN}/save`, C, { method: "POST", body: "{}" });
  await api(`/api/library/import/${RUN}/finish`, C, { method: "POST", body: JSON.stringify({ discardUnsaved: true }) });

  const { data: chunkRows } = await svc.from("ingestion_chunks")
    .select("ordinal, source_start, source_end, result").eq("run_id", RUN).order("ordinal");
  const { data: libRows } = await svc.from("library_items")
    .select("id,title,address,description,notes,details,links,photos,contacts,origin_chunk_ordinal,origin_item_index")
    .eq("user_id", UID);

  // occupancy of each chunk, measured from the actual plan this run used
  const occ = new Map<number, number>();
  for (const c of (chunkRows ?? []) as any[]) {
    occ.set(c.ordinal, RECORDS.filter((r) => {
      const at = SOURCE.indexOf(r.text);
      return at >= c.source_start && at < c.source_end;
    }).length);
  }

  const entries = (libRows ?? []) as any[];
  const matched = new Map<string, any>();
  for (const e of entries) {
    const t = squash(e.title);
    let best: any = null, score = 0;
    for (const r of RECORDS) {
      const rt = squash(r.title);
      const sc = rt === t ? 3 : (t.includes(rt) || rt.includes(t)) ? 2 : 0;
      if (sc > score) { score = sc; best = r; }
    }
    if (best && !matched.has(best.key)) matched.set(best.key, e);
  }

  const rows: Row[] = [];
  for (const r of RECORDS) {
    const e = matched.get(r.key);
    const density = r.facts.filter((x) => x.present).length;
    if (!e) {
      for (const fa of r.facts) rows.push({ run, rec: r.key, group: r.group, fact: fa.id, expect: fa.expect,
        rule: fa.ruleStated, shape: fa.shape, outcome: fa.present ? "LOST" : "CORRECTLY_ABSENT",
        chunk: -1, occupancy: 0, recLen: r.text.length, density });
      continue;
    }
    const hay = haystacks(e);
    for (const fa of r.facts) {
      const { outcome, actual } = classify(hay, fa.text, fa.expect, fa.present);
      rows.push({ run, rec: r.key, group: r.group, fact: fa.id, expect: fa.expect, rule: fa.ruleStated,
        shape: fa.shape, outcome, actual, chunk: e.origin_chunk_ordinal,
        occupancy: occ.get(e.origin_chunk_ordinal) ?? 0, recLen: r.text.length, density });
    }
  }
  return rows;
}

const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "n/a";
const isOk = (o: Outcome) => o === "CORRECT" || o === "CORRECTLY_ABSENT";

try {
  console.log(`\nCORPUS v2 — ${JSON.stringify(TOTALS)}\n${SAMPLES} samples\n`);
  const all: Row[] = [];
  for (let i = 1; i <= SAMPLES; i++) {
    process.stdout.write(`run ${i} `);
    const rows = await oneRun(i);
    all.push(...rows);
    // Written per run: a completed sample is evidence and must survive whatever
    // happens to the next one.
    (await import("node:fs")).writeFileSync(`/tmp/v2-run${i}.json`, JSON.stringify(rows));
    const r = all.filter((x) => x.run === i);
    console.log(`  ${pct(r.filter((x) => isOk(x.outcome)).length, r.length)} correct`);
  }

  const bar = "=".repeat(74);
  console.log(`\n${bar}\n1. OVERALL, ${SAMPLES} RUNS\n${bar}`);
  for (const o of ["CORRECT","CORRECTLY_ABSENT","MISCLASSIFIED","LOST","FABRICATED","DUPLICATED"] as Outcome[])
    console.log(`  ${o.padEnd(18)} ${String(all.filter((x) => x.outcome === o).length).padStart(5)}`);
  console.log(`  ${"correct".padEnd(18)} ${pct(all.filter((x) => isOk(x.outcome)).length, all.length)} of ${all.length} fact-observations`);

  console.log(`\n${bar}\n2. BY VALUE SHAPE  <-- the dimension v1 implicated\n${bar}`);
  for (const sh of ["simple","qualified","ranged","prose"] as Shape[]) {
    const rows = all.filter((x) => x.shape === sh);
    const bad = rows.filter((x) => !isOk(x.outcome));
    const kinds: Record<string, number> = {};
    for (const b of bad) kinds[b.outcome] = (kinds[b.outcome] ?? 0) + 1;
    console.log(`  ${sh.padEnd(10)} ${pct(rows.length - bad.length, rows.length).padStart(7)}  of ${String(rows.length).padStart(4)}   ${JSON.stringify(kinds)}`);
  }

  console.log(`\n${bar}\n3. BY CHUNK OCCUPANCY (records sharing the model call)\n${bar}`);
  for (const n of [1, 2]) {
    const rows = all.filter((x) => x.occupancy === n);
    console.log(`  ${n} record${n > 1 ? "s" : " "} per chunk: ${pct(rows.filter((x) => isOk(x.outcome)).length, rows.length)} over ${rows.length}`);
  }

  console.log(`\n${bar}\n4. CLONE CONSISTENCY — does the SAME fact change destination?\n${bar}`);
  const cloneFacts = [...new Set(all.filter((x) => x.group === "A-clone").map((x) => x.fact))];
  const unstable: string[] = [];
  for (const fid of cloneFacts) {
    const rows = all.filter((x) => x.group === "A-clone" && x.fact === fid);
    const key = (x: Row) => x.outcome === "CORRECT" ? String(x.expect)
      : (x.actual ?? []).join("+") || x.outcome;
    const tally: Record<string, number> = {};
    for (const x of rows) tally[key(x)] = (tally[key(x)] ?? 0) + 1;
    const modal = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    const rate = modal[1] / rows.length;
    if (rate < 1) {
      unstable.push(fid);
      const shape = rows[0].shape;
      console.log(`  ${(rate * 100).toFixed(0).padStart(3)}%  ${fid.padEnd(14)} shape=${shape.padEnd(10)} ` +
        Object.entries(tally).map(([k, v]) => `${k}×${v}`).join("  "));
    }
  }
  console.log(`  ${cloneFacts.length - unstable.length}/${cloneFacts.length} clone fact types were perfectly stable across all runs`);

  console.log(`\n${bar}\n5. REPRODUCIBLE vs RUN-TO-RUN\n${bar}`);
  const byRecFact = new Map<string, Row[]>();
  for (const x of all) {
    const k = `${x.rec}|${x.fact}`;
    (byRecFact.get(k) ?? byRecFact.set(k, []).get(k)!).push(x);
  }
  let always = 0, sometimes = 0, never = 0;
  const alwaysList: string[] = [], sometimesList: string[] = [];
  for (const [k, rows] of byRecFact) {
    const bad = rows.filter((x) => !isOk(x.outcome)).length;
    if (bad === 0) never++;
    else if (bad === rows.length) { always++; alwaysList.push(`${k} (${rows[0].outcome}, ${rows[0].shape})`); }
    else { sometimes++; sometimesList.push(`${k} ${bad}/${rows.length} (${rows[0].shape})`); }
  }
  console.log(`  always correct ......... ${never}`);
  console.log(`  ALWAYS wrong ........... ${always}   <- reproducible, not nondeterminism`);
  console.log(`  sometimes wrong ........ ${sometimes}   <- run-to-run variation`);
  if (alwaysList.length) { console.log("  reproducible failures:"); for (const a of alwaysList.slice(0, 30)) console.log("    " + a); }
  if (sometimesList.length) { console.log("  variable failures:"); for (const a of sometimesList.slice(0, 20)) console.log("    " + a); }

  console.log(`\n${bar}\n6. RECORD LENGTH AND FIELD DENSITY\n${bar}`);
  const buckets = [[0,1000],[1000,1700],[1700,2100]];
  for (const [lo, hi] of buckets) {
    const rows = all.filter((x) => x.recLen >= lo && x.recLen < hi);
    if (rows.length) console.log(`  length ${lo}-${hi}: ${pct(rows.filter((x) => isOk(x.outcome)).length, rows.length)} over ${rows.length}`);
  }
  const dens = [...new Set(all.map((x) => x.density))].sort((a, b) => a - b);
  for (const d of dens) {
    const rows = all.filter((x) => x.density === d);
    console.log(`  ${String(d).padStart(2)} facts/record: ${pct(rows.filter((x) => isOk(x.outcome)).length, rows.length)} over ${rows.length}`);
  }

  console.log(`\n${bar}\n7. WHERE MISPLACED FACTS ACTUALLY WENT\n${bar}`);
  const mis: Record<string, number> = {};
  for (const x of all.filter((r) => r.outcome === "MISCLASSIFIED"))
    mis[`${x.expect} -> ${(x.actual ?? []).join("+")}`] = (mis[`${x.expect} -> ${(x.actual ?? []).join("+")}`] ?? 0) + 1;
  for (const [k, v] of Object.entries(mis).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  const lost: Record<string, number> = {};
  for (const x of all.filter((r) => r.outcome === "LOST")) lost[`${x.fact} (${x.shape})`] = (lost[`${x.fact} (${x.shape})`] ?? 0) + 1;
  console.log("  LOST by fact:");
  for (const [k, v] of Object.entries(lost).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(v).padStart(3)}  ${k}`);
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
  console.log(`\ncleanup: ${(left ?? []).length} stray — ${(left ?? []).length === 0 ? "clean" : "MANUAL"}`);
}
