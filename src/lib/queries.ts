import { createPublicClient, createServerClient } from "./supabase";
import type { Packet, PacketBlock, Section, Item, ItemDetail, ItemLink, ItemContact, ProfessionalContact } from "./types";
import type { SenderIdentity } from "./recipient-metadata";
import { acceptsResponses, acceptsLikes } from "./response-actions";

// ============================================================
// Resolve which identity a packet presents in the editor/preview,
// honoring the packet's identity_mode:
//   'default' -> the live account profile (current behavior)
//   'none'    -> no identity (empty; the footer/logo simply don't render)
//   'custom'  -> the packet-specific identity stored on the packet
// Published views do NOT use this — they read the frozen snapshot, into which
// publish has already baked the resolved identity.
// ============================================================
export function resolveProfessional(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any
): ProfessionalContact {
  const mode = packet.identity_mode || "default";

  if (mode === "none") {
    return { name: "" };
  }

  if (mode === "custom") {
    const c = packet.custom_identity || {};
    return {
      name: c.name || "",
      email: c.email || undefined,
      phone: c.phone || undefined,
      businessName: c.businessName || undefined,
      logoUrl: c.logoUrl || undefined,
      headshotUrl: c.headshotUrl || undefined,
      footerLabel: c.footerLabel || undefined,
      websiteUrl: c.websiteUrl || undefined,
      links: Array.isArray(c.links) && c.links.length > 0 ? c.links : undefined,
    };
  }

  return {
    name: profile?.name || "",
    email: profile?.email || undefined,
    phone: profile?.phone || undefined,
    businessName: profile?.business_name || undefined,
    logoUrl: profile?.logo_url || undefined,
    headshotUrl: profile?.headshot_url || undefined,
    footerLabel: profile?.footer_label ?? "Your Advisor",
    websiteUrl: profile?.website_url || undefined,
    links: profile?.links || undefined,
  };
}

// ============================================================
// SERVER: The published Sendset a recipient sees — web, print and email
// ============================================================
// THE FROZEN PUBLICATION, NOT THE WORKING ROWS. Since the reader switch the
// live rows are the professional's draft: editing a published Sendset changes
// nothing a recipient sees until Republish freezes a new copy (publish_packet,
// 0052). Every recipient renderer loads through here, so the page, the printed
// copy and the email version always show the same publication.
//
// The internal title is never part of a publication, so it is blank here on
// every path: a recipient's Packet does not carry it.
export async function getPublishedPacket(slug: string, db: Db = createServerClient()): Promise<Packet | null> {
  return (await getPublishedPacketForPage(slug, db))?.packet ?? null;
}

/**
 * The same published Sendset, plus what the recipient PAGE alone needs: whether
 * it accepts responses, and the marker of the publication it is rendering.
 *
 * THE MARKER COMES FROM THE SAME ROW AS THE CONTENT, in the same query. Reading
 * them separately could pair the content of one publication with the marker of
 * the next, and a response would then be recorded as current for a page that
 * never showed that publication.
 *
 * THE MARKER IS PostgREST's STRING, returned untouched. Never a Date. See
 * MARKER_SHAPE in responses.ts.
 *
 * `response_actions` is read live from the Sendset, never from the publication:
 * turning either off takes effect on the next request, with no Republish. Each
 * marker is null whenever that action is not offered — off, or a Sendset still
 * on the rollout fallback, which has no publication to mark.
 *
 * The two are separate because the creator chooses them separately: a Sendset
 * may take messages, hearts, both or neither.
 */
export async function getPublishedPacketForPage(
  slug: string,
  db: Db = createServerClient()
): Promise<{ packet: Packet; responseMarker: string | null; likeMarker: string | null } | null> {
  const { data: packet, error: packetError } = await db
    .from("packets")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .single();

  if (packetError || !packet) return null;

  // A failed read or an unknown format THROWS: rendering the working rows
  // instead would show a recipient changes that were never published.
  const publication = await readPublication(db, packet.id);
  if (publication) {
    const live = typeof publication.publishedAt === "string" ? publication.publishedAt : null;
    return {
      packet: recipientPacket(publication.content),
      responseMarker: acceptsResponses(packet.response_actions) ? live : null,
      likeMarker: acceptsLikes(packet.response_actions) ? live : null,
    };
  }

  // TEMPORARY ROLLOUT FALLBACK — a published Sendset with no publication row.
  //
  // That is exactly the state of every Sendset published before 0052 until the
  // 0054 backfill has stored its copy, and for those the live rows ARE what was
  // published. After a complete backfill it cannot arise (publish_packet writes
  // the copy with the status, unpublish_packet deletes both, 0053 refuses any
  // other status change), so this logging is an alarm: it should never fire.
  // Removed once production has run clean on publications alone.
  console.error("[publication-reader] published Sendset has no publication; rendering live rows", { packetId: packet.id });
  const live = await assemblePublishedFromLiveRows(db, packet);
  return { packet: { ...live, title: "" }, responseMarker: null, likeMarker: null };
}

/** WHO SENT IT, and deliberately nothing else.
 *
 *  For the link preview on /p/[slug] and its print route. It reads the SAME
 *  frozen publication the recipient sees, so the name in an unfurl is the name
 *  on the page — a Republish that changes an advisor's details changes both
 *  together, and neither can show an identity that was never published.
 *
 *  NARROW ON PURPOSE, twice over. It asks Postgres for one jsonb path rather
 *  than the whole snapshot (571 bytes at most, against 37KB for the largest
 *  publication), and it returns two fields out of the nine that path holds, so
 *  an email address or a phone number is not sitting in the caller's hand
 *  waiting to be put in a meta tag. A preview may know who sent a Sendset; it
 *  may not know anything else about it. See recipient-metadata.ts.
 *
 *  Returns null for a missing or unpublished slug — the caller renders the
 *  anonymous title, and the page itself 404s a moment later. */
export async function publishedSenderIdentity(
  slug: string,
  db: Db = createServerClient()
): Promise<SenderIdentity | null> {
  const { data: packet } = await db
    .from("packets")
    .select("id")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  if (!packet) return null;

  const { data, error } = await db
    .from("packet_publications")
    .select("professional:content->professional")
    .eq("packet_id", packet.id)
    .maybeSingle();
  // A PREVIEW IS NOT WORTH A 500. getPublishedPacket throws on a failed read
  // because rendering the wrong thing to a recipient is worse than an error;
  // here the fallback is an anonymous title on a page that still renders.
  if (error || !data) return null;

  const p = (data as { professional?: Record<string, unknown> }).professional;
  return { name: str(p?.name), businessName: str(p?.businessName) };
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

/** The CURRENT publication's marker for a Sendset — PostgREST's string for
 *  published_at, untouched — or null when there is no publication. For the
 *  owner's response list, which asks Postgres (by equality) which responses
 *  arrived under it. Never a Date; see MARKER_SHAPE in responses.ts. */
export async function currentPublicationMarker(db: Db, packetId: string): Promise<string | null> {
  const { data, error } = await db
    .from("packet_publications")
    .select("published_at")
    .eq("packet_id", packetId)
    .maybeSingle();
  if (error || !data) return null;
  const marker = (data as { published_at?: unknown }).published_at;
  return typeof marker === "string" ? marker : null;
}

/** The current publication's CONTENT for a Sendset, or null. For the owner's
 *  response list, which needs to know whether a hearted item is still in the
 *  Sendset. Read here so packet_publications keeps exactly one reader. */
export async function currentPublicationContent(db: Db, packetId: string): Promise<PublicationSnapshot | null> {
  const { data, error } = await db
    .from("packet_publications")
    .select("content")
    .eq("packet_id", packetId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { content?: PublicationSnapshot }).content ?? null;
}

/** Where a published Sendset's frozen copy is read. Throws on a failed read or an unknown format. */
export async function readPublication(db: Db, packetId: string): Promise<{ formatVersion: number; content: PublicationSnapshot; publishedAt: unknown } | null> {
  const { data, error } = await db
    .from("packet_publications")
    .select("format_version, content, published_at")
    .eq("packet_id", packetId)
    .maybeSingle();
  if (error) throw new Error(`publication could not be read: ${error.message}`);
  if (!data) return null;
  const row = data as { format_version: number; content: PublicationSnapshot; published_at: unknown };
  if (row.format_version !== PUBLICATION_FORMAT_VERSION) {
    throw new Error(`publication format ${row.format_version} is not one this reader renders`);
  }
  // published_at stays `unknown` and untouched: only the response marker uses
  // it, and only as the string PostgREST produced.
  return { formatVersion: row.format_version, content: row.content, publishedAt: row.published_at };
}

function recipientPacket(content: PublicationSnapshot): Packet {
  return { ...content, title: "" };
}

// ============================================================
// SERVER: The published Sendset assembled from its WORKING rows
// ============================================================
// What recipients saw before the reader switch. Kept for the rollout fallback
// above and for the backfill, which must freeze exactly this. Not a recipient
// reader: after the switch the working rows may hold unpublished changes.
export async function getLiveRowsPublishedPacket(slug: string, db: Db = createServerClient()): Promise<Packet | null> {
  const { data: packet, error: packetError } = await db
    .from("packets")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .single();

  if (packetError || !packet) return null;
  return assemblePublishedFromLiveRows(db, packet);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assemblePublishedFromLiveRows(supabase: Db, packet: any): Promise<Packet> {
  // Use snapshotted profile when present, fall back to live profile for
  // packets published before the snapshot feature (snapshot is null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let profile: any = null;
  const snapshot = packet.professional_snapshot;
  if (snapshot && typeof snapshot === "object" && Object.keys(snapshot).length > 0) {
    profile = profileFromSnapshot(snapshot);
  } else if (snapshot === null) {
    // No snapshot — legacy packet, fall back to live profile
    const { data: liveProfile } = await supabase
      .from("professional_profiles")
      .select("*")
      .eq("user_id", packet.user_id)
      .single();
    profile = liveProfile;
  }
  // If snapshot is {} (empty object), packet was published without branding — profile stays null

  return assemblePacket(supabase, packet, profile, false);
}

type Db = ReturnType<typeof createServerClient>;

// A FAILED READ IS NOT AN EMPTY ONE — WHEN THE RESULT IS BEING FROZEN.
//
// The live recipient page has always read `data || []`, and it keeps doing so:
// a hiccup there costs one page view. A publication snapshot is different. It is
// stored and served later, so a failed read that assembled "no photos" would
// freeze that absence into what every recipient sees. The snapshot builder
// therefore reads strictly and throws instead.
function rowsOf<T>(res: { data: T[] | null; error: { message: string } | null }, strict: boolean, what: string): T[] {
  if (strict && res.error) throw new Error(`publication snapshot could not read ${what}: ${res.error.message}`);
  return res.data || [];
}

// The frozen professional_snapshot (camelCase) as the profile row shape the
// assembly expects. `{}` means "published without branding" and yields null.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function profileFromSnapshot(snapshot: any): any {
  if (!snapshot || typeof snapshot !== "object" || Object.keys(snapshot).length === 0) return null;
  return {
    name: snapshot.name || "",
    email: snapshot.email || "",
    phone: snapshot.phone || "",
    business_name: snapshot.businessName || "",
    logo_url: snapshot.logoUrl || "",
    headshot_url: snapshot.headshotUrl || "",
    footer_label: snapshot.footerLabel ?? "Your Advisor",
    website_url: snapshot.websiteUrl || "",
    links: snapshot.links || [],
  };
}

// ONE ASSEMBLY for both the live recipient page and the frozen publication, so
// the copy publish_packet stores is, by construction, what the page renders.
async function assemblePacket(
  supabase: Db,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any,
  strict: boolean
): Promise<Packet> {
  // Branch on composition mode. Block-mode packets present an ordered block body
  // (packet_blocks) instead of sections; legacy packets continue through the
  // exact section/item assembly below, unchanged. The packet shell and the
  // resolved professional identity (from the frozen snapshot) are shared by both.
  if (packet.composition_mode === "blocks") {
    return buildBlockPacket(supabase, packet, profile, strict);
  }

  // Fetch sections ordered by sort_order
  const sections = rowsOf(await supabase
    .from("sections")
    .select("*")
    .eq("packet_id", packet.id)
    .order("sort_order"), strict, "sections");

  if (sections.length === 0) {
    return buildPacket(packet, profile, []);
  }

  // Fetch all items for all sections
  const sectionIds = sections.map((s) => s.id);
  const items = rowsOf(await supabase
    .from("items")
    .select("*")
    .in("section_id", sectionIds)
    .order("sort_order"), strict, "items");

  if (items.length === 0) {
    return buildPacket(
      packet,
      profile,
      sections.map((s) => ({ ...s, items: [] }))
    );
  }

  // Fetch all sub-fields for all items
  const itemIds = items.map((i) => i.id);
  const [photosRes, linksRes, detailsRes, contactsRes] = await Promise.all([
    supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_contacts").select("*").in("item_id", itemIds).order("sort_order"),
  ]);

  const photos = rowsOf(photosRes, strict, "photos");
  const links = rowsOf(linksRes, strict, "links");
  const details = rowsOf(detailsRes, strict, "details");
  const contacts = rowsOf(contactsRes, strict, "contacts");

  // Assemble items with their sub-fields
  const assembledItems = items.map((item) => {
    const itemPhotos = photos.filter((p) => p.item_id === item.id).map((p) => p.url);
    const itemLinks: ItemLink[] = links
      .filter((l) => l.item_id === item.id)
      .map((l) => ({ url: l.url, label: l.label || undefined }));
    const itemDetails: ItemDetail[] = details
      .filter((d) => d.item_id === item.id)
      .map((d) => ({ label: d.label, value: d.value }));
    const itemContacts = contacts
      .filter((c) => c.item_id === item.id)
      .map((c) => ({
        name: c.name || undefined,
        role: c.role || undefined,
        phone: c.phone || undefined,
        email: c.email || undefined,
        website: c.website || undefined,
      }));

    const assembled: Item = {
      id: item.id,
      title: item.title,
      address: item.address || undefined,
      description: item.description || undefined,
      // RECIPIENT PATH. The private note is deliberately not assembled here at
      // all — see the Audience note above assembleItemsByIds. `highlight` is the
      // OTHER field and the opposite rule: it was written FOR this reader, so it
      // is assembled for every audience.
      highlight: item.highlight || undefined,
      photos: itemPhotos.length > 0 ? itemPhotos : undefined,
      links: itemLinks.length > 0 ? itemLinks : undefined,
      details: itemDetails.length > 0 ? itemDetails : undefined,
      contacts: itemContacts.length > 0 ? itemContacts : undefined,
    };
    return assembled;
  });

  // Assemble sections with their items
  const assembledSections: Section[] = sections.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description || undefined,
    items: assembledItems.filter((item) =>
      items.find((i) => i.id === item.id && i.section_id === section.id)
    ),
  }));

  return buildPacket(packet, profile, assembledSections);
}

// ============================================================
// SERVER: The recipient-safe copy publish_packet freezes (0052)
// ============================================================
// Built from the Sendset's working rows by id — whatever its status — through
// the same assembly getPublishedPacket uses, with the identity the publish
// route is about to store in professional_snapshot. The internal `title` is
// dropped (it is never shown to a recipient, and packet_publications refuses
// it); private notes never enter the assembly at all.
export const PUBLICATION_FORMAT_VERSION = 1;
export type PublicationSnapshot = Omit<Packet, "title">;

export async function buildPublicationSnapshot(
  db: Db,
  packetId: string,
  professionalSnapshot: Record<string, unknown>
): Promise<PublicationSnapshot> {
  const { data: packet, error } = await db.from("packets").select("*").eq("id", packetId).single();
  if (error || !packet) throw new Error(`publication snapshot could not read the Sendset: ${error?.message ?? "not found"}`);
  const built = await assemblePacket(db, packet, profileFromSnapshot(professionalSnapshot), true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { title: _internalName, ...recipient } = built;
  // Exactly the JSON that will be stored: undefined fields are absent, not null.
  return JSON.parse(JSON.stringify(recipient)) as PublicationSnapshot;
}

// Map a snapshot/profile row (snake_case) to the ProfessionalContact shape the
// renderers consume. Shared by the legacy and block published paths so identity
// resolves identically regardless of composition mode.
function professionalFromProfileRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any
): ProfessionalContact {
  return {
    name: profile?.name || "",
    email: profile?.email || undefined,
    phone: profile?.phone || undefined,
    businessName: profile?.business_name || undefined,
    logoUrl: profile?.logo_url || undefined,
    headshotUrl: profile?.headshot_url || undefined,
    footerLabel: profile?.footer_label ?? "Your Advisor",
    websiteUrl: profile?.website_url || undefined,
    links: profile?.links || undefined,
  };
}

function buildPacket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any,
  sections: Section[]
): Packet {
  return {
    slug: packet.slug,
    title: packet.title,
    clientTitle: packet.client_title || undefined,
    clientName: packet.client_name || undefined,
    personalNote: packet.personal_note || undefined,
    mapUrl: packet.map_url || undefined,
    compositionMode: "legacy",
    // `!== false` rather than `=== true`: a null, a missing column or an older
    // cached row must all read as ON, so the failure mode is "behaves as it
    // does today" rather than "the index silently vanished".
    showQuickNav: packet.show_quick_nav !== false,
    // Absent, null or unrecognised all resolve to the default treatment; see
    // treatmentFor(). Migration 0049 makes the column NOT NULL, so in practice
    // this is always one of the registry's names.
    styleTreatment: packet.style_treatment ?? undefined,
    sections,
    professional: professionalFromProfileRow(profile),
  };
}

// Build a published block-mode packet: read packet_blocks STRICTLY by position,
// assemble the referenced item content, and reuse the same packet shell and
// resolved professional identity as the legacy path. `sections` is empty; the
// ordered `blocks` body is what the renderer reads.
async function buildBlockPacket(
  supabase: ReturnType<typeof createServerClient>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any,
  strict = false
): Promise<Packet> {
  const blockRows = rowsOf(await supabase
    .from("packet_blocks")
    .select("id, position, block_type, item_id, heading_text, heading_subtext")
    .eq("packet_id", packet.id)
    .order("position"), strict, "blocks");

  const itemIds = blockRows
    .filter((r) => r.block_type === "item" && r.item_id)
    .map((r) => r.item_id as string);
  const itemsById = await assembleItemsByIds(supabase, itemIds, "recipient", strict);

  const blocks: PacketBlock[] = [];
  for (const r of blockRows) {
    if (r.block_type === "item") {
      const item = itemsById[r.item_id as string];
      // A missing item would be a DB-guarded inconsistency; skip defensively.
      if (item) blocks.push({ id: r.id, kind: "item", item });
    } else {
      blocks.push({
        id: r.id,
        kind: r.block_type as "heading" | "subheading" | "label",
        text: r.heading_text || "",
        subtext: r.heading_subtext || undefined,
      });
    }
  }

  return {
    slug: packet.slug,
    title: packet.title,
    clientTitle: packet.client_title || undefined,
    clientName: packet.client_name || undefined,
    personalNote: packet.personal_note || undefined,
    mapUrl: packet.map_url || undefined,
    compositionMode: "blocks",
    // PRESENTATION PREFERENCES BELONG TO THE SHARED ASSEMBLY, not to each
    // caller. The published block branch used to attach neither, while the
    // editor branch attached showQuickNav after the fact — an omission that was
    // inert only because a block body renders no index. A treatment is NOT
    // inert: block packets render through the same treatment-aware components,
    // so a branch that forgot it would show a client the wrong look.
    showQuickNav: packet.show_quick_nav !== false,
    styleTreatment: packet.style_treatment ?? undefined,
    sections: [],
    blocks,
    professional: professionalFromProfileRow(profile),
  };
}

// Assemble full Item content (photos/links/details/contact) for a set of item
// ids, matching the legacy published assembly exactly. Shared by the block
// published path and the persisted-block preview so item rendering never drifts.
// WHO IS THIS DATA FOR.
//
// `notes` is the professional's PRIVATE note — the Library calls it "Private
// note / Only you see this" and the editor calls it "Private notes". It was
// reaching recipients on /p/[slug], and not only through the rendered markup:
// ItemCard is a "use client" component, so Next.js serializes whatever it is
// given into the RSC payload embedded in the HTML. Hiding the JSX would have
// left the note readable in view-source. So the note is removed HERE, before it
// can cross into a recipient page at all.
//
// THE DEFAULT IS "recipient" ON PURPOSE. A surface added later is private by
// omission. Getting an opt-in wrong means a professional cannot see their own
// note in one view — visible, and recoverable. The opposite default fails
// silently toward exposure, which is exactly how this happened.
export type Audience = "recipient" | "professional";

export async function assembleItemsByIds(
  supabase: ReturnType<typeof createServerClient>,
  itemIds: string[],
  audience: Audience = "recipient",
  strict = false
): Promise<Record<string, Item>> {
  if (itemIds.length === 0) return {};
  const [itemsRes, photosRes, linksRes, detailsRes, contactsRes] = await Promise.all([
    supabase.from("items").select("*").in("id", itemIds),
    supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_contacts").select("*").in("item_id", itemIds).order("sort_order"),
  ]);
  const photos = rowsOf(photosRes, strict, "photos");
  const links = rowsOf(linksRes, strict, "links");
  const details = rowsOf(detailsRes, strict, "details");
  const contacts = rowsOf(contactsRes, strict, "contacts");

  const map: Record<string, Item> = {};
  for (const it of rowsOf(itemsRes, strict, "items")) {
    const itemPhotos = photos.filter((p) => p.item_id === it.id).map((p) => p.url);
    const itemLinks: ItemLink[] = links
      .filter((l) => l.item_id === it.id)
      .map((l) => ({ url: l.url, label: l.label || undefined }));
    const itemDetails: ItemDetail[] = details
      .filter((d) => d.item_id === it.id)
      .map((d) => ({ label: d.label, value: d.value }));
    const itemContacts = contacts
      .filter((x) => x.item_id === it.id)
      .map((x) => ({
        name: x.name || undefined,
        role: x.role || undefined,
        phone: x.phone || undefined,
        email: x.email || undefined,
        website: x.website || undefined,
      }));
    map[it.id] = {
      id: it.id,
      title: it.title,
      address: it.address || undefined,
      description: it.description || undefined,
      // Present only for the professional. Absent — not empty — for a recipient,
      // so the key never reaches the serialized payload.
      ...(audience === "professional" ? { notes: it.notes || undefined } : {}),
      // Recipient-facing by design, so it is NOT gated on audience.
      highlight: it.highlight || undefined,
      photos: itemPhotos.length > 0 ? itemPhotos : undefined,
      links: itemLinks.length > 0 ? itemLinks : undefined,
      details: itemDetails.length > 0 ? itemDetails : undefined,
      contacts: itemContacts.length > 0 ? itemContacts : undefined,
    };
  }
  return map;
}

// THE VIEW COUNT IS NOT WRITTEN FROM HERE. A page open is recorded by the
// browser that opened it, through POST /api/p/[slug]/view and the
// record_packet_view function (0057). Nothing on a read path may write it: a
// GET that counted would count every server-side fetch of the URL, which is
// what the old `viewed` boolean did.

// ============================================================
// SERVER: Fetch a packet by ID for the editor (any status)
// ============================================================
export async function getPacketForEditor(
  packetId: string,
  userId: string
): Promise<(Packet & { id: string; status: string }) | null> {
  const supabase = createServerClient();

  const { data: packet, error } = await supabase
    .from("packets")
    .select("*")
    .eq("id", packetId)
    .eq("user_id", userId)
    .single();

  if (error || !packet) return null;

  // Reuse the same assembly logic but with server client
  const { data: profile } = await supabase
    .from("professional_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();

  // THE SAME COMPOSITION THE RECIPIENT PAGE READS.
  //
  // This path returned sections unconditionally, so a block-composed packet
  // reached Preview with no `blocks` and no `compositionMode` — and Preview
  // rendered its (empty) sections. The professional was approving something
  // their client would never see. buildBlockPacket is the recipient path's own
  // assembly, reused rather than reimplemented; the only difference is where
  // the identity comes from, which is the editor's live profile rather than a
  // publish-time snapshot, exactly as it is for the section path below.
  if (packet.composition_mode === "blocks") {
    const built = await buildBlockPacket(supabase, packet, profile);
    return { ...built, id: packet.id, status: packet.status };
  }

  const { data: sections } = await supabase
    .from("sections")
    .select("*")
    .eq("packet_id", packet.id)
    .order("sort_order");

  if (!sections || sections.length === 0) {
    return buildPacketWithId(packet, profile, []);
  }

  const sectionIds = sections.map((s) => s.id);
  const { data: items } = await supabase
    .from("items")
    .select("*")
    .in("section_id", sectionIds)
    .order("sort_order");

  if (!items || items.length === 0) {
    return buildPacketWithId(
      packet,
      profile,
      sections.map((s) => ({ id: s.id, title: s.title, description: s.description, items: [] }))
    );
  }

  const itemIds = items.map((i) => i.id);
  const [photosRes, linksRes, detailsRes, contactsRes] = await Promise.all([
    supabase.from("item_photos").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_links").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_details").select("*").in("item_id", itemIds).order("sort_order"),
    supabase.from("item_contacts").select("*").in("item_id", itemIds).order("sort_order"),
  ]);

  const photos = photosRes.data || [];
  const links = linksRes.data || [];
  const details = detailsRes.data || [];
  const contacts = contactsRes.data || [];

  const assembledItems = items.map((item) => ({
    id: item.id,
    title: item.title,
    address: item.address || undefined,
    description: item.description || undefined,
    notes: item.notes || undefined,
    highlight: item.highlight || undefined,
    photos: photos.filter((p) => p.item_id === item.id).map((p) => p.url),
    links: links.filter((l) => l.item_id === item.id).map((l) => ({ url: l.url, label: l.label || undefined })),
    details: details.filter((d) => d.item_id === item.id).map((d) => ({ label: d.label, value: d.value })),
    contacts: contacts
      .filter((c) => c.item_id === item.id)
      .map((c) => ({ name: c.name || undefined, role: c.role || undefined, phone: c.phone || undefined, email: c.email || undefined, website: c.website || undefined })),
  }));

  const assembledSections = sections.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description || undefined,
    items: assembledItems.filter((item) =>
      items.find((i) => i.id === item.id && i.section_id === section.id)
    ),
  }));

  return buildPacketWithId(packet, profile, assembledSections);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPacketWithId(packet: any, profile: any, sections: Section[]): Packet & { id: string; status: string } {
  return {
    id: packet.id,
    slug: packet.slug,
    title: packet.title,
    clientTitle: packet.client_title || undefined,
    clientName: packet.client_name || undefined,
    personalNote: packet.personal_note || undefined,
    mapUrl: packet.map_url || undefined,
    status: packet.status,
    // The creator's preview must be recipient-truthful, so it reads the same
    // preferences the live page does.
    showQuickNav: packet.show_quick_nav !== false,
    styleTreatment: packet.style_treatment ?? undefined,
    sections,
    professional: resolveProfessional(packet, profile),
  };
}
