// LABEL SHAPES — a detector fixture, not a model corpus.
//
// It exists because the first fix for prose lead-ins banned digits from labels,
// which reached 100% precision on corpora that happen to contain no digit-
// bearing labels. That is overfitting: `2nd Person Fee` and `Level 2 Care` are
// things professionals type, and a detector that silently drops them would lose
// real facts while reporting a perfect score.
//
// Kept separate from corpus v1/v2 on purpose. Those two are joined to persisted
// model runs, and adding records to them would move chunk boundaries and
// invalidate that join. Detector questions get a detector fixture.
//
// `label` is what the detector SHOULD extract, or null if the line is prose that
// must not be read as a fact.
export type LabelCase = { line: string; label: string | null; why: string };

export const LABEL_CASES: LabelCase[] = [
  // --- digit-bearing labels. The whole reason this file exists. ---
  { line: "2nd Person Fee: $950/month", label: "2nd Person Fee", why: "ordinal prefix" },
  { line: "Level 2 Care: $1,400 added to base rate", label: "Level 2 Care", why: "care tier" },
  { line: "24-Hour Support: included at all levels", label: "24-Hour Support", why: "leading number" },
  { line: "Studio 1: $4,150/month", label: "Studio 1", why: "unit number" },
  { line: "1 Bedroom Deluxe: $5,600/month", label: "1 Bedroom Deluxe", why: "leading digit" },
  { line: "Tier 3 Memory Care: $7,900/month", label: "Tier 3 Memory Care", why: "tier in the middle" },
  { line: "2026 Rate Sheet: effective 1 January", label: "2026 Rate Sheet", why: "year as label" },
  { line: "Room 214 Monthly: $3,300", label: "Room 214 Monthly", why: "room number" },

  // --- letter-suffixed labels, which a case-blind stop-word test would eat ---
  { line: "Building B: memory care only", label: "Building B", why: "capital A/B must not read as an article" },
  { line: "Care Level A: $600 added", label: "Care Level A", why: "same, mid-label" },

  // --- sentence case. Title case is a corpus habit, not a rule. ---
  { line: "Community fee: $3,500 one time", label: "Community fee", why: "sentence case" },
  { line: "Move-in fee: $2,000", label: "Move-in fee", why: "hyphen, sentence case" },
  { line: "Respite care rate: $195/day", label: "Respite care rate", why: "three words, sentence case" },

  // --- connectors that legitimately appear inside labels ---
  { line: "Days of Operation: Monday to Friday", label: "Days of Operation", why: "'of' is not a clause marker" },
  { line: "Fee for Second Person: $950", label: "Fee for Second Person", why: "'for' is not a clause marker" },
  { line: "Meals & Housekeeping: included", label: "Meals & Housekeeping", why: "ampersand" },
  { line: "Board and Care Rate: $4,800/month", label: "Board and Care Rate", why: "'and' inside a label" },
  { line: "Sat/Sun Coverage: on request", label: "Sat/Sun Coverage", why: "slash" },
  { line: "All-Inclusive Monthly: $6,200", label: "All-Inclusive Monthly", why: "hyphen" },

  // --- ordinary labels, as a control ---
  { line: "Community Fee: $3,500", label: "Community Fee", why: "control" },
  { line: "Capacity: 84 residents", label: "Capacity", why: "single word" },
  { line: "Notes: reliable for short-notice cover", label: "Notes", why: "a real one-word label whose value is prose" },
  { line: "Assisted Living One Bedroom: $5,200/month", label: "Assisted Living One Bedroom", why: "four words" },

  // --- prose lead-ins. Colon-shaped, but NOT facts. ---
  { line: "Notes from the tour on 4 March: the dining room was busy", label: null, why: "seven words, and 'the'" },
  { line: "What the family said afterwards: they want a second visit", label: null, why: "'the'" },
  { line: "The director was candid about pricing: expect an increase", label: null, why: "'the' and 'was'" },
  { line: "A quick reminder before you call: ask for the coordinator", label: null, why: "lowercase 'a'" },
  { line: "Things I noticed while I was there: staffing looked thin", label: null, why: "seven words" },
  { line: "Update after my second visit last week: still no opening", label: null, why: "seven words" },
  { line: "This is what the intake nurse told me: bring the POA", label: null, why: "'this', 'is', 'the'" },

  // --- KNOWN LIMITATION, recorded rather than tuned away. ---
  // Four words, no determiner, no verb: grammatically indistinguishable from a
  // label. Adding "to" to the marker set would break "Fee for Second Person"
  // style labels for a case this rare, so it is left as a known false positive.
  // Its cost is bounded: a spurious unresolved entry, never a lost fact.
  { line: "One thing to remember: the waitlist moves fast", label: null, why: "KNOWN MISS — reads as a label" },
];

export const SOURCE = LABEL_CASES.map((c) => c.line).join("\n");
