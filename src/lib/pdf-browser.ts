// READING A PDF IN THE BROWSER — the only file that loads pdf.js.
//
// LAZY. pdf.js and its worker are about 1.5MB between them, and most visits to
// New Sendset never see a PDF. Nothing here runs until one is dropped: the
// module is imported on first use and kept, so the second PDF costs nothing.
//
// THE WORKER AND CHARACTER MAPS are served from /pdfjs/, copied there from the
// installed package at build time (scripts/copy-pdfjs-assets.mjs), so they can
// never be a different version from the library that asks for them.
//
// THE FILE STAYS HERE. Its bytes are read into memory, handed to the worker in
// this tab, and dropped. No request carries them anywhere.
import { extractPdf, type PdfResult, type PdfjsModule } from "./pdf-extract";

let loading: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    return pdfjs as unknown as PdfjsModule;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

export async function readPdfInBrowser(file: File, remainingChars: number): Promise<PdfResult> {
  let pdfjs: PdfjsModule;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    return { ok: false, code: "malformed", message: "Sendset couldn’t load its PDF reader. Check your connection and try again." };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return extractPdf(file.name, bytes, { pdfjs, cMapUrl: "/pdfjs/cmaps/", remainingChars });
}
