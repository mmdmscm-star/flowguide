import { svc } from "../scripts/ingestion-runtime/lib.mts";
const TAG = "flowguide-photoshape-" + process.pid;
const { data: u } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
const UID = (u as any).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now()+864e5).toISOString() });

// A run + proposal exactly as the import pipeline produces them. The model's
// contract (ingest-validate.ts:60) is photos: string[].
const run = await svc.rpc("create_library_import_run", {
  p_owner: UID, p_source_text: "x", p_source_hash: "h", p_source_len: 1, p_segmenter_version: "seg-v4",
  p_chunks: [{ ordinal: 0, source_start: 0, source_end: 1, segment_text: "x", segment_hash: "h", section_hint: "", is_continuation: false }],
});
const RUN = (run.data as any).run_id;
const { data: prop } = await svc.from("library_import_proposals").insert({
  run_id: RUN, ordinal: 0, idx: 0,
  payload: { title: "The Reserve at Fountaingrove",
             photos: ["https://example.com/reserve-1.jpg", "https://example.com/reserve-2.jpg"],
             links: [{ url: "https://reserve.example.com", label: "Website" }] },
}).select("id").single();

const saved = await svc.rpc("library_save_proposal", { p_owner: UID, p_run_id: RUN, p_proposal_id: (prop as any).id });
const LIB = saved.data as string;
const { data: row } = await svc.from("library_items").select("photos, links").eq("id", LIB).single();
console.log("stored photos:", JSON.stringify((row as any).photos));
console.log("stored links :", JSON.stringify((row as any).links));
const photos = (row as any).photos;
const areStrings = photos.every((p: unknown) => typeof p === "string");
console.log(areStrings ? "CONFIRMED: photos are STRINGS, but the app reads p.url" : "photos are objects");

// Replay exactly what the UI does.
const asItem = photos.map((p: any) => p.url);
console.log("snapshotToItem -> item.photos =", JSON.stringify(asItem));
try {
  asItem.map((u: any) => ({ url: u })).filter((p: any) => p.url.trim());
  console.log("handleSave filter: survived (unexpected)");
} catch (e) {
  console.log("handleSave filter THREW:", (e as Error).message);
  console.log(">>> This is the defect: the click handler rejects, so Save does nothing.");
}
console.log(JSON.stringify({ UID, token, LIB }));
