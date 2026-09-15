// EARLY-ACCESS INVITES, from the terminal. Service role; no admin UI.
//
//   node --env-file=.env.local --import tsx scripts/invites/invites.mts create "Jane Doe (jane@example.com)"
//   node --env-file=.env.local --import tsx scripts/invites/invites.mts list
//   node --env-file=.env.local --import tsx scripts/invites/invites.mts revoke <id>
//   node --env-file=.env.local --import tsx scripts/invites/invites.mts requests [days]
//
// `create` prints the code ONCE — the only time it exists anywhere. The
// database stores its SHA-256, so a lost code cannot be recovered: revoke it
// and make another. `list` never shows codes, because it cannot.
import { createServerClient } from "../../src/lib/supabase.ts";
import { generateInviteCode, inviteCodeHash, normalizeInviteCode } from "../../src/lib/invite-code.ts";

const db = createServerClient();
const [command, ...rest] = process.argv.slice(2);
const die = (msg: string) => { console.error(msg); process.exit(1); };

if (command === "create") {
  const label = rest.join(" ").trim();
  if (!label) die('usage: invites.mts create "who it is for"');
  const code = generateInviteCode();
  const { error } = await db.from("invite_codes").insert({ code_hash: inviteCodeHash(normalizeInviteCode(code)), label });
  if (error) die(`could not create the invite: ${error.message}`);
  console.log(`\n  invite for ${label}\n\n      ${code}\n\n  Send it to them. It is shown once and stored only as a hash;\n  it creates ONE account, with whatever email they sign in with.\n`);
} else if (command === "list") {
  const { data, error } = await db.from("invite_codes").select("id, label, created_at, used_at, used_by, revoked_at").order("created_at", { ascending: false });
  if (error) die(`could not list invites: ${error.message}`);
  const rows = (data as { id: string; label: string; created_at: string; used_at: string | null; used_by: string | null; revoked_at: string | null }[]);
  if (rows.length === 0) console.log("no invites yet");
  for (const r of rows) {
    const state = r.used_at ? `used ${r.used_at.slice(0, 10)}` : r.revoked_at ? `revoked ${r.revoked_at.slice(0, 10)}` : "unused";
    console.log(`${r.id}  ${state.padEnd(18)}  created ${r.created_at.slice(0, 10)}  ${r.label}`);
  }
  console.log(`\n${rows.filter((r) => !r.used_at && !r.revoked_at).length} unused`);
} else if (command === "revoke") {
  const id = rest[0];
  if (!id) die("usage: invites.mts revoke <id>   (ids come from `list`)");
  const { data, error } = await db.from("invite_codes").update({ revoked_at: new Date().toISOString() })
    .eq("id", id).is("used_at", null).is("revoked_at", null).select("id, label");
  if (error) die(`could not revoke: ${error.message}`);
  const rows = data as { id: string; label: string }[];
  if (rows.length === 0) die("nothing revoked: no such invite, or it is already used or revoked");
  console.log(`revoked ${rows[0].id} (${rows[0].label}) — it can no longer create an account`);
} else if (command === "requests") {
  const days = Number(rest[0] ?? 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from("early_access_requests").select("created_at, name, email, use_case").gte("created_at", since).order("created_at", { ascending: false });
  if (error) die(`could not read requests: ${error.message}`);
  const rows = data as { created_at: string; name: string; email: string; use_case: string }[];
  console.log(`${rows.length} request(s) in the last ${days} days (kept for 90):\n`);
  for (const r of rows) console.log(`${r.created_at.slice(0, 10)}  ${r.name} <${r.email}>\n    ${r.use_case.replace(/\s+/g, " ").slice(0, 300)}\n`);
} else {
  die("usage: invites.mts create \"who it is for\" | list | revoke <id> | requests [days]");
}
