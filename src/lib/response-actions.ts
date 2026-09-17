/** THE RESPONSE ACTIONS A PUBLISHED SENDSET CAN ACCEPT.
 *
 *  One list, mirrored exactly by the database's CHECK on
 *  packets.response_actions (0058, 0059). respond = a message; like = a heart
 *  on an item. Each is chosen separately by the creator, and both default off. The route validates against this so a bad
 *  value is refused with a message rather than a Postgres error; the database
 *  refuses it regardless.
 *
 *  A SENDSET CAPABILITY, not an editor one. Both editors read and write it
 *  through the same component, and it lives on the Sendset rather than in its
 *  frozen publication — so switching responses off takes effect on the next
 *  request, with no Republish. */
export const RESPONSE_ACTIONS = ["respond", "like"] as const;
export type ResponseAction = (typeof RESPONSE_ACTIONS)[number];

/** A stored value read back from the database: anything unexpected is off. */
export function acceptsAction(stored: unknown, action: ResponseAction): boolean {
  return Array.isArray(stored) && stored.includes(action);
}

/** Can somebody send this Sendset a message? */
export function acceptsResponses(stored: unknown): boolean {
  return acceptsAction(stored, "respond");
}

/** Can somebody heart its items? A SEPARATE creator choice, off with the rest
 *  by default: a Sendset that accepts messages accepts nothing else by it. */
export function acceptsLikes(stored: unknown): boolean {
  return acceptsAction(stored, "like");
}

/** A value arriving at the API: an array of known actions, de-duplicated, or
 *  null if anything about it is wrong. An empty array is valid — it is "off". */
export function parseResponseActions(value: unknown): ResponseAction[] | null {
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(RESPONSE_ACTIONS);
  if (!value.every((a) => typeof a === "string" && known.has(a))) return null;
  return RESPONSE_ACTIONS.filter((a) => value.includes(a));
}
