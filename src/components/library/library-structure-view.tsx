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
  // OPEN, NOT COLLAPSED — the map records what has been opened, and anything
  // absent from it is shut. That inversion is the whole change: with several
  // sections, a Library that opens fully expanded is a wall of rows, and the
  // headings are the thing worth reading first.
  //
  // Deliberately NOT persisted. A remembered per-section state across sessions
  // is a preference, and a preference needs somewhere to live and something to
  // manage it. Opening the Library the same quiet way every time is simpler and
  // costs one click when it is wrong.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((m) => ({ ...m, [id]: !m[id] }));
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
  /** One page of one container, straight from the server. Shared by Show more
   *  and by the depth restore below, so both page the same way. */
  const fetchPage = useCallback(async (
    sectionId: string | null, groupId: string | null,
    cursor: { sortOrder?: number; updatedAt?: string; id: string } | null,
  ) => {
    const sp = new URLSearchParams();
    if (sectionId) sp.set("sectionId", sectionId); else sp.set("unorganized", "1");
    if (groupId) sp.set("groupId", groupId);
    if (cursor) {
      sp.set("cursorId", cursor.id);
      if (cursor.sortOrder !== undefined) sp.set("cursorSortOrder", String(cursor.sortOrder));
      if (cursor.updatedAt !== undefined) sp.set("cursorUpdatedAt", cursor.updatedAt);
    }
    const res = await fetch(`/api/library?${sp}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || "Could not load more.");
    return { items: (d.items ?? []) as LibrarySnapshot[],
             cursor: (d.nextContainerCursor ?? d.nextCursor ?? null) as Container["cursor"],
             hasMore: d.hasMore === true };
  }, []);

  /**
   * Reload the whole structure.
   *
   * `restore` says how many rows each container was showing, so a reload after
   * a reorder can page back to the SAME DEPTH instead of snapping to the first
   * page. Without it, moving an item that Show more had revealed collapsed the
   * section back to six rows and made manual ordering a click-per-move chore.
   *
   * The already-fetched pages are NOT kept and re-sorted locally. They were
   * paged with cursors against the order that just changed, so keeping them
   * could repeat or drop a row. The server stays authoritative; this simply
   * asks it for the same amount again.
   *
   * Everything is assembled BEFORE any state is set, so the view renders once
   * at full depth — no flash of a short list, and nothing for the page to
   * scroll away from underneath the professional.
   */
  const load = useCallback(async (restore?: Record<string, number>) => {
    try {
      const res = await fetch("/api/library/browse");
      const d = await res.json();
      if (!res.ok) { setError(d.message || "Could not load your Library."); return; }

      let refilled: Record<string, Container> = {};
      if (restore) {
        const containers: Container[] = [...(d.containers ?? []), d.unorganized].filter(Boolean);
        for (const c of containers) {
          const k = keyOf(c.sectionId, c.groupId);
          const want = restore[k] ?? 0;
          if (want <= c.items.length) continue;
          let cursor = c.cursor, hasMore = c.hasMore, got: LibrarySnapshot[] = [];
          // The container may have SHRUNK — an item moved elsewhere — so stop
          // when the server runs out rather than when the old count is reached.
          while (hasMore && cursor && c.items.length + got.length < want) {
            const page = await fetchPage(c.sectionId, c.groupId, cursor);
            got = [...got, ...page.items];
            cursor = page.cursor; hasMore = page.hasMore;
          }
          if (got.length) refilled = { ...refilled, [k]: { ...c, items: got, cursor, hasMore } };
        }
      }

      setError("");
      setData(d); setExtra(refilled);
      if (d.vocabulary) vocabRef.current?.(d.vocabulary);
      emptyRef.current?.((d.structure?.sections ?? []).length === 0);
    } catch { setError("Could not load your Library. Check your connection."); }
  }, [fetchPage]);

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
      const page = await fetchPage(c.sectionId, c.groupId, st.cursor);
      const k = keyOf(c.sectionId, c.groupId);
      setExtra((m) => ({ ...m, [k]: {
        ...c,
        items: [...(m[k]?.items ?? []), ...page.items],
        cursor: page.cursor,
        hasMore: page.hasMore,
      } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more.");
    } finally { setBusy(false); }
  }

  /** Correct a heading in place. One column; nothing under it moves. */
  async function rename(kind: "section" | "group", id: string, name: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/library/structure", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id, name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.message || "Could not rename that.");
        return false;
      }
      setError("");
      await load();
      return true;
    } catch { setError("Could not rename that."); return false; }
    finally { setBusy(false); }
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
      // HOW MUCH WAS ON SCREEN, so the reload can put it back. Captured after
      // the server confirms, because a failed move should change nothing.
      // `data` is non-null wherever a move control can be pressed, but the
      // guard costs nothing and keeps the reload honest if that ever changes.
      const depth: Record<string, number> = {};
      for (const c of data ? [...data.containers, data.unorganized] : []) {
        depth[keyOf(c.sectionId, c.groupId)] = rowsFor(c).length;
      }
      await load(depth);
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

  // Every heading that can be opened. Groups included, so Expand all means what
  // it says rather than "expand the sections and leave you clicking again".
  const headingIds = [...sections.map((x) => x.id), ...groups.map((x) => x.id)];
  const anyOpen = headingIds.some((id) => open[id]);

  return (
    <div className="space-y-5">
      {/* ONE CONTROL, and only when there is more than one thing to act on.
          A single section already has its own chevron, so a global toggle
          beside it would be two ways to do the same thing. */}
      {headingIds.length > 1 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setOpen(anyOpen ? {} : Object.fromEntries(headingIds.map((id) => [id, true])))}
            className="text-xs font-medium text-muted hover:text-accent"
          >
            {anyOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}
      {sections.map((sec, si) => {
        const mine = groups.filter((g) => g.sectionId === sec.id);
        const loose = container(sec.id, null);
        const total = mine.reduce((n, g) => n + (container(sec.id, g.id)?.total ?? 0), 0)
          + (loose?.total ?? 0);
        const shut = !open[sec.id];
        return (
          <section key={sec.id}>
            <Header
              level="section" name={sec.name} count={total} collapsed={!!shut}
              onCollapse={() => toggle(sec.id)}
              onRename={reorder ? (n) => rename("section", sec.id, n) : undefined}
              busy={busy}
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
                  const gshut = !open[g.id];
                  return (
                    <div key={g.id} className="pl-3 border-l border-border">
                      <Header
                        level="group" name={g.name} count={c?.total ?? 0} collapsed={!!gshut}
                        onCollapse={() => toggle(g.id)}
                        onRename={reorder ? (n) => rename("group", g.id, n) : undefined}
                        busy={busy}
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
  level, name, count, collapsed, onCollapse, controls, onRename, busy,
}: {
  level: "section" | "group"; name: string; count: number;
  collapsed: boolean; onCollapse: () => void; controls?: React.ReactNode;
  /** Omitted wherever the structure is not the professional's to change —
   *  inside a picker, and while a filter is narrowing the list. */
  onRename?: (name: string) => Promise<boolean>;
  busy?: boolean;
}) {
  // RENAME HAPPENS WHERE THE NAME IS. The heading becomes a field, in place —
  // no dialog, no settings panel, and certainly no screen for managing
  // headings. Enter keeps it, Escape abandons it, and blurring keeps it too,
  // because clicking away from a thing you just typed should not discard it.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  async function commit() {
    const wanted = draft.replace(/\s+/g, " ").trim();
    // Nothing to do: unchanged, or emptied. Closing beats an error about a
    // change the professional did not make.
    if (!wanted || wanted === name) { setEditing(false); setDraft(name); return; }
    const ok = await onRename?.(wanted);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={draft}
          disabled={busy}
          aria-label={`Rename ${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); setDraft(name); setEditing(false); }
          }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded border border-accent px-2 py-1 text-sm
                     focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
    );
  }

  return (
    <div className="group/head flex items-center gap-1.5">
      <button type="button" onClick={onCollapse} aria-expanded={!collapsed}
        className="flex min-w-0 items-center gap-1.5 text-left">
        <span className={`text-muted transition-transform ${collapsed ? "" : "rotate-90"}`} aria-hidden="true">›</span>
        <span className={level === "section"
          ? "truncate text-sm font-semibold text-foreground"
          : "truncate text-sm font-medium text-foreground/80"}>{name}</span>
        <span className="flex-none text-xs text-muted">({count})</span>
      </button>
      {onRename && <HeadingMenu name={name} busy={busy} onRename={() => { setDraft(name); setEditing(true); }} />}
      <span className="ml-auto flex-none">{controls}</span>
    </div>
  );
}

/** The one action a heading has, reachable without hovering.
 *
 *  HOVER IS NOT AN AFFORDANCE ON A PHONE. The first version faded Rename in on
 *  hover and focus, which meant a touch device had no way to find it at all
 *  short of discovering it by accident. So the control is always visible — a
 *  quiet `…` that sits at the end of the heading and says nothing until asked.
 *
 *  Dismissal is deliberate for the same reason the Library picker's is: Escape
 *  closes, and a click anywhere else closes, but only when the press STARTED
 *  outside — otherwise a drag that ends off the menu would close it mid-gesture.
 */
function HeadingMenu({
  name, busy, onRename,
}: { name: string; busy?: boolean; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const pressedOutside = useRef(false);

  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => {
      pressedOutside.current = !box.current?.contains(e.target as Node);
    };
    const up = (e: Event) => {
      if (pressedOutside.current && !box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: Event) => { if ((e as KeyboardEvent).key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("click", up, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("click", up, true);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={box} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-1.5 text-sm leading-none text-muted hover:text-accent disabled:opacity-40"
      >
        …
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-10 mt-1 w-36 overflow-hidden
                                    rounded-lg border border-border bg-white shadow-lg">
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onRename(); }}
            className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-gray-50"
          >
            Rename
          </button>
        </div>
      )}
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
