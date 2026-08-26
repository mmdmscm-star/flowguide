// ONE COMMUNITY, ONE PROPOSAL — across a chunk boundary.
//
// A Library import extracts items chunk by chunk, and
// `library_materialize_proposals` expands every item of every completed chunk
// into its own proposal. That is correct until a single community's text
// STRADDLES a boundary: the model then describes it twice — pricing and contact
// in the tail of one chunk, description and photos in the head of the next —
// and the professional is handed two half-populated records for one community.
// Measured on the real 65-community source: 67 proposals, two communities split
// (`The Reserve at Fountaingrove`, `Cogir of North Bay`).
//
// WHY NOT `is_continuation`. It looked like the obvious signal and is not: on
// that same source it is TRUE for 54 of 56 chunks, and FALSE for chunk 54 —
// the actual continuation of Cogir of North Bay. It answers "does this chunk
// begin mid-block", which is nearly always yes, not "is this the same record".
// `section_hint` is empty for every chunk on this path.
//
// THE SIGNAL THAT DOES HOLD is the model's own answer. Both straddling chunks
// contain the community name further into their text, so both halves come back
// TITLED with it. Identity is therefore carried in the output, and merging is a
// question about titles rather than about offsets.
//
// DELIBERATELY CONSERVATIVE. Two proposals merge only when all of these hold:
//   * they are ADJACENT in source order — nothing reaches across a third record
//   * they come from DIFFERENT chunks — one chunk listing two communities that
//     genuinely share a name is not a split, it is two records
//   * their community keys are EQUAL, never merely a shared prefix
// Prefix matching would merge `Ivy Park at Piner` with `Ivy Park at Santa Rosa`,
// which are different communities in this very source. Equality will not.

export interface ProposalLike {
  id?: string;
  ordinal: number;
  idx: number;
  title?: string | null;
  address?: string | null;
  description?: string | null;
  details?: Array<{ label?: string; value?: string }> | null;
  links?: Array<{ url?: string; label?: string }> | null;
  photos?: string[] | null;
  contacts?: Array<Record<string, unknown>> | null;
  [k: string]: unknown;
}

/** A community's identity, reduced to what two halves of it will agree on.
 *
 *  Strips a trailing " — City" qualifier because the first half of a split
 *  often keeps it and the second half does not, and folds accents so `Ensō`
 *  and `Enso` are one community rather than two. */
export function communityKey(title: unknown): string {
  let t = String(title ?? "");
  t = t.split(/\s[—–-]\s/)[0];                    // drop a trailing " — City"
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => String(v ?? "").trim();

/** Union two lists, keeping first-seen order and dropping exact repeats. */
function union<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const out: T[] = []; const seen = new Set<string>();
  for (const x of [...a, ...b]) {
    const k = key(x);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(x);
  }
  return out;
}

/** Fold the later half into the earlier one. Nothing is dropped: every field
 *  takes the fuller of the two, and every list is unioned. */
export function mergeProposals(a: ProposalLike, b: ProposalLike): ProposalLike {
  const longer = (x: unknown, y: unknown) => (str(x).length >= str(y).length ? str(x) : str(y));
  return {
    ...a,
    // The fuller title wins: "Cogir of North Bay — Vallejo" over "Cogir of
    // North Bay", because the qualifier is information the other half lost.
    title: longer(a.title, b.title),
    address: longer(a.address, b.address),
    description: longer(a.description, b.description),
    details: union(arr<{label?:string;value?:string}>(a.details), arr(b.details),
      (d) => `${str(d.label).toLowerCase()}|${str(d.value).toLowerCase()}`),
    links: union(arr<{url?:string;label?:string}>(a.links), arr(b.links), (l) => str(l.url).toLowerCase()),
    photos: union(arr<string>(a.photos), arr(b.photos), (p) => str(p).toLowerCase()),
    contacts: union(arr<Record<string, unknown>>(a.contacts), arr(b.contacts),
      (c) => ["name","role","phone","email","website"].map((k) => str(c[k]).toLowerCase()).join("|")),
  };
}

export interface MergePlan {
  /** The proposal that survives, carrying the union. */
  keep: ProposalLike;
  /** The proposal absorbed into it. */
  absorb: ProposalLike;
  merged: ProposalLike;
}

/**
 * Which proposals are two halves of one community.
 *
 * `ordered` must already be in SOURCE order — a split chunk's children carry
 * higher ordinals while their text belongs mid-paste, so ordinal order is not
 * source order and using it would compare the wrong neighbours.
 */
export function planContinuationMerges(ordered: ProposalLike[]): MergePlan[] {
  const plans: MergePlan[] = [];
  let i = 0;
  while (i < ordered.length - 1) {
    const a = ordered[i], b = ordered[i + 1];
    const ka = communityKey(a.title), kb = communityKey(b.title);
    if (ka && ka === kb && a.ordinal !== b.ordinal) {
      plans.push({ keep: a, absorb: b, merged: mergeProposals(a, b) });
      i += 2;                       // never chain a third record into the pair
      continue;
    }
    i += 1;
  }
  return plans;
}
