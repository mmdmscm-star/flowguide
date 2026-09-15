// EARLY-ACCESS INVITE CODES.
//
// 100 bits of randomness in Crockford's base32 (no I, L, O or U), shown in four
// groups of five: HTG4M-9XQ2K-7VPZB-3NDR6. Only the SHA-256 of the normalised
// code is ever stored or sent to the database, and the code itself appears in
// exactly two places: the terminal that created it, and the box the invited
// person types it into. Never in a URL, a log line or a table.
import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford base32
export const INVITE_CODE_LENGTH = 20;                  // 20 × 5 bits = 100 bits
const GROUP = 5;

/** A new code, grouped for reading aloud. Rejection sampling keeps every symbol equally likely. */
export function generateInviteCode(): string {
  let code = "";
  while (code.length < INVITE_CODE_LENGTH) {
    for (const byte of randomBytes(INVITE_CODE_LENGTH)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;   // would favour the first symbols
      code += ALPHABET[byte % ALPHABET.length];
      if (code.length === INVITE_CODE_LENGTH) break;
    }
  }
  return (code.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? []).join("-");
}

/**
 * What the person typed, as the code it means: case, spaces and dashes ignored,
 * and the three substitutions Crockford's alphabet exists to forgive.
 */
export function normalizeInviteCode(input: string): string {
  return (input ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** Worth a database round trip: right length, right alphabet. */
export function isPlausibleInviteCode(normalized: string): boolean {
  return normalized.length === INVITE_CODE_LENGTH && [...normalized].every((ch) => ALPHABET.includes(ch));
}

/** What is stored and compared. The code is never persisted. */
export function inviteCodeHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
