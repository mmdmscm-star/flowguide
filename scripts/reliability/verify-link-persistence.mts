// FULL-CHAIN REGRESSION for the demonstrated silent loss.
//
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/reliability/verify-link-persistence.mts
//
// source -> staged result -> enforcement -> FINALIZED PERSISTED PACKET.
//
// The earlier proof stopped at the model result and therefore proved nothing:
// the URL was present there and absent from item_links. This drives the real
// finalize RPC and asserts on the row that actually exists afterwards.
//
// NO MODEL CALLS. The staged result is written directly, so the chain under
// test is the persistence chain and nothing else — and it costs no API key.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
import { normalizeStagedLinks } from "../../src/lib/normalize-staged-links.ts";

const TAG = "flowguide-linkpersist-" + process.pid;
const SOURCE = `SHORTLIST

Riverbend Studio
$1,800/day. 3,000 sq ft, blackout capable, in-house grip.
riverbend.example.com | Booking: Nia Patel 646-555-0188
`;

const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error(errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;

/** What the model actually returned in production: the URL, unqualified. */
const modelResult = {
  sections: [{ title: "Shortlist", items: [{
    title: "Riverbend Studio",
    description: "3,000 sq ft, blackout capable, in-house grip.",
    details: [{ label: "Day rate", value: "$1,800/day" }],
    links: [
      { url: "riverbend.example.com", label: "Website" },        // the lost case
      { url: "https://already.example.com/page", label: "Existing" }, // must survive byte-identical
      { url: "javascript:alert(1)", label: "Hostile" },          // must never be stored
      { url: "notes.md", label: "A file" },                      // not a website
      { url: "pat@example.com", label: "An address" },           // not a website
    ],
    contacts: [{ name: "Nia Patel", role: "Booking", phone: "646-555-0188" }],
  }] }],
};

try {
  // FLOWGUIDE_MUTATE=1 stages the model result RAW, reproducing the bug. It
  // must make "THE BARE HOSTNAME IS PERSISTED" fail — a chain test that passes
  // with the fix removed is testing nothing.
  const staged = process.env.FLOWGUIDE_MUTATE
    ? modelResult
    : normalizeStagedLinks(modelResult);

  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: TAG, title: "Link Persistence", status: "draft",
    composition_mode: "legacy", raw_input: SOURCE,
  }).select("id").single();
  const PID = (p as { id: string }).id;

  const { data: r, error: rerr } = await svc.from("ingestion_runs").insert({
    user_id: UID, packet_id: PID, entry_point: "organize", source_text: SOURCE,
    source_hash: segmentHash(SOURCE), source_len: SOURCE.length,
    request_key: `${TAG}-key-000`, segmenter_version: SEGMENTER_VERSION,
    status: "active", total_chunks: 1, completed_chunks: 1, source_offset_base: 0,
    baseline_section_count: 0, baseline_item_count: 0, baseline_content_rev: 0,
  }).select("id").single();
  if (rerr) { console.error("run:", errText(rerr)); process.exit(1); }
  const RID = (r as { id: string }).id;

  const { error: cerr } = await svc.from("ingestion_chunks").insert({
    run_id: RID, ordinal: 0, source_start: 0, source_end: SOURCE.length,
    segment_text: SOURCE, segment_hash: segmentHash(SOURCE),
    status: "completed", result: staged, attempt_count: 1,
  });
  if (cerr) { console.error("chunk:", errText(cerr)); process.exit(1); }

  const { error: ferr } = await svc.rpc("finalize_ingestion_run", {
    p_run_id: RID, p_owner: UID,
  });
  check("finalize succeeds", !ferr, errText(ferr));

  // ---- the row that actually exists afterwards ----------------------------
  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", PID);
  const sids = (secs ?? []).map((s: { id: string }) => s.id);
  const { data: items } = await svc.from("items").select("id, title").in("section_id", sids);
  const iids = (items ?? []).map((i: { id: string }) => i.id);
  const { data: links } = await svc.from("item_links").select("url, label").in("item_id", iids);
  const urls = (links ?? []).map((l: { url: string }) => l.url);

  check("the item was created", (items ?? []).length === 1, JSON.stringify(items));
  check("THE BARE HOSTNAME IS PERSISTED, canonical",
    urls.includes("https://riverbend.example.com"), JSON.stringify(urls));
  check("an existing https URL is stored BYTE-IDENTICAL",
    urls.includes("https://already.example.com/page"), JSON.stringify(urls));
  check("javascript: is still refused",
    !urls.some((u) => /^javascript:/i.test(u)), JSON.stringify(urls));
  check("a filename is not stored as a website",
    !urls.some((u) => u.includes("notes.md")), JSON.stringify(urls));
  check("an email address is not stored as a website",
    !urls.some((u) => u.includes("pat@example.com")), JSON.stringify(urls));
  check("exactly the two storable links survive", urls.length === 2, JSON.stringify(urls));
  console.log(`\n  persisted: ${JSON.stringify(urls)}`);
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`cleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
summary("link persistence, source to persisted packet");
