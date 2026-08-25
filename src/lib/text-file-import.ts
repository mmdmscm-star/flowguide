// READING A FILE THE PROFESSIONAL ALREADY HAS.
//
// A file is a SEED, not a source of record. It is read in the browser, its text
// goes into the same box a paste goes into, and the file itself is never
// uploaded, stored or referenced again. What `organize` receives is the text —
// identical in kind to a paste — so chunking, the semantic contract,
// provenance and media accounting are untouched, and there is no second
// editing model and no document that can drift out of sync with the FlowGuide.
//
// Text formats only, deliberately. A .csv, .txt or .md IS text; nothing has to
// interpret it. PDF is a print format whose text extraction fails quietly on
// scans, columns and tables, so it is a separate decision rather than one more
// entry in this list.

/** What the file picker accepts, and the single statement of it. */
export const TEXT_FILE_ACCEPT = ".csv,.tsv,.txt,.md,.markdown,text/csv,text/plain,text/markdown";

const EXTENSIONS = ["csv", "tsv", "txt", "md", "markdown"];

/** Matches the server's own ceiling, so a file that could never be organized is
 *  refused here with a sentence instead of a 413 after the upload. */
export const MAX_IMPORT_CHARS = 200_000;

export class TextFileError extends Error {}

/**
 * The delimiter a file EXTENSION declares, or null when it declares none.
 *
 * This is the whole point of the hinted path: a professional who picks a .csv
 * has already told us the delimiter, so nothing has to infer it from the text —
 * and the inference guards that make ordinary one-line-per-row CSVs invisible
 * to record detection do not apply.
 *
 * .txt and .md declare nothing, and get null rather than a guess.
 */
export function delimiterForFile(name: string): string | null {
  const ext = extensionOf(name);
  if (ext === "csv") return ",";
  if (ext === "tsv") return "\t";
  return null;
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

export function isSupportedTextFile(name: string): boolean {
  return EXTENSIONS.includes(extensionOf(name));
}

/**
 * Everything that can go wrong, said in the professional's terms.
 *
 * A PDF gets its own sentence rather than falling into "unsupported". It is the
 * most likely thing to be tried next, and "we can't read PDFs yet" is a
 * different message from "that isn't a file type we know".
 */
export function rejectionFor(name: string, size: number): string | null {
  const ext = extensionOf(name);
  if (ext === "pdf") return "FlowGuide can’t read PDFs yet. Copy the text out and paste it instead.";
  if (["doc", "docx", "pages", "rtf"].includes(ext))
    return "FlowGuide can’t read Word documents yet. Copy the text out and paste it instead.";
  if (["xls", "xlsx", "numbers"].includes(ext))
    return "Save the sheet as CSV and try again — FlowGuide reads .csv.";
  if (!isSupportedTextFile(name))
    return "That file type isn’t supported. Use a .csv, .txt or .md file, or paste the text instead.";
  // Bytes, not characters — a rough gate before reading, so a 40MB file is
  // refused without being loaded into memory first.
  if (size > MAX_IMPORT_CHARS * 4)
    return "That file is too large. Try a smaller export, or paste the part you need.";
  return null;
}

/**
 * The file's text, or a thrown TextFileError a caller can show as-is.
 *
 * Read as UTF-8, which is what a modern export produces. A file saved in a
 * legacy encoding arrives with mangled accents rather than an error — visible
 * in the box before anything is organized, which is why the text is shown to
 * the professional rather than submitted straight through.
 */
export async function readTextFile(file: File): Promise<string> {
  const rejection = rejectionFor(file.name, file.size);
  if (rejection) throw new TextFileError(rejection);

  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new TextFileError("That file couldn’t be read. Try opening it and pasting the text instead.");
  }

  // A file with no readable text is a dead end that would otherwise become an
  // empty draft with no explanation.
  if (!text.trim()) {
    throw new TextFileError("That file looks empty. Check it, or paste the text instead.");
  }
  if (text.length > MAX_IMPORT_CHARS) {
    throw new TextFileError(
      `That file is ${text.length.toLocaleString()} characters — the limit is ${MAX_IMPORT_CHARS.toLocaleString()}. Try a smaller export.`
    );
  }
  // Normalize line endings only. The text is otherwise untouched: it becomes
  // the source of record, and a source that was silently rewritten cannot be
  // reconciled against what the professional actually wrote.
  return text.replace(/\r\n?/g, "\n");
}
