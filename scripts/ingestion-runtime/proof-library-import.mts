// FULL END-TO-END RUNTIME PROOF — Library AI import.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=http://localhost:3000 \
//     npx tsx scripts/ingestion-runtime/proof-library-import.mts
//
// Real HTTP routes, real segmentation, real model calls, real database.
// EVERY row it creates belongs to disposable users created here and is removed
// in a finally block that verifies the removal by id. No live FlowGuide and no
// live Library is read or written.
//
// The split is forced NATURALLY — one oversized record trips shouldPresplit, so
// no fault injection and no environment flag is needed. That matters for what
// the ordering assertion is worth: the split children really are produced by the
// same code path a real oversized paste would take.
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const TAG = "flowguide-importproof-" + process.pid;
console.log(`\nLibrary AI import — full runtime proof — ${BASE}\n`);

const users: string[] = [];
const packets: string[] = [];
const libIds: string[] = [];

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

/** Drive every outstanding chunk, exactly as the browser does. */
async function drive(runId: string, cookie: string, opts: { stopAfter?: number } = {}) {
  let processed = 0;
  for (let guard = 0; guard < 60; guard++) {
    const { data: st } = await api(`/api/ingest/${runId}`, cookie);
    const chunks = (st.chunks ?? []) as { ordinal: number; status: string }[];
    const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
    if (!next) return { processed, chunks };
    const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, cookie, { method: "POST" });
    // The proof drives chunks exactly as a client does, through the SAME
    // classifier — otherwise it would prove a loop no real client runs.
    const outcome = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (outcome.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${outcome.message}`);
    if (outcome.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
    processed++;
    if (opts.stopAfter && processed >= opts.stopAfter) return { processed, chunks, stopped: true };
  }
  throw new Error("drive: guard tripped");
}

// ---- the paste -------------------------------------------------------------
const rec = (n: number) =>
  `Community ${n}\n${n}00 Example Rd, Santa Rosa CA\nAssisted living and memory care. Studio from $${3 + n},500 per month. Contact Pat Rivera, 707-555-0${100 + n}.`;
const HUGE = "Sunrise Villa\n" + Array.from({ length: 90 }, (_, i) =>
  `The community offers assisted living with a staffing ratio of ${i} residents per aide and a memory care wing last reviewed in ${2000 + i}.`).join(" ");
// The oversized record sits in the MIDDLE on purpose: its split children are
// appended with HIGHER ordinals, so ordinal order and source order disagree.
const SOURCE = [rec(1), rec(2), HUGE, rec(3), rec(4)].join("\n\n");

try {
  const pro = await makeUser("pro");

  // ---- 1. create ----------------------------------------------------------
  const created = await api("/api/library/import", pro.cookie, {
    method: "POST", body: JSON.stringify({ rawText: SOURCE }),
  });
  check("an import starts with no FlowGuide involved", created.status === 201,
    `status ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  const RUN = created.data.runId as string;

  const { data: runRow } = await svc.from("ingestion_runs")
    .select("destination, packet_id, entry_point, total_chunks").eq("id", RUN).single();
  const rr = runRow as Record<string, unknown>;
  check("the run is a library run with NO packet",
    rr.destination === "library" && rr.packet_id === null && rr.entry_point === "library_import",
    JSON.stringify(rr));
  check("the chunk plan was persisted with the run", Number(rr.total_chunks) === 3,
    `total_chunks=${rr.total_chunks}`);

  // ---- 2. one active import per professional --------------------------------
  const second = await api("/api/library/import", pro.cookie, {
    method: "POST", body: JSON.stringify({ rawText: "A completely different paste to import." }),
  });
  check("a DIFFERENT paste is refused while one is open, and names the open run",
    second.status === 409 && second.data.error === "import_in_progress" && second.data.runId === RUN,
    `status ${second.status} ${JSON.stringify(second.data).slice(0, 160)}`);

  const resubmit = await api("/api/library/import", pro.cookie, {
    method: "POST", body: JSON.stringify({ rawText: SOURCE }),
  });
  check("the SAME paste reconnects instead of starting a second import",
    resubmit.status === 200 && resubmit.data.reused === true && resubmit.data.runId === RUN,
    JSON.stringify(resubmit.data).slice(0, 160));

  // ---- 3. real chunked extraction, interrupted --------------------------------
  await drive(RUN, pro.cookie, { stopAfter: 1 });

  const found = await api("/api/library/import", pro.cookie);
  check("RECONNECT MID-EXTRACTION: the open import is discoverable with no pasted text",
    found.data?.run?.id === RUN, JSON.stringify(found.data).slice(0, 160));
  const mid = await api(`/api/library/import/${RUN}/proposals`, pro.cookie);
  check("and it reports itself as still extracting", mid.data.phase === "extracting",
    `phase ${mid.data.phase}`);

  const early = await api(`/api/library/import/${RUN}/proposals`, pro.cookie, { method: "POST" });
  check("materialising early is REFUSED, so a partial import cannot pose as the whole one",
    early.status === 409 && early.data.error === "not_ready", `status ${early.status}`);

  const drove = await drive(RUN, pro.cookie);
  check("extraction resumes and completes", drove.processed > 0, `${drove.processed} more chunks`);

  // ---- 4. the forced split ---------------------------------------------------
  const { data: chunkRows } = await svc.from("ingestion_chunks")
    .select("ordinal, source_start, status, split_depth").eq("run_id", RUN).order("ordinal");
  const cs = (chunkRows ?? []) as Record<string, unknown>[];
  const split = cs.filter((c) => c.status === "split");
  const children = cs.filter((c) => Number(c.split_depth) > 0);
  check("the oversized record really was split", split.length === 1 && children.length >= 2,
    `${split.length} split parent(s), ${children.length} child chunk(s)`);
  check("and the children carry HIGHER ordinals than a chunk that precedes them in the source",
    children.every((c) => Number(c.ordinal) > 1) &&
      children.every((c) => Number(c.source_start) < 11985),
    JSON.stringify(children.map((c) => ({ o: c.ordinal, s: c.source_start }))));

  // ---- 5. materialise --------------------------------------------------------
  const mat = await api(`/api/library/import/${RUN}/proposals`, pro.cookie, { method: "POST" });
  check("materialising produces proposals", mat.ok && (mat.data.proposals ?? []).length > 0,
    `inserted ${mat.data.inserted}, ${(mat.data.proposals ?? []).length} proposals`);
  const proposals = mat.data.proposals as { id: string; ordinal: number; idx: number; title: string }[];

  const startOf = new Map(cs.map((c) => [Number(c.ordinal), Number(c.source_start)]));
  const starts = proposals.map((p) => startOf.get(p.ordinal) ?? -1);
  check("SOURCE ORDER: proposals come back ordered by position in the paste",
    starts.every((s, i) => i === 0 || s >= starts[i - 1]),
    JSON.stringify(proposals.map((p) => ({ ord: p.ordinal, start: startOf.get(p.ordinal) }))));

  const byOrdinal = [...proposals].sort((a, b) => a.ordinal - b.ordinal || a.idx - b.idx);
  check("and that ordering genuinely differs from ordering by ordinal",
    JSON.stringify(byOrdinal.map((p) => p.id)) !== JSON.stringify(proposals.map((p) => p.id)),
    "if these matched, the split children did not land mid-source and the check proves nothing");

  // ---- 6. review edits survive, materialising again changes nothing ----------
  const target = proposals[0];
  const edited = await api(`/api/library/import/${RUN}/proposals/${target.id}`, pro.cookie, {
    method: "PATCH",
    body: JSON.stringify({ item: { title: "EDITED BY THE PROFESSIONAL", address: "1 Reviewed Way" }, selected: true }),
  });
  check("a proposal can be edited and selected", edited.ok, JSON.stringify(edited.data).slice(0, 160));

  const again = await api(`/api/library/import/${RUN}/proposals`, pro.cookie, { method: "POST" });
  check("IDEMPOTENT: materialising again inserts nothing", again.data.inserted === 0,
    `inserted ${again.data.inserted}`);

  const restored = await api(`/api/library/import/${RUN}/proposals`, pro.cookie);
  const back = (restored.data.proposals as { id: string; title: string; address: string; selected: boolean }[])
    .find((p) => p.id === target.id);
  check("RECONNECT MID-REVIEW: the edit and the selection are restored exactly",
    back?.title === "EDITED BY THE PROFESSIONAL" && back?.address === "1 Reviewed Way" && back?.selected === true,
    JSON.stringify(back));

  // ---- 7. save ---------------------------------------------------------------
  const saved = await api(`/api/library/import/${RUN}/save`, pro.cookie, { method: "POST", body: "{}" });
  check("the selected proposal saves to the Library", saved.ok && saved.data.saved === 1,
    JSON.stringify(saved.data).slice(0, 220));
  const newId = (saved.data.results ?? []).find((r: { outcome: string }) => r.outcome === "saved")?.libraryItemId;
  if (newId) libIds.push(newId);

  const { data: libRow } = await svc.from("library_items")
    .select("title, address, source_packet_item_id").eq("id", newId).single();
  const lr = libRow as Record<string, unknown>;
  check("the saved entry carries the reviewed edit, not the model's original",
    lr.title === "EDITED BY THE PROFESSIONAL" && lr.address === "1 Reviewed Way", JSON.stringify(lr));
  check("and records no packet lineage", lr.source_packet_item_id === null);

  const { data: goneRow } = await svc.from("library_import_proposals").select("id").eq("id", target.id);
  check("the saved proposal was consumed in the same transaction", (goneRow ?? []).length === 0);

  const retry = await api(`/api/library/import/${RUN}/save`, pro.cookie, {
    method: "POST", body: JSON.stringify({ proposalIds: [target.id] }),
  });
  const { count: libCount } = await svc.from("library_items")
    .select("id", { count: "exact", head: true }).eq("user_id", pro.id);
  check("RETRY of a saved proposal creates no duplicate",
    libCount === 1, `${libCount} library item(s) after retry (status ${retry.status})`);

  // ---- 8. Finish protection ---------------------------------------------------
  const remaining = await api(`/api/library/import/${RUN}/proposals`, pro.cookie);
  const survivor = (remaining.data.proposals as { id: string }[])[0];
  await api(`/api/library/import/${RUN}/proposals/${survivor.id}`, pro.cookie, {
    method: "PATCH", body: JSON.stringify({ selected: true }),
  });

  const blocked = await api(`/api/library/import/${RUN}/finish`, pro.cookie, { method: "POST", body: "{}" });
  check("FINISH REFUSES while a selected proposal is unsaved, and says how many",
    blocked.status === 409 && blocked.data.error === "unsaved_proposals" && blocked.data.selected >= 1,
    JSON.stringify(blocked.data).slice(0, 200));

  const finished = await api(`/api/library/import/${RUN}/finish`, pro.cookie, {
    method: "POST", body: JSON.stringify({ discardUnsaved: true }),
  });
  check("and completes once the professional acknowledges what will go",
    finished.ok && finished.data.status === "finished", JSON.stringify(finished.data).slice(0, 160));

  const { data: closedRun } = await svc.from("ingestion_runs")
    .select("status, source_text, evidence_purge_after").eq("id", RUN).single();
  const cr = closedRun as Record<string, unknown>;
  // 0024 SPLIT FINISHING FROM THROWING AWAY. This assertion predates that: it
  // still expected finalize to clear the source, which is exactly the evidence
  // destruction 0024 removed - a completed import used to be impossible to
  // diagnose afterwards. Finalize now RETAINS the source and stamps a bounded
  // expiry; discard is what clears it immediately. So the property to check is
  // "retained AND bounded", not "gone".
  check("the finished run is finalized, its source RETAINED under a bounded expiry",
    cr.status === "finalized" && typeof cr.source_text === "string" && cr.evidence_purge_after !== null,
    `${cr.status}, source ${cr.source_text === null ? "cleared" : "retained"}, expiry ${cr.evidence_purge_after}`);
  const { count: leftover } = await svc.from("library_import_proposals")
    .select("id", { count: "exact", head: true }).eq("run_id", RUN);
  check("and no proposal outlives it", leftover === 0, `${leftover} left`);
  const { count: keptItems } = await svc.from("library_items")
    .select("id", { count: "exact", head: true }).eq("user_id", pro.id);
  check("what was already saved STAYS saved", keptItems === 1, `${keptItems} item(s)`);

  // ---- 9. Abandon ------------------------------------------------------------
  const ab = await makeUser("abandoner");
  const abRun = await api("/api/library/import", ab.cookie, {
    method: "POST", body: JSON.stringify({ rawText: [rec(7), rec(8)].join("\n\n") }),
  });
  const AB = abRun.data.runId as string;
  const noConfirm = await api(`/api/library/import/${AB}/abandon`, ab.cookie, { method: "POST", body: "{}" });
  check("ABANDON requires its own explicit confirmation",
    noConfirm.status === 409 && noConfirm.data.error === "confirm_required",
    JSON.stringify(noConfirm.data).slice(0, 160));
  const abandoned = await api(`/api/library/import/${AB}/abandon`, ab.cookie, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  check("and then throws the import away", abandoned.ok && abandoned.data.status === "abandoned",
    JSON.stringify(abandoned.data).slice(0, 160));
  const { data: abRow } = await svc.from("ingestion_runs").select("status").eq("id", AB).single();
  check("the abandoned run is discarded", (abRow as { status: string }).status === "discarded");

  const fresh = await api("/api/library/import", ab.cookie, {
    method: "POST", body: JSON.stringify({ rawText: [rec(9)].join("\n\n") }),
  });
  check("and the professional can immediately start another",
    fresh.status === 201, `status ${fresh.status}`);
  await api(`/api/library/import/${fresh.data.runId}/abandon`, ab.cookie, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });

  // ---- 10. packet ingestion regression ---------------------------------------
  const pk = await makeUser("packet");
  const org = await api("/api/ingest/organize", pk.cookie, {
    method: "POST",
    body: JSON.stringify({ rawText: [rec(1), rec(2), rec(3)].join("\n\n"), packetType: "senior_placement",
                           requestKey: crypto.randomUUID() }),
  });
  check("PACKET REGRESSION: Organize with AI still creates a packet and a run",
    org.status === 201 && !!org.data.packetId, JSON.stringify(org.data).slice(0, 200));
  if (org.data.packetId) packets.push(org.data.packetId);

  await drive(org.data.runId, pk.cookie);
  const fin = await api(`/api/ingest/${org.data.runId}/finalize`, pk.cookie, { method: "POST", body: "{}" });
  check("and still finalizes into the packet", fin.ok, JSON.stringify(fin.data).slice(0, 200));

  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", org.data.packetId);
  const secIds = (secs ?? []).map((s: { id: string }) => s.id);
  const { count: itemCount } = secIds.length
    ? await svc.from("items").select("id", { count: "exact", head: true }).in("section_id", secIds)
    : { count: 0 };
  check("the packet really has structure", (secs ?? []).length > 0 && (itemCount ?? 0) > 0,
    `${(secs ?? []).length} section(s), ${itemCount} item(s)`);

  const wrongWay = await api(`/api/ingest/${RUN}/finalize`, pro.cookie, { method: "POST", body: "{}" });
  check("packet finalize still refuses a library run",
    wrongWay.status === 409 && wrongWay.data.error === "wrong_destination",
    `status ${wrongWay.status} ${JSON.stringify(wrongWay.data).slice(0, 120)}`);

  summary("Library AI import — full runtime proof");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of libIds) await svc.from("library_items").delete().eq("id", id);
  for (const id of users) {
    // Runs, chunks and proposals cascade from the run's FK to the user.
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
  for (const id of users) {
    for (const t of ["ingestion_runs", "library_items", "packets", "sessions"] as const) {
      const { data } = await svc.from(t).select("user_id").eq("user_id", id);
      stray += (data ?? []).length;
    }
  }
  const { data: lp } = packets.length ? await svc.from("packets").select("id").in("id", packets) : { data: [] };
  stray += (lp ?? []).length;
  console.log(`\ncleanup: ${stray} row(s) remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
