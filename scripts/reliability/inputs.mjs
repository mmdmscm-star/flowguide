// FIFTEEN ORDINARY INPUTS.
//
// Not adversarial and not corpus-tuned: these are the shapes a professional
// actually has lying around — a tab-separated paste out of a spreadsheet, a
// bulleted list, notes to self with half-sentences, an email they sent
// themselves, a numbered shortlist with prices written five different ways.
//
// `expect` is what a careful human would say the source contains. It is a
// REFERENCE, not a contract: the point is to see how far the result drifts from
// an obvious reading, not to assert an exact number.
export const INPUTS = [
  {
    id: "01-tabbed-spreadsheet",
    note: "straight paste out of a spreadsheet column set",
    // What a .tsv file would declare. Sent only by the hinted arm.
    hint: "\t",
    expect: { items: 4 },
    text: `Name\tAddress\tDay rate\tCapacity\tContact
The Foundry\t41 Mill St\t$4,200\t120\tDana Reyes 206-555-0118
Harborlight Loft\t9 Pier Rd\t$5,600\t90\tSam Okonjo 206-555-0164
Cedar & Vine\t388 Vine St\t$3,800\t150\tAlice Fenner 206-555-0177
Union Hall\t12 Canal St\t$2,900\t220\t`,
  },
  {
    id: "02-bulleted-notes",
    note: "bullets with inconsistent fields",
    expect: { items: 3 },
    text: `Places I looked at for the Ramirez move:

- Brightwater Apartments — 2br from $2,450/mo, 15 min to downtown, has parking. Leasing office 415-555-0132. brightwater.example.com
- Kestrel Court — cheaper, $2,100, but no in-unit laundry and the 2brs are tiny. Ask about the waitlist.
- Alder Row — $2,800, newest of the three, gym + roof deck. Tour available Thursday.`,
  },
  {
    id: "03-numbered-prose",
    note: "numbered list, prose descriptions, prices inline",
    expect: { items: 3 },
    text: `Three contractors for the kitchen job.

1. Marsh & Sons. Been around 30 years, did the Delgado place. Quoted 42k, 6 weeks. Sam Marsh, 503-555-0144. Slow to return calls but the work is excellent.

2. Nine Yards Build. Quoted 38k but that excludes countertops. 8 weeks out. They sent the most detailed scope. nineyards.example.com

3. Pell Renovation. 51k, could start Monday. Feels expensive for what it is, including only because they're available.`,
  },
  {
    id: "04-email-to-self",
    note: "an email a professional sent themselves",
    expect: { items: 4 },
    text: `From: me
Subject: gym options for the Chen account

ok so far

Ironline Fitness - 24hr access, $89/mo corporate rate, closest to the office (4 blocks). Manager is Tia, 312-555-0119.
The Yard - $75/mo, no 24hr, but the classes are better and they'll do a 20-person block booking.
Summit Club - $140/mo, pool + squash, probably overkill
Basecamp Athletic - $95/mo, brand new, opening in March so no reviews yet

need to check parking for all of these`,
  },
  {
    id: "05-messy-shorthand",
    note: "terse shorthand, missing punctuation",
    expect: { items: 4 },
    text: `caterers
- Olive & Thyme 32/head min 40 ppl veg options good
- Fairground Kitchen 28/head min 60 does bbq
- Twelve Tables 45/head fancy, min 25
- Copper Pot 30/head no min but limited menu`,
  },
  {
    id: "06-single-long-prose",
    note: "one paragraph, several entities buried in it",
    expect: { items: 3 },
    text: `I went and saw three spaces on Tuesday. The one on Marlow Street is 2,400 square feet, asking $4,100 a month, and it has the loading dock we need though the ceiling is lower than I expected. Then there's the Ivy Building unit which is smaller at 1,800 square feet and $3,600, no dock but a freight elevator, and the landlord seemed flexible on the term. Last was the place on Rowan Avenue, 3,000 square feet at $5,200, which is more than we wanted to spend but it's the only one that could take the second line without modifications.`,
  },
  {
    id: "07-mixed-headings",
    note: "headings plus items, the shape a shortlist doc usually has",
    expect: { items: 4, sections: 2 },
    text: `SHORTLIST

Riverbend Studio
$1,800/day. 3,000 sq ft, blackout capable, in-house grip.
riverbend.example.com | Booking: Nia Patel 646-555-0188

Fifth Street Stage
$2,400/day. Bigger, has a cyc wall. Parking is a problem.

ALSO LOOKED AT

Old Mill Works
$1,200/day but no climate control, ruled out for the August shoot.

Harbor Sound
Audio only, keeping for the voiceover day.`,
  },
  {
    id: "08-urls-heavy",
    note: "mostly links, minimal text — a common 'here's my research' paste",
    expect: { items: 4 },
    text: `https://northgate.example.com — Northgate Family Dentistry, takes our plan, 2 wks out
https://cedarsmiles.example.com — Cedar Smiles, closer but doesn't take the plan
https://oakhilldental.example.com — Oak Hill, takes plan, 6 wks out, best reviews
https://brightpath.example.com — Brightpath, no reviews, new practice`,
  },
  {
    id: "09-two-columns-pasted",
    note: "a table that lost its structure on paste",
    expect: { items: 4 },
    text: `Vendor Quote Lead time Notes
Alto Print 1,240 5 days includes setup
Peachtree Press 980 9 days setup extra 150
Rally Signs 1,410 3 days rush ok
Bower & Co 1,100 7 days no rush option`,
  },
  {
    id: "10-with-dates-and-times",
    note: "schedule-shaped content rather than a comparison list",
    expect: { items: 5 },
    text: `Week 1 plan for the Okafor onboarding

Mon 9:00 — Kickoff with the exec team, 90 min, conference room B
Tue 13:00 — Systems walkthrough with IT, 2 hrs, remote
Wed 10:00 — Shadow the intake desk, half day
Thu 15:00 — Compliance training module 1, 45 min, self-paced
Fri 11:00 — Week one review with Dana, 30 min`,
  },
  {
    id: "11-very-short",
    note: "the smallest thing someone would realistically paste",
    expect: { items: 2 },
    text: `Two options:
Willow Creek Camp - $450/wk, ages 7-12, bus from downtown
Pinehurst Day Camp - $380/wk, ages 5-10, no bus`,
  },
  {
    id: "12-inconsistent-money",
    note: "prices written five ways, a real source of extraction drift",
    expect: { items: 5 },
    text: `Quotes so far:
Apex Moving — 3,400 dollars
Brightline Relocation — $2,950
Sturdy Van Lines — 4.1k
Copperfield Movers — approx $3,600-$3,900 depending on date
Northway — twenty eight hundred flat`,
  },
  {
    id: "13-duplicate-mentions",
    note: "the same entity referenced twice, which should not become two items",
    expect: { items: 3 },
    text: `Looked at Glenview Academy first — $18,400 tuition, strong music program, 22 min drive.
Then Hartwell School, $21,000, smaller classes.
Also Beacon Prep at $16,900, furthest away at 40 min.
Circling back on Glenview: they confirmed the bus route does cover our address, so the 22 min is not a problem.`,
  },
  {
    id: "14-headers-no-items",
    note: "notes with structure but few real entities — should not invent",
    expect: { items: 2 },
    text: `Things to decide before Friday

Venue — still between the two downtown options
Catering — waiting on the Olive & Thyme quote

Budget is 40k all in. Need to confirm headcount with Priya before booking anything.`,
  },
  {
    id: "15-longer-mixed",
    note: "a fuller research dump, the size a real shortlist reaches",
    expect: { items: 6 },
    text: `Coworking options for the Denver team (8 desks, need 12mo term)

1) Fulcrum Union — 1401 Larimer
   $4,200/mo for 8 dedicated desks. Includes 20 hrs meeting room, mail, 24/7.
   Pros: closest to transit, best coffee, they'll hold desks together.
   Cons: no phone booths on our floor.
   Contact: Rhea Simmons, 720-555-0143, rhea@fulcrum.example.com

2) The Assembly — 2200 Blake
   $3,850/mo. Includes 10 hrs meeting room. Parking $95/space extra.
   Nice light. Slightly out of the way. 12mo term required anyway.
   Contact: front desk 720-555-0166

3) Ridgeline Works — 899 Broadway
   $5,100/mo, all-in including parking and unlimited meeting rooms.
   Most expensive but the only one with a private suite option.

4) Cobblestone Collective — 45 Wazee
   $3,200/mo but desks are hot-desk only, no dedicated. Probably a no.

5) North Union — 1750 Wewatta
   $4,400/mo. New building. Couldn't get a straight answer on the meeting room policy.

6) Halyard Offices — 1200 17th
   $4,050/mo. Fine. Nothing stood out either way. Backup.`,
  },
  {
    id: "16-comma-csv",
    note: "a real comma-separated CSV export — the headline new input path",
    hint: ",",
    expect: { items: 4 },
    text: `Name,Day rate,Capacity,Catering,Contact,Phone
The Foundry,"$4,200",120,"In-house, from $58/head",Dana Reyes,206-555-0118
Harborlight Loft,"$5,600",90,"External, approved list",Sam Okonjo,206-555-0164
Cedar & Vine,"$3,800",150,"In-house, $2,400 minimum",Alice Fenner,206-555-0177
Union Hall,"$2,900",220,"External, no restrictions",,`,
  },
];
