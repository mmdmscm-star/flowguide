// WHEN AN ITEM IS REALLY JUST A PICTURE.
//
// "Add picture" makes an ordinary item — same table, same photos, same
// renderers — because a Sendset already knows how to carry and show one, and a
// second content type would have to be taught to every renderer separately.
//
// But the field a creator types into is not the same field to them. On a
// recommendation it is the name of the place; on a map, a diagram or a
// screenshot it is a caption. There is no column saying which, and this feature
// deliberately adds none, so the answer is DERIVED from what the item holds: an
// item with a picture and nothing else is a picture.
//
// IT STOPS BEING ONE THE MOMENT IT CARRIES ANYTHING ELSE. Add an address or a
// description and the field goes back to being a title, because the item has
// gone back to being a thing rather than an image. That is the honest reading
// of the content, and it means nothing has to remember what the creator
// originally pressed — a label that survives a reload without being stored.
//
// Note this can also be true of an item that arrived some other way. That is
// fine: calling the field "Caption" on an item that is only a photo is right
// however it got there.

interface Blank { [k: string]: unknown }

const filled = (v: unknown) => String(v ?? "").trim().length > 0;
/** A row the creator started but has not filled in is not content. The editor
 *  keeps blank rows on screen while they are being typed into, and persistence
 *  drops them, so they must not count here either. */
const anyFilled = (rows: unknown, keys: string[]) =>
  Array.isArray(rows) && rows.some((r) => keys.some((k) => filled((r as Blank)?.[k])));

export interface PictureItemShape {
  address?: string;
  description?: string;
  photos?: unknown;
  details?: unknown;
  links?: unknown;
  contacts?: unknown;
}

export function isPictureItem(item: PictureItemShape | null | undefined): boolean {
  if (!item) return false;
  const photos = Array.isArray(item.photos) ? item.photos : [];
  // A real, stored picture — not the blank row "Add photo" leaves behind.
  const hasPhoto = photos.some((p) => {
    const url = typeof p === "string" ? p : String((p as Blank)?.url ?? "");
    return /^https?:\/\//i.test(url.trim());
  });
  if (!hasPhoto) return false;

  // `notes` is absent on purpose: it is private to the professional and never
  // reaches a recipient, so it says nothing about what this item IS to a
  // reader. `highlight` is absent for the opposite reason — it is written ABOUT
  // something, and a caption is the natural place for it on a picture.
  if (filled(item.address) || filled(item.description)) return false;
  if (anyFilled(item.details, ["label", "value"])) return false;
  if (anyFilled(item.links, ["url"])) return false;
  if (anyFilled(item.contacts, ["name", "role", "phone", "email", "website"])) return false;
  return true;
}

/** What to call the item's one required text field, for this item. */
export const titleLabelFor = (item: PictureItemShape | null | undefined) =>
  isPictureItem(item) ? "Caption" : "Item title";
