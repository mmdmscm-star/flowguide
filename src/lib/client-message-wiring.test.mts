// Source gates for the client message. It ships in ONE place and stays an
// envelope; these fail if either changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(p, "utf8");
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p)) acc.push(p);
  }
  return acc;
}

test("the panel is rendered in exactly one place — the post-publish bar", () => {
  const users = walk("src").filter((f) => read(f).includes("ClientMessagePanel"));
  assert.deepEqual(users.sort(), [
    "src/components/client-message-panel.tsx",
    "src/components/preview-actions.tsx",
  ], `rendered outside the publish bar: ${users.join(", ")}`);
});

test("Copy Link still works, and from the same URL the message uses", () => {
  const p = read("src/components/preview-actions.tsx");
  // One definition of the share URL. Two would let the button and the message
  // disagree about where the packet lives.
  assert.equal((p.match(/\$\{window\.location\.origin\}\/p\/\$\{slug\}/g) ?? []).length, 1);
  assert.match(p, /function copyLink\(\)[\s\S]{0,200}navigator\.clipboard\.writeText\(shareUrl\)/);
  assert.match(p, /setCopied\(true\)/);
  assert.match(p, /setTimeout\(\(\) => setCopied\(false\), 2000\)/);
  // ...and it is still offered to the professional.
  assert.match(read("src/components/client-message-panel.tsx"), /Copy link only/);
});

test("the message is never stored", () => {
  const panel = read("src/components/client-message-panel.tsx");
  assert.doesNotMatch(panel, /fetch\(|supabase|localStorage|sessionStorage/,
    "the panel persists or transmits the edited message");
});

test("the panel takes plain values, not a packet", () => {
  // Standalone so another surface could adopt it without rework.
  const panel = read("src/components/client-message-panel.tsx");
  assert.match(panel, /ClientMessageInput/);
  assert.doesNotMatch(panel, /getPacket|from\("packets"\)/);
});

test("v1 stays out of sending, AI and channel variants", () => {
  const both = read("src/components/client-message-panel.tsx") + read("src/lib/client-message.ts");
  for (const banned of [/mailto:/i, /\bsms:/i, /subject/i, /openrouter/i, /\bprompt\b/i]) {
    assert.doesNotMatch(both, banned, `v1 scope broadened: ${banned}`);
  }
});
