import { Section } from "@/lib/types";
import { ItemCard } from "./item-card";

export function SectionGroup({ section }: { section: Section }) {
  return (
    <section className="mb-8">
      {(section.title || section.description) && (
        <div className="px-5 mb-4">
          {section.title && (
            <h2 className="text-lg font-bold text-foreground">{section.title}</h2>
          )}
          {section.description && (
            <p className="mt-1 text-sm text-muted leading-relaxed">
              {section.description}
            </p>
          )}
        </div>
      )}
      <div className="px-5 space-y-4">
        {section.items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
