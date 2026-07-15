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

// ============================================================
// Phase-0.1 ordered-block composition prototype (disposable, in-memory only).
//
// A packet's sections+items are flattened into ONE ordered list of blocks:
//   heading | subheading | item | item | heading | item ...
// Headings are visual only — they do NOT own the items after them. Deleting a
// heading removes just that heading; items stay exactly where they are. Two
// heading roles give visual hierarchy (major Heading vs Subheading/Label).
// All state is local React state; nothing is ever written back.
// ============================================================

type HeadingRole = "heading" | "subheading";
type Block =
  | { blockId: string; kind: "heading"; role: HeadingRole; title: string; subtext: string }
  | { blockId: string; kind: "item"; item: Item };

function deriveBlocks(sections: Section[]): Block[] {
  const out: Block[] = [];
  for (const s of sections) {
    // Existing sections are top-level, so they derive as major Headings.
    out.push({ blockId: `h-${s.id}`, kind: "heading", role: "heading", title: s.title || "", subtext: s.description || "" });
    for (const it of s.items) out.push({ blockId: `i-${it.id}`, kind: "item", item: it });
  }
  return out;
}

const dragDots = (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <circle cx="7" cy="4" r="1.5" /><circle cx="13" cy="4" r="1.5" />
    <circle cx="7" cy="10" r="1.5" /><circle cx="13" cy="10" r="1.5" />
    <circle cx="7" cy="16" r="1.5" /><circle cx="13" cy="16" r="1.5" />
  </svg>
);
const chevron = (dir: "up" | "down") => (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d={dir === "up" ? "M5 12l5-5 5 5" : "M5 8l5 5 5-5"} />
  </svg>
);

// Left gutter: move up / drag handle / move down. Up is disabled on the first
// block, down on the last.
function BlockControls({
  attributes, listeners, isFirst, isLast, onUp, onDown,
}: {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  isFirst: boolean;
  isLast: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 pt-1.5 flex-shrink-0">
      <button
        type="button"
        onClick={onUp}
        disabled={isFirst}
        aria-label="Move up"
        className="text-gray-400 hover:text-accent disabled:opacity-20 disabled:hover:text-gray-400 p-0.5"
      >
        {chevron("up")}
      </button>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        className="text-gray-400 hover:text-gray-700 cursor-grab active:cursor-grabbing touch-none p-0.5"
      >
        {dragDots}
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={isLast}
        aria-label="Move down"
        className="text-gray-400 hover:text-accent disabled:opacity-20 disabled:hover:text-gray-400 p-0.5"
      >
        {chevron("down")}
      </button>
    </div>
  );
}

function SortableBlock({
  block, isFirst, isLast, onEditHeading, onSetRole, onDeleteHeading, onUp, onDown,
}: {
  block: Block;
  isFirst: boolean;
  isLast: boolean;
  onEditHeading: (blockId: string, field: "title" | "subtext", value: string) => void;
  onSetRole: (blockId: string, role: HeadingRole) => void;
  onDeleteHeading: (blockId: string) => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.blockId });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const isSub = block.kind === "heading" && block.role === "subheading";

  return (
    <div ref={setNodeRef} style={style} className={`flex items-start gap-2 ${isSub ? "pl-6" : ""}`}>
      <BlockControls attributes={attributes} listeners={listeners} isFirst={isFirst} isLast={isLast} onUp={onUp} onDown={onDown} />

      <div className="flex-1 min-w-0">
        {block.kind === "heading" ? (
          <div className={isSub
            ? "rounded-lg border border-accent/30 bg-white px-3 py-2"
            : "rounded-xl border-2 border-accent/40 bg-accent/5 px-3 py-2.5"}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              {/* Role toggle: Heading | Subheading */}
              <div className="inline-flex rounded-md border border-border overflow-hidden text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => onSetRole(block.blockId, "heading")}
                  className={`px-2 py-0.5 ${!isSub ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
                >
                  Heading
                </button>
                <button
                  type="button"
                  onClick={() => onSetRole(block.blockId, "subheading")}
                  className={`px-2 py-0.5 ${isSub ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
                >
                  Subheading
                </button>
              </div>
              <button
                type="button"
                onClick={() => onDeleteHeading(block.blockId)}
                className="text-[11px] font-medium text-red-500 hover:text-red-700"
              >
                Delete
              </button>
            </div>
            <input
              value={block.title}
              onChange={(e) => onEditHeading(block.blockId, "title", e.target.value)}
              placeholder={isSub ? "Subheading or label" : "Heading title"}
              className={isSub
                ? "w-full bg-transparent text-sm font-semibold uppercase tracking-wide text-foreground/80 focus:outline-none placeholder:text-gray-300 placeholder:normal-case placeholder:font-normal"
                : "w-full bg-transparent text-lg font-bold text-foreground focus:outline-none placeholder:text-gray-300"}
            />
            <input
              value={block.subtext}
              onChange={(e) => onEditHeading(block.blockId, "subtext", e.target.value)}
              placeholder="Optional subtext"
              className="w-full bg-transparent text-sm text-gray-600 focus:outline-none placeholder:text-gray-300"
            />
          </div>
        ) : (
          <ItemCard item={block.item} />
        )}
      </div>
    </div>
  );
}

// Clearly-visible insert control shown in every gap.
function AddHeadingBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full my-2 py-1.5 rounded-lg border border-dashed border-accent/50 text-accent text-xs font-semibold hover:bg-accent hover:text-white hover:border-accent transition-colors"
    >
      + Add heading
    </button>
  );
}

// Recipient-style preview: renders blocks in order, distinguishing a major
// Heading from a Subheading/Label, with each heading introducing the items that
// follow it until the next heading.
function RecipientPreview({ blocks }: { blocks: Block[] }) {
  if (blocks.length === 0) return <p className="text-center text-sm text-muted py-8">Nothing to preview.</p>;
  return (
    <div className="py-2">
      {blocks.map((b) => {
        if (b.kind === "item") {
          return (
            <div key={b.blockId} className="px-5 mb-4">
              <ItemCard item={b.item} />
            </div>
          );
        }
        if (b.role === "subheading") {
          return (
            <div key={b.blockId} className="px-5 mt-5 mb-3">
              {b.title && (
                <p className="text-xs font-semibold uppercase tracking-widest text-accent">{b.title}</p>
              )}
              {b.subtext && <p className="mt-0.5 text-sm text-gray-500">{b.subtext}</p>}
            </div>
          );
        }
        return (
          <div key={b.blockId} className="px-5 mt-7 mb-4 first:mt-2">
            {b.title && <h2 className="text-xl font-bold text-foreground">{b.title}</h2>}
            {b.subtext && <p className="mt-1 text-base text-gray-600 leading-relaxed">{b.subtext}</p>}
          </div>
        );
      })}
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

  function moveByOne(index: number, delta: number) {
    setBlocks((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      return arrayMove(prev, index, to);
    });
  }

  function editHeading(blockId: string, field: "title" | "subtext", value: string) {
    setBlocks((prev) =>
      prev.map((b) => (b.blockId === blockId && b.kind === "heading" ? { ...b, [field]: value } : b))
    );
  }

  function setRole(blockId: string, role: HeadingRole) {
    setBlocks((prev) =>
      prev.map((b) => (b.blockId === blockId && b.kind === "heading" ? { ...b, role } : b))
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
      next.splice(index, 0, { blockId, kind: "heading", role: "heading", title: "New heading", subtext: "" });
      return next;
    });
  }

  function reset() {
    newCounter.current = 0;
    setBlocks(deriveBlocks(sections));
  }

  const headingCount = blocks.filter((b) => b.kind === "heading").length;
  const itemCount = blocks.filter((b) => b.kind === "item").length;

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-20 bg-amber-500 text-white text-center text-sm font-semibold px-4 py-2 shadow">
        Prototype — changes are local and will not be saved
      </div>

      <div className="max-w-lg mx-auto px-5 pb-24">
        <header className="pt-6 pb-4">
          <p className="text-xs uppercase tracking-widest text-muted mb-1">Ordered-block composition prototype</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight whitespace-pre-line">{packetTitle || "Untitled Packet"}</h1>
          <p className="mt-2 text-xs text-muted">
            {headingCount} heading{headingCount === 1 ? "" : "s"} · {itemCount} item{itemCount === 1 ? "" : "s"} · headings
            are visual only and do not own the items after them
          </p>
        </header>

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
            <AddHeadingBar onClick={() => insertHeadingAt(0)} />
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={blocks.map((b) => b.blockId)} strategy={verticalListSortingStrategy}>
                {blocks.map((block, i) => (
                  <div key={block.blockId}>
                    <SortableBlock
                      block={block}
                      isFirst={i === 0}
                      isLast={i === blocks.length - 1}
                      onEditHeading={editHeading}
                      onSetRole={setRole}
                      onDeleteHeading={deleteHeading}
                      onUp={() => moveByOne(i, -1)}
                      onDown={() => moveByOne(i, 1)}
                    />
                    <AddHeadingBar onClick={() => insertHeadingAt(i + 1)} />
                  </div>
                ))}
              </SortableContext>
            </DndContext>
            {blocks.length === 0 && (
              <p className="text-center text-sm text-muted py-8">No blocks. This packet had no sections or items.</p>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-border overflow-hidden bg-white">
            <div className="text-center text-[11px] uppercase tracking-widest text-muted py-2 border-b border-border">
              Recipient preview (local order)
            </div>
            <RecipientPreview blocks={blocks} />
          </div>
        )}
      </div>
    </div>
  );
}
