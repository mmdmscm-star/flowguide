// BOUNDED RELIABILITY RUN over the ORDINARY paste path.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=http://localhost:3000 \
//     npx tsx scripts/reliability/paste-path.mts
//
// Drives the same routes the editor drives — organize, then each chunk, then
// finalize — against one disposable user, and records what came out. It ASSERTS
// almost nothing: the job is to produce raw results and let a failure class
// show itself, not to encode today's behaviour as correct.
//
// `expected` per input is one careful human's reading of the source. Drift from
// it is a signal to look at, not a verdict.
import { svc, errText } from "../ingestion-runtime/lib.mts";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { recordEnvelopes } from "../../src/lib/attribution.ts";
import { writeFileSync } from "node:fs";
const { INPUTS } = await import("./inputs.mjs");

const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
const TAG = "flowguide-rel-" + process.pid;
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
// HINTED arm: send the delimiter a .csv/.tsv file would have declared, exactly
// as the file picker does. Off by default so the pasted path is measured as a
// professional pasting actually experiences it.
const USE_HINT = process.env.HINT === "1";

const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({
  user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
const COOKIE = `flowguide_session=${token}`;
await svc.from("professional_profiles").insert({
  user_id: UID, name: "Dana Whitfield", phone: "(206) 555-0100" });

const api = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init,
    headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) } });
  const text = await r.text();
  let data: any = null; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: r.status, data };
};

type Row = Record<string, unknown>;
const rows: Row[] = [];

for (const input of INPUTS) {
  if (ONLY && !ONLY.includes(input.id)) continue;
  const t0 = performance.now();
  const row: Row = { id: input.id, chars: input.text.length, expectedItems: input.expect.items };
  process.stdout.write(`\n${input.id}  (${input.text.length} chars) … `);

  const org = await api("/api/ingest/organize", {
    method: "POST",
    body: JSON.stringify({
      rawText: input.text, packetType: "general", requestKey: `${TAG}-${input.id}`,
      ...(USE_HINT && input.hint ? { delimiterHint: input.hint } : {}),
    }),
  });
  row.organizeStatus = org.status;
  if (org.status !== 201) {
    row.outcome = "organize_failed";
    row.error = JSON.stringify(org.data).slice(0, 200);
    rows.push(row); process.stdout.write(`ORGANIZE FAILED ${org.status}`); continue;
  }
  const { packetId, runId, totalChunks } = org.data;
  row.packetId = packetId; row.chunks = totalChunks;
  row.hintSent = Boolean(USE_HINT && input.hint);
  // Did the hint actually reach the database? Provenance for a later
  // verification is the reason it is stored at all.
  {
    const { data: r } = await svc.from("ingestion_runs").select("delimiter_hint").eq("id", runId).single();
    row.hintPersisted = (r as { delimiter_hint: string | null } | null)?.delimiter_hint ?? null;
  }

  // Drive exactly as the editor does: process pending chunks, then finalize.
  let outcome = "unknown";
  for (let step = 0; step < 200; step++) {
    const st = await api(`/api/ingest/${runId}`);
    if (!st.data?.run) { outcome = "run_lost"; break; }
    const run = st.data.run, chunks = (st.data.chunks ?? []) as any[];
    if (run.status === "finalized") { outcome = "finalized"; break; }
    if (run.status === "discarded") { outcome = "discarded"; break; }
    if (run.status === "needs_review") {
      outcome = "needs_review";
      row.reviewSummary = String(run.review?.summary ?? "").slice(0, 200);
      break;
    }
    const next = chunks.find((c) => c.status === "pending" || c.status === "failed");
    if (next) {
      const res = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" });
      row[`chunk${next.ordinal}Status`] = res.status;
      if (res.status >= 500) { row.chunkError = JSON.stringify(res.data).slice(0, 200); }
      continue;
    }
    const fin = await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
    row.finalizeStatus = fin.status;
    if (fin.status >= 400) { row.finalizeError = JSON.stringify(fin.data).slice(0, 240); outcome = "finalize_failed"; break; }
  }
  row.outcome = outcome;

  // What actually landed in the packet.
  const { data: secs } = await svc.from("sections").select("id, title").eq("packet_id", packetId);
  const sids = (secs ?? []).map((s: any) => s.id);
  const { data: items } = sids.length
    ? await svc.from("items").select("id, title, description, address").in("section_id", sids)
    : { data: [] as any[] };
  const iids = (items ?? []).map((i: any) => i.id);
  const [dets, lnks, cons] = iids.length ? await Promise.all([
    // VALUES, not just ids: the omission check compares source facts against
    // what actually landed, and an id column proves nothing about a phone
    // number. Selecting only item_id here made every fact look missing.
    svc.from("item_details").select("item_id, label, value").in("item_id", iids),
    svc.from("item_links").select("item_id, url, label").in("item_id", iids),
    svc.from("item_contacts").select("item_id, name, role, phone, email, website").in("item_id", iids),
  ]) : [{ data: [] }, { data: [] }, { data: [] }] as any;

  row.sections = (secs ?? []).length;
  row.items = (items ?? []).length;
  row.untitledItems = (items ?? []).filter((i: any) => !String(i.title ?? "").trim()).length;
  row.itemsNoDescription = (items ?? []).filter((i: any) => !String(i.description ?? "").trim()).length;
  row.details = (dets.data ?? []).length;
  row.links = (lnks.data ?? []).length;
  row.contacts = (cons.data ?? []).length;
  row.itemTitles = (items ?? []).map((i: any) => i.title);
  row.ms = Math.round(performance.now() - t0);

  // ---- what the contract actually did, read back off the chunks -----------
  {
    const { data: chunks } = await svc.from("ingestion_chunks")
      .select("fact_ledger").eq("run_id", runId);
    const tel = (chunks ?? []).map((c: any) => c?.fact_ledger?.enforcement).filter(Boolean);
    const sum = (k: string) => tel.reduce((n: number, t: any) => n + Number(t?.[k] ?? 0), 0);
    row.enforcementRan = tel.length > 0;
    row.scope = tel[0]?.scope ?? null;
    row.itemsGoverned = sum("itemsGoverned");
    row.accepted = sum("accepted");
    row.repaired = sum("repaired");
    row.stripped = sum("stripped");
    row.sourceUnresolved = sum("sourceUnresolved");
    row.attributionUnresolved = sum("attributionUnresolved");
  }

  // ---- SILENT OMISSIONS, measured directly ---------------------------------
  // Every high-identity fact the parser can name in the source, checked against
  // the whole finished packet. A fact that is nowhere in the draft and nowhere
  // in the telemetry is exactly the silent disappearance we are trying to end.
  {
    const parsed: any = parseClaims(input.text, 0);
    const claims = (parsed.claims ?? []) as { kind: string; value: string }[];
    const hay = JSON.stringify({ items, dets: dets.data, lnks: lnks.data, cons: cons.data, secs });
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9@.]/g, "");
    const haystack = norm(hay);
    const missing = claims.filter((c) => {
      const v = norm(c.value);
      if (!v) return false;
      // Phones are reformatted on purpose; compare digits only.
      if (c.kind === "phone") return !haystack.includes(v.replace(/[^0-9]/g, ""));
      // A bare hostname may be stored with a scheme and a trailing slash.
      if (c.kind === "url") return !haystack.includes(v.replace(/^https?/, "").replace(/\/$/, ""));
      return !haystack.includes(v);
    });
    row.claims = claims.length;
    row.claimsMissing = missing.length;
    row.missingValues = missing.map((m) => `${m.kind}:${m.value.trim().slice(0, 40)}`);
    row.recordsDetected = (recordEnvelopes(input.text, USE_HINT && input.hint ? input.hint : undefined) ?? []).length;
  }

  // Can it actually be published? An import that finishes but cannot ship is
  // still a failed creation attempt from the professional's side.
  const pub = await api(`/api/packets/${packetId}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish" }) });
  row.publishStatus = pub.status;
  if (pub.status >= 400) row.publishError = JSON.stringify(pub.data).slice(0, 200);

  rows.push(row);
  process.stdout.write(`${outcome}  items=${row.items}/${row.expectedItems}  publish=${row.publishStatus}  ${row.ms}ms`);
}

const out = "/private/tmp/claude-501/-Users-matthewmaurer-Desktop-vibe-coded-magic-OH-YAHHHHHH-FlowGuide/857c008a-9324-4785-b8f5-e7172459fba5/scratchpad/reliability.json";
writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`\n\nraw results -> ${out}`);

// Cleanup.
await svc.from("packets").delete().eq("user_id", UID);
await svc.from("professional_profiles").delete().eq("user_id", UID);
await svc.from("sessions").delete().eq("user_id", UID);
await svc.from("users").delete().eq("id", UID);
const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
console.log(`cleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
