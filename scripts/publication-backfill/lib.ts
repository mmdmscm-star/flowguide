// THE 0054 BACKFILL, as functions over a Supabase client (service role).
//
// For every Sendset published before 0052 — published, no packet_publications
// row — store the frozen copy of exactly what its public page renders today.
//
// Per Sendset, in this order:
//   1. read packet_backfill_token (BEFORE anything the copy is built from);
//   2. build the copy with the publish builder, using the identity the live page
//      shows (the stored snapshot, or the live profile when that is null);
//   3. render the live page with getPublishedPacket and REFUSE unless the copy
//      equals it by value;
//   4. (apply only) call backfill_packet_publication with the token from step 1,
//      so anything that changed during steps 2–3 makes the database refuse;
//   5. (apply only) read the row back and confirm it equals the copy by value.
//
// Comparisons are by VALUE (canonicalJson), never bytes: jsonb reorders keys.
// The manifest digest is the database's sha256 of the STORED jsonb text, which
// does not depend on the key order the copy was sent in.
import { buildPublicationSnapshot, getPublishedPacket, PUBLICATION_FORMAT_VERSION } from "../../src/lib/queries.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Key-order-independent JSON text: object keys sorted at every depth; array order kept. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The professional_snapshot to hand the builder so the frozen card is the one the
 * live page shows. Mirrors getPublishedPacket: a stored snapshot is used as is;
 * a null one means the page shows the live account profile, in the shape the
 * publish route stores it. Step 3 is the proof — any mismatch is refused.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function identityForLiveRender(packet: any, profile: any): Record<string, unknown> {
  const s = packet.professional_snapshot;
  if (s !== null && s !== undefined) return s && typeof s === "object" ? s : {};
  if (!profile) return {};
  return {
    name: profile.name || "", email: profile.email || "", phone: profile.phone || "",
    businessName: profile.business_name || "", logoUrl: profile.logo_url || "",
    headshotUrl: profile.headshot_url || "", footerLabel: profile.footer_label ?? "Your Advisor",
    websiteUrl: profile.website_url || "", links: profile.links || [],
  };
}

export type ManifestEntry = { packet_id: string; published_at: string; source_draft_rev: number; content_sha256: string };
export type Outcome =
  | { packetId: string; outcome: "would_backfill" }
  | { packetId: string; outcome: "backfilled"; manifest: ManifestEntry }
  | { packetId: string; outcome: "skipped"; reason: "not_found" | "not_published" | "publication_exists" }
  | { packetId: string; outcome: "refused"; reason: string; detail?: string }
  | { packetId: string; outcome: "stored_but_unverified"; reason: string; manifest: ManifestEntry };

const errOf = (e: { message?: string } | null | undefined) => e?.message ?? "unknown error";

/** Published Sendsets with no publication row, in id order. */
export async function listCandidates(db: Db): Promise<string[]> {
  const pk = await db.from("packets").select("id").eq("status", "published");
  if (pk.error) throw new Error(`could not list published Sendsets: ${errOf(pk.error)}`);
  const pubs = await db.from("packet_publications").select("packet_id");
  if (pubs.error) throw new Error(`could not list publications: ${errOf(pubs.error)}`);
  const has = new Set((pubs.data as { packet_id: string }[]).map((r) => r.packet_id));
  return (pk.data as { id: string }[]).map((r) => r.id).filter((id) => !has.has(id)).sort();
}

export async function backfillOne(db: Db, packetId: string, { apply }: { apply: boolean }): Promise<Outcome> {
  // 1. The token, before any read the copy depends on.
  const tok = await db.rpc("packet_backfill_token", { p_packet_id: packetId });
  if (tok.error) return { packetId, outcome: "refused", reason: "token_unavailable", detail: errOf(tok.error) };
  const token = tok.data as Record<string, Json> | null;
  if (!token) return { packetId, outcome: "skipped", reason: "not_found" };
  if (token.status !== "published") return { packetId, outcome: "skipped", reason: "not_published" };
  if (token.has_publication) return { packetId, outcome: "skipped", reason: "publication_exists" };

  // 2. The copy, from the same builder publish uses.
  const pk = await db.from("packets").select("*").eq("id", packetId).single();
  if (pk.error || !pk.data) return { packetId, outcome: "refused", reason: "read_failed", detail: errOf(pk.error) };
  let profile = null;
  if (token.identity_from_profile) {
    const pr = await db.from("professional_profiles").select("*").eq("user_id", pk.data.user_id).maybeSingle();
    if (pr.error) return { packetId, outcome: "refused", reason: "read_failed", detail: errOf(pr.error) };
    profile = pr.data;
  }
  let copy: Record<string, unknown>;
  try {
    copy = await buildPublicationSnapshot(db, packetId, identityForLiveRender(pk.data, profile)) as never;
  } catch (e) {
    return { packetId, outcome: "refused", reason: "build_failed", detail: (e as Error).message };
  }

  // 3. Exactly what the page renders today, or nothing.
  const live = await getPublishedPacket(pk.data.slug, db);
  if (!live) return { packetId, outcome: "refused", reason: "live_page_missing" };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { title: _internal, ...recipient } = live as unknown as Record<string, unknown>;
  if (canonicalJson(JSON.parse(JSON.stringify(recipient))) !== canonicalJson(copy)) {
    return { packetId, outcome: "refused", reason: "differs_from_live_page" };
  }

  if (!apply) return { packetId, outcome: "would_backfill" };

  // 4. The database re-checks everything under the Sendset lock.
  const res = await db.rpc("backfill_packet_publication", {
    p_packet_id: packetId, p_expected_token: token, p_format_version: PUBLICATION_FORMAT_VERSION, p_content: copy,
  });
  if (res.error) {
    const detail = (res.error as { details?: string }).details;
    if (detail === "publication_exists" || detail === "not_published" || detail === "not_found") {
      return { packetId, outcome: "skipped", reason: detail };
    }
    return { packetId, outcome: "refused", reason: detail || "backfill_failed", detail: errOf(res.error) };
  }
  const r = res.data as { publishedAt: string; sourceDraftRev: number; contentSha256: string };
  const manifest: ManifestEntry = { packet_id: packetId, published_at: r.publishedAt, source_draft_rev: r.sourceDraftRev, content_sha256: r.contentSha256 };

  // 5. Stored means stored as built.
  const back = await db.from("packet_publications").select("content, published_at").eq("packet_id", packetId).single();
  if (back.error || !back.data) return { packetId, outcome: "stored_but_unverified", reason: `read_back_failed: ${errOf(back.error)}`, manifest };
  if (canonicalJson(back.data.content) !== canonicalJson(copy)) return { packetId, outcome: "stored_but_unverified", reason: "read_back_differs", manifest };
  // Both are timestamptz columns rendered by the same connection: equal instants render identically.
  if (back.data.published_at !== pk.data.published_at || r.publishedAt == null) {
    return { packetId, outcome: "stored_but_unverified", reason: "published_at_differs", manifest };
  }
  return { packetId, outcome: "backfilled", manifest };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Kept as the database rendered it. Never round-tripped through a JS Date, which
// keeps milliseconds and would silently drop the microseconds the match needs.
const TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * SQL that removes backfilled rows — and ONLY a row whose stored content digest
 * and published_at still equal the manifest's, so a Sendset republished since
 * keeps its publication. Run as postgres (service_role cannot delete). Returns
 * the counts deleted and kept.
 */
export function rollbackSql(manifest: ManifestEntry[]): string {
  if (manifest.length === 0) throw new Error("empty manifest: nothing to roll back");
  const values = manifest.map((m) => {
    if (!UUID.test(m.packet_id) || !HEX64.test(m.content_sha256) || !TIMESTAMPTZ.test(m.published_at)) {
      throw new Error(`malformed manifest entry: ${JSON.stringify(m)}`);
    }
    return `  ('${m.packet_id}'::uuid, '${m.content_sha256}', '${m.published_at}'::timestamptz)`;
  });
  return `-- Removes 0054-backfilled publications named in a manifest, only while unchanged.
begin;
create temp table _backfill_manifest (packet_id uuid primary key, content_sha256 text not null, published_at timestamptz not null) on commit drop;
insert into _backfill_manifest values
${values.join(",\n")};
create temp table _backfill_rollback_result on commit drop as
with deleted as (
  delete from public.packet_publications x
   using _backfill_manifest m
   where x.packet_id = m.packet_id
     and encode(sha256(convert_to(x.content::text, 'UTF8')), 'hex') = m.content_sha256
     and x.published_at = m.published_at
  returning x.packet_id
)
select (select count(*) from deleted) as deleted,
       (select count(*) from _backfill_manifest m where m.packet_id not in (select packet_id from deleted)
          and exists (select 1 from public.packet_publications x where x.packet_id = m.packet_id)) as kept_changed,
       (select count(*) from _backfill_manifest m where m.packet_id not in (select packet_id from deleted)
          and not exists (select 1 from public.packet_publications x where x.packet_id = m.packet_id)) as already_absent;
select * from _backfill_rollback_result;
commit;
`;
}
