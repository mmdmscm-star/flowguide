// DETAIL ORDER IS THE ARRAY.
//
// item_details has carried a sort_order since the beginning, and
// update_item_content assigns it from the POSITION of each entry in the details
// array the client sends. Every read path already selects order("sort_order") —
// the editor, the live FlowGuide, print, email, the Library. So the professional
// has always had durable ordering available; what was missing was any way to
// change the array.
//
// Which is why this is not a schema change. Moving a row and saving the list is
// the whole feature.
//
// Kept out of the editor component so the semantics can be tested directly:
// that a move reorders and nothing else, and that editing a row afterwards
// leaves it where it was put.

export interface OrderedDetail {
  id: string;
  label: string;
  value: string;
}

/**
 * Move the row `activeId` to where `overId` sits, closing the gap behind it.
 *
 * Returns the SAME array reference when nothing should change — an unknown id,
 * or a row dropped on itself — so a stray drag cannot mark the FlowGuide dirty
 * or trigger a save that writes the order it already had.
 */
export function moveDetail<T extends { id: string }>(details: T[], activeId: string, overId: string): T[] {
  if (activeId === overId) return details;
  const from = details.findIndex((d) => d.id === activeId);
  const to = details.findIndex((d) => d.id === overId);
  if (from === -1 || to === -1) return details;
  const next = [...details];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * What the save sends. Position carries the order, so the payload is the list
 * in its current sequence and nothing else — no ordinal to keep in step with
 * the array and no chance of the two disagreeing.
 */
export function detailsPayload(details: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  return details.map((d) => ({ label: d.label, value: d.value }));
}
