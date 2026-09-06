// ONE WAY IN, WHATEVER THE GESTURE.
//
// A professional can now hand `/new` several files at once — three photographed
// brochure pages, or a spreadsheet, or both — by browsing or by dropping. Those
// are two gestures and they must not become two code paths: a drop handler with
// its own idea of what a supported file is, or its own upload call, is a second
// implementation of the rule that will drift from the first. So both gestures
// produce a `File[]`, both hand it here, and what comes back is the same
// ordered plan either way.
//
// ORDER IS THE PROFESSIONAL'S. Pages one, two and three of a brochure are not a
// set, they are a sequence, and the transcription that comes out has to read in
// that order. So this preserves the order it was given and nothing sorts,
// groups or interleaves afterwards — including a text file, which is read
// locally in microseconds and would otherwise finish first and jump the queue.
//
// AT MOST ONE TEXT FILE, and that is a product rule rather than a limitation.
// Two spreadsheets concatenated become one source_text whose record structure
// is a fiction: delimiterForFile already refuses to guess when two files
// declare different delimiters, and the segmenter would then tile the join as
// though it were one document. Images are different — they are pages of one
// thing by construction, and a photograph declares no structure at all.

import { isSupportedTextFile, rejectionFor } from "./text-file-import.ts";
import { ACCEPTED_PHOTO_TYPES, MAX_UPLOAD_BYTES, OVERSIZED_IMAGE_MESSAGE } from "./photo-upload.ts";

/** Extensions matching the mime allowlist. SVG is absent there and so here. */
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];
const IMAGE_MIMES = ACCEPTED_PHOTO_TYPES.map((t) => t.mime);

export type BundleKind = "image" | "text";
export interface BundleItem { kind: BundleKind; file: File }

export type BundlePlan =
  | { ok: true; items: BundleItem[] }
  | { ok: false; message: string };

const extensionOf = (name: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? "").trim());
  return m ? m[1].toLowerCase() : "";
};

/** Is this an image we accept?
 *
 *  BY EITHER SIGNAL, because a dropped file often carries no `type` at all and
 *  a file picked on one platform can carry a type no other platform sets. This
 *  is a ROUTING decision, not a security one — the server sniffs the magic
 *  number of every byte it is sent and refuses anything that merely claims to
 *  be an image. Guessing generously here costs a clear error message; guessing
 *  meanly costs a professional their photograph. */
export function looksLikeImage(file: File): boolean {
  const type = String(file?.type ?? "").toLowerCase();
  if (IMAGE_MIMES.includes(type)) return true;
  return IMAGE_EXTENSIONS.includes(extensionOf(file?.name ?? ""));
}

/**
 * Turn one selection or one drop into an ordered plan, or into the sentence
 * explaining why it is not one.
 *
 * REFUSES THE WHOLE BATCH RATHER THAN PART OF IT. Accepting four of five files
 * and saying so in a line of small text is how a professional ends up
 * organizing a source they think is complete. If a batch cannot be taken as
 * given, none of it is taken.
 */
export function planBundle(files: File[]): BundlePlan {
  const list = (files ?? []).filter(Boolean);
  if (!list.length) return { ok: false, message: "No files were added." };

  const items: BundleItem[] = [];
  let textCount = 0;

  for (const file of list) {
    if (looksLikeImage(file)) {
      // EVERY PICTURE IS SIZED BEFORE ANY OF THEM IS READ.
      //
      // The transport budget is per REQUEST and each picture is its own
      // request, so an oversized page three does not break pages one and two —
      // which is exactly the danger: they would transcribe, page three would
      // fail, and a professional watching four of five pages succeed has every
      // reason to believe the source is complete. Refusing the whole batch up
      // front, by name, is the only version of this that cannot mislead.
      if (file.size > MAX_UPLOAD_BYTES) {
        return { ok: false, message: `${file.name}: ${OVERSIZED_IMAGE_MESSAGE}` };
      }
      items.push({ kind: "image", file });
      continue;
    }

    if (isSupportedTextFile(file.name)) {
      textCount++;
      if (textCount > 1) {
        return { ok: false, message:
          "Add one file at a time — Sendset needs to know where each one begins. " +
          "Pictures can be added together." };
      }
      // The file's own rejection sentence, where it has one: too large, or a
      // supported extension that is nonetheless not readable.
      const why = rejectionFor(file.name, file.size);
      if (why) return { ok: false, message: why };
      items.push({ kind: "text", file });
      continue;
    }

    // Not an image and not a text file we read. text-file-import already has
    // the right sentence for a PDF, a Word document and a spreadsheet, and
    // those are the three things most likely to be tried next.
    return { ok: false, message: rejectionFor(file.name, file.size)
      ?? "That file type isn’t supported." };
  }

  return { ok: true, items };
}

/** The state a picture is in while the bundle is being prepared. */
export type ImageStatus = "reading" | "done" | "failed";

/**
 * The first picture that must be settled before this source can be organized,
 * or null when every one of them is.
 *
 * ORGANIZE IS A CLAIM ABOUT COMPLETENESS. It says: this text is the source, and
 * these images are what it was read from. Neither half of that is true while a
 * picture is unsettled.
 *
 *   READING — its transcription has not landed. The text it will contribute is
 *   not in the box yet, and `handleOrganize` snapshots the box on its first
 *   line, so the run would be created from text missing a page while carrying
 *   the image that page came from.
 *
 *   FAILED — its transcription never landed and never will. Storing it puts an
 *   image in source_image_urls with nothing in source_text behind it: the
 *   removal defect in the opposite direction, and equally invisible to 0048,
 *   which only checks that the evidence a run claims is internally coherent.
 *
 * Both exits are available: a failed picture can be retried or removed, and a
 * reading one only has to be waited for. The one thing that must not happen is
 * organizing around it.
 *
 * PURE, AND SHARED BY THE BUTTON AND THE HANDLER, so a disabled control and a
 * refused action can never disagree about why. The handler's check is the
 * guarantee; the button's is a courtesy.
 */
export function blockingImage<T extends { status: ImageStatus; label: string }>(
  images: T[],
): T | null {
  return (images ?? []).find((i) => i?.status === "reading" || i?.status === "failed") ?? null;
}

/** What to say about it. Names the picture, and names the way out. */
export function blockingMessage(image: { status: ImageStatus; label: string }): string {
  return image.status === "reading"
    ? `${image.label} is still being read. Wait for it to finish before organizing.`
    : `${image.label} couldn’t be read. Try it again or remove it before organizing.`;
}
