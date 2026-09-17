// SENDSET RESPONSES — the app half of 0058.
//
// The database half is proved in scripts/pg-harness/test-0058.mjs. What is
// pinned here is everything the database cannot see: the marker surviving the
// application untouched, the endpoint's order, persistence before email, the
// email's recipient and wording, what a recipient page may and may not show, and
// the words the owner reads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import {
  MARKER_SHAPE, parseResponseBody, responseEmail, stalenessLabel, notificationLabel,
  responseCountLabel, respondHeading, IDENTITY_NOTE, RESPONSE_OUTCOME,
} from "./responses.ts";

const raw = (p: string) => readFileSync(p, "utf8");
/** Every source file under a directory, tests excluded. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}
/** Source with comments removed, so a comment explaining a rule cannot satisfy
 *  or break the rule's guard. */
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

// The message handler moved out of the route when the endpoints moved under
// /p/[slug]; both paths delegate to this one implementation.
const ROUTE = "src/lib/respond-handler.ts";
const CANONICAL_ROUTE = "src/app/p/[slug]/respond/route.ts";
const LEGACY_ROUTE = "src/app/api/p/[slug]/responses/route.ts";
const PANEL = "src/components/respond-panel.tsx";
const PAGE = "src/app/p/[slug]/page.tsx";

// A marker as PostgREST renders published_at: microseconds and an offset.
const MARKER = "2026-09-15T19:13:23.490556+00:00";
const good = { marker: MARKER, name: "Lisa", contact: "", message: "Is Saturday still open?", website: "" };

// ---------------------------------------------------------------------------
// THE MARKER IS AN OPAQUE STRING
// ---------------------------------------------------------------------------

test("the marker shape is exactly the database's", () => {
  const sql = raw("supabase/migrations/0058_sendset_responses.sql");
  const dbPattern = sql.match(/p_rendered_published_at !~ '([^']+)'/)?.[1];
  assert.equal(dbPattern, MARKER_SHAPE.source, "the app and the database disagree about a marker's shape");
  for (const ok of [MARKER, "2026-09-15T19:13:23Z", "2026-09-15T19:13:23.4+00:00", "2026-09-15T12:13:23.490556-07:00"])
    assert.ok(MARKER_SHAPE.test(ok), ok);
  for (const bad of ["", "yesterday", "2026-09-15 19:13:23+00:00", "2026-09-15T19:13:23.4905561+00:00", "2026-09-15T19:13:23"])
    assert.ok(!MARKER_SHAPE.test(bad), bad);
});

test("the marker leaves the parser exactly as it arrived — microseconds intact", () => {
  const r = parseResponseBody(good);
  assert.ok(r.ok);
  assert.equal(r.marker, MARKER);
  // The hazard this guards: a JS date keeps milliseconds only.
  assert.notEqual(new Date(MARKER).toISOString(), MARKER.replace("+00:00", "Z"));
});

test("NO DATE ANYWHERE ON THE MARKER'S PATH", () => {
  const q = codeOf("src/lib/queries.ts");
  const pageReader = q.slice(q.indexOf("export async function getPublishedPacketForPage"), q.indexOf("export async function publishedSenderIdentity"));
  const markerRead = q.slice(q.indexOf("export async function currentPublicationMarker"), q.indexOf("export async function readPublication"));
  const readPub = q.slice(q.indexOf("export async function readPublication"), q.indexOf("function recipientPacket"));
  assert.ok(pageReader.length > 200 && markerRead.length > 100 && readPub.length > 100, "a reader moved; re-scope this");
  const owner = codeOf("src/lib/owner-responses.ts");
  for (const [where, src] of [
    [PANEL, codeOf(PANEL)], [ROUTE, codeOf(ROUTE)], [PAGE, codeOf(PAGE)], ["responses.ts", codeOf("src/lib/responses.ts")],
    ["getPublishedPacketForPage", pageReader], ["currentPublicationMarker", markerRead], ["readPublication", readPub],
    ["owner-responses.ts", owner],
  ] as const) {
    assert.doesNotMatch(src, /new Date\(|Date\.parse|Date\.UTC|toISOString|toLocale|date-fns|dayjs|moment\(/, `${where} handles a date`);
  }
  // The page passes the marker straight through to the panel, which posts it as given.
  assert.match(codeOf(PAGE), /<RespondPanel slug=\{slug\} marker=\{responseMarker\}/);
  assert.match(codeOf(PANEL), /JSON\.stringify\(\{ marker, name, contact, message, website \}\)/);
  assert.match(codeOf(ROUTE), /p_rendered_published_at: parsed\.marker,/);
  // The item-action path carries the same marker under the same rule.
  assert.match(codeOf("src/app/p/[slug]/actions/route.ts"), /p_rendered_published_at: parsed\.marker,/);
  for (const f of ["src/app/p/[slug]/actions/route.ts", "src/lib/item-actions.ts", "src/lib/capability.ts",
                   "src/components/hearts/hearts-provider.tsx"]) {
    assert.doesNotMatch(codeOf(f), /new Date\(|Date\.parse|Date\.UTC|toISOString|toLocale|date-fns|dayjs|moment\(/,
      `${f} handles a date`);
  }
});

test("staleness is decided by Postgres equality, never by ordering", () => {
  const owner = codeOf("src/lib/owner-responses.ts");
  assert.match(owner, /\.eq\("live_publication_published_at", current\)/);
  assert.doesNotMatch(owner, /\.(lt|lte|gt|gte|order)\("live_publication_published_at"/);
  assert.doesNotMatch(owner, /published_at[^\n]*[<>]|[<>][^\n]*published_at/);
});

// ---------------------------------------------------------------------------
// THE REQUEST BODY
// ---------------------------------------------------------------------------

test("v1 requires a name and a message; contact is optional", () => {
  assert.deepEqual(parseResponseBody({ ...good, name: "  " }), { ok: false, field: "name", message: "Add your name." });
  assert.deepEqual(parseResponseBody({ ...good, message: "\n\t " }), { ok: false, field: "message", message: "Write a message." });
  const r = parseResponseBody({ ...good, contact: "   " });
  assert.ok(r.ok && r.contact === null);
  const withContact = parseResponseBody({ ...good, contact: " lisa@example.com " });
  assert.ok(withContact.ok && withContact.contact === "lisa@example.com");
});

test("trimming and length match the database CHECKs exactly", () => {
  // The database trims space, tab, CR and LF — not a no-break space. Trimming
  // more here would accept a value the CHECK then refuses as a 500.
  const nbsp = parseResponseBody({ ...good, name: "\u00a0Lisa\u00a0" });
  assert.ok(nbsp.ok && nbsp.name === "\u00a0Lisa\u00a0");
  const r = parseResponseBody({ ...good, name: "\t Lisa \r\n" });
  assert.ok(r.ok && r.name === "Lisa");
  // Code points, as char_length counts: 120 emoji is 240 UTF-16 units and allowed.
  assert.ok(parseResponseBody({ ...good, name: "😀".repeat(120) }).ok);
  assert.equal(parseResponseBody({ ...good, name: "a".repeat(121) }).ok, false);
  assert.equal(parseResponseBody({ ...good, contact: "a".repeat(201) }).ok, false);
  assert.ok(parseResponseBody({ ...good, message: "a".repeat(4000) }).ok);
  assert.equal(parseResponseBody({ ...good, message: "a".repeat(4001) }).ok, false);
  const sql = raw("supabase/migrations/0058_sendset_responses.sql");
  assert.match(sql, /char_length\(responder_name\) between 1 and 120/);
  assert.match(sql, /char_length\(responder_contact\) between 1 and 200/);
  assert.match(sql, /char_length\(note\) between 1 and 4000/);
});

test("a malformed or missing marker is refused before anything else", () => {
  for (const marker of [undefined, null, 42, "", "not a time"]) {
    const r = parseResponseBody({ ...good, marker, name: "" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.field, "form", "the marker must be checked first");
  }
  for (const body of [null, "string", [], 7]) assert.equal(parseResponseBody(body).ok, false);
});

test("the honeypot is recognised but the body is still validated", () => {
  const r = parseResponseBody({ ...good, website: "http://spam.example" });
  assert.ok(r.ok && r.honeypot === true);
  assert.ok(parseResponseBody(good).ok && !(parseResponseBody(good) as { honeypot: boolean }).honeypot);
});

// ---------------------------------------------------------------------------
// THE ENDPOINT'S ORDER
// ---------------------------------------------------------------------------

test("same-origin → shape → honeypot → demo → owner → record → email → answer", () => {
  const src = codeOf(ROUTE);
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  const order = [
    'request.headers.get("sec-fetch-site")',
    "parseResponseBody(body)",
    "if (parsed.honeypot)",
    "if (isPublicDemo(slug))",
    "await getSession()",
    'rpc("record_sendset_response"',
    "if (stored.notificationDue)",
    "await notifyOwnerOfResponse(",
    "message: RESPONSE_OUTCOME.sent }",
  ].map(at);
  // The last "sent" answer — the honeypot's comes earlier by design.
  const lastSent = src.lastIndexOf("message: RESPONSE_OUTCOME.sent }");
  order[order.length - 1] = lastSent;
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `step ${i} is out of order`);
  // Nothing touches the database before the shape is checked.
  const beforeShape = src.slice(0, at("parseResponseBody(body)"));
  assert.doesNotMatch(beforeShape, /createServerClient\(\)|\.rpc\(|\.from\(/);
  // The honeypot answers exactly what a real send answers, and stores nothing.
  const honeypot = src.slice(at("if (parsed.honeypot)"), at("if (isPublicDemo(slug))"));
  assert.match(honeypot, /answer\(200, \{ ok: true, message: RESPONSE_OUTCOME\.sent \}\)/);
  assert.doesNotMatch(honeypot, /rpc|from\(/);
  // The owner is refused before anything is written.
  const owner = src.slice(at("await getSession()"), at('rpc("record_sendset_response"'));
  assert.match(owner, /\.eq\("user_id", session\.userId\)[\s\S]*if \(owned\) return answer\(403/);
  // Nothing identifying about the requester is read.
  assert.doesNotMatch(src, /x-forwarded-for|x-real-ip|user-agent|cookies\(\)/i);
});

test("every refusal is worded so it cannot reveal whether the Sendset exists", () => {
  const src = codeOf(ROUTE);
  assert.match(src, /error\.code === "PT404"\) return notAccepting\(\)/);
  assert.match(src, /if \(isPublicDemo\(slug\)\) return notAccepting\(\)/);
  assert.equal(RESPONSE_OUTCOME.notAccepting, "This Sendset isn\u2019t accepting responses right now.");
  // Sent promises nothing and echoes nothing.
  assert.equal(RESPONSE_OUTCOME.sent, "Sent.");
});

test("the two paths to a message are ONE handler, and the legacy one says only that it was used", () => {
  const canonical = codeOf(CANONICAL_ROUTE), legacy = codeOf(LEGACY_ROUTE);
  for (const [name, src] of [["canonical", canonical], ["legacy", legacy]] as const) {
    assert.match(src, /handleRespond\(request, slug\)/, `${name} does not delegate to the shared handler`);
    assert.doesNotMatch(src, /record_sendset_response|parseResponseBody/, `${name} holds its own copy of the body`);
  }
  assert.match(legacy, /console\.log\("\[responses\] legacy endpoint used"\)/);
  for (const [, arg] of legacy.matchAll(/console\.\w+\(([^)]*)\)/g)) {
    assert.doesNotMatch(arg, /slug|name|contact|message|marker|capability|hash/i, "the legacy signal records who called it");
  }
  // A MESSAGE IS NOT HELD BY A CAPABILITY. The cookie is scoped to /p/<slug>,
  // so the browser sends it here too — and neither path reads it.
  assert.doesNotMatch(legacy + canonical + codeOf(ROUTE), /capabilityFromRequest|CAPABILITY_COOKIE|sendset_actions/);
});

test("new code calls the canonical path; nothing new calls the legacy one", () => {
  const callers = [...filesUnder("src/app"), ...filesUnder("src/components"), ...filesUnder("src/lib")]
    .filter((f) => !/\.test\./.test(f) && f !== LEGACY_ROUTE)
    // Code only: a comment naming the old path is documentation, not a call.
    .filter((f) => /["'`][^"'`]*\/api\/p\/[^"'`]*\/responses/.test(codeOf(f)));
  assert.deepEqual(callers, [], `still calling the legacy endpoint: ${callers.join(", ")}`);
  assert.match(codeOf("src/components/respond-panel.tsx"), /\/p\/\$\{encodeURIComponent\(slug\)\}\/respond/);
});

// ---------------------------------------------------------------------------
// PERSIST FIRST, THEN A CAPPED, BEST-EFFORT EMAIL TO THE OWNER
// ---------------------------------------------------------------------------

type Call = { table?: string; rpc?: string; args?: unknown };
function notifyDb(opts: { email?: string | null; stored?: boolean; wasCurrent?: boolean; title?: string } = {}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      calls.push({ table });
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: async () => {
          if (table === "sendset_responses") {
            return { data: opts.stored === false ? null : { packet_id: "p-1", rendered_publication_was_current: opts.wasCurrent ?? true, packets: { title: opts.title ?? "Harbor options" } }, error: null };
          }
          if (table === "users") return { data: opts.email === null ? null : { email: opts.email ?? "owner@example.com" }, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
    rpc: async (name: string, args: unknown) => { calls.push({ rpc: name, args }); return { error: null }; },
  };
  return { db, calls };
}

async function withMailer<T>(respond: (body: Record<string, unknown>) => Response | Promise<Response>, fn: (sent: Record<string, unknown>[]) => Promise<T>) {
  const sent: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return respond(body);
  }) as unknown as typeof fetch;
  try { return await fn(sent); }
  finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = realKey;
  }
}

const RESPONSE = { responseId: "r-1", ownerUserId: "u-1", name: "Lisa", contact: "lisa@example.com", message: "Call me <b>about</b> Saturday" };

test("the email goes to the owner's ACCOUNT address, with no Reply-To, then is recorded", async () => {
  const { notifyOwnerOfResponse } = await import("./response-notify.ts");
  const { db, calls } = notifyDb();
  await withMailer(() => new Response("{}", { status: 200 }), async (sent) => {
    assert.deepEqual(await notifyOwnerOfResponse(db, RESPONSE), { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.com");
    for (const key of Object.keys(sent[0])) assert.doesNotMatch(key, /reply/i, "a Reply-To was set");
    assert.ok(!JSON.stringify(sent[0]).includes('"to":"lisa@example.com"'));
    assert.deepEqual(calls.at(-1), { rpc: "mark_sendset_response_notified", args: { p_response_id: "r-1" } });
  });
  assert.match(codeOf("src/lib/response-notify.ts"), /from\("users"\)\.select\("email"\)\.eq\("id", r\.ownerUserId\)/);
  assert.doesNotMatch(codeOf("src/lib/response-notify.ts"), /professional_profiles|custom_identity|reply_to|replyTo/i);
});

test("a failed, thrown or unconfigured send is swallowed and NOT recorded as sent", async () => {
  const { notifyOwnerOfResponse } = await import("./response-notify.ts");
  for (const respond of [() => new Response("{}", { status: 500 }), () => { throw new TypeError("network"); }]) {
    const { db, calls } = notifyDb();
    await withMailer(respond as () => Response, async () => {
      assert.deepEqual(await notifyOwnerOfResponse(db, RESPONSE), { sent: false });
    });
    assert.ok(!calls.some((c) => c.rpc), "a failed send was marked notified");
  }
  const { db, calls } = notifyDb();
  const realKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const log = console.log; console.log = () => {};
  try { assert.deepEqual(await notifyOwnerOfResponse(db, RESPONSE), { sent: false }); }
  finally { console.log = log; if (realKey !== undefined) process.env.RESEND_API_KEY = realKey; }
  assert.ok(!calls.some((c) => c.rpc));
});

test("the email's staleness comes from the STORED row, not the request", async () => {
  const { notifyOwnerOfResponse } = await import("./response-notify.ts");
  const { db } = notifyDb({ wasCurrent: false });
  await withMailer(() => new Response("{}", { status: 200 }), async (sent) => {
    await notifyOwnerOfResponse(db, RESPONSE);
    assert.match(String(sent[0].text), /Sent from an earlier version of this Sendset\./);
  });
});

test("the subject never carries the responder's words; the body escapes them and labels contact unverified", () => {
  const mail = responseEmail({ sendsetTitle: "Harbor options", name: "Lisa", contact: "lisa@example.com",
    message: "URGENT: your account <script>x</script>", stale: false, responsesUrl: "https://sendset.io/responses/p-1" });
  assert.equal(mail.subject, "New response on \u201cHarbor options\u201d");
  assert.doesNotMatch(mail.subject, /URGENT|Lisa/);
  assert.doesNotMatch(mail.html, /<script>/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(mail.text, /Signed \u201cLisa\u201d/);
  assert.match(mail.text, /Contact, as entered \(not verified\): lisa@example\.com/);
  assert.ok(mail.text.includes(IDENTITY_NOTE));
  assert.doesNotMatch(mail.text + mail.html, /\bFrom Lisa\b|approved|your client/i);
  assert.equal(responseEmail({ sendsetTitle: " ", name: "L", contact: null, message: "m", stale: false, responsesUrl: "u" }).subject,
    "New response on an untitled Sendset");
});

// ---------------------------------------------------------------------------
// THE RECIPIENT PAGE
// ---------------------------------------------------------------------------

function pageDb(packet: Record<string, unknown>, publication: Record<string, unknown> | null) {
  return {
    from(table: string) {
      let rows: Record<string, unknown>[] = table === "packets" ? [packet] : table === "packet_publications" ? (publication ? [publication] : []) : [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        in: () => q, order: () => q,
        single: async () => rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "none" } },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
      };
      return q;
    },
  } as never;
}
const PUB_PACKET = { id: "p-1", slug: "harbor-7k2", status: "published", user_id: "u-1" };
const PUBLICATION = { packet_id: "p-1", format_version: 1, published_at: MARKER,
  content: { slug: "harbor-7k2", clientTitle: "", clientName: "", sections: [], professional: { name: "Dana" } } };

test("the page offers Respond only when the LIVE Sendset accepts it, with the SAME row's marker", async () => {
  const { getPublishedPacketForPage } = await import("./queries.ts");
  const on = await getPublishedPacketForPage("harbor-7k2", pageDb({ ...PUB_PACKET, response_actions: ["respond"] }, PUBLICATION));
  assert.equal(on?.responseMarker, MARKER);
  for (const actions of [[], null, undefined, ["approve"]]) {
    const off = await getPublishedPacketForPage("harbor-7k2", pageDb({ ...PUB_PACKET, response_actions: actions }, PUBLICATION));
    assert.ok(off?.packet, "the Sendset still renders");
    assert.equal(off?.responseMarker, null, `responses offered for ${JSON.stringify(actions)}`);
  }
  // A marker that is not a string is never offered — it is never coerced.
  const odd = await getPublishedPacketForPage("harbor-7k2", pageDb({ ...PUB_PACKET, response_actions: ["respond"] }, { ...PUBLICATION, published_at: 1726427603 }));
  assert.equal(odd?.responseMarker, null);
  // Unpublished: nothing at all.
  assert.equal(await getPublishedPacketForPage("harbor-7k2", pageDb({ ...PUB_PACKET, status: "draft", response_actions: ["respond"] }, PUBLICATION)), null);
});

test("the published copy never carries response settings or responses", async () => {
  const { buildPublicationSnapshot } = await import("./queries.ts");
  const snapshot = await buildPublicationSnapshot(
    pageDb({ ...PUB_PACKET, composition_mode: "legacy", response_actions: ["respond"] }, null), "p-1", { name: "Dana" });
  assert.doesNotMatch(JSON.stringify(snapshot), /respon/i);
});

test("the page mounts the panel only for a non-owner, and nothing else about responses", () => {
  const page = codeOf(PAGE);
  assert.match(page, /\{responseMarker && !ownedId && \(\s*<RespondPanel /);
  assert.match(page, /if \(demo\) return \{ packet: demo, responseMarker: null, likeMarker: null \};/);
  for (const src of [page, codeOf(PANEL)]) {
    assert.doesNotMatch(src, /owner-responses|responseCountLabel|response_count|sendset_responses|IDENTITY_NOTE/,
      "a recipient surface reaches for other people's responses");
  }
  // Preview, print and email never offer it.
  for (const f of ["src/app/preview/[id]/page.tsx", "src/components/preview-surface.tsx", "src/app/p/[slug]/print/page.tsx",
                   "src/app/api/packets/[id]/email/route.ts", "src/lib/email-render.ts"]) {
    assert.doesNotMatch(raw(f), /RespondPanel|responseMarker|\/responses/, `${f} offers Respond`);
  }
  // The panel only ever POSTs.
  const fetches = [...codeOf(PANEL).matchAll(/fetch\(/g)].length;
  assert.equal(fetches, 1);
  assert.match(codeOf(PANEL), /method: "POST"/);
});

test("the heading names the published sender, or nobody", () => {
  assert.equal(respondHeading("Dana Whitfield"), "Send a message to Dana Whitfield");
  assert.equal(respondHeading("  "), "Send a message");
  assert.equal(respondHeading(undefined), "Send a message");
});

// ---------------------------------------------------------------------------
// THE PANEL, DRIVEN
// ---------------------------------------------------------------------------

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Panel: typeof import("../components/respond-panel.tsx").RespondPanel;
const posts: { url: string; body: Record<string, unknown> }[] = [];
let reply: () => Response = () => new Response(JSON.stringify({ ok: true, message: "Sent." }), { status: 200 });

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://sendset.io/p/harbor-7k2", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ RespondPanel: Panel } = await import("../components/respond-panel.tsx"));
});
after(() => dom.window.close());

async function mountPanel() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return reply();
  }) as unknown as typeof fetch;
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Panel, { slug: "harbor-7k2", marker: MARKER, senderName: "Dana" })); });
  return { host, root, restore: () => { globalThis.fetch = realFetch; } };
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
const submit = (host: HTMLElement) => act(async () => {
  host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
});

test("closed, it is one button; opened, a form with name, contact, message and a hidden honeypot", async () => {
  const { host, root, restore } = await mountPanel();
  try {
    assert.equal(host.querySelectorAll("button").length, 1);
    assert.equal(host.querySelector("form"), null, "no form until asked for");
    await click(host.querySelector("button")!);
    assert.equal(host.querySelector("h2")?.textContent, "Send a message to Dana");
    const labels = [...host.querySelectorAll("label")].map((l) => l.textContent);
    assert.deepEqual(labels, ["Your name", "How to reach you (optional)", "Message", "Website"]);
    const trap = host.querySelector('input[name="website"]') as HTMLInputElement;
    assert.equal(trap.tabIndex, -1);
    assert.equal(trap.closest("[aria-hidden]")?.getAttribute("aria-hidden"), "true");
    assert.equal(host.querySelectorAll("[maxlength]").length, 0, "a field would silently truncate");
  } finally { restore(); await act(async () => root.unmount()); }
});

test("a send posts the marker untouched; success replaces the form with Sent. and no echo", async () => {
  posts.length = 0;
  reply = () => new Response(JSON.stringify({ ok: true, message: "Sent." }), { status: 200 });
  const { host, root, restore } = await mountPanel();
  try {
    await click(host.querySelector("button")!);
    await type(host.querySelector('input[name="name"]')!, "Lisa");
    await type(host.querySelector('textarea[name="message"]')!, "Is Saturday still open?");
    await submit(host);
    assert.deepEqual(posts, [{ url: "/p/harbor-7k2/respond",
      body: { marker: MARKER, name: "Lisa", contact: "", message: "Is Saturday still open?", website: "" } }]);
    assert.equal(host.querySelector("form"), null);
    assert.equal(host.textContent, "Sent.");
  } finally { restore(); await act(async () => root.unmount()); }
});

test("a refusal keeps every word they typed and says why", async () => {
  for (const [status, body, where] of [
    [404, { error: "not_accepting", message: RESPONSE_OUTCOME.notAccepting }, "form"],
    [429, { error: "rate_limited", message: RESPONSE_OUTCOME.rateLimited }, "form"],
    [400, { error: "invalid", field: "name", message: "Add your name." }, "name"],
  ] as const) {
    reply = () => new Response(JSON.stringify(body), { status });
    const { host, root, restore } = await mountPanel();
    try {
      await click(host.querySelector("button")!);
      await type(host.querySelector('input[name="name"]')!, "Lisa");
      await type(host.querySelector('textarea[name="message"]')!, "Three paragraphs of careful thought.");
      await submit(host);
      assert.equal((host.querySelector('textarea[name="message"]') as HTMLTextAreaElement).value, "Three paragraphs of careful thought.");
      assert.equal((host.querySelector('input[name="name"]') as HTMLInputElement).value, "Lisa");
      const alert = host.querySelector('[role="alert"]');
      assert.equal(alert?.textContent, body.message);
      if (where === "name") assert.equal(host.querySelector('input[name="name"]')!.getAttribute("aria-invalid"), "true");
      assert.equal((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled, false);
    } finally { restore(); await act(async () => root.unmount()); }
  }
});

// ---------------------------------------------------------------------------
// THE OWNER'S VIEW
// ---------------------------------------------------------------------------

test("a name is a signature, never an author, a vote or a person", () => {
  const list = codeOf("src/components/responses/response-list.tsx");
  assert.match(list, /`Signed (\u201c|\\u201c)\$\{r\.name\}(\u201d|\\u201d)`/);
  assert.match(list, /\{IDENTITY_NOTE\}/);
  assert.match(list, /Contact, as entered \(not verified\)/);
  assert.doesNotMatch(list + codeOf("src/lib/responses.ts"), /\bFrom \$|approved by|\bvotes?\b|\bpeople responded|your client/i);
  assert.equal(IDENTITY_NOTE, "Names and contact details are what the person typed. Sendset doesn\u2019t verify who sent a response.");
  assert.equal(responseCountLabel(1), "1 response");
  assert.equal(responseCountLabel(4), "4 responses");
});

test("staleness and notification labels", () => {
  assert.equal(stalenessLabel(true, false), null);
  assert.equal(stalenessLabel(true, null), null);
  assert.equal(stalenessLabel(true, true), "Sent before your latest update");
  assert.equal(stalenessLabel(false, false), "Sent from an earlier version of this Sendset");
  assert.equal(stalenessLabel(false, null), "Sent from an earlier version of this Sendset");
  assert.doesNotMatch(String(stalenessLabel(false, true)), /view|show|see/i, "an earlier version is offered, but it is not kept");
  assert.equal(notificationLabel(true, "2026-09-17T10:00:00Z"), "Emailed to you");
  assert.equal(notificationLabel(true, null), "Email not sent");
  assert.match(notificationLabel(false, null), /^Not emailed/);
});

test("the owner's reads are scoped to the owner twice, and never reach a recipient", () => {
  const owner = codeOf("src/lib/owner-responses.ts");
  assert.match(owner, /\.from\("packets"\)\.select\("id, title, status, response_actions"\)\.eq\("id", packetId\)\.eq\("user_id", userId\)/);
  assert.equal((owner.match(/\.eq\("owner_user_id", userId\)/g) ?? []).length, 2, "a response read is not owner-scoped");
  const api = codeOf("src/app/api/packets/[id]/responses/route.ts");
  assert.match(api, /if \(!session\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/);
  assert.match(api, /loadOwnerResponses\(id, session\.userId\)/);
  const page = codeOf("src/app/responses/[id]/page.tsx");
  assert.match(page, /if \(!session\) redirect\("\/login"\)/);
  assert.match(page, /loadOwnerResponses\(id, session\.userId\)/);
});

test("the dashboard count is the owner's own, and the list route states it", () => {
  const list = codeOf("src/app/api/packets/route.ts");
  assert.match(list, /sendset_responses\(count\)/);
  assert.match(list, /\.eq\("user_id", session\.userId\)/);
  assert.match(list, /response_count: Number\(embedded\?\.\[0\]\?\.count \?\? 0\)/);
  const dash = codeOf("src/components/dashboard/dashboard-workspace.tsx");
  assert.match(dash, /responseCountLabel\(packet\.response_count\)/);
  assert.match(dash, /router\.push\(`\/responses\/\$\{packet\.id\}`\)/);
});
