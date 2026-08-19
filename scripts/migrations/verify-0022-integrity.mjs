// 0022 INTEGRITY — offline, no database.
//
// 0022 adds three new functions and touches nothing that exists. This proves
// both halves of that, and cross-checks the one thing a type-checker cannot:
// supabase.rpc() sends NAMED arguments, so a parameter renamed on either side
// fails at runtime and nowhere earlier.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (p) => readFileSync(p, "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const M22 = read("supabase/migrations/0022_library_import_lifecycle.sql");

let failed = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};
console.log(`\n0022 integrity  sha256=${sha(M22)}\n`);

// ---------------------------------------------------------------------------
// It creates three functions, and replaces nothing that already exists.
// ---------------------------------------------------------------------------
const defined = [...M22.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
const EXPECTED = ["create_library_import_run", "library_materialize_proposals", "library_close_import_run"];
ok(JSON.stringify(defined) === JSON.stringify(EXPECTED),
   "defines exactly the three intended functions, in order", defined.join(", "));

const priorNames = new Set();
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql") && !f.startsWith("0022"))) {
  for (const m of read(`supabase/migrations/${f}`).matchAll(/create or replace function public\.(\w+)\(/g)) {
    priorNames.add(m[1]);
  }
}
ok(defined.every((n) => !priorNames.has(n)),
   "none of the three collides with an existing function",
   defined.filter((n) => priorNames.has(n)).join(", "));

ok(!/\balter table\b/i.test(M22) && !/\bdrop (table|index|constraint|function|trigger)\b/i.test(M22),
   "no table, index, constraint or function is altered or dropped");

// ---------------------------------------------------------------------------
// The three conditions required of library_close_import_run.
// ---------------------------------------------------------------------------
const close = M22.slice(M22.indexOf("create or replace function public.library_close_import_run("),
                        M22.indexOf("$lci$;") + 6);
ok(/p_status not in \('finalized','discarded'\)/.test(close),
   "close: accepts ONLY the two permitted terminal statuses");
ok(/raise exception 'library: close status must be/.test(close),
   "close: anything else raises rather than being coerced");
ok(!/set status = '/.test(close) || /set status = p_status/.test(close),
   "close: the status written is the validated parameter, never a literal smuggled elsewhere");
ok(/v_run\.destination <> 'library'/.test(close),
   "close: refuses a packet run");
ok(/v_run\.user_id <> p_owner/.test(close),
   "close: refuses a caller who does not own the run");
ok(/if v_run\.status in \('finalized','discarded'\) then/.test(close),
   "close: refuses to move a run that is already terminal");

// ---------------------------------------------------------------------------
// Privileges — service role only, for all three.
// ---------------------------------------------------------------------------
for (const n of EXPECTED) {
  const rev = new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon, authenticated, service_role;`);
  const grant = new RegExp(`grant execute on function public\\.${n}\\([^)]*\\) to service_role;`);
  ok(rev.test(M22) && grant.test(M22), `${n}: revoked from all, granted only to service_role`);
  const body = M22.slice(M22.indexOf(`create or replace function public.${n}(`));
  const head = body.slice(0, body.indexOf("as $"));
  ok(/security definer/.test(head) && /set search_path = ''/.test(head),
     `${n}: security definer with a pinned empty search_path`);
}

// ---------------------------------------------------------------------------
// It stays out of the packet path and out of library_items.
// ---------------------------------------------------------------------------
// Scoped to the FUNCTION BODIES. 0022's own verify block quotes these very
// strings in order to forbid them, so a whole-file scan reads the assertion and
// reports the thing it is asserting against. Second time this trap has been hit
// in this workstream; the fix is always to scope, never to loosen the pattern.
const BODIES = M22.slice(0, M22.indexOf("do $verify$"));
for (const t of ["public.packets", "public.sections", "public.items", "public.packet_blocks"]) {
  ok(!new RegExp(`insert into ${t.replace(".", "\\.")}`).test(BODIES),
     `never inserts into ${t}`);
}
ok(!/insert into public\.library_items/.test(BODIES),
   "never writes library_items — library_save_proposal remains the only writer");
// ...and the verify block really does contain those guards, so scoping the scan
// did not quietly discard the protection.
const VERIFY = M22.slice(M22.indexOf("do $verify$"));
ok(/insert into public\.sections/.test(VERIFY) && /insert into public\.library_items/.test(VERIFY),
   "0022's own verify block still guards against both at apply time");

// ---------------------------------------------------------------------------
// NAMED-ARGUMENT CROSS-CHECK. supabase.rpc() sends named arguments, so a
// parameter renamed on either side is a runtime failure that nothing else
// catches: not tsc, not the migration's own verify block, not a source grep.
// ---------------------------------------------------------------------------
function declaredParams(name) {
  const i = M22.indexOf(`create or replace function public.${name}(`);
  const sig = M22.slice(i + `create or replace function public.${name}(`.length, M22.indexOf(")", i));
  return sig.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).sort();
}
function callSites(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...callSites(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const sources = callSites("src");
for (const n of [...EXPECTED, "library_save_proposal"]) {
  const declared = n === "library_save_proposal"
    ? ["p_owner", "p_proposal_id", "p_run_id"]     // from 0021
    : declaredParams(n);
  const file = sources.find((f) => read(f).includes(`rpc("${n}"`));
  if (!file) { ok(false, `${n}: no call site found in src/`); continue; }
  const src = read(file);
  const call = src.slice(src.indexOf(`rpc("${n}"`));
  const args = [...call.slice(0, call.indexOf("});") + 3).matchAll(/\b(p_\w+):/g)].map((m) => m[1]).sort();
  ok(JSON.stringify(args) === JSON.stringify(declared),
     `${n}: the route sends exactly the declared parameter names`,
     `route sends [${args}] vs declared [${declared}]`);
}

console.log(`\n${failed === 0 ? "INTEGRITY OK" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
