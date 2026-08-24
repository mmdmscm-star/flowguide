import { Section } from "@/lib/types";
import { ItemCard } from "./item-card";
import { SectionContents } from "./section-contents";

export function SectionGroup({ section }: { section: Section }) {
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
      {/* Contents first, then the cards it points at. Only for a section with
          more than one item - see SectionContents. */}
      <SectionContents items={section.items} sectionTitle={section.title} />

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
