// ITEM ACTIONS — the app half of 0059.
//
// The database half is proved in scripts/pg-harness/test-0059.mjs. What is
// pinned here is everything it cannot see: where the raw capability is allowed
// to exist, that nothing new is minted until somebody completes a first heart,
// that one call can only ever name one target, that a browser is told only what
// it itself did, and the words a shared device reads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import {
  ACTION_HEADER, ITEM_ACTIONS, NO_ACTIONS, heartCountLabel, parseActionRequest, sessionSignatureLine, NOT_YOU,
} from "./item-actions.ts";
import {
  CAPABILITY_COOKIE, CAPABILITY_MAX_AGE, capabilityFromRequest, capabilityPath, hashCapability, mintCapability,
} from "./capability.ts";

const raw = (p: string) => readFileSync(p, "utf8");
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

const ROUTE = "src/app/p/[slug]/actions/route.ts";
/** The handlers themselves, so an import at the top of the file cannot satisfy
 *  an ordering assertion about the body. */
const postBody = () => {
  const src = codeOf(ROUTE);
  return src.slice(src.indexOf("export async function POST"));
};
const PROVIDER = "src/components/hearts/hearts-provider.tsx";
const MARKER = "2026-09-15T19:13:23.490556+00:00";
const ITEM = "10000000-0000-4000-8000-000000000001";
const ITEM2 = "10000000-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// WHERE THE CAPABILITY IS ALLOWED TO EXIST
// ---------------------------------------------------------------------------

test("the server generates it, and PostgreSQL only ever sees its SHA-256", () => {
  const { raw: token, hash } = mintCapability();
  // 256 bits, base64url: 43 characters, no padding.
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  const expected = `\\x${createHash("sha256").update(token, "utf8").digest("hex")}`;
  assert.equal(hash, expected);
  assert.equal(hash.length, 2 + 64);
  assert.notEqual(hash, token);
  // Two mints are two capabilities. (A generator that repeated itself would
  // hand one browser another browser's submission.)
  const seen = new Set(Array.from({ length: 200 }, () => mintCapability().raw));
  assert.equal(seen.size, 200);
});

test("a cookie that was never ours is treated as no cookie at all", () => {
  for (const bad of [undefined, null, "", "short", "!".repeat(43), "a".repeat(42), "a".repeat(44)]) {
    assert.equal(hashCapability(bad as string), null, `${String(bad)} must not hash`);
  }
  const { raw: token, hash } = mintCapability();
  assert.equal(hashCapability(token), hash);
});

test("it is read from the cookie header and from nowhere else", () => {
  const { raw: token, hash } = mintCapability();
  const req = (cookie?: string) => new Request("https://sendset.io/p/x/actions", cookie ? { headers: { cookie } } : {});
  assert.equal(capabilityFromRequest(req(`${CAPABILITY_COOKIE}=${token}`)), hash);
  assert.equal(capabilityFromRequest(req(`other=1; ${CAPABILITY_COOKIE}=${token}; more=2`)), hash);
  assert.equal(capabilityFromRequest(req("other=1")), null);
  assert.equal(capabilityFromRequest(req()), null);
  assert.equal(capabilityFromRequest(req(`${CAPABILITY_COOKIE}=not-a-capability`)), null);
  // Not from a body, a query string or a header of its own.
  const smuggled = new Request(`https://sendset.io/p/x/actions?cap=${token}`, { headers: { "x-capability": token } });
  assert.equal(capabilityFromRequest(smuggled), null);
});

test("the cookie is HttpOnly, Secure in production, and scoped to ONE Sendset", async () => {
  const { NextResponse } = await import("next/server");
  const { setCapabilityCookie, clearCapabilityCookie } = await import("./capability.ts");
  const res = NextResponse.json({ ok: true });
  const { raw: token } = mintCapability();
  setCapabilityCookie(res, "harbor-7k2", token);
  const set = res.cookies.get(CAPABILITY_COOKIE)!;
  assert.equal(set.value, token);
  assert.equal(set.httpOnly, true, "JavaScript could read it");
  assert.equal(set.sameSite, "lax");
  assert.equal(set.path, "/p/harbor-7k2");
  assert.equal(set.maxAge, CAPABILITY_MAX_AGE);
  assert.equal(capabilityPath("a b/c"), `/p/${encodeURIComponent("a b/c")}`, "a slug cannot escape its own path");

  // "Not you?" expires it at the SAME path — a mismatch would leave the old
  // cookie in place and silently keep editing somebody else's response.
  const gone = NextResponse.json({ ok: true });
  clearCapabilityCookie(gone, "harbor-7k2");
  const cleared = gone.cookies.get(CAPABILITY_COOKIE)!;
  assert.equal(cleared.value, "");
  assert.equal(cleared.maxAge, 0);
  assert.equal(cleared.path, "/p/harbor-7k2");

  const lib = codeOf("src/lib/capability.ts");
  assert.match(lib, /secure: process\.env\.NODE_ENV === "production"/);
  assert.equal((lib.match(/httpOnly: true/g) ?? []).length, 2, "every cookie write must be HttpOnly");
});

test("THE RAW TOKEN NEVER LEAVES THE Set-Cookie HEADER", () => {
  const route = codeOf(ROUTE);
  // It appears exactly once in the route: handed to the cookie writer.
  const uses = [...route.matchAll(/minted[!?]?\.raw/g)];
  assert.equal(uses.length, 1, "the raw capability is used somewhere other than the cookie");
  assert.match(route, /setCapabilityCookie\(res, slug, minted\.raw\)/);
  // Never in a body, never in a log, never in a URL.
  assert.doesNotMatch(route, /json\([^)]*raw|console\.\w+\([^)]*raw|\?cap=|capability=\$\{/);
  for (const [, args] of route.matchAll(/console\.\w+\(([\s\S]{0,160}?)\)\s*;/g)) {
    assert.doesNotMatch(args, /raw|hash|token|session_hash|p_session_hash/i, `a log line carries the capability: ${args}`);
  }
  const lib = codeOf("src/lib/capability.ts");
  assert.doesNotMatch(lib, /console\./, "the capability module logs");
  // And the database only ever receives the hash.
  assert.match(route, /p_session_hash: hash/);
  assert.match(route, /p_session_hash: existing/);
});

test("nothing client-side can read or send a capability", () => {
  for (const f of filesUnder("src/components").concat(filesUnder("src/app"))) {
    const src = codeOf(f);
    if (!/"use client"/.test(raw(f))) continue;
    assert.doesNotMatch(src, /document\.cookie/, `${f} reads cookies in the browser`);
    assert.doesNotMatch(src, /mintCapability|hashCapability|capabilityFromRequest|CAPABILITY_COOKIE/,
      `${f} handles the capability in the browser`);
  }
  // The browser never names it in a request body either: the cookie carries it.
  assert.doesNotMatch(codeOf(PROVIDER), /sessionHash|session_hash|capability/i);
});

// ---------------------------------------------------------------------------
// ONE TARGET, ONE CALL
// ---------------------------------------------------------------------------

test("v1 has exactly one item action, drawn as a heart", () => {
  assert.deepEqual([...ITEM_ACTIONS], ["like"]);
  const sql = raw("supabase/migrations/0059_sendset_item_actions.sql");
  assert.match(sql, /check \(action in \('respond', 'like'\)\)/);
  // Select, Pass and Approve are not here, in any form.
  assert.doesNotMatch(codeOf("src/lib/item-actions.ts"), /select|pass|approve/i);
});

test("a request names ONE target and ONE action — there is no shape for 'all of mine'", () => {
  const set = parseActionRequest({ op: "set", itemId: ITEM, action: "like", marker: MARKER, name: "Lisa" });
  assert.deepEqual(set, { ok: true, op: "set", itemId: ITEM, action: "like", marker: MARKER, name: "Lisa", contact: null });
  const clear = parseActionRequest({ op: "clear", itemId: ITEM, action: "like" });
  assert.deepEqual(clear, { ok: true, op: "clear", itemId: ITEM, action: "like" });
  assert.deepEqual(parseActionRequest({ op: "forget" }), { ok: true, op: "forget" });

  // Anything plural is simply not expressible.
  for (const body of [
    { op: "set", items: [ITEM, ITEM2], action: "like", marker: MARKER, name: "Lisa" },
    { op: "replace", itemIds: [ITEM], action: "like", marker: MARKER, name: "Lisa" },
    { op: "set", itemId: [ITEM, ITEM2], action: "like", marker: MARKER, name: "Lisa" },
  ]) {
    assert.equal(parseActionRequest(body).ok, false, `${JSON.stringify(body)} must be refused`);
  }
  const src = codeOf("src/lib/item-actions.ts") + codeOf(ROUTE) + codeOf(PROVIDER);
  assert.doesNotMatch(src, /itemIds|\bitems:\s|replaceAll|"replace"/, "a bulk shape appeared");
});

test("a set carries a name and a marker; a clear needs neither", () => {
  assert.equal(parseActionRequest({ op: "set", itemId: ITEM, action: "like", marker: MARKER, name: " " }).ok, false);
  assert.equal(parseActionRequest({ op: "set", itemId: ITEM, action: "like", marker: "yesterday", name: "Lisa" }).ok, false);
  assert.equal(parseActionRequest({ op: "set", itemId: "nope", action: "like", marker: MARKER, name: "Lisa" }).ok, false);
  assert.equal(parseActionRequest({ op: "set", itemId: ITEM, action: "approve", marker: MARKER, name: "Lisa" }).ok, false);
  // A withdrawal asks for nothing: somebody taking back their own heart should
  // not have to re-sign or hold a current page to do it.
  assert.equal(parseActionRequest({ op: "clear", itemId: ITEM, action: "like" }).ok, true);
  const contact = parseActionRequest({ op: "set", itemId: ITEM, action: "like", marker: MARKER, name: "Lisa", contact: " l@example.com " });
  assert.ok(contact.ok && contact.op === "set" && contact.contact === "l@example.com");
  // The name is checked BEFORE anything is looked up, so "name_required" cannot
  // tell a prober that a slug exists.
  const post = postBody();
  assert.ok(post.indexOf("parseActionRequest(body)") < post.indexOf("isPublicDemo(slug)"));
  assert.ok(post.indexOf("parseActionRequest(body)") < post.indexOf("createServerClient()"));
});

// ---------------------------------------------------------------------------
// THE ENDPOINT
// ---------------------------------------------------------------------------

test("a mutation needs the custom header; the origin checks stay as well", () => {
  const route = codeOf(ROUTE);
  assert.match(route, /request\.headers\.get\(ACTION_HEADER\) !== "1"/);
  assert.equal(ACTION_HEADER, "x-sendset-action");
  assert.match(route, /sec-fetch-site/);
  assert.match(route, /headers\.get\("origin"\)/);
  // The header check must come before anything is read or written.
  assert.ok(route.indexOf("ACTION_HEADER") < route.indexOf("await request.json()"));
  assert.match(codeOf(PROVIDER), /\[ACTION_HEADER\]: "1"/);
});

test("nothing is minted until a first heart is completed", () => {
  const route = codeOf(ROUTE);
  // Only the set branch mints, and only when the browser holds nothing.
  assert.equal((route.match(/mintCapability\(\)/g) ?? []).length, 1);
  assert.match(route, /const minted = existing \? null : mintCapability\(\);/);
  // The cookie is written only when that call succeeded.
  // Existence AND order: an indexOf of something absent is -1, which would
  // satisfy an ordering check while the guard was simply gone.
  const setBranch = route.slice(route.indexOf("const minted ="));
  assert.match(setBranch, /if \(error\) return refusal\(error\);[\s\S]*setCapabilityCookie\(res, slug, minted\.raw\)/,
    "a capability could be handed out for a call the database refused");
  // GET mints nothing, and a read is never a write.
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.doesNotMatch(get, /mintCapability|setCapabilityCookie|set_sendset_item_action|clear_sendset_item_action/);
  assert.match(get, /read_sendset_session_actions/);
  assert.match(get, /"Cache-Control": "no-store"/);
});

test("forget drops the browser's handle and changes no stored row", () => {
  const post = postBody();
  const branch = post.slice(post.indexOf('if (parsed.op === "forget")'), post.indexOf("if (isPublicDemo(slug))"));
  assert.match(branch, /clearCapabilityCookie\(res, slug\)/);
  assert.doesNotMatch(branch, /rpc\(|from\(/, "forget touches the database");
});

test("a withdrawal without a capability is answered, not raised at, and writes nothing", () => {
  const post = postBody();
  const clear = post.slice(post.indexOf('if (parsed.op === "clear")'), post.indexOf("const minted ="));
  assert.match(clear, /if \(!existing\) return json\(200, \{ ok: true, removed: false \}\)/);
  assert.match(clear, /p_session_hash: existing/);
  assert.doesNotMatch(clear, /mintCapability/);
});

test("the owner and a demo are refused before anything is written", () => {
  const post = postBody();
  const firstRpc = post.indexOf("supabase.rpc(");
  assert.ok(firstRpc > 0, "the handler calls no function at all");
  assert.ok(post.indexOf("isPublicDemo(slug)") < firstRpc, "a demo reaches the database");
  assert.match(post, /\.eq\("user_id", session\.userId\)[\s\S]{0,160}if \(owned\) return json\(403/);
  assert.ok(post.indexOf("if (owned)") < firstRpc, "the owner reaches the database");
  // Nothing identifying about the requester is read anywhere.
  assert.doesNotMatch(codeOf(ROUTE), /x-forwarded-for|x-real-ip|user-agent|fingerprint/i);
});

test("the database's refusals reach the reader as sentences, revealing nothing", () => {
  const route = codeOf(ROUTE);
  assert.match(route, /error\.code === "PT404"\) return notAccepting\(\)/);
  assert.match(route, /error\.code === "PT429"[\s\S]{0,120}status: 429|rate_limited/);
  assert.match(route, /error\.code === "PT409" && error\.details === "target_absent"/);
  // A Sendset that does not exist, one that is unpublished and one that does
  // not accept hearts are ONE answer, built in ONE place — so a later branch
  // cannot answer a fourth way by accident.
  assert.match(route, /const notAccepting = \(\) => json\(404, \{ error: "not_accepting", message: ACTION_OUTCOME\.notAccepting \}\)/);
  assert.equal((route.match(/json\(404/g) ?? []).length, 1, "a second 404 shape appeared");
});

// ---------------------------------------------------------------------------
// THE PAGE
// ---------------------------------------------------------------------------

test("hearts are mounted only by the recipient page, only when the Sendset takes them", () => {
  const page = codeOf("src/app/p/[slug]/page.tsx");
  assert.match(page, /const hearts = Boolean\(likeMarker\) && !ownedId;/);
  assert.match(page, /<HeartsProvider slug=\{slug\} marker=\{likeMarker!\}>/);
  assert.match(page, /if \(demo\) return \{ packet: demo, responseMarker: null, likeMarker: null \};/);

  // No other surface mounts the provider — which is what makes ItemHeart render
  // nothing on Preview, print and email rather than merely hide itself.
  const mounts = [...filesUnder("src/app"), ...filesUnder("src/components")]
    .filter((f) => !f.includes("/hearts/"))
    .filter((f) => /HeartsProvider/.test(codeOf(f)));
  assert.deepEqual(mounts, ["src/app/p/[slug]/page.tsx"]);
  for (const f of ["src/app/preview/[id]/page.tsx", "src/components/preview-surface.tsx",
                   "src/app/p/[slug]/print/page.tsx", "src/lib/email-render.ts", "src/components/print/print-packet.tsx"]) {
    assert.doesNotMatch(raw(f), /HeartsProvider|ItemHeart|likeMarker/, `${f} carries hearts`);
  }
  // The card asks for a heart; the provider decides whether there is one.
  assert.match(codeOf("src/components/item-card.tsx"), /audience === "recipient" && item\.id && <ItemHeart/);
});

test("a recipient is never shown anybody else's hearts", () => {
  for (const f of filesUnder("src/components/hearts")) {
    const src = codeOf(f);
    assert.doesNotMatch(src, /\btotal\b|others|everyone|\bpopular\b|people/i, `${f} hints at other responders`);
    assert.doesNotMatch(src, /owner-responses|loadOwnerResponses|responseCountLabel/, `${f} reaches for the owner's view`);
  }
  // The read endpoint returns one capability's own lines, and the empty answer
  // is the same for everything unknown.
  assert.deepEqual(NO_ACTIONS, { signature: null, actions: [] });
});

test("the words a shared browser reads are about the BROWSER, never the person", () => {
  assert.equal(sessionSignatureLine("Lisa"), "You’re hearting as “Lisa” from this browser.");
  assert.equal(sessionSignatureLine("  "), null);
  assert.equal(NOT_YOU, "Not you? Start a new response");
  const footer = codeOf("src/components/hearts/hearts-footer.tsx");
  assert.doesNotMatch(footer, /you are|verified|confirms|proves|signed in as/i);
  assert.equal(heartCountLabel(1), "1 heart");
  assert.equal(heartCountLabel(3), "3 hearts");
});

// ---------------------------------------------------------------------------
// THE OWNER'S VIEW OF HEARTS
// ---------------------------------------------------------------------------

const PACKET = "20000000-0000-4000-8000-000000000001";
const CURRENT = "2026-09-16T10:00:00.111111+00:00";
const OLD = "2026-09-15T10:00:00.222222+00:00";

/** A database whose tables answer by name, close enough for the read path. */
function ownerDb(rows: Record<string, unknown>[], publishedItems: { id: string; title: string }[]) {
  return {
    from(table: string) {
      const q = {
        select: () => q, eq: () => q, in: () => q, order: () => q,
        maybeSingle: async () => ({
          data: table === "packets"
            ? { id: PACKET, title: "Harbor options", status: "published", response_actions: ["respond", "like"] }
            : table === "packet_publications"
              ? { published_at: CURRENT, content: { sections: [{ items: publishedItems }] } }
              : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({
          data: table === "sendset_responses" ? rows
            : table === "sendset_response_lines"
              // The lines whose own marker equals the current publication.
              ? rows.flatMap((r) => (r as { sendset_response_lines: { id: string; live_publication_published_at: string }[] }).sendset_response_lines)
                  .filter((l) => l.live_publication_published_at === CURRENT).map((l) => ({ id: l.id }))
            : [],
          error: null,
        }).then(resolve),
      };
      return q;
    },
  } as never;
}

test("an action session is never labelled with a message's staleness", async () => {
  const { loadOwnerResponses } = await import("./owner-responses.ts");
  const rows = [
    {
      id: "r1", kind: "message", created_at: CURRENT, updated_at: null, responder_name: "Lisa",
      responder_contact: null, notification_due: true, notified_at: null,
      rendered_publication_was_current: false,
      sendset_response_lines: [{ id: "l1", target_kind: "sendset", target_item_id: null, target_label: null, action: "respond", note: "Hello", rendered_publication_was_current: null, live_publication_published_at: null }],
    },
    {
      id: "r2", kind: "actions", created_at: OLD, updated_at: CURRENT, responder_name: "Mark",
      responder_contact: "mark@example.invalid", notification_due: false, notified_at: null,
      // An action session HAS no submission-level marker: null, not false.
      rendered_publication_was_current: null,
      sendset_response_lines: [
        { id: "l2", target_kind: "item", target_item_id: ITEM, target_label: "Harbor House (as hearted)", action: "like", note: null, rendered_publication_was_current: true, live_publication_published_at: CURRENT },
        { id: "l3", target_kind: "item", target_item_id: ITEM2, target_label: "The Loft", action: "like", note: null, rendered_publication_was_current: true, live_publication_published_at: OLD },
      ],
    },
  ];
  const loaded = await loadOwnerResponses(PACKET, "u1", ownerDb(rows, [{ id: ITEM, title: "Harbor House renamed" }]));
  assert.ok(loaded);
  const message = loaded.responses.find((r) => r.kind === "message")!;
  const session = loaded.responses.find((r) => r.kind === "actions")!;

  // THE FALLOUT THIS GUARDS: a null read as false would label every set of
  // hearts "Sent from an earlier version of this Sendset", which is untrue.
  assert.equal(message.wasCurrent, false, "the message keeps its own marker");
  assert.equal(session.wasCurrent, null, "an action session has none");
  assert.equal(session.republishedSince, null);
  assert.equal(session.updatedAt, CURRENT);
  assert.equal(message.updatedAt, null);

  // A heart shows the item's CURRENT title while it is there, the frozen
  // tombstone once it is not — and says which.
  const here = session.hearts.find((h) => h.itemId === ITEM)!;
  const gone = session.hearts.find((h) => h.itemId === ITEM2)!;
  assert.equal(here.label, "Harbor House renamed");
  assert.equal(here.inCurrent, true);
  assert.equal(here.republishedSince, false);
  assert.equal(gone.label, "The Loft");
  assert.equal(gone.inCurrent, false);
  assert.equal(gone.republishedSince, true, "a heart given under an earlier publication says so, per heart");
});

test("the owner's list shows the two kinds as two different things", () => {
  const list = codeOf("src/components/responses/response-list.tsx");
  // Hearts are never described as sent or emailed: they are not correspondence.
  assert.match(list, /r\.kind === "message" && <span>\{notificationLabel/);
  assert.match(list, /r\.kind === "message" \? stalenessLabel\(r\.wasCurrent === true, r\.republishedSince\) : null/);
  assert.match(list, /No longer in this Sendset/);
  assert.doesNotMatch(list, /\bvotes?\b|people|approved/i);
});

// ---------------------------------------------------------------------------
// THE PANEL, DRIVEN
// ---------------------------------------------------------------------------

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let HeartsProvider: typeof import("../components/hearts/hearts-provider.tsx").HeartsProvider;
let ItemHeart: typeof import("../components/hearts/item-heart.tsx").ItemHeart;
let SignatureSheet: typeof import("../components/hearts/signature-sheet.tsx").SignatureSheet;
let HeartsFooter: typeof import("../components/hearts/hearts-footer.tsx").HeartsFooter;

const posts: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let initial: unknown = NO_ACTIONS;
let reply: (body: Record<string, unknown>) => Response = () => new Response("{}", { status: 200 });

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://sendset.io/p/harbor-7k2", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (!init?.method) return new Response(JSON.stringify(initial), { status: 200 });
    const body = JSON.parse(String(init.body));
    posts.push({ url, method: init.method, headers: init.headers ?? {}, body });
    return reply(body);
  }) as unknown as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ HeartsProvider } = await import("../components/hearts/hearts-provider.tsx"));
  ({ ItemHeart } = await import("../components/hearts/item-heart.tsx"));
  ({ SignatureSheet } = await import("../components/hearts/signature-sheet.tsx"));
  ({ HeartsFooter } = await import("../components/hearts/hearts-footer.tsx"));
});
after(() => dom.window.close());

async function mount() {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(HeartsProvider, { slug: "harbor-7k2", marker: MARKER },
      React.createElement(ItemHeart, { itemId: ITEM, title: "Harbor House" }),
      React.createElement(ItemHeart, { itemId: ITEM2, title: "The Loft" }),
      React.createElement(HeartsFooter, {}),
      React.createElement(SignatureSheet, {})));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { host, root };
}
const heart = (host: HTMLElement, n = 0) => host.querySelectorAll('[aria-pressed]')[n] as HTMLButtonElement;
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
const byText = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

test("without a provider a heart is ABSENT, not hidden", async () => {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ItemHeart, { itemId: ITEM, title: "Harbor House" })); });
  assert.equal(host.innerHTML, "", "a surface without hearts rendered one anyway");
  await act(async () => root.unmount());
});

test("THE FIRST HEART ASKS WHO, SHOWS AT ONCE, AND WRITES NOTHING IF CANCELLED", async () => {
  posts.length = 0; initial = NO_ACTIONS;
  const { host, root } = await mount();
  await click(heart(host));
  assert.equal(heart(host).getAttribute("aria-pressed"), "true", "the heart did not appear while the sheet is open");
  assert.ok(host.querySelector('[role="dialog"]'), "no signature sheet");
  assert.deepEqual(posts, [], "something was written before the person finished");

  await click(byText(host, "Cancel")!);
  assert.equal(heart(host).getAttribute("aria-pressed"), "false", "the optimistic heart did not go back");
  assert.equal(host.querySelector('[role="dialog"]'), null);
  assert.deepEqual(posts, [], "cancelling wrote something");
  await act(async () => root.unmount());
});

test("completing the signature sends ONE set, and later hearts are immediate", async () => {
  posts.length = 0; initial = NO_ACTIONS;
  reply = (body) => new Response(JSON.stringify({
    ok: true,
    action: { itemId: body.itemId, action: "like", label: "Harbor House", inCurrent: true, wasCurrent: true },
    signature: { name: body.name ?? "Lisa" },
  }), { status: 200 });
  const { host, root } = await mount();
  await click(heart(host));
  await type(host.querySelector('input[name="name"]') as HTMLInputElement, "Lisa");
  await click(byText(host, "Save")!);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/p/harbor-7k2/actions");
  assert.equal(posts[0].method, "POST");
  assert.equal(posts[0].headers[ACTION_HEADER], "1");
  assert.deepEqual(posts[0].body, { op: "set", itemId: ITEM, action: "like", marker: MARKER, name: "Lisa", contact: "" });
  assert.equal(host.querySelector('[role="dialog"]'), null, "the sheet stayed open after saving");
  assert.equal(heart(host).getAttribute("aria-pressed"), "true");

  // The second heart does not ask again.
  await click(heart(host, 1));
  assert.equal(host.querySelector('[role="dialog"]'), null, "it asked for a name twice");
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.op, "set");
  assert.equal(posts[1].body.itemId, ITEM2);
  await act(async () => root.unmount());
});

test("a returning browser sees its own hearts, and un-hearting sends ONE clear", async () => {
  posts.length = 0;
  initial = {
    signature: { name: "Lisa" },
    actions: [{ itemId: ITEM, action: "like", label: "Harbor House", inCurrent: true, wasCurrent: true }],
  };
  reply = () => new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 });
  const { host, root } = await mount();
  assert.equal(heart(host).getAttribute("aria-pressed"), "true", "a returning browser lost its hearts");
  assert.equal(heart(host, 1).getAttribute("aria-pressed"), "false");
  assert.match(host.textContent!, /1 heart on this Sendset/);
  assert.match(host.textContent!, /You’re hearting as “Lisa” from this browser/);

  await click(heart(host));
  assert.deepEqual(posts.map((p) => p.body), [{ op: "clear", itemId: ITEM, action: "like" }]);
  assert.equal(heart(host).getAttribute("aria-pressed"), "false");
  await act(async () => root.unmount());
});

test("a heart whose item has gone is still shown, and can still be taken back", async () => {
  posts.length = 0;
  initial = {
    signature: { name: "Lisa" },
    actions: [
      { itemId: ITEM, action: "like", label: "Harbor House", inCurrent: true, wasCurrent: true },
      { itemId: "99999999-0000-4000-8000-000000000009", action: "like", label: "The Loft", inCurrent: false, wasCurrent: true },
    ],
  };
  reply = () => new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 });
  const { host, root } = await mount();
  assert.match(host.textContent!, /No longer in this Sendset:/);
  assert.match(host.textContent!, /The Loft/);
  await click(byText(host, "Remove")!);
  assert.deepEqual(posts.map((p) => p.body.itemId), ["99999999-0000-4000-8000-000000000009"]);
  assert.doesNotMatch(host.textContent!, /The Loft/);
  await act(async () => root.unmount());
});

test("Not you? forgets the browser's handle and asks first", async () => {
  posts.length = 0;
  initial = { signature: { name: "Lisa" }, actions: [{ itemId: ITEM, action: "like", label: "Harbor House", inCurrent: true, wasCurrent: true }] };
  reply = () => new Response(JSON.stringify({ ok: true, forgotten: true, signature: null, actions: [] }), { status: 200 });
  const { host, root } = await mount();
  await click(byText(host, NOT_YOU)!);
  assert.match(host.textContent!, /Your hearts stay with Lisa/, "it did not say what happens to what they already said");
  assert.deepEqual(posts, [], "it forgot before being asked");
  await click(byText(host, "Start a new response")!);
  assert.deepEqual(posts.map((p) => p.body), [{ op: "forget" }]);
  assert.equal(heart(host).getAttribute("aria-pressed"), "false", "the new browser state still shows the old hearts");
  await act(async () => root.unmount());
});

test("a refusal is said plainly, and the heart goes back to what was actually saved", async () => {
  posts.length = 0;
  initial = { signature: { name: "Lisa" }, actions: [] };
  reply = () => new Response(JSON.stringify({ error: "rate_limited", message: "Too many changes just now. Please try again a little later." }), { status: 429 });
  const { host, root } = await mount();
  await click(heart(host));
  assert.equal(heart(host).getAttribute("aria-pressed"), "false", "a refused heart still looks saved");
  assert.match(host.textContent!, /Too many changes just now/);
  await act(async () => root.unmount());
});
