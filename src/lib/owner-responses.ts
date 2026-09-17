// THE OWNER'S RESPONSES — read on the server, for the owner only.
//
// sendset_responses has RLS on and no policies, and only service_role may read
// it (0058). So every read goes through the server client AND is scoped here to
// the signed-in owner twice: the Sendset must be theirs, and each response must
// carry their owner_user_id.
import { createServerClient } from "./supabase.ts";
import { acceptsResponses } from "./response-actions.ts";
import { currentPublicationMarker } from "./queries.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface OwnerResponse {
  id: string;
  createdAt: string;
  name: string | null;
  contact: string | null;
  message: string;
  notificationDue: boolean;
  notifiedAt: string | null;
  wasCurrent: boolean;
  /** Postgres-decided; null when the Sendset is not published now. */
  republishedSince: boolean | null;
}

export interface OwnerResponses {
  packet: { id: string; title: string; status: string; responsesEnabled: boolean };
  responses: OwnerResponse[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Null when the Sendset does not exist or is not this owner's — one answer for
 *  both, so the question cannot be used to probe for someone else's id. */
export async function loadOwnerResponses(
  packetId: string,
  userId: string,
  db: Db = createServerClient(),
): Promise<OwnerResponses | null> {
  if (!UUID.test(packetId)) return null;

  const { data: packet } = await db
    .from("packets").select("id, title, status, response_actions").eq("id", packetId).eq("user_id", userId).maybeSingle();
  if (!packet) return null;

  const [{ data: rows, error }, current] = await Promise.all([
    db.from("sendset_responses")
      .select("id, created_at, responder_name, responder_contact, notification_due, notified_at, rendered_publication_was_current, sendset_response_lines(target_kind, action, note)")
      .eq("packet_id", packetId)
      .eq("owner_user_id", userId)
      .order("created_at", { ascending: false }),
    currentPublicationMarker(db, packetId),
  ]);
  if (error) throw new Error(`responses could not be read: ${error.message}`);

  // REPUBLISHED SINCE? Decided by POSTGRES EQUALITY, not here. The current
  // marker goes back to the database as the exact string it produced, and the
  // database says which responses arrived under that same publication. Anything
  // else arrived under a different one. Never an ordering comparison:
  // published_at is not monotonic.
  let underCurrent: Set<string> | null = null;
  if (packet.status === "published" && current !== null) {
    const { data: same, error: sameErr } = await db
      .from("sendset_responses")
      .select("id")
      .eq("packet_id", packetId)
      .eq("owner_user_id", userId)
      .eq("live_publication_published_at", current);
    if (!sameErr) underCurrent = new Set((same as { id: string }[]).map((r) => r.id));
  }

  type Row = {
    id: string; created_at: string; responder_name: string | null; responder_contact: string | null;
    notification_due: boolean; notified_at: string | null; rendered_publication_was_current: boolean;
    sendset_response_lines: { target_kind: string; action: string; note: string | null }[];
  };

  const responses = ((rows ?? []) as Row[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    name: r.responder_name,
    contact: r.responder_contact,
    // v1 writes exactly one Sendset-level respond line.
    message: r.sendset_response_lines.find((l) => l.target_kind === "sendset" && l.action === "respond")?.note ?? "",
    notificationDue: r.notification_due,
    notifiedAt: r.notified_at,
    wasCurrent: r.rendered_publication_was_current,
    republishedSince: underCurrent ? !underCurrent.has(r.id) : null,
  }));

  return {
    packet: { id: packet.id, title: packet.title ?? "", status: packet.status, responsesEnabled: acceptsResponses(packet.response_actions) },
    responses,
  };
}
