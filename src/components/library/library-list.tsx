"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LibrarySnapshot, subtitleFor, heroPhoto } from "@/lib/library-adapter";

// The searchable list of Library entries. Used in two places, deliberately:
// the /library workspace and the in-editor picker. One list, two contexts —
// `selectable` is the only difference, so what a professional learns in one
// place transfers to the other.

export function LibraryList({
  selectable = false,
  selected = [],
  onToggle,
  onOpen,
  refreshKey = 0,
  emptyHint,
  onLoaded,
  category = "",
  labels = [],
  favorite = false,
  onVocabulary,
}: {
  selectable?: boolean;
  selected?: string[];
  onToggle?: (id: string) => void;
  onOpen?: (item: LibrarySnapshot) => void;
  refreshKey?: number;
  /** What to show when the Library holds nothing AND nothing is being searched.
   *  A node rather than a string: an empty Library is a professional's first
   *  encounter with the feature, and one grey sentence is not an explanation. */
  emptyHint?: React.ReactNode;
  /** Reports what a load found. `filtered` distinguishes "the Library is empty"
   *  from "this search matched nothing" — an action that needs saved material
   *  must not disappear just because a search came back empty. */
  onLoaded?: (info: { count: number; filtered: boolean }) => void;
  /** Organization filters. They compose with the search box and with each
   *  other; labels are AND, so an item must carry every one asked for. */
  category?: string;
  labels?: string[];
  favorite?: boolean;
  /** The vocabulary actually in use, reported from the first page so the
   *  filter chips can be drawn from the professional's own words. */
  onVocabulary?: (v: { categories: string[]; labels: string[] }) => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LibrarySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // A page at a time, newest first. `cursor` is the raw pair the server handed
  // back; `hasMore` is the server's own answer rather than a guess from the
  // page size, because "fewer than I asked for" stops meaning "the end" the
  // moment a filter changes the shape of a page.
  const [cursor, setCursor] = useState<{ updatedAt: string; id: string } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Guards against an older, slower search overwriting a newer one.
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // DEPEND ON THE VALUE, NOT THE ARRAY.
  //
  // `labels` arrives as a prop with a default of [], which is a new identity on
  // every render. As a useCallback dependency that rebuilt `params`, which
  // rebuilt `load`, which re-ran the load effect, which set state and rendered
  // again — a fetch loop with no exit. The workspace passes state and never saw
  // it; the picker passes nothing at all and hit it immediately.
  //
  // The joined string is the dependency, so identity stops mattering and only a
  // real change to the chosen labels causes a refetch.
  // THE CALLBACKS MUST NOT DECIDE WHEN WE FETCH.
  //
  // onLoaded is passed as an inline arrow, so it is a new function on every
  // render. As a dependency of `load` that rebuilt load, which re-ran the load
  // effect, which called setItems with a fresh array, which re-rendered — and
  // round again. The server log showed the first page being fetched twenty-five
  // times over for one visit.
  //
  // They are notifications, not inputs: nothing about WHEN to load depends on
  // them. Held in refs so the latest is always called and the identity never
  // participates in scheduling.
  const onLoadedRef = useRef(onLoaded);
  const onVocabularyRef = useRef(onVocabulary);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
    onVocabularyRef.current = onVocabulary;
  });

  const labelKey = labels.join("\u0000");
  const labelList = useMemo(() => (labelKey ? labelKey.split("\u0000") : []), [labelKey]);

  const params = useCallback((query: string, after: { updatedAt: string; id: string } | null) => {
    const sp = new URLSearchParams();
    if (query.trim()) sp.set("q", query.trim());
    if (category) sp.set("category", category);
    if (labelList.length) sp.set("labels", labelList.join(","));
    if (favorite) sp.set("favorite", "1");
    if (after) { sp.set("cursorUpdatedAt", after.updatedAt); sp.set("cursorId", after.id); }
    return sp.toString();
  }, [category, labelList, favorite]);

  const load = useCallback(async (query: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/library?${params(query, null)}`);
      const data = await res.json();
      if (mine !== seq.current) return;
      if (!res.ok) { setError(data.message || data.error || "Could not load your Library."); return; }
      setItems(data.items ?? []);
      setHasMore(data.hasMore === true);
      setCursor(data.nextCursor ?? null);
      if (data.vocabulary) onVocabularyRef.current?.(data.vocabulary);
      onLoadedRef.current?.({ count: (data.items ?? []).length, filtered: query.trim().length > 0 });
    } catch {
      if (mine === seq.current) setError("Could not load your Library. Check your connection.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [params]);

  // The NEXT page appends. It carries the same seq guard, so a page that lands
  // after the professional has typed a new search is discarded instead of
  // pasting stale rows under fresh ones.
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/library?${params(q, cursor)}`);
      const data = await res.json();
      if (mine !== seq.current) return;
      if (!res.ok) { setError(data.message || data.error || "Could not load more."); return; }
      setItems((prev) => [...prev, ...(data.items ?? [])]);
      setHasMore(data.hasMore === true);
      setCursor(data.nextCursor ?? null);
    } catch {
      if (mine === seq.current) setError("Could not load more of your Library.");
    } finally {
      if (mine === seq.current) setLoadingMore(false);
    }
  }, [cursor, loadingMore, params, q]);

  // Search, filters and an explicit refresh all RESET paging: a cursor from the
  // previous result set describes a position that no longer exists.
  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, refreshKey, load]);

  // Reaching the end of the list fetches the next page, so the professional
  // never has to know there was a page boundary. The button below remains for
  // keyboard use and for anywhere the observer is unavailable.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your Library…"
        className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-400"
      />

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {loading && items.length === 0 && (
        <p className="mt-4 text-xs text-muted">Loading…</p>
      )}

      {!loading && items.length === 0 && (
        q
          ? <p className="mt-4 text-sm text-muted">Nothing in your Library matches “{q}”.</p>
          : <div className="mt-4">
              {emptyHint ?? (
                <p className="text-sm text-muted">
                  Your Library is empty. Save an item from a FlowGuide to reuse it later.
                </p>
              )}
            </div>
      )}

      <ul className="mt-3 space-y-2">
        {items.map((s) => {
          const photo = heroPhoto(s);
          const isSelected = selected.includes(s.id);

          // ONE BEHAVIOUR PER MODE, and they are different elements rather than
          // one element with a branch inside its handler. In selection mode a
          // row is a label wrapping a checkbox and clicking it selects; in
          // normal mode a row is a button and clicking it opens the entry to
          // read. Neither can fire in the other's mode, so a click never has to
          // be interpreted.
          const body = (
            <>
              {/* The item's own photo when it has one; otherwise a quiet
                  neutral tile rather than anything derived from the title. */}
              {photo
                /* eslint-disable-next-line @next/next/no-img-element */
                ? <img src={photo} alt="" className="h-10 w-10 flex-none rounded object-cover bg-gray-100" />
                : <div className="h-10 w-10 flex-none rounded bg-gray-100 flex items-center justify-center">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <circle cx="8.5" cy="9.5" r="1.5" />
                      <path d="M21 16l-5-5-4 4-2-2-4 4" />
                    </svg>
                  </div>}
              <div className="min-w-0 flex-1 text-left">
                <p className="text-sm font-medium text-foreground truncate">{s.title || "Untitled"}</p>
                <p className="text-sm text-muted truncate">{subtitleFor(s)}</p>
              </div>
            </>
          );

          const shell = `flex w-full items-center gap-3 rounded-lg border p-3 ${
            isSelected ? "border-accent bg-accent/5" : "border-border bg-white"
          }`;

          return selectable ? (
            <li key={s.id}>
              <label className={`${shell} cursor-pointer`}>
                <input type="checkbox" checked={isSelected}
                       onChange={() => onToggle?.(s.id)} className="flex-none" />
                {body}
              </label>
            </li>
          ) : (
            <li key={s.id}>
              <button type="button" onClick={() => onOpen?.(s)} disabled={!onOpen}
                      className={`${shell} ${onOpen ? "cursor-pointer hover:border-accent" : ""}`}>
                {body}
              </button>
            </li>
          );
        })}
      </ul>

      {/* The end of the list, and the next page. */}
      <div ref={sentinel} />
      {hasMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="text-sm font-medium text-accent hover:text-accent-hover disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
