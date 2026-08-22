import { corpora, chunksOf, buildStructuralContext, contaminationCheck } from "./lib.mts";
for (const c of await corpora()) {
  const chunks = chunksOf(c.text);
  const b = buildStructuralContext(c.text, chunks[0], chunks.length);
  const hits = contaminationCheck(b, c.text);
  console.log(`\n===== ${c.key}  (contamination hits: ${hits.length}${hits.length ? " -> " + JSON.stringify(hits.slice(0,3)) : ""})`);
  console.log(b);
}
