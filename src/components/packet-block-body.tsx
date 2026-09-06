import type { PacketBlock } from "@/lib/types";
import { ItemCard } from "./item-card";

// Production renderer for a block-mode packet's ordered body. It renders the
// flat block sequence in order — Heading, Subheading, Label, and Item — reusing
// ItemCard for item content. Headings/subheadings/labels own only their own
// text; item blocks reference assembled item content. This is the single
// block-body renderer shared by the recipient page and the persisted-block
// preview, so what the founder reviews and what recipients see cannot drift.
//
// Heading/subheading text styling mirrors the legacy SectionGroup header so a
// converted packet reads identically to its legacy form.
function renderBlock(b: PacketBlock, audience: "recipient" | "professional") {
  if (b.kind === "item") {
    return (
      <div key={b.id} className="sg-item px-[var(--sg-page-gutter)] mb-[var(--sg-item-gap)]">
        <ItemCard item={b.item} audience={audience} />
      </div>
    );
  }
  if (b.kind === "label") {
    return (
      <div key={b.id} className="px-[var(--sg-page-gutter)] mt-4 mb-2">
        {b.text && (
          <p
            className="text-xs uppercase"
            style={{
              color: "var(--sg-accent)",
              fontWeight: "var(--sg-eyebrow-weight)",
              letterSpacing: "var(--sg-eyebrow-tracking)",
            }}
          >
            {b.text}
          </p>
        )}
      </div>
    );
  }
  if (b.kind === "subheading") {
    return (
      <div key={b.id} className="px-[var(--sg-page-gutter)] mt-5 mb-2.5">
        {b.text && (
          <h3
            className="font-semibold"
            style={{ fontFamily: "var(--sg-font-display)", fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)", color: "var(--sg-ink)" }}
          >
            {b.text}
          </h3>
        )}
        {b.subtext && (
          <p
            className="mt-0.5 leading-relaxed"
            style={{ fontSize: "var(--sg-small)", color: "var(--sg-subtle)" }}
          >
            {b.subtext}
          </p>
        )}
      </div>
    );
  }
  // heading
  return (
    <div key={b.id} className="px-[var(--sg-page-gutter)] mt-7 mb-4 first:mt-2">
      {b.text && (
        <h2
          style={{
            fontFamily: "var(--sg-font-display)",
            fontSize: "var(--sg-section-title)",
            lineHeight: "var(--sg-section-title-lh)",
            fontWeight: "var(--sg-title-weight)",
            letterSpacing: "var(--sg-title-tracking)",
            color: "var(--sg-ink)",
          }}
        >
          {b.text}
        </h2>
      )}
      {b.subtext && (
        <p
          className="mt-1 leading-relaxed whitespace-pre-line"
          style={{ fontSize: "var(--sg-body)", color: "var(--sg-label)" }}
        >
          {b.subtext}
        </p>
      )}
    </div>
  );
}

export function PacketBlockBody({
  blocks,
  audience = "recipient",
}: {
  blocks: PacketBlock[];
  /** Defaults to "recipient" so a caller that forgets stays safe — the same
   *  fail-safe default that kept the private note hidden here before. */
  audience?: "recipient" | "professional";
}) {
  return <>{blocks.map((b) => renderBlock(b, audience))}</>;
}
