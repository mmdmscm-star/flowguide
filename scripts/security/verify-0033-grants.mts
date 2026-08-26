// VERIFY 0033 DID NOT REPEAT THE 0031 MISTAKE.
// Dropping a function discards its grants; the replacement defaults to EXECUTE
// for PUBLIC. A validation/constraint error means the BODY RAN and the grant is
// open — only "permission denied for function" proves it is closed.
import { anon, svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const ZERO = "00000000-0000-0000-0000-000000000000";
const args = {
  p_item_id: ZERO, p_owner_id: ZERO, p_packet_id: null, p_require_mode: null,
  p_title: null, p_description: null, p_notes: null, p_highlight: null,
  p_address: null, p_details: null, p_links: null, p_photos: null, p_contacts: null,
};
{
  const { error } = await anon.rpc("update_item_content", args as never);
  const msg = error ? errText(error) : "(NO ERROR — the body ran)";
  console.log(`anon -> ${msg.slice(0, 100)}`);
  check("anon is refused with PERMISSION DENIED", /permission denied for function/i.test(msg), msg.slice(0, 120));
  check("anon does NOT reach the body", !/item content:|not found/i.test(msg), msg.slice(0, 120));
}
{
  // service_role must still work — a revoke that broke the app would be worse.
  const { error } = await svc.rpc("update_item_content", args as never);
  const msg = error ? errText(error) : "";
  // Reaching 'item % not found' proves it EXECUTED (the zero uuid has no item).
  check("service_role CAN still execute it", /item content: item .* not found/i.test(msg), msg.slice(0, 120));
}
{
  // The 13-arg signature is the one that exists; the old 12-arg must be gone.
  const { p_highlight, ...old } = args;
  void p_highlight;
  const { error } = await svc.rpc("update_item_content", old as never);
  const msg = error ? errText(error) : "";
  check("the old 12-argument signature no longer resolves",
    /Could not find the function|schema cache/i.test(msg), msg.slice(0, 100));
}
process.exit(summary("MIGRATION 0033 — update_item_content grants") > 0 ? 1 : 0);
