// HOW MANY THINGS IS THIS SOURCE?
//
// Nothing used to ask. The model formed one opinion about item granularity from
// the shape of the text, the deterministic side formed its own by tiling the
// source into records, and when those two disagreed every proposal failed to
// bind — producing one review card per row for a single misunderstanding about
// scope. Twenty-six cards, one mistake.
//
// So this is the creator's answer to that question, persisted on the run:
//
//   auto            nobody was asked. Automatic record detection, exactly as
//                   before. THE DEFAULT, and the whole existing corpus.
//   keep_together   the creator declares the entire source is ONE record, and
//                   names it.
//   split           the creator declares many. Persisted and valid; today it
//                   behaves identically to auto and is not offered in the UI,
//                   because claiming otherwise would be a distinction the code
//                   does not yet make.
//
// ONE VALUE FEEDS BOTH SIDES, and that is the point of this module rather than
// two flags. The prompt rule and the enforcement rule are both derived from the
// same persisted intent, so the state that looks like a fix and is not — the
// model told to produce one item while the deterministic side still tiles the
// source into many — cannot be reached. It was measured: that combination
// yields one review card and still withholds every fact.

export type GroupingIntent = "auto" | "keep_together" | "split";

export interface Grouping {
  intent: GroupingIntent;
  /** The creator's own name for the single item. Present only for
   *  keep_together, where the database requires it. */
  title: string | null;
}

/** Read what the run says, defaulting to the historical behaviour.
 *
 *  Anything unrecognised becomes `auto` rather than throwing: an unknown intent
 *  should behave like the product did before intents existed, not fail a chunk
 *  the professional is waiting on. The database CHECK is what stops one being
 *  written in the first place. */
export function groupingOf(row: {
  grouping_intent?: unknown; grouping_title?: unknown;
} | null | undefined): Grouping {
  const raw = String(row?.grouping_intent ?? "auto");
  const intent: GroupingIntent =
    raw === "keep_together" || raw === "split" ? raw : "auto";
  const title = String(row?.grouping_title ?? "").trim();
  return { intent, title: intent === "keep_together" && title ? title : null };
}

/** THE ONE PREDICATE. Both the prompt and the enforcement ask this, so they
 *  cannot answer it differently. */
export function keepsTogether(g: Grouping | null | undefined): boolean {
  return g?.intent === "keep_together" && Boolean(g.title);
}

/**
 * What to add to the structuring prompt, and nothing when nobody asked.
 *
 * Deliberately an ADDITION rather than an edit to the existing prompts. Under
 * `auto` this returns "" and the prompt the model receives is byte-identical to
 * the one it received before this feature existed — which is the property that
 * keeps the default path a true no-op rather than a change nobody measured.
 *
 * It constrains SHAPE, never content: one item, this title. The rules about
 * preserving every specific, inventing nothing, and where prices may come from
 * are the existing prompt's and are not restated, weakened or overridden here.
 */
export function groupingPromptRule(g: Grouping | null | undefined): string {
  if (!keepsTogether(g)) return "";
  const title = String(g!.title).replace(/\s+/g, " ").trim();
  return [
    "",
    "GROUPING — THE PROFESSIONAL HAS ALREADY DECIDED THIS:",
    `This entire source describes ONE thing. Return EXACTLY ONE item, titled exactly: ${JSON.stringify(title)}`,
    "Do not split it into several items, and do not rename it.",
    "Everything the source says — every row, price, size, type, name and figure —",
    "belongs to that one item, as its details. Preserve all of them; omit nothing",
    "because it did not fit. If the source appears to describe several things,",
    "still return one item and keep every fact inside it.",
  ].join("\n");
}
