// THE OWNER'S RESPONSES — read on the server, for the owner only.
//
// sendset_responses has RLS on and no policies, and only service_role may read
// it (0058). So every read goes through the server client AND is scoped here to
// the signed-in owner twice: the Sendset must be theirs, and each response must
// carry their owner_user_id.
import { createServerClient } from "./supabase.ts";
import { acceptsResponses } from "./response-actions.ts";
import { currentPublicationContent, currentPublicationMarker } from "./queries.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** One hearted item, as the owner reads it. */
export interface OwnerHeart {
  itemId: string;
  /** The item's CURRENT title while it is still in the Sendset; the label
   *  frozen when the heart was given once it is not. */
  label: string;
  /** False = the Sendset no longer carries it. The heart is still real and is
   *  still shown; it simply cannot be given again. */
  inCurrent: boolean;
  wasCurrent: boolean;
  /** Per line, because an action session spans republishes (0059). Null when
   *  the Sendset is not published now, so no comparison is made. */
  republishedSince: boolean | null;
}

export interface OwnerResponse {
  id: string;
  /** 'message' is correspondence: immutable, notified, with one marker for the
   *  moment it happened. 'actions' is a mutable set of hearts held by one
   *  browser's capability, never notified, with staleness per heart. */
  kind: "message" | "actions";
  createdAt: string;
  updatedAt: string | null;
  name: string | null;
  contact: string | null;
  message: string;
  hearts: OwnerHeart[];
  notificationDue: boolean;
  notifiedAt: string | null;
  /** Message only. An action session has none — its hearts carry their own. */
  wasCurrent: boolean | null;
  /** Message only; Postgres-decided, null when the Sendset is not published. */
  republishedSince: boolean | null;
}

export interface OwnerResponses {
  packet: { id: string; title: string; status: string; responsesEnabled: boolean };
  responses: OwnerResponse[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PublicationContent = {
  sections?: { items?: { id?: string; title?: string }[] }[];
  blocks?: { kind?: string; item?: { id?: string; title?: string } }[];
};

/** Item id -> current title, from the publication, in both composition shapes.
 *  Membership is what decides whether a heart's item is still there; the title
 *  is what the owner reads while it is. */
function publishedItemTitles(content: PublicationContent | null): Map<string, string> {
  const items = new Map<string, string>();
  if (!content) return items;
  for (const section of content.sections ?? []) {
    for (const item of section.items ?? []) {
      if (item?.id) items.set(item.id, String(item.title ?? "").trim() || "An item");
    }
  }
  for (const block of content.blocks ?? []) {
    if (block?.kind === "item" && block.item?.id) {
      items.set(block.item.id, String(block.item.title ?? "").trim() || "An item");
    }
  }
  return items;
}

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
      // THE RELATIONSHIP IS NAMED, and it has to be. 0059 gave the lines a
      // SECOND foreign key to this table — the composite (response_id,
      // parent_kind) that keeps a like under an action session — so an
      // unqualified embed is ambiguous and PostgREST refuses it outright.
      .select("id, kind, created_at, updated_at, responder_name, responder_contact, notification_due, notified_at, rendered_publication_was_current, sendset_response_lines!sendset_response_lines_response_id_fkey(id, target_kind, target_item_id, target_label, action, note, rendered_publication_was_current, live_publication_published_at)")
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
  let heartsUnderCurrent: Set<string> | null = null;
  if (packet.status === "published" && current !== null) {
    const ids = ((rows ?? []) as { id: string }[]).map((r) => r.id);
    const [{ data: same, error: sameErr }, { data: sameLines, error: lineErr }] = await Promise.all([
      db.from("sendset_responses").select("id")
        .eq("packet_id", packetId).eq("owner_user_id", userId)
        .eq("live_publication_published_at", current),
      // The SAME equality, for the lines that carry their own marker — and
      // scoped to this Sendset's own submissions, which are the only ones this
      // read may touch.
      ids.length
        ? db.from("sendset_response_lines").select("id").in("response_id", ids)
            .eq("live_publication_published_at", current)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (!sameErr) underCurrent = new Set((same as { id: string }[]).map((r) => r.id));
    if (!lineErr) heartsUnderCurrent = new Set((sameLines as { id: string }[]).map((l) => l.id));
  }

  // Which items the publication still carries, so a heart can say whether its
  // item is gone. Computed at read time and never stored: it changes when the
  // Sendset changes, not when anybody acts.
  const content = packet.status === "published" ? await currentPublicationContent(db, packetId) : null;
  const currentItems = publishedItemTitles(content as PublicationContent | null);

  type Line = {
    id: string; target_kind: string; target_item_id: string | null; target_label: string | null;
    action: string; note: string | null; rendered_publication_was_current: boolean | null;
  };
  type Row = {
    id: string; kind: "message" | "actions"; created_at: string; updated_at: string | null;
    responder_name: string | null; responder_contact: string | null;
    notification_due: boolean; notified_at: string | null; rendered_publication_was_current: boolean | null;
    sendset_response_lines: Line[];
  };

  const responses = ((rows ?? []) as Row[]).map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    name: r.responder_name,
    contact: r.responder_contact,
    // A message is exactly one Sendset-level respond line.
    message: r.sendset_response_lines.find((l) => l.target_kind === "sendset" && l.action === "respond")?.note ?? "",
    hearts: r.sendset_response_lines
      .filter((l) => l.action === "like" && l.target_item_id)
      .map((l) => ({
        itemId: l.target_item_id!,
        label: currentItems.get(l.target_item_id!) ?? l.target_label ?? "An item",
        inCurrent: currentItems.has(l.target_item_id!),
        wasCurrent: l.rendered_publication_was_current === true,
        republishedSince: heartsUnderCurrent ? !heartsUnderCurrent.has(l.id) : null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    notificationDue: r.notification_due,
    notifiedAt: r.notified_at,
    // A MESSAGE'S MARKER IS THE MESSAGE'S. An action session has none — reading
    // its null as "not current" would label every set of hearts as sent from an
    // earlier version, which is simply untrue.
    wasCurrent: r.kind === "message" ? r.rendered_publication_was_current === true : null,
    republishedSince: r.kind === "message" && underCurrent ? !underCurrent.has(r.id) : null,
  }));

  return {
    packet: { id: packet.id, title: packet.title ?? "", status: packet.status, responsesEnabled: acceptsResponses(packet.response_actions) },
    responses,
  };
}
