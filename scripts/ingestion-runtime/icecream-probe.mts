// What WOULD the contract do with these shapes? The run's own evidence was
// destroyed by packet-path finalize, so this probes the parser directly.
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { reconcile } from "../../src/lib/reconcile.ts";
const shapes = [
  ["labelled, bare domain", "Website: mitchellsicecream.com"],
  ["labelled, www domain", "Website: www.screaminmimisicecream.com"],
  ["labelled, scheme", "Website: https://www.bopnfrz.com"],
  ["bare domain alone", "mitchellsicecream.com"],
  ["www alone", "www.screaminmimisicecream.com"],
  ["scheme alone", "https://www.fentonscreamery.com"],
] as const;
for (const [name, line] of shapes) {
  const p = parseClaims(line);
  const c = p.claims[0];
  const r = reconcile(p, { details: [], links: [], contacts: [] });
  const res = r.resolutions[0];
  console.log(`  ${name.padEnd(24)} claim=${c ? c.kind : "NONE"}  ` +
    `${c ? `label=${c.label ?? "-"} ` : ""}rung=${res?.rung ?? "-"} want=${res?.want ?? "-"} outcome=${res?.outcome ?? "-"}` +
    `${!c ? `  fragments=${p.fragments.map((f) => f.reason).join(",")}` : ""}`);
}
