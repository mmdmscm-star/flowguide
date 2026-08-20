// Run the controlled corpus and score it field by field.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=http://localhost:3000 \
//     npx tsx scripts/ingestion-runtime/diagnose-semantic-corpus.mts
//
// Disposable user throughout. Changes no production behaviour: it imports,
// scores, reports and cleans up.
import { svc, errText } from "./lib.mts";
import { RECORDS, SOURCE, TOTALS, type Fact, type Dest } from "./fixtures/semantic-corpus.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const TAG = "flowguide-corpus-" + process.pid;

// ---------------------------------------------------------------------------
// Normalisation. A fact matches if its distinctive core appears; formatting
// differences are recorded separately and never counted as misplacement.
// ---------------------------------------------------------------------------
const squash = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const digits = (s: unknown) => String(s ?? "").replace(/\D+/g, "");
const urlKey = (s: unknown) => String(s ?? "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");

/** The minimal distinctive needle for a fact, by kind. */
function probe(fact: Fact): { kind: string; needle: string } {
  const t = fact.text;
  if (/^https?:\/\//.test(t)) return { kind: "url", needle: urlKey(t) };
  if (/@/.test(t)) return { kind: "email", needle: squash(t) };
  if (/^\d{3}-\d{3}-\d{4}$/.test(t)) return { kind: "phone", needle: digits(t) };
  if (/\$/.test(t)) return { kind: "money", needle: digits(t) };
  if (/^\d+$/.test(t)) return { kind: "number", needle: t };
  return { kind: "text", needle: squash(t) };
}

type Item = Record<string, any>;
/** Every destination's text, normalised the same way. */
function haystacks(it: Item): Record<Dest, string> {
  const details = (it.details ?? []).map((d: any) => `${d?.label} ${d?.value}`).join(" ");
  const detailValues = (it.details ?? []).map((d: any) => `${d?.value}`).join(" ");
  const contacts = it.contacts ?? [];
  return {
    title: squash(it.title),
    address: squash(it.address),
    description: squash(it.description),
    notes: squash(it.notes),
    details: squash(details),
    links: (it.links ?? []).map((l: any) => urlKey(l?.url)).join(" "),
    photos: (it.photos ?? []).map((p: any) => urlKey(typeof p === "string" ? p : p?.url)).join(" "),
    "contacts.name": squash(contacts.map((c: any) => c?.name).join(" ")),
    "contacts.role": squash(contacts.map((c: any) => c?.role).join(" ")),
    "contacts.phone": digits(contacts.map((c: any) => c?.phone).join(" ")),
    "contacts.email": squash(contacts.map((c: any) => c?.email).join(" ")),
    "contacts.website": (contacts.map((c: any) => urlKey(c?.website)).filter(Boolean)).join(" "),
    __detailValues: squash(detailValues),
  } as any;
}
const DESTS: Dest[] = ["title","address","description","notes","details","links","photos",
  "contacts.name","contacts.role","contacts.phone","contacts.email","contacts.website"];

// A plain-text fact must not be counted as "placed in" a destination that merely
// CONTAINS it as a substring of something else. A community called Marin Terrace
// has marinterrace.example.com as its website and ken@marinterrace.example.com
// as a contact address — the name appears inside both, and a naive scan reports
// the title as DUPLICATED across title+links+photos+contacts.email.
//
// That is a scoring artifact, not a product defect, and it inflated DUPLICATED
// in the first two runs. Text facts are therefore not searched in the
// url-and-address-shaped destinations at all.
const URL_SHAPED: Dest[] = ["links", "photos", "contacts.website", "contacts.email"];
function found(hay: Record<Dest, string>, d: Dest, p: { kind: string; needle: string }): boolean {
  const h = hay[d] ?? "";
  if (!p.needle) return false;
  if (p.kind === "text" && URL_SHAPED.includes(d)) return false;
  if (p.kind === "url") return h.split(/\s+/).includes(p.needle) || h.includes(p.needle);
  return h.includes(p.needle);
}

type Outcome = "CORRECT" | "CORRECTLY_ABSENT" | "MISCLASSIFIED" | "LOST" | "FABRICATED" | "DUPLICATED";
interface Scored { rec: string; group: string; fact: string; expect: Dest; rule: Fact["ruleStated"];
                   outcome: Outcome; actual?: Dest[]; chunk: number; }

function scoreItem(recKey: string, group: string, facts: Fact[], it: Item, chunk: number): Scored[] {
  const hay = haystacks(it);
  const out: Scored[] = [];
  for (const f of facts) {
    const p = probe(f);
    const where = DESTS.filter((d) => found(hay, d, p));
    if (!f.present) {
      out.push({ rec: recKey, group, fact: f.id, expect: f.expect, rule: f.ruleStated, chunk,
                 outcome: where.length ? "FABRICATED" : "CORRECTLY_ABSENT",
                 actual: where.length ? where : undefined });
      continue;
    }
    if (where.length === 0) {
      out.push({ rec: recKey, group, fact: f.id, expect: f.expect, rule: f.ruleStated, chunk, outcome: "LOST" });
    } else if (where.length > 1) {
      out.push({ rec: recKey, group, fact: f.id, expect: f.expect, rule: f.ruleStated, chunk,
                 outcome: "DUPLICATED", actual: where });
    } else if (where[0] === f.expect) {
      out.push({ rec: recKey, group, fact: f.id, expect: f.expect, rule: f.ruleStated, chunk, outcome: "CORRECT" });
    } else {
      out.push({ rec: recKey, group, fact: f.id, expect: f.expect, rule: f.ruleStated, chunk,
                 outcome: "MISCLASSIFIED", actual: where });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
const users: string[] = [];
async function api(path: string, cookie: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    signal: AbortSignal.timeout(120_000) });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
}

try {
  console.log(`\nCONTROLLED CORPUS — ${JSON.stringify(TOTALS)}\n`);
  const { data: u, error } = await svc.from("users")
    .insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(errText(error));
  const UID = (u as any).id; users.push(UID);
  const tok = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: UID, token: tok,
    expires_at: new Date(Date.now() + 864e5).toISOString() });
  const C = `flowguide_session=${tok}`;

  const created = await api("/api/library/import", C, { method: "POST", body: JSON.stringify({ rawText: SOURCE }) });
  if (!created.ok) throw new Error(`create: ${JSON.stringify(created.data)}`);
  const RUN = created.data.runId as string;
  console.log(`run ${RUN}  ${created.data.totalChunks} chunks — driving…`);

  for (let guard = 0; guard < 60; guard++) {
    const { data: st } = await api(`/api/ingest/${RUN}`, C);
    const chunks = (st.chunks ?? []) as { ordinal: number; status: string }[];
    const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${RUN}/chunks/${next.ordinal}`, C, { method: "POST" });
    const o = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (o.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${o.message}`);
    if (o.kind === "retry") await new Promise((x) => setTimeout(x, 6000));
    process.stdout.write(".");
  }
  console.log("\nextraction complete");

  const mat = await api(`/api/library/import/${RUN}/proposals`, C, { method: "POST" });
  const proposals = (mat.data.proposals ?? []) as any[];
  console.log(`materialised ${proposals.length} proposals from ${RECORDS.length} source records`);

  for (const p of proposals) {
    await api(`/api/library/import/${RUN}/proposals/${p.id}`, C, {
      method: "PATCH", body: JSON.stringify({ selected: true }) });
  }
  const saved = await api(`/api/library/import/${RUN}/save`, C, { method: "POST", body: "{}" });
  console.log(`saved ${saved.data.saved} entries` +
    (saved.data.results ?? []).filter((r: any) => r.outcome !== "saved").length
      ? `  (${(saved.data.results ?? []).filter((r: any) => r.outcome !== "saved").map((r: any) => r.outcome).join(",")})` : "");

  await api(`/api/library/import/${RUN}/finish`, C, { method: "POST", body: JSON.stringify({ discardUnsaved: true }) });

  // ---- reconstruct through the preserved evidence --------------------------
  const { data: runRow } = await svc.from("ingestion_runs").select("source_text").eq("id", RUN).single();
  const { data: chunkRows } = await svc.from("ingestion_chunks")
    .select("ordinal, source_start, source_end, segment_text, result").eq("run_id", RUN).order("ordinal");
  const { data: libRows } = await svc.from("library_items")
    .select("id,title,address,description,notes,details,links,photos,contacts,origin_run_id,origin_chunk_ordinal,origin_item_index")
    .eq("user_id", UID);
  console.log(`evidence preserved: source ${(runRow as any)?.source_text ? "YES" : "NO"}, ` +
    `${(chunkRows ?? []).filter((c: any) => c.result).length}/${(chunkRows ?? []).length} chunks retain results`);

  const chunkByOrd = new Map((chunkRows ?? []).map((c: any) => [c.ordinal, c]));
  const entries = (libRows ?? []) as any[];

  // ---- match saved entries to source records -------------------------------
  const matched = new Map<string, any>();
  const unmatched: any[] = [];
  for (const e of entries) {
    const t = squash(e.title);
    let best: any = null, bestScore = 0;
    for (const r of RECORDS) {
      const rt = squash(r.title);
      const s = rt === t ? 3 : (t.includes(rt) || rt.includes(t)) ? 2 : 0;
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (best && !matched.has(best.key)) matched.set(best.key, e);
    else unmatched.push(e);
  }
  const missing = RECORDS.filter((r) => !matched.has(r.key));

  // ---- score ---------------------------------------------------------------
  const all: Scored[] = [];
  const modelVsSaved: string[] = [];
  for (const r of RECORDS) {
    const e = matched.get(r.key);
    if (!e) { for (const f of r.facts) all.push({ rec: r.key, group: r.group, fact: f.id, expect: f.expect,
                rule: f.ruleStated, outcome: f.present ? "LOST" : "CORRECTLY_ABSENT", chunk: -1 }); continue; }
    all.push(...scoreItem(r.key, r.group, r.facts, e, e.origin_chunk_ordinal));
    // model output vs what was saved — should be identical
    const ch = chunkByOrd.get(e.origin_chunk_ordinal);
    const model = ch?.result?.items?.[e.origin_item_index];
    if (model) {
      const a = JSON.stringify({ t: squash(model.title), d: squash(JSON.stringify(model.details ?? [])) });
      const b = JSON.stringify({ t: squash(e.title), d: squash(JSON.stringify(e.details ?? [])) });
      if (a !== b) modelVsSaved.push(`${r.key}: model output and saved entry DIFFER`);
    } else modelVsSaved.push(`${r.key}: no model item at the recorded coordinates`);
  }

  const count = (o: Outcome) => all.filter((x) => x.outcome === o).length;
  const correct = count("CORRECT") + count("CORRECTLY_ABSENT");
  console.log(`\n${"=".repeat(72)}\n1. OVERALL CORRECTNESS\n${"=".repeat(72)}`);
  console.log(`  ${correct}/${all.length} facts correct  (${(correct / all.length * 100).toFixed(1)}%)`);
  for (const o of ["CORRECT","CORRECTLY_ABSENT","MISCLASSIFIED","LOST","FABRICATED","DUPLICATED"] as Outcome[])
    console.log(`    ${o.padEnd(18)} ${count(o)}`);
  console.log(`  records: ${matched.size}/${RECORDS.length} matched, ${missing.length} missing, ${unmatched.length} extra/unmatched`);
  if (missing.length) console.log(`    missing: ${missing.map((m) => m.key + " " + m.title).join(", ")}`);
  if (unmatched.length) console.log(`    unmatched entries: ${unmatched.map((e) => e.title).join(" | ")}`);

  console.log(`\n${"=".repeat(72)}\n2. CLONE CONSISTENCY BY FACT TYPE (group A, 8 identical structures)\n${"=".repeat(72)}`);
  const cloneFacts = [...new Set(all.filter((x) => x.group === "A-clone").map((x) => x.fact))];
  const consistency: { fact: string; modal: string; rate: number; spread: string; rule: string }[] = [];
  for (const fid of cloneFacts) {
    const rows = all.filter((x) => x.group === "A-clone" && x.fact === fid);
    const dests = rows.map((x) => x.outcome === "CORRECT" ? x.expect
      : x.outcome === "MISCLASSIFIED" || x.outcome === "DUPLICATED" ? (x.actual ?? []).join("+")
      : x.outcome);
    const tally: Record<string, number> = {};
    for (const d of dests) tally[d] = (tally[d] ?? 0) + 1;
    const [modal, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    consistency.push({ fact: fid, modal, rate: n / rows.length, rule: rows[0].rule,
      spread: Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(", ") });
  }
  consistency.sort((a, b) => a.rate - b.rate);
  for (const c of consistency)
    console.log(`  ${(c.rate * 100).toFixed(0).padStart(3)}%  ${c.fact.padEnd(14)} rule=${c.rule.padEnd(20)} ${c.spread}`);

  console.log(`\n${"=".repeat(72)}\n3. WITHIN-CHUNK vs CROSS-CHUNK (clones)\n${"=".repeat(72)}`);
  const c0 = all.filter((x) => x.group === "A-clone" && x.chunk === 0);
  const others = all.filter((x) => x.group === "A-clone" && x.chunk !== 0 && x.chunk >= 0);
  const rateOf = (rows: Scored[]) => rows.length ? (rows.filter((r) => r.outcome === "CORRECT" || r.outcome === "CORRECTLY_ABSENT").length / rows.length * 100).toFixed(1) : "n/a";
  console.log(`  chunk 0 (A1-A4 together): ${rateOf(c0)}% correct over ${c0.length} facts`);
  console.log(`  chunks 1-3 (A5-A8):       ${rateOf(others)}% correct over ${others.length} facts`);
  for (const fid of cloneFacts) {
    const byChunk: Record<number, string[]> = {};
    for (const x of all.filter((r) => r.group === "A-clone" && r.fact === fid)) {
      (byChunk[x.chunk] ??= []).push(x.outcome === "CORRECT" ? "ok" : x.outcome.toLowerCase().slice(0, 6));
    }
    const per = Object.entries(byChunk).map(([k, v]) => `c${k}:${[...new Set(v)].join("/")}`).join(" ");
    if (new Set(Object.values(byChunk).flat()).size > 1) console.log(`    ${fid.padEnd(14)} ${per}`);
  }

  console.log(`\n${"=".repeat(72)}\n4. BY WHETHER THE PROMPT STATES THE RULE\n${"=".repeat(72)}`);
  for (const rule of ["yes","packet-prompts-only","no"] as const) {
    const rows = all.filter((x) => x.rule === rule);
    const ok = rows.filter((r) => r.outcome === "CORRECT" || r.outcome === "CORRECTLY_ABSENT").length;
    console.log(`  ${rule.padEnd(22)} ${ok}/${rows.length} correct (${(ok / rows.length * 100).toFixed(1)}%)`);
  }

  console.log(`\n${"=".repeat(72)}\n5. MIXED-TYPE (D) AND NEIGHBOURS\n${"=".repeat(72)}`);
  for (const g of ["D-mixed-type","A-clone","B-absence","C-ambiguity","E-awkward"] as const) {
    const rows = all.filter((x) => x.group === g);
    const ok = rows.filter((r) => r.outcome === "CORRECT" || r.outcome === "CORRECTLY_ABSENT").length;
    console.log(`  ${g.padEnd(14)} ${ok}/${rows.length} (${(ok / rows.length * 100).toFixed(1)}%)`);
  }

  console.log(`\n${"=".repeat(72)}\n6. AMBIGUITY PROBES AND THE DUPLICATE LINK\n${"=".repeat(72)}`);
  for (const k of ["C1","C2","E1"]) {
    const e = matched.get(k);
    console.log(`  ${k}: ${e ? e.title : "NOT MATCHED"}`);
    for (const x of all.filter((r) => r.rec === k && r.outcome !== "CORRECT" && r.outcome !== "CORRECTLY_ABSENT"))
      console.log(`     ${x.outcome.padEnd(14)} ${x.fact.padEnd(18)} expected ${x.expect}${x.actual ? " -> " + x.actual.join("+") : ""}`);
    if (e) console.log(`     links: ${JSON.stringify((e.links ?? []).map((l: any) => l.url))}`);
  }

  console.log(`\n${"=".repeat(72)}\n7. TRACES: source -> model output -> saved entry\n${"=".repeat(72)}`);
  for (const k of ["A1","A8","C1","D2","E1"]) {
    const r = RECORDS.find((x) => x.key === k)!; const e = matched.get(k);
    if (!e) { console.log(`\n  ${k}: no saved entry`); continue; }
    const ch = chunkByOrd.get(e.origin_chunk_ordinal);
    const model = ch?.result?.items?.[e.origin_item_index];
    console.log(`\n  ── ${k} ${r.title}  (chunk ${e.origin_chunk_ordinal}, item ${e.origin_item_index})`);
    console.log(`     SOURCE  : ${r.text.split("\n").slice(0, 3).join(" / ").slice(0, 110)}`);
    console.log(`     MODEL   : details=${JSON.stringify((model?.details ?? []).map((d: any) => d.label)).slice(0, 110)}`);
    console.log(`               notes=${JSON.stringify(model?.notes ?? "").slice(0, 90)}`);
    console.log(`     SAVED   : details=${(e.details ?? []).length} links=${(e.links ?? []).length} contacts=${(e.contacts ?? []).length} notes=${String(e.notes ?? "").length}ch`);
  }

  console.log(`\n${"=".repeat(72)}\n7b. EVERY NON-CORRECT FACT, IN FULL\n${"=".repeat(72)}`);
  for (const o of ["MISCLASSIFIED","LOST","FABRICATED","DUPLICATED"] as Outcome[]) {
    const rows = all.filter((x) => x.outcome === o);
    console.log(`  ${o} (${rows.length})`);
    for (const x of rows)
      console.log(`     ${x.rec.padEnd(4)} ${x.fact.padEnd(18)} expected ${String(x.expect).padEnd(16)}` +
                  `${x.actual ? "actual " + x.actual.join("+") : ""}  [rule=${x.rule}]`);
  }

  console.log(`\n${"=".repeat(72)}\n8. EVIDENCE AGAINST THE HYPOTHESIS\n${"=".repeat(72)}`);
  console.log(modelVsSaved.length
    ? modelVsSaved.map((m) => "  " + m).join("\n")
    : "  model output and saved entry are identical for every matched record —\n" +
      "  the application layer alters nothing, so every discrepancy is upstream of the save");
  const perfect = consistency.filter((c) => c.rate === 1);
  console.log(`  fact types that were perfectly consistent across all 8 clones: ${perfect.length}/${consistency.length}` +
    (perfect.length ? ` (${perfect.map((p) => p.fact).join(", ")})` : ""));
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
