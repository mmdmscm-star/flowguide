// EARLY ACCESS: invite codes, the request form, and where an account can be made.
//
// The database half (atomic redemption, races, revocation, grants) is proved in
// scripts/pg-harness/test-0055.mjs. These cover the code that surrounds it and
// the rules that keep the gate the only door.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { INVITE_CODE_LENGTH, generateInviteCode, inviteCodeHash, isPlausibleInviteCode, normalizeInviteCode } from "./invite-code.ts";
import { MAX_PER_EMAIL_PER_DAY, MAX_PER_HOUR, notificationEmail, storeEarlyAccessRequest, validateEarlyAccess } from "./early-access.ts";

// ---------------------------------------------------------------------------
test("a code is 100 bits in an alphabet without look-alikes, grouped for reading", () => {
  const code = generateInviteCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(normalizeInviteCode(code).length, INVITE_CODE_LENGTH);
  assert.doesNotMatch(code, /[ILOU]/, "I, L, O and U are excluded so a code can be read aloud");
  const many = Array.from({ length: 500 }, generateInviteCode);
  assert.equal(new Set(many).size, 500, "codes repeated");
  const symbols = new Set(many.join("").replace(/-/g, ""));
  assert.ok(symbols.size >= 30, `only ${symbols.size} symbols ever appear — the generator is biased`);
});

test("typing it back forgives case, spacing and the three confusable characters", () => {
  const code = "HTG4M-9XQ2K-7VPZB-3NDR6";
  const canonical = normalizeInviteCode(code);
  for (const typed of [code, code.toLowerCase(), ` ${code} `, code.replace(/-/g, " "), code.replace(/-/g, "")]) {
    assert.equal(normalizeInviteCode(typed), canonical, `not forgiven: ${typed}`);
  }
  assert.equal(normalizeInviteCode("OI L0"), "0110", "O, I and L map to 0 and 1");
  assert.ok(isPlausibleInviteCode(canonical));
  for (const bad of ["", "SHORT", canonical + "X", canonical.slice(0, 19) + "U"]) {
    assert.equal(isPlausibleInviteCode(normalizeInviteCode(bad)), false, `accepted as plausible: ${bad}`);
  }
});

test("only the hash leaves this file, and it is the hash of the normalised code", () => {
  const code = generateInviteCode();
  const hash = inviteCodeHash(normalizeInviteCode(code));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(normalizeInviteCode(code).slice(0, 6)), "the code shows through its hash");
  assert.equal(inviteCodeHash(normalizeInviteCode(code.toLowerCase())), hash, "a differently typed code hashes differently");
  assert.notEqual(inviteCodeHash(normalizeInviteCode(generateInviteCode())), hash);
});

// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
function fakeDb(rows: Row[] = [], { failCount = false, failInsert = false } = {}) {
  const inserted: Row[] = [];
  const counted: { email?: string; since?: string }[] = [];
  const db = {
    inserted, counted,
    from() {
      let filtered = [...rows];
      let email: string | undefined;
      const q = {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => { void opts; return q; },
        eq: (col: string, v: string) => { if (col === "email") { email = v; filtered = filtered.filter((r) => r.email === v); } return q; },
        gte: (col: string, v: string) => {
          filtered = filtered.filter((r) => String(r[col]) >= v);
          counted.push({ email, since: v });
          return Promise.resolve(failCount ? { count: null, error: { message: "down" } } : { count: filtered.length, error: null });
        },
        insert: async (row: Row) => { if (failInsert) return { error: { message: "down" } }; inserted.push(row); return { error: null }; },
      };
      return q;
    },
  };
  return db;
}
const REQUEST = { name: " Jane Doe ", email: " Jane@Example.com ", useCase: "Sending venue options to families." };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("a good request is stored once, trimmed, with the email lowercased", async () => {
  const db = fakeDb();
  assert.deepEqual(await storeEarlyAccessRequest(db as never, REQUEST), { status: 200, stored: true });
  assert.deepEqual(db.inserted, [{ name: "Jane Doe", email: "jane@example.com", use_case: "Sending venue options to families." }]);
});

test("what the form refuses, and in the person's words", async () => {
  const cases: [string, Row][] = [
    ["no name", { ...REQUEST, name: "   " }],
    ["no email", { ...REQUEST, email: "" }],
    ["malformed email", { ...REQUEST, email: "not-an-email" }],
    ["no use case", { ...REQUEST, useCase: "" }],
    ["a 2001-character use case", { ...REQUEST, useCase: "x".repeat(2001) }],
    ["a 201-character name", { ...REQUEST, name: "x".repeat(201) }],
  ];
  for (const [label, input] of cases) {
    const db = fakeDb();
    const out = await storeEarlyAccessRequest(db as never, input);
    assert.equal(out.status, 400, `${label} was accepted`);
    assert.match((out as { message: string }).message, /^Please /, `${label}: unhelpful message`);
    assert.deepEqual(db.inserted, [], `${label} was stored anyway`);
  }
  assert.equal(validateEarlyAccess(REQUEST).ok, true);
});

test("the honeypot is answered like any request and stored nowhere", async () => {
  const db = fakeDb();
  assert.deepEqual(await storeEarlyAccessRequest(db as never, { ...REQUEST, website: "https://spam.example" }), { status: 200, stored: false });
  assert.deepEqual(db.inserted, []);
  assert.deepEqual(db.counted, [], "a bot's submission should not even cost a query");
});

test("small limits: per email per day, and overall per hour", async () => {
  const mine = Array.from({ length: MAX_PER_EMAIL_PER_DAY }, () => ({ email: "jane@example.com", created_at: ago(60_000) }));
  const perEmail = await storeEarlyAccessRequest(fakeDb(mine) as never, REQUEST);
  assert.equal(perEmail.status, 429);
  assert.match((perEmail as { message: string }).message, /already sent a request/);

  const others = Array.from({ length: MAX_PER_HOUR }, (_, i) => ({ email: `p${i}@example.com`, created_at: ago(60_000) }));
  const perHour = await storeEarlyAccessRequest(fakeDb(others) as never, REQUEST);
  assert.equal(perHour.status, 429);
  assert.match((perHour as { message: string }).message, /try again a little later/);

  const stale = Array.from({ length: MAX_PER_HOUR }, (_, i) => ({ email: `p${i}@example.com`, created_at: ago(2 * 60 * 60 * 1000) }));
  assert.deepEqual(await storeEarlyAccessRequest(fakeDb(stale) as never, REQUEST), { status: 200, stored: true }, "yesterday's requests still count against today");
});

test("a database that cannot answer says so instead of pretending", async () => {
  assert.equal((await storeEarlyAccessRequest(fakeDb([], { failCount: true }) as never, REQUEST)).status, 503);
  assert.equal((await storeEarlyAccessRequest(fakeDb([], { failInsert: true }) as never, REQUEST)).status, 503);
});

test("the owner's notification escapes what the requester wrote", () => {
  const { subject, html } = notificationEmail({ name: "Jane <script>alert(1)</script>", email: "jane@example.com", useCase: "A & B \"quoted\"" });
  assert.match(subject, /^Sendset early access: Jane/);
  assert.ok(!html.includes("<script>"), "unescaped markup reached the notification");
  assert.ok(html.includes("&lt;script&gt;") && html.includes("A &amp; B"));
});

// ---------------------------------------------------------------------------
// The gate: where an account can be created, and what must never leak
// ---------------------------------------------------------------------------
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

test("nothing in the app creates an account except redeem_invite", () => {
  const writers = sourceFiles().filter((f) => /from\("users"\)[\s\S]{0,80}\.insert\(/.test(codeOf(f)));
  assert.deepEqual(writers, [], "an account is created outside the invite gate");
  const callers = sourceFiles().filter((f) => codeOf(f).includes('rpc("redeem_invite"'));
  assert.deepEqual(callers, [join("src", "app", "api", "auth", "redeem-invite", "route.ts")], "redeem_invite is reachable from more than one route");
  const verify = codeOf("src/app/api/auth/verify/route.ts");
  assert.doesNotMatch(verify, /\.insert\(/, "verify still writes rows for a new email");
  assert.match(verify, /if \(!user\) \{[\s\S]{0,900}redirect\(`\$\{appUrl\}\/join`\)/, "a new email is not sent to the invite page");
  assert.match(verify, /cookies\.set\(SIGNUP_COOKIE, token, \{[\s\S]{0,200}httpOnly: true/, "the signup cookie must be httpOnly");
  assert.match(verify, /await createSession\(user\.id\)/, "an existing account must still sign in");
  // Exactly one session is ever created here, and it belongs to an account
  // that already existed: a new email leaves with a cookie and no session.
  assert.equal((verify.match(/createSession\(/g) ?? []).length, 1, "verify creates a session somewhere else too");
  assert.ok(verify.indexOf("await createSession(user.id)") > verify.indexOf(`redirect(\`\${appUrl}/join\`)`),
    "a session is created before the new-email branch returns");
});

test("the invite code never reaches a URL, a log or the database in the clear", () => {
  const redeem = codeOf("src/app/api/auth/redeem-invite/route.ts");
  assert.match(redeem, /const token = \(await cookies\(\)\)\.get\(SIGNUP_COOKIE\)\?\.value;/, "the verified link must come from the httpOnly cookie");
  assert.doesNotMatch(redeem, /body\.(token|magic|email)/, "the request body must not be able to name the link or the account");
  assert.match(redeem, /const body = await request\.json\(\)/, "the code must arrive in the body");
  assert.match(redeem, /p_code_hash: inviteCodeHash\(normalized\)/, "the plaintext code must not be sent to the database");
  assert.doesNotMatch(redeem, /searchParams|URLSearchParams/, "a code in a URL would reach logs and history");
  for (const log of redeem.match(/console\.(log|error|warn)\([\s\S]{0,160}?\);/g) ?? []) {
    assert.doesNotMatch(log, /(?<![.\w])(code|normalized|body)(?![\w:])/, `a log line carries the code: ${log}`);
  }
  const joinForm = codeOf("src/components/join-form.tsx");
  assert.match(joinForm, /body: JSON\.stringify\(\{ code \}\)/);
  assert.doesNotMatch(joinForm, /\?code=|searchParams/);
  // The one place a plaintext code exists is the terminal that created it.
  const printers = sourceFiles().filter((f) => codeOf(f).includes("generateInviteCode"));
  assert.deepEqual(printers, [join("src", "lib", "invite-code.ts")], "a code is generated inside the app");
});

test("the early-access route stores first and notifies best-effort", () => {
  const file = codeOf("src/app/api/early-access/route.ts");
  const route = file.slice(file.indexOf("export async function POST"));
  const stored = route.indexOf("storeEarlyAccessRequest");
  const mail = route.indexOf("api.resend.com");
  assert.ok(stored > 0 && mail > stored, "the notification must come after the row exists");
  assert.match(route, /try \{[\s\S]{0,700}catch \(e\)/, "a mail failure must not fail the request");
  assert.match(route, /signal: AbortSignal\.timeout\(4000\)/, "the notification must not hang the response");
  assert.doesNotMatch(route, /console\.error\([^)]*use_case|useCase/, "the request's words must stay out of the log");
  assert.match(route, /return NextResponse\.json\(\{ ok: true, message: THANKS \}\);\s*\}\s*$/, "the answer is the same whether or not the note was sent");
});

test("the copy says what it should, and the ways in are where they should be", () => {
  assert.match(read("src/app/join/page.tsx"), /Sendset is currently in early access\. Enter your invite code to continue\./);
  assert.match(read("src/components/join-form.tsx"), /Don&rsquo;t have a code\?\{" "\}[\s\S]{0,200}Request early access\./);
  assert.match(read("src/app/early-access/page.tsx"), /I&rsquo;m opening Sendset gradually while I work closely with the first users\./);
  const home = read("src/app/page.tsx");
  assert.equal((home.match(/Request early access/g) ?? []).length, 2, "both homepage actions should lead to early access");
  assert.equal((home.match(/href="\/early-access"/g) ?? []).length, 2);
  assert.ok(home.includes('<Link href="/login" className="text-base font-medium text-muted underline-offset-4 hover:underline">'), "existing users lost their way in");
  assert.doesNotMatch(home, /Start your first Sendset/, "the old signup call to action is still there");
  assert.match(read("src/app/login/page.tsx"), /New to Sendset\?\{" "\}[\s\S]{0,200}Request early access\./);
  assert.match(read("src/app/login/page.tsx"), /"signup-expired": "Your sign-in link expired/);
  // The public Sendset pages and the demos stay public: nothing here touches them.
  assert.doesNotMatch(codeOf("src/app/p/[slug]/page.tsx"), /SIGNUP_COOKIE|invite/i);
});

test("the join page needs a verified link, not just a visit", () => {
  const page = codeOf("src/app/join/page.tsx");
  assert.match(page, /cookies\(\)\)\.get\(SIGNUP_COOKIE\)/);
  assert.match(page, /if \(!pending\) redirect\("\/login\?error=signup-expired"\)/);
});
