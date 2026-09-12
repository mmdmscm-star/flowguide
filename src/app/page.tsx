import Link from "next/link";
import { PUBLIC_DEMOS } from "@/lib/public-demos";
import { monthOneDemo } from "@/lib/demo-month-one";

// THE PUBLIC FRONT DOOR.
//
// It uses the APPLICATION'S OWN tokens (accent, foreground, muted, border,
// surface) rather than a marketing palette, because the page has to feel like
// the same object as the product it is selling. There is no illustration
// system, no icon set, no stock photography and no animation: the product's
// whole argument is that a well-made thing respects its reader, and a busy
// page would contradict that on sight.
//
// IT SHOWS FOUR REAL SENDSETS AND LINKS TO THEM. The page used to reason
// outward from the product — what goes in, what comes out, four ways to hand it
// over — and a visitor had to assemble a mental picture before they could want
// anything. Someone who already understood Sendset read it and temporarily lost
// the thread, which is a recognition failure and not a persuasion one. So the
// examples come second, before any explanation: a venue shortlist, a hotel's
// guest guide, a month of training, a food truck's menu. Four jobs with almost
// nothing in common, which is the fastest way to think of a fifth.
//
// EVERYTHING SHOWN IS LIVE. The cards read their title, their contents and
// their photograph out of the fixtures the demos themselves render from, so a
// card cannot advertise a Sendset that no longer says that. The before/after
// below is the same: the left panel is Day A's rows, from the same object the
// right panel is a photograph of.
//
// THE IMAGES ARE PHOTOGRAPHS OF THE PRODUCT, and nothing else is. Captured from
// the live site by scripts/marketing/capture.mjs. A screenshot can go stale,
// which is why regenerating it is one command rather than a design file.
//
// The primary action is a DEMO, not signup. For a professional weighing a
// peer's product, opening a finished Sendset explains more in ten seconds than
// the page can in five hundred words — and it is the one path with no form, no
// account and no way to lose work. With four of them above the fold, the hero's
// own button becomes the way in rather than the way to look.
//
// VOCABULARY: the finished object is a SENDSET, publicly and in the product.
// `packet` is the internal name in the schema, the API and the docs, and never
// appears here.
//
// WHAT THE PAGE MAY CLAIM AS INPUT is what /new actually accepts: pasted text,
// a .csv/.txt/.md file, and photographed pages. Not PDFs and not Word — both
// are refused by name — and PDF belongs on the OUTPUT side only.

/** The four featured Sendsets, in the order they are shown, with the one line
 *  of copy each needs. Everything else — the heading, the contents, the
 *  photograph — is read from the demo itself. */
const FEATURED: Array<{ slug: string; blurb: string }> = [
  { slug: "demo",
    blurb: "Five venues compared, with the three worth touring first." },
  { slug: "harbor-house",
    blurb: "What guests come to the desk to ask, then where the desk actually sends them." },
  { slug: "month-one",
    blurb: "A month of sessions, read one-handed between sets." },
  { slug: "red-awning",
    blurb: "A small business sending its own prices, changed the morning it changed." },
];

const bySlug = new Map(PUBLIC_DEMOS.map((d) => [d.slug, d]));

/** What a card can show without inventing anything: the first photograph in the
 *  Sendset, and the names of the first few things in it. The names are the
 *  recognition — "Wi-Fi · Breakfast · Parking" says what a guest guide is
 *  faster than a sentence about guest guides. */
function cardOf(slug: string) {
  const demo = bySlug.get(slug)!;
  const items = demo.sections.flatMap((s) => s.items);
  // The first item with a GALLERY rather than the first with any photograph.
  // An item its author gave two pictures is one they invested in, and it is
  // reliably the thing the Sendset is about — Month One's first photograph is
  // the warm-up, which on a card reads as a pair of feet.
  const photo = (items.find((i) => (i.photos ?? []).length >= 2)
    ?? items.find((i) => (i.photos ?? []).length > 0))?.photos?.[0];
  return {
    demo,
    photo,
    names: items.slice(0, 3).map((i) => i.title),
    more: Math.max(0, items.length - 3),
  };
}

/** Day A, as the rows it is. The same object the captured photograph beside it
 *  was taken of — so "the same information" is a fact about this page rather
 *  than a claim made on it. */
const DAY_A = monthOneDemo.sections.find((s) => s.title === "Day A")!;
const DAY_A_COLUMNS = (DAY_A.items[0].details ?? []).map((d) => d.label);
const DAY_A_ROWS = DAY_A.items.map((i) => [i.title, ...(i.details ?? []).map((d) => d.value)]);

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 pb-24">
      {/* ---- 1. What it is ------------------------------------------------ */}
      <header className="pt-20 pb-12 sm:pt-28">
        <p className="text-sm font-semibold tracking-[0.14em] uppercase text-muted">
          Sendset
        </p>
        <h1 className="mt-5 text-[2.1rem] leading-[1.12] sm:text-[2.6rem] font-bold tracking-tight text-foreground text-balance">
          Turn what you have into something worth opening.
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-muted max-w-2xl">
          Sendset turns spreadsheet rows, pasted text, photographed pages and photos
          into one clear page made for the phone in someone&rsquo;s hand. You check it
          before anyone else sees it, then send it by link, email, message, print, or PDF.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href="/login"
            className="inline-flex items-center rounded-lg bg-accent px-6 py-3 text-base font-medium text-white transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
          >
            Start your first Sendset
          </Link>
          <Link href="/p/demo" className="text-base font-medium text-accent underline-offset-4 hover:underline">
            See a real Sendset
          </Link>
        </div>
      </header>

      {/* ---- 2. Four real ones -------------------------------------------- */}
      <Section title="Four Sendsets, made from four different piles of information.">
        <P className="!mt-0">
          All four are real and open in a new tab. Nothing here is a mock-up.
        </P>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {FEATURED.map(({ slug, blurb }) => {
            const { demo, photo, names, more } = cardOf(slug);
            return (
              <Link
                key={slug}
                href={`/p/${slug}`}
                /* A NEW TAB, because the copy above promises one and because a
                   visitor comparing four of these should not lose the page that
                   offered them. */
                target="_blank"
                rel="noopener"
                className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card
                           transition-colors hover:border-gray-300 focus:outline-none
                           focus:ring-2 focus:ring-accent focus:ring-offset-2"
              >
                {photo && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={photo}
                    alt=""
                    loading="lazy"
                    width={800}
                    height={500}
                    sizes="(min-width: 640px) 340px, 100vw"
                    className="aspect-[16/10] w-full object-cover"
                  />
                )}
                <div className="flex flex-1 flex-col p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                    {demo.professional.businessName}
                  </p>
                  <h3 className="mt-1.5 text-lg font-semibold leading-snug text-foreground">
                    {demo.clientTitle}
                  </h3>
                  <p className="mt-1.5 text-base leading-relaxed text-muted">{blurb}</p>
                  {/* The contents, in the Sendset's own words. */}
                  <p className="mt-3 text-sm leading-relaxed text-muted">
                    {names.join(" · ")}
                    {more > 0 && ` · +${more} more`}
                  </p>
                  <span className="mt-4 text-sm font-medium text-accent group-hover:underline">
                    Open it &rarr;
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
        <P className="mt-6">
          Different jobs, one thing underneath: a set of items with photos, details, links
          and notes, laid out to be read on a phone. Whether you gathered the information
          for someone else or it was yours to begin with.
        </P>
      </Section>

      {/* ---- 3. The same rows, twice --------------------------------------- */}
      <Section title="The information was already useful. It just wasn’t in a useful shape.">
        <div className="mt-1 grid gap-5 sm:grid-cols-2">
          {/* BEFORE — not a picture of a spreadsheet but the rows themselves,
              read out of the same object the photograph beside it was taken of,
              and given a phone's worth of room. Nothing is exaggerated: this is
              what four columns do when the screen is 350px wide. */}
          {/* min-w-0: a grid item's default `min-width: auto` is its CONTENT
              width, so the deliberately-too-wide table below pushed the whole
              page sideways instead of being clipped by the frame around it. */}
          <figure className="m-0 flex min-w-0 flex-col">
            <figcaption className="mb-2 text-sm font-medium text-foreground">
              Day A, as a spreadsheet on a phone
            </figcaption>
            {/* flex-1 so this panel stands the same height as the photograph
                beside it. Four rows and then blank grid is not padding — it is
                what four rows look like on a screen this size. */}
            <div className="flex-1 overflow-hidden rounded-xl border border-border bg-white">
              <div className="overflow-hidden">
                <table className="w-[150%] table-fixed border-collapse text-[10px] leading-tight text-foreground">
                  <thead>
                    <tr className="bg-surface">
                      <th className="border border-border px-1.5 py-1 text-left font-semibold">Exercise</th>
                      {DAY_A_COLUMNS.map((c) => (
                        <th key={c} className="border border-border px-1.5 py-1 text-left font-semibold">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DAY_A_ROWS.map((row) => (
                      <tr key={row[0]}>
                        {row.map((cell, j) => (
                          <td key={j} className="truncate border border-border px-1.5 py-1 align-top">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="px-3 py-2 text-xs text-muted">
                Four columns, cut off at the edge. No photograph of the movement, and
                nowhere for the one note the trainer wanted read.
              </p>
            </div>
          </figure>

          {/* AFTER — a photograph of the live Sendset those rows became. */}
          <figure className="m-0 flex min-w-0 flex-col">
            <figcaption className="mb-2 text-sm font-medium text-foreground">
              The same rows, as a Sendset
            </figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/marketing/workout-after.webp"
              srcSet="/marketing/workout-after@1x.webp 390w, /marketing/workout-after.webp 700w"
              sizes="(min-width: 640px) 350px, 100vw"
              width={350}
              height={704}
              alt="The first exercise as a Sendset on a phone: a photograph of the movement, the exercise name, a one-line coaching cue, a table of sets, reps, rest and starting weight, and a highlighted note from the trainer."
              className="block w-full rounded-xl border border-border"
            />
          </figure>
        </div>
        <P className="mt-6">
          Same four exercises, same sets, same reps, same starting weights &mdash; this
          page reads both panels out of the same Sendset.{" "}
          <Link href="/p/month-one" target="_blank" rel="noopener" className="font-medium text-accent underline-offset-4 hover:underline">
            Open the whole month
          </Link>.
        </P>
      </Section>

      {/* ---- 4. How it works ---------------------------------------------- */}
      <Section title="Three steps">
        <ol className="space-y-6">
          <Step n={1} heading="Bring in what you have.">
            Paste your text, open a CSV, photograph the pages you were handed, or pull
            items from your Library. Pictures are transcribed into the same box, where you
            can correct the words before anything is organized. It doesn&rsquo;t need to
            be tidy.
          </Step>
          <Step n={2} heading="Read the draft, and change what needs changing.">
            It comes back organized into sections. Fix a price, drop an option, add a
            photo, write a personal note at the top. Anything Sendset has asked you to
            look at, you settle here. You see all of it before anyone else does.
          </Step>
          <Step n={3} heading="Send something people can actually use.">
            One link that opens into a clean, mobile-friendly Sendset. Text it, email it,
            or open it yourself while you&rsquo;re out.
          </Step>
        </ol>
        <P className="mt-6">
          <strong className="font-semibold text-foreground">You stay in the middle.</strong>{" "}
          Sendset works from the material you give it &mdash; your words, your source
          material &mdash; and organizes it into a draft. That draft opens in an editor,
          and nothing reaches anyone until you&rsquo;ve read it, corrected anything
          that&rsquo;s off, and decided it&rsquo;s right. When Sendset spots something
          that needs your attention, it asks you to review it before you send.
        </P>
      </Section>

      {/* ---- 5. The Library ------------------------------------------------ */}
      <Section title="Build it once. Use it again.">
        <P>
          The things you put into a Sendset don&rsquo;t have to disappear when you send it.
        </P>
        <P>
          Save a venue, a property, a vendor, a dish, an exercise &mdash; anything
          you&rsquo;ll reach for again &mdash; to your Library. Next time, pick what
          belongs and put it in order instead of rebuilding it.
        </P>
        <P>
          No perfect database required. The Library fills up as you work.
        </P>
      </Section>

      {/* ---- 6. Where it gets opened --------------------------------------- */}
      <Section title="Made for the phone in their hand.">
        <P>Useful information almost never gets opened at a desk.</P>
        <P>
          It&rsquo;s opened while touring a house. Walking a market. Standing outside a
          food truck. Looking for dinner near the hotel. Deciding something with family.
          Or trying to remember the next exercise.
        </P>
        <P>
          A Sendset is built for that moment &mdash; big enough to read, quick to scan,
          with the photo, the address and the details where a thumb can reach them.
        </P>
      </Section>

      {/* ---- 7. Delivery, in its place ------------------------------------- */}
      <Section title="One Sendset. Share it the way that suits.">
        <P className="!mt-0">
          A link is the simplest way, and a text is usually the best one &mdash; it opens
          right where they are. Sendset writes the message for you; you edit it and send
          it.
        </P>
        {/* THE SAME SENDSET, FOUR TIMES. This used to be a section of its own,
            with a second section arguing against rebuilding — two consecutive
            blocks on a capability that removes objections rather than creating
            desire. It is one picture and three sentences now. */}
        <picture>
          <source
            media="(min-width: 640px)"
            srcSet="/marketing/formats-wide@1x.webp 768w, /marketing/formats-wide.webp 1536w"
            sizes="768px"
            width={768}
            height={660}
          />
          <img
            src="/marketing/formats-narrow.webp"
            srcSet="/marketing/formats-narrow@1x.webp 342w, /marketing/formats-narrow.webp 684w"
            sizes="(min-width: 640px) 768px, 100vw"
            width={342}
            height={470}
            loading="lazy"
            alt="The same Sendset handed over four ways: the interactive link on a phone, a short message with the link ready to paste, the Sendset inside the body of an email, and the same Sendset printed on paper."
            className="mt-5 block w-full h-auto rounded-xl border border-border
                       aspect-[342/470] sm:aspect-[768/660] object-cover object-top"
          />
        </picture>
        <P className="mt-5">
          When email, print or PDF suits better, the same Sendset comes out in those too.
          Nothing to rebuild, and no second version in the world: update it, and the link
          you already sent shows the current one.
        </P>
      </Section>

      {/* ---- 8. What to do next -------------------------------------------- */}
      <section className="mt-20 rounded-2xl border border-border bg-surface px-7 py-10 sm:px-10">
        <h2 className="text-2xl font-bold tracking-tight text-foreground text-balance">
          Start with one you really have to send.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-muted max-w-xl">
          The fastest way to judge it is to build one &mdash; the Sendset you&rsquo;d
          otherwise assemble by hand this week.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href="/login"
            className="inline-flex items-center rounded-lg bg-accent px-6 py-3 text-base font-medium text-white transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
          >
            Start your first Sendset
          </Link>
          <Link href="/p/harbor-house" className="text-base font-medium text-accent underline-offset-4 hover:underline">
            Or look at a finished one first
          </Link>
        </div>
        {/* The honest substitute for social proof we do not have. */}
        <p className="mt-8 border-t border-border pt-6 text-base leading-relaxed text-muted max-w-xl">
          Sendset is new, and built by one person. If you try it and something
          doesn&rsquo;t fit how you work, I&rsquo;d genuinely like to hear it.
        </p>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-12 mt-12 first-of-type:mt-0">
      <h2 className="text-2xl font-bold tracking-tight text-foreground text-balance">
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-lg leading-relaxed text-muted max-w-2xl ${className} [&:not(:first-child)]:mt-4`}>
      {children}
    </p>
  );
}

function Step({ n, heading, children }: { n: number; heading: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      {/* The steps are a real sequence, so they are numbered. */}
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface border border-border text-sm font-semibold tabular-nums text-foreground">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold text-foreground">{heading}</p>
        <p className="mt-1 text-lg leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}
