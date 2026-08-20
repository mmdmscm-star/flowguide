// RUNTIME PROOF — the observe-only fact ledger.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=http://localhost:3000 \
//     npx tsx scripts/ingestion-runtime/proof-fact-ledger.mts
//
// Real HTTP routes, real segmentation, real model calls, real database. Every
// row belongs to a disposable user created here and is removed in a finally
// block that verifies the removal by id.
//
// THE CENTRAL ARGUMENT. Inertness cannot be proven by re-running an import and
// diffing, because the model is not deterministic — two runs of the same paste
// differ for reasons that have nothing to do with the ledger. So the proof is
// built the other way round: the stored ledger is RECOMPUTED offline from the
// chunk's own segment_text and result, and must match byte for byte. A value
// that is reproducible from (segment, result) alone cannot have influenced
// either of them. It observed the output; it did not shape it.
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";
import { buildChunkLedger } from "../../src/lib/fact-ledger.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
if (!process.env.FLOWGUIDE_RT_CONFIRM) {
  console.error("Refusing to run without FLOWGUIDE_RT_CONFIRM=1 — this makes real model calls.");
  process.exit(1);
}
const TAG = "flowguide-ledgerproof-" + process.pid;
console.log(`\nObserve-only fact ledger — runtime proof — ${BASE}\n`);

const users: string[] = [];

async function makeUser(label: string) {
  const { data, error } = await svc.from("users")
    .insert({ email: `${TAG}-${label}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(`user ${label}: ${errText(error)}`);
  const id = (data as { id: string }).id;
  users.push(id);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({
    user_id: id, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
  });
  return { id, cookie: `flowguide_session=${token}` };
}

async function api(path: string, cookie: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    signal: AbortSignal.timeout(90_000),
  });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
}

async function drive(runId: string, cookie: string) {
  for (let guard = 0; guard < 60; guard++) {
    const { data: st } = await api(`/api/ingest/${runId}`, cookie);
    const chunks = (st.chunks ?? []) as { ordinal: number; status: string }[];
    const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
    if (!next) return;
    const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, cookie, { method: "POST" });
    const outcome = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (outcome.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${outcome.message}`);
    if (outcome.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
  }
  throw new Error("drive: guard tripped");
}

// A paste with facts the detector is designed to see: labelled key/values, a
// range, contacts and a URL. Deliberately ordinary — the point is a REAL import,
// not a corpus fixture.
const SOURCE = [
  `Fairview Gardens
1200 Example Rd, Santa Rosa CA 95401
Community Fee: $3,500 one time
Assisted Living Studio: $4,850/month
Level of care ranges from $450 to $1,900 per month
Capacity: 84 residents
Pat Rivera, Executive Director
707-555-0101
pat@fairviewgardens.example.com
https://www.fairviewgardens.example.com`,
  `Brookside Manor
88 Example Ave, Petaluma CA 94952
Community Fee: $2,900 one time
Memory Care Private Studio: $7,100/month
2nd Person Fee: $950/month
Capacity: 52 residents
Dana Whitfield, Placement Liaison
707-555-0144
dana@brooksidemanor.example.com`,
].join("\n\n");

// CANONICAL COMPARISON. jsonb does not preserve key order — it stores keys
// sorted by length, then bytewise — so a ledger written as {kind, text, line}
// reads back as {kind, line, text}. Comparing raw JSON.stringify output would
// report every chunk as a mismatch and the reproducibility proof would be
// worthless. Both sides are canonicalised the same way instead.
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}
/** Every read goes through this. A `select` naming a column that does not exist
 *  returns an ERROR and a null data set, not an exception — so ignoring `error`
 *  turns a typo into "zero rows", which reads downstream as either a vacuous
 *  pass or a phantom failure. This proof lost a run to exactly that: it asked
 *  for `chunk_ordinal` and `content`, neither of which exists. */
async function rows<T>(label: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${errText(error)}`);
  return data ?? [];
}

const stable = (v: unknown) => JSON.stringify(canon(v));

try {
  const pro = await makeUser("pro");

  const created = await api("/api/library/import", pro.cookie, {
    method: "POST", body: JSON.stringify({ rawText: SOURCE }),
  });
  check("a real Library AI import starts", created.status === 201,
    `status ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  const RUN = created.data.runId as string;

  await drive(RUN, pro.cookie);

  // ---- 1. every completed chunk carries a ledger ---------------------------
  const chunks = await rows<{
    ordinal: number; status: string; segment_text: string | null;
    result: unknown; fact_ledger: { facts?: unknown[]; counts?: Record<string, number> } | null;
  }>("chunks", svc.from("ingestion_chunks")
      .select("ordinal, status, segment_text, result, fact_ledger").eq("run_id", RUN).order("ordinal"));
  const completed = chunks.filter((c) => c.status === "completed");

  check("the import produced completed chunks", completed.length > 0, `${completed.length} completed`);
  check("EVERY completed chunk has a non-null fact_ledger",
    completed.every((c) => c.fact_ledger !== null),
    completed.map((c) => `#${c.ordinal}=${c.fact_ledger === null ? "NULL" : "ledger"}`).join(" "));

  // ---- 2. the ledger belongs to THAT chunk's segment -----------------------
  //        Recomputed offline. Byte-identical, or it is not this chunk's ledger.
  let mismatches = 0;
  for (const c of completed) {
    const recomputed = buildChunkLedger(c.segment_text ?? "", c.ordinal, c.result);
    if (stable(recomputed) !== stable(c.fact_ledger)) mismatches++;
  }
  check("each ledger is EXACTLY reproducible from that chunk's own segment_text and result",
    mismatches === 0, `${mismatches} of ${completed.length} chunk(s) did not reproduce`);

  // A ledger that reproduced against the WRONG segment would make the check
  // above worthless, so prove the binding is discriminating.
  if (completed.length > 1) {
    const a = completed[0], b = completed[1];
    const crossed = buildChunkLedger(b.segment_text ?? "", a.ordinal, a.result);
    check("...and does NOT reproduce against a different chunk's segment",
      stable(crossed) !== stable(a.fact_ledger), "the binding is not discriminating");
  }

  // ---- 3. facts were actually detected, and the counts are coherent --------
  const totals = completed.reduce((t, c) => {
    const k = c.fact_ledger?.counts ?? {};
    return { detected: t.detected + (k.detected ?? 0), accounted: t.accounted + (k.accounted ?? 0),
             unaccounted: t.unaccounted + (k.unaccounted ?? 0), facts: t.facts + (c.fact_ledger?.facts?.length ?? 0) };
  }, { detected: 0, accounted: 0, unaccounted: 0, facts: 0 });
  check("the ledger detected real facts in real source",
    totals.detected > 0, JSON.stringify(totals));
  check("counts are coherent: detected = accounted + unaccounted = facts recorded",
    totals.detected === totals.accounted + totals.unaccounted && totals.detected === totals.facts,
    JSON.stringify(totals));
  console.log(`      ledger totals: ${JSON.stringify(totals)}`);

  // ---- 4. INERT: the model's staged output is untouched --------------------
  // Proposals are materialized by an explicit POST — the same call the review
  // screen makes. Reading the table without it finds nothing, and every
  // assertion downstream would pass on an empty set.
  const mat = await api(`/api/library/import/${RUN}/proposals`, pro.cookie, { method: "POST" });
  check("proposals materialize for review", mat.ok,
    `status ${mat.status} ${JSON.stringify(mat.data).slice(0, 160)}`);

  const proposals = await rows<{ payload: Record<string, unknown>; ordinal: number }>(
    "proposals", svc.from("library_import_proposals").select("payload, ordinal").eq("run_id", RUN));
  check("the import produced proposals", proposals.length > 0, `${proposals.length} proposal(s)`);

  // Every proposal title must exist in the staged model result for its chunk.
  // If the ledger had repaired, rerouted or stripped anything, a proposal would
  // carry content the model did not return.
  const titlesFromResult = new Set<string>();
  for (const c of completed) {
    const r = (c.result ?? {}) as { items?: { title?: string }[]; sections?: { items?: { title?: string }[] }[] };
    for (const it of r.items ?? []) if (it?.title) titlesFromResult.add(it.title);
    for (const s of r.sections ?? []) for (const it of s?.items ?? []) if (it?.title) titlesFromResult.add(it.title);
  }
  const orphan = proposals.filter((p) => !titlesFromResult.has(String(p.payload?.title ?? "")));
  // Guarded on a non-empty set: `every`/`filter` over nothing is vacuously true,
  // and this proof has already been bitten once by a check that fired on absence.
  check("every proposal traces to the model's own staged result — nothing was added or rewritten",
    proposals.length > 0 && orphan.length === 0,
    `${proposals.length} proposal(s), ${orphan.length} with no matching staged title`);

  check("no ledger field leaked into any proposal payload",
    proposals.length > 0 && proposals.every((p) => !JSON.stringify(p.payload).includes("unaccounted")),
    `${proposals.length} proposal(s) checked`);

  // ---- 5. finalize RETAINS the ledger with the 0024 evidence ---------------
  // The REAL routes: /save takes proposalIds, /finish closes the import and
  // requires discardUnsaved when anything is left over. Read from the route
  // files rather than guessed — the last verifier round was lost to a signature
  // I assumed instead of checking.
  const ids = (await rows<{ id: string }>("proposal ids",
    svc.from("library_import_proposals").select("id").eq("run_id", RUN))).map((p) => p.id);
  const savedRes = await api(`/api/library/import/${RUN}/save`, pro.cookie, {
    method: "POST", body: JSON.stringify({ proposalIds: ids.slice(0, 2) }),
  });
  check("proposals save into the Library", savedRes.ok && ids.length > 0,
    `${ids.length} id(s) offered, ` +
    `status ${savedRes.status} ${JSON.stringify(savedRes.data).slice(0, 160)}`);

  const done = await api(`/api/library/import/${RUN}/finish`, pro.cookie, {
    method: "POST", body: JSON.stringify({ discardUnsaved: true }),
  });
  check("the import finalizes", done.ok,
    `status ${done.status} ${JSON.stringify(done.data).slice(0, 160)}`);

  const after = await rows<{ ordinal: number; segment_text: string | null; result: unknown; fact_ledger: unknown }>(
    "chunks after finalize", svc.from("ingestion_chunks")
      .select("ordinal, segment_text, result, fact_ledger").eq("run_id", RUN).order("ordinal"));
  const { data: runAfter } = await svc.from("ingestion_runs")
    .select("status, source_text, evidence_purge_after").eq("id", RUN).single();
  const ra = runAfter as { status: string; source_text: string | null; evidence_purge_after: string | null };

  check("FINALIZE RETAINS the ledger alongside the 0024 evidence",
    ra.status === "finalized" && ra.source_text !== null && ra.evidence_purge_after !== null &&
    after.filter((c) => c.segment_text !== null).length > 0 &&
    after.filter((c) => c.fact_ledger !== null).length === completed.length,
    `status=${ra.status} source=${ra.source_text === null ? "CLEARED" : "kept"} ` +
    `expiry=${ra.evidence_purge_after === null ? "MISSING" : "stamped"} ` +
    `segments=${after.filter((c) => c.segment_text !== null).length} ` +
    `ledgers=${after.filter((c) => c.fact_ledger !== null).length}/${completed.length}`);

  check("...and the ledger is unchanged by finalize",
    after.filter((c) => c.fact_ledger !== null).every((c) => {
      const before = completed.find((x) => x.ordinal === c.ordinal);
      return before ? stable(before.fact_ledger) === stable(c.fact_ledger) : false;
    }), "finalize altered a ledger");

  // ---- 6. saved Library entries carry no ledger trace ----------------------
  const lib = await rows<Record<string, unknown>>("library entries",
    svc.from("library_items").select("id, title, address, description, notes, details, links, photos, contacts")
      .eq("user_id", pro.id));
  check("entries saved to the Library are ordinary entries, with no ledger trace",
    lib.length > 0 && lib.every((l) => {
      const t = JSON.stringify(l);
      return !t.includes("unaccounted") && !t.includes("detailEligible") && !t.includes("fact_ledger");
    }),
    `${lib.length} entry(ies)`);

  summary("Observe-only fact ledger — runtime proof");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of users) {
    await svc.from("ingestion_runs").delete().eq("user_id", id);
    await svc.from("library_items").delete().eq("user_id", id);
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    for (const p of (ps ?? []) as { id: string }[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  let stray = 0;
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  stray += (lu ?? []).length;
  for (const id of users)
    for (const t of ["ingestion_runs", "library_items", "packets", "sessions"] as const) {
      const { data } = await svc.from(t).select("user_id").eq("user_id", id);
      stray += (data ?? []).length;
    }
  console.log(`\ncleanup: ${stray} row(s) remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
