// POST-DEPLOYMENT PRODUCTION SMOKE TEST.
//
// Runs the real product flows against the deployed production app with synthetic
// disposable data only. NO fault injection is used or possible here: production
// has no FLOWGUIDE_TEST_FAULT_FILE and NODE_ENV=production, and the call site is
// dead-code eliminated from the production bundle.
//
// Containment is identical to the local harness: one disposable user, removed by
// FK cascade in cleanup.mts.
import { api, drive, packetContent, newMetrics, bump, organize,
         TAG, makeSource, check, summary, svc, errText, modelCalls } from "./e2e.mts";
import { root } from "./lib.mts";
const { buildRunChunks } = await import(`${root}/src/lib/ingestion.ts`);

const evidence: Record<string, unknown> = {};
const timings: Array<{ label: string; chunks: number; slowestMs: number; totalMs: number }> = [];
function note(label: string, m: { initialChunks: number; chunkMs: number[]; totalMs: number }) {
  const slow = Math.max(0, ...m.chunkMs);
  timings.push({ label, chunks: m.initialChunks, slowestMs: slow, totalMs: m.totalMs });
  console.log(`    chunks=${m.initialChunks}  slowest=${(slow / 1000).toFixed(2)}s  total=${(m.totalMs / 1000).toFixed(1)}s`);
}

// ------------------------------------------------- 1. one-chunk Organize
console.log("[1] small Organize completes through the ONE-CHUNK path");
{
  const src = makeSource(2);
  check("fixture plans to exactly one chunk", buildRunChunks(src).length === 1, `${buildRunChunks(src).length}`);
  const r = await organize("prod-small", src);
  check("run finalized", r.outcome === "finalized", String(r.outcome));
  check("was a single-chunk run", r.m.initialChunks === 1, `${r.m.initialChunks}`);
  note("small (1 chunk)", r.m);
  const c = await packetContent(r.packetId!);
  check("produced items", c.items.length >= 2, `${c.items.length}`);
  evidence.small = { chunks: r.m.initialChunks, items: c.items.length, packetId: r.packetId };
}

// ------------------------------------------------- 2. multi-chunk Organize
console.log("\n[2] larger Organize uses MULTIPLE chunks with persisted progress");
{
  const src = makeSource(24);
  const planned = buildRunChunks(src).length;
  check("fixture plans to multiple chunks", planned >= 3, `${planned}`);

  const m = newMetrics("prod-multi", src.length);
  const start = await api(`/api/ingest/organize`, {
    method: "POST",
    body: JSON.stringify({ rawText: src, packetType: "senior_living", requestKey: `${TAG}-prod-multi` }),
  });
  bump(m, start.status);
  check("organize accepted (201)", start.status === 201, `${start.status}`);
  const runId = start.data.runId, packetId = start.data.packetId;
  m.initialChunks = start.data.totalChunks;
  check("server planned the same chunk count as the client", start.data.totalChunks === planned, `${start.data.totalChunks} vs ${planned}`);

  // Drive two chunks, then confirm progress is PERSISTED server-side (this is
  // what the editor's "part N of M" reads on reconnect).
  const st0 = await api(`/api/ingest/${runId}`);
  await api(`/api/ingest/${runId}/chunks/${st0.data.chunks[0].ordinal}`, { method: "POST" });
  const mid = await api(`/api/ingest/${runId}`);
  const doneMid = mid.data.chunks.filter((c: { status: string }) => c.status === "completed").length;
  check("progress is persisted and readable mid-run", doneMid >= 1, `${doneMid}/${mid.data.run.totalChunks} completed`);
  check("run still active mid-flight", mid.data.run.status === "active", mid.data.run.status);
  evidence.persistedProgress = { completedMidRun: doneMid, total: mid.data.run.totalChunks };

  // ---- 6. publishing must be blocked while this import is active.
  // The publish route requires {action:"publish"}; posting {} yields 400
  // "Invalid action", which would make this assertion pass for the WRONG reason.
  // Assert on the specific refusal, not merely on a 4xx.
  const pub = await api(`/api/packets/${packetId}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  const pubMsg = JSON.stringify(pub.data);
  check("[6] publishing BLOCKED while an import is active", pub.status >= 400, `${pub.status} ${pubMsg.slice(0, 110)}`);
  check("[6] refusal cites the import, not a malformed request",
    /import/i.test(pubMsg) && !/invalid action/i.test(pubMsg), `${pub.status} ${pubMsg.slice(0, 140)}`);
  evidence.publishBlocked = { status: pub.status, message: pub.data?.error ?? pub.data?.message };

  const out = await drive(runId, m);
  check("multi-chunk run finalized", out.outcome === "finalized", String(out.outcome));
  note(`multi (${planned} chunks)`, m);
  const c = await packetContent(packetId);
  check("all chunks contributed content", c.items.length >= 20, `${c.items.length} items`);
  const titles = c.items.map((i: { title: string }) => i.title.trim().toLowerCase());
  check("no duplicated items", new Set(titles).size === titles.length, `${titles.length} vs ${new Set(titles).size}`);
  evidence.multi = { chunks: planned, items: c.items.length, sections: c.secs.length, packetId };
  (evidence as Record<string, unknown>).multiPacketId = packetId;
}

// ------------------------------------------------- 3. general Add with AI
console.log("\n[3] general 'Add with AI' on a legacy draft");
{
  const base = await organize("prod-append-base", makeSource(3));
  check("base packet ready", base.outcome === "finalized", String(base.outcome));
  const before = await packetContent(base.packetId!);

  const m = newMetrics("prod-append", 0);
  const add = makeSource(4);
  const start = await api(`/api/packets/${base.packetId}/ingest`, {
    method: "POST", body: JSON.stringify({ entryPoint: "append", rawText: add }),
  });
  bump(m, start.status);
  check("append accepted (201)", start.status === 201, `${start.status} ${JSON.stringify(start.data).slice(0, 110)}`);
  m.initialChunks = start.data.totalChunks;
  const out = await drive(start.data.runId, m);
  check("append finalized", out.outcome === "finalized", String(out.outcome));
  note("append", m);
  const after = await packetContent(base.packetId!);
  check("added new items", after.items.length > before.items.length, `${before.items.length} -> ${after.items.length}`);
  check("pre-existing items preserved", before.items.every((b: { id: string }) => after.items.some((a: { id: string }) => a.id === b.id)), "some lost");
  evidence.append = { before: before.items.length, after: after.items.length };
}

// ------------------------------------------------- 4. section-level Add items
console.log("\n[4] section-level 'Add items with AI' on a legacy draft");
{
  const base = await organize("prod-secappend-base", makeSource(3));
  check("base packet ready", base.outcome === "finalized", String(base.outcome));
  const before = await packetContent(base.packetId!);
  const target = before.secs[0];

  const m = newMetrics("prod-section", 0);
  const start = await api(`/api/packets/${base.packetId}/ingest`, {
    method: "POST",
    body: JSON.stringify({ entryPoint: "section_append", rawText: makeSource(3), targetSectionId: target.id }),
  });
  bump(m, start.status);
  check("section_append accepted (201)", start.status === 201, `${start.status} ${JSON.stringify(start.data).slice(0, 110)}`);
  m.initialChunks = start.data.totalChunks;
  const out = await drive(start.data.runId, m);
  check("section_append finalized", out.outcome === "finalized", String(out.outcome));
  note("section_append", m);
  const after = await packetContent(base.packetId!);
  check("created NO new sections", after.secs.length === before.secs.length, `${before.secs.length} -> ${after.secs.length}`);
  const added = after.items.filter((a: { id: string }) => !before.items.some((b: { id: string }) => b.id === a.id));
  check("every new item landed in the target section", added.length > 0 && added.every((a: { section_id: string }) => a.section_id === target.id), `${added.length} added`);
  evidence.sectionAppend = { added: added.length, sections: after.secs.length };

  // --------------------------------------------- 5. block mode stays rejected
  console.log("\n[5] block-mode append/section_append remain unavailable");
  const conv = await svc.rpc("convert_packet_to_blocks", { p_packet_id: base.packetId });
  check("test packet converted to blocks", !conv.error, errText(conv.error));
  const mode = (await svc.from("packets").select("composition_mode").eq("id", base.packetId).single()).data;
  check("packet really is in blocks mode", mode?.composition_mode === "blocks", String(mode?.composition_mode));
  for (const [ep, body] of [
    ["append", { entryPoint: "append", rawText: makeSource(2) }],
    ["section_append", { entryPoint: "section_append", rawText: makeSource(2), targetSectionId: target.id }],
  ] as const) {
    const r = await api(`/api/packets/${base.packetId}/ingest`, { method: "POST", body: JSON.stringify(body) });
    check(`[5] ${ep} on a BLOCK packet is rejected`, r.status >= 400, `${r.status} ${JSON.stringify(r.data).slice(0, 110)}`);
    check(`[5] ${ep} rejection names the reason`, /composition|block/i.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 110));
  }
  const runsForBlock = await svc.from("ingestion_runs").select("id").eq("packet_id", base.packetId!);
  check("[5] no run row created for the rejected block attempts", (runsForBlock.data ?? []).length === 0, `${(runsForBlock.data ?? []).length}`);
  evidence.blockRejected = true;
}

// ------------------------------------------------- 7. editor + recipient view
console.log("\n[7] the finished packet opens in the editor and the recipient view");
{
  const packetId = evidence.multiPacketId as string;
  const ed = await api(`/edit/${packetId}`);
  check("editor route loads for the owner", ed.status === 200 || ed.status === 0, `${ed.status}`);

  // Publish it (import is finished now) and fetch the public recipient page.
  const pub = await api(`/api/packets/${packetId}/publish`, { method: "POST", body: JSON.stringify({}) });
  check("publishing succeeds once the import is finished", pub.status === 200, `${pub.status} ${JSON.stringify(pub.data).slice(0, 120)}`);
  const slug = (await svc.from("packets").select("slug, status").eq("id", packetId).single()).data;
  check("packet is published", slug?.status === "published", String(slug?.status));

  const base = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
  const r = await fetch(`${base}/p/${slug?.slug}`);
  const html = await r.text();
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  check("recipient view returns 200", r.status === 200, `${r.status}`);
  check("recipient view renders the imported content", text.length > 500, `${text.length} chars`);
  const c = await packetContent(packetId);
  const firstTitle = c.items[0]?.title ?? "";
  check("a known imported item appears in the recipient view", firstTitle.length > 0 && text.includes(firstTitle), `looking for "${firstTitle}"`);
  evidence.recipient = { slug: slug?.slug, chars: text.length, items: c.items.length };
}

console.log("\n=== PRODUCTION CHUNK TIMING ===");
for (const t of timings) {
  console.log(`  ${t.label.padEnd(22)} chunks=${String(t.chunks).padEnd(3)} slowest=${(t.slowestMs / 1000).toFixed(2)}s  total=${(t.totalMs / 1000).toFixed(1)}s`);
}
const slowest = Math.max(0, ...timings.map((t) => t.slowestMs));
console.log(`  SLOWEST PRODUCTION CHUNK: ${(slowest / 1000).toFixed(2)}s of the 60s ceiling (${(60000 / Math.max(slowest, 1)).toFixed(1)}x headroom)`);
check("no production chunk approached the 60s ceiling", slowest <= 30000, `${(slowest / 1000).toFixed(1)}s`);
console.log(`  real model calls billed: ${modelCalls()}`);

console.log("\n" + JSON.stringify(evidence, null, 1));
process.exit(summary("PRODUCTION SMOKE") > 0 ? 1 : 0);
