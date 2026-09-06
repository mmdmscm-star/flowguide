import { Section } from "@/lib/types";
import { ItemCard } from "./item-card";
import { SectionContents } from "./section-contents";

export function SectionGroup({
  section,
  showQuickNav = true,
  audience = "recipient",
}: {
  section: Section;
  /** Packet-level presentation preference (migration 0030). Defaults to true so
   *  every existing caller and every existing packet behaves as before. */
  showQuickNav?: boolean;
  /** Who is looking. DEFAULTS TO "recipient" ON PURPOSE: a surface that forgets
   *  to declare itself gets the SAFE answer and the private note stays hidden.
   *  Only an explicitly professional surface passes "professional". */
  audience?: "recipient" | "professional";
}) {
  return (
    <section className="mb-[var(--sg-section-gap)]">
      {(section.title || section.description) && (
        // THE SECTION RULE is the treatment's, not this component's. A
        // treatment that announces a section with a hairline sets the border
        // and the space it needs; every other treatment resolves both to
        // nothing and the header sits exactly where it always did.
        <div
          className="px-[var(--sg-page-gutter)] mb-4"
          style={{
            borderTopWidth: "var(--sg-section-rule-width)",
            borderTopColor: "var(--sg-section-rule-color)",
            paddingTop: "var(--sg-section-rule-pad)",
          }}
        >
          {section.title && (
            <h2
              className="text-[length:var(--sg-section-title)] text-[color:var(--sg-ink)]"
              style={{
                fontFamily: "var(--sg-font-display)",
                fontWeight: "var(--sg-title-weight)",
                letterSpacing: "var(--sg-title-tracking)",
              }}
            >
              {section.title}
            </h2>
          )}
          {section.description && (
            <p
              className="mt-1 leading-relaxed whitespace-pre-line"
              style={{ fontSize: "var(--sg-body)", color: "var(--sg-label)" }}
            >
              {section.description}
            </p>
          )}
        </div>
      )}
      {/* Contents first, then the cards it points at.
          TWO RULES, TWO HOMES, deliberately. "A single item needs no index" is a
          fact about the content and stays inside SectionContents. "This
          professional turned it off" is a preference about the packet and is
          decided here. Merging them into one condition would force one place to
          explain both. */}
      {showQuickNav && <SectionContents items={section.items} sectionTitle={section.title} />}

      <div className="px-[var(--sg-page-gutter)] space-y-[var(--sg-item-gap)]">
        {section.items.map((item) => (
          // The anchor lives on a wrapper so ItemCard itself is untouched.
          // scroll-mt keeps the card's top edge off the very top of the
          // viewport after a jump.
          <div key={item.id} id={`item-${item.id}`} className="sg-item scroll-mt-4">
            <ItemCard item={item} audience={audience} />
          </div>
        ))}
      </div>
    </section>
  );
}
