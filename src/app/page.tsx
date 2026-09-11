import Link from "next/link";

// THE PUBLIC FRONT DOOR.
//
// Replaces a developer index — a wordmark and three raw links — that told a
// visiting professional nothing about what this is or who it is for.
//
// It uses the APPLICATION'S OWN tokens (accent, foreground, muted, border,
// surface) rather than a marketing palette, because the page has to feel like
// the same object as the product it is selling. There is no illustration
// system, no icon set, no stock photography and no animation: the product's
// whole argument is that a well-made thing respects its reader, and a busy
// page would contradict that on sight.
//
// THE TWO IMAGES ARE PHOTOGRAPHS OF THE PRODUCT, and nothing else is. Both are
// captured from the demo Sendset by scripts/marketing/capture.mjs — the same
// recipient page, print route and email renderer a professional would get —
// so the page shows evidence rather than making an assertion. A screenshot can
// go stale, which is why regenerating it is one command rather than a design
// file. They replace prose: the four-format section used to describe in four
// paragraphs what one picture shows.
//
// The primary action is the DEMO, not signup. For a professional weighing a
// peer's product, opening a finished Sendset explains more in ten seconds than
// the page can in five hundred words — and it is the one path with no form, no
// account and no way to lose work.
//
// VOCABULARY: the finished object is a SENDSET, publicly and in the product.
// It used to be "a guide" here — a public substitute chosen when the only other
// word was "packet", before the object had a name of its own. With the app
// saying "My Sendsets" and "this Sendset" on every screen, a visitor met one
// word outside and another inside. `packet` is still the internal name in the
// schema, the API and the docs, and never appears here.
//
// THE OBJECT IS NAMED BY THE CTAs, not by the subhead. "Sendset helps you shape
// it into a Sendset" is the tautology the /new copy already had to learn its
// way out of, so the subhead names the product and "See a real Sendset" names
// the object one line below it. Section 3 then defines it outright.
//
// WHAT THE PAGE MAY CLAIM AS INPUT is what /new actually accepts: pasted text,
// a .csv/.txt/.md file, and photographed pages. Not PDFs and not Word — both
// are refused by name ("can't read PDFs yet"), and this page used to imply
// otherwise. PDF belongs on the OUTPUT side only.

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 pb-24">
      {/* ---- 1. What it is ------------------------------------------------ */}
      <header className="pt-20 pb-16 sm:pt-28">
        {/* ONE COLUMN ON A PHONE, so the two actions are still the first thing
            under the sentence that earns them; the artifact follows. On a wider
            screen the same two things sit beside each other and the first
            screen carries the claim, the actions and the product at once. */}
        <div className="sm:grid sm:grid-cols-[1fr_17rem] sm:gap-10 sm:items-start">
          <div>
            <p className="text-sm font-semibold tracking-[0.14em] uppercase text-muted">
              Sendset
            </p>
            <h1 className="mt-5 text-[2.1rem] leading-[1.12] sm:text-[2.6rem] font-bold tracking-tight text-foreground text-balance">
              Start with what you have. Send something people can actually use.
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted max-w-2xl">
              You&rsquo;ve already done the work. Pasted text, spreadsheet rows,
              photographs of the pages you were handed &mdash; Sendset helps you shape it
              into one clear, organized thing to hand over. You check it before anyone
              else sees it, then send it by link, email, message, print, or PDF.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link
                href="/p/demo"
                className="inline-flex items-center rounded-lg bg-accent px-6 py-3 text-base font-medium text-white transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
              >
                See a real Sendset
              </Link>
              <Link
                href="/login"
                className="text-base font-medium text-accent underline-offset-4 hover:underline"
              >
                Start your first Sendset
              </Link>
            </div>
          </div>

          {/* One option out of a real Sendset, exactly as it is received.
              Height-capped from the top on wide screens so the hero does not
              become a column of screenshot; the crop is the same artifact. */}
          <div className="mt-10 sm:mt-1 mx-auto w-full max-w-[19rem] sm:max-w-none
                          overflow-hidden rounded-xl border border-border
                          sm:h-[27rem]">
            {/* A fixed, pre-sized static marketing asset: two hand-exported
                WebP files served straight from public/ with srcSet and sizes,
                deliberately NOT run through Vercel image optimization — there
                is nothing to size or re-encode at request time, and the
                optimizer would add per-image cost for the same bytes. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/marketing/hero.webp"
              srcSet="/marketing/hero@1x.webp 350w, /marketing/hero.webp 700w"
              sizes="(min-width: 640px) 272px, 304px"
              width={700}
              height={1508}
              alt="A Sendset on a phone: a photograph of a venue, its name and address, a short description, and a table showing capacity, day rate and catering."
              className="block w-full h-auto sm:h-full sm:object-cover sm:object-top"
            />
          </div>
        </div>
      </header>

      {/* ---- 2. Why it exists --------------------------------------------- */}
      <Section title="The information isn’t missing. It’s scattered.">
        <P>
          By the time you&rsquo;re ready to send it, you already have everything they
          need. It&rsquo;s just spread across nine browser tabs, a spreadsheet, three
          email threads, photos on your phone, a printout someone handed you, and notes
          only you can read.
        </P>
        <P>
          So you assemble it by hand. An email with links. A document. A few
          screenshots. A follow-up message with the one thing you forgot.
        </P>
        <P>
          What arrives is a pile &mdash; and they have to do the assembly themselves,
          usually on a phone, usually while making a decision that matters to them.
        </P>
        <P>
          Sendset exists to close that last gap. Not to do the work for you &mdash; to
          help what you&rsquo;ve already done arrive as one clear thing you can hand over.
        </P>
      </Section>

      {/* ---- 3. In and out ------------------------------------------------ */}
      <Section title="What goes in, and what comes out">
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel label="In">
            Notes and pasted text, a spreadsheet saved as CSV, photographs of the pages
            you were handed. Sendset helps organize it into a draft.
          </Panel>
          <Panel label="Out">
            A Sendset: one clear, organized version of what you&rsquo;re sending, laid
            out to be read on a phone &mdash; like the one above.
          </Panel>
        </div>
        <P className="mt-6">
          <strong className="font-semibold text-foreground">You stay in the middle.</strong>{" "}
          Sendset works from the material you give it &mdash; your words, your source
          material &mdash; and organizes it into a draft. That draft opens in an editor,
          and nothing reaches anyone until you&rsquo;ve read it, corrected anything
          that&rsquo;s off, and decided it&rsquo;s right. When Sendset spots something
          that needs your attention, it asks you to review it before you send.
        </P>
      </Section>

      {/* ---- 4. How it works ---------------------------------------------- */}
      <Section title="Three steps">
        <ol className="space-y-6">
          <Step n={1} heading="Bring in what you have.">
            Paste your text, open a CSV, or photograph the pages you were handed.
            Pictures are transcribed into the same box, where you can correct the words
            before anything is organized. It doesn&rsquo;t need to be tidy.
          </Step>
          <Step n={2} heading="Read the draft, and change what needs changing.">
            It comes back organized into sections. Fix a price, drop an option, add a
            photo, write a personal note at the top. Anything Sendset has asked you to
            look at, you settle here. You see all of it before anyone else does.
          </Step>
          <Step n={3} heading="Send it the way that person prefers.">
            One Sendset, several formats &mdash; chosen when you send, not when you build.
          </Step>
        </ol>
      </Section>

      {/* ---- 5. The four formats ------------------------------------------ */}
      <Section title="One Sendset. Four ways to hand it over.">
        {/* THE SAME SENDSET, FOUR TIMES. This used to be four paragraphs saying
            what each format looks like; the picture says it, and says the part
            prose could not — that they are one object, not four documents.
            Two layouts because one composition cannot be legible at both 342px
            and 768px, and the aspect ratio is pinned at each width so nothing
            moves while the image loads. */}
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
            alt="The same Sendset handed over four ways: the interactive link on a phone, a short message with the link ready to paste, the Sendset inside the body of an email, and the same Sendset printed on paper."
            className="block w-full h-auto rounded-xl border border-border
                       aspect-[342/470] sm:aspect-[768/660] object-cover object-top"
          />
        </picture>
        <P className="mt-6">
          You build it once. Which one goes out is a decision you make when you send it
          &mdash; and whichever they open, it&rsquo;s the same Sendset.
        </P>
      </Section>

      {/* ---- 6. Versus rebuilding ------------------------------------------ */}
      <Section title="Build it once, not once per format.">
        <P>
          Sharing the same information several ways usually means rebuilding or
          reformatting it for each one. And the moment something changes&mdash;a price,
          a date, one option dropping out&mdash;you can end up with multiple versions in
          the world and no easy way to know which one they are looking at.
        </P>
        <P>
          A Sendset is one thing. Update it, and the link you already sent shows the
          current version. Nothing to resend, nothing to correct.
        </P>
      </Section>

      {/* ---- 7. Who it's for ----------------------------------------------- */}
      <Section title="For people who have to explain what they’ve put together">
        <P>
          Consultants, planners, advisors, coaches, agents, relocation professionals.
          Small businesses sending their own options, prices or schedules. Anyone who has
          to put information in front of someone else and make it easy to take in
          &mdash; whether you gathered it on their behalf or it was yours to begin with.
        </P>
        <P>
          If your work ends with <em>&ldquo;here&rsquo;s what I put together, and
          here&rsquo;s what I&rsquo;d do&rdquo;</em>, Sendset is for that handover.
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
          <Link
            href="/p/demo"
            className="text-base font-medium text-accent underline-offset-4 hover:underline"
          >
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

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-2 text-base leading-relaxed text-foreground">{children}</p>
    </div>
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
