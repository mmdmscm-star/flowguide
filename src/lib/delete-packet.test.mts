import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deleteConfirmMessage } from "./delete-packet.ts";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ---------------------------------------------------------------------------
// THE CONFIRMATION IDENTIFIES THE PACKET
//
// This is the whole feature. A creator opens a draft, decides they don't want
// it, and needs to know the thing about to be deleted is the thing they were
// looking at — which is exactly what several identically-untitled rows on the
// dashboard cannot tell them.
// ---------------------------------------------------------------------------

test("a titled Sendset is named, with the client when there is one", () => {
  assert.match(deleteConfirmMessage({ title: "Possible Communities" }),
    /^Delete "Possible Communities"\?/);
  assert.match(deleteConfirmMessage({ title: "Possible Communities", clientName: "the Alvarez family" }),
    /^Delete "Possible Communities" \(for the Alvarez family\)\?/);
});

test("AN UNTITLED FLOWGUIDE SAYS SO — it is never called by a made-up name", () => {
  const m = deleteConfirmMessage({ title: "", clientName: "the Alvarez family" });
  assert.match(m, /^Delete this untitled Sendset \(for the Alvarez family\)\?/);
  // Whitespace is not a title.
  assert.match(deleteConfirmMessage({ title: "   " }), /untitled Sendset/);
  // And it must not invent one, the way the old dashboard copy did.
  assert.doesNotMatch(m, /Untitled Packet/);
});

test("with NOTHING to identify it, say that plainly and give the date", () => {
  const m = deleteConfirmMessage({ title: "", clientName: "", createdAt: "2026-08-12T09:30:00Z" });
  assert.match(m, /It has no title and no client name\. Created 12 August 2026\./);
});

test("the date is read off the stored string, not through a timezone", () => {
  // `new Date("2026-08-12")` is UTC midnight — the 11th in every western
  // timezone. A draft created on the 12th must never offer to delete one
  // "created 11 August".
  assert.match(deleteConfirmMessage({ createdAt: "2026-08-12" }), /Created 12 August 2026/);
  assert.match(deleteConfirmMessage({ createdAt: "2026-01-01T00:00:00Z" }), /Created 1 January 2026/);
  assert.match(deleteConfirmMessage({ createdAt: "2026-12-31T23:59:59Z" }), /Created 31 December 2026/);
});

test("a missing or unusable date degrades to the sentence without it", () => {
  for (const bad of [undefined, null, "", "not a date", "2026-13-45"]) {
    const m = deleteConfirmMessage({ title: "", clientName: "", createdAt: bad });
    assert.match(m, /It has no title and no client name\./);
    assert.doesNotMatch(m, /Created/, `expected no date clause for ${JSON.stringify(bad)}`);
  }
});

test("the 'nothing to identify it' line appears ONLY when that is true", () => {
  assert.doesNotMatch(deleteConfirmMessage({ title: "X", createdAt: "2026-08-12" }), /no title/);
  assert.doesNotMatch(deleteConfirmMessage({ clientName: "Y", createdAt: "2026-08-12" }), /no title/);
});

test("PUBLISHED carries the broken-link warning; a draft does not", () => {
  const published = deleteConfirmMessage({ title: "X", status: "published" });
  assert.match(published, /Anyone you shared the link with will no longer be able to open it\./);
  assert.doesNotMatch(deleteConfirmMessage({ title: "X", status: "draft" }), /shared the link/);
});

test("every message ends by saying it cannot be undone", () => {
  for (const p of [{}, { title: "X" }, { title: "X", status: "published" },
                   { title: "", clientName: "", createdAt: "2026-08-12" }]) {
    assert.match(deleteConfirmMessage(p), /This cannot be undone\.$/);
  }
});

// ---------------------------------------------------------------------------
// ONE MECHANISM
// ---------------------------------------------------------------------------

test("EVERY caller goes through the shared confirm-and-delete flow", () => {
  for (const caller of [
    "src/components/editor/delete-packet-action.tsx",
    "src/components/dashboard/dashboard-workspace.tsx",
  ]) {
    const src = codeOf(caller);
    assert.match(src, /confirmAndDeletePacket\(/, `${caller} does not use the shared flow`);
    // A second hand-rolled DELETE would be a second mechanism.
    assert.doesNotMatch(src, /method:\s*"DELETE"/, `${caller} rolls its own delete request`);
  }
});

test("and every caller uses the shared confirmation wording", () => {
  // The flow composes the message itself; a caller only supplies how to ask.
  assert.match(codeOf("src/lib/delete-packet.ts"),
    /export async function confirmAndDeletePacket[\s\S]*deleteConfirmMessage\(\{ \.\.\.packet, responseCount: count \}\)/);
  for (const caller of [
    "src/components/editor/delete-packet-action.tsx",
    "src/components/dashboard/dashboard-workspace.tsx",
  ]) {
    const src = codeOf(caller);
    assert.doesNotMatch(src, /confirm\(\s*["'`]/, `${caller} writes its own confirmation`);
    assert.match(src, /\(m(essage)?\) => confirm\(m(essage)?\)/, `${caller} does not ask with the shared message`);
    assert.match(src, /responseCount: (packet\.response_count|count)\b/, `${caller} does not state the response count`);
  }
});

test("A FAILED DELETE IS VISIBLE, and does not navigate away", () => {
  const action = codeOf("src/components/editor/delete-packet-action.tsx");
  // The push must be inside the try, after the await — never in a finally.
  assert.match(action, /const deleted = await confirmAndDeletePacket\([\s\S]{0,160}if \(!deleted\) \{ setBusy\(false\); return; \}[\s\S]{0,160}router\.push\("\/dashboard"\)/,
    "navigation is not gated on the delete succeeding");
  assert.match(action, /catch[\s\S]{0,160}setError\(/, "a failed delete says nothing");
  assert.doesNotMatch(action, /finally[\s\S]{0,80}router\.push/, "it navigates away even on failure");

  const dash = codeOf("src/components/dashboard/dashboard-workspace.tsx");
  assert.match(dash, /catch[\s\S]{0,160}setDeleteError\(/, "the dashboard still fails silently");
  assert.match(dash, /\{deleteError &&/, "the dashboard error is never rendered");
});

test("the helper throws rather than returning a flag a caller can ignore", () => {
  const lib = codeOf("src/lib/delete-packet.ts");
  assert.match(lib, /if \(!res\.ok\)[\s\S]{0,700}throw new Error/, "a non-OK response is not thrown");
  assert.match(lib, /catch[\s\S]{0,120}throw new Error/, "a network failure is not thrown");
});

// ---------------------------------------------------------------------------
// PLACEMENT AND SCOPE
// ---------------------------------------------------------------------------

test("BOTH editors mount the one component", () => {
  for (const editor of [
    "src/components/editor/legacy-packet-editor.tsx",
    "src/components/editor/block-packet-editor.tsx",
  ]) {
    assert.match(codeOf(editor), /<DeletePacketAction/, `${editor} cannot delete its own Sendset`);
  }
});

test("the destructive action is NOT in the bar that holds Publish", () => {
  const legacy = codeOf("src/components/editor/legacy-packet-editor.tsx");
  const bar = legacy.indexOf('className="fixed bottom-0');
  const del = legacy.indexOf("<DeletePacketAction");
  assert.ok(del > -1 && bar > -1, "expected both the action and the action bar");
  assert.ok(del < bar, "the delete action was moved into the fixed action bar beside Publish");
  // And it is a text link, not a filled button competing with the primary action.
  const action = codeOf("src/components/editor/delete-packet-action.tsx");
  assert.doesNotMatch(action, /bg-red-[56]00|bg-accent/, "the delete action is styled as a primary button");
});

test("no lifecycle system crept in", () => {
  const lib = codeOf("src/lib/delete-packet.ts");
  const action = codeOf("src/components/editor/delete-packet-action.tsx");
  // \bundo\b, not /undo/: the required copy says "cannot be undone", and a
  // pattern that matches its own mandated wording forbids the feature by
  // forbidding the sentence that promises the feature does not exist.
  for (const forbidden of [/archive/i, /\btrash\b/i, /soft.?delete/i, /\bundo\b/i, /\brestore\b/i, /\bbulk\b/i]) {
    assert.doesNotMatch(lib + action, forbidden, `scope crept: ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// THE HELPER SURFACES THE SERVER'S SENTENCE
//
// The route answers a machine code in `error` and a human sentence in
// `message`. Both editors and the dashboard render whatever this throws, so
// preferring the wrong key would put "not_found" in front of a professional.
// ---------------------------------------------------------------------------

/** Run deletePacketRequest against a stubbed fetch, return the thrown message. */
async function messageFor(response: Response | Error): Promise<string> {
  const { deletePacketRequest } = await import("./delete-packet.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  try {
    await deletePacketRequest("some-id");
    return "";               // resolved — no error thrown
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a 404 surfaces the sentence, not the code", async () => {
  const msg = await messageFor(json(404, {
    error: "not_found",
    message: "This Sendset no longer exists, or you no longer have access to it.",
  }));
  assert.equal(msg, "This Sendset no longer exists, or you no longer have access to it.");
  assert.doesNotMatch(msg, /not_found/, "the machine code reached the professional");
});

test("a body with only `error` still says something useful", async () => {
  assert.equal(await messageFor(json(401, { error: "Unauthorized" })), "Unauthorized");
});

test("a body with neither falls back to naming the status", async () => {
  assert.match(await messageFor(json(500, {})), /Could not delete this Sendset \(500\)\./);
  assert.match(await messageFor(new Response("boom", { status: 502 })), /\(502\)\./);
});

test("a network failure is reported as one, not as a silent success", async () => {
  assert.match(await messageFor(new TypeError("network down")), /Check your connection/);
});

test("a 200 resolves — success is still success", async () => {
  assert.equal(await messageFor(json(200, { ok: true })), "");
});

test("THE ROUTE DELETES ONLY THROUGH delete_sendset, holding it to the acknowledged count", () => {
  const route = codeOf("src/app/api/packets/[id]/route.ts");
  const del = route.slice(route.indexOf("export async function DELETE"));
  assert.match(del, /if \(!session\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/);
  assert.match(del, /rpc\("delete_sendset", \{\s*p_owner: session\.userId,\s*p_packet_id: id,\s*p_acknowledged_responses: acknowledged,\s*\}\)/,
    "the owner scope or the acknowledgement is not passed to delete_sendset");
  // No plain delete anywhere in the route: RESTRICT would refuse it once a
  // response exists, and it would never have checked the count.
  assert.doesNotMatch(route, /\.delete\(\)/, "the route still deletes the row directly");
  // Not-yours and not-there stay one answer.
  assert.match(del, /error\.code === "PT404"[\s\S]{0,200}error: "not_found"[\s\S]{0,160}status: 404/);
  assert.doesNotMatch(del, /\.from\("packets"\)/, "an existence probe was added");
  // A moved count is 409 with the true number, and nothing deleted.
  assert.match(del, /error\.code === "PT409" && error\.details === "responses_changed"[\s\S]{0,400}responses:[\s\S]{0,80}status: 409/);
  // The acknowledgement is a plain non-negative integer or nothing.
  assert.match(del, /searchParams\.get\("acknowledgedResponses"\)/);
  assert.match(del, /\^\\d\{1,9\}\$/);
});

// ---------------------------------------------------------------------------
// RESPONSES GO WITH A SENDSET, AND THE CREATOR IS TOLD THE NUMBER
// ---------------------------------------------------------------------------

test("the confirmation states the response count, and only when there are any", () => {
  assert.match(deleteConfirmMessage({ title: "X", responseCount: 1 }), /It has 1 response\. Deleting it deletes that response too\./);
  assert.match(deleteConfirmMessage({ title: "X", responseCount: 3 }), /It has 3 responses\. Deleting it deletes them too\./);
  for (const none of [0, null, undefined]) {
    assert.doesNotMatch(deleteConfirmMessage({ title: "X", responseCount: none }), /response/);
  }
  assert.match(deleteConfirmMessage({ title: "X", responseCount: 3 }), /This cannot be undone\.$/);
});

/** Drive confirmAndDeletePacket against scripted server answers. */
async function runFlow(answers: Response[], replies: boolean[], responseCount = 0) {
  const { confirmAndDeletePacket } = await import("./delete-packet.ts");
  const urls: string[] = [];
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { urls.push(String(url)); return answers.shift()!; }) as typeof fetch;
  try {
    const result = await confirmAndDeletePacket("p1", { title: "X", responseCount },
      (m) => { asked.push(m); return replies.shift() ?? false; });
    return { result, urls, asked };
  } finally {
    globalThis.fetch = real;
  }
}

test("the request acknowledges exactly the count the creator was shown", async () => {
  const { result, urls, asked } = await runFlow([json(200, { ok: true })], [true], 2);
  assert.equal(result, true);
  assert.match(asked[0], /It has 2 responses/);
  assert.deepEqual(urls, ["/api/packets/p1?acknowledgedResponses=2"]);
});

test("cancelling sends nothing", async () => {
  const { result, urls } = await runFlow([], [false], 2);
  assert.equal(result, false);
  assert.deepEqual(urls, []);
});

test("A RESPONSE THAT ARRIVED AFTER THE WARNING: nothing deleted, the creator is asked again with the true number", async () => {
  const { result, urls, asked } = await runFlow(
    [json(409, { error: "responses_changed", responses: 3 }), json(200, { ok: true })], [true, true], 2);
  assert.equal(result, true);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /^A new response arrived\./);
  assert.match(asked[1], /It has 3 responses/);
  assert.deepEqual(urls, ["/api/packets/p1?acknowledgedResponses=2", "/api/packets/p1?acknowledgedResponses=3"]);
});

test("declining the second warning deletes nothing", async () => {
  const { result, urls } = await runFlow([json(409, { error: "responses_changed", responses: 1 })], [true, false], 0);
  assert.equal(result, false);
  assert.equal(urls.length, 1);
});

test("any other failure is thrown, not retried", async () => {
  await assert.rejects(runFlow([json(500, { message: "Could not delete this Sendset. Try again." })], [true]),
    /Could not delete this Sendset\. Try again\./);
  // A 409 without a usable count is a failure, not a silent re-ask.
  await assert.rejects(runFlow([json(409, { error: "responses_changed" })], [true]), /Could not delete|responses_changed/);
});

