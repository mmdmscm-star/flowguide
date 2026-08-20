// A controlled corpus for diagnosing semantic-ingestion reliability.
//
// GROUND TRUTH IS GENERATED, NOT TYPED. Every record is built from a template,
// so the "structural clone" group is identical by construction rather than by
// careful proofreading — and each fact carries its expected destination, so
// scoring is mechanical instead of a judgement call made after seeing results.
//
// The expected destination of a fact is recorded together with WHETHER THE
// CURRENT PROMPT ACTUALLY STATES THAT RULE. That column is the point: a fact
// that lands inconsistently where no rule exists is a prompt/schema gap, while
// one that lands inconsistently where a rule DOES exist is model
// nondeterminism. The corpus is built to tell those apart.

export type Dest =
  | "title" | "address" | "description" | "notes"
  | "details" | "links" | "photos"
  | "contacts.name" | "contacts.role" | "contacts.phone" | "contacts.email" | "contacts.website";

export interface Fact {
  id: string;
  /** The exact substring that appears in the source. */
  text: string;
  /** Where it should end up. */
  expect: Dest;
  /** For details, the label we would consider correct. */
  label?: string;
  /** Is the rule stated in the prompt the Library import actually uses? */
  ruleStated: "yes" | "no" | "packet-prompts-only";
  /** Present in the source at all. `false` marks a deliberate absence. */
  present: boolean;
}

export interface Record_ {
  key: string;
  group: "A-clone" | "B-absence" | "C-ambiguity" | "D-mixed-type" | "E-awkward";
  title: string;
  text: string;
  facts: Fact[];
}

const f = (id: string, text: string, expect: Dest, ruleStated: Fact["ruleStated"],
           opts: { label?: string; present?: boolean } = {}): Fact =>
  ({ id, text, expect, ruleStated, label: opts.label, present: opts.present !== false });

// ---------------------------------------------------------------------------
// GROUP A — structural clones. Identical shape, different values.
// If these map differently, the source is not the reason.
// ---------------------------------------------------------------------------
const CLONES = [
  { n: "Brookdale Ridgeway",   city: "Santa Rosa",  cap: 140, studio: "4,720", oneBed: "5,465", fee: "6,000", person: "Dana Alvarez",  role: "Community Director",   ph: "707-555-0142", em: "dana@ridgeway.example.com",  host: "ridgeway" },
  { n: "Oakmont of Larkspur",  city: "Larkspur",    cap: 118, studio: "8,195", oneBed: "9,295", fee: "10,000", person: "Priya Raman",  role: "Sales Director",       ph: "415-555-0188", em: "priya@larkspur.example.com", host: "larkspur" },
  { n: "Cogir of Petaluma",    city: "Petaluma",    cap: 105, studio: "4,317", oneBed: "5,406", fee: "3,500",  person: "Marcus Webb",  role: "Executive Director",   ph: "707-555-0119", em: "marcus@petaluma.example.com",host: "petaluma" },
  { n: "Aegis of Corte Madera",city: "Corte Madera",cap: 150, studio: "5,000", oneBed: "9,000", fee: "8,000",  person: "Lena Ortiz",   role: "Admissions Director",  ph: "415-555-0155", em: "lena@cortemadera.example.com",host:"cortemadera" },
  { n: "Windsor Gardens",      city: "Windsor",     cap: 96,  studio: "4,830", oneBed: "5,610", fee: "4,500",  person: "Tom Becker",   role: "Community Director",   ph: "707-555-0173", em: "tom@windsorgardens.example.com",host:"windsorgardens" },
  { n: "The Berkshire Napa",   city: "Napa",        cap: 72,  studio: "6,100", oneBed: "7,250", fee: "9,000",  person: "Ana Ruiz",     role: "Sales Director",       ph: "707-555-0164", em: "ana@berkshirenapa.example.com",host:"berkshirenapa" },
  { n: "Marin Terrace",        city: "San Rafael",  cap: 49,  studio: "5,295", oneBed: "6,410", fee: "5,000",  person: "Ken Adachi",   role: "Executive Director",   ph: "415-555-0131", em: "ken@marinterrace.example.com",host:"marinterrace" },
  { n: "Sonoma Hills",         city: "Sonoma",      cap: 88,  studio: "4,995", oneBed: "5,880", fee: "7,500",  person: "Rosa Lim",     role: "Community Director",   ph: "707-555-0146", em: "rosa@sonomahills.example.com",host:"sonomahills" },
];

function cloneRecord(c: (typeof CLONES)[number], i: number): Record_ {
  const addr = `${100 + i * 37} Example Road, ${c.city} CA 9540${i % 10}`;
  const site = `https://www.${c.host}.example.com`;
  const photo = `https://images.example.com/${c.host}-exterior.jpg`;
  const text =
`${c.n}
${addr}
Type: Assisted Living, Memory Care
Capacity: ${c.cap}
Assisted Living Studio: $${c.studio}/month
Assisted Living One Bedroom: $${c.oneBed}/month
Community Fee: $${c.fee}
${c.person}, ${c.role}
${c.ph}
${c.em}
${site}
${photo}
A established community close to shops and a regional hospital, with a walled garden and a weekly outing programme.
Tours run on Tuesday and Thursday mornings.`;
  return {
    key: `A${i + 1}`, group: "A-clone", title: c.n, text,
    facts: [
      f("name", c.n, "title", "yes"),
      f("address", addr, "address", "packet-prompts-only"),
      f("type", "Assisted Living, Memory Care", "details", "packet-prompts-only", { label: "Type" }),
      f("capacity", String(c.cap), "details", "no", { label: "Capacity" }),
      f("price_studio", `$${c.studio}/month`, "details", "packet-prompts-only", { label: "Assisted Living Studio" }),
      f("price_onebed", `$${c.oneBed}/month`, "details", "packet-prompts-only", { label: "Assisted Living One Bedroom" }),
      f("fee", `$${c.fee}`, "details", "packet-prompts-only", { label: "Community Fee" }),
      f("person", c.person, "contacts.name", "yes"),
      f("role", c.role, "contacts.role", "yes"),
      f("phone", c.ph, "contacts.phone", "yes"),
      f("email", c.em, "contacts.email", "yes"),
      f("website", site, "links", "yes"),
      f("photo", photo, "photos", "yes"),
      f("prose", "walled garden", "description", "no"),
      f("tour", "Tours run on Tuesday and Thursday mornings.", "notes", "packet-prompts-only"),
    ],
  };
}

// ---------------------------------------------------------------------------
// GROUP B — legitimate absences. Same shape, each missing ONE thing.
// Absent-in-source AND absent-in-output is CORRECT. Present-in-output is
// FABRICATION. This is what stops us reading silence as failure.
// ---------------------------------------------------------------------------
const ABSENCES = [
  { key: "B1", name: "Pine Ridge Terrace", drop: "phone" },
  { key: "B2", name: "Valley Oaks Living",  drop: "website" },
  { key: "B3", name: "Hillcrest Manor",     drop: "price" },
  { key: "B4", name: "Riverbend Cottage",   drop: "address" },
  { key: "B5", name: "Cedar Court",         drop: "email" },
  { key: "B6", name: "Lakeview Commons",    drop: "prose" },
] as const;

function absenceRecord(b: (typeof ABSENCES)[number], i: number): Record_ {
  const host = b.name.toLowerCase().replace(/[^a-z]+/g, "");
  const addr = `${200 + i * 11} Orchard Lane, Sebastopol CA 95472`;
  const site = `https://www.${host}.example.com`;
  const lines: string[] = [b.name];
  if (b.drop !== "address") lines.push(addr);
  lines.push("Type: Assisted Living");
  lines.push(`Capacity: ${40 + i * 7}`);
  if (b.drop !== "price") lines.push(`Assisted Living Studio: $${4 + i},250/month`);
  lines.push(`Sam Patel, Community Director`);
  if (b.drop !== "phone") lines.push("707-555-02" + (10 + i));
  if (b.drop !== "email") lines.push(`sam@${host}.example.com`);
  if (b.drop !== "website") lines.push(site);
  if (b.drop !== "prose") lines.push("A small community on a quiet street with a shared kitchen garden.");

  const facts: Fact[] = [
    f("name", b.name, "title", "yes"),
    f("address", addr, "address", "packet-prompts-only", { present: b.drop !== "address" }),
    f("type", "Assisted Living", "details", "packet-prompts-only", { label: "Type" }),
    f("capacity", String(40 + i * 7), "details", "no", { label: "Capacity" }),
    f("price_studio", `$${4 + i},250/month`, "details", "packet-prompts-only",
      { label: "Assisted Living Studio", present: b.drop !== "price" }),
    f("person", "Sam Patel", "contacts.name", "yes"),
    f("phone", "707-555-02" + (10 + i), "contacts.phone", "yes", { present: b.drop !== "phone" }),
    f("email", `sam@${host}.example.com`, "contacts.email", "yes", { present: b.drop !== "email" }),
    f("website", site, "links", "yes", { present: b.drop !== "website" }),
    f("prose", "kitchen garden", "description", "no", { present: b.drop !== "prose" }),
  ];
  return { key: b.key, group: "B-absence", title: b.name, text: lines.join("\n"), facts };
}

// ---------------------------------------------------------------------------
// GROUP C — ambiguity probes. Facts that could defensibly land in two places.
// These measure whether the SAME ambiguity resolves the same way twice.
// ---------------------------------------------------------------------------
const AMBIGUITY: Record_[] = [
  {
    key: "C1", group: "C-ambiguity", title: "Meadowbrook Assisted Living",
    text:
`Meadowbrook Assisted Living
15 Meadow Way, Rohnert Park CA 94928
Type: Assisted Living
The community fee is six thousand dollars and there is a second-person fee of $1,200 a month.
Jo Ferris, Admissions
707-555-0301
Jo keeps a personal scheduling page at https://calendly.example.com/jo-ferris
https://www.meadowbrook.example.com`,
    facts: [
      f("name", "Meadowbrook Assisted Living", "title", "yes"),
      f("address", "15 Meadow Way, Rohnert Park CA 94928", "address", "packet-prompts-only"),
      // Stated as PROSE rather than a key/value pair. Same fact as A's "fee".
      f("fee_prose", "six thousand dollars", "details", "no", { label: "Community Fee" }),
      f("second_person_prose", "$1,200 a month", "details", "no", { label: "Second Person Fee" }),
      f("person", "Jo Ferris", "contacts.name", "yes"),
      f("phone", "707-555-0301", "contacts.phone", "yes"),
      // A person's OWN url — the prompt explicitly distinguishes this from the
      // community site, so this one has a stated rule.
      f("personal_site", "https://calendly.example.com/jo-ferris", "contacts.website", "yes"),
      f("website", "https://www.meadowbrook.example.com", "links", "yes"),
    ],
  },
  {
    key: "C2", group: "C-ambiguity", title: "Fairview Senior Residence",
    text:
`Fairview Senior Residence
88 Fairview Ave, Novato CA 94947
Type: Assisted Living, Memory Care
Studio pricing ranges from $5,100 to $6,400 per month depending on care level.
Two contacts: Bea Nolan (Director) 415-555-0410 bea@fairview.example.com and Chris Oyelaran (Nurse Manager) 415-555-0411 chris@fairview.example.com
https://www.fairview.example.com`,
    facts: [
      f("name", "Fairview Senior Residence", "title", "yes"),
      f("address", "88 Fairview Ave, Novato CA 94947", "address", "packet-prompts-only"),
      f("price_range", "$5,100 to $6,400 per month", "details", "no", { label: "Studio" }),
      f("person1", "Bea Nolan", "contacts.name", "yes"),
      f("phone1", "415-555-0410", "contacts.phone", "yes"),
      f("person2", "Chris Oyelaran", "contacts.name", "yes"),
      f("phone2", "415-555-0411", "contacts.phone", "yes"),
      f("website", "https://www.fairview.example.com", "links", "yes"),
    ],
  },
];

// ---------------------------------------------------------------------------
// GROUP D — a different KIND of record, interleaved rather than appended, so we
// can see whether a type switch disturbs its neighbours.
// ---------------------------------------------------------------------------
const MIXED: Record_[] = [
  {
    key: "D1", group: "D-mixed-type", title: "Sonoma Home Care Partners",
    text:
`Sonoma Home Care Partners
In-home caregiving agency serving Sonoma and Marin counties.
Hourly Rate: $42/hour
Minimum Shift: 4 hours
Ivy Chen, Care Coordinator
707-555-0500
ivy@sonomahomecare.example.com
https://www.sonomahomecare.example.com`,
    facts: [
      f("name", "Sonoma Home Care Partners", "title", "yes"),
      f("prose", "In-home caregiving agency", "description", "no"),
      f("rate", "$42/hour", "details", "no", { label: "Hourly Rate" }),
      f("minimum", "4 hours", "details", "no", { label: "Minimum Shift" }),
      f("person", "Ivy Chen", "contacts.name", "yes"),
      f("phone", "707-555-0500", "contacts.phone", "yes"),
      f("email", "ivy@sonomahomecare.example.com", "contacts.email", "yes"),
      f("website", "https://www.sonomahomecare.example.com", "links", "yes"),
      // No address at all: an agency serving a region. Absence is correct.
      f("address", "", "address", "packet-prompts-only", { present: false }),
    ],
  },
  {
    key: "D2", group: "D-mixed-type", title: "VA Aid and Attendance",
    text:
`VA Aid and Attendance
A federal benefit for veterans and surviving spouses who need help with daily activities.
Maximum Benefit: $2,300/month
Application typically takes 4 to 6 months.
https://www.va.example.gov/aid-and-attendance`,
    facts: [
      f("name", "VA Aid and Attendance", "title", "yes"),
      f("prose", "federal benefit for veterans", "description", "no"),
      f("max", "$2,300/month", "details", "no", { label: "Maximum Benefit" }),
      f("timeline", "4 to 6 months", "details", "no", { label: "Application Time" }),
      f("website", "https://www.va.example.gov/aid-and-attendance", "links", "yes"),
      f("phone", "", "contacts.phone", "yes", { present: false }),
      f("address", "", "address", "packet-prompts-only", { present: false }),
    ],
  },
  {
    key: "D3", group: "D-mixed-type", title: "Bayside Physical Therapy",
    text:
`Bayside Physical Therapy
420 Harbor Blvd, San Rafael CA 94901
Outpatient rehabilitation, including post-surgical and balance work.
Visit Cost: $180 per session
Accepts Medicare: Yes
Dr. Ellen Marsh, Clinic Lead
415-555-0620
https://www.baysidept.example.com`,
    facts: [
      f("name", "Bayside Physical Therapy", "title", "yes"),
      f("address", "420 Harbor Blvd, San Rafael CA 94901", "address", "packet-prompts-only"),
      f("prose", "Outpatient rehabilitation", "description", "no"),
      f("cost", "$180 per session", "details", "no", { label: "Visit Cost" }),
      f("medicare", "Yes", "details", "no", { label: "Accepts Medicare" }),
      f("person", "Dr. Ellen Marsh", "contacts.name", "yes"),
      f("phone", "415-555-0620", "contacts.phone", "yes"),
      f("website", "https://www.baysidept.example.com", "links", "yes"),
    ],
  },
];

// ---------------------------------------------------------------------------
// GROUP E — awkward but entirely realistic.
// ---------------------------------------------------------------------------
const AWKWARD: Record_[] = [
  {
    key: "E1", group: "E-awkward", title: "The Vincent",
    text:
`The Vincent
1 Vincent Plaza, Suite 200, Petaluma CA 94952
Type: Assisted Living, Memory Care
Classic Studio: $5,595/month
Larger Studio: $6,195/month
See https://www.thevincent.example.com for floor plans, or the same site at https://www.thevincent.example.com
Ruth Kaplan, Director
707-555-0700`,
    facts: [
      f("name", "The Vincent", "title", "yes"),
      f("address", "1 Vincent Plaza, Suite 200, Petaluma CA 94952", "address", "packet-prompts-only"),
      f("type", "Assisted Living, Memory Care", "details", "packet-prompts-only", { label: "Type" }),
      f("price_classic", "$5,595/month", "details", "packet-prompts-only", { label: "Classic Studio" }),
      f("price_larger", "$6,195/month", "details", "packet-prompts-only", { label: "Larger Studio" }),
      // The SAME url twice in the source. Correct output has it ONCE.
      f("website", "https://www.thevincent.example.com", "links", "yes"),
      f("person", "Ruth Kaplan", "contacts.name", "yes"),
      f("phone", "707-555-0700", "contacts.phone", "yes"),
    ],
  },
];

// ---------------------------------------------------------------------------
// Assembly. Mixed-type and awkward records are INTERLEAVED, not appended.
// ---------------------------------------------------------------------------
export const RECORDS: Record_[] = (() => {
  const a = CLONES.map(cloneRecord);
  const b = ABSENCES.map(absenceRecord);
  const out: Record_[] = [];
  out.push(a[0], a[1], MIXED[0], a[2], b[0], a[3], AMBIGUITY[0], b[1], a[4],
           MIXED[1], b[2], a[5], AWKWARD[0], b[3], a[6], AMBIGUITY[1], MIXED[2], b[4], a[7], b[5]);
  return out;
})();

export const SOURCE = RECORDS.map((r) => r.text).join("\n\n");

export const TOTALS = {
  records: RECORDS.length,
  facts: RECORDS.reduce((n, r) => n + r.facts.length, 0),
  presentFacts: RECORDS.reduce((n, r) => n + r.facts.filter((x) => x.present).length, 0),
  deliberateAbsences: RECORDS.reduce((n, r) => n + r.facts.filter((x) => !x.present).length, 0),
  chars: SOURCE.length,
};
