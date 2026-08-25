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
// The primary action is the DEMO, not signup. For a professional weighing a
// peer's product, opening a finished FlowGuide explains more in ten seconds
// than the page can in five hundred words — and it is the one path with no
// form, no account and no way to lose work.
//
// Vocabulary: "guide", never "packet". `packet` remains the internal name in
// the schema, the API and the docs; it is not what a professional calls this.

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 pb-24">
      {/* ---- 1. What it is ------------------------------------------------ */}
      <header className="pt-20 pb-16 sm:pt-28">
        <p className="text-sm font-semibold tracking-[0.14em] uppercase text-muted">
          FlowGuide
        </p>
        <h1 className="mt-5 text-[2.1rem] leading-[1.12] sm:text-[2.85rem] font-bold tracking-tight text-foreground text-balance">
          Everything you found, in one thing your client can actually use.
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-muted max-w-2xl">
          You&rsquo;ve already done the work. FlowGuide turns your notes into a clear,
          client-ready guide &mdash; then lets you share it by link, email, message,
          print, or PDF without rebuilding it for every format.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href="/p/demo"
            className="inline-flex items-center rounded-lg bg-accent px-6 py-3 text-base font-medium text-white transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
          >
            See a real FlowGuide
          </Link>
          <Link
            href="/login"
            className="text-base font-medium text-accent underline-offset-4 hover:underline"
          >
            Start your first FlowGuide
          </Link>
        </div>
      </header>

      {/* ---- 2. Why it exists --------------------------------------------- */}
      <Section title="The information isn’t missing. It’s scattered.">
        <P>
          By the time you&rsquo;re ready to advise a client, you already have what they
          need. It&rsquo;s just spread across nine browser tabs, a spreadsheet, three
          email threads, photos on your phone, a PDF someone sent you, and notes only
          you can read.
        </P>
        <P>
          So you assemble it by hand. An email with links. A document. A few
          screenshots. A follow-up message with the one thing you forgot.
        </P>
        <P>
          What arrives is a pile &mdash; and your client has to do the assembly
          themselves, usually on a phone, usually while making a decision that matters
          to them.
        </P>
        <P>
          FlowGuide exists to close that last gap. Not to do your research; to turn the
          research you&rsquo;ve already done into one clear thing you can hand over.
        </P>
      </Section>

      {/* ---- 3. In and out ------------------------------------------------ */}
      <Section title="What goes in, and what comes out">
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel label="In">
            Whatever you already have. A pasted list, an email you sent yourself, a
            column from a spreadsheet, bullet points with links and half-finished
            sentences. Mess is fine &mdash; mess is the normal case.
          </Panel>
          <Panel label="Out">
            A structured guide. Organised into sections, with photos, details, links
            and contacts, laid out to be read on a phone.
          </Panel>
        </div>
        <P className="mt-6">
          <strong className="font-semibold text-foreground">You stay in the middle.</strong>{" "}
          FlowGuide works from the material you give it &mdash; your words, your
          findings &mdash; and organises it into a draft. That draft opens in an editor,
          and nothing reaches your client until you&rsquo;ve read it, corrected anything
          that&rsquo;s off, and decided it&rsquo;s right.
        </P>
      </Section>

      {/* ---- 4. How it works ---------------------------------------------- */}
      <Section title="Three steps">
        <ol className="space-y-6">
          <Step n={1} heading="Paste what you have.">
            However rough. FlowGuide reads it and pulls out the options, the details,
            the links.
          </Step>
          <Step n={2} heading="Review and edit.">
            It comes back organised into sections. Change anything &mdash; fix a price,
            add a photo, write a note to your client at the top. You see it before they
            do.
          </Step>
          <Step n={3} heading="Send it the way that client prefers.">
            One guide, several formats, chosen when you send rather than when you build.
          </Step>
        </ol>
      </Section>

      {/* ---- 5. The four formats ------------------------------------------ */}
      <Section title="One guide. Four ways to hand it over.">
        <div className="divide-y divide-border border-y border-border">
          <Format name="The link">
            The interactive version, and the best one. Opens on a phone, photos you can
            swipe through, details laid out, tap to call. This is what you&rsquo;re
            sharing when you send a link.
          </Format>
          <Format name="A short message">
            A few sentences wrapping that link, ready to paste into a text or an email.
            Edit it however you like.
          </Format>
          <Format name="An email version">
            The full content inside the body of the email, for a client who&rsquo;d
            rather just read it there.
          </Format>
          <Format name="Print or PDF">
            The same guide on paper, for a client who wants to hold it or pass it
            around.
          </Format>
        </div>
        <P className="mt-6">
          You build it once. Which format goes out is a decision you make when you send
          it, not when you build it.
        </P>
      </Section>

      {/* ---- 6. Versus rebuilding ------------------------------------------ */}
      <Section title="Build it once, not once per format.">
        <P>
          Sharing the same information several ways usually means rebuilding or
          reformatting it for each one. And the moment something changes&mdash;a price,
          a date, one option dropping out&mdash;you can end up with multiple versions in
          the world and no easy way to know which one your client is looking at.
        </P>
        <P>
          With FlowGuide there&rsquo;s one guide. Update it, and the link your client
          already has shows the current version. Nothing to resend, nothing to correct.
        </P>
      </Section>

      {/* ---- 7. Who it's for ----------------------------------------------- */}
      <Section title="For professionals who hand over what they’ve found">
        <P>
          Consultants, planners, advisors, agents, coaches, relocation professionals
          &mdash; anyone who researches options on someone else&rsquo;s behalf and then
          has to explain them clearly.
        </P>
        <P>
          If your work ends with <em>&ldquo;here&rsquo;s what I found, and here&rsquo;s
          what I&rsquo;d do&rdquo;</em>, FlowGuide is for that handover.
        </P>
      </Section>

      {/* ---- 8. What to do next -------------------------------------------- */}
      <section className="mt-20 rounded-2xl border border-border bg-surface px-7 py-10 sm:px-10">
        <h2 className="text-2xl font-bold tracking-tight text-foreground text-balance">
          Start with one real client.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-muted max-w-xl">
          The fastest way to judge it is to build one &mdash; the guide you&rsquo;d
          otherwise assemble by hand this week.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href="/login"
            className="inline-flex items-center rounded-lg bg-accent px-6 py-3 text-base font-medium text-white transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
          >
            Start your first FlowGuide
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
          FlowGuide is new, and built by one person. If you try it and something
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

function Format({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-5 sm:grid-cols-[11rem_1fr] sm:gap-6">
      <p className="text-base font-semibold text-foreground">{name}</p>
      <p className="text-lg leading-relaxed text-muted">{children}</p>
    </div>
  );
}
