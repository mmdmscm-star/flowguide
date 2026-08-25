import type { Packet } from "./types.ts";

// THE PUBLIC DEMO, at /p/demo.
//
// This is the first real thing a prospective professional sees, and the landing
// page's primary call to action points straight at it. It has to read like work
// somebody actually did, which is why the planner below has opinions: she says
// one venue is too small and includes it anyway with a reason, and admits the
// cheapest option is loud. A feature showcase without judgement reads as a
// brochure.
//
// EVERY ENTITY AND EVERY FACT HERE IS INVENTED. Not just the names — the
// venues, people, addresses, prices, capacities, phone numbers and domains are
// all fictional, and none of them is attached to a real business. The previous
// demo attributed invented rates and invented staff to four real companies,
// which is a liability rather than a rough edge.
//
//   * phone numbers use 555-01xx, the range reserved for fiction;
//   * domains use .example.com, reserved by RFC 2606 and unregistrable;
//   * photographs are generic interiors, chosen so no identifiable real
//     building is presented as one of these invented venues.
//
// NO `notes` FIELD ANYWHERE, deliberately. /p/demo resolves this object
// directly rather than through getPublishedPacket, so the usual stripping of
// the professional's private note never runs — and ItemCard is a client
// component, so anything handed to it is serialised into the RSC payload and
// readable in view-source even when it is not drawn. The old demo leaked its
// note exactly that way. The safe fix for a fixture is to carry nothing
// private in the first place; a test enforces it.
export const samplePacket: Packet = {
  slug: "demo",
  title: "Offsite Venue Options",
  clientName: "the Northbeam team",
  personalNote:
    "Hi Priya,\n\nHere are the five venues I looked at for the March offsite, with the three I'd put in front of you first. I've listed day rates, capacity and what's included so you can compare them properly rather than digging through five websites.\n\nTwo things worth knowing now: The Foundry will only hold March 12–13 until the 28th, and Cedar & Vine's catering minimum goes up in January.\n\nHave a look and tell me which two you'd like to tour — I'll arrange them.\n\nThanks,\nMaya",
  sections: [
    {
      id: "s1",
      title: "Recommended",
      description: "The three I'd shortlist, in the order I'd rank them.",
      items: [
        {
          id: "i1",
          title: "The Foundry at Mill Street",
          address: "41 Mill Street, Harlow Bend",
          description:
            "A converted textile works with exposed brick and a glass roof over the main hall. Warm, informal, and the best natural light of anything I saw. The breakout rooms are on the same floor as the main space, which matters more than it sounds when you're moving 100 people between sessions.",
          photos: [
            "https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=800&q=80",
            "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=800&q=80",
            "https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=800&q=80",
            "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80",
          ],
          details: [
            { label: "Capacity", value: "120 seated · 180 standing" },
            { label: "Day rate", value: "$4,200" },
            { label: "Catering", value: "In-house, from $58 per head" },
            { label: "A/V", value: "Included — two screens, house sound" },
            { label: "Breakout rooms", value: "3, same floor" },
            { label: "Distance", value: "12 minutes from your office" },
          ],
          links: [{ url: "https://foundrymill.example.com", label: "Venue website" }],
          contacts: [
            {
              name: "Dana Reyes",
              role: "Events Manager",
              phone: "(206) 555-0118",
              email: "dana@foundrymill.example.com",
            },
          ],
        },
        {
          id: "i2",
          title: "Harborlight Loft",
          address: "9 Pier Road, Alder Quay",
          description:
            "Top-floor space with water on three sides. The view does a lot of the work, and it films well if you're recording any of the day. Honestly a little tight at 120 seated — comfortable at 90.",
          photos: [
            "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?w=800&q=80",
            "https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=800&q=80",
            "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80",
            "https://images.unsplash.com/photo-1511578314322-379afb476865?w=800&q=80",
          ],
          details: [
            { label: "Capacity", value: "90 seated · 140 standing" },
            { label: "Day rate", value: "$5,600" },
            { label: "Catering", value: "External, from their approved list" },
            { label: "A/V", value: "Screens and mics included, no house sound" },
            { label: "Breakout rooms", value: "1" },
            { label: "Distance", value: "20 minutes" },
          ],
          links: [{ url: "https://harborlightloft.example.com", label: "Venue website" }],
          contacts: [
            {
              name: "Sam Okonjo",
              role: "Venue Director",
              phone: "(206) 555-0164",
              email: "sam@harborlightloft.example.com",
            },
          ],
        },
        {
          id: "i3",
          title: "Cedar & Vine",
          address: "388 Vine Street, Harlow Bend",
          description:
            "The most straightforward of the three. Purpose-built for corporate days, so nothing needs solving — but it has less character than the other two. Best food by some distance.",
          photos: [
            "https://images.unsplash.com/photo-1431540015161-0bf868a2d407?w=800&q=80",
            "https://images.unsplash.com/photo-1478147427282-58a87a120781?w=800&q=80",
            "https://images.unsplash.com/photo-1533090161767-e6ffed986c88?w=800&q=80",
            "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=800&q=80",
            "https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&q=80",
          ],
          details: [
            { label: "Capacity", value: "150 seated" },
            { label: "Day rate", value: "$3,800" },
            { label: "Catering", value: "In-house, $2,400 minimum" },
            { label: "A/V", value: "Full house rig, technician included" },
            { label: "Breakout rooms", value: "4" },
            { label: "Distance", value: "15 minutes" },
          ],
          links: [{ url: "https://cedarandvine.example.com", label: "Venue website" }],
          contacts: [
            {
              name: "Alice Fenner",
              role: "Sales Manager",
              phone: "(206) 555-0177",
              email: "alice@cedarandvine.example.com",
            },
          ],
        },
      ],
    },
    {
      id: "s2",
      title: "Also considered",
      description: "Ruled out for this one, but worth knowing about.",
      items: [
        {
          id: "i4",
          title: "Union Hall",
          address: "12 Canal Street, Alder Quay",
          description:
            "Large and noticeably cheaper, but the main room is one open box with no breakout space and a ceiling that makes it loud. Worth keeping in mind if the group grows past 150.",
          photos: [
            "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=800&q=80",
            "https://images.unsplash.com/photo-1487958449943-2429e8be8625?w=800&q=80",
          ],
          details: [
            { label: "Capacity", value: "220 seated" },
            { label: "Day rate", value: "$2,900" },
            { label: "Catering", value: "External, no restrictions" },
            { label: "Breakout rooms", value: "None" },
          ],
        },
        {
          id: "i5",
          title: "The Glasshouse",
          address: "5 Orchard Lane, Harlow Bend",
          description:
            "Genuinely lovely, and genuinely too small — 60 seated at most. I've left it in because I think it's right for the leadership offsite in the autumn.",
          photos: [
            "https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=800&q=80",
            "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=800&q=80",
          ],
          details: [
            { label: "Capacity", value: "60 seated" },
            { label: "Day rate", value: "$3,100" },
            { label: "Catering", value: "In-house" },
            { label: "Breakout rooms", value: "2" },
          ],
        },
      ],
    },
    {
      id: "s3",
      title: "Next steps",
      items: [
        {
          id: "i6",
          title: "Pick two to tour",
          description:
            "Tell me which two you'd like to see and I'll arrange visits for the week of the 8th. Most venues want about a week's notice.",
        },
        {
          id: "i7",
          title: "Hold dates by the 28th",
          description:
            "The Foundry is holding March 12–13 for us until the 28th. After that it opens back up. The others have wider availability through March.",
        },
      ],
    },
  ],
  professional: {
    name: "Maya Ellison",
    businessName: "Ellison & Co.",
    footerLabel: "Your Planner",
    phone: "(206) 555-0143",
    email: "maya@ellisonco.example.com",
    websiteUrl: "https://ellisonco.example.com",
  },
};
