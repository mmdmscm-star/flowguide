// DELETING A FLOWGUIDE — one mechanism, used everywhere it is offered.
//
// The endpoint already existed and is owner-scoped; what did not exist was a
// single place that CALLS it correctly. The dashboard did
// `await fetch(..., {method:"DELETE"})` and then reloaded, discarding the
// response — so a 500 or a 401 was indistinguishable from success: the list
// simply came back with the packet still in it and nothing said why.
//
// Both callers now go through here, which is what makes "one deletion
// mechanism" true rather than aspirational.

/** Everything the confirmation is allowed to say about the packet. */
export interface PacketIdentity {
  title?: string | null;
  clientName?: string | null;
  status?: string | null;
  /** ISO timestamp from the database. */
  createdAt?: string | null;
  /** How many responses this Sendset holds, as last read. They are deleted
   *  with it, so the creator is told the number before confirming. */
  responseCount?: number | null;
  /** The same number, broken down, where the caller knows it. A "response" is
   *  one submission — which may be a message somebody wrote or a set of hearts
   *  somebody left — and those read very differently to a creator deciding
   *  whether to delete. The TOTAL is what the server is held to; this only
   *  says what it is made of. */
  responseBreakdown?: { messages: number; heartSessions: number } | null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "12 August 2026", read straight off the stored ISO string.
 *
 * Deliberately not `new Date(...)`: parsing a date-only string yields UTC
 * midnight, which is the previous day in every western timezone, so a draft
 * created on the 12th would offer to delete one "created 11 August". Reading
 * the characters the database wrote cannot drift.
 */
function formatCreated(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? "").trim());
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * The sentence a creator reads before an irreversible delete.
 *
 * The job is IDENTIFICATION. A creator who opened a draft to decide whether
 * they wanted it needs to know that the thing about to be deleted is the thing
 * they were just looking at — which is precisely what the dashboard cannot tell
 * them when several drafts are called nothing at all.
 */
export function deleteConfirmMessage(packet: PacketIdentity): string {
  const title = String(packet.title ?? "").trim();
  const client = String(packet.clientName ?? "").trim();
  const forWhom = client ? ` (for ${client})` : "";

  const lines: string[] = [
    title ? `Delete "${title}"${forWhom}?` : `Delete this untitled Sendset${forWhom}?`,
  ];

  // With NEITHER a title nor a client name there is nothing on screen that
  // distinguishes this draft from any other, so say that plainly and offer the
  // one safe fact that does distinguish it.
  if (!title && !client) {
    const created = formatCreated(packet.createdAt);
    lines.push("", created
      ? `It has no title and no client name. Created ${created}.`
      : "It has no title and no client name.");
  }

  // Deleting a draft discards work. Deleting a PUBLISHED FlowGuide also breaks
  // a link somebody may already be holding, which is a different decision.
  if (String(packet.status ?? "").trim() === "published") {
    lines.push("", "Anyone you shared the link with will no longer be able to open it.");
  }

  // Responses are other people's words, and they go with the Sendset. Say the
  // number, because it is the number the server will hold this confirmation to.
  const responses = Number(packet.responseCount ?? 0);
  if (Number.isInteger(responses) && responses > 0) {
    const head = responses === 1 ? "It has 1 response" : `It has ${responses} responses`;
    const b = packet.responseBreakdown;
    const parts: string[] = [];
    if (b && b.messages + b.heartSessions === responses && b.messages > 0 && b.heartSessions > 0) {
      parts.push(b.messages === 1 ? "1 message" : `${b.messages} messages`);
      parts.push(b.heartSessions === 1 ? "1 with hearts" : `${b.heartSessions} with hearts`);
    }
    const detail = parts.length ? ` \u2014 ${parts.join(" and ")}` : "";
    lines.push("", responses === 1
      ? `${head}${detail}. Deleting it deletes that response too.`
      : `${head}${detail}. Deleting it deletes them too.`);
  }

  lines.push("", "This cannot be undone.");
  return lines.join("\n");
}

/** The server refused because the Sendset holds a different number of
 *  responses than the creator was shown. Nothing was deleted. */
export class ResponsesChangedError extends Error {
  constructor(readonly responses: number) {
    super("A response arrived since you confirmed. Nothing was deleted.");
    this.name = "ResponsesChangedError";
  }
}

/**
 * Delete one packet. Throws on any non-OK response.
 *
 * Throwing rather than returning a flag is the point: a caller that forgets to
 * check gets a visible failure instead of a silent one.
 */
export async function deletePacketRequest(id: string, acknowledgedResponses = 0): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/packets/${id}?acknowledgedResponses=${acknowledgedResponses}`, { method: "DELETE" });
  } catch {
    throw new Error("Could not reach Sendset. Check your connection and try again.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string; responses?: unknown };
    if (res.status === 409 && body?.error === "responses_changed"
        && Number.isInteger(body.responses) && (body.responses as number) >= 0) {
      throw new ResponsesChangedError(body.responses as number);
    }
    // `message` first, `error` second. Routes here carry a machine code in
    // `error` ("not_found") and the sentence a professional should read in
    // `message`; preferring `error` would put the code on screen.
    throw new Error(
      body?.message?.trim() ||
        body?.error?.trim() ||
        `Could not delete this Sendset (${res.status}).`
    );
  }
}

/**
 * Confirm, then delete — the whole flow both surfaces use.
 *
 * The confirmation states `packet.responseCount`, and the request acknowledges
 * that same number. If responses arrived in between, the server deletes nothing
 * and reports the true count; the creator is asked AGAIN with it. Nothing is
 * ever deleted on a confirmation that stated the wrong number.
 *
 * Resolves true when deleted, false when the creator cancelled. Throws on any
 * other failure.
 */
export async function confirmAndDeletePacket(
  id: string,
  packet: PacketIdentity,
  ask: (message: string) => boolean,
): Promise<boolean> {
  let count = Math.max(0, Number(packet.responseCount ?? 0) || 0);
  let changed = false;
  for (;;) {
    const message = deleteConfirmMessage({ ...packet, responseCount: count });
    if (!ask(changed ? `A new response arrived.\n\n${message}` : message)) return false;
    try {
      await deletePacketRequest(id, count);
      return true;
    } catch (e) {
      if (!(e instanceof ResponsesChangedError)) throw e;
      count = e.responses;
      changed = true;
    }
  }
}
