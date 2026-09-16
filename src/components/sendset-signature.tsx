/** The quiet mark at the bottom of a Sendset a client is reading.
 *
 *  ONE COMPONENT, because there were two copies of this line — the recipient
 *  page and the professional's preview of it — written out separately and kept
 *  in step by hand. A preview that signs off differently from the page it is
 *  previewing is a preview that lies about the thing being sent.
 *
 *  SECONDARY, DELIBERATELY. This sits under the professional's own footer, and
 *  the client came for their advisor's work, not for ours. So: no button, no
 *  "create your own", no wordmark — the icon at the size of a line of text, and
 *  four words. What changed is that it is no longer INVISIBLE: it used to be
 *  `faint`, which on the default treatment is grey at 40% opacity and reads as
 *  an artefact rather than a signature. `subtle` is the next token up and the
 *  one the rest of the page uses for supporting text.
 *
 *  A NEW TAB, against the usual preference for staying put. Every external link
 *  in a recipient view already opens in one — the professional's website, their
 *  social links, an item's link — and a client halfway through reading a
 *  shortlist should not lose it to a marketing page they tapped by accident.
 *
 *  The icon is `alt=""` on purpose: the link's own words name the destination,
 *  so describing the mark as well would make a screen reader say Sendset twice.
 *  Nothing here is icon-only. */
export function SendsetSignature({ className = "" }: { className?: string }) {
  return (
    <div className={`mt-6 flex justify-center ${className}`}>
      <a
        href="https://sendset.io"
        target="_blank"
        rel="noopener noreferrer"
        className="text-meta inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-1.5 py-1
                   underline-offset-4 transition-colors hover:underline
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        style={{ color: "var(--sg-subtle)" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/sendset-icon.svg" alt="" width={15} height={15} className="h-[15px] w-[15px]" />
        Made with Sendset
      </a>
    </div>
  );
}
