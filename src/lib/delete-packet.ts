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

  lines.push("", "This cannot be undone.");
  return lines.join("\n");
}

/**
 * Delete one packet. Throws on any non-OK response.
 *
 * Throwing rather than returning a flag is the point: a caller that forgets to
 * check gets a visible failure instead of a silent one.
 */
export async function deletePacketRequest(id: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/packets/${id}`, { method: "DELETE" });
  } catch {
    throw new Error("Could not reach Sendset. Check your connection and try again.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
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
