// Entry-point-aware validation of a model result BEFORE it is staged.
//
// Why this exists: finalize_ingestion_run reads result->'sections' for
// organize/append and result->'items' for section_append, and coalesces a
// missing key to '[]'. So a structurally wrong result — items-only output on an
// append run, or an empty sections array — stages happily, every chunk reports
// "completed", and the run finalizes with ZERO content. The professional sees a
// successful import that added nothing, with no error to retry.
//
// Validating here converts that silent no-op into a visible, retryable failure:
// the chunk is marked failed, nothing is staged, and finalize (which requires
// every leaf chunk completed) never runs.
//
// Deliberately permissive about OPTIONAL fields — models legitimately omit
// address/notes/links/contacts. What is required is the correct top-level shape
// for the entry point and at least one usable item, since a chunk of source text
// that yields no items is silent data loss.

export type ResultShape = "sections" | "items";

export function shapeFor(entryPoint: string): ResultShape {
  return entryPoint === "section_append" ? "items" : "sections";
}

export type ValidationOk = { ok: true; result: Record<string, unknown>; itemCount: number };
export type ValidationErr = { ok: false; code: string; message: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasUsableTitle = (it: Record<string, unknown>) =>
  typeof it.title === "string" && it.title.trim().length > 0;

// A retryable, human-readable message. The orchestrator surfaces this and the
// chunk stays failed, so the user can retry that part.
const err = (code: string, message: string): ValidationErr => ({ ok: false, code, message });

function validateItem(it: unknown, where: string): ValidationErr | null {
  if (!isPlainObject(it)) return err("item_not_object", `The AI returned a malformed item in ${where}.`);
  for (const [key, val] of [["details", it.details], ["links", it.links], ["photos", it.photos], ["contacts", it.contacts]] as const) {
    if (val !== undefined && val !== null && !Array.isArray(val)) {
      // A bare object here is the old single-contact shape; accepting it would
      // silently collapse two people into one.
      return err(`${key}_not_array`, `The AI returned a malformed "${key}" list in ${where}.`);
    }
  }
  for (const [key, val] of [["details", it.details], ["links", it.links], ["contacts", it.contacts]] as const) {
    if (Array.isArray(val) && val.some((e) => !isPlainObject(e))) {
      return err(`${key}_entry_not_object`, `The AI returned a malformed "${key}" entry in ${where}.`);
    }
  }
  if (Array.isArray(it.photos) && it.photos.some((p) => typeof p !== "string")) {
    return err("photo_not_string", `The AI returned a malformed photo URL in ${where}.`);
  }
  return null;
}

export function validateEntryPointResult(entryPoint: string, data: unknown): ValidationOk | ValidationErr {
  const shape = shapeFor(entryPoint);
  const RETRY = "Please retry this part.";

  if (!isPlainObject(data)) return err("result_not_object", `The AI response wasn't structured data. ${RETRY}`);

  if (shape === "items") {
    const { items } = data;
    if (items === undefined) {
      // The classic wrong-shape case: sections-only output on a section_append run.
      const got = Array.isArray((data as { sections?: unknown }).sections) ? "sections" : "no items";
      return err("wrong_shape_expected_items", `The AI returned ${got} instead of a list of items. ${RETRY}`);
    }
    if (!Array.isArray(items)) return err("items_not_array", `The AI returned a malformed list of items. ${RETRY}`);
    if (items.length === 0) return err("no_items", `The AI returned no items for this part. ${RETRY}`);
    for (const it of items) {
      const bad = validateItem(it, "this part");
      if (bad) return { ...bad, message: `${bad.message} ${RETRY}` };
    }
    if (!items.some((it) => hasUsableTitle(it as Record<string, unknown>))) {
      return err("no_usable_item", `The AI returned items with no titles. ${RETRY}`);
    }
    return { ok: true, result: { items }, itemCount: items.length };
  }

  const { sections } = data;
  if (sections === undefined) {
    const got = Array.isArray((data as { items?: unknown }).items) ? "a bare list of items" : "no sections";
    return err("wrong_shape_expected_sections", `The AI returned ${got} instead of sections. ${RETRY}`);
  }
  if (!Array.isArray(sections)) return err("sections_not_array", `The AI returned a malformed set of sections. ${RETRY}`);
  if (sections.length === 0) return err("no_sections", `The AI returned no sections for this part. ${RETRY}`);

  let itemCount = 0;
  let usable = false;
  for (const sec of sections) {
    if (!isPlainObject(sec)) return err("section_not_object", `The AI returned a malformed section. ${RETRY}`);
    const items = sec.items;
    if (items !== undefined && items !== null && !Array.isArray(items)) {
      return err("section_items_not_array", `The AI returned a malformed item list in a section. ${RETRY}`);
    }
    for (const it of Array.isArray(items) ? items : []) {
      const bad = validateItem(it, "a section");
      if (bad) return { ...bad, message: `${bad.message} ${RETRY}` };
      itemCount++;
      if (hasUsableTitle(it as Record<string, unknown>)) usable = true;
    }
  }
  // Sections with no items at all means this slice of the source produced nothing
  // usable — exactly the silent-no-op case.
  if (itemCount === 0) return err("no_items_in_sections", `The AI returned sections with no items. ${RETRY}`);
  if (!usable) return err("no_usable_item", `The AI returned items with no titles. ${RETRY}`);

  return { ok: true, result: { sections }, itemCount };
}
