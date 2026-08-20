// READ ONLY. How far does the private-note exposure reach in real data?
// Reports COUNTS and lengths only — never note content.
import { svc, errText } from "./lib.mts";
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
const packets = await rows<{ id: string; status: string; user_id: string; viewed: boolean }>(
  "packets", svc.from("packets").select("id, status, user_id, viewed"));
const published = packets.filter((p) => p.status === "published");
const secs = await rows<{ id: string; packet_id: string }>("sections", svc.from("sections").select("id, packet_id"));
const items = await rows<{ id: string; section_id: string; notes: string | null }>(
  "items", svc.from("items").select("id, section_id, notes"));
const lib = await rows<{ id: string; notes: string | null }>("library", svc.from("library_items").select("id, notes"));

const secToPacket = new Map(secs.map((s) => [s.id, s.packet_id]));
const pubIds = new Set(published.map((p) => p.id));
const withNote = items.filter((i) => (i.notes ?? "").trim().length > 0);
const exposed = withNote.filter((i) => pubIds.has(secToPacket.get(i.section_id) ?? ""));
const exposedPackets = new Set(exposed.map((i) => secToPacket.get(i.section_id)!));
const viewedExposed = published.filter((p) => exposedPackets.has(p.id) && p.viewed);

console.log(`\nPRIVATE-NOTE EXPOSURE — real data, read only\n`);
console.log(`  packets ................................. ${packets.length}  (${published.length} published)`);
console.log(`  items carrying a note ................... ${withNote.length} of ${items.length}`);
console.log(`  ...of those, in a PUBLISHED FlowGuide ... ${exposed.length}`);
console.log(`  published FlowGuides exposing a note .... ${exposedPackets.size}`);
console.log(`  ...that a recipient has actually OPENED . ${viewedExposed.length}`);
console.log(`\n  Library entries carrying a "Private note" ${lib.filter((l) => (l.notes ?? "").trim()).length} of ${lib.length}`);
console.log(`  (a Library note is exposed only once inserted into a FlowGuide that is published)\n`);
