// Copy pdf.js's worker and character maps from the INSTALLED package into
// public/pdfjs/, so the browser loads exactly the version the code was built
// against. Run before dev and before build (package.json predev / prebuild);
// the output is gitignored and regenerated every time, so it cannot go stale.
import { cpSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "node_modules", "pdfjs-dist");
const OUT = join(ROOT, "public", "pdfjs");

const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(PKG, "build", "pdf.worker.min.mjs"), join(OUT, "pdf.worker.min.mjs"));
cpSync(join(PKG, "cmaps"), join(OUT, "cmaps"), { recursive: true });
console.log(`pdf.js ${version}: worker and character maps copied to public/pdfjs/`);
