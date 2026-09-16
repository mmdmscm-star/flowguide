// WHO MAY APPROVE AN EARLY-ACCESS REQUEST.
//
// One allowlist, read from the environment, compared against the signed-in
// account's own address. There are no roles in the database and no admin user:
// approving is a capability of being one of these addresses, checked on the
// server for both the page and every action. Anyone else is told the surface
// does not exist (404), because a 403 would advertise it.
export const FOUNDER_EMAILS_ENV = "FOUNDER_EMAILS";

/** The allowlist, lower-cased. Empty when unset — nobody can approve. */
export function founderEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[FOUNDER_EMAILS_ENV] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isFounder(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const address = (email ?? "").trim().toLowerCase();
  return address.length > 0 && founderEmails(env).includes(address);
}
