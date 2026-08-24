// BOUNDED APPEND-PATH REGRESSION CHECK.
//
// sectionsPrompt() serves organize's non-lead chunks AND the `append` entry
// point. The offline measurement covered organize only, so this asks one
// question about append: does the lossless wording cause duplication, bloat or
// malformed output there? It is VERIFICATION, not an experiment - there is no
// arm to compare and nothing here will be tuned.
import { svc, check, summary, errText } from "./lib.mts";
import { classifyChunkResponse } from "../../src/lib/chunk-outcome.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const TAG = "flowguide-append-" + process.pid;

const FIRST = [
  "1. Alpha House", "Address: 1 Alpha Way, Seattle WA", "Phone: (206) 555-0101", "alphahouse.com",
  "", "2. Beta Place", "Address: 2 Beta Rd, Tacoma WA", "Phone: (253) 555-0102", "betaplace.com",
  "", "3. Gamma Court", "Address: 3 Gamma Ave, Everett WA", "Phone: (425) 555-0103", "gammacourt.com",
].join("\n");
// The appended batch. Two numbers on one record and a small enumeration - the
// shapes the lossless rules act on.
const SECOND = [
  "4. Delta Lodge", "Address: 4 Delta St, Olympia WA", "Main Phone: (360) 555-0104",
  "Cell Phone: (360) 555-0204", "deltalodge.com",
  "Rates: Studio $3,200, One Bedroom $4,100, Two Bedroom $5,400",
  "", "5. Epsilon Court", "Address: 5 Epsilon Ln, Bellevue WA", "Main Phone: (425) 555-0105",
  "Cell Phone: (425) 555-0205", "epsiloncourt.com",
  "Rates: Studio $3,600, One Bedroom $4,700",
].join("\n");

const users: string[] = [];
try {
  const { data: u, error } = await svc.from("users")
    .insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(errText(error));
  const uid = (u as { id: string }).id; users.push(uid);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: uid, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(180_000) });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) as any };
  };
  const drive = async (runId: string) => {
    for (let g = 0; g < 40; g++) {
      const { data: st } = await api(`/api/ingest/${runId}`);
      const next = ((st.chunks ?? []) as any[]).find((c) => c.status === "pending" || c.status === "failed");
      if (!next) return;
      const r = await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" });
      const o = classifyChunkResponse(r.status, r.ok, r.data as Record<string, unknown>);
      if (o.kind === "fatal") throw new Error(`chunk ${next.ordinal}: ${o.message}`);
      if (o.kind === "retry") await new Promise((res) => setTimeout(res, 6000));
    }
  };

  // ---- establish a packet with content, the ordinary way ------------------
  const org = await api("/api/ingest/organize", { method: "POST", body: JSON.stringify({
    rawText: FIRST, packetType: "general", requestKey: crypto.randomUUID() }) });
  check("an organize import starts", org.status === 201, JSON.stringify(org.data).slice(0, 120));
  if (org.status !== 201) throw new Error(`organize did not start: ${JSON.stringify(org.data)}`);
  const RUN1 = org.data.runId as string;
  await drive(RUN1);
  const fin1 = await api(`/api/ingest/${RUN1}/finalize`, { method: "POST", body: "{}" });
  check("the seed organize finalizes", !!fin1.data?.ok, JSON.stringify(fin1.data).slice(0, 200));
  const { data: r1, error: r1e } = await svc.from("ingestion_runs").select("packet_id").eq("id", RUN1).single();
  if (r1e) throw new Error(`run lookup: ${errText(r1e)}`);
  const PID = (r1 as any).packet_id as string;
  if (!PID) throw new Error("organize run has no packet_id");
  console.log(`   [packet ${PID}]`);

  // PostgREST RETURNS errors; swallowing them turns a broken query into "0
  // items" and then into a false regression finding.
  const itemsOf = async () => {
    const { data: secs, error: se } = await svc.from("sections").select("id").eq("packet_id", PID);
    if (se) throw new Error(`sections: ${errText(se)}`);
    const ids = ((secs ?? []) as any[]).map((s) => s.id);
    if (!ids.length) return [] as any[];
    const { data, error: ie } = await svc.from("items")
      .select("id, title, description, notes, address, item_details(label, value), item_links(url, label), item_contacts(name, role, phone, email, website), item_photos(url)")
      .in("section_id", ids);
    if (ie) throw new Error(`items: ${errText(ie)}`);
    return (data ?? []) as any[];
  };
  const before = await itemsOf();
  check("the packet has content to append to", before.length === 3, `${before.length} items`);

  // ---- APPEND, which is the path under check ------------------------------
  const app = await api(`/api/packets/${PID}/ingest`, { method: "POST", body: JSON.stringify({
    entryPoint: "append", rawText: SECOND }) });
  check("an append import starts", app.status === 201 || !!app.data?.runId,
    `${app.status} ${JSON.stringify(app.data).slice(0, 140)}`);
  const RUN2 = app.data.runId as string;
  await drive(RUN2);
  const fin = await api(`/api/ingest/${RUN2}/finalize`, { method: "POST", body: "{}" });
  check("the append finalizes", !!fin.data?.ok, JSON.stringify(fin.data).slice(0, 140));

  const { data: cs } = await svc.from("ingestion_chunks")
    .select("status, error, result").eq("run_id", RUN2).neq("status", "split");
  const chunks = (cs ?? []) as any[];
  check("no malformed or failed chunk on the append", chunks.every((c) => c.status === "completed" && !c.error),
    JSON.stringify(chunks.map((c) => [c.status, c.error])).slice(0, 160));

  const after = await itemsOf();
  const added = after.length - before.length;
  check("the append added the two new records and nothing else", added === 2, `${before.length} -> ${after.length}`);

  // DUPLICATION: the pre-existing items must not have been re-emitted.
  const titles = after.map((i) => String(i.title ?? ""));
  const dupTitles = titles.filter((t, i) => titles.indexOf(t) !== i);
  check("no duplicated items", dupTitles.length === 0, JSON.stringify(dupTitles));

  // BLOAT: the same value repeated into several destinations of one item.
  const spec = (t: string) => (t.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\$[\d,]+/g) ?? []);
  let repeated = 0;
  for (const it of after) {
    const counts = new Map<string, number>();
    for (const f of ["description", "item_details", "item_links", "notes", "address", "item_contacts"]) {
      for (const s of spec(JSON.stringify((it as any)[f] ?? ""))) {
        const k = s.replace(/\D/g, ""); counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    for (const v of counts.values()) if (v > 1) repeated++;
  }
  check("no value duplicated across destinations within an item", repeated === 0, `${repeated} repeats`);

  // The lossless rules SHOULD have kept both phones and all three rates.
  const delta = after.find((i) => String(i.title ?? "").includes("Delta"));
  const blob = JSON.stringify(delta ?? {});
  check("both phone numbers on the appended record survived",
    blob.includes("5550104") || (blob.includes("555-0104") && blob.includes("555-0204")),
    JSON.stringify(spec(blob)));
  check("the rate enumeration was not collapsed",
    ["3,200", "4,100", "5,400"].filter((r) => blob.includes(r)).length >= 2,
    JSON.stringify(spec(blob)));

  const { data: run2 } = await svc.from("ingestion_runs").select("status, review").eq("id", RUN2).single();
  check("the append run ended cleanly", (run2 as any)?.status === "finalized", (run2 as any)?.status);
} finally {
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    for (const p of (ps ?? []) as any[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { count } = await svc.from("users").select("id", { count: "exact", head: true }).like("email", `${TAG}%`);
  console.log(`\ncleanup: ${count ?? 0} users remaining`);
}
summary("append-path lossless regression");
