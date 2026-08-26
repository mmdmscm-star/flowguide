// 0034 POST-APPLY VERIFICATION: schema, behaviour of the new counter, grants.
import { anon, svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const ZERO = "00000000-0000-0000-0000-000000000000";

// ---- schema -----------------------------------------------------------------
{
  const { data: p } = await svc.from("packets").select("*").limit(1);
  const cols = Object.keys((p ?? [{}])[0] ?? {});
  check("packets.structural_rev exists", cols.includes("structural_rev"), cols.join(","));
  const { data: r } = await svc.from("ingestion_runs").select("*").limit(1);
  const rcols = Object.keys((r ?? [{}])[0] ?? {});
  check("ingestion_runs.baseline_structural_rev exists", rcols.includes("baseline_structural_rev"), "");
}

// ---- THE CORE BEHAVIOUR: metadata must NOT move structural_rev --------------
const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
try {
  const { data: pk } = await svc.from("packets").insert({
    user_id: UID, slug: TAG, title: "t", status: "draft", composition_mode: "legacy" })
    .select("id, content_rev, structural_rev").single();
  const PID = (pk as { id: string }).id;
  const read = async () => {
    const { data } = await svc.from("packets").select("content_rev, structural_rev").eq("id", PID).single();
    return data as { content_rev: number; structural_rev: number };
  };
  const before = await read();

  // METADATA — every column ingest_bump_packet_self watches.
  await svc.from("packets").update({ title: "A new title" }).eq("id", PID);
  await svc.from("packets").update({ client_name: "the Chen family" }).eq("id", PID);
  await svc.from("packets").update({ personal_note: "A note for them." }).eq("id", PID);
  await svc.from("packets").update({ map_url: "https://maps.example.com/x" }).eq("id", PID);
  const afterMeta = await read();
  check("metadata bumps content_rev", afterMeta.content_rev > before.content_rev,
    `${before.content_rev} -> ${afterMeta.content_rev}`);
  check("METADATA DOES NOT BUMP structural_rev",
    afterMeta.structural_rev === before.structural_rev,
    `${before.structural_rev} -> ${afterMeta.structural_rev}`);

  // STRUCTURE — a section, an item, and each child table.
  const { data: sec } = await svc.from("sections").insert({ packet_id: PID, title: "S", sort_order: 0 }).select("id").single();
  const afterSection = await read();
  check("a section bumps structural_rev", afterSection.structural_rev > afterMeta.structural_rev,
    `${afterMeta.structural_rev} -> ${afterSection.structural_rev}`);

  const { data: it } = await svc.from("items").insert({ section_id: (sec as {id:string}).id, title: "I", sort_order: 0 }).select("id").single();
  const IID = (it as { id: string }).id;
  const afterItem = await read();
  check("an item bumps structural_rev", afterItem.structural_rev > afterSection.structural_rev, "");

  let prev = afterItem.structural_rev;
  for (const [label, table, row] of [
    ["a detail", "item_details", { item_id: IID, label: "L", value: "V", sort_order: 0 }],
    ["a link", "item_links", { item_id: IID, url: "https://e.example.com", label: "L", sort_order: 0 }],
    ["a photo", "item_photos", { item_id: IID, url: "https://e.example.com/p.jpg", storage_path: "", sort_order: 0 }],
    ["a contact", "item_contacts", { item_id: IID, name: "N", sort_order: 0 }],
  ] as const) {
    await svc.from(table).insert(row as never);
    const now = await read();
    check(`${label} bumps structural_rev`, now.structural_rev > prev, `${prev} -> ${now.structural_rev}`);
    prev = now.structural_rev;
  }

  // DELETE + ADD netting to the same count must still move the counter.
  const netBefore = await read();
  await svc.from("items").delete().eq("id", IID);
  await svc.from("items").insert({ section_id: (sec as {id:string}).id, title: "replacement", sort_order: 0 });
  const netAfter = await read();
  check("DELETE+ADD netting zero still moves structural_rev",
    netAfter.structural_rev > netBefore.structural_rev + 1,
    `${netBefore.structural_rev} -> ${netAfter.structural_rev}`);
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
}

// ---- grants -----------------------------------------------------------------
{
  const { error } = await anon.rpc("rebaseline_ingestion_run", { p_run_id: ZERO, p_owner: ZERO });
  const msg = error ? errText(error) : "(NO ERROR — the body ran)";
  check("anon CANNOT execute rebaseline_ingestion_run", /permission denied for function/i.test(msg), msg.slice(0, 110));
  check("anon does not reach its body", !/run .* not found|ingestion:/i.test(msg), msg.slice(0, 110));
}
for (const fn of ["finalize_ingestion_run", "create_organize_run", "create_ingestion_run"]) {
  const { error } = await anon.rpc(fn, { p_run_id: ZERO, p_owner: ZERO } as never);
  const msg = error ? errText(error) : "";
  check(`${fn} still refuses anon`, /permission denied|Could not find the function|schema cache/i.test(msg), msg.slice(0, 90));
}
{
  const { error } = await svc.rpc("rebaseline_ingestion_run", { p_run_id: ZERO, p_owner: ZERO });
  check("service_role CAN execute it (reaches the body)",
    /run .* not found/i.test(error ? errText(error) : ""), error ? errText(error).slice(0,90) : "no error");
}
process.exit(summary("MIGRATION 0034 — schema, behaviour, grants") > 0 ? 1 : 0);
