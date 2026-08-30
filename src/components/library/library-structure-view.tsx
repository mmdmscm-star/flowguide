"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibrarySnapshot } from "@/lib/library-adapter";
import type { LibraryVocabulary } from "@/lib/library-organization";
import { LibraryRow } from "@/components/library/library-row";

// THE LIBRARY, WITH ITS STRUCTURE SHOWING.
//
// Sections stacked as the major headings, their groups nested simply beneath,
// items under those or directly under the section, and whatever has not been
// filed sitting quietly afterwards. One page. A long container expands IN PLACE
// with Show more.
//
// It is not a file manager. Nothing here navigates into a container and back
// out again: there is no folder to open, no breadcrumb, no second screen. The
// professional is looking at their Library the whole time, and structure is a
// property of what they are already looking at.
//
// This view appears only when structure EXISTS and nothing is filtering. A
// Library with no sections is the calm flat list it has always been, and a
// search or a label filter suspends the hierarchy — drawing untouched
// containers as empty would say they were, when they were only filtered out.

interface Container {
  sectionId: string | null;
  groupId: string | null;
  items: LibrarySnapshot[];
  total: number;
  cursor: { sortOrder?: number; updatedAt?: string; id: string } | null;
  hasMore: boolean;
}
interface Browse {
  structure: {
    sections: Array<{ id: string; name: string; sortOrder: number }>;
    groups: Array<{ id: string; sectionId: string; name: string; sortOrder: number }>;
  };
  containers: Container[];
  unorganized: Container;
  vocabulary?: LibraryVocabulary;
}

const keyOf = (s: string | null, g: string | null) => `${s ?? ""}|${g ?? ""}`;

export function LibraryStructureView({
  refreshKey = 0, selectable = false, selected = [], onToggle, onOpen,
  onToggleFavorite, onMove, reorder = false, onVocabulary, onEmpty,
}: {
  refreshKey?: number;
  selectable?: boolean;
  selected?: string[];
  onToggle?: (id: string) => void;
  onOpen?: (s: LibrarySnapshot) => void;
  onToggleFavorite?: (id: string, next: boolean) => void;
  /** "Move…" on a row — hands the item to the Organize panel rather than
   *  inventing a second way to choose a destination. */
  onMove?: (id: string) => void;
  /** Move up / Move down. Never in a picker: choosing is not filing. */
  reorder?: boolean;
  onVocabulary?: (v: LibraryVocabulary) => void;
  /** Reports that no structure exists, so the caller can fall back to the flat
   *  list rather than rendering an empty hierarchy. */
  onEmpty?: (empty: boolean) => void;
}) {
  const [data, setData] = useState<Browse | null>(null);
  const [extra, setExtra] = useState<Record<string, Container>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Notifications, not inputs. Held in refs so their identity never
  // participates in deciding when to fetch — an inline arrow as a dependency
  // is what turned the flat list into a refetch loop.
  const vocabRef = useRef(onVocabulary); const emptyRef = useRef(onEmpty);
  useEffect(() => { vocabRef.current = onVocabulary; emptyRef.current = onEmpty; });

  // Nothing sets state SYNCHRONOUSLY here: the first statement is the fetch, so
  // the effect below cannot start a cascading render. The stale error is
  // cleared where the new answer lands rather than optimistically up front.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/library/browse");
      const d = await res.json();
      if (!res.ok) { setError(d.message || "Could not load your Library."); return; }
      setError("");
      setData(d); setExtra({});
      if (d.vocabulary) vocabRef.current?.(d.vocabulary);
      emptyRef.current?.((d.structure?.sections ?? []).length === 0);
    } catch { setError("Could not load your Library. Check your connection."); }
  }, []);

  // Deferred out of the effect body, the same way the flat list does it: the
  // fetch is started after the render commits rather than during it.
  useEffect(() => {
    const t = setTimeout(() => load(), 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  const rowsFor = (c: Container) => {
    const more = extra[keyOf(c.sectionId, c.groupId)];
    return more ? [...c.items, ...more.items] : c.items;
  };
  const stateFor = (c: Container) => extra[keyOf(c.sectionId, c.groupId)] ?? c;

  async function showMore(c: Container) {
    const st = stateFor(c);
    if (!st.cursor || busy) return;
    setBusy(true);
    try {
      const sp = new URLSearchParams();
      if (c.sectionId) sp.set("sectionId", c.sectionId); else sp.set("unorganized", "1");
      if (c.groupId) sp.set("groupId", c.groupId);
      sp.set("cursorId", st.cursor.id);
      if (st.cursor.sortOrder !== undefined) sp.set("cursorSortOrder", String(st.cursor.sortOrder));
      if (st.cursor.updatedAt !== undefined) sp.set("cursorUpdatedAt", st.cursor.updatedAt);
      const res = await fetch(`/api/library?${sp}`);
      const d = await res.json();
      if (!res.ok) { setError(d.message || "Could not load more."); return; }
      const k = keyOf(c.sectionId, c.groupId);
      setExtra((m) => ({ ...m, [k]: {
        ...c,
        items: [...(m[k]?.items ?? []), ...(d.items ?? [])],
        cursor: d.nextContainerCursor ?? d.nextCursor ?? null,
        hasMore: d.hasMore === true,
      } }));
    } finally { setBusy(false); }
  }

  async function move(kind: "item" | "section" | "group", id: string, direction: "up" | "down") {
    setBusy(true);
    try {
      // AN INTENT, not the loaded rows. The server resolves the neighbour
      // against the whole container, so this is correct whether or not the rest
      // of a long section has been shown yet.
      const res = await fetch("/api/library/order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id, direction }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.message || "Could not move that."); return; }
      await load();
    } catch { setError("Could not move that."); }
    finally { setBusy(false); }
  }

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data) return <p className="text-xs text-muted">Loading…</p>;

  const { sections, groups } = data.structure;
  const container = (s: string | null, g: string | null) =>
    data.containers.find((c) => c.sectionId === s && c.groupId === g);

  const star = (s: LibrarySnapshot) => onToggleFavorite ? <StarButton item={s} onToggle={onToggleFavorite} /> : null;

  const itemList = (c: Container | undefined, indent: string) => {
    if (!c) return null;
    const rows = rowsFor(c);
    const st = stateFor(c);
    if (!rows.length) return null;
    return (
      <>
        <ul className={`${indent} space-y-2`}>
          {rows.map((s, i) => (
            <LibraryRow key={s.id} item={s} selectable={selectable}
              selected={selected.includes(s.id)} onToggle={onToggle} onOpen={onOpen}
              star={star(s)}
              controls={reorder && !selectable ? (
                // isLast IS NOT "the last row loaded". A paged container has
                // more below the fold, and disabling Move down there would put
                // the rest of the section out of reach from the one row that
                // needs to walk into it — the page boundary leaking into
                // behaviour, which is the whole thing the server-side move
                // exists to avoid.
                <Controls busy={busy} isFirst={i === 0}
                  isLast={i === rows.length - 1 && !st.hasMore}
                  onUp={() => move("item", s.id, "up")} onDown={() => move("item", s.id, "down")}
                  onMove={onMove ? () => onMove(s.id) : undefined} />
              ) : null} />
          ))}
        </ul>
        {st.hasMore && (
          <div className={`${indent} mt-2`}>
            <button type="button" onClick={() => showMore(c)} disabled={busy}
              className="text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-60">
              {busy ? "Loading…" : `Show more (${Math.max(c.total - rows.length, 0)} more)`}
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="space-y-5">
      {sections.map((sec, si) => {
        const mine = groups.filter((g) => g.sectionId === sec.id);
        const loose = container(sec.id, null);
        const total = mine.reduce((n, g) => n + (container(sec.id, g.id)?.total ?? 0), 0)
          + (loose?.total ?? 0);
        const shut = collapsed[sec.id];
        return (
          <section key={sec.id}>
            <Header
              level="section" name={sec.name} count={total} collapsed={!!shut}
              onCollapse={() => setCollapsed((m) => ({ ...m, [sec.id]: !m[sec.id] }))}
              controls={reorder ? (
                <Controls busy={busy} isFirst={si === 0} isLast={si === sections.length - 1}
                  onUp={() => move("section", sec.id, "up")} onDown={() => move("section", sec.id, "down")} />
              ) : null} />
            {!shut && (
              <div className="mt-2 space-y-3">
                {/* Organized first, remainder last — the same rule as the page
                    itself: groups in order, then whatever sits loose in the
                    section. */}
                {mine.map((g, gi) => {
                  const c = container(sec.id, g.id);
                  const gshut = collapsed[g.id];
                  return (
                    <div key={g.id} className="pl-3 border-l border-border">
                      <Header
                        level="group" name={g.name} count={c?.total ?? 0} collapsed={!!gshut}
                        onCollapse={() => setCollapsed((m) => ({ ...m, [g.id]: !m[g.id] }))}
                        controls={reorder ? (
                          <Controls busy={busy} isFirst={gi === 0} isLast={gi === mine.length - 1}
                            onUp={() => move("group", g.id, "up")} onDown={() => move("group", g.id, "down")} />
                        ) : null} />
                      {!gshut && <div className="mt-2">{itemList(c, "")}</div>}
                    </div>
                  );
                })}
                {itemList(loose, "")}
              </div>
            )}
          </section>
        );
      })}

      {/* WHAT HAS NOT BEEN FILED, and that is a fine place for it to stay. Not
          a section, not called Uncategorized, and not something to finish. */}
      {data.unorganized.total > 0 && (
        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Everything else <span className="ml-1 font-normal normal-case">({data.unorganized.total})</span>
          </p>
          <p className="mb-2 mt-0.5 text-[11px] text-muted/80">Newest first. Nothing here needs a section.</p>
          {itemList(data.unorganized, "")}
        </section>
      )}
    </div>
  );
}

function Header({
  level, name, count, collapsed, onCollapse, controls,
}: {
  level: "section" | "group"; name: string; count: number;
  collapsed: boolean; onCollapse: () => void; controls?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={onCollapse} aria-expanded={!collapsed}
        className="flex min-w-0 items-center gap-1.5 text-left">
        <span className={`text-muted transition-transform ${collapsed ? "" : "rotate-90"}`} aria-hidden="true">›</span>
        <span className={level === "section"
          ? "truncate text-sm font-semibold text-foreground"
          : "truncate text-sm font-medium text-foreground/80"}>{name}</span>
        <span className="flex-none text-xs text-muted">({count})</span>
      </button>
      <span className="ml-auto flex-none">{controls}</span>
    </div>
  );
}

/** Move up / Move down, and Move… for crossing containers.
 *
 *  No drag handle. Dragging is not the requirement — easy movement is, and on a
 *  phone inside a scrolling list a drag is the least reliable way to get it.
 *  Two buttons work with a mouse, a keyboard and a screen reader without
 *  anything extra, and "Move…" hands the item to the Organize panel rather
 *  than inventing a second way to pick a destination. */
function Controls({
  busy, isFirst, isLast, onUp, onDown, onMove,
}: {
  busy: boolean; isFirst: boolean; isLast: boolean;
  onUp: () => void; onDown: () => void; onMove?: () => void;
}) {
  const b = "px-1 text-gray-400 hover:text-accent disabled:opacity-25 disabled:hover:text-gray-400";
  return (
    <span className="flex flex-none items-center">
      <button type="button" onClick={onUp} disabled={busy || isFirst} aria-label="Move up" className={b}>↑</button>
      <button type="button" onClick={onDown} disabled={busy || isLast} aria-label="Move down" className={b}>↓</button>
      {onMove && (
        <button type="button" onClick={onMove} disabled={busy}
          className="ml-0.5 text-[11px] font-medium text-muted hover:text-accent disabled:opacity-40">
          Move…
        </button>
      )}
    </span>
  );
}

function StarButton({ item, onToggle }: { item: LibrarySnapshot; onToggle: (id: string, next: boolean) => void }) {
  // Answers immediately and reconciles on the next load — filing is a rapid,
  // low-stakes gesture and should not feel like submitting a form.
  const [on, setOn] = useState(item.isFavorite === true);
  return (
    <button type="button"
      onClick={() => { const next = !on; setOn(next); onToggle(item.id, next); }}
      aria-pressed={on}
      aria-label={on ? `Remove ${item.title || "this item"} from favorites` : `Add ${item.title || "this item"} to favorites`}
      className={`flex-none px-1 text-lg leading-none transition-colors ${
        on ? "text-amber-500 hover:text-amber-600" : "text-gray-300 hover:text-amber-500"}`}>
      {on ? "★" : "☆"}
    </button>
  );
}
