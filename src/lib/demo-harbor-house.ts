import type { Packet } from "./types.ts";

// A PUBLIC DEMO, at /p/harbor-house.
//
// A hotel's guest guide: the things people come down to the desk to ask, and
// then the places the desk actually sends them. It is here because it is the
// furthest thing from the venue shortlist that the same content model can
// make — no comparison, no shortlist, no decision to reach. Reference
// information, which a phone is the right place for and a printed card in a
// room is not.
//
// THE SAME RULES AS EVERY OTHER DEMO, enforced by public-surface.test.mts
// against the registry rather than against one fixture. Every business, person,
// price, address, phone number and domain below is invented: phones in the
// 555-01xx block reserved for fiction, domains in .example.com. No `notes`
// field anywhere — /p/[slug] resolves this object directly, so the private-note
// stripping never runs, and ItemCard is a client component, so anything handed
// to it is readable in view-source even when it is never drawn.
//
// Photographs are generic interiors and food, checked one at a time so that no
// identifiable real hotel, restaurant or café is presented as one of these
// invented businesses — and none carries a visible brand.
//
// It wears the WARM treatment. Three demos, three looks, no extra content: the
// treatment layer is already per-packet, so the fastest way to make the
// examples look unalike is to let them be.
export const harborHouseDemo: Packet = {
  slug: "harbor-house",
  title: "Harbor House — Guest Guide",
  clientTitle: "Welcome to Harbor House",
  styleTreatment: "warm",
  personalNote:
    "Welcome — we're glad you're here.\n\nThis is everything guests come down to the desk to ask, so you don't have to. Wi-Fi, breakfast, parking and check-out are at the top. Below that are the places we actually send people, which is not the same list as the map in your room.\n\nIf something isn't here, dial 0. Someone's on the desk until eleven, and after that the night porter will find us.\n\n— Nadia",
  sections: [
    {
      id: "s1",
      title: "The things everyone asks",
      description: "Wi-Fi, breakfast, parking and check-out, in that order.",
      items: [
        {
          id: "h1",
          title: "Wi-Fi",
          description: "One network for the whole building, including the courtyard.",
          details: [
            { label: "Network", value: "HarborHouse-Guest" },
            { label: "Password", value: "seabird-1908" },
            { label: "Devices", value: "Up to four per room" },
            { label: "If it drops", value: "Forget the network and rejoin — it beats a reset" },
          ],
        },
        {
          id: "h2",
          title: "Breakfast",
          description:
            "In the Glasshouse, off the lobby. A proper cooked breakfast, not a tray of pastries.",
          highlight:
            "Come before 8.15 or after 9.30 — the middle hour is the only time there's ever a wait.",
          photos: [
            "https://images.unsplash.com/photo-1655979283362-535e6a167a53?w=800&q=80",
            "https://images.unsplash.com/photo-1525184782196-8e2ded604bf7?w=800&q=80",
          ],
          details: [
            { label: "Weekdays", value: "7.00 – 10.00" },
            { label: "Weekends", value: "8.00 – 11.00" },
            { label: "Included", value: "Yes, with every room" },
            { label: "Room service", value: "Same menu, $6 tray charge" },
          ],
        },
        {
          id: "h3",
          title: "Parking",
          address: "Rear entrance, Canal Street, Alder Quay",
          description:
            "The car park is ours, but the entrance is easy to miss — it's the gap between the bakery and the chandlery.",
          photos: ["https://images.unsplash.com/photo-1573477236351-8726ea419a62?w=800&q=80"],
          details: [
            { label: "Height limit", value: "2.0 m" },
            { label: "Overnight", value: "$18, added to your room" },
            { label: "In and out", value: "Yes — keep the ticket" },
            { label: "Electric", value: "Two chargers, by the back door" },
          ],
        },
        {
          id: "h4",
          title: "Check-out",
          details: [
            { label: "Check-out", value: "11.00" },
            { label: "Late check-out", value: "Until 14.00 when we have it — ask the night before" },
            { label: "Luggage", value: "We'll keep it as long as you need" },
            { label: "Express", value: "Leave the key in the box by the door" },
          ],
        },
      ],
    },
    {
      id: "s2",
      title: "In the building",
      items: [
        {
          id: "h5",
          title: "The roof terrace",
          description:
            "Open to guests, no booking. It's the best thing about this hotel and almost nobody finds it.",
          highlight:
            "Sunset is over the water from the north end, not the side everyone sits on.",
          photos: [
            "https://images.unsplash.com/photo-1586865020662-e8185e0b2679?w=800&q=80",
            "https://images.unsplash.com/photo-1613891186868-eebda780cc8a?w=800&q=80",
          ],
          details: [
            { label: "Hours", value: "8.00 until 22.00" },
            { label: "Access", value: "Lift to 4, then the stair on your left" },
            { label: "Drinks", value: "From the bar until 21.30" },
            { label: "In the rain", value: "Covered at the north end" },
          ],
          links: [
            { url: "https://harborhousehotel.example.com/terrace", label: "Terrace menu" },
          ],
        },
        {
          id: "h6",
          title: "Bikes",
          description:
            "Six of them, free, first come. They're heavy and they're perfect for the towpath.",
          photos: ["https://images.unsplash.com/photo-1521078803125-7efd09b65b8f?w=800&q=80"],
          details: [
            { label: "Where", value: "Under the stair by the back door" },
            { label: "Key", value: "From the desk" },
            { label: "Helmets", value: "Yes — ask" },
            { label: "Lights", value: "Fitted, charged Fridays" },
          ],
        },
      ],
    },
    {
      id: "s3",
      title: "Where we actually send people",
      description: "Not the tourist map in your room. These are ours, and all within a walk.",
      items: [
        {
          id: "h7",
          title: "The Lantern Room",
          address: "12 Canal Street, Alder Quay",
          description:
            "Eight tables, one sitting a night. This is where we send people celebrating something.",
          photos: [
            "https://images.unsplash.com/photo-1772057593039-372e8622c6be?w=800&q=80",
            "https://images.unsplash.com/photo-1759358342176-d754874c6d6e?w=800&q=80",
          ],
          details: [
            { label: "Walk", value: "6 minutes" },
            { label: "Booking", value: "Essential — we'll call for you" },
            { label: "Closed", value: "Sunday and Monday" },
            { label: "About", value: "$45 a head before wine" },
          ],
          links: [{ url: "https://lanternroom.example.com", label: "Menu" }],
          contacts: [
            { name: "Ivo Marchetti", role: "Owner", phone: "(206) 555-0158", email: "ivo@lanternroom.example.com" },
          ],
        },
        {
          id: "h8",
          title: "Pell & Daughter",
          address: "3 Weighbridge Lane, Alder Quay",
          description:
            "Coffee. They open at six for the fishermen, which makes it the only thing open when you're awake at five and shouldn't be.",
          photos: ["https://images.unsplash.com/photo-1598959652545-c0230cdbb01f?w=800&q=80"],
          details: [
            { label: "Walk", value: "2 minutes" },
            { label: "Opens", value: "6.00" },
            { label: "Closed", value: "Never, apparently" },
            { label: "Cash", value: "They prefer it" },
          ],
          contacts: [{ name: "Marta Pell", role: "Owner", phone: "(206) 555-0163" }],
        },
        {
          id: "h9",
          title: "The towpath, going north",
          description:
            "Forty minutes out, forty back, flat the whole way. Take one of the bikes.",
          details: [
            { label: "Start", value: "Left out of the back door" },
            { label: "Surface", value: "Gravel — fine in trainers" },
            { label: "Turn around at", value: "The iron bridge" },
            { label: "Dogs", value: "Off lead past the lock" },
          ],
        },
      ],
    },
  ],
  professional: {
    name: "Nadia Hale",
    businessName: "Harbor House Hotel",
    footerLabel: "The Front Desk",
    phone: "(206) 555-0142",
    email: "nadia@harborhousehotel.example.com",
    websiteUrl: "https://harborhousehotel.example.com",
  },
};
