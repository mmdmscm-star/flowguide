// Generate a random slug for packet URLs.
//
// A packet link is an unguessable bearer token: anyone holding /p/<slug> can
// view the packet, and the slug is the only thing standing between a leaked URL
// and enumeration. So two properties matter:
//   1. Cryptographic randomness — Math.random() is predictable and must not gate
//      access to a client's private packet. We draw from the platform CSPRNG.
//   2. Enough length — 22 base-36 chars is ~113 bits of entropy, far beyond any
//      practical guessing. (The previous 8-char slug was ~41 bits.)
// Existing packets keep their shorter slugs; only newly created ones use this.
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 symbols
const SLUG_LENGTH = 22;

export function generateSlug(): string {
  // Reject bytes at/above the largest multiple of 36 that fits in a byte (252)
  // so the modulo below is unbiased across the alphabet.
  const unbiasedMax = 256 - (256 % CHARS.length);

  let result = "";
  while (result.length < SLUG_LENGTH) {
    const bytes = new Uint8Array(SLUG_LENGTH - result.length);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < unbiasedMax) result += CHARS[b % CHARS.length];
    }
  }
  return result;
}
