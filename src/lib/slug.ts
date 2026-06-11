// Generate an 8-character alphanumeric slug for packet URLs
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateSlug(): string {
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}
