import type { Packet } from "./types.ts";

// A PUBLIC DEMO, at /p/month-one.
//
// A trainer's month of sessions, and the origin of the whole product: a
// spreadsheet that works on a laptop is useless at a gym, where you are
// standing up, holding a phone, with ninety seconds before the next set.
// Day A below is deliberately shaped like the rows of that spreadsheet —
// exercise, sets, reps, rest, weight — because it IS those rows, rendered.
//
// TWO PHOTOGRAPHS PER LIFT, START AND BOTTOM, and that is the point rather
// than decoration. A form video is what a trainer would actually send, and the
// product renders one: a YouTube link becomes a tappable thumbnail. A public
// demo may not carry one, because every URL in a demo has to be unregistrable
// (.example.com) or the image host — and a real video can be deleted, made
// private, or changed by someone who has never heard of this fixture. Two
// stills of the movement need no such dependency and a spreadsheet cannot show
// you either of them.
//
// Not every item carries photographs, which is what a real plan looks like.
//
// Every person, business, phone number and domain is invented; phones use the
// 555-01xx block and domains .example.com. No `notes` field — see the comment
// in sample-data.ts for why a fixture carries nothing private at all.
export const monthOneDemo: Packet = {
  slug: "month-one",
  title: "Jordan — Month One",
  clientTitle: "Month One",
  clientName: "Jordan",
  styleTreatment: "default",
  personalNote:
    "Jordan —\n\nHere's month one. Two sessions, A and B, alternating, three days a week — so week one is A-B-A and week two is B-A-B.\n\nThe weights are starting points, not targets. If the last rep is easy, add a little next time. If your form breaks before the last rep, take weight off; that isn't failing, that's the set doing its job.\n\nTwo things I want to hear about: sharp pain, which is not the same as soreness, and the overhead press if your left shoulder complains. There's a swap for it and I'd rather change it than have you push through.\n\nBring this up on your phone between sets. Don't try to remember it.\n\n— Tasha",
  sections: [
    {
      id: "m0",
      title: "How the month works",
      description: "Three sessions a week, alternating A and B.",
      items: [
        {
          id: "w0",
          title: "The warm-up, both days",
          description:
            "Five minutes. Not optional — it's the difference between a good session and a tweaked back.",
          photos: ["https://images.unsplash.com/photo-1467818488384-3a21f2b79959?w=800&q=80"],
          details: [
            { label: "Bike or row", value: "3 minutes, easy" },
            { label: "Hip hinge", value: "10, no weight" },
            { label: "Band pull-apart", value: "15" },
            { label: "Bodyweight squat", value: "10, slow" },
          ],
        },
      ],
    },
    {
      id: "mA",
      title: "Day A",
      description: "Push and squat. About 45 minutes.",
      items: [
        {
          id: "a1",
          title: "Goblet squat",
          description: "Elbows inside the knees. Sit straight down, not back.",
          highlight: "If your heels lift, put a 5 lb plate under them and tell me.",
          photos: [
            "https://images.unsplash.com/photo-1706029831387-fd8bc3d27d01?w=800&q=80",
            "https://images.unsplash.com/photo-1603503363848-6952525df449?w=800&q=80",
          ],
          details: [
            { label: "Sets", value: "3" },
            { label: "Reps", value: "8" },
            { label: "Rest", value: "90 sec" },
            { label: "Start with", value: "35 lb" },
          ],
        },
        {
          id: "a2",
          title: "Dumbbell bench press",
          description: "Shoulder blades pinned to the bench the whole time.",
          photos: [
            "https://images.unsplash.com/photo-1692372372344-41aed374b848?w=800&q=80",
            "https://images.unsplash.com/photo-1646072508263-af94f0218bf0?w=800&q=80",
          ],
          details: [
            { label: "Sets", value: "3" },
            { label: "Reps", value: "10" },
            { label: "Rest", value: "90 sec" },
            { label: "Start with", value: "25 lb each" },
          ],
        },
        {
          id: "a3",
          title: "Overhead press",
          description: "Ribs down. If you're arching your back to finish, it's too heavy.",
          highlight:
            "This is the one to tell me about. If the left shoulder pinches, we swap to the landmine press.",
          details: [
            { label: "Sets", value: "3" },
            { label: "Reps", value: "8" },
            { label: "Rest", value: "90 sec" },
            { label: "Start with", value: "20 lb each" },
          ],
        },
        {
          id: "a4",
          title: "Split squat",
          description: "Back knee to the floor, front shin vertical. Slow on the way down.",
          details: [
            { label: "Sets", value: "2" },
            { label: "Reps", value: "10 each side" },
            { label: "Rest", value: "60 sec" },
            { label: "Start with", value: "Bodyweight" },
          ],
        },
      ],
    },
    {
      id: "mB",
      title: "Day B",
      description: "Pull and hinge. About 45 minutes.",
      items: [
        {
          id: "b1",
          title: "Romanian deadlift",
          description:
            "Push your hips back toward the wall behind you. The bar stays against your legs.",
          photos: [
            "https://images.unsplash.com/photo-1706029831405-619b27e3260c?w=800&q=80",
            "https://images.unsplash.com/photo-1620188500179-32ac33c60848?w=800&q=80",
          ],
          details: [
            { label: "Sets", value: "3" },
            { label: "Reps", value: "8" },
            { label: "Rest", value: "2 min" },
            { label: "Start with", value: "65 lb" },
          ],
        },
        {
          id: "b2",
          title: "One-arm row",
          description: "Pull to your hip, not your armpit. Don't twist.",
          details: [
            { label: "Sets", value: "3" },
            { label: "Reps", value: "10 each side" },
            { label: "Rest", value: "60 sec" },
            { label: "Start with", value: "30 lb" },
          ],
        },
        {
          id: "b3",
          title: "Lat pulldown",
          description: "Lead with your elbows. Stop at your collarbone.",
          details: [
            { label: "Sets", value: "3" },
            { label: "Reps", value: "10" },
            { label: "Rest", value: "90 sec" },
            { label: "Start with", value: "50 lb" },
          ],
        },
        {
          id: "b4",
          title: "Plank",
          description: "Squeeze everything. Thirty honest seconds beats a minute of sagging.",
          details: [
            { label: "Sets", value: "3" },
            { label: "Hold", value: "30 sec" },
            { label: "Rest", value: "45 sec" },
            { label: "Progress", value: "Add 5 sec when 30 is easy" },
          ],
        },
      ],
    },
  ],
  professional: {
    name: "Tasha Bell",
    businessName: "Bell Strength",
    footerLabel: "Your Coach",
    phone: "(206) 555-0126",
    email: "tasha@bellstrength.example.com",
    websiteUrl: "https://bellstrength.example.com",
  },
};
