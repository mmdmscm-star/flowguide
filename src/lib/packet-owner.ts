import { cookies } from "next/headers";
import { getSession, SESSION_COOKIE } from "./auth.ts";
import { createServerClient } from "./supabase.ts";

/**
 * The packet's id when the current visitor is the professional who owns this
 * published FlowGuide, and null otherwise.
 *
 * FREE FOR RECIPIENTS, and that is the point. A recipient carries no session
 * cookie, so this returns false after a single in-memory cookie read and never
 * touches the database. /p/[slug] is the hottest public route in the product and
 * the one path where a per-request query would be paid by people who get nothing
 * from it.
 *
 * The check is deliberately SEPARATE from `getPublishedPacket` rather than
 * widening the `Packet` type with an owner id. `Packet` is the recipient's view
 * of a FlowGuide; putting an owner's user id inside the object that renders a
 * client-facing page is how that id eventually reaches the client.
 *
 * This answers a question about the VIEWER. It must never change what is
 * fetched or rendered for anyone else.
 */
export async function ownedPacketId(slug: string): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await getSession();
  if (!session) return null;

  const supabase = createServerClient();
  const { data } = await supabase
    .from("packets")
    .select("id, user_id")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();

  // A signed-in professional who is NOT the owner is a recipient like any other.
  const row = data as { id: string; user_id: string } | null;
  return row && row.user_id === session.userId ? row.id : null;
}
