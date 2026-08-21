// CROSS-VERTICAL ADVERSARIAL CORPUS — an overfitting test, not four new verticals.
//
// Same STRUCTURES as the senior-living diagnostic: tab-separated record rows,
// quoted multiline cells, labelled facts, unlabelled price/descriptor pairs in
// both orders, the wrapped/orphaned shape, repeated amounts, contacts,
// addresses, URLs, image URLs, blank fields, narrative paragraphs, and
// genuinely ambiguous fragments.
//
// Entirely different SUBJECT MATTER. If a rule only worked because it knew what
// a "studio" or "memory care" is, it fails here — and that is the finding.
//
// The parser is NOT modified between verticals.

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const row = (...cells: string[]) => cells.map((c) => (/[\n\t"]/.test(c) ? q(c) : c)).join("\t");

// ---- 1. RESTAURANT / CATERING ---------------------------------------------
const restaurant = row(
  "Harborview Kitchen", "Astoria",
  `Type: Catering, Private Dining
 Capacity: 120
 Venue Phone: (503) 555-0110
 Contact Name: Dana Whitfield
 Contact Title: Events Manager
 Cell Phone: (503) 555-0188
 Email Address: dana@harborviewkitchen.example.com
 Existing Website: https://harborviewkitchen.example.com`,
  `Harborview Kitchen 88 Marine Dr. Astoria, OR 97103
 (503) 555-0110
 https://harborviewkitchen.example.com
 Plated Dinner
 - $68/person Family Style
 - $54/person Buffet
 - $47/person
 Bar Package: Additional per-guest fee based on tier selected (consultation required)
 Cake Cutting Fee: $3/person
 Room Rental: $1,200
 Second Server Fee: $250
 Corkage: $25/bottle`,
  "Harborview Kitchen is a waterfront restaurant and catering company in Astoria serving Pacific Northwest menus for weddings and corporate events.",
  `Picture 1: https://images.example.com/harborview-dining.jpg
Picture 2: https://images.example.com/harborview-patio.jpg`,
);

// ---- 2. CONTRACTOR / HOME SERVICES ----------------------------------------
const contractor = row(
  "Ridgeline Roofing", "Bend",
  `Type: Roofing, Gutters
 Capacity: 6 crews
 Office Phone: (541) 555-0143
 Contact Name: Marcus Ortiz
 Contact Title: Estimator
 Email Address: marcus@ridgelineroofing.example.com
 Existing Website: https://ridgelineroofing.example.com`,
  `Ridgeline Roofing 412 Wall St. Bend, OR 97701
 (541) 555-0143
 Asphalt Shingle Tear-off $6.50-$8.25/sq ft
 Standing Seam Metal $14/sq ft
 Gutter Replacement $12/linear foot
 Permit Fee: Varies by jurisdiction; owner is billed at cost
 Emergency Callout: $450 minimum
 Warranty: 25 years materials, 10 years labour`,
  "Ridgeline Roofing is a licensed contractor serving central Oregon with residential re-roofs, gutter work and storm damage repair.",
  "Picture 1: https://images.example.com/ridgeline-crew.jpg",
);

// ---- 3. RENTAL / PROPERTY LISTING -----------------------------------------
// Blank Profile cell on purpose: a legitimately absent field.
const rental = row(
  "The Fillmore Lofts", "Tacoma",
  `Type: Apartments
 Capacity: 48
 Leasing Phone: (253) 555-0177
 Contact Name: Priya Raman
 Contact Title: Leasing Agent
 Email Address: priya@fillmorelofts.example.com
 Existing Website: https://fillmorelofts.example.com`,
  "",
  "The Fillmore Lofts is a converted 1920s warehouse in Tacoma offering open-plan apartments with original timber framing.",
  `Picture 1: https://images.example.com/fillmore-exterior.jpg
Picture 2: https://images.example.com/fillmore-unit.jpg`,
);

// ---- 4. EVENT VENDOR — the hard one ---------------------------------------
// Repeated identical amounts, prose glued onto a labelled line, a range, and a
// two-amounts-one-line case that must stay ambiguous.
const vendor = row(
  "Northlight Sound", "Eugene",
  `Type: AV, Lighting
 Capacity: 3 simultaneous events
 Studio Phone: (458) 555-0122
 Contact Name: Sam Okafor
 Contact Title: Owner
 Email Address: sam@northlightsound.example.com
 Existing Website: https://northlightsound.example.com`,
  `Northlight Sound 77 Blair Blvd. Eugene, OR 97402
 (458) 555-0122
 Basic PA Package
 - $850/day Full Stage Package
 - $2,400/day
 Lighting Rig $850/day
 Delivery Fee: $200 within 30 miles, $350 beyond Rates quoted here reflect standard weekday bookings and will change for holidays and multi-day festivals.
 Operator: Required for events over 200 guests
 Rehearsal Discount: $1,500 to $1,900 depending on load-in window
 Wireless Mic $75 each Monitor Wedge $95 each`,
  "Northlight Sound provides audio, lighting and staging for festivals, weddings and corporate events across the Willamette Valley.",
  `Picture 1: https://images.example.com/northlight-stage.jpg`,
);

export const CROSS_VERTICAL: { name: string; vertical: string; text: string }[] = [
  { name: "Harborview Kitchen", vertical: "restaurant/catering", text: restaurant },
  { name: "Ridgeline Roofing", vertical: "contractor/home services", text: contractor },
  { name: "The Fillmore Lofts", vertical: "rental/property", text: rental },
  { name: "Northlight Sound", vertical: "event vendor", text: vendor },
];

export const PASTE = CROSS_VERTICAL.map((r) => r.text).join("\n") + "\n";

/** What a correct parse should find, authored by hand from the text above. */
export const EXPECTED = {
  labelledFacts: [
    // restaurant
    "Type", "Capacity", "Venue Phone", "Contact Name", "Contact Title", "Cell Phone",
    "Email Address", "Existing Website", "Bar Package", "Cake Cutting Fee", "Room Rental",
    "Second Server Fee", "Corkage",
    // contractor
    "Type", "Capacity", "Office Phone", "Contact Name", "Contact Title", "Email Address",
    "Existing Website", "Permit Fee", "Emergency Callout", "Warranty",
    // rental
    "Type", "Capacity", "Leasing Phone", "Contact Name", "Contact Title", "Email Address",
    "Existing Website",
    // vendor
    "Type", "Capacity", "Studio Phone", "Contact Name", "Contact Title", "Email Address",
    "Existing Website", "Delivery Fee", "Operator", "Rehearsal Discount",
  ],
  /** Unlabelled price/descriptor pairs a horizontal parser ought to claim. */
  unlabelledPricing: [
    "Standing Seam Metal $14/sq ft",
    "Gutter Replacement $12/linear foot",
    "Asphalt Shingle Tear-off $6.50-$8.25/sq ft",
    "Lighting Rig $850/day",
  ],
  /** Must stay ambiguous: the wrapped shape and the two-amounts line. */
  mustBeAmbiguous: [
    "- $68/person Family Style",     // dangling "Plated Dinner" above
    "- $850/day Full Stage Package", // dangling "Basic PA Package" above
    "Wireless Mic $75 each Monitor Wedge $95 each",
  ],
};
