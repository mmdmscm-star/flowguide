// The creator affordance on a recipient's page — boundary invariants.
//
// /p/[slug] is the one public route in the product, and the only place where a
// creator-side element and a client-side document share a page. Everything here
// pins that boundary rather than the styling: who sees the bar, what it may do,
// and what the recipient path is allowed to pay for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const RECIPIENT = read("src/app/p/[slug]/page.tsx");

const OWNER = read("src/lib/packet-owner.ts");
const BAR = read("src/components/nav/owner-bar.tsx");

test("a visitor with no session cookie costs nothing and can never be the owner", () => {
  const body = OWNER.slice(OWNER.indexOf("export async function ownedPacketId"));
  const cookie = body.indexOf("SESSION_COOKIE");
  const bail = body.indexOf("if (!token) return null;");
  const db = body.indexOf("createServerClient");
  assert.ok(cookie < bail && bail < db,
    "the cookie check must short-circuit BEFORE any database work — recipients are " +
    "the majority of traffic on this route and must not pay for a creator feature");
});

test("ownership requires the session user to match a PUBLISHED packet's owner", () => {
  assert.match(OWNER, /\.eq\("status", "published"\)/);
  assert.match(OWNER, /row\.user_id === session\.userId/);
});

test("the cookie name is not duplicated", () => {
  // Two copies drift silently: rename one and the other keeps "working" by
  // always finding nothing, which fails OPEN into "not the owner".
  assert.match(OWNER, /SESSION_COOKIE/);
  assert.doesNotMatch(OWNER, /"flowguide_session"/);
});

test("the recipient page renders the bar ONLY for a confirmed owner", () => {
  assert.match(RECIPIENT, /\{ownedId && <OwnerBar/,
    "the bar must be gated on the resolved owner id, never on the mere presence of a session");
  assert.match(RECIPIENT, /slug !== "demo" \? await ownedPacketId\(slug\) : null/,
    "the sample packet has no owner and must not attempt the check");
});

test("the owner bar cannot act on anything", () => {
  for (const forbidden of [/<form/, /<button/, /fetch\(/, /onClick/, /"use client"/]) {
    assert.doesNotMatch(BAR, forbidden,
      "the public page gained a way OUT, not a way IN — this bar is links only");
  }
});

test("the recipient packet shape still carries no owner identity", () => {
  const types = read("src/lib/types.ts");
  const packet = types.slice(types.indexOf("export interface Packet {"));
  assert.doesNotMatch(packet.slice(0, packet.indexOf("}")), /user_?[Ii]d|owner/,
    "an owner id inside the object that renders a client-facing page is how it reaches the client");
});

test("the owner's own visit no longer marks the Sendset as seen by the client", () => {
  assert.match(RECIPIENT, /isSupabaseConfigured && !ownedId\) \{\n\s*markPacketViewed/,
    "`viewed` means the CLIENT opened it; the author checking their own link must not set it");
});

test("the generic creator nav is still never rendered on a recipient's page", () => {
  // The owner bar is deliberately a DIFFERENT component: three links out and a
  // sentence, not the workspace chrome. Mounting CreatorNav here would make the
  // public page look like an app shell to whoever happened to be signed in.
  assert.doesNotMatch(RECIPIENT, /CreatorNav/);
});
