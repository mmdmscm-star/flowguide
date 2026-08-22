import { corpora, chunksOf, buildStructuralContext, contaminationCheck } from "./lib.mts";
const v = (process.env.VARIANT ?? "B3") as "B2" | "B3";
for (const c of await corpora()) {
  const chunks = chunksOf(c.text);
  const b = buildStructuralContext(c.text, chunks[0], chunks.length, v);
  console.log(`\n===== ${c.key} [${v}]  contamination hits: ${contaminationCheck(b, c.text).length}`);
  console.log(b);
}
