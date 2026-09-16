// THE INVITATION FLOW: approve, send, open, accept.
//
// The database half (reservation, atomic claim, races, rollback) is proved in
// scripts/pg-harness/test-0056.mjs. These cover the founder gate, the email, the
// side-effect-free landing page, and the rules that keep a seven-day token safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { founderEmails, isFounder } from "./founder.ts";
import { INVITATION_FALLBACK, INVITATION_LINE, INVITATION_LINK_DAYS, INVITATION_SUBJECT, invitationEmail, invitationExpiry } from "./invitation.ts";

const read = (p: string) => readFileSync(p, "utf8");
const codeOf = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
function sourceFiles(dir = "src", acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) && !/ \d+\.[a-z]+$/.test(p)) acc.push(p);
  }
  return acc;
}

// ---------------------------------------------------------------------------
test("only the allowlisted addresses are founders", () => {
  const env = { FOUNDER_EMAILS: " Owner@Example.com , second@example.com " } as NodeJS.ProcessEnv;
  assert.deepEqual(founderEmails(env), ["owner@example.com", "second@example.com"]);
  for (const yes of ["owner@example.com", "OWNER@example.com", " owner@example.com "]) assert.ok(isFounder(yes, env), yes);
  for (const no of ["", null, undefined, "someone@example.com", "owner@example.com.attacker.test"]) assert.ok(!isFounder(no, env), String(no));
  // Unset means nobody, never everybody.
  assert.deepEqual(founderEmails({} as NodeJS.ProcessEnv), []);
  assert.equal(isFounder("owner@example.com", {} as NodeJS.ProcessEnv), false);
  assert.equal(isFounder("", { FOUNDER_EMAILS: "" } as NodeJS.ProcessEnv), false);
});

test("the invitation email is the approved copy, and carries the link once", () => {
  const url = "https://sendset.io/invited?token=abc-123";
  const { subject, html, text } = invitationEmail({ url });
  assert.equal(subject, "You're invited to Sendset");
  assert.equal(INVITATION_SUBJECT, subject);
  assert.equal(INVITATION_LINE, "Sendset is currently in early access, and your invitation is ready.");
  assert.equal(INVITATION_FALLBACK, "If the button doesn't work, go to sendset.io/login and use the same email address this invitation was sent to.");
  for (const part of [INVITATION_LINE, INVITATION_FALLBACK]) {
    assert.ok(html.includes(part), `the HTML lost: ${part}`);
    assert.ok(text.includes(part), `the plain text lost: ${part}`);
  }
  assert.ok(html.includes(`href="${url}"`) && html.includes(">Get started</a>"), "the primary action is missing");
  assert.equal((html.match(/abc-123/g) ?? []).length, 1, "the token should appear once, in the button");
  assert.ok(text.includes(`Get started: ${url}`));
  assert.ok(!html.includes("invite code") && !text.includes("invite code"), "an invitation must not ask for a code");
});

test("an invitation link lives seven days, and ordinary sign-in still fifteen minutes", () => {
  assert.equal(INVITATION_LINK_DAYS, 7);
  const now = new Date("2026-09-16T00:00:00.000Z");
  assert.equal(invitationExpiry(now).toISOString(), "2026-09-23T00:00:00.000Z");
  const signIn = codeOf("src/app/api/auth/send-magic-link/route.ts");
  assert.match(signIn, /15 \* 60 \* 1000/, "ordinary sign-in links must stay short-lived");
  assert.doesNotMatch(signIn, /INVITATION_LINK_DAYS|invitationExpiry/, "the sign-in route must not borrow the invitation lifetime");
  assert.match(codeOf("src/lib/invitation-server.ts"), /expires_at: invitationExpiry\(\)\.toISOString\(\)/);
});

// ---------------------------------------------------------------------------
// The founder gate
// ---------------------------------------------------------------------------
test("the founder surfaces check the server, and hide themselves from everyone else", () => {
  const page = codeOf("src/app/invites/page.tsx");
  assert.match(page, /const founder = await founderSession\(db\);\s*if \(!founder\) notFound\(\);/, "the page must 404 for non-founders");
  const gate = codeOf("src/lib/invitation-server.ts");
  assert.match(gate, /const session = await getSession\(\);\s*if \(!session\) return null;/);
  assert.match(gate, /isFounder\(email\) \? \{ userId: session\.userId, email: email! \} : null/, "the allowlist decides, not the request");
  for (const route of ["src/app/api/invites/approve/route.ts", "src/app/api/invites/resend/route.ts"]) {
    const src = codeOf(route);
    assert.match(src, /const founder = await founderSession\(db\);\s*if \(!founder\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\);/,
      `${route} does not re-check on the server`);
    const gateAt = src.indexOf("founderSession");
    assert.ok(gateAt < src.indexOf("rpc("), `${route} does work before checking who is asking`);
    assert.doesNotMatch(src, /body\.(email|founder|isFounder)/, `${route} takes identity from the request body`);
  }
});

test("the founder page knows which addresses can already sign in", () => {
  const page = codeOf("src/app/invites/page.tsx");
  assert.match(page, /\.from\("users"\)\s*\.select\("email"\)\s*\.in\("email", requests\.map\(\(r\) => r\.email\)\)/,
    "the page must look up which requested addresses already have accounts");
  assert.match(page, /hasAccount: withAccounts\.has\(r\.email\)/);
  const list = codeOf("src/components/invite-request-list.tsx");
  assert.match(list, /const hasAccount = r\.hasAccount \|\| existing\[r\.id\];/);
  assert.match(list, /\{approved && hasAccount && \([\s\S]{0,200}Already has an account/);
  assert.match(list, /\{approved && !hasAccount && \([\s\S]{0,200}Send again/,
    "Send again must be offered only where an invitation exists");
  assert.match(list, /if \(data\.status === "has_account"\) setExisting/);
});

test("approving twice sends one invitation; sending again is its own action", () => {
  const approveFile = codeOf("src/app/api/invites/approve/route.ts");
  const approve = approveFile.slice(approveFile.indexOf("export async function POST"));
  const alreadyAt = approve.indexOf('result.status === "already_approved"');
  const sendAt = approve.indexOf("sendInvitation(");
  assert.ok(alreadyAt > 0 && alreadyAt < sendAt, "an already-approved request must return before anything is sent");
  assert.match(approve, /if \(sent\.sent\) await db\.rpc\("record_invitation_sent"/, "a send is recorded only when it happened");
  assert.match(approve, /result\.status === "has_account"/, "an address that can already sign in must not be invited");
  const resend = codeOf("src/app/api/invites/resend/route.ts");
  assert.match(resend, /if \(!row\.approved_at\) return NextResponse\.json\(\{ error: "not_approved"/, "resend must not approve anything");
  assert.doesNotMatch(resend, /approve_early_access_request/, "resend must not approve");
  assert.match(codeOf("src/lib/invitation-server.ts"), /from\("magic_links"\)\.insert\(/, "resend issues a fresh link");
  assert.doesNotMatch(codeOf("src/lib/invitation-server.ts"), /invite_codes/, "sending must not touch the reservation");
});

// ---------------------------------------------------------------------------
// The seven-day token
// ---------------------------------------------------------------------------
test("opening the emailed link only reads: no account, no spent link, no consumed invitation", () => {
  const page = codeOf("src/app/invited/page.tsx");
  assert.match(page, /\.from\("magic_links"\)\s*\.select\("used, expires_at"\)/, "the page should look the link up and nothing more");
  for (const banned of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.rpc\(/, /createSession/]) {
    assert.doesNotMatch(page, banned, `the landing page has a side effect: ${banned}`);
  }
  // Accepting is a POST, and the token travels in its body.
  const accept = codeOf("src/app/api/auth/accept-invitation/route.ts");
  assert.match(accept, /export async function POST\(/);
  assert.doesNotMatch(accept, /export async function GET\(/, "accepting must never be reachable by a GET");
  assert.match(accept, /const token = typeof body\.token === "string"/);
  assert.match(accept, /rpc\("redeem_bound_invite", \{ p_magic_token: token \}\)/);
  assert.match(codeOf("src/components/accept-invitation.tsx"), /body: JSON\.stringify\(\{ token \}\)/);
});

test("the token is not written to logs, and does not leak through a Referer", () => {
  for (const file of ["src/app/api/auth/accept-invitation/route.ts", "src/app/invited/page.tsx",
                      "src/lib/invitation-server.ts", "src/app/api/invites/approve/route.ts", "src/app/api/invites/resend/route.ts"]) {
    const src = codeOf(file);
    // A link may be printed in ONE place: the development branch that runs only
    // when no mailer is configured, which is what the sign-in route already
    // does. In production RESEND_API_KEY is set and it never runs.
    const devBranch = src.includes("if (!key) {") ? src.slice(src.indexOf("if (!key) {"), src.indexOf("return { sent: false, reason: \"no_mailer\" };")) : "";
    for (const line of src.match(/console\.(log|error|warn)\([\s\S]{0,200}?\);/g) ?? []) {
      if (devBranch && devBranch.includes(line)) continue;
      assert.doesNotMatch(line, /(?<![.\w])(token|url|magicLinkUrl|invitationUrl)(?![\w:])/, `${file} logs the token: ${line}`);
    }
  }
  const server = codeOf("src/lib/invitation-server.ts");
  assert.equal((server.match(/console\.log\(/g) ?? []).length, 1, "only the development fallback may print a link");
  assert.ok(server.indexOf("if (!key) {") < server.indexOf("console.log("), "the printed link must be behind the no-mailer branch");
  const config = codeOf("next.config.ts");
  const invited = config.slice(config.indexOf('source: "/invited"'));
  assert.match(invited, /key: "Referrer-Policy", value: "no-referrer"/, "/invited must send no Referer");
  assert.match(invited, /key: "X-Robots-Tag", value: "noindex, nofollow"/, "/invited must not be indexed");
  assert.match(read("src/app/invited/page.tsx"), /robots: \{ index: false, follow: false \}/);
  // Analytics would be the other way a URL escapes: there is none.
  assert.deepEqual(sourceFiles().filter((f) => /analytics|gtag|mixpanel|segment\.com|posthog/i.test(codeOf(f))), []);
});

test("an invitation that expires falls back to ordinary sign-in, which claims it", () => {
  const verify = codeOf("src/app/api/auth/verify/route.ts");
  const claimAt = verify.indexOf('rpc("redeem_bound_invite"');
  const joinAt = verify.indexOf("`${appUrl}/join`");
  assert.ok(claimAt > 0 && claimAt < joinAt, "verify must try the invitation before asking for a typed code");
  assert.match(verify, /if \(claimError && \(claimError as \{ details\?: string \| null \}\)\.details !== "no_invitation"\)/,
    "only 'no invitation' may fall through to the code screen");
  assert.match(verify, /await createSession\(\(claimed as \{ userId: string \}\)\.userId\)/);
  const invited = read("src/app/invited/page.tsx");
  assert.match(invited, /already been used or has expired/);
  assert.ok(invited.includes("INVITATION_FALLBACK"), "the expired page must say which address to use");
});

test("the typed-code path survives untouched, as the direct-invite escape hatch", () => {
  assert.match(codeOf("src/app/api/auth/redeem-invite/route.ts"), /rpc\("redeem_invite"/);
  assert.match(read("src/app/join/page.tsx"), /Enter your invite code to continue\./);
  const scripts = read("scripts/invites/invites.mts");
  assert.match(scripts, /generateInviteCode\(\)/);
  assert.match(scripts, /code_hash: inviteCodeHash\(normalizeInviteCode\(code\)\)/);
  // One door for account creation, still: three callers, one function each.
  const creators = sourceFiles().filter((f) => /rpc\("(redeem_invite|redeem_bound_invite)"/.test(codeOf(f)));
  assert.deepEqual(creators.sort(), [
    join("src", "app", "api", "auth", "accept-invitation", "route.ts"),
    join("src", "app", "api", "auth", "redeem-invite", "route.ts"),
    join("src", "app", "api", "auth", "verify", "route.ts"),
  ]);
  assert.deepEqual(sourceFiles().filter((f) => /from\("users"\)[\s\S]{0,80}\.insert\(/.test(codeOf(f))), [],
    "an account is created outside the invite functions");
});

test("the migration keeps both redemptions on one account-creation body", () => {
  const sql = read("supabase/migrations/0056_invitations.sql");
  assert.match(sql, /create function public\.consume_link_and_create_account\(p_link_id uuid, p_email text, p_invite_id uuid\)/);
  for (const fn of ["redeem_invite(p_magic_token text, p_code_hash text)", "redeem_bound_invite(p_magic_token text)"]) {
    const start = sql.indexOf(`function public.${fn}`);
    const body = sql.slice(start, sql.indexOf("$$;", start));
    assert.ok(start > 0 && body.includes("return public.consume_link_and_create_account(v_link.id, v_link.email, v_invite);"),
      `${fn} does not create the account through the shared body`);
    assert.doesNotMatch(body, /insert into public\.users/, `${fn} creates accounts on its own`);
  }
  assert.match(sql, /revoke all on function public\.consume_link_and_create_account\(uuid, text, uuid\) from public, anon, authenticated, service_role;/);
  assert.match(sql, /create unique index invite_codes_one_live_reservation_per_email/);
});
