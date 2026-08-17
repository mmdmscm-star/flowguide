// Empirical anon-key exposure probe. Run BEFORE and AFTER migration 0015.
//
//   npx tsx scripts/security/anon-exposure-probe.mts
//
// Reading the policies tells you what SHOULD be true. This tells you what IS
// true, from a client holding only the public anon key — the same key that ships
// in the browser bundle.
//
// SAFETY. Every WRITE probe targets a disposable packet this script creates and
// then deletes; it never writes to real data. The one probe that touches real
// rows is the enumeration COUNT, which is read-only and prints only a number —
// client names are the thing being protected and must not land in a transcript.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = createClient(URL_, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const rows: Array<{ probe: string; result: string; open: boolean }> = [];
const record = (probe: string, open: boolean, result: string) => {
  rows.push({ probe, result, open });
  console.log(`  ${open ? "OPEN  " : "closed"}  ${probe.padEnd(46)} ${result}`);
};
// Service-role paths are SUPPOSED to work; they are not exposures, and labelling
// them OPEN alongside the anon probes reads as a finding when it is the opposite.
const expect = (probe: string, ok: boolean, result: string) => {
  console.log(`  ${ok ? "  ok  " : "BROKEN"}  ${probe.padEnd(46)} ${result}`);
};

const stamp = Math.floor(Number(process.env.PROBE_STAMP ?? "0")) || 1;
const SLUG = `zz-secprobe-${stamp}-${Math.abs(Math.round(stamp * 2654435761)) % 1e9}`;

console.log(`\nanon-key exposure probe against ${URL_}\n`);

// ---- disposable fixture (service role) ------------------------------------
const { data: user } = await svc.from("users").select("id").limit(1).maybeSingle();
if (!user) { console.error("no users row to attach a probe packet to"); process.exit(1); }
const uid = (user as { id: string }).id;

const { data: pkt, error: pErr } = await svc.from("packets")
  .insert({ user_id: uid, slug: SLUG, title: "SECURITY PROBE — delete me",
            client_name: "probe", raw_input: "PROBE", status: "published" })
  .select("id").single();
if (pErr) { console.error("could not create probe packet:", pErr.message); process.exit(1); }
const packetId = (pkt as { id: string }).id;

const { data: sec } = await svc.from("sections")
  .insert({ packet_id: packetId, title: "probe section", sort_order: 0 }).select("id").single();
const sectionId = (sec as { id: string } | null)?.id;
const { data: itm } = await svc.from("items")
  .insert({ section_id: sectionId, title: "probe item", sort_order: 0 }).select("id").single();
const itemId = (itm as { id: string } | null)?.id;
await svc.from("item_photos").insert({ item_id: itemId, url: "https://example.com/probe.jpg", storage_path: "", sort_order: 0 });

console.log(`disposable published packet ${packetId} (slug ${SLUG})\n`);

try {
  // ---- READ: can anon enumerate all published packets? --------------------
  const { data: listed, error: lErr } = await anon.from("packets").select("id");
  record("anon SELECT packets (enumeration)", !lErr && (listed?.length ?? 0) > 0,
    lErr ? `denied (${lErr.code})` : `${listed?.length} rows readable`);

  // ---- READ: child content of a published packet --------------------------
  for (const [table, col, val] of [
    ["sections", "packet_id", packetId],
    ["items", "section_id", sectionId!],
    ["item_photos", "item_id", itemId!],
    ["packet_blocks", "packet_id", packetId],
  ] as const) {
    const { data, error } = await anon.from(table).select("id").eq(col, val);
    // NOTE: 0 rows on packet_blocks is INCONCLUSIVE for a legacy packet, which
    // has no blocks to read. Read it as "nothing leaked here", not "denied".
    record(`anon SELECT ${table}`, !error && (data?.length ?? 0) > 0,
      error ? `denied (${error.code})` : `${data?.length} rows readable`);
  }

  // ---- WRITE: overwrite content of a published packet ---------------------
  // Targets the DISPOSABLE packet only. Writes a marker so a success is
  // unambiguous rather than a silent no-op.
  const { data: w, error: wErr } = await anon.from("packets")
    .update({ raw_input: "OVERWRITTEN-BY-ANON", title: "OVERWRITTEN" })
    .eq("id", packetId).select("id");
  record("anon UPDATE packets (content overwrite)", !wErr && (w?.length ?? 0) > 0,
    wErr ? `rejected (${wErr.code})` : `ACCEPTED, ${w?.length} row(s) rewritten`);

  const { data: w2, error: w2Err } = await anon.from("item_photos")
    .update({ url: "https://example.com/anon-swapped.jpg" }).eq("item_id", itemId!).select("id");
  record("anon UPDATE item_photos", !w2Err && (w2?.length ?? 0) > 0,
    w2Err ? `rejected (${w2Err.code})` : `ACCEPTED, ${w2?.length} row(s)`);

  // ---- WRITE: create / destroy -------------------------------------------
  const { data: ins, error: iErr } = await anon.from("packets")
    .insert({ user_id: uid, slug: `${SLUG}-inserted`, title: "anon insert", status: "published" })
    .select("id");
  record("anon INSERT packets", !iErr && (ins?.length ?? 0) > 0,
    iErr ? `rejected (${iErr.code})` : "ACCEPTED — anon can create packets");
  if (ins?.length) await svc.from("packets").delete().eq("slug", `${SLUG}-inserted`);

  const { data: del, error: dErr } = await anon.from("item_photos").delete().eq("item_id", itemId!).select("id");
  record("anon DELETE item_photos", !dErr && (del?.length ?? 0) > 0,
    dErr ? `rejected (${dErr.code})` : `ACCEPTED, ${del?.length} row(s) destroyed`);

  // ---- The legitimate paths must keep working -----------------------------
  // The REAL recipient read path, not a raw table read: getPublishedPacket()
  // fetches the packet plus sections, items, photos, links, details and
  // contacts — every table whose public SELECT policy 0015 drops. If any of
  // those reads had depended on the anon role, this is what would break.
  const { getPublishedPacket } = await import("../../src/lib/queries.ts");
  const rendered = await getPublishedPacket(SLUG);
  const secs = rendered?.sections?.length ?? 0;
  const its = rendered?.sections?.reduce((n, x) => n + (x.items?.length ?? 0), 0) ?? 0;
  const phs = rendered?.sections?.reduce((n, x) => n + (x.items?.reduce((m, i) => m + (i.photos?.length ?? 0), 0) ?? 0), 0) ?? 0;
  expect("getPublishedPacket() — real recipient read path", !!rendered && secs > 0 && its > 0,
    rendered ? `packet + ${secs} section(s), ${its} item(s), ${phs} photo(s)` : "RETURNED NULL — recipient view is broken");

  const { data: readBack } = await svc.from("packets").select("id, title, viewed").eq("id", packetId).maybeSingle();
  expect("service role can still read the packet", !!readBack,
    readBack ? "yes — this is how /p/[slug] reads" : "NO — investigate");

  await svc.from("packets").update({ viewed: true }).eq("slug", SLUG).eq("status", "published").eq("viewed", false);
  const { data: after } = await svc.from("packets").select("viewed").eq("id", packetId).maybeSingle();
  const viewedOk = !!(after as { viewed?: boolean } | null)?.viewed;
  expect("markPacketViewed path (service role)", viewedOk,
    viewedOk ? "viewed=true — works" : "FAILED to set viewed");
} finally {
  await svc.from("packets").delete().eq("id", packetId);
  const { data: leftover } = await svc.from("packets").select("id").like("slug", "zz-secprobe-%");
  console.log(`\ncleanup: ${leftover?.length ?? 0} probe packet(s) remaining (expect 0)`);
}

const open = rows.filter((r) => r.open && r.probe.startsWith("anon"));
console.log(`\n==> ${open.length} anon capability(ies) OPEN:`);
for (const o of open) console.log(`      - ${o.probe}`);
if (open.length === 0) console.log("      (none — anon has no access to packet content)");
