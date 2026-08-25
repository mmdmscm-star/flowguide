// How OFTEN does a scheme-less URL survive ingestion? One input, repeated, so
// the answer is a rate rather than an anecdote.
import { svc, errText } from "../ingestion-runtime/lib.mts";
const { INPUTS } = await import("./inputs.mjs");
const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
const REPEAT = Number(process.env.REPEAT ?? 3);
const TAG = "flowguide-urlrate-" + process.pid;

const { data: user, error } = await svc.from("users")
  .insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (error) { console.error(errText(error)); process.exit(1); }
const UID = (user as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now()+864e5).toISOString() });
const COOKIE = `flowguide_session=${token}`;
const api = async (p: string, i: RequestInit = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...i, headers: { "Content-Type":"application/json", Cookie: COOKIE, ...(i.headers||{}) } });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const tally: Record<string, { kept: number; runs: number }> = {};
try {
  for (const id of ["02-bulleted-notes", "03-numbered-prose", "07-mixed-headings"]) {
    const input = INPUTS.find((i: any) => i.id === id)!;
    const domain = (input.text.match(/[a-z0-9-]+\.example\.com/) || [])[0];
    tally[id] = { kept: 0, runs: 0 };
    for (let n = 0; n < REPEAT; n++) {
      const org = await api("/api/ingest/organize", { method: "POST",
        body: JSON.stringify({ rawText: input.text, packetType: "general", requestKey: `${TAG}-${id}-${n}` }) });
      if (org.status !== 201) { console.log(`  ${id} run ${n}: organize ${org.status}`); continue; }
      const { packetId, runId } = org.data;
      for (let s = 0; s < 100; s++) {
        const st = await api(`/api/ingest/${runId}`);
        const run = st.data?.run; if (!run || run.status === "finalized" || run.status === "discarded") break;
        const next = (st.data.chunks ?? []).find((c: any) => c.status === "pending" || c.status === "failed");
        if (next) { await api(`/api/ingest/${runId}/chunks/${next.ordinal}`, { method: "POST" }); continue; }
        await api(`/api/ingest/${runId}/finalize`, { method: "POST" });
      }
      const { data: secs } = await svc.from("sections").select("id").eq("packet_id", packetId);
      const sids = (secs ?? []).map((s: any) => s.id);
      const { data: items } = await svc.from("items").select("id").in("section_id", sids);
      const iids = (items ?? []).map((i: any) => i.id);
      const { data: lnk } = await svc.from("item_links").select("url").in("item_id", iids);
      const kept = (lnk ?? []).some((l: any) => String(l.url).includes(domain));
      tally[id].runs++; if (kept) tally[id].kept++;
      process.stdout.write(kept ? "✔" : "✖");
    }
    console.log(`  ${id}  "${domain}"  kept ${tally[id].kept}/${tally[id].runs}`);
  }
  const kept = Object.values(tally).reduce((a, t) => a + t.kept, 0);
  const runs = Object.values(tally).reduce((a, t) => a + t.runs, 0);
  console.log(`\nSCHEME-LESS URL SURVIVAL: ${kept}/${runs} (${runs ? Math.round(kept/runs*100) : 0}%)  — base ${BASE}`);
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  console.log("cleanup: done");
}
