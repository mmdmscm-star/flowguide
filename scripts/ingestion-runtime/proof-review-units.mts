// THE DELIBERATE PRIVACY-REJECTION CONTROL.
//
// One held piece of prose, followed all the way through:
//
//   rejected -> held (not placed, not deleted) -> persisted with a stable id
//   -> survives a reload -> resolved / ignored -> excerpt stripped
//   -> last unit lifts the publish block -> publishing works
//
// WHAT EACH PHASE PROVES, AND WHAT IT DOES NOT
//
// Phase 1 runs the real enforcement chain in-process on a model result that
// routes prose into `notes` with no privacy authority in the source. It proves
// the rejection and the holding. It does NOT prove the model does that on any
// given day - that is the flagged-enforcement proof's job, and it already
// measured it.
//
// Phase 2 drives the real finalize route, the real RPC, the real resolve route
// and the real publish gate against a disposable packet whose chunk ledger
// carries the units phase 1 produces. The model is not in the loop, on purpose:
// a proof of the persistence and resolution path must not be able to fail
// because a provider had an off day.
import { svc, check, summary, errText } from "./lib.mts";
import { enforceChunkResult } from "../../src/lib/enforce-chunk.ts";
import { unresolvedCount, isResolvable } from "../../src/lib/review-units.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const TAG = "flowguide-review-" + process.pid;

// No privacy label anywhere. "Private" never appears; nothing here grants the
// authority to hide anything from a recipient.
// Three records, because a record envelope is a STRUCTURAL finding: a single
// entry has no repeated shape to detect, and without an envelope no claim can
// be bound to an item at all. Each carries its own unique anchor.
const SOURCE = [
  "1. Harbor House",
  "Address: 41 Harbor Way, Seattle WA",
  "Phone: (206) 555-0142",
  "harborhouse.com",
  "They are wonderful with memory care and the director will meet families on weekends.",
  "",
  "2. Cedar Ridge",
  "Address: 8 Cedar Ridge Rd, Tacoma WA",
  "Phone: (253) 555-0199",
  "cedarridgeliving.com",
  "",
  "The staff go out of their way for families who visit after hours.",
  "",
  "3. Lakeview Commons",
  "Address: 700 Lakeview Ave, Everett WA",
  "Phone: (425) 555-0177",
  "lakeviewcommons.com",
].join("\n");

// What a model actually did, repeatedly, in the diagnostics: recipient-intended
// prose routed into the private field.
const MODEL_RESULT = {
  sections: [{
    title: "Communities",
    items: [
      {
        title: "Harbor House",
        description: "A senior community in Seattle.",
        details: [{ label: "Phone", value: "(206) 555-0142" }],
        notes: "They are wonderful with memory care and the director will meet families on weekends.",
        links: [{ label: "Website", url: "https://harborhouse.com" }],
      },
      {
        title: "Cedar Ridge",
        description: "A senior community in Tacoma.",
        details: [{ label: "Phone", value: "(253) 555-0199" }],
        notes: "The staff go out of their way for families who visit after hours.",
        links: [{ label: "Website", url: "https://cedarridgeliving.com" }],
      },
      {
        title: "Lakeview Commons",
        description: "A senior community in Everett.",
        details: [{ label: "Phone", value: "(425) 555-0177" }],
        links: [{ label: "Website", url: "https://lakeviewcommons.com" }],
      },
    ],
  }],
};

const users: string[] = [];
const packets: string[] = [];
try {
  // ---------------------------------------------------------------- phase 1
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  const e = enforceChunkResult({
    segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0,
    sourceText: SOURCE, result: MODEL_RESULT,
  });
  const held = e.unresolved.filter((u) => u.kind === "privacy-rejected");
  check("enforcement REJECTS an unauthorized private placement", held.length === 2,
    `${held.length} held unit(s), telemetry privacyRejected=${e.telemetry.privacyRejected}`);
  // ABSENCE READS AS SUCCESS: with zero held units every later assertion in this
  // phase would pass while proving nothing at all.
  if (held.length !== 2) throw new Error("phase 1 held " + held.length + " units, expected 2 - nothing below would be tested");

  const item = (e.result as any).sections[0].items[0];
  check("the prose is NOT lost", held.some((h) => h.text.includes("memory care"))
    && held.some((h) => h.text.includes("after hours")), JSON.stringify(held.map((h) => h.text.slice(0, 30))));
  const items1 = (e.result as any).sections[0].items;
  check("the private field is cleared on every governed item",
    items1.every((i: any) => !i.notes), JSON.stringify(items1.map((i: any) => i.notes ?? null)));
  // Appending it to description would create exactly the narrative overflow
  // field we decided not to create, and would be FlowGuide choosing a
  // destination the professional never chose.
  check("it is NOT auto-placed into Description", !String(item.description).includes("memory care"),
    String(item.description).slice(0, 80));
  check("it is NOT auto-placed into Details",
    !JSON.stringify(item.details ?? []).includes("memory care"), JSON.stringify(item.details));

  // The SPLIT: review-required exceptions become questions; observed telemetry
  // does not. Both were produced by the same call.
  check("only review-required exceptions become review units",
    e.reviewUnits.length === 2 && e.unresolved.length >= e.reviewUnits.length,
    `${e.reviewUnits.length} review units of ${e.unresolved.length} unresolved`);
  check("the held unit carries a stable content-derived id",
    /^u_[0-9a-f]{16}$/.test(e.reviewUnits[0].id), e.reviewUnits[0].id);
  check("every review unit is classified, none unclassified",
    e.reviewUnits.every((u) => u.code === "privacy_rejected"),
    JSON.stringify(e.reviewUnits.map((u) => u.code)));

  // ---------------------------------------------------------------- phase 2
  const { data: u, error: uerr } = await svc.from("users")
    .insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
  if (uerr) throw new Error(errText(uerr));
  const uid = (u as { id: string }).id; users.push(uid);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: uid, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  const cookie = `flowguide_session=${token}`;
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) }, signal: AbortSignal.timeout(90_000) });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) as any };
  };

  const { data: p, error: perr } = await svc.from("packets")
    .insert({ user_id: uid, slug: `${TAG}-packet`, title: "Review Units Proof",
              status: "draft", raw_input: SOURCE, composition_mode: "legacy" })
    .select("id").single();
  if (perr) throw new Error(errText(perr));
  const PID = (p as { id: string }).id; packets.push(PID);

  // A run whose chunk ledger carries the held unit, exactly as the chunk route
  // writes it. Everything after this point is the real product path.
  // The run must be ACTIVE with a baseline matching the packet's current
  // content_rev - finalize refuses anything else, which is the 0012 guarantee
  // that an import cannot apply over a packet that changed underneath it.
  const { data: pk } = await svc.from("packets").select("content_rev").eq("id", PID).single();
  const { data: r0, error: rerr } = await svc.from("ingestion_runs").insert({
    user_id: uid, packet_id: PID, destination: "packet", entry_point: "organize",
    source_hash: "review-proof", source_text: SOURCE, source_len: SOURCE.length,
    segmenter_version: "proof", status: "active", total_chunks: 1, completed_chunks: 1,
    baseline_content_rev: (pk as any)?.content_rev ?? 0,
  }).select("id").single();
  if (rerr) throw new Error(errText(rerr));
  const RUN = (r0 as { id: string }).id;
  // Enforcement re-run with the REAL run id, so the units carry the ids the
  // product path would actually have assigned.
  const e2 = enforceChunkResult({
    segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0,
    sourceText: SOURCE, result: MODEL_RESULT, runId: RUN,
  });
  const { error: chErr } = await svc.from("ingestion_chunks").insert({
    run_id: RUN, ordinal: 0, status: "completed", attempt_count: 1,
    source_start: 0, source_end: SOURCE.length, segment_text: SOURCE,
    segment_hash: "review-proof-seg",
    // The ENFORCED result is what gets applied - the same object the chunk route
    // stages once enforcement has had its say. The items below are therefore
    // created by the real apply path, not pre-planted by this script.
    result: e.result,
    review_units: e2.reviewUnits,
    // A DECOY. The ledger carries a unit that exists nowhere else. If any of it
    // reaches the run's review, product behaviour is reading evidence again -
    // which is the boundary 0028 exists to restore, and no amount of source
    // scanning proves it as well as watching the value fail to arrive.
    fact_ledger: {
      unresolved: [...held, { record: 9, title: "Ledger Decoy", kind: "privacy-rejected",
                              text: "LEDGER-ONLY-DECOY-must-never-surface", reason: "decoy" }],
    },
  });
  if (chErr) throw new Error(`ingestion_chunks: ${errText(chErr)}`);

  const fin = await api(`/api/ingest/${RUN}/finalize`, { method: "POST", body: "{}" });
  check("finalize returns a review verdict", fin.data?.review !== undefined,
    JSON.stringify(fin.data).slice(0, 160));

  const runRow = async () => {
    const { data } = await svc.from("ingestion_runs")
      .select("status, review, finalized_at").eq("id", RUN).single();
    return data as { status: string; review: any; finalized_at: string | null };
  };
  // The prose must not have reached ANY item's stored content by any route -
  // not description, and not the private field it was rejected from.
  const { data: secRows } = await svc.from("sections").select("id").eq("packet_id", PID);
  const { data: itemRows } = await svc.from("items")
    .select("id, title, description, notes")
    .in("section_id", (secRows ?? []).map((r: any) => r.id));
  const rows = (itemRows ?? []) as Array<{ id: string; title: string; description: string; notes: string | null }>;
  check("the apply path created the items", rows.length === 3, `${rows.length} items`);
  const ITEM = rows.find((r) => r.title === "Harbor House")?.id;
  check("no item's stored content carries the held prose",
    rows.length === 3 && !JSON.stringify(rows).includes("memory care"),
    JSON.stringify(rows.map((r) => ({ t: r.title, n: r.notes }))).slice(0, 160));

  let run = await runRow();
  check("the run is held for review", run.status === "needs_review", run.status);
  const persisted = (run.review?.failures ?? []).filter(isResolvable);
  check("both held units are persisted on the run", persisted.length === 2, JSON.stringify(run.review).slice(0, 240));
  // THE 0028 BOUNDARY, proven by behaviour rather than by reading the source.
  check("the ledger-only decoy never reaches the run's review",
    !JSON.stringify(run.review).includes("LEDGER-ONLY-DECOY"),
    "a fact_ledger unit surfaced as a question");
  check("...each on its own record",
    persisted.map((f: any) => f.title).sort().join("|") === "Cedar Ridge|Harbor House",
    JSON.stringify(persisted.map((f: any) => f.title)));
  // ABSENCE READS AS SUCCESS: with no item created and no itemIds recorded,
  // `undefined === undefined` would report this as a pass while proving nothing.
  const harbor = persisted.find((f: any) => f.title === "Harbor House");
  check("...naming the correct item",
    !!ITEM && (harbor?.itemIds ?? [])[0] === ITEM,
    `item=${ITEM} itemIds=${JSON.stringify(harbor?.itemIds)}`);
  check("...with the verbatim excerpt a professional can read",
    String(harbor?.text ?? "").includes("memory care"), String(harbor?.text ?? "").slice(0, 60));
  check("...and its classified exception code", harbor?.code === "privacy_rejected", harbor?.code);

  const pub1 = await api(`/api/packets/${PID}/publish`, { method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }) });
  check("PUBLISHING IS BLOCKED while a unit is outstanding",
    !pub1.ok && pub1.data?.error === "import_needs_review", `${pub1.status} ${JSON.stringify(pub1.data).slice(0, 100)}`);

  // Reload: exactly what the panel re-reads after a refresh.
  const reload = await api(`/api/ingest/${RUN}`);
  const shown = (reload.data?.run?.review?.failures ?? []).filter(isResolvable);
  check("both units survive a reload, still readable",
    shown.length === 2 && shown.every((f: any) => String(f.text ?? "").length > 10),
    JSON.stringify(shown.map((f: any) => f.id)).slice(0, 160));
  const UNIT = (shown.find((f: any) => f.title === "Harbor House") ?? shown[0]).id as string;
  const LAST = (shown.find((f: any) => f.id !== UNIT) ?? {}).id as string;

  // Ownership: the RPC refuses a run that is not the caller's. The route never
  // takes an owner from the body, so this is the database's half of the promise.
  const { data: other } = await svc.from("users")
    .insert({ email: `${TAG}-other@disposable.invalid` }).select("id").single();
  users.push((other as any).id);
  const otherToken = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: (other as any).id, token: otherToken, expires_at: new Date(Date.now() + 864e5).toISOString() });
  const asOther = await fetch(`${BASE}/api/ingest/${RUN}/review/${UNIT}`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${otherToken}` },
    body: JSON.stringify({ status: "resolved" }),
  });
  check("another professional cannot resolve this unit", asOther.status === 409, String(asOther.status));

  const bad = await api(`/api/ingest/${RUN}/review/${UNIT}`, { method: "POST", body: JSON.stringify({ status: "deleted" }) });
  check("a status outside resolved|ignored is refused", bad.status === 400, String(bad.status));

  const ok1 = await api(`/api/ingest/${RUN}/review/${UNIT}`, { method: "POST", body: JSON.stringify({ status: "resolved" }) });
  check("the owner resolves the unit", ok1.ok && ok1.data.changed === true, JSON.stringify(ok1.data));

  run = await runRow();
  const after = (run.review?.failures ?? []).find((f: any) => f.id === UNIT);
  check("the verbatim excerpt is stripped once decided", after && after.text === undefined,
    JSON.stringify(after));
  check("...while the audit metadata remains",
    after?.status === "resolved" && !!after?.resolved_at && after?.code === "privacy_rejected",
    JSON.stringify(after));

  // ONE OF TWO. The run must NOT finalize here - premature release of the
  // publish block is the failure this whole slice exists to prevent.
  check("resolving one of two does not finalize the run", run.status === "needs_review", run.status);
  check("...and the OTHER unit keeps its excerpt",
    String((run.review?.failures ?? []).find((f: any) => f.id === LAST)?.text ?? "").includes("after hours"),
    JSON.stringify((run.review?.failures ?? []).find((f: any) => f.id === LAST)));

  // A second tab, acting on what it saw before the first decision landed.
  const stale = await api(`/api/ingest/${RUN}/review/${UNIT}`, { method: "POST", body: JSON.stringify({ status: "ignored" }) });
  check("a stale repeat cannot overwrite the decision",
    stale.ok && stale.data.changed === false, JSON.stringify(stale.data));
  run = await runRow();
  check("...and the original decision stands",
    (run.review?.failures ?? []).find((f: any) => f.id === UNIT)?.status === "resolved",
    JSON.stringify((run.review?.failures ?? []).find((f: any) => f.id === UNIT)?.status));

  // The LAST unit, ignored rather than resolved: both decisions must clear it.
  const ok2 = await api(`/api/ingest/${RUN}/review/${LAST}`, { method: "POST", body: JSON.stringify({ status: "ignored" }) });
  check("the last unit is ignored", ok2.ok && ok2.data.changed === true && ok2.data.remaining === 0,
    JSON.stringify(ok2.data));

  run = await runRow();
  check("the last unit cleared the run", run.status === "finalized", run.status);
  check("finalized_at is stamped", !!run.finalized_at, String(run.finalized_at));
  check("review.ok agrees with the run", run.review?.ok === true, JSON.stringify(run.review?.ok));
  check("the stale failure summary is cleared", run.review?.summary === "", JSON.stringify(run.review?.summary));
  check("nothing outstanding remains", unresolvedCount(run.review?.failures) === 0,
    String(unresolvedCount(run.review?.failures)));

  const pub2 = await api(`/api/packets/${PID}/publish`, { method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }) });
  check("PUBLISHING IS UNBLOCKED once every unit is decided", pub2.ok,
    `${pub2.status} ${JSON.stringify(pub2.data).slice(0, 120)}`);

  // The whole point: the recipient never receives the held prose.
  const { data: pubRow } = await svc.from("packets").select("slug").eq("id", PID).single();
  const slug = (pubRow as any)?.slug;
  if (slug) {
    const page = await fetch(`${BASE}/p/${slug}`);
    const html = await page.text();
    check("the recipient's page never carries the held prose", !html.includes("memory care"),
      `page ${page.status}, ${html.length} bytes`);
  } else {
    check("the recipient's page never carries the held prose", false, "no slug to fetch");
  }
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of users) {
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { count: leftUsers } = await svc.from("users")
    .select("id", { count: "exact", head: true }).like("email", `${TAG}%`);
  console.log(`\ncleanup: ${leftUsers ?? 0} users remaining`);
}
summary("privacy-rejection control");
