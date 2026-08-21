// FLAGGED ENFORCEMENT PROOF, bounded and disposable.
//
// A real packet import through the live route with FLOWGUIDE_ENFORCE_CONTRACT=1
// set for THIS server process only. Never enabled for customers. Proves the full
// trace survives finalization under 0026 retention:
//
//   source -> envelope -> claim -> segment -> raw model result
//          -> attribution -> reconciliation outcome -> final proposal
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";
import { recordEnvelopes } from "../../src/lib/attribution.ts";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { readFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
if (!process.env.FLOWGUIDE_RT_CONFIRM) { console.error("FLOWGUIDE_RT_CONFIRM=1 required"); process.exit(1); }
const TAG = "flowguide-flagged-" + process.pid;
// The recovered ice-cream shape: numbered directory, two-line labels, bare
// domains, and a recipient-intended paragraph per entry.
const SOURCE = readFileSync(process.env.SRC_FILE ?? "/tmp/flagged-source.txt", "utf8");

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

  const env = recordEnvelopes(SOURCE);
  check("SOURCE -> ENVELOPE: deterministic record envelopes", (env?.length ?? 0) >= 3, `${env?.length} envelopes`);
  const claims = parseClaims(SOURCE, 0);
  check("ENVELOPE -> CLAIM: websites recognized as URL claims",
    claims.claims.filter((c) => c.kind === "url").length >= 3,
    `${claims.claims.filter((c) => c.kind === "url").length} url claims`);

  const org = await api("/api/ingest/organize", { method: "POST", body: JSON.stringify({
    rawText: SOURCE, packetType: "general", requestKey: crypto.randomUUID() }) });
  check("a real packet import starts", org.status === 201, JSON.stringify(org.data).slice(0, 120));
  const RUN = org.data.runId as string;
  for (let g = 0; g < 60; g++) {
    const { data: st } = await api(`/api/ingest/${RUN}`);
    const next = ((st.chunks ?? []) as any[]).find((c) => c.status === "pending" || c.status === "failed");
    if (!next) break;
    const r = await api(`/api/ingest/${RUN}/chunks/${next.ordinal}`, { method: "POST" });
    const o = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
    if (o.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${o.message}`);
    if (o.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
  }
  const fin = await api(`/api/ingest/${RUN}/finalize`, { method: "POST", body: "{}" });
  check("it finalizes", fin.ok, JSON.stringify(fin.data).slice(0, 120));

  // ---- the trace, AFTER finalize, under 0026 retention --------------------
  const { data: rr } = await svc.from("ingestion_runs").select("source_text, evidence_purge_after, status").eq("id", RUN).single();
  const { data: cRows } = await svc.from("ingestion_chunks")
    .select("ordinal, status, segment_text, result, fact_ledger").eq("run_id", RUN).order("ordinal");
  const chunks = ((cRows ?? []) as any[]).filter((c) => c.status === "completed");
  check("SOURCE retained after finalize", (rr as any).source_text !== null, "");
  check("SEGMENT retained", chunks.every((c) => c.segment_text !== null), "");
  check("RAW MODEL RESULT retained", chunks.every((c) => c.result !== null), "");
  check("ATTRIBUTION + RECONCILIATION retained (accounting)", chunks.every((c) => c.fact_ledger?.accounting?.v === 1), "");
  check("ENFORCEMENT TELEMETRY recorded", chunks.every((c) => c.fact_ledger?.enforcement !== undefined), "");
  check("expiry stamped — bounded, not indefinite", (rr as any).evidence_purge_after !== null, "");

  const tel = chunks.reduce((t: any, c: any) => {
    const e = c.fact_ledger.enforcement ?? {};
    for (const k of Object.keys(e)) t[k] = (t[k] ?? 0) + e[k];
    return t;
  }, {});
  console.log(`      TELEMETRY: ${JSON.stringify(tel)}`);
  check("enforcement actually ran (flag on for this process)", (tel.itemsGoverned ?? 0) > 0,
    `itemsGoverned=${tel.itemsGoverned} — is FLOWGUIDE_ENFORCE_CONTRACT=1 set on the SERVER?`);

  // ---- FINAL PROPOSAL: the governed outcome the recipient would see -------
  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", org.data.packetId);
  const sids = (secs ?? []).map((s: any) => s.id);
  const { data: items } = await svc.from("items").select("id, title, notes, description").in("section_id", sids).order("sort_order");
  const iids = (items ?? []).map((i: any) => i.id);
  const { data: links } = iids.length ? await svc.from("item_links").select("item_id, url").in("item_id", iids) : { data: [] };
  const withLink = new Set((links ?? []).map((l: any) => l.item_id)).size;
  const notesLeft = (items ?? []).filter((i: any) => String(i.notes ?? "").trim()).length;

  check("WEBSITES restored to canonical Links", withLink === (items ?? []).length && withLink > 0,
    `${withLink}/${(items ?? []).length} items have a link`);
  const unresolved = chunks.flatMap((c: any) => c.fact_ledger?.unresolved ?? []);
  const pr = unresolved.filter((u: any) => u.kind === "privacy-rejected");
  // EITHER the model kept recipient prose out of notes (the prompt fix working),
  // OR it did not and every rejected unit was preserved with its record. What
  // must never happen is a note being emptied and its content vanishing.
  // Asserting pr.length > 0 would have required the model to misbehave.
  check("recipient prose is accounted for: kept out of notes, or preserved as unresolved",
    (notesLeft === 0 && pr.length === 0) || (pr.length > 0 && pr.every((u: any) => u.title)),
    `notesLeft=${notesLeft} privacyRejected=${pr.length}`);
  const source = readFileSync(process.env.SRC_FILE ?? "/tmp/flagged-source.txt", "utf8");
  const whys = (source.match(/Why it made the list:/g) ?? []).length;
  const survived = (items ?? []).filter((i: any) =>
    /why it made the list/i.test(`${i.description ?? ""} ${i.notes ?? ""}`)).length;
  check("every 'Why it made the list' paragraph survived somewhere recipient-visible",
    survived === whys, `${survived}/${whys} survived`);
  check("...and NOT appended to description",
    (items ?? []).every((i: any) => !pr.some((u: any) => String(i.description ?? "").includes(String(u.text).slice(0, 30)))),
    "prose leaked into description");
  check("every link is canonical https", (links ?? []).every((l: any) => /^https:\/\//.test(l.url)),
    (links ?? []).slice(0, 2).map((l: any) => l.url).join(" "));
  check("NO private note survives without source authority", notesLeft === 0, `${notesLeft} items still carry notes`);
  check("recipient-intended prose preserved, not deleted",
    (items ?? []).every((i: any) => String(i.description ?? "").trim().length > 0), "");

  summary("Flagged enforcement — packet path, bounded disposable run");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    await svc.from("ingestion_runs").delete().eq("user_id", id);
    for (const p of (ps ?? []) as { id: string }[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { data: left } = await svc.from("users").select("id").like("email", `${TAG}%`);
  console.log(`cleanup: ${(left ?? []).length} row(s) remaining — ${(left ?? []).length === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
