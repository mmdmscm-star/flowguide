// Password hashing + strength policy. One file so the rules live once:
// every API route that reads or writes a password_hash goes through the
// helpers below, and the choices (algorithm, cost factor, minimum length,
// rate-limit window) have exactly one home.
//
// bcrypt is deliberate. It is a slow, salted, GPU-expensive hash — the
// correct default for a password column that will sit at rest in a
// Postgres table. The cost factor (10) is the sweet spot for 2026
// hardware: a verify runs in ~50 ms on a typical web server, slow
// enough to defeat offline cracking, fast enough that a human on a
// login form doesn't notice.
//
// The strength policy is deliberately simple. Minimum 10 characters, no
// composition rules. NIST SP 800-63B guidance: length beats mixed-case
// gymnastics, and composition rules push users toward predictable
// substitutions. One rule: the password must not BE the email address
// (a common lazy setup mistake), which is a trivial check with a real
// consequence.

import bcrypt from "bcryptjs";

/** bcrypt rounds. 10 ~= 50 ms per verify at 2026 server hardware. */
const BCRYPT_ROUNDS = 10;

/** The rate-limit window read by /api/auth/password-login. 5 failed
 *  attempts in 15 minutes locks the email out of the password path. */
export const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const PASSWORD_ATTEMPT_LIMIT = 5;

/** Lower bound only. See the header comment for the rationale. */
export const PASSWORD_MIN_LENGTH = 10;

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Enforced on both the set-password and change-password paths. */
export function validatePassword(password: unknown, email?: string): PasswordPolicyResult {
  if (typeof password !== "string") {
    return { ok: false, reason: "Password is required." };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `Use at least ${PASSWORD_MIN_LENGTH} characters — longer is stronger.` };
  }
  if (password.length > 200) {
    // bcrypt silently truncates past 72 bytes, so a 200+ character password
    // isn't actually stronger. Refuse up front so no one is misled.
    return { ok: false, reason: "That's too long — try something under 200 characters." };
  }
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) {
    return { ok: false, reason: "Please pick a password that isn't your email address." };
  }
  return { ok: true };
}

/** Write-path helper. Produces the value that goes into users.password_hash. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Read-path helper. Returns false for a null/empty/malformed stored hash
 *  (no password set yet) so the verify side never throws on an account
 *  that hasn't opted in to the password path. */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || typeof hash !== "string" || hash.length < 20) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** Normalises an email for lookup and rate-limit bucketing. Matches the
 *  rule the magic-link path already uses. */
export function normaliseEmail(email: string): string {
  return String(email ?? "").toLowerCase().trim();
}
