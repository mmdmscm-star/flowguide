"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
}: {
  selectable?: boolean;
  selected?: string[];
  onToggle?: (id: string) => void;
  onOpen?: (item: LibrarySnapshot) => void;
  refreshKey?: number;
  emptyHint?: string;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LibrarySnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Guards against an older, slower search overwriting a newer one.
  const seq = useRef(0);

  const load = useCallback(async (query: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/library?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (mine !== seq.current) return;
      if (!res.ok) { setError(data.message || data.error || "Could not load your Library."); return; }
      setItems(data.items ?? []);
    } catch {
      if (mine === seq.current) setError("Could not load your Library. Check your connection.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, refreshKey, load]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your Library…"
        className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-400"
      />

      {error && <p className="mt-3 text-xs text-red-700">{error}</p>}

      {loading && items.length === 0 && (
        <p className="mt-4 text-xs text-muted">Loading…</p>
      )}

      {!loading && items.length === 0 && (
        <p className="mt-4 text-sm text-muted">
          {q
            ? `Nothing in your Library matches “${q}”.`
            : emptyHint ?? "Your Library is empty. Save an item from a FlowGuide to reuse it later."}
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {items.map((s) => {
          const photo = heroPhoto(s);
          const isSelected = selected.includes(s.id);
          const Row = selectable ? "label" : "div";
          return (
            <Row
              key={s.id}
              className={`flex items-center gap-3 rounded-lg border p-3 ${
                isSelected ? "border-accent bg-accent/5" : "border-border bg-white"
              } ${selectable ? "cursor-pointer" : ""}`}
            >
              {selectable && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle?.(s.id)}
                  className="flex-none"
                />
              )}
              {/* The item's own photo when it has one. The fallback is a quiet
                  neutral tile rather than anything derived from the title —
                  a coloured word-swatch reads as data the item does not have. */}
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
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{s.title || "Untitled"}</p>
                <p className="text-xs text-muted truncate">{subtitleFor(s)}</p>
              </div>
              {!selectable && onOpen && (
                <button
                  onClick={() => onOpen(s)}
                  className="flex-none text-xs font-medium text-accent hover:text-accent-hover"
                >
                  Edit
                </button>
              )}
            </Row>
          );
        })}
      </ul>
    </div>
  );
}
