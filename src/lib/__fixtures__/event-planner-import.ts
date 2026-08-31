// THE REAL EVENT-PLANNER IMPORT THAT EXPOSED THE INGESTION-INTEGRITY DEFECTS.
//
// A venue CSV whose header carries FOUR note columns that mean different
// things — `Client-Facing Notes`, `Private / Internal Notes`, `Planner Notes —
// Audience Not Yet Decided`, and `Related / Cross-Reference`. That shape is what
// made the defects visible, and it is why this file is worth keeping:
//
//  * THREE PAIRS OF VENUES SHARE ONE CONTACT PERSON — Lauren Pike on both
//    Harbor House rows, Omar Reed on both Foundry rows, Jae Kim on both Atlas
//    rows. A shared email and phone are correctly discarded as non-unique, so
//    each of those six records can only be told apart by its own WEBSITE —
//    which is exactly the anchor a trailing CSV comma used to corrupt.
//
//  * THE PRICING COLUMN IS A QUOTED MULTILINE FIELD whose second line holds a
//    clock time. Splitting it on the first colon lands inside "6:00", and the
//    model then ran past the field's closing quote and swallowed raw CSV — in
//    two cases across the record boundary into the next venue entirely.
//
//  * THE CLIENT-FACING COLUMN DELIBERATELY CONTAINS PRIVACY WORDS: "private
//    office", "internal courtyard", "confidential one-on-one meeting space",
//    "confidentiality screens", and Clementine Club's menu that is
//    confidential to the public but explicitly reviewable BY THE CLIENT. Those
//    exist to prove that widening privacy vocabulary by PHRASE would hide
//    information the source says the client may see.
//
// Synthetic throughout — example.example domains, 555 numbers — and kept as a
// TypeScript module rather than a .csv because .gitignore excludes *.csv, and
// that rule exists to keep real client data out of the repository. A fixture
// that vanishes on a clean checkout is worse than no fixture: the test that
// depends on it fails for a reason nobody can see.
export const EVENT_PLANNER_CSV = String.raw`Venue,City,Address,Venue Type,Client-Facing Description,Capacity / Layout,Contact Name,Role,Phone,Email,Website,Pricing,Availability / Date,Included / Amenities,Food & Beverage,Client-Facing Notes,Private / Internal Notes,Planner Notes — Audience Not Yet Decided,Related / Cross-Reference
Harbor House Loft,Sausalito,"22 Bridgeway, Sausalito, CA 94965",Waterfront loft / private events,"Bright second-floor loft overlooking the bay, with exposed beams, large windows, and a separate private dining room that can be closed for an executive dinner.",85 seated at rounds; 120 reception; private dining room seats 18,Lauren Pike,Director of Events,(415) 555-0211,lauren@harborhospitality.example,https://harborhouseloft.example,"Venue rental: $8,500
Required staffing: $1,200
Security after 9:00 PM: $450",October 16 available; October 17 on hold for another event,"Tables, chairs, basic house lighting, coat check area, waterfront terrace",Preferred caterer list; outside caterers allowed with $750 kitchen fee,The private dining room is client-facing information and may be useful for the leadership dinner.,,,"Harbor House Loft and Harbor House Garden share an events team, but they are separate venues."
Harbor House Garden,Sausalito,"8 Princess St, Sausalito, CA 94965",Outdoor garden / tented event space,"Landscaped courtyard and lawn two blocks from the waterfront. Best for a daytime reception, dinner under a tent, or a casual closing event.",100 seated under tent; 150 reception,Lauren Pike,Director of Events,(415) 555-0211,lauren@harborhospitality.example,https://harborhousegarden.example,"Site fee: $6,200
Tent package: $4,800
Power distribution: $900",October 16 and 17 currently available,"Garden furniture, string lighting, two restrooms, small prep room",Catering must be licensed; no exclusive caterer,Lauren also represents Harbor House Loft. The repeated contact is intentional.,,,Guests can walk from Harbor House Garden to Harbor House Loft in about 4 minutes; this does not make the two spaces one venue.
The Foundry Hall,Oakland,"390 3rd St, Oakland, CA 94607",Industrial event hall,"Large brick-and-timber hall with a flexible floor plan, built-in stage, and good production access for presentations followed by dinner.",140 seated; 225 reception; classroom layout up to 110,Omar Reed,Senior Sales Manager,(510) 555-0240,omar@foundryevents.example,https://foundryhall.example,"Friday rental: $12,000
AV package: $3,600
Cleaning: $800",October 17 available; access from 10:00 AM to midnight,"Stage, projector, screen, green room, loading door, 20A power drops",Exclusive in-house bar; outside caterers from approved list,The green room is backstage but is ordinary client-facing venue information.,For planner only — Omar offered a 7% courtesy reduction if we sign by September 12. Do not quote this to the client until he sends the revised proposal.,,
The Foundry Annex,Oakland,"404 3rd St, Oakland, CA 94607",Small industrial event space,"Smaller sister space next door to The Foundry Hall. It works well for workshops, breakouts, or a dinner when the full Hall feels oversized.",72 seated; 95 reception,Omar Reed,Senior Sales Manager,(510) 555-0240,omar@foundryevents.example,https://foundryannex.example,"Rental: $6,800
Basic AV: $1,250",October 17 available,"Portable screen, lounge furniture, two breakout nooks",May use The Foundry Hall kitchen for catering prep if the Hall is not booked simultaneously,The kitchen arrangement belongs to the Annex record even though it mentions The Foundry Hall.,,Omar said 85 people may feel tight for a fully seated program even though the published maximum is 95. I would probably discuss layout with the client before recommending it.,Separate venue from The Foundry Hall despite the similar name and shared contact.
Redwood Assembly,San Rafael,"910 B St, San Rafael, CA 94901",Meeting venue / courtyard,"Warm, modern meeting venue with a main room and an internal courtyard that can be opened during breaks. The courtyard is part of the guest experience, not a staff-only area.",90 seated theater; 64 classroom; 110 reception,Tessa Morgan,Venue Manager,(415) 555-0264,tessa@redwoodassembly.example,https://redwoodassembly.example,"Full-day rental: $7,400
Evening extension after 6:00 PM: $1,100",October 17 available,"Wi-Fi, 2 wireless mics, display, internal courtyard, coffee station",Outside catering allowed; beer and wine permit available,The phrase “internal courtyard” is descriptive and should remain client-facing.,"Keep between the planning team: the owner is considering a stricter outdoor-noise policy after 10:00 PM, but nothing has been adopted or published.",,
Assembly House,San Anselmo,"17 Tunstead Ave, San Anselmo, CA 94960",Historic house / meeting venue,Restored historic house suited to smaller leadership gatherings. A private office off the library can be used as a speaker prep room or confidential one-on-one meeting space.,54 seated; 75 reception,Nora Bell,Events Coordinator,(415) 555-0255,nora@assemblyhouse.example,https://assemblyhouse.example,"Day rental: $5,900
Furniture reset fee: $350",October 17 available until 9:30 PM,"Library, dining room, private office, garden patio, house sound system",Approved caterer list; wine service allowed,“Private office” and “confidential one-on-one meeting space” describe client-usable rooms; those words do not make the source note private.,,,Assembly House is unrelated to Redwood Assembly.
Atlas Hall (formerly Pier 27 Gallery),San Francisco,"270 The Embarcadero, San Francisco, CA 94111",Gallery / event hall,"Large contemporary gallery with bay views and strong built-in production capability. Suitable for a keynote, reception, and dinner in one room.",180 seated; 300 reception,Jae Kim,Group Sales Director,(415) 555-0291,jae@atlasevents.example,https://atlashall.example,"Venue rental: $14,500
Mandatory building engineer: $1,100
AV starting package: $4,250",October 17 available after 2:00 PM load-in,"Stage, 16-foot screen, house sound, freight elevator, waterfront lobby",Exclusive beverage service; outside catering allowed,The former name is part of the venue identity and should not cause this record to merge with Atlas Courtyard.,,,"Same ownership group as Atlas Courtyard; different room, address, capacity, and pricing."
Atlas Courtyard,San Francisco,"288 The Embarcadero, San Francisco, CA 94111",Outdoor courtyard / reception venue,"Open-air courtyard operated by Atlas Events. Best for cocktails, lunch, or a closing reception rather than a full-day meeting.",110 seated; 180 reception,Jae Kim,Group Sales Director,(415) 555-0291,jae@atlasevents.example,https://atlascourtyard.example,"Courtyard rental: $7,250
Weather tent: $3,900 if requested",October 16 confirmed open; October 17 status pending,"Market lights, heaters, portable bar, adjacent loading access",Same approved catering list as Atlas Hall,Jae Kim and the Atlas Events email domain legitimately appear on both Atlas records.,,Jae said another group has a soft hold on October 17 but expects to know tomorrow whether it will clear. She did not tell me whether we should treat the date as available yet.,Shares a loading entrance with Atlas Hall; that fact belongs to Atlas Courtyard too.
Larkspur Landing Conference Center,Larkspur,"500 Larkspur Landing Cir, Larkspur, CA 94939",Conference center,"Straightforward conference venue near the ferry, with multiple meeting rooms and easy parking. Less distinctive visually, but operationally simple for an all-day program.",Main room: 120 theater / 80 classroom; 4 breakout rooms,Devon Ross,Conference Services,(415) 555-0228,devon@larkspurconference.example,https://larkspurconference.example,"Day package: $165 per person, 60-person minimum
Includes room rental, continental breakfast, lunch, and standard AV",October 17 available,"Parking, Wi-Fi, standard projector, 4 breakout rooms, confidentiality screens available on request",In-house conference catering,Confidentiality screens are a normal client-facing amenity and should not be treated as a privacy instruction.,,,
Glasshouse Studio,Berkeley,"1420 4th St, Berkeley, CA 94710",Creative studio / event rental,"Light-filled studio with movable walls, a demonstration kitchen, and a private roof deck. Good for an interactive workshop followed by drinks.",80 seated; 130 reception,Imani Wells,Studio Director,(510) 555-0233,imani@glasshousestudio.example,https://glasshousestudio.example,"Studio rental: $7,900
Kitchen use: $650
Roof deck staffing: $500",October 17 available,"Demonstration kitchen, movable walls, private roof deck, basic furniture",Outside catering and wine allowed with insurance certificate,The private roof deck is client-facing venue information.,"Do not share with the client yet — Imani verbally offered to waive corkage if we use her preferred caterer, but she has not confirmed the waiver in writing.",,
Clementine Club,San Francisco,"88 Clement St, San Francisco, CA 94118",Restaurant buyout / private dining,"Neighborhood restaurant available for a full private buyout. Strong option for a closing dinner, with a bar area and two connected dining rooms.",96 seated; 125 reception,Marco Ruiz,Private Events Manager,(415) 555-0280,marco@clementineclub.example,https://clementineclub.example,"Food & beverage minimum: $18,000
Service charge: 24%
Room fee waived with minimum",October 17 dinner available,"Full restaurant buyout, bar, two dining rooms, printed menus",Seasonal three-course and family-style menus available,"The fall menu is confidential until September 20. The client may review it now, but the restaurant asks that it not be posted or shared publicly before launch.",,,
Clementine Room at Parkline Hotel,San Francisco,"705 Market St, San Francisco, CA 94103",Hotel meeting room,"Dedicated hotel meeting room with natural light, adjacent foyer, and easy guest-room access. Despite the similar name, it is not affiliated with Clementine Club.",70 classroom; 100 theater; 80 banquet,Sara Ng,Group Events Manager,(415) 555-0272,sara@parklinehotel.example,https://parklinehotel.example/clementine-room,"Meeting room rental: $4,800
Guest-room block: $349/night before taxes
Coffee service: $28 per person",October 17 available; 20 guestrooms currently held as a courtesy,"Built-in display, foyer, hotel Wi-Fi, guestrooms upstairs",Hotel catering required,The similar “Clementine” name should not pull information from Clementine Club onto this record.,Private note for our team: this hotel waived the meeting-room rental for this same client two years ago. Do not assume or promise that concession this time.,,`;

/** The delimiter the run declared. */
export const EVENT_PLANNER_DELIMITER = ",";
