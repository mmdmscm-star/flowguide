// WHY does record detection decline? Replays the detectors' own gates over the
// measured corpus and names the gate that failed, per input.
const { detectSourceRecords, detectListRecords } = await import("../../src/lib/segmentation.ts");
const { recordEnvelopes } = await import("../../src/lib/attribution.ts");
const { INPUTS } = await import("./inputs.mjs");

const NUMBERED = /^(\s*)(\d{1,2})[.)]\s+(.*)$/;
const BULLETED = /^(\s*)([-*•])\s+(.*)$/;

/** Field counts per line for a delimiter, ignoring blank lines. */
function fieldProfile(src: string, d: string) {
  const rows = src.split("\n").filter((l) => l.trim());
  const counts = rows.map((l) => l.split(d).length);
  const tally = new Map<number, number>();
  for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
  const mode = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return { counts, mode, uniform: counts.every((c) => c === mode), rows: rows.length };
}

function listProfile(src: string) {
  const lines = src.split("\n");
  const out: Record<string, unknown> = {};
  for (const [kind, re] of [["numbered", NUMBERED], ["bulleted", BULLETED]] as const) {
    const hits = lines.map((t) => re.exec(t)).filter(Boolean) as RegExpExecArray[];
    if (!hits.length) { out[kind] = "0 markers"; continue; }
    const minIndent = Math.min(...hits.map((h) => h[1].length));
    const top = hits.filter((h) => h[1].length === minIndent);
    let note = `${top.length} at top level`;
    if (top.length < 3) note += " (needs 3)";
    if (kind === "numbered") {
      const nums = top.map((h) => Number(h[2]));
      const contiguous = nums.every((n, k) => n === nums[0] + k) && (nums[0] === 1 || nums[0] === 0);
      if (!contiguous) note += ` (not contiguous from 1: ${nums.join(",")})`;
    } else {
      const chars = new Set(top.map((h) => h[2]));
      if (chars.size !== 1) note += ` (mixed markers: ${[...chars].join("")})`;
    }
    out[kind] = note;
  }
  return out;
}

for (const input of INPUTS) {
  const env = recordEnvelopes(input.text);
  const tab = detectSourceRecords(input.text);
  const list = detectListRecords(input.text);
  console.log(`\n${input.id}  —  ${input.note}`);
  console.log(`  RESULT: ${env === null ? "NULL" : `${env.length} envelopes via ${tab ? "tabular" : "list"}`}`);
  if (env !== null) continue;
  for (const d of ["\t", ",", ";", "|"]) {
    const p = fieldProfile(input.text, d);
    if (p.mode < 2) continue;
    const name = d === "\t" ? "TAB" : d;
    const gates: string[] = [];
    if (!p.uniform) gates.push(`field counts differ: ${p.counts.join(",")}`);
    if (d !== "\t" && p.mode < 3) gates.push(`mode ${p.mode} < 3 required for non-tab`);
    if (d !== "\t" && p.rows < 3) gates.push(`${p.rows} rows < 3 required for non-tab`);
    if (gates.length) console.log(`    ${name}: ${gates.join("; ")}`);
  }
  const lp = listProfile(input.text);
  console.log(`    list: numbered=${lp.numbered} | bulleted=${lp.bulleted}`);
}
