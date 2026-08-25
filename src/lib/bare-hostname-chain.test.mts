// THE WHOLE CHAIN, not just recognition.
//
// The parser fix only matters if the URL actually lands in `links`. This drives
// the real pipeline — parseClaims → recordEnvelopes → bindByProvenance →
// reconcile → enforceItem — over a real source that lost a URL, with a model
// result that omits it, and asserts the URL is materialized.
//
// Writing this caught a mistake in my own reasoning: recognition alone does NOT
// deliver the fix. Enforcement can only repair an item it can ATTRIBUTE to a
// source record, and recordEnvelopes finds no records in some ordinary shapes.
// The limit is asserted at the bottom of this file rather than left implicit.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceChunkResult } from "./enforce-chunk.ts";
import { recordEnvelopes } from "./attribution.ts";

/** A real source in which a bare hostname shares a line with other content. */
const SOURCE = `Places I looked at for the Ramirez move:

- Brightwater Apartments — 2br from $2,450/mo, 15 min to downtown, has parking. Leasing office 415-555-0132. brightwater.example.com
- Kestrel Court — cheaper, $2,100, but no in-unit laundry and the 2brs are tiny. Ask about the waitlist.
- Alder Row — $2,800, newest of the three, gym + roof deck. Tour available Thursday.`;

/** The model's output WITHOUT the URL — the failure being repaired. */
const omitted = () => ({ items: [
  { title: "Brightwater Apartments", description: "2br, 15 min to downtown, has parking.",
    details: [{ label: "Rent", value: "$2,450/mo" }], links: [],
    contacts: [{ name: "Leasing office", phone: "415-555-0132" }] },
  { title: "Kestrel Court", description: "Cheaper, no in-unit laundry.",
    details: [{ label: "Rent", value: "$2,100" }], links: [], contacts: [] },
]});

const run = (result: unknown) => enforceChunkResult({
  segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0, sourceText: SOURCE,
  result, destination: "packet",
});
const linksOf = (out: ReturnType<typeof run>, i = 0) =>
  (((out.result as { items: Record<string, unknown>[] }).items[i].links ?? []) as { url?: string }[])
    .map((l) => String(l?.url ?? ""));

test("THE URL THAT WAS SILENTLY LOST NOW LANDS IN LINKS", () => {
  const urls = linksOf(run(omitted()));
  assert.ok(urls.some((u) => u.includes("brightwater.example.com")),
    `still missing — links were ${JSON.stringify(urls)}`);
});

test("and it is stored as a usable URL, with the scheme supplied", () => {
  const url = linksOf(run(omitted())).find((u) => u.includes("brightwater"))!;
  // A bare hostname in an href is not a link; canonicalUrl supplies what the
  // professional did not type.
  assert.match(url, /^https:\/\/brightwater\.example\.com/, `stored as ${url}`);
});

test("the repair is COUNTED, so it is visible rather than silent", () => {
  const t = run(omitted()).telemetry as unknown as Record<string, unknown>;
  assert.equal(t.scope, "enforced");
  assert.ok(Number(t.repaired ?? 0) >= 1, JSON.stringify(t));
});

test("the contact that already worked is untouched", () => {
  const item = (run(omitted()).result as { items: Record<string, unknown>[] }).items[0];
  // Enforcement CANONICALIZES a phone — "415-555-0132" is stored as
  // "(415) 555-0132". The fact must survive; its formatting is allowed to
  // change, so this asserts the digits rather than the punctuation.
  const digits = JSON.stringify(item.contacts ?? []).replace(/\D/g, "");
  assert.ok(digits.includes("4155550132"), `the phone was lost: ${JSON.stringify(item.contacts)}`);
});

test("a URL the model DID place is accepted, not duplicated", () => {
  const placed = omitted();
  placed.items[0].links = [{ url: "https://brightwater.example.com", label: "Website" }] as never;
  const hits = linksOf(run(placed)).filter((u) => u.includes("brightwater.example.com"));
  assert.equal(hits.length, 1, `duplicated: ${JSON.stringify(hits)}`);
});

// ---------------------------------------------------------------------------
// THE LIMIT — asserted, not assumed
// ---------------------------------------------------------------------------

test("KNOWN GAP: enforcement is inert wherever no source records are found", () => {
  // recordEnvelopes returning null means bindByProvenance binds nothing,
  // itemsGoverned is 0, and the contract cannot repair, strip or flag ANYTHING
  // for that input — not this URL, not any other dropped fact.
  //
  // Measured over fifteen ordinary inputs: null for ELEVEN of them. The four
  // that produce records are dash- and number-led lists. So the parser fix
  // delivers where attribution succeeds, and the wider gap is record detection,
  // which is a separate piece of work.
  //
  // Pinned so an improvement to record detection surfaces here as a failing
  // expectation rather than passing unnoticed.
  const headingShaped = "SHORTLIST\n\nRiverbend Studio\n$1,800/day. 3,000 sq ft, blackout capable, in-house grip.\nriverbend.example.com | Booking: Nia Patel 646-555-0188\n\nFifth Street Stage\n$2,400/day. Bigger, has a cyc wall.\n";
  assert.equal(recordEnvelopes(headingShaped), null,
    "record detection now covers heading-shaped sources — revisit the URL gap there");

  // Verbatim from the reliability run, not a reconstruction — an earlier
  // shortened version of this DID produce records, which is exactly why the
  // measured text is used.
  const spreadsheetPaste =
    "Name\tAddress\tDay rate\tCapacity\tContact\n" +
    "The Foundry\t41 Mill St\t$4,200\t120\tDana Reyes 206-555-0118\n" +
    "Harborlight Loft\t9 Pier Rd\t$5,600\t90\tSam Okonjo 206-555-0164\n" +
    "Cedar & Vine\t388 Vine St\t$3,800\t150\tAlice Fenner 206-555-0177\n" +
    "Union Hall\t12 Canal St\t$2,900\t220\t";
  assert.equal(recordEnvelopes(spreadsheetPaste), null,
    "record detection now covers spreadsheet pastes — revisit enforcement coverage there");

  // The dash-led shape this file exercises DOES produce records, which is why
  // the repair above is possible at all.
  assert.ok((recordEnvelopes(SOURCE) ?? []).length >= 2, "the working shape stopped producing records");
});
