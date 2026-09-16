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
  // A DEMO HAS NO OWNER, so the check is skipped for one — and this used to
  // name the one demo by its slug. There are several now, and the rule was
  // never about that slug: it is that a public demo never goes looking for an
  // owner. The registry answers that for all of them.
  assert.match(RECIPIENT, /!isPublicDemo\(slug\) \? await ownedPacketId\(slug\) : null/,
    "a public demo now attempts an owner lookup it can never satisfy");
  // …and the check still HAPPENS for everything else, or the bar is simply
  // gone and the assertion above is satisfied by skipping it for everyone.
  assert.match(RECIPIENT, /await ownedPacketId\(slug\)/,
    "the owner lookup is gone entirely, so no professional ever sees the bar");
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

test("the owner's own visit is not counted as a view", () => {
  // The count answers "has my client opened this". A professional checking
  // their own link is what made the boolean it replaced untrustworthy, so the
  // page does not even mount the beacon for them.
  assert.match(RECIPIENT, /const countThisOpen = !isPublicDemo\(slug\) && isSupabaseConfigured && !ownedId;/,
    "the owner, a demo, or an unconfigured environment would now count a view");
  assert.match(RECIPIENT, /\{countThisOpen && <RecordView slug=\{slug\} \/>\}/,
    "the beacon is mounted unconditionally");
});

test("THE RECIPIENT GET WRITES NOTHING", () => {
  // It used to mark the Sendset viewed while rendering, which counted every
  // server-side fetch of the URL — including a messaging app building a link
  // preview. A read path that writes is how that happens again.
  assert.ok(!/markPacketViewed/.test(RECIPIENT), "the recipient page still writes while rendering");
  assert.ok(!/markPacketViewed/.test(read("src/lib/queries.ts")),
    "the view-marking write survives in the query layer");
  for (const forbidden of [/\.update\(/, /\.insert\(/, /\.rpc\(/]) {
    assert.doesNotMatch(RECIPIENT, forbidden, "the recipient page performs a write during render");
  }
});

test("the generic creator nav is still never rendered on a recipient's page", () => {
  // The owner bar is deliberately a DIFFERENT component: three links out and a
  // sentence, not the workspace chrome. Mounting CreatorNav here would make the
  // public page look like an app shell to whoever happened to be signed in.
  assert.doesNotMatch(RECIPIENT, /CreatorNav/);
});
