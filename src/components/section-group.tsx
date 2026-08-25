import { Section } from "@/lib/types";
import { ItemCard } from "./item-card";
import { SectionContents } from "./section-contents";

export function SectionGroup({
  section,
  showQuickNav = true,
}: {
  section: Section;
  /** Packet-level presentation preference (migration 0030). Defaults to true so
   *  every existing caller and every existing packet behaves as before. */
  showQuickNav?: boolean;
}) {
  return (
    <section className="mb-8">
      {(section.title || section.description) && (
        <div className="px-5 mb-4">
          {section.title && (
            <h2 className="text-xl font-bold text-foreground">{section.title}</h2>
          )}
          {section.description && (
            <p className="mt-1 text-base text-gray-600 leading-relaxed">
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

      <div className="px-5 space-y-4">
        {section.items.map((item) => (
          // The anchor lives on a wrapper so ItemCard itself is untouched.
          // scroll-mt keeps the card's top edge off the very top of the
          // viewport after a jump.
          <div key={item.id} id={`item-${item.id}`} className="scroll-mt-4">
            <ItemCard item={item} />
          </div>
        ))}
      </div>
    </section>
  );
}
