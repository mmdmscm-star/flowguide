// THE CAPABILITY — server only. Never import this into a client component.
//
// A capability is 256 random bits that mean exactly one thing: you may re-open
// the submission you created on THIS Sendset. It is not an identity, not an
// account, and never proof of who anybody is.
//
// WHERE EACH PART OF IT IS ALLOWED TO EXIST:
//   * THE SERVER generates the raw token. Nothing else ever does.
//   * It reaches the browser ONLY as an HttpOnly, Secure cookie scoped to that
//     one Sendset's path.
//   * JAVASCRIPT NEVER RECEIVES OR READS IT — HttpOnly is what makes that true
//     rather than a convention the page is trusted to keep.
//   * It never appears in a response body, in a log line, or in a URL.
//   * POSTGRESQL RECEIVES ONLY THE 32-BYTE SHA-256 HASH.
//
// It is minted only by a completed first action (0059), so somebody who merely
// reads a Sendset is given nothing: no cookie, no row, no counter.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";

/** One fixed name. The PATH is what scopes it to a Sendset — a name carrying
 *  the slug would put the list of Sendsets this browser has acted on into the
 *  cookie jar, which is the cross-Sendset identifier this design refuses. */
export const CAPABILITY_COOKIE = "sendset_actions";

/** 60 days. A capability that is never used again simply expires; there is no
 *  server-side record of it to clean up and nothing to "log out" of. */
export const CAPABILITY_MAX_AGE = 60 * 60 * 24 * 60;

/** Scoped to ONE Sendset's path, so the browser sends it to that Sendset's
 *  endpoints and to nothing else — not even to another Sendset on this origin. */
export function capabilityPath(slug: string): string {
  return `/p/${encodeURIComponent(slug)}`;
}

/** A raw token as it is written into the cookie: 43 base64url characters. */
const RAW_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** PostgREST renders a bytea argument from this escaped-hex form. */
const toByteaLiteral = (hash: Buffer) => `\\x${hash.toString("hex")}`;

/** A new capability. The raw half goes to the cookie and nowhere else; the
 *  hashed half is the only thing any other system ever sees. */
export function mintCapability(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashCapability(raw)! };
}

/** The hash PostgreSQL stores, or null if the cookie held something that was
 *  never one of ours. A wrong-shaped cookie is not an error: it is treated
 *  exactly like no cookie at all. */
export function hashCapability(raw: string | undefined | null): string | null {
  if (typeof raw !== "string" || !RAW_SHAPE.test(raw)) return null;
  return toByteaLiteral(createHash("sha256").update(raw, "utf8").digest());
}

/** Constant-time comparison, for the rare places two hashes are compared in
 *  application code rather than by the database. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Hand the browser a freshly minted capability. */
export function setCapabilityCookie(res: NextResponse, slug: string, raw: string): void {
  res.cookies.set({
    name: CAPABILITY_COOKIE,
    value: raw,
    path: capabilityPath(slug),
    httpOnly: true,
    // Secure everywhere it can be: a Secure cookie is simply not stored over
    // plain http, which would make local development untestable.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: CAPABILITY_MAX_AGE,
  });
}

/** "Not you? Start a new response." Drops the browser's handle and CHANGES NO
 *  STORED ROW: the submission it held stays exactly as it is, under its own
 *  signature. The next action mints a new capability and a new submission. */
export function clearCapabilityCookie(res: NextResponse, slug: string): void {
  res.cookies.set({
    name: CAPABILITY_COOKIE,
    value: "",
    path: capabilityPath(slug),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
  });
}

/** The hash for the capability this request carries, or null. The raw value is
 *  read here and nowhere else, and is never returned, logged or passed on. */
export function capabilityFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== CAPABILITY_COOKIE) continue;
    return hashCapability(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}
