// A shared Sendset link names the canonical host, never the one it was copied
// from. Production answers on aliases; a link built from the browser's or the
// request's host would carry an alias into a text, an inbox or onto paper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ORIGIN, publicSendsetUrl } from "./public-url.ts";

const read = (p: string) => readFileSync(p, "utf8");
// Comments explain the old behaviour by name; only code counts.
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p)) acc.push(p);
  }
  return acc;
}

test("the public URL is the canonical host plus the slug", () => {
  assert.equal(PUBLIC_ORIGIN, "https://sendset.io");
  assert.equal(publicSendsetUrl("k3x9q2m7p4r8t1v6w5y0za"), "https://sendset.io/p/k3x9q2m7p4r8t1v6w5y0za");
});

test("every surface that hands out a link builds it with publicSendsetUrl", () => {
  const surfaces: Record<string, RegExp> = {
    "src/components/preview-actions.tsx": /const shareUrl = publicSendsetUrl\(slug\)/,
    "src/components/dashboard/dashboard-workspace.tsx": /const url = publicSendsetUrl\(slug\)/,
    "src/components/editor/legacy-packet-editor.tsx": /clipboard\.writeText\(publicSendsetUrl\(packet\.slug\)\)/,
    "src/app/api/packets/[id]/email/route.ts": /const liveUrl = publicSendsetUrl\(row\.slug\)/,
    "src/app/p/[slug]/print/page.tsx": /liveUrl=\{publicSendsetUrl\(slug\)\}/,
  };
  for (const [file, pattern] of Object.entries(surfaces)) {
    assert.match(codeOf(read(file)), pattern, `${file} no longer builds its link canonically`);
  }
  // metadataBase is pinned as a literal by brand-name and recipient-metadata
  // tests; this keeps it and the shared-link host from drifting apart.
  const base = codeOf(read("src/app/layout.tsx")).match(/metadataBase: new URL\("([^"]+)"\)/);
  assert.equal(base?.[1], PUBLIC_ORIGIN, "shared links and metadataBase name different hosts");
});

test("nothing in src builds an absolute /p/ URL from a host", () => {
  const offenders: string[] = [];
  for (const file of walk("src")) {
    if (file === join("src", "lib", "public-url.ts")) continue;
    const code = codeOf(read(file));
    if (/location\.origin/.test(code)) offenders.push(`${file}: location.origin`);
    if (/x-forwarded-host/.test(code)) offenders.push(`${file}: x-forwarded-host`);
    if (/\.url\)\.origin/.test(code)) offenders.push(`${file}: request origin`);
    // `${origin}/p/${slug}` — an interpolated prefix in front of /p/.
    if (/\}\/p\/\$\{/.test(code)) offenders.push(`${file}: interpolated host before /p/`);
    if (/https?:\/\/[^"'`\s]*\/p\/\$\{/.test(code)) offenders.push(`${file}: hard-coded host before /p/`);
  }
  assert.deepEqual(offenders, []);
});
