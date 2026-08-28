// EXECUTING REGRESSION for Library Detail ordering.
//
// The snapshot model is the thing at risk here, not the ordering: a Library
// item is a reusable starting point, a FlowGuide gets a COPY, and the two go
// their own way from that moment. So this does not stop at "the order saved" —
// it takes a copy, reorders each side afterwards, and proves neither followed
// the other.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const TAG = "flowguide-libdetail-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });

// Import order, with Type last — the arrangement the professional wants changed.
const IMPORTED = [
  { label: "Memory Care Shared Suite", value: "$8,990/month" },
  { label: "Community Fee", value: "$4,000" },
  { label: "Contact Name", value: "Sean Baron" },
  { label: "Type", value: "MC" },
];
const L = (rows: Array<{ label: string }>) => rows.map((r) => r.label);
const IMPORT_ORDER = L(IMPORTED);
const CHOSEN = ["Type", "Memory Care Shared Suite", "Community Fee", "Contact Name"];

try {
  // ---- 1. save a Library item, then arrange its Details ------------------
  const created = await api("/api/library", { method: "POST", body: JSON.stringify({
    item: {
      title: "The Reserve at Fountaingrove", address: "200 Fountaingrove Pkwy. Santa Rosa, CA 95403",
      description: "A dedicated memory care community.", notes: "", highlight: "",
      details: IMPORTED, links: [], photos: [], contacts: [],
    },
  }) });
  const cbody = await created.json();
  check("[1] the Library item saves", created.ok, `${created.status} ${JSON.stringify(cbody).slice(0, 200)}`);
  const libId = String(cbody?.item?.id ?? cbody?.id ?? "");
  check("[1] it has an id", !!libId, JSON.stringify(cbody).slice(0, 200));
  if (!libId) throw new Error("no library id — the rest would be meaningless");

  // The Library save carries expectedRevision — optimistic concurrency, exactly
  // as the editor sends it. Read the current revision each time rather than
  // assuming one, so the harness cannot pass by accident.
  const saveLibrary = async (details: Array<{ label: string; value: string }>) => {
    const { data: cur } = await svc.from("library_items").select("revision").eq("id", libId).single();
    return api(`/api/library/${libId}`, { method: "PATCH", body: JSON.stringify({
      title: "The Reserve at Fountaingrove", address: "200 Fountaingrove Pkwy. Santa Rosa, CA 95403",
      description: "A dedicated memory care community.", notes: "", highlight: "",
      details, links: [], photos: [], contacts: [],
      expectedRevision: (cur as { revision: number }).revision,
    }) });
  };

  const libDetails = async () => {
    const { data } = await svc.from("library_items").select("details").eq("id", libId).single();
    return ((data as { details: Array<{ label: string; value: string }> })?.details ?? []);
  };
  check("[1] stored in the order sent", JSON.stringify(L(await libDetails())) === JSON.stringify(IMPORT_ORDER),
    JSON.stringify(L(await libDetails())));

  // The professional drags Type to the top and the editor saves the whole list.
  const reordered = [IMPORTED[3], IMPORTED[0], IMPORTED[1], IMPORTED[2]];
  const moved = await saveLibrary(reordered);
  check("[2] the reorder saves", moved.ok, `${moved.status} ${(await moved.text()).slice(0, 200)}`);
  check("[2] Type is now first", JSON.stringify(L(await libDetails())) === JSON.stringify(CHOSEN),
    JSON.stringify(L(await libDetails())));
  const vals = await libDetails();
  check("[2] no value changed while moving",
    vals.find((d) => d.label === "Type")?.value === "MC" &&
    vals.find((d) => d.label === "Community Fee")?.value === "$4,000", JSON.stringify(vals));

  // ---- 3. RELOAD — what the Library editor reads back --------------------
  const reloaded = await (await api(`/api/library/${libId}`)).json();
  const asLoaded = ((reloaded?.item?.details ?? reloaded?.details ?? []) as Array<{ label: string }>);
  check("[3] the Library editor reloads it in the chosen order",
    JSON.stringify(L(asLoaded)) === JSON.stringify(CHOSEN), JSON.stringify(L(asLoaded)));

  // ---- 4. A NEW FLOWGUIDE INHERITS THE LIBRARY ORDER ---------------------
  const fg = await api("/api/packets/from-library", { method: "POST",
    body: JSON.stringify({ libraryItemIds: [libId], title: "Inherits Order", clientName: "Smoke Client" }) });
  const fgBody = await fg.json();
  check("[4] the FlowGuide is created", fg.status === 201, `${fg.status} ${JSON.stringify(fgBody).slice(0, 200)}`);
  const packetId = String(fgBody.packetId);
  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", packetId);
  const { data: its } = await svc.from("items").select("id")
    .in("section_id", ((secs ?? []) as { id: string }[]).map((x) => x.id));
  const copyId = String(((its ?? []) as { id: string }[])[0]?.id ?? "");
  const copyDetails = async () => ((await svc.from("item_details")
    .select("label, value, sort_order").eq("item_id", copyId).order("sort_order")).data ?? []) as
    Array<{ label: string; value: string; sort_order: number }>;

  check("[4] THE COPY INHERITS THE LIBRARY ORDER",
    JSON.stringify(L(await copyDetails())) === JSON.stringify(CHOSEN), JSON.stringify(L(await copyDetails())));
  check("[4] and it is not merely the import order",
    JSON.stringify(L(await copyDetails())) !== JSON.stringify(IMPORT_ORDER), "");
  check("[4] sort_order numbered from the array position",
    JSON.stringify((await copyDetails()).map((d) => d.sort_order)) === "[0,1,2,3]",
    JSON.stringify((await copyDetails()).map((d) => d.sort_order)));

  // ---- 5. REORDERING THE LIBRARY LATER LEAVES THE COPY ALONE -------------
  const later = [IMPORTED[1], IMPORTED[2], IMPORTED[0], IMPORTED[3]];   // a different arrangement again
  await saveLibrary(later);
  check("[5] the Library took the new order", JSON.stringify(L(await libDetails())) === JSON.stringify(L(later)),
    JSON.stringify(L(await libDetails())));
  check("[5] THE ALREADY-CREATED FLOWGUIDE DID NOT MOVE",
    JSON.stringify(L(await copyDetails())) === JSON.stringify(CHOSEN), JSON.stringify(L(await copyDetails())));

  // ---- 6. REORDERING THE FLOWGUIDE LEAVES THE LIBRARY ALONE --------------
  const inGuide = [{ label: "Contact Name", value: "Sean Baron" }, { label: "Type", value: "MC" },
                   { label: "Memory Care Shared Suite", value: "$8,990/month" }, { label: "Community Fee", value: "$4,000" }];
  const patched = await api("/api/items", { method: "PATCH",
    body: JSON.stringify({ id: copyId, details: inGuide }) });
  check("[6] the FlowGuide copy reorders", patched.ok, String(patched.status));
  check("[6] the copy took its own order", JSON.stringify(L(await copyDetails())) === JSON.stringify(L(inGuide)),
    JSON.stringify(L(await copyDetails())));
  check("[6] THE LIBRARY ITEM DID NOT MOVE", JSON.stringify(L(await libDetails())) === JSON.stringify(L(later)),
    JSON.stringify(L(await libDetails())));

  // ---- 7. editing, adding and deleting in the Library --------------------
  const edited = [{ label: "Community Fee", value: "$4,250" }, ...later.slice(1),
                  { label: "Pet Policy", value: "Cats welcome" }];
  await saveLibrary(edited);
  let now = await libDetails();
  check("[7] editing a row keeps its position", now[0]?.label === "Community Fee" && now[0]?.value === "$4,250",
    JSON.stringify(now.slice(0, 1)));
  check("[7] a new row appends without disturbing the order",
    now[4]?.label === "Pet Policy" && now.length === 5, JSON.stringify(L(now)));
  const afterDelete = edited.filter((d) => d.label !== "Contact Name");
  await saveLibrary(afterDelete);
  now = await libDetails();
  check("[7] deleting leaves the rest in sequence", JSON.stringify(L(now)) === JSON.stringify(L(afterDelete)),
    JSON.stringify(L(now)));
  check("[7] and the FlowGuide copy STILL has not moved",
    JSON.stringify(L(await copyDetails())) === JSON.stringify(L(inGuide)), JSON.stringify(L(await copyDetails())));
} finally {
  const { data: packets } = await svc.from("packets").select("id").eq("user_id", UID);
  for (const p of ((packets ?? []) as { id: string }[])) await svc.from("packets").delete().eq("id", p.id);
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count: lib } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: pk } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: users } = await svc.from("users").select("id", { count: "exact", head: true }).eq("id", UID);
  console.log(`\ncleanup: library=${lib ?? 0} packets=${pk ?? 0} users=${users ?? 0} — ${!lib && !pk && !users ? "clean" : "NOT CLEAN"}`);
}
process.exit(summary("LIBRARY DETAIL ORDER — arrange, persist, inherit, and stay independent") > 0 ? 1 : 0);
