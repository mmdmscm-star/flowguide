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
function renderBlock(b: PacketBlock) {
  if (b.kind === "item") {
    return (
      <div key={b.id} className="px-5 mb-4">
        <ItemCard item={b.item} />
      </div>
    );
  }
  if (b.kind === "label") {
    return (
      <div key={b.id} className="px-5 mt-4 mb-2">
        {b.text && (
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">{b.text}</p>
        )}
      </div>
    );
  }
  if (b.kind === "subheading") {
    return (
      <div key={b.id} className="px-5 mt-5 mb-2.5">
        {b.text && <h3 className="text-base font-semibold text-foreground">{b.text}</h3>}
        {b.subtext && <p className="mt-0.5 text-sm text-gray-500 leading-relaxed">{b.subtext}</p>}
      </div>
    );
  }
  // heading
  return (
    <div key={b.id} className="px-5 mt-7 mb-4 first:mt-2">
      {b.text && <h2 className="text-xl font-bold text-foreground">{b.text}</h2>}
      {b.subtext && <p className="mt-1 text-base text-gray-600 leading-relaxed">{b.subtext}</p>}
    </div>
  );
}

export function PacketBlockBody({ blocks }: { blocks: PacketBlock[] }) {
  return <>{blocks.map((b) => renderBlock(b))}</>;
}
