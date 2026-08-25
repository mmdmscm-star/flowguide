// IS THE FACT ACTUALLY GONE, OR ONLY THE PARSER'S RENDERING OF IT?
//
// The corpus reports a claim missing when its VERBATIM value is absent from the
// recipient page. For `labelled` claims that is often an artifact: the parser
// splits "Mon 9:00 — Kickoff, 90 min" at the colon into label "Mon 9" and value
// "00 — Kickoff, 90 min", and the string "00 — Kickoff" never existed as text.
// The packet can hold every underlying fact and still miss that concatenation.
//
// So this asks the only question that matters to a professional: are the
// CONSTITUENT facts on the page the client opens? Each probe below is a
// substring a reader would expect to see with their own eyes.
import { svc, errText } from "../ingestion-runtime/lib.mts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";
const { INPUTS } = await import("./inputs.mjs");

const PROBES: Record<string, string[]> = {
  "04-email-to-self": ["Ironline", "89", "Tia", "312", "555", "0119", "Yard", "75", "Summit", "140", "Basecamp", "95"],
  "10-with-dates-and-times": ["Kickoff", "90", "conference room B", "Systems walkthrough", "IT", "Shadow", "intake desk", "Compliance", "45", "Week one review", "Dana", "30"],
  "11-very-short": ["Willow Creek", "450", "7-12", "bus", "downtown", "Pinehurst", "380", "5-10"],
  "12-inconsistent-money": ["Apex Moving", "3,400", "Brightline", "2,950", "Sturdy", "4.1k", "Copperfield", "Northway"],
  "13-duplicate-mentions": ["Glenview", "18,400", "music", "22 min", "Hartwell", "21,000", "Beacon Prep", "16,900", "40 min", "bus route"],
};

const TAG = "flowguide-rel-" + process.pid;
const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error(errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
await svc.from("professional_profiles").insert({ user_id: UID, name: "Dana Whitfield", phone: "(206) 555-0100" });
const COOKIE = `flowguide_session=${token}`;
const api = async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) } });
  const t = await r.text(); let d: any = null; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 200) }; }
  return { status: r.status, data: d };
};

let totalGone = 0;
try {
  for (const input of INPUTS.filter((i: any) => PROBES[i.id])) {
    const org = await api("/api/ingest/organize", { method: "POST", body: JSON.stringify({
      rawText: input.text, packetType: "general", requestKey: `${TAG}-${input.id}` }) });
    if (org.status !== 201) { console.log(`${input.id}: organize ${org.status}`); continue; }
    const { packetId, runId } = org.data;
    for (let s = 0; s < 200; s++) {
      const st = await api(`/api/ingest/${runId}`);
      const run = st.data?.run; if (!run) break;
      if (["finalized", "discarded", "needs_review"].includes(run.status)) break;
      const next = (st.data.chunks ?? []).find((c: any) => c.status === "pending" || c.status === "failed");
      if (next) { await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" }); continue; }
      await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
    }
    await api(`/api/packets/${packetId}/publish`, { method: "POST", body: JSON.stringify({ action: "publish" }) });
    const { data: pk } = await svc.from("packets").select("slug").eq("id", packetId).single();
    const slug = (pk as { slug: string } | null)?.slug;
    if (!slug) { console.log(`${input.id}: not published`); continue; }
    const html = await (await fetch(`${BASE}/p/${slug}`)).text();
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).join(" ");
    const hay = (html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ") + " " + hrefs)
      .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
      .toLowerCase().replace(/[^a-z0-9@.]/g, "");
    const gone = PROBES[input.id].filter((p) => !hay.includes(p.toLowerCase().replace(/[^a-z0-9@.]/g, "")));
    totalGone += gone.length;
    console.log(`${input.id.padEnd(26)} ${PROBES[input.id].length - gone.length}/${PROBES[input.id].length} present` +
      (gone.length ? `   MISSING: ${JSON.stringify(gone)}` : ""));
  }
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("professional_profiles").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
console.log(`\nconstituent facts absent from the recipient page: ${totalGone}`);
