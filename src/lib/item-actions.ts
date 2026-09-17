// ITEM ACTIONS — the rules shared by the page, the endpoint and the owner's
// list. No I/O here; see 0059 for the database half.
//
// v1 IS ONE ACTION: Like, drawn as a heart. It is mutable preference, which is
// what separates it from a Respond message: a message is correspondence and
// cannot be rewritten once sent, while a heart can be given and taken back.
//
// ONE TARGET PER CALL, always. There is no "replace my hearts" shape anywhere
// in this module, because a client that cannot render a line it holds — an
// item the Sendset no longer carries — would delete it by leaving it out.
import { MARKER_SHAPE, NAME_MAX, CONTACT_MAX } from "./responses.ts";

export const ITEM_ACTIONS = ["like"] as const;
export type ItemAction = (typeof ITEM_ACTIONS)[number];

/** The header a mutation must carry. A cross-site page cannot send it without a
 *  CORS preflight this app never grants, so forgery is closed structurally
 *  rather than by the origin checks — which stay, as defence in depth, and are
 *  not presented as sufficient on their own. */
export const ACTION_HEADER = "x-sendset-action";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trimLikeDb = (s: string) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
const codePoints = (s: string) => [...s].length;

export type ActionRequest =
  | { ok: true; op: "set"; itemId: string; action: ItemAction; marker: string; name: string; contact: string | null }
  | { ok: true; op: "clear"; itemId: string; action: ItemAction }
  | { ok: true; op: "forget" }
  | { ok: false; field: "name" | "contact" | "form"; message: string };

/**
 * The body of POST /p/[slug]/actions, checked before anything is looked up.
 *
 * `set` carries the signature every time. It is written only when the
 * capability is minted and ignored afterwards, but it is always REQUIRED, so
 * that "a name is missing" cannot be told apart from "this Sendset is not
 * accepting hearts" — which would tell a prober that a slug exists.
 */
export function parseActionRequest(body: unknown): ActionRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const bad = (message: string, field: "name" | "contact" | "form" = "form") =>
    ({ ok: false as const, field, message });

  const op = str(b.op);
  if (op === "forget") return { ok: true, op: "forget" };
  if (op !== "set" && op !== "clear") return bad("Something went wrong. Reload the page and try again.");

  const itemId = str(b.itemId);
  if (!itemId || !UUID.test(itemId)) return bad("Something went wrong. Reload the page and try again.");

  const action = str(b.action);
  if (!action || !(ITEM_ACTIONS as readonly string[]).includes(action)) {
    return bad("Something went wrong. Reload the page and try again.");
  }

  if (op === "clear") return { ok: true, op, itemId, action: action as ItemAction };

  const marker = str(b.marker);
  if (!marker || !MARKER_SHAPE.test(marker)) {
    return bad("This page is out of date. Reload it and try again.");
  }

  const name = trimLikeDb(str(b.name) ?? "");
  if (!name) return bad("Add your name.", "name");
  if (codePoints(name) > NAME_MAX) return bad(`Keep your name under ${NAME_MAX} characters.`, "name");

  const contact = trimLikeDb(str(b.contact) ?? "");
  if (codePoints(contact) > CONTACT_MAX) return bad(`Keep this under ${CONTACT_MAX} characters.`, "contact");

  return { ok: true, op, itemId, action: action as ItemAction, marker, name, contact: contact || null };
}

/** What a reader is told. None of these says whether a Sendset exists, and none
 *  says anything about anybody else's hearts. */
export const ACTION_OUTCOME = {
  notAccepting: "This Sendset isn’t taking hearts right now.",
  rateLimited: "Too many changes just now. Please try again a little later.",
  targetAbsent: "That isn’t in this Sendset any more.",
  failed: "That didn’t save. Please try again.",
} as const;

/** One heart, as the recipient's own page holds it. */
export interface MyAction {
  itemId: string;
  action: ItemAction;
  label: string | null;
  /** Is the item still in the Sendset? False means it can be withdrawn but not
   *  given again — and that it must keep being shown rather than disappearing. */
  inCurrent: boolean;
  wasCurrent: boolean;
}

export interface MyActions {
  signature: { name: string | null } | null;
  actions: MyAction[];
}

/** The empty answer: the same one an unknown capability, an unknown slug and a
 *  browser holding nothing all receive. */
export const NO_ACTIONS: MyActions = { signature: null, actions: [] };

/** What the person reading their own page is told about the browser they are
 *  using. About the BROWSER, never about them: a capability is not proof of
 *  identity, and a shared device is one capability. */
export function sessionSignatureLine(name: string | null | undefined): string | null {
  const n = String(name ?? "").trim();
  return n ? `You’re hearting as “${n}” from this browser.` : null;
}

export const NOT_YOU = "Not you? Start a new response";

/** "1 heart", "4 hearts" — of items, by this one browser. Never people. */
export function heartCountLabel(count: number): string {
  return `${count} ${count === 1 ? "heart" : "hearts"}`;
}
