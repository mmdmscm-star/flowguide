// The fixture the 0016 acceptance script builds its packet from.
//
// It lives here, rather than inside the script, so a unit test can prove it
// actually produces the finding the script is written to exercise. A script
// whose fixture silently stopped being misplaced would pass every assertion by
// finding nothing, and report that as success.
//
// Two records, one photo each. Record 0's photo is attached to item 1 — the
// shape of the original incident, minus the model.

export const PHOTO_A = "https://cdn.example.invalid/alpha-1.jpg";
export const PHOTO_B = "https://cdn.example.invalid/bravo-1.jpg";

export const GATE_SOURCE =
  `Alpha House\t101 First St\t${PHOTO_A}\n` +
  `Bravo Manor\t202 Second St\t${PHOTO_B}\n`;

export const GATE_TITLES = ["Alpha House", "Bravo Manor"] as const;
