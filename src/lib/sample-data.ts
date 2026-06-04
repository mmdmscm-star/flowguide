import { Packet } from "./types";

export const samplePacket: Packet = {
  slug: "demo",
  title: "Senior Living Options for Mom",
  clientName: "Sarah Johnson",
  personalNote:
    "Hi Sarah, it was wonderful speaking with you and your brother about your mom's care needs. Based on everything you shared — her love of gardening, her need for light memory support, and your preference to stay close to the Riverside area — I've put together my top recommendations. Each community below has been personally visited and vetted. Please don't hesitate to call me with any questions. I'm here to help make this transition as smooth as possible.",
  sections: [
    {
      id: "s1",
      title: "Top Recommended Communities",
      description:
        "These three communities are my strongest recommendations based on your family's priorities.",
      items: [
        {
          id: "i1",
          title: "Sunrise of Riverside",
          description:
            "A warm, boutique-style community with an outstanding memory care program. Their garden courtyard is one of the best I've seen — your mom would love it. Staff-to-resident ratio is excellent at 1:5 during daytime hours.",
          photos: [
            "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=800&q=80",
            "https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=800&q=80",
          ],
          details: [
            { label: "Care Level", value: "Assisted Living + Memory Care" },
            { label: "Monthly Cost", value: "$4,800 - $6,200" },
            { label: "Room Types", value: "Private Studio, One Bedroom" },
            { label: "Move-in Availability", value: "2 studios available now" },
            { label: "Distance from You", value: "8 minutes" },
          ],
          notes:
            "I'd suggest scheduling a lunch visit — their dining program is a real highlight. Ask for Maria at the front desk; she'll give you the full tour.",
          links: [
            {
              url: "https://www.sunriseseniorliving.com",
              label: "Community Website",
            },
          ],
          contact: {
            name: "Maria Santos, Community Director",
            phone: "(951) 555-0142",
            email: "msantos@sunrise.example.com",
          },
        },
        {
          id: "i2",
          title: "Oakmont Senior Living",
          description:
            "A larger community with a resort-style feel. They have a dedicated memory care wing called 'The Terrace' that's separate from assisted living, which provides a calm environment. Excellent activities program with daily music therapy.",
          photos: [
            "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80",
          ],
          details: [
            { label: "Care Level", value: "Memory Care (The Terrace)" },
            { label: "Monthly Cost", value: "$5,500 - $7,100" },
            { label: "Room Types", value: "Private Suite" },
            { label: "Move-in Availability", value: "Waitlist — approx. 3 weeks" },
            { label: "Distance from You", value: "14 minutes" },
          ],
          notes:
            "Slightly higher price point but their memory care program is one of the best in the county. The waitlist moves fast — I'd recommend getting on it now even if you're still deciding.",
          links: [
            {
              url: "https://www.oakmontseniorliving.com",
              label: "Community Website",
            },
            {
              url: "https://www.oakmontseniorliving.com/the-terrace",
              label: "The Terrace Memory Care",
            },
          ],
          contact: {
            name: "David Chen, Admissions",
            phone: "(951) 555-0287",
            email: "dchen@oakmont.example.com",
          },
        },
        {
          id: "i3",
          title: "Garden Villas Memory Care",
          description:
            "A smaller, home-like community specializing exclusively in memory care. Only 24 residents, so the staff really knows everyone by name. Their outdoor garden program is therapeutic and structured — perfect for your mom.",
          photos: [
            "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800&q=80",
          ],
          details: [
            { label: "Care Level", value: "Memory Care Only" },
            { label: "Monthly Cost", value: "$5,200 - $5,800" },
            { label: "Room Types", value: "Private Room, Shared Common Areas" },
            { label: "Move-in Availability", value: "1 room available now" },
            { label: "Distance from You", value: "11 minutes" },
          ],
          notes:
            "This is my personal favorite for your mom's situation. The small size means she won't feel overwhelmed, and the garden program aligns perfectly with her interests.",
          links: [
            {
              url: "https://www.gardenvillas.example.com",
              label: "Community Website",
            },
          ],
          contact: {
            name: "Patricia Nguyen, Owner/Director",
            phone: "(951) 555-0319",
          },
        },
      ],
    },
    {
      id: "s2",
      title: "Also Worth Considering",
      description:
        "These communities are solid options if the top three don't feel like the right fit.",
      items: [
        {
          id: "i4",
          title: "Brookdale Riverside",
          description:
            "A well-known national brand with consistent quality. Larger community with more social activities and amenities. Their memory care wing was recently renovated.",
          details: [
            { label: "Care Level", value: "Assisted Living + Memory Care" },
            { label: "Monthly Cost", value: "$4,200 - $5,900" },
            { label: "Move-in Availability", value: "Available now" },
            { label: "Distance from You", value: "18 minutes" },
          ],
          notes:
            "Good value option. Less intimate than Garden Villas but more amenities. They frequently run move-in specials.",
          contact: {
            name: "Admissions Office",
            phone: "(951) 555-0445",
          },
        },
        {
          id: "i5",
          title: "Pacifica Senior Living",
          description:
            "Mid-range option with a strong rehabilitation program. Good choice if your mom's needs might increase over time, as they offer a full continuum of care.",
          details: [
            { label: "Care Level", value: "Full Continuum" },
            { label: "Monthly Cost", value: "$4,500 - $6,400" },
            { label: "Move-in Availability", value: "Available now" },
            { label: "Distance from You", value: "22 minutes" },
          ],
          contact: {
            name: "Jennifer Walsh, Community Relations",
            phone: "(951) 555-0518",
            email: "jwalsh@pacifica.example.com",
          },
        },
      ],
    },
    {
      id: "s3",
      title: "Next Steps",
      description: "Here's what I recommend doing over the next two weeks.",
      items: [
        {
          id: "i6",
          title: "Schedule Tours",
          description:
            "I'd recommend visiting your top 2-3 choices in person. Weekday lunch visits give you the best feel for daily life. I'm happy to accompany you on any tour.",
        },
        {
          id: "i7",
          title: "Financial Planning",
          description:
            "If you haven't already, connect with a senior care financial advisor. Many families use long-term care insurance, VA benefits, or bridge loans to cover costs. I can recommend an advisor if helpful.",
          links: [
            {
              url: "https://www.eldercare.acl.gov",
              label: "Eldercare Locator (Free Resource)",
            },
          ],
        },
        {
          id: "i8",
          title: "Questions to Ask on Tours",
          description:
            "Staff-to-resident ratio on nights and weekends. How they handle medical emergencies. What's included in the base rate vs. add-on charges. How they personalize care for memory care residents. Activity schedule for the specific wing your mom would be in.",
        },
      ],
    },
  ],
  professional: {
    name: "Linda Martinez",
    businessName: "Riverside Senior Placement Services",
    phone: "(951) 555-0100",
    email: "linda@riversideplacement.example.com",
  },
};
