// Corpus v2 — built to reproduce the REAL import conditions.
//
// v1 scored 96.9% and did not reproduce the production failure. Measuring why
// gave the design constraint: real records average ~1,900 characters and real
// chunks held ~1.3 records, against v1's ~376 characters and ~5 records. v1 gave
// every fact a tidy one-line `Label: value` form — the easy case — and the two
// facts it did lose were both values written as prose.
//
// So v2 keeps the clone discipline (identical structure, values only differ) and
// changes exactly what the measurement said to change: length, field density,
// and the SHAPE of values. Every fact now carries a valueShape, because that is
// the dimension v1 implicated and could not quantify.

export type Dest =
  | "title" | "address" | "description" | "notes"
  | "details" | "links" | "photos"
  | "contacts.name" | "contacts.role" | "contacts.phone" | "contacts.email" | "contacts.website";

/** How the value is written in the source — the dimension v1 implicated. */
export type Shape = "simple" | "qualified" | "ranged" | "prose";

export interface Fact {
  id: string; text: string; expect: Dest; label?: string;
  ruleStated: "yes" | "packet-prompts-only" | "no";
  shape: Shape;
  present: boolean;
}
export interface Record_ {
  key: string; group: "A-clone" | "B-absence" | "D-mixed-type";
  title: string; text: string; facts: Fact[];
}

const f = (id: string, text: string, expect: Dest, ruleStated: Fact["ruleStated"],
           shape: Shape, opts: { label?: string; present?: boolean } = {}): Fact =>
  ({ id, text, expect, ruleStated, shape, label: opts.label, present: opts.present !== false });

// ---------------------------------------------------------------------------
// The clone template. Eight records share this structure exactly; only the
// interpolated values differ, so any divergence in destination is provably not
// caused by the source.
// ---------------------------------------------------------------------------
interface Seed {
  name: string; city: string; zip: string; cap: number;
  p: [string, string, string, string, string, string]; // six room prices
  respiteDay: string; secondPerson: string; petFee: string;
  rangeLo: string; rangeHi: string; feeQualifier: string;
  c1: [string, string, string, string]; c2: [string, string, string, string];
  host: string; toured: string;
}

const SEEDS: Seed[] = [
  { name: "Brookdale Ridgeway", city: "Santa Rosa", zip: "95401", cap: 140,
    p: ["4,720","5,465","6,420","9,390","10,210","325"], respiteDay: "325", secondPerson: "2,500", petFee: "995",
    rangeLo: "600", rangeHi: "2,400", feeQualifier: "Equal to one month's rent",
    c1: ["Dana Alvarez","Community Director","707-555-0142","dana"],
    c2: ["Priya Raman","Move-in Coordinator","707-555-0143","priya"], host: "ridgeway", toured: "4 March" },
  { name: "Oakmont of Larkspur", city: "Larkspur", zip: "94939", cap: 118,
    p: ["8,195","9,295","11,495","7,850","9,100","410"], respiteDay: "410", secondPerson: "1,600", petFee: "1,000",
    rangeLo: "800", rangeHi: "3,100", feeQualifier: "$10,000 to $15,000 depending on apartment",
    c1: ["Marcus Webb","Executive Director","415-555-0188","marcus"],
    c2: ["Lena Ortiz","Admissions Director","415-555-0189","lena"], host: "larkspur", toured: "11 March" },
  { name: "Cogir of Petaluma", city: "Petaluma", zip: "94952", cap: 105,
    p: ["4,317","5,406","7,812","5,931","6,940","280"], respiteDay: "280", secondPerson: "1,500", petFee: "500",
    rangeLo: "450", rangeHi: "1,900", feeQualifier: "Waived for move-ins before the end of the quarter",
    c1: ["Tom Becker","Sales Director","707-555-0119","tom"],
    c2: ["Ana Ruiz","Care Manager","707-555-0120","ana"], host: "petaluma", toured: "18 March" },
  { name: "Aegis of Corte Madera", city: "Corte Madera", zip: "94925", cap: 150,
    p: ["5,000","9,000","11,250","7,300","12,000","360"], respiteDay: "360", secondPerson: "1,200", petFee: "750",
    rangeLo: "700", rangeHi: "2,800", feeQualifier: "Equal to one month's rent, non-refundable",
    c1: ["Ken Adachi","Community Director","415-555-0155","ken"],
    c2: ["Rosa Lim","Wellness Director","415-555-0156","rosa"], host: "cortemadera", toured: "25 March" },
  { name: "Windsor Gardens", city: "Windsor", zip: "95492", cap: 96,
    p: ["4,830","5,610","6,900","6,100","7,400","300"], respiteDay: "300", secondPerson: "1,400", petFee: "600",
    rangeLo: "500", rangeHi: "2,100", feeQualifier: "Starting at $4,500 and rising with apartment size",
    c1: ["Ivy Chen","Executive Director","707-555-0173","ivy"],
    c2: ["Sam Patel","Admissions","707-555-0174","sam"], host: "windsorgardens", toured: "1 April" },
  { name: "The Berkshire Napa", city: "Napa", zip: "94558", cap: 72,
    p: ["6,100","7,250","8,900","7,600","8,850","390"], respiteDay: "390", secondPerson: "1,800", petFee: "1,200",
    rangeLo: "650", rangeHi: "2,600", feeQualifier: "Two months' rent, half refundable within ninety days",
    c1: ["Bea Nolan","Sales Director","707-555-0164","bea"],
    c2: ["Chris Oyelaran","Nurse Manager","707-555-0165","chris"], host: "berkshirenapa", toured: "8 April" },
  { name: "Marin Terrace", city: "San Rafael", zip: "94901", cap: 49,
    p: ["5,295","6,410","7,980","6,700","7,950","340"], respiteDay: "340", secondPerson: "1,100", petFee: "450",
    rangeLo: "550", rangeHi: "2,200", feeQualifier: "One month's rent, billed with the first invoice",
    c1: ["Jo Ferris","Community Director","415-555-0131","jo"],
    c2: ["Ellen Marsh","Care Coordinator","415-555-0132","ellen"], host: "marinterrace", toured: "15 April" },
  { name: "Sonoma Hills", city: "Sonoma", zip: "95476", cap: 88,
    p: ["4,995","5,880","7,100","6,300","7,300","310"], respiteDay: "310", secondPerson: "1,300", petFee: "800",
    rangeLo: "480", rangeHi: "2,000", feeQualifier: "Equal to one month's rent plus a $500 assessment",
    c1: ["Ruth Kaplan","Executive Director","707-555-0146","ruth"],
    c2: ["Noor Haddad","Memory Care Lead","707-555-0147","noor"], host: "sonomahills", toured: "22 April" },
];

const ROOMS = ["Assisted Living Studio","Assisted Living One Bedroom","Assisted Living Two Bedroom",
               "Memory Care Shared Suite","Memory Care Private Studio"] as const;

function cloneText(s: Seed, i: number, drop: string[] = []): string {
  const has = (k: string) => !drop.includes(k);
  // REAL IMPORTS ARE NOT UNIFORM. The observed average was ~1,900 characters per
  // record, which is an average over a mix — some entries carry a full pricing
  // table and two paragraphs, others are half that. Uniform records would give
  // uniform chunk occupancy and hide exactly the variation being studied.
  const terse = i % 3 === 2;
  const L: string[] = [];
  L.push(s.name);
  if (has("address")) L.push(`${120 + i * 46} Ridgeline Road, ${s.city} CA ${s.zip}`);
  L.push(`Type: Assisted Living, Memory Care, Respite`);
  L.push(`Capacity: ${s.cap} residents`);
  // (no blank line: a blank line inside a record is indistinguishable from the
  //  blank line BETWEEN records, which is what made the segmenter cut mid-record)
  L.push("Pricing");
  ROOMS.forEach((r, k) => L.push(`${r}: $${s.p[k]}/month`));
  L.push(`Respite Care: $${s.respiteDay}/day, two week minimum stay`);
  L.push(`Community Fee: ${s.feeQualifier}`);
  L.push(`Second Person Fee: $${s.secondPerson}/month`);
  L.push(`Care Costs: Additional monthly fee based on level of care, assessed on move-in and reviewed every six months.`);
  if (has("petfee")) L.push(`Pet Fee: $${s.petFee} one-time, subject to a weight limit and a temperament check.`);
  L.push(`Level of care pricing ranges from $${s.rangeLo} to $${s.rangeHi} per month depending on the assessment.`);
  L.push(`The community sits on a landscaped campus a short drive from the regional hospital, with a walled garden, a bistro that serves all day, and a small cinema room.${terse ? "" : " Apartments are unfurnished and residents are encouraged to bring their own furniture, which most families arrange in the week before a move."}`);
  if (!terse) L.push(`Memory care occupies a separate secured wing with its own courtyard and a dedicated activities programme. Staffing there runs at a higher ratio than the assisted living floors, and the team includes a nurse on site overnight.`);
  if (has("note")) L.push(`Notes from the tour on ${s.toured}: the dining room was busy and the residents looked settled. The director was candid about the waitlist for memory care, which she put at roughly two months. Worth revisiting once the family has decided on a budget. Do not share the waitlist figure with the family yet.`);
  L.push(`${s.c1[0]}, ${s.c1[1]}`);
  if (has("phone1")) L.push(s.c1[2]);
  L.push(`${s.c1[3]}@${s.host}.example.com`);
  L.push(`${s.c2[0]}, ${s.c2[1]}`);
  L.push(s.c2[2]);
  L.push(`${s.c2[3]}@${s.host}.example.com`);
  if (has("website")) L.push(`Website: https://www.${s.host}.example.com`);
  L.push(`Brochure: https://www.${s.host}.example.com/floorplans.pdf`);
  L.push(`Map: https://www.google.com/maps/place/${s.host}`);
  L.push(`https://images.example.com/${s.host}-exterior.jpg`);
  L.push(`https://images.example.com/${s.host}-dining.jpg`);
  if (has("photo3")) L.push(`https://images.example.com/${s.host}-garden.jpg`);
  return L.join("\n");
}

function cloneFacts(s: Seed, i: number, drop: string[] = []): Fact[] {
  const has = (k: string) => !drop.includes(k);
  const F: Fact[] = [
    f("name", s.name, "title", "yes", "simple"),
    f("address", `${120 + i * 46} Ridgeline Road, ${s.city} CA ${s.zip}`, "address", "packet-prompts-only", "simple", { present: has("address") }),
    f("type", "Assisted Living, Memory Care, Respite", "details", "packet-prompts-only", "simple", { label: "Type" }),
    f("capacity", String(s.cap), "details", "no", "simple", { label: "Capacity" }),
  ];
  ROOMS.forEach((r, k) => F.push(f(`price_${k}`, `$${s.p[k]}/month`, "details", "packet-prompts-only", "simple", { label: r })));
  F.push(f("respite", `$${s.respiteDay}/day`, "details", "packet-prompts-only", "qualified", { label: "Respite Care" }));
  F.push(f("fee_qualified", s.feeQualifier, "details", "packet-prompts-only", "qualified", { label: "Community Fee" }));
  F.push(f("second_person", `$${s.secondPerson}/month`, "details", "packet-prompts-only", "simple", { label: "Second Person Fee" }));
  F.push(f("care_costs", "Additional monthly fee based on level of care", "details", "no", "prose", { label: "Care Costs" }));
  F.push(f("pet_fee", `$${s.petFee}`, "details", "no", "qualified", { label: "Pet Fee", present: has("petfee") }));
  F.push(f("range", `$${s.rangeLo} to $${s.rangeHi}`, "details", "no", "ranged", { label: "Level of Care" }));
  F.push(f("prose_campus", "walled garden", "description", "no", "prose"));
  F.push(f("prose_memory", "secured wing", "description", "no", "prose", { present: i % 3 !== 2 }));
  F.push(f("tour_note", "waitlist for memory care", "notes", "packet-prompts-only", "prose", { present: has("note") }));
  F.push(f("c1_name", s.c1[0], "contacts.name", "yes", "simple"));
  F.push(f("c1_role", s.c1[1], "contacts.role", "yes", "simple"));
  F.push(f("c1_phone", s.c1[2], "contacts.phone", "yes", "simple", { present: has("phone1") }));
  F.push(f("c1_email", `${s.c1[3]}@${s.host}.example.com`, "contacts.email", "yes", "simple"));
  F.push(f("c2_name", s.c2[0], "contacts.name", "yes", "simple"));
  F.push(f("c2_role", s.c2[1], "contacts.role", "yes", "simple"));
  F.push(f("c2_phone", s.c2[2], "contacts.phone", "yes", "simple"));
  // ADDED after the detector found these and the ground truth did not. The
  // source always contained them; the corpus simply failed to declare them, so
  // the earlier v2 baseline was computed over an incomplete fact set.
  F.push(f("c2_email", `${s.c2[3]}@${s.host}.example.com`, "contacts.email", "yes", "simple"));
  F.push(f("website", `https://www.${s.host}.example.com`, "links", "yes", "simple", { present: has("website") }));
  F.push(f("brochure", `https://www.${s.host}.example.com/floorplans.pdf`, "links", "yes", "simple"));
  F.push(f("map", `https://www.google.com/maps/place/${s.host}`, "links", "yes", "simple"));
  F.push(f("photo1", `https://images.example.com/${s.host}-exterior.jpg`, "photos", "yes", "simple"));
  F.push(f("photo2", `https://images.example.com/${s.host}-dining.jpg`, "photos", "yes", "simple"));
  F.push(f("photo3", `https://images.example.com/${s.host}-garden.jpg`, "photos", "yes", "simple", { present: has("photo3") }));
  return F;
}

const CLONES: Record_[] = SEEDS.map((s, i) => ({
  key: `A${i + 1}`, group: "A-clone", title: s.name,
  text: cloneText(s, i), facts: cloneFacts(s, i),
}));

// Same messy structure, each missing one thing — so absence stays
// distinguishable from failure at realistic length.
const ABSENCE_DROPS = [["phone1"], ["website"], ["note", "photo3"]];
const ABSENCES: Record_[] = ABSENCE_DROPS.map((drop, i) => {
  const s = { ...SEEDS[i], name: ["Pine Ridge Terrace","Valley Oaks Living","Hillcrest Manor"][i],
              host: ["pineridge","valleyoaks","hillcrest"][i] };
  return { key: `B${i + 1}`, group: "B-absence" as const, title: s.name,
           text: cloneText(s, 8 + i, drop), facts: cloneFacts(s, 8 + i, drop) };
});

// Secondary, per the v1 finding that type bleed was not observable.
const MIXED: Record_[] = [
  {
    key: "D1", group: "D-mixed-type", title: "Sonoma Home Care Partners",
    text:
`Sonoma Home Care Partners
In-home caregiving agency serving Sonoma and Marin counties, with caregivers available for hourly visits, overnight cover and live-in placements. The agency runs its own training programme and does not subcontract.

Hourly Rate: $42/hour
Overnight Rate: $380/night, awake cover
Live-in Rate: ranges from $520 to $610 per day depending on care level
Minimum Shift: 4 hours
Assessment Fee: waived for clients referred by a placement advisor

Notes: reliable for short-notice cover. The scheduler is slow to answer email but quick on the phone. Do not promise same-day starts.

Ivy Chen, Care Coordinator
707-555-0500
ivy@sonomahomecare.example.com

Website: https://www.sonomahomecare.example.com
https://images.example.com/sonomahomecare-team.jpg`,
    facts: [
      f("name","Sonoma Home Care Partners","title","yes","simple"),
      f("prose","In-home caregiving agency","description","no","prose"),
      f("hourly","$42/hour","details","no","simple",{label:"Hourly Rate"}),
      f("overnight","$380/night","details","no","qualified",{label:"Overnight Rate"}),
      f("livein","$520 to $610","details","no","ranged",{label:"Live-in Rate"}),
      f("minimum","4 hours","details","no","simple",{label:"Minimum Shift"}),
      f("assessment","waived for clients referred","details","no","prose",{label:"Assessment Fee"}),
      f("note","slow to answer email","notes","packet-prompts-only","prose"),
      f("c1_name","Ivy Chen","contacts.name","yes","simple"),
      f("c1_phone","707-555-0500","contacts.phone","yes","simple"),
      f("c1_email","ivy@sonomahomecare.example.com","contacts.email","yes","simple"),
      f("website","https://www.sonomahomecare.example.com","links","yes","simple"),
      f("photo","https://images.example.com/sonomahomecare-team.jpg","photos","yes","simple"),
      f("address","","address","packet-prompts-only","simple",{present:false}),
    ],
  },
  {
    key: "D2", group: "D-mixed-type", title: "VA Aid and Attendance",
    text:
`VA Aid and Attendance
A federal benefit for wartime veterans and surviving spouses who need help with daily activities. It is paid monthly on top of a VA pension and can be used toward assisted living or in-home care.

Maximum Benefit: $2,300/month for a married veteran
Surviving Spouse Benefit: $1,478/month
Asset Limit: approximately $155,000 including most countable assets but excluding a primary residence
Processing Time: ranges from 4 to 9 months depending on the regional office

Notes: worth starting the paperwork before a placement decision, because backdating is limited. The county veterans service office will file at no charge.

https://www.va.example.gov/aid-and-attendance
https://www.va.example.gov/forms/21-2680.pdf`,
    facts: [
      f("name","VA Aid and Attendance","title","yes","simple"),
      f("prose","federal benefit for wartime veterans","description","no","prose"),
      f("max","$2,300/month","details","no","qualified",{label:"Maximum Benefit"}),
      f("spouse","$1,478/month","details","no","simple",{label:"Surviving Spouse Benefit"}),
      f("assets","$155,000","details","no","qualified",{label:"Asset Limit"}),
      f("processing","4 to 9 months","details","no","ranged",{label:"Processing Time"}),
      f("note","backdating is limited","notes","packet-prompts-only","prose"),
      f("website","https://www.va.example.gov/aid-and-attendance","links","yes","simple"),
      f("form","https://www.va.example.gov/forms/21-2680.pdf","links","yes","simple"),
      f("phone","","contacts.phone","yes","simple",{present:false}),
      f("address","","address","packet-prompts-only","simple",{present:false}),
    ],
  },
];

export const RECORDS: Record_[] = [
  CLONES[0], CLONES[1], MIXED[0], CLONES[2], ABSENCES[0], CLONES[3],
  CLONES[4], ABSENCES[1], MIXED[1], CLONES[5], ABSENCES[2], CLONES[6], CLONES[7],
];
export const SOURCE = RECORDS.map((r) => r.text).join("\n\n");
export const TOTALS = {
  records: RECORDS.length,
  facts: RECORDS.reduce((n, r) => n + r.facts.length, 0),
  presentFacts: RECORDS.reduce((n, r) => n + r.facts.filter((x) => x.present).length, 0),
  deliberateAbsences: RECORDS.reduce((n, r) => n + r.facts.filter((x) => !x.present).length, 0),
  chars: SOURCE.length,
  meanRecordChars: Math.round(RECORDS.reduce((n, r) => n + r.text.length, 0) / RECORDS.length),
};
