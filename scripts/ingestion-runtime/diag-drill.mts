// Is "ABSENT" a real loss, or my matcher failing on a reformatted value?
// A value the model legitimately normalised ("$4,090/month" -> "$4,090") must
// not be counted as lost — that would inflate the headline and send us chasing
// a defect that is not there.
import { readFileSync } from "node:fs";
import { locate, survives } from "../../src/lib/placement.ts";
import { squash } from "../../src/lib/fact-match.ts";
const runs = [1, 2].map((n) => JSON.parse(readFileSync(`/tmp/diag-run${n}.json`, "utf8")));
const SRC = JSON.parse(readFileSync("/tmp/diag-source.json", "utf8")) as { name: string; cells: string[] }[];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const pick = (list: any[], name: string) => list.find((x) => {
  const t = norm(String(x.payload?.title ?? "")); const k = norm(name);
  return t === k || t.startsWith(k.slice(0, 14)) || k.startsWith(t.slice(0, 14));
});
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z0-9 /&()'’.+-]{1,44}):\s*(\S.*)$/;
const CONTACT = /^(community phone|contact name|contact title|cell phone|email address|existing website|phone|email|website)\b/i;
/** Digits only — survives any reformatting that keeps the numbers. */
const digits = (s: string) => s.replace(/\D/g, "");

let absent = 0, reformatted = 0, trulyGone = 0;
const gone: string[] = [], reshaped: string[] = [];
for (const s of SRC) {
  for (const which of [0, 1]) {
    const P = pick(runs[which].proposals, s.name)?.payload;
    if (!P) continue;
    const blob = JSON.stringify(P);
    for (const cell of s.cells.slice(2, 4))
      for (const line of String(cell ?? "").split("\n")) {
        const m = LABEL_LINE.exec(line.trim());
        if (!m || /^picture\b/i.test(m[1]) || CONTACT.test(m[1])) continue;
        const value = m[2].trim();
        if (locate(P, value).length) continue;
        absent++;
        const d = digits(value);
        // Present-but-reformatted: its digits survive, or a long word-run does.
        const words = squash(value).slice(0, 18);
        if ((d.length >= 3 && digits(blob).includes(d)) || (words.length >= 12 && squash(blob).includes(words)) || survives(P, value)) {
          reformatted++; if (reshaped.length < 8) reshaped.push(`r${which + 1} ${s.name} · ${m[1]}: ${value.slice(0, 54)}`);
        } else {
          trulyGone++; if (gone.length < 14) gone.push(`r${which + 1} ${s.name} · ${m[1]}: ${value.slice(0, 54)}`);
        }
      }
  }
}
console.log(`\nWHAT "ABSENT" ACTUALLY MEANS  (both runs, labelled non-contact facts)\n`);
console.log(`  exact-string miss ............ ${absent}`);
console.log(`  ...present, reformatted ...... ${reformatted}   NOT a loss`);
console.log(`  ...genuinely gone ............ ${trulyGone}`);
console.log(`\n  reformatted examples:`);
for (const x of reshaped) console.log(`    ${x}`);
console.log(`\n  genuinely gone:`);
for (const x of gone) console.log(`    ${x}`);
console.log("");
