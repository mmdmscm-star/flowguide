// IS WHAT RECIPIENTS SEE STILL WHAT THE PROFESSIONAL HAS?
//
// For a published Sendset, the answer the editor shows as "Published" or
// "Saved · Changes not published". It is EXACT: the copy a Republish pressed now
// would freeze is built with the same builder and identity rule publish uses,
// and compared BY VALUE with the stored publication. Not the revision counters
// (they over-count — an identical rewrite moves them) and not bytes (jsonb
// reorders keys).
import { buildPublicationSnapshot, readPublication } from "./queries.ts";
import { canonicalJson } from "./canonical-json.ts";
import { PUBLISH_PROFILE_COLUMNS, republishIdentity } from "./publish-identity.ts";
import type { createServerClient } from "./supabase.ts";

type Db = ReturnType<typeof createServerClient>;

export type PublicationState =
  | { published: false }
  // "missing" is a published Sendset with no stored copy: before the backfill
  // only. Its page renders the working rows, so nothing is unpublished.
  | { published: true; publication: "current" | "changed" | "missing" };

/** null when the Sendset does not exist or is not this owner's. Throws when it cannot tell. */
export async function getPublicationState(db: Db, packetId: string, ownerId: string): Promise<PublicationState | null> {
  const { data: packet, error } = await db
    .from("packets")
    .select("id, user_id, status, identity_mode, custom_identity")
    .eq("id", packetId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(`publication state could not read the Sendset: ${error.message}`);
  if (!packet) return null;
  if (packet.status !== "published") return { published: false };

  const publication = await readPublication(db, packetId);
  if (!publication) return { published: true, publication: "missing" };

  let profile = null;
  if ((packet.identity_mode || "default") === "default") {
    const res = await db.from("professional_profiles").select(PUBLISH_PROFILE_COLUMNS).eq("user_id", ownerId).maybeSingle();
    if (res.error) throw new Error(`publication state could not read the profile: ${res.error.message}`);
    profile = res.data;
  }
  const next = await buildPublicationSnapshot(db, packetId, republishIdentity(packet, profile));
  return {
    published: true,
    publication: canonicalJson(next) === canonicalJson(publication.content) ? "current" : "changed",
  };
}
