// Deterministic synthetic senior-placement source generator — Phase-1 diagnosis
// fixture for the resilient-AI-ingestion investigation. FULLY SYNTHETIC: fake
// community names, addresses, phones. No secrets, no network, no private client
// data. Used to reproduce the Organize-with-AI 60s timeout and (later) to drive
// acceptance tests for natural-boundary chunking.
//
// makeSource(nItems) returns freeform text a professional might paste: blank-line
// separated community blocks under "Recommended Communities" / "Also Worth
// Considering" headings — i.e. natural chunk boundaries. Each block keeps its
// contact + phone together on adjacent lines so a splitter must not break it.

const NAMES = ["Golden Meadows","Cedar Ridge","Harbor View","Willow Creek","Sunset Terrace","Maplewood","Bayside Gardens","Oak Hollow","Riverbend","Lakeshore","Magnolia Court","Pinecrest","Evergreen Villa","Stonebridge","Meadowlark","Fairhaven","Brookside","Silver Pines","Hillcrest","Rosewood","Amberfield","Larkspur","Juniper Grove","Wildflower","Crescent Bay","Northgate","Sequoia","Vista Del Mar","Cypress Point","Heritage Hills"];
const CITIES = ["Santa Rosa","Petaluma","Napa","Windsor","Rohnert Park","Healdsburg","Sonoma","Sebastopol"];
const CARE = ["Assisted Living","Assisted Living + Memory Care","Memory Care","Independent Living","Continuing Care"];

export function community(i) {
  const n = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : "");
  const city = CITIES[i % CITIES.length];
  const lo = 3800 + ((i * 137) % 2600), hi = lo + 900 + ((i * 53) % 1500);
  const care = CARE[i % CARE.length];
  const dist = 5 + ((i * 7) % 25);
  const num = 100 + ((i * 89) % 8900);
  const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hasContact = i % 3 === 0;
  const desc = `A ${["warm boutique","larger resort-style","home-like","well-established","newly renovated"][i % 5]} community in ${city}. ` +
    `Known for its ${["garden courtyard","activities program","dining","memory care wing","staff-to-resident ratio"][i % 5]}. ` +
    `I toured it ${["last month","recently","in the spring"][i % 3]} and thought it could fit the family's needs.`;
  let block = `${n}\n${num} ${["Sonoma Ave","Vine St","Oak Blvd","Ridge Rd","Bay Dr","Creek Ln"][i % 6]}, ${city}, CA 95${(400 + i) % 1000}\n` +
    `${desc}\n` +
    `Monthly cost around $${lo.toLocaleString()}-$${hi.toLocaleString()}. Care level: ${care}. ` +
    `Room types: ${["Studio, One Bedroom","Private Suite","Shared and Private"][i % 3]}. ` +
    `Availability: ${["2 openings now","waitlist ~3 weeks","available now","1 room now"][i % 4]}. About ${dist} minutes away.\n` +
    `Website: https://www.${slug}.example.com\n`;
  if (hasContact) block += `Contact: ${["Maria Santos","David Chen","Patricia Nguyen","James Lee","Sofia Reyes"][i % 5]}, ${["Community Director","Admissions","Director of Nursing"][i % 3]} - (707) 555-${String(1000 + i).slice(-4)}\n`;
  return block;
}

export function makeSource(nItems) {
  let out = "Senior living options I'm putting together for the Johnson family. Mom needs light memory support and loves gardening.\n\nRecommended Communities\n\n";
  for (let i = 0; i < nItems; i++) {
    out += community(i) + "\n";
    if (i === Math.floor(nItems * 0.6)) out += "Also Worth Considering\n\n";
  }
  return out.trim();
}
