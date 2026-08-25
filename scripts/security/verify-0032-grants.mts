// VERIFICATION OF MIGRATION 0032 — the grant 0031 dropped on the floor.
//
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/security/verify-0032-grants.mts
//
// Reading the migration tells you what SHOULD be true. This asks the database.
//
// The distinction that matters, and the one that made the original defect look
// like a pass: a VALIDATION or CONSTRAINT error means the function BODY RAN and
// the caller had EXECUTE. Only "permission denied for function" proves the
// grant is closed. Before 0032, anon reached a foreign-key error inside the
// body — a data constraint, not an authorization control.
import { anon, svc, check, summary, errText } from "../ingestion-runtime/lib.mts";

const ZERO = "00000000-0000-0000-0000-000000000000";
const args = (owner: string, key: string) => ({
  p_chunks: [{ ordinal: 0, source_start: 0, source_end: 5, segment_text: "probe", segment_hash: "x" }],
  p_delimiter_hint: null, p_owner: owner, p_packet_type: "senior_living",
  p_request_key: key, p_segmenter_version: "seg-v4", p_slug: key,
  p_source_hash: "x", p_source_len: 5, p_source_text: "probe",
});

// ---- 1. anon is DENIED, and denied for the right reason -------------------
console.log("[1] anon");
{
  const { error } = await anon.rpc("create_organize_run", args(ZERO, "v0032-anon-" + process.pid));
  const msg = error ? errText(error) : "(NO ERROR — the body ran to completion)";
  console.log(`    ${msg.slice(0, 100)}`);
  check("anon is refused with PERMISSION DENIED", /permission denied for function/i.test(msg), msg.slice(0, 120));
  // The exact shape of the old defect, named so a regression cannot pass quietly.
  check("anon does NOT reach the body (no constraint/validation error)",
    !/foreign key|violates|ingestion:/i.test(msg), msg.slice(0, 120));
}

// ---- 2. PUBLIC holds no grant either --------------------------------------
// anon inherits PUBLIC. If PUBLIC still had EXECUTE, the probe above would have
// reached the body. Its denial is what proves PUBLIC is closed — and therefore
// that `authenticated` cannot reach it that way either.
console.log("\n[2] PUBLIC (proven through anon, which inherits it)");
{
  const { error } = await anon.rpc("create_organize_run", args(ZERO, "v0032-pub-" + process.pid));
  check("PUBLIC has no execute on create_organize_run",
    /permission denied for function/i.test(error ? errText(error) : ""), "PUBLIC still grants execute");
}

// ---- 3. service_role STILL WORKS ------------------------------------------
// A revoke that also broke the legitimate caller would be a worse outcome than
// the hole. This proves the function still executes for the role the app uses.
console.log("\n[3] service_role");
{
  const TAG = "flowguide-rt-" + process.pid;
  const { data: u, error: uerr } = await svc
    .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
  if (uerr) { console.error(errText(uerr)); process.exit(1); }
  const UID = (u as { id: string }).id;
  try {
    const KEY = "v0032-svc-" + process.pid;
    const { data, error } = await svc.rpc("create_organize_run", args(UID, KEY));
    check("service_role CAN still execute it", !error, error ? errText(error).slice(0, 140) : "");
    const out = (data ?? {}) as { packet_id?: string; run_id?: string };
    check("it returned a real packet_id and run_id", !!out.packet_id && !!out.run_id, JSON.stringify(out));
    // The row, not the return value — the function is SECURITY DEFINER and the
    // return value would look identical if nothing had been written.
    const { data: runs } = await svc.from("ingestion_runs").select("id, user_id").eq("request_key", KEY);
    check("a run row actually exists, owned by the caller",
      (runs ?? []).length === 1 && (runs![0] as { user_id: string }).user_id === UID,
      JSON.stringify(runs));
  } finally {
    await svc.from("packets").delete().eq("user_id", UID);
    await svc.from("users").delete().eq("id", UID);
    const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
    console.log(`    cleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
  }
}

// ---- 4. the untouched siblings are unchanged ------------------------------
console.log("\n[4] siblings unchanged by 0032");
for (const fn of ["finalize_ingestion_run", "discard_ingestion_run"]) {
  const { error } = await anon.rpc(fn, { p_run_id: ZERO, p_owner: ZERO });
  check(`${fn} still refuses anon`, /permission denied/i.test(error ? errText(error) : ""), "");
}

process.exit(summary("MIGRATION 0032 — create_organize_run grants") > 0 ? 1 : 0);
