"use client";

import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Item, Section } from "@/lib/types";
import { ItemCard } from "@/components/item-card";
import { SectionGroup } from "@/components/section-group";

// ============================================================
// Phase-0 ordered-block composition prototype (disposable, in-memory only).
//
// A packet's sections+items are flattened into ONE ordered list of blocks:
//   heading block | item block | item block | heading block | item block ...
// Headings are visual only — they do NOT own the items after them. Deleting a
// heading removes just that heading; items stay exactly where they are. All
// state is local React state; nothing is ever written back.
// ============================================================

type Block =
  | { blockId: string; kind: "heading"; title: string; subtext: string }
  | { blockId: string; kind: "item"; item: Item };

function deriveBlocks(sections: Section[]): Block[] {
  const out: Block[] = [];
  for (const s of sections) {
    out.push({ blockId: `h-${s.id}`, kind: "heading", title: s.title || "", subtext: s.description || "" });
    for (const it of s.items) out.push({ blockId: `i-${it.id}`, kind: "item", item: it });
  }
  return out;
}

// Group the flat block order into runs for a recipient-style preview: a heading
// introduces every item after it until the next heading. Items before the first
// heading form a leading, header-less group.
function groupForPreview(blocks: Block[]): Section[] {
  const groups: Section[] = [];
  let current: Section | null = null;
  for (const b of blocks) {
    if (b.kind === "heading") {
      current = { id: b.blockId, title: b.title, description: b.subtext, items: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { id: "lead", title: "", description: "", items: [] };
        groups.push(current);
      }
      current.items.push(b.item);
    }
  }
  return groups;
}

const handleDots = (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <circle cx="7" cy="4" r="1.5" /><circle cx="13" cy="4" r="1.5" />
    <circle cx="7" cy="10" r="1.5" /><circle cx="13" cy="10" r="1.5" />
    <circle cx="7" cy="16" r="1.5" /><circle cx="13" cy="16" r="1.5" />
  </svg>
);

function SortableBlock({
  block,
  onEditHeading,
  onDeleteHeading,
}: {
  block: Block;
  onEditHeading: (blockId: string, field: "title" | "subtext", value: string) => void;
  onDeleteHeading: (blockId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.blockId });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  return (
    <div ref={setNodeRef} style={style} className="flex items-start gap-2">
      {/* Drag handle — only this starts a drag, so inputs/links stay usable */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        className="mt-2 text-gray-400 hover:text-gray-700 cursor-grab active:cursor-grabbing touch-none flex-shrink-0 p-1"
      >
        {handleDots}
      </button>

      <div className="flex-1 min-w-0">
        {block.kind === "heading" ? (
          <div className="rounded-xl border-2 border-accent/40 bg-accent/5 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-accent">Heading</span>
              <button
                type="button"
                onClick={() => onDeleteHeading(block.blockId)}
                className="text-[11px] font-medium text-red-500 hover:text-red-700"
              >
                Delete heading
              </button>
            </div>
            <input
              value={block.title}
              onChange={(e) => onEditHeading(block.blockId, "title", e.target.value)}
              placeholder="Heading title"
              className="w-full bg-transparent text-lg font-bold text-foreground focus:outline-none placeholder:text-gray-300"
            />
            <input
              value={block.subtext}
              onChange={(e) => onEditHeading(block.blockId, "subtext", e.target.value)}
              placeholder="Optional subtext"
              className="w-full bg-transparent text-sm text-gray-600 focus:outline-none placeholder:text-gray-300"
            />
          </div>
        ) : (
          <div className="rounded-xl">
            <ItemCard item={block.item} />
          </div>
        )}
      </div>
    </div>
  );
}

export function BlockPrototype({ packetTitle, sections }: { packetTitle: string; sections: Section[] }) {
  const original = useMemo(() => deriveBlocks(sections), [sections]);
  const [blocks, setBlocks] = useState<Block[]>(original);
  const [view, setView] = useState<"compose" | "preview">("compose");
  const newCounter = useRef(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setBlocks((prev) => {
      const from = prev.findIndex((b) => b.blockId === active.id);
      const to = prev.findIndex((b) => b.blockId === over.id);
      if (from === -1 || to === -1) return prev;
      return arrayMove(prev, from, to);
    });
  }

  function editHeading(blockId: string, field: "title" | "subtext", value: string) {
    setBlocks((prev) =>
      prev.map((b) => (b.blockId === blockId && b.kind === "heading" ? { ...b, [field]: value } : b))
    );
  }

  function deleteHeading(blockId: string) {
    // Remove ONLY the heading block. Every item block stays in place.
    setBlocks((prev) => prev.filter((b) => b.blockId !== blockId));
  }

  function insertHeadingAt(index: number) {
    const blockId = `h-new-${newCounter.current++}`;
    setBlocks((prev) => {
      const next = [...prev];
      next.splice(index, 0, { blockId, kind: "heading", title: "New heading", subtext: "" });
      return next;
    });
  }

  function reset() {
    newCounter.current = 0;
    setBlocks(deriveBlocks(sections));
  }

  const previewGroups = groupForPreview(blocks);
  const headingCount = blocks.filter((b) => b.kind === "heading").length;
  const itemCount = blocks.filter((b) => b.kind === "item").length;

  return (
    <div className="min-h-screen bg-background">
      {/* Prominent local-only notice */}
      <div className="sticky top-0 z-20 bg-amber-500 text-white text-center text-sm font-semibold px-4 py-2 shadow">
        Prototype — changes are local and will not be saved
      </div>

      <div className="max-w-lg mx-auto px-5 pb-24">
        <header className="pt-6 pb-4">
          <p className="text-xs uppercase tracking-widest text-muted mb-1">Ordered-block composition prototype</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight whitespace-pre-line">{packetTitle || "Untitled Packet"}</h1>
          <p className="mt-2 text-xs text-muted">
            {headingCount} heading{headingCount === 1 ? "" : "s"} · {itemCount} item{itemCount === 1 ? "" : "s"} ·
            headings are visual only and do not own the items after them
          </p>
        </header>

        {/* Controls */}
        <div className="flex items-center gap-2 mb-5">
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => setView("compose")}
              className={`px-3 py-1.5 text-sm font-medium ${view === "compose" ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
            >
              Compose
            </button>
            <button
              onClick={() => setView("preview")}
              className={`px-3 py-1.5 text-sm font-medium ${view === "preview" ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
            >
              Recipient preview
            </button>
          </div>
          <button
            onClick={reset}
            className="ml-auto px-3 py-1.5 text-sm font-medium text-muted hover:text-foreground border border-border rounded-lg"
          >
            Reset order
          </button>
        </div>

        {view === "compose" ? (
          <div>
            <InsertHeading onClick={() => insertHeadingAt(0)} />
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={blocks.map((b) => b.blockId)} strategy={verticalListSortingStrategy}>
                {blocks.map((block, i) => (
                  <div key={block.blockId}>
                    <SortableBlock block={block} onEditHeading={editHeading} onDeleteHeading={deleteHeading} />
                    <InsertHeading onClick={() => insertHeadingAt(i + 1)} />
                  </div>
                ))}
              </SortableContext>
            </DndContext>
            {blocks.length === 0 && (
              <p className="text-center text-sm text-muted py-8">
                No blocks. This packet had no sections or items.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-border overflow-hidden bg-white">
            <div className="text-center text-[11px] uppercase tracking-widest text-muted py-2 border-b border-border">
              Recipient preview (local order)
            </div>
            <div className="py-4">
              {previewGroups.length === 0 ? (
                <p className="text-center text-sm text-muted py-8">Nothing to preview.</p>
              ) : (
                previewGroups.map((g) => <SectionGroup key={g.id} section={g} />)
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// A thin "insert a heading here" affordance rendered in each gap between blocks.
function InsertHeading({ onClick }: { onClick: () => void }) {
  return (
    <div className="group h-5 flex items-center justify-center">
      <button
        onClick={onClick}
        className="opacity-40 hover:opacity-100 transition-opacity text-[11px] font-medium text-accent flex items-center gap-1"
      >
        <span className="inline-block w-6 h-px bg-accent/40" />+ Add heading here
        <span className="inline-block w-6 h-px bg-accent/40" />
      </button>
    </div>
  );
}
