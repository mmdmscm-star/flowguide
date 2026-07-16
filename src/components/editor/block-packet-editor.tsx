"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import type { Item, PacketBlock } from "@/lib/types";
import { ItemCard } from "@/components/item-card";

// ============================================================
// R2-A persistent block-composition editor.
//
// The flat ordered block list is authored here and persisted through the
// controlled RPCs (via /api/packets/[id]/blocks*). This slice supports:
//   * reorder (drag + up/down) across the WHOLE sequence, including item blocks;
//   * add / edit / delete HEADING-LIKE blocks (heading, subheading, label);
//   * item blocks reorder but are never deleted or edited here; item content is
//     never touched.
// Every mutation is optimistic with rollback: a failed save reverts the editor
// to the last persisted state and surfaces the error.
//
// Ports the validated Phase-0.2 prototype styling/behavior into production.
// ============================================================

type HeadingKind = "heading" | "subheading" | "label";

type EditorBlock =
  | { id: string; kind: HeadingKind; text: string; subtext: string }
  | { id: string; kind: "item"; item: Item };

function toEditorBlocks(blocks: PacketBlock[]): EditorBlock[] {
  return blocks.map((b) =>
    b.kind === "item"
      ? { id: b.id, kind: "item" as const, item: b.item }
      : { id: b.id, kind: b.kind, text: b.text, subtext: b.subtext ?? "" }
  );
}

const HEADING_ROLES: { role: HeadingKind; name: string; defaultText: string }[] = [
  { role: "heading", name: "Heading", defaultText: "New heading" },
  { role: "subheading", name: "Subheading", defaultText: "New subheading" },
  { role: "label", name: "Label", defaultText: "New label" },
];

// Per-role styling for a heading-like editor block (matches the prototype).
function composeStyle(role: HeadingKind) {
  switch (role) {
    case "heading":
      return { indent: "", box: "rounded-xl border-2 border-accent/40 bg-accent/5 px-3 py-2.5", input: "text-lg font-bold text-foreground", placeholder: "Heading", subtext: true };
    case "subheading":
      return { indent: "pl-6", box: "rounded-lg border border-border bg-white px-3 py-2", input: "text-base font-semibold text-foreground", placeholder: "Subheading", subtext: true };
    case "label":
      return { indent: "pl-10", box: "rounded-lg border border-dashed border-accent/40 bg-white px-3 py-1.5", input: "text-xs font-semibold uppercase tracking-wide text-accent", placeholder: "Label", subtext: false };
  }
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

function BlockControls({
  attributes, listeners, isFirst, isLast, disabled, onUp, onDown,
}: {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 pt-1.5 flex-shrink-0">
      <button type="button" onClick={onUp} disabled={isFirst || disabled} aria-label="Move up"
        className="text-gray-400 hover:text-accent disabled:opacity-20 disabled:hover:text-gray-400 p-0.5">
        {chevron("up")}
      </button>
      <button type="button" {...attributes} {...listeners} disabled={disabled} aria-label="Drag to reorder"
        className="text-gray-400 hover:text-gray-700 cursor-grab active:cursor-grabbing touch-none p-0.5 disabled:opacity-20 disabled:cursor-default">
        {dragDots}
      </button>
      <button type="button" onClick={onDown} disabled={isLast || disabled} aria-label="Move down"
        className="text-gray-400 hover:text-accent disabled:opacity-20 disabled:hover:text-gray-400 p-0.5">
        {chevron("down")}
      </button>
    </div>
  );
}

function SortableBlock({
  block, isFirst, isLast, readOnly, onEdit, onSaveHeading, onDelete, onUp, onDown,
}: {
  block: EditorBlock;
  isFirst: boolean;
  isLast: boolean;
  readOnly: boolean;
  onEdit: (id: string, field: "text" | "subtext", value: string) => void;
  onSaveHeading: (id: string) => void;
  onDelete: (id: string) => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: readOnly });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const s = block.kind !== "item" ? composeStyle(block.kind) : null;

  return (
    <div ref={setNodeRef} style={style} className={`flex items-start gap-2 ${s ? s.indent : ""}`}>
      <BlockControls attributes={attributes} listeners={listeners} isFirst={isFirst} isLast={isLast} disabled={readOnly} onUp={onUp} onDown={onDown} />
      <div className="flex-1 min-w-0">
        {block.kind !== "item" && s ? (
          <div className={s.box}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{s.placeholder}</span>
              {!readOnly && (
                <button type="button" onClick={() => onDelete(block.id)}
                  className="text-[11px] font-medium text-red-500 hover:text-red-700">
                  Delete
                </button>
              )}
            </div>
            <input
              value={block.text}
              disabled={readOnly}
              onChange={(e) => onEdit(block.id, "text", e.target.value)}
              onBlur={() => onSaveHeading(block.id)}
              placeholder={s.placeholder}
              className={`w-full bg-transparent focus:outline-none placeholder:text-gray-300 placeholder:normal-case placeholder:font-normal placeholder:tracking-normal ${s.input}`}
            />
            {s.subtext && (
              <input
                value={block.subtext}
                disabled={readOnly}
                onChange={(e) => onEdit(block.id, "subtext", e.target.value)}
                onBlur={() => onSaveHeading(block.id)}
                placeholder="Optional subtext"
                className="w-full bg-transparent text-sm text-gray-600 focus:outline-none placeholder:text-gray-300"
              />
            )}
          </div>
        ) : block.kind === "item" ? (
          <ItemCard item={block.item} />
        ) : null}
      </div>
    </div>
  );
}

function AddBlockBar({ onAdd }: { onAdd: (role: HeadingKind, defaultText: string) => void }) {
  return (
    <div className="flex items-center justify-center gap-1.5 my-2">
      {HEADING_ROLES.map(({ role, name, defaultText }) => (
        <button key={role} type="button" onClick={() => onAdd(role, defaultText)}
          className="px-2.5 py-1 rounded-lg border border-dashed border-accent/50 text-accent text-[11px] font-semibold hover:bg-accent hover:text-white hover:border-accent transition-colors">
          + {name}
        </button>
      ))}
    </div>
  );
}

export function BlockPacketEditor({
  packetId, title, status, initialBlocks,
}: {
  packetId: string;
  title: string;
  status: string;
  initialBlocks: PacketBlock[];
}) {
  const router = useRouter();
  const readOnly = status !== "draft";
  const [blocks, setBlocks] = useState<EditorBlock[]>(() => toEditorBlocks(initialBlocks));
  // Last persisted state — the rollback target for a failed save.
  const savedRef = useRef<EditorBlock[]>(toEditorBlocks(initialBlocks));
  // Mirror of the current blocks for async callbacks (blur/click handlers read
  // the latest list without stale closures). Synced after each render.
  const blocksRef = useRef<EditorBlock[]>(blocks);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [errorMsg, setErrorMsg] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Persist a full reordering (drag or up/down). Optimistic with rollback.
  async function persistReorder(next: EditorBlock[]) {
    const prev = savedRef.current;
    setBlocks(next);
    setSaveStatus("saving");
    try {
      const res = await fetch(`/api/packets/${packetId}/blocks/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockIds: next.map((b) => b.id) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Save failed");
      savedRef.current = next;
      setSaveStatus("saved");
      setErrorMsg("");
    } catch (e) {
      setBlocks(prev);
      savedRef.current = prev;
      setSaveStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Save failed");
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (readOnly || !over || active.id === over.id) return;
    const from = blocks.findIndex((b) => b.id === active.id);
    const to = blocks.findIndex((b) => b.id === over.id);
    if (from === -1 || to === -1) return;
    persistReorder(arrayMove(blocks, from, to));
  }

  function moveByOne(index: number, delta: number) {
    const to = index + delta;
    if (readOnly || to < 0 || to >= blocks.length) return;
    persistReorder(arrayMove(blocks, index, to));
  }

  // Local (unsaved) edit of heading text/subtext — persisted on blur.
  function editHeadingLocal(id: string, field: "text" | "subtext", value: string) {
    setBlocks((prev) => prev.map((b) => (b.id === id && b.kind !== "item" ? { ...b, [field]: value } : b)));
  }

  async function saveHeading(id: string) {
    const block = blocksRef.current.find((b) => b.id === id);
    if (!block || block.kind === "item") return;
    // Skip if unchanged vs last persisted.
    const persisted = savedRef.current.find((b) => b.id === id);
    if (persisted && persisted.kind !== "item" && persisted.text === block.text && persisted.subtext === block.subtext) return;
    if (!block.text.trim()) {
      // heading text must be non-blank — revert this field to last persisted
      setBlocks(savedRef.current);
      setSaveStatus("error");
      setErrorMsg("Heading text can't be empty — reverted.");
      return;
    }
    setSaveStatus("saving");
    try {
      const res = await fetch(`/api/packets/${packetId}/blocks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: block.text, subtext: block.subtext }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Save failed");
      savedRef.current = blocksRef.current;
      setSaveStatus("saved");
      setErrorMsg("");
    } catch (e) {
      setBlocks(savedRef.current);
      setSaveStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function addBlock(index: number, role: HeadingKind, defaultText: string) {
    if (readOnly) return;
    setSaveStatus("saving");
    try {
      const res = await fetch(`/api/packets/${packetId}/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: index, blockType: role, text: defaultText, subtext: "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Save failed");
      const next = [...blocksRef.current];
      next.splice(index, 0, { id: data.id, kind: role, text: defaultText, subtext: "" });
      setBlocks(next);
      savedRef.current = next;
      setSaveStatus("saved");
      setErrorMsg("");
    } catch (e) {
      // Nothing was added locally, so no rollback needed.
      setSaveStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function deleteBlock(id: string) {
    if (readOnly) return;
    const prev = savedRef.current;
    const next = blocksRef.current.filter((b) => b.id !== id);
    setBlocks(next);
    setSaveStatus("saving");
    try {
      const res = await fetch(`/api/packets/${packetId}/blocks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Save failed");
      savedRef.current = next;
      setSaveStatus("saved");
      setErrorMsg("");
    } catch (e) {
      setBlocks(prev);
      savedRef.current = prev;
      setSaveStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Save failed");
    }
  }

  const headingCount = blocks.filter((b) => b.kind !== "item").length;
  const itemCount = blocks.filter((b) => b.kind === "item").length;

  const statusPill =
    saveStatus === "saving"
      ? { text: "Saving…", cls: "bg-amber-100 text-amber-800" }
      : saveStatus === "error"
        ? { text: "Save failed — reverted", cls: "bg-red-100 text-red-700" }
        : { text: "All changes saved", cls: "bg-gray-100 text-gray-500" };

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-20 bg-white border-b border-border">
        <div className="max-w-lg mx-auto px-5 py-3 flex items-center gap-3">
          <button onClick={() => router.push("/dashboard")} className="text-sm text-muted hover:text-foreground">← Dashboard</button>
          <span className={`ml-auto text-xs font-medium px-2 py-1 rounded-full ${statusPill.cls}`}>{statusPill.text}</span>
        </div>
        {saveStatus === "error" && errorMsg && (
          <div className="max-w-lg mx-auto px-5 pb-2 text-xs text-red-600">{errorMsg}</div>
        )}
      </div>

      <div className="max-w-lg mx-auto px-5 pb-24">
        <header className="pt-6 pb-4">
          <p className="text-xs uppercase tracking-widest text-muted mb-1">Block composition</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight whitespace-pre-line">{title || "Untitled Packet"}</h1>
          <p className="mt-2 text-xs text-muted">
            {headingCount} heading{headingCount === 1 ? "" : "s"} · {itemCount} item{itemCount === 1 ? "" : "s"} · headings are visual only and do not own the items after them
          </p>
        </header>

        {readOnly && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This packet is <strong>{status}</strong>. Unpublish it to edit its composition.
          </div>
        )}

        {!readOnly && <AddBlockBar onAdd={(role, dt) => addBlock(0, role, dt)} />}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {blocks.map((block, i) => (
              <div key={block.id}>
                <SortableBlock
                  block={block}
                  isFirst={i === 0}
                  isLast={i === blocks.length - 1}
                  readOnly={readOnly}
                  onEdit={editHeadingLocal}
                  onSaveHeading={saveHeading}
                  onDelete={deleteBlock}
                  onUp={() => moveByOne(i, -1)}
                  onDown={() => moveByOne(i, 1)}
                />
                {!readOnly && <AddBlockBar onAdd={(role, dt) => addBlock(i + 1, role, dt)} />}
              </div>
            ))}
          </SortableContext>
        </DndContext>

        {blocks.length === 0 && (
          <p className="text-center text-sm text-muted py-8">This packet has no blocks yet.</p>
        )}
      </div>
    </div>
  );
}
