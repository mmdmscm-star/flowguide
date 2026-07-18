// RUNTIME SUITE — disposable data only.
// Containment: every row is created under ONE disposable user. Cleanup deletes
// that user, and the FK cascade removes exactly what this suite made. No genuine
// row is ever targeted by any delete in this file.
import { svc, root, check, summary, errText } from "./lib.mts";
import { readFileSync, writeFileSync } from "node:fs";

const { buildRunChunks, buildSplitChildren } = await import(`${root}/src/lib/ingestion.ts`);
const { segmentHash, SEGMENTER_VERSION } = await import(`${root}/src/lib/segmentation.ts`);

const base = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
const TAG = "flowguide-rt-" + process.pid;
const timings: Record<string, number[]> = {};
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  (timings[label] ??= []).push(performance.now() - t0);
  return r;
}

// ---------------------------------------------------------------- disposable user
const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("cannot create disposable user:", errText(uerr)); process.exit(1); }
const UID = user.id as string;
console.log(`disposable user: ${UID} (${TAG})\n`);

let slugN = 0;
// Packets must be born legacy (DB trigger); blocks mode is reachable only via
// convert_packet_to_blocks. The harness uses the same real path the app does.
async function mkPacket(mode: "legacy" | "blocks", status = "draft") {
  const { data, error } = await svc.from("packets").insert({
    user_id: UID, slug: `${TAG}-${slugN++}`, title: "RT", status,
  }).select("id, content_rev").single();
  if (error) throw new Error("mkPacket: " + errText(error));
  if (mode === "blocks") {
    const { error: cerr } = await svc.rpc("convert_packet_to_blocks", { p_packet_id: data.id });
    if (cerr) throw new Error("convert_packet_to_blocks: " + errText(cerr));
    const { data: chk } = await svc.from("packets").select("id, content_rev, composition_mode").eq("id", data.id).single();
    if (chk?.composition_mode !== "blocks") throw new Error("convert did not yield blocks mode");
    return chk as any;
  }
  return data as { id: string; content_rev: number };
}
async function itemsOf(packetId: string) {
  const { data: secs } = await svc.from("sections").select("id, title, sort_order").eq("packet_id", packetId).order("sort_order");
  const ids = (secs ?? []).map((s: any) => s.id);
  if (!ids.length) return { secs: secs ?? [], items: [] as any[] };
  const { data: items } = await svc.from("items").select("id, title, section_id, sort_order").in("section_id", ids);
  return { secs: secs ?? [], items: items ?? [] };
}
async function mkSection(packetId: string, title = "Existing") {
  const { data, error } = await svc.from("sections")
    .insert({ packet_id: packetId, title, sort_order: 0 }).select("id").single();
  if (error) throw new Error("mkSection: " + errText(error));
  return data.id as string;
}

const SRC = [
  "Coffee Shops", "Blue Bottle — 300 Webster St, Oakland. Great pourover.",
  "Sightglass — 270 7th St, SF. Roastery on site.",
  "Parks", "Dolores Park — 19th & Dolores, SF. Best skyline view.",
].join("\n\n");
const CHUNKS = buildRunChunks(SRC);
// A realistic large paste — this is the case that blew the 60s single-call budget
// and motivated the feature. Multi-chunk, so it also exercises real concurrency.
const BIG = Array.from({ length: 60 }, (_, i) =>
  `Neighborhood ${i}\n\nPlace ${i} — ${i} Main St, Springfield. ${"detail ".repeat(40)}`).join("\n\n");
const BIG_CHUNKS = buildRunChunks(BIG);
// Result shapes are ENTRY-POINT SPECIFIC and finalize coalesces a missing key to
// []: organize/append read result->'sections'; section_append reads result->'items'.
// Supplying the wrong shape finalizes to a silent no-op, so each run uses its own.
const ITEM = { title: "Blue Bottle", address: "300 Webster St", description: "Great pourover" };
const RESULT = { sections: [{ title: "Coffee", description: "", items: [ITEM] }] };
const RESULT_ITEMS = { items: [ITEM] };

let failed = false;
const fin = (e: any) => errText(e);

try {
// ============================================================ 1. happy path
console.log("[1] append happy path: run -> claim -> stage -> finalize");
{
  const p = await mkPacket("legacy");
  await mkSection(p.id);
  const { data: runId, error } = await timed("create_ingestion_run", () => svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  }));
  check("create_ingestion_run succeeds", !error && !!runId, fin(error));

  const { data: rows } = await svc.from("ingestion_chunks").select("ordinal").eq("run_id", runId);
  check("chunks persisted", (rows?.length ?? 0) === CHUNKS.length, `${rows?.length} vs ${CHUNKS.length}`);

  for (const c of CHUNKS) {
    const { data: cl, error: cerr } = await timed("claim_chunk", () => svc.rpc("claim_chunk", {
      p_run_id: runId, p_owner: UID, p_ordinal: c.ordinal, p_lease_seconds: 90,
    }));
    check(`claim chunk ${c.ordinal}`, !cerr && cl?.claimed === true, fin(cerr));
    const { error: serr } = await timed("stage_chunk_result", () => svc.rpc("stage_chunk_result", {
      p_run_id: runId, p_owner: UID, p_ordinal: c.ordinal, p_attempt: cl.attempt,
      p_segment_hash: c.segment_hash, p_result: RESULT,
    }));
    check(`stage chunk ${c.ordinal}`, !serr, fin(serr));
  }

  const { data: f, error: ferr } = await timed("finalize_ingestion_run", () =>
    svc.rpc("finalize_ingestion_run", { p_run_id: runId, p_owner: UID }));
  check("finalize succeeds", !ferr, fin(ferr));

  const { items, secs } = await itemsOf(p.id);
  // One pre-existing section + one new section per leaf chunk, one item each.
  check("append materialized one section per chunk", secs.length === 1 + CHUNKS.length, `${secs.length} sections`);
  check("append materialized one item per chunk", items.length === CHUNKS.length, `${items.length} items`);
  check("item content came from the staged result", items.every((i: any) => i.title === ITEM.title), JSON.stringify(items[0] ?? {}));
  check("pre-existing section untouched by append", secs[0].title === "Existing", secs[0].title);

  const { data: run } = await svc.from("ingestion_runs").select("status, source_text, derived_title, error").eq("id", runId).single();
  check("run finalized", run?.status === "finalized", run?.status);
  check("PRIVACY finalize: source_text cleared", run?.source_text === null, String(run?.source_text).slice(0, 40));
  const { data: ch } = await svc.from("ingestion_chunks").select("segment_text, section_hint, result, error").eq("run_id", runId);
  check("PRIVACY finalize: chunk text/result/hint/error cleared",
    (ch ?? []).every((c: any) => c.segment_text === null && c.result === null && c.section_hint === "" && c.error === ""),
    JSON.stringify(ch?.[0]).slice(0, 120));
}

// ============================================================ 2. THE FIX
console.log("\n[2] late writes after run ends (the mark_chunk_failed fix)");
{
  const p = await mkPacket("legacy");
  await mkSection(p.id);
  const { data: runId } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  // 1. claim (model request now "in flight")
  const { data: cl } = await svc.rpc("claim_chunk", { p_run_id: runId, p_owner: UID, p_ordinal: 0, p_lease_seconds: 90 });
  check("chunk claimed, attempt issued", cl?.claimed === true && typeof cl.attempt === "number", JSON.stringify(cl));

  // 2. user discards while it is outstanding
  const { error: derr } = await timed("discard_ingestion_run", () =>
    svc.rpc("discard_ingestion_run", { p_run_id: runId, p_owner: UID }));
  check("discard succeeds mid-flight", !derr, fin(derr));

  // Preconditions that make this a real hazard: the chunk is still 'processing'
  // with a still-current attempt, so every OTHER guard would have passed.
  const { data: pre } = await svc.from("ingestion_chunks").select("status, attempt_count").eq("run_id", runId).eq("ordinal", 0).single();
  check("chunk still 'processing' after discard (guard is load-bearing)", pre?.status === "processing", pre?.status);
  check("attempt_count still current after discard", pre?.attempt_count === cl.attempt, `${pre?.attempt_count} vs ${cl.attempt}`);

  // 3-4. the late failure must be REJECTED
  const SECRET = "MODEL-ERROR-LEAK-CANARY-" + TAG;
  const { error: lferr } = await svc.rpc("mark_chunk_failed", {
    p_run_id: runId, p_owner: UID, p_ordinal: 0, p_attempt: cl.attempt, p_error: SECRET,
  });
  check("late mark_chunk_failed REJECTED", !!lferr && /not active/i.test(fin(lferr)), lferr ? fin(lferr).slice(0, 80) : "ACCEPTED — LEAK");

  // late stage and split must also be rejected
  const { error: lserr } = await svc.rpc("stage_chunk_result", {
    p_run_id: runId, p_owner: UID, p_ordinal: 0, p_attempt: cl.attempt,
    p_segment_hash: CHUNKS[0].segment_hash, p_result: { items: [{ title: SECRET }] },
  });
  check("late stage_chunk_result REJECTED", !!lserr && /not active/i.test(fin(lserr)), lserr ? fin(lserr).slice(0, 80) : "ACCEPTED — LEAK");
  const { error: lsp } = await svc.rpc("split_chunk", {
    p_run_id: runId, p_owner: UID, p_ordinal: 0, p_attempt: cl.attempt,
    p_children: buildSplitChildren(SRC, CHUNKS[0].source_start, CHUNKS[0].source_end),
  });
  check("late split_chunk REJECTED", !!lsp && /not active/i.test(fin(lsp)), lsp ? fin(lsp).slice(0, 80) : "ACCEPTED — LEAK");

  // 5. nothing carries text, and the canary is nowhere
  const { data: run } = await svc.from("ingestion_runs").select("status, source_text, derived_title, derived_client_name, error").eq("id", runId).single();
  const { data: chs } = await svc.from("ingestion_chunks").select("segment_text, section_hint, result, error").eq("run_id", runId);
  check("discarded run holds no source text", run?.source_text === null && run?.derived_title === "" && run?.error === "", JSON.stringify(run).slice(0, 120));
  check("discarded chunks hold no text/result/hint/error",
    (chs ?? []).every((c: any) => c.segment_text === null && c.result === null && c.section_hint === "" && c.error === ""),
    JSON.stringify(chs?.[0]).slice(0, 120));
  const blob = JSON.stringify(run) + JSON.stringify(chs);
  check("no model-error canary anywhere in run/chunks", !blob.includes("CANARY"), "CANARY PRESENT — LEAK");
}

// ============================================================ 3. composition mode
console.log("\n[3] append entry points are legacy-only");
{
  // Build the section while still legacy, then convert. The section therefore
  // genuinely belongs to the packet and survives conversion, so composition mode
  // is the ONLY reason these can be rejected — no false pass from a bad section.
  const { data: bl, error: blerr } = await svc.from("packets")
    .insert({ user_id: UID, slug: `${TAG}-blk`, title: "RT", status: "draft" }).select("id").single();
  if (blerr) throw new Error("block packet: " + errText(blerr));
  const secId = await mkSection(bl.id, "Pre-convert");
  const { error: cverr } = await svc.rpc("convert_packet_to_blocks", { p_packet_id: bl.id });
  if (cverr) throw new Error("convert: " + errText(cverr));
  const b = { id: bl.id };
  const { data: modeChk } = await svc.from("packets").select("composition_mode").eq("id", b.id).single();
  check("test packet really is in blocks mode", modeChk?.composition_mode === "blocks", modeChk?.composition_mode);
  const { data: secChk } = await svc.from("sections").select("id, packet_id").eq("id", secId).maybeSingle();
  check("target section survives conversion and still belongs to the packet", secChk?.packet_id === b.id, JSON.stringify(secChk));

  for (const ep of ["append", "section_append"]) {
    const { error } = await svc.rpc("create_ingestion_run", {
      p_owner: UID, p_packet_id: b.id, p_entry_point: ep, p_target_section_id: ep === "section_append" ? secId : null,
      p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
      p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
    });
    check(`${ep} on a BLOCK packet rejected`, !!error && /legacy composition mode/i.test(fin(error)), error ? fin(error).slice(0, 80) : "ACCEPTED");
  }
  const { count } = await svc.from("ingestion_runs").select("*", { count: "exact", head: true }).eq("packet_id", b.id);
  check("no run row created for rejected block-mode attempts", count === 0, `${count}`);

  // legacy section_append still works END TO END, into the named section only
  const l = await mkPacket("legacy");
  const lsec = await mkSection(l.id, "Target");
  const other = await mkSection(l.id, "Other");
  await svc.from("sections").update({ sort_order: 1 }).eq("id", other);
  const { data: lrun, error: ok } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: l.id, p_entry_point: "section_append", p_target_section_id: lsec,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  check("section_append on a LEGACY packet accepted", !ok, fin(ok));
  for (const c of CHUNKS) {
    const { data: cl } = await svc.rpc("claim_chunk", { p_run_id: lrun, p_owner: UID, p_ordinal: c.ordinal, p_lease_seconds: 90 });
    await svc.rpc("stage_chunk_result", { p_run_id: lrun, p_owner: UID, p_ordinal: c.ordinal, p_attempt: cl.attempt, p_segment_hash: c.segment_hash, p_result: RESULT_ITEMS });
  }
  const { error: lfe } = await svc.rpc("finalize_ingestion_run", { p_run_id: lrun, p_owner: UID });
  check("section_append finalizes", !lfe, fin(lfe));
  const { items: li, secs: ls } = await itemsOf(l.id);
  check("section_append created NO new sections", ls.length === 2, `${ls.length} sections`);
  check("section_append items all landed in the TARGET section", li.length === CHUNKS.length && li.every((i: any) => i.section_id === lsec), `${li.length} items, sections ${[...new Set(li.map((i: any) => i.section_id))].length}`);
  check("section_append items are contiguously ordered from 0", JSON.stringify([...li].sort((a: any, b: any) => a.sort_order - b.sort_order).map((i: any) => i.sort_order)) === JSON.stringify(li.map((_: any, n: number) => n)), JSON.stringify(li.map((i: any) => i.sort_order)));
}

// ============================================================ 4. claim/lease/attempt
console.log("\n[4] claim atomicity, lease, attempt generation");
{
  const p = await mkPacket("legacy"); await mkSection(p.id);
  const { data: runId } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  const { data: c1 } = await svc.rpc("claim_chunk", { p_run_id: runId, p_owner: UID, p_ordinal: 0, p_lease_seconds: 90 });
  const { data: c2 } = await svc.rpc("claim_chunk", { p_run_id: runId, p_owner: UID, p_ordinal: 0, p_lease_seconds: 90 });
  check("second claim under a live lease is refused", c1?.claimed === true && c2?.claimed === false, JSON.stringify(c2));

  // Concurrent claims on a MULTI-chunk run. The short fixture yields a single
  // chunk, so racing ordinal 1 there would have raced a nonexistent row.
  const pm = await mkPacket("legacy"); await mkSection(pm.id);
  const { data: mrun } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: pm.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: BIG, p_source_hash: segmentHash(BIG), p_source_len: BIG.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: BIG_CHUNKS,
  });
  check("large source produced multiple chunks", BIG_CHUNKS.length > 1, `${BIG_CHUNKS.length}`);
  const race = await Promise.all([1, 2, 3, 4, 5, 6].map(() =>
    svc.rpc("claim_chunk", { p_run_id: mrun, p_owner: UID, p_ordinal: 1, p_lease_seconds: 90 })));
  const winners = race.filter((r: any) => r.data?.claimed === true).length;
  const errs = race.filter((r: any) => r.error).length;
  check("6 concurrent claims on one chunk yield exactly one winner", winners === 1, `${winners} winners, ${errs} errors`);
  const { data: rc } = await svc.from("ingestion_chunks").select("attempt_count").eq("run_id", mrun).eq("ordinal", 1).single();
  check("contended chunk counted exactly one attempt", rc?.attempt_count === 1, `${rc?.attempt_count}`);

  // lease expiry -> recovery with a NEW attempt generation
  const { data: c3 } = await svc.rpc("claim_chunk", { p_run_id: runId, p_owner: UID, p_ordinal: 0, p_lease_seconds: 0 });
  check("expired lease is recoverable", c3?.claimed === true, JSON.stringify(c3));
  check("recovery issues a new attempt generation", c3?.attempt === c1.attempt + 1, `${c3?.attempt} vs ${c1.attempt}`);

  // the superseded attempt is now stale on every path
  const { error: st } = await svc.rpc("stage_chunk_result", {
    p_run_id: runId, p_owner: UID, p_ordinal: 0, p_attempt: c1.attempt,
    p_segment_hash: CHUNKS[0].segment_hash, p_result: RESULT,
  });
  check("superseded attempt cannot stage", !!st && /stale claim/i.test(fin(st)), st ? fin(st).slice(0, 70) : "ACCEPTED");
  const { error: mf } = await svc.rpc("mark_chunk_failed", {
    p_run_id: runId, p_owner: UID, p_ordinal: 0, p_attempt: c1.attempt, p_error: "x",
  });
  check("superseded attempt cannot fail", !!mf && /stale claim/i.test(fin(mf)), mf ? fin(mf).slice(0, 70) : "ACCEPTED");

  // wrong segment hash (plan drift) is refused
  const { error: hh } = await svc.rpc("stage_chunk_result", {
    p_run_id: runId, p_owner: UID, p_ordinal: 0, p_attempt: c3.attempt,
    p_segment_hash: "not-the-hash", p_result: RESULT,
  });
  check("segment-hash mismatch refused", !!hh && /hash mismatch/i.test(fin(hh)), hh ? fin(hh).slice(0, 70) : "ACCEPTED");
}

// ============================================================ 5. ownership isolation
console.log("\n[5] cross-owner isolation");
{
  const { data: other } = await svc.from("users").insert({ email: `${TAG}-other@disposable.invalid` }).select("id").single();
  const p = await mkPacket("legacy"); await mkSection(p.id);
  const { data: runId } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  for (const [fn, args] of [
    ["claim_chunk", { p_run_id: runId, p_owner: other.id, p_ordinal: 0, p_lease_seconds: 90 }],
    ["discard_ingestion_run", { p_run_id: runId, p_owner: other.id }],
    ["finalize_ingestion_run", { p_run_id: runId, p_owner: other.id }],
  ] as const) {
    const { error } = await svc.rpc(fn, args as any);
    check(`${fn} rejects a non-owner`, !!error && /does not own/i.test(fin(error)), error ? fin(error).slice(0, 70) : "ACCEPTED");
  }
  const { error: xp } = await svc.rpc("create_ingestion_run", {
    p_owner: other.id, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  check("create_ingestion_run rejects a non-owner", !!xp && /does not own/i.test(fin(xp)), xp ? fin(xp).slice(0, 70) : "ACCEPTED");
}

// ============================================================ 6. content_rev conflict + publish guard
console.log("\n[6] content_rev conflict guard + publish block");
{
  const p = await mkPacket("legacy"); await mkSection(p.id);
  const { data: runId } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  for (const c of CHUNKS) {
    const { data: cl } = await svc.rpc("claim_chunk", { p_run_id: runId, p_owner: UID, p_ordinal: c.ordinal, p_lease_seconds: 90 });
    await svc.rpc("stage_chunk_result", { p_run_id: runId, p_owner: UID, p_ordinal: c.ordinal, p_attempt: cl.attempt, p_segment_hash: c.segment_hash, p_result: RESULT });
  }
  // publishing while the run is active must be blocked by the trigger
  const { error: pub } = await svc.from("packets").update({ status: "published" }).eq("id", p.id);
  check("publish blocked while a run is active", !!pub && /import is in progress/i.test(fin(pub)), pub ? fin(pub).slice(0, 70) : "PUBLISH ALLOWED");

  // concurrent edit bumps content_rev -> finalize must refuse
  const before = (await svc.from("packets").select("content_rev").eq("id", p.id).single()).data!.content_rev;
  await svc.from("packets").update({ title: "edited mid-run" }).eq("id", p.id);
  const after = (await svc.from("packets").select("content_rev").eq("id", p.id).single()).data!.content_rev;
  check("content_rev bumped by a real edit (trigger live)", after > before, `${before} -> ${after}`);
  const { error: fe } = await svc.rpc("finalize_ingestion_run", { p_run_id: runId, p_owner: UID });
  check("finalize refuses after a concurrent edit", !!fe, fe ? fin(fe).slice(0, 80) : "FINALIZED ANYWAY");
  const { count } = await svc.from("items").select("*, sections!inner(packet_id)", { count: "exact", head: true }).eq("sections.packet_id", p.id);
  check("no partial items written by the refused finalize", count === 0, `${count} items`);
}

// ============================================================ 7. organize idempotency + discard
console.log("\n[7] organize idempotency + discard of an empty draft");
{
  const key = TAG + "-orgkey";
  const mk = () => svc.rpc("create_organize_run", {
    p_owner: UID, p_packet_type: "general", p_slug: `${TAG}-org-${Math.floor(performance.now())}`,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_request_key: key, p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  // NOTE: the RPC returns snake_case keys (run_id/packet_id); the organize route
  // maps them to camelCase for its own JSON. Comparing camelCase here would make
  // the idempotency assertions vacuously true (undefined === undefined).
  const { data: o1, error: e1 } = await timed("create_organize_run", mk);
  check("organize run created", !e1 && !!o1?.run_id && !!o1?.packet_id, fin(e1) || JSON.stringify(o1));
  const { data: o2 } = await mk();
  check("same request_key collapses to the same run", !!o1?.run_id && o2?.run_id === o1.run_id, `${o2?.run_id} vs ${o1?.run_id}`);
  check("same request_key reuses the same packet", !!o1?.packet_id && o2?.packet_id === o1.packet_id, `${o2?.packet_id} vs ${o1?.packet_id}`);
  check("second organize call reports reuse", o2?.reused === true, JSON.stringify(o2));

  const { error: diff } = await svc.rpc("create_organize_run", {
    p_owner: UID, p_packet_type: "general", p_slug: `${TAG}-org-diff`,
    p_source_text: SRC + " DIFFERENT", p_source_hash: segmentHash(SRC + " DIFFERENT"), p_source_len: SRC.length + 10,
    p_request_key: key, p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  check("same key + different source rejected", !!diff, diff ? fin(diff).slice(0, 70) : "ACCEPTED");

  // discard an untouched organize draft -> packet deleted
  const { data: d1, error: derr } = await svc.rpc("discard_ingestion_run", { p_run_id: o1.run_id, p_owner: UID });
  check("discard of an empty organize draft deletes the packet", !derr && d1?.deletedPacket === true, fin(derr) || JSON.stringify(d1));
  const { count: gone } = await svc.from("packets").select("*", { count: "exact", head: true }).eq("id", o1.packet_id);
  check("organize draft packet is gone", gone === 0, `${gone}`);
}

console.log("\n[8] discard idempotency on a preserved packet");
{
  const p = await mkPacket("legacy"); await mkSection(p.id);
  const { data: runId } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: SRC, p_source_hash: segmentHash(SRC), p_source_len: SRC.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: CHUNKS,
  });
  const { data: d1 } = await svc.rpc("discard_ingestion_run", { p_run_id: runId, p_owner: UID });
  const { data: d2 } = await svc.rpc("discard_ingestion_run", { p_run_id: runId, p_owner: UID });
  check("first discard preserves the existing packet", d1?.deletedPacket === false, JSON.stringify(d1));
  check("repeat discard is idempotent (reused)", d2?.reused === true && d2?.deletedPacket === false, JSON.stringify(d2));
  const { count } = await svc.from("packets").select("*", { count: "exact", head: true }).eq("id", p.id);
  check("packet with prior content survives repeat discard", count === 1, `${count}`);
}

// ============================================================ 9. large source E2E + timing
console.log("\n[9] large multi-chunk source end to end (the 60s-timeout case)");
{
  const p = await mkPacket("legacy"); await mkSection(p.id);
  const t0 = performance.now();
  const { data: runId, error } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: p.id, p_entry_point: "append", p_target_section_id: null,
    p_source_text: BIG, p_source_hash: segmentHash(BIG), p_source_len: BIG.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: BIG_CHUNKS,
  });
  check("large run created", !error && !!runId, fin(error));

  // Each chunk is an independent claim->stage round trip: this is what keeps any
  // SINGLE serverless invocation well under the 60s ceiling.
  let worst = 0;
  for (const c of BIG_CHUNKS) {
    const t1 = performance.now();
    const { data: cl, error: ce } = await svc.rpc("claim_chunk", { p_run_id: runId, p_owner: UID, p_ordinal: c.ordinal, p_lease_seconds: 90 });
    if (ce || !cl?.claimed) { check(`claim ordinal ${c.ordinal}`, false, fin(ce) || JSON.stringify(cl)); continue; }
    const { error: se } = await svc.rpc("stage_chunk_result", {
      p_run_id: runId, p_owner: UID, p_ordinal: c.ordinal, p_attempt: cl.attempt,
      p_segment_hash: c.segment_hash, p_result: RESULT,
    });
    if (se) check(`stage ordinal ${c.ordinal}`, false, fin(se));
    worst = Math.max(worst, performance.now() - t1);
  }
  const tFin = performance.now();
  const { error: fe } = await svc.rpc("finalize_ingestion_run", { p_run_id: runId, p_owner: UID });
  const finMs = performance.now() - tFin;
  const totalMs = performance.now() - t0;
  check("large run finalized", !fe, fin(fe));

  const { items, secs } = await itemsOf(p.id);
  check("every chunk contributed a section", secs.length === 1 + BIG_CHUNKS.length, `${secs.length} vs ${1 + BIG_CHUNKS.length}`);
  check("every chunk contributed an item", items.length === BIG_CHUNKS.length, `${items.length} vs ${BIG_CHUNKS.length}`);

  console.log(`    source=${BIG.length} chars, chunks=${BIG_CHUNKS.length}`);
  console.log(`    worst per-chunk round trip = ${worst.toFixed(1)}ms  (serverless budget 60000ms)`);
  console.log(`    finalize = ${finMs.toFixed(1)}ms   whole run (DB work only) = ${totalMs.toFixed(1)}ms`);
  check("worst per-chunk DB round trip is far under the 60s ceiling", worst < 5000, `${worst.toFixed(1)}ms`);
  check("finalize of a multi-chunk run is a single fast transaction", finMs < 10000, `${finMs.toFixed(1)}ms`);
}

} catch (e: any) {
  failed = true;
  console.error("\nHARNESS ERROR:", e?.message ?? e);
}

// ============================================================ timings
console.log("\n[timing] per-RPC latency (ms)");
for (const [k, v] of Object.entries(timings)) {
  const s = [...v].sort((a, b) => a - b);
  console.log(`  ${k.padEnd(24)} n=${String(v.length).padEnd(4)} p50=${s[Math.floor(s.length/2)].toFixed(1).padStart(7)}  max=${s[s.length-1].toFixed(1).padStart(7)}`);
}

writeFileSync(new URL("./uid.txt", import.meta.url), UID);
console.log(`\nDisposable user retained for cleanup step: ${UID}`);
process.exit(summary("RUNTIME SUITE") > 0 || failed ? 1 : 0);
