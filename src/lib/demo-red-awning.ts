import type { Packet } from "./types.ts";

// A PUBLIC DEMO, at /p/red-awning.
//
// A food truck's menu for the day. The most instantly legible of the four — a
// stranger knows what it is before reading a word — and the one that shows the
// same content model holding something nobody would call a document: a dense
// price list, read standing up, on the pavement in front of the thing selling
// it.
//
// It is also the demo that shows a Sendset is not a one-off. "Today's menu"
// changes tomorrow, and the link the truck already gave out shows the new one.
//
// Every business, person, price and domain is invented; the domain is
// unregistrable (.example.com) and the phone sits in the 555-01xx block
// reserved for fiction. No `notes` field — see sample-data.ts.
//
// EDITORIAL treatment, which is the furthest of the three from the venue
// shortlist's Default, so the four demos do not look like one demo four times.
export const redAwningDemo: Packet = {
  slug: "red-awning",
  title: "The Red Awning — Today's Menu",
  clientTitle: "Today's Menu",
  styleTreatment: "editorial",
  personalNote:
    "Everything on here is made in the truck, that morning.\n\nThe menu moves. If something's on it today it's because it was good at the market this morning, and if the thing you had last time is missing, that's why.\n\nTwo notes. The birria is the one to get if you've not been before, and it runs out — usually by one. And the salsa on the table is the mild one on purpose; the hot one is on the counter and it is genuinely hot.\n\nCash and cards both fine.\n\n— Elena",
  sections: [
    {
      id: "r1",
      title: "Tacos",
      description: "All $4.50. Three is a meal, four if you're hungry.",
      items: [
        {
          id: "t1",
          title: "Birria",
          description: "Beef, going since five this morning, with the consommé to dip.",
          highlight: "Get this one if it's your first time.",
          photos: [
            "https://images.unsplash.com/photo-1617918160302-f2dfbcb3f88c?w=800&q=80",
            "https://images.unsplash.com/photo-1606350383072-4b031d6bd834?w=800&q=80",
          ],
          details: [
            { label: "Price", value: "$4.50" },
            { label: "Heat", value: "Mild" },
            { label: "With", value: "Consommé, onion, cilantro" },
            { label: "Gone by", value: "Usually 1pm" },
          ],
        },
        {
          id: "t2",
          title: "Carnitas",
          description: "Shoulder, crisped on the flat-top to order.",
          details: [
            { label: "Price", value: "$4.50" },
            { label: "Heat", value: "None" },
            { label: "With", value: "Onion, cilantro, lime" },
            { label: "Ask for", value: "Extra crisp — we'll do it" },
          ],
        },
        {
          id: "t3",
          title: "Pollo asado",
          description: "Thigh, not breast. Marinated overnight in achiote.",
          details: [
            { label: "Price", value: "$4.50" },
            { label: "Heat", value: "Mild" },
            { label: "With", value: "Onion, cilantro" },
            { label: "Also", value: "Good on the salad below" },
          ],
        },
        {
          id: "t4",
          title: "Nopales",
          description: "Cactus, charred, with black beans. The one the vegetarians come back for.",
          photos: ["https://images.unsplash.com/photo-1601579110733-f654670d8c30?w=800&q=80"],
          details: [
            { label: "Price", value: "$4.50" },
            { label: "Heat", value: "None" },
            { label: "With", value: "Queso fresco, lime" },
            { label: "Vegan", value: "Yes, without the queso" },
          ],
        },
      ],
    },
    {
      id: "r2",
      title: "Plates",
      description: "Bigger. Under ten minutes.",
      items: [
        {
          id: "p1",
          title: "Birria plate",
          photos: ["https://images.unsplash.com/photo-1683062332605-4e1209d75346?w=800&q=80"],
          details: [
            { label: "Price", value: "$14.00" },
            { label: "With", value: "Three tacos, consommé, rice" },
            { label: "Heat", value: "Mild" },
            { label: "Gone by", value: "Usually 1pm" },
          ],
        },
        {
          id: "p2",
          title: "Chopped salad",
          description: "Not an afterthought. Romaine, black bean, pickled onion, pepita, lime.",
          details: [
            { label: "Price", value: "$11.00" },
            { label: "Add chicken", value: "+$3" },
            { label: "Vegan", value: "Yes, without the cotija" },
            { label: "Dressing", value: "On the side if you ask" },
          ],
        },
        {
          id: "p3",
          title: "The big quesadilla",
          photos: ["https://images.unsplash.com/photo-1618040996337-56904b7850b9?w=800&q=80"],
          details: [
            { label: "Price", value: "$12.00" },
            { label: "With", value: "Salsa, crema" },
            { label: "Add birria", value: "+$4" },
            { label: "Feeds", value: "One, or two if you've had a taco" },
          ],
        },
      ],
    },
    {
      id: "r3",
      title: "Drinks and the sweet one",
      items: [
        {
          id: "d1",
          title: "Agua fresca",
          description: "Whatever fruit was good this morning.",
          details: [
            { label: "Price", value: "$4.00" },
            { label: "Today", value: "Watermelon" },
            { label: "Tomorrow", value: "Ask" },
            { label: "Refills", value: "No, sorry" },
          ],
        },
        {
          id: "d2",
          title: "Churros, two",
          photos: ["https://images.unsplash.com/photo-1590872809871-8a1602d5842d?w=800&q=80"],
          details: [
            { label: "Price", value: "$5.00" },
            { label: "With", value: "Cajeta to dip" },
            { label: "Made", value: "To order, four minutes" },
            { label: "Worth the wait", value: "Yes" },
          ],
        },
      ],
    },
  ],
  professional: {
    name: "Elena Duarte",
    businessName: "The Red Awning",
    footerLabel: "The Red Awning",
    phone: "(206) 555-0171",
    email: "elena@redawning.example.com",
    websiteUrl: "https://redawning.example.com",
  },
};
