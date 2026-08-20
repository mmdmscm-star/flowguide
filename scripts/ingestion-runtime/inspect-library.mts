// READ ONLY. Characterises the surviving Library entries as HISTORICAL OUTPUTS.
//
// These are not source truth — they are what the importer produced. The point is
// to see the SHAPE of what came out: which fields got filled, which labels
// recur, and where facts landed that look like they belong somewhere else.
//
// It reads and it reports. It writes nothing, deletes nothing, and modifies
// nothing.
import { svc, errText } from "./lib.mts";
import { judge, isRecipientVisible, type Field } from "../../src/lib/placement.ts";

async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
type Entry = {
  id: string; title: string; address: string | null; description: string | null; notes: string | null;
  details: { label?: string; value?: string }[] | null;
  links: { url?: string; label?: string }[] | null;
  photos: unknown[] | null;
  contacts: { name?: string; role?: string; phone?: string; email?: string; website?: string }[] | null;
  created_at: string;
};
const all = await rows<Entry>("library", svc.from("library_items")
  .select("id, title, address, description, notes, details, links, photos, contacts, created_at")
  .order("created_at"));

const arr = (v: unknown[] | null) => (Array.isArray(v) ? v : []);
console.log(`\nSURVIVING LIBRARY ENTRIES — ${all.length}\n`);

// ---- field occupancy -------------------------------------------------------
const filled = (e: Entry): Record<Field, boolean> => ({
  title: !!e.title?.trim(), address: !!e.address?.trim(), description: !!e.description?.trim(),
  notes: !!e.notes?.trim(), details: arr(e.details).length > 0, links: arr(e.links).length > 0,
  photos: arr(e.photos).length > 0, contacts: arr(e.contacts).length > 0,
});
const FIELDS: Field[] = ["title", "address", "description", "notes", "details", "links", "photos", "contacts"];
console.log("  FIELD OCCUPANCY");
for (const f of FIELDS) {
  const n = all.filter((e) => filled(e)[f]).length;
  console.log(`    ${f.padEnd(12)} ${String(n).padStart(3)}/${all.length}  ${"█".repeat(Math.round(n / all.length * 28)).padEnd(28)} ${isRecipientVisible(f) ? "" : "  ← RECIPIENT NEVER SEES THIS"}`);
}

// ---- detail labels: the destination-consistency question -------------------
const labelCount = new Map<string, number>();
for (const e of all) for (const d of arr(e.details) as { label?: string }[])
  if (d?.label) labelCount.set(d.label.trim(), (labelCount.get(d.label.trim()) ?? 0) + 1);
const labels = [...labelCount.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n  DETAIL LABELS — ${labels.length} distinct across ${all.length} entries`);
console.log(`    used once only: ${labels.filter(([, n]) => n === 1).length} (${Math.round(labels.filter(([, n]) => n === 1).length / labels.length * 100)}%)`);
console.log(`    top labels:`);
for (const [l, n] of labels.slice(0, 14)) console.log(`      ${String(n).padStart(3)}×  ${l}`);

// ---- what is sitting in the now-private notes field ------------------------
const KV = /^\s*([A-Za-z][A-Za-z0-9 /&()'’.+-]{0,47}):\s*(\S.*)$/;
const MONEY = /\$\s?[\d,]+/;
const noted = all.filter((e) => (e.notes ?? "").trim());
let kvInNotes = 0, moneyInNotes = 0;
const kvLabels = new Map<string, number>();
for (const e of noted) {
  const lines = String(e.notes).split(/\n|(?<=[.;])\s+(?=[A-Z])/);
  let sawKv = false;
  for (const line of lines) {
    const m = KV.exec(line.trim());
    if (m) { sawKv = true; kvLabels.set(m[1].trim(), (kvLabels.get(m[1].trim()) ?? 0) + 1); }
  }
  if (sawKv) kvInNotes++;
  if (MONEY.test(String(e.notes))) moneyInNotes++;
}
console.log(`\n  WHAT IS IN \`notes\` — now stripped from every recipient FlowGuide`);
console.log(`    entries with any note ................ ${noted.length}/${all.length}`);
console.log(`    ...containing a "Label: value" pair ... ${kvInNotes}`);
console.log(`    ...containing a $ amount ............. ${moneyInNotes}`);
if (kvLabels.size) {
  console.log(`    labels found INSIDE notes (top):`);
  for (const [l, n] of [...kvLabels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
    console.log(`      ${String(n).padStart(3)}×  ${l}${labelCount.has(l) ? `   (also a real detail label on ${labelCount.get(l)} entr${labelCount.get(l) === 1 ? "y" : "ies"})` : ""}`);
}

// ---- duplication and fabrication signals -----------------------------------
let dupPhone = 0, dupUrl = 0, websiteFromEmail = 0;
for (const e of all) {
  const contacts = arr(e.contacts) as Entry["contacts"];
  for (const c of contacts ?? []) {
    if (c?.phone && judge(e as unknown as Record<string, unknown>, { value: c.phone }).duplicated) dupPhone++;
    if (c?.website && c?.email) {
      const dom = c.email.split("@")[1]?.replace(/^www\./, "");
      if (dom && c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").startsWith(dom)) websiteFromEmail++;
    }
  }
  const urls = [...arr(e.links).map((l) => (l as { url?: string })?.url), ...arr(e.photos).map((p) => typeof p === "string" ? p : (p as { url?: string })?.url)].filter(Boolean) as string[];
  if (new Set(urls).size !== urls.length) dupUrl++;
}
console.log(`\n  SIGNALS`);
console.log(`    contact phone also appearing elsewhere in the entry ... ${dupPhone}`);
console.log(`    entries with a duplicated URL across links/photos ..... ${dupUrl}`);
console.log(`    contact website matching the email's own domain ....... ${websiteFromEmail}   (possible inference, not extraction)`);
console.log("");
