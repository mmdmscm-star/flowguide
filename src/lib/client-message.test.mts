import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildClientMessage } from "./client-message.ts";

const URL_ = "https://flowguide.example.com/p/abc123";
const full = { clientName: "Sarah", title: "Senior Living Options", url: URL_, professionalName: "Michael" };

test("the complete message reads as one wrapper around the link", () => {
  assert.equal(buildClientMessage(full), [
    "Hi Sarah,",
    "",
    "I've put together Senior Living Options for you so everything is easy to review in one place.",
    "",
    "You can view it here:",
    URL_,
    "",
    "Any questions, just reply.",
    "",
    "Michael",
  ].join("\n"));
});

test("a missing client name removes the greeting, it does not leave 'Hi ,'", () => {
  // The COMMON case: most real packets carry no client name.
  const m = buildClientMessage({ ...full, clientName: null });
  assert.ok(m.startsWith("I've put together"), m.slice(0, 40));
  assert.doesNotMatch(m, /Hi\s*,/);
});

test("a missing title degrades the sentence rather than naming nothing", () => {
  const m = buildClientMessage({ ...full, title: "" });
  assert.match(m, /I've put this together for you/);
  assert.doesNotMatch(m, /for you so everything.*undefined/);
});

test("a missing professional name removes the sign-off cleanly", () => {
  const m = buildClientMessage({ ...full, professionalName: undefined });
  assert.ok(m.endsWith("Any questions, just reply."), JSON.stringify(m.slice(-40)));
  assert.doesNotMatch(m, /\n\n$/);
});

test("everything missing still produces a sendable message with the link", () => {
  const m = buildClientMessage({ url: URL_ });
  assert.match(m, /I've put this together/);
  assert.ok(m.includes(URL_));
  assert.doesNotMatch(m, /undefined|null|\[|\]/);
});

test("whitespace-only values count as missing", () => {
  const m = buildClientMessage({ ...full, clientName: "   ", professionalName: "\t" });
  assert.doesNotMatch(m, /Hi/);
  assert.ok(m.endsWith("Any questions, just reply."));
});

test("the link is always present and appears exactly once", () => {
  for (const v of [full, { url: URL_ }, { ...full, title: null, clientName: null }]) {
    const m = buildClientMessage(v as never);
    assert.equal(m.split(URL_).length - 1, 1, JSON.stringify(m));
  }
});

test("it is deterministic — same input, same bytes", () => {
  assert.equal(buildClientMessage(full), buildClientMessage({ ...full }));
});

test("the message never describes the packet's contents", () => {
  // v1 is strictly an envelope. If a summary clause is ever added here it
  // becomes a second account of the content that can go stale.
  const src = readFileSync("src/lib/client-message.ts", "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const banned of [/\bitems?\b/i, /\bcount\b/i, /\bsections?\b/i, /\bphotos?\b/i, /\bpricing\b/i]) {
    assert.doesNotMatch(code, banned, `the builder references packet contents: ${banned}`);
  }
});

test("no AI, no persistence, no network", () => {
  const src = readFileSync("src/lib/client-message.ts", "utf8");
  assert.doesNotMatch(src, /fetch|supabase|openrouter|prompt/i);
});
