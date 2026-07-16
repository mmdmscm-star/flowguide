"use client";

import { useState } from "react";

// ============================================================
// R2-C deliberate conversion controls. One component drives both directions:
//   convert  — legacy draft  -> block editor  (calls /api/packets/:id/convert)
//   revert   — block  draft  -> legacy editor (calls /api/packets/:id/revert)
// Each shows a confirmation with the exact consequences before acting. On
// success it hard-navigates back into the correct editor with a success notice;
// on failure the packet is unchanged and the error is shown. Only rendered for
// owned DRAFT packets — published packets never see it (callers gate on status),
// and the server routes + RPCs reject anything else.
// ============================================================

type Direction = "convert" | "revert";

const COPY: Record<Direction, {
  button: string;
  title: string;
  lead?: string;
  points: string[];
  confirm: string;
  endpoint: string;
  successParam: string;
  danger: boolean;
}> = {
  convert: {
    button: "Convert to block editor",
    title: "Convert this packet to the block editor?",
    points: [
      "All item content is preserved exactly — nothing is deleted.",
      "Each existing section becomes a heading block.",
      "The packet switches to the flat block composition editor.",
      "If you later revert, block-only headings and their ordering are discarded.",
    ],
    confirm: "Convert to blocks",
    endpoint: "convert",
    successParam: "converted",
    danger: false,
  },
  revert: {
    button: "Revert to legacy editor",
    title: "Revert this packet to the legacy section editor?",
    lead: "This changes how the packet is composed. Please read carefully:",
    points: [
      "All item content remains — nothing is deleted.",
      "Block-only headings and the block ordering will be permanently discarded.",
      "The original frozen legacy section structure returns.",
    ],
    confirm: "Revert to legacy",
    endpoint: "revert",
    successParam: "reverted",
    danger: true,
  },
};

export function CompositionModeControl({ packetId, direction }: { packetId: string; direction: Direction }) {
  const c = COPY[direction];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/packets/${packetId}/${c.endpoint}`, { method: "POST" });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error || "The change could not be applied.");
      }
      // Hard navigation guarantees a fresh server render into the correct editor.
      window.location.href = `/edit/${packetId}?${c.successParam}=1`;
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "The change could not be applied.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setError(""); setOpen(true); }}
        className={
          direction === "convert"
            ? "text-xs font-medium text-white bg-accent hover:bg-accent-hover px-3 py-1.5 rounded-lg"
            : "text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg"
        }
      >
        {c.button}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto p-4" role="dialog">
          <div className="w-full max-w-md my-12 rounded-2xl bg-white shadow-xl p-5">
            <h2 className="text-base font-semibold text-foreground">{c.title}</h2>
            {c.lead && <p className={`mt-1 text-sm ${c.danger ? "text-red-600" : "text-muted"}`}>{c.lead}</p>}
            <ul className="mt-3 space-y-1.5 text-sm text-foreground list-disc pl-5">
              {c.points.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} disabled={busy}
                className="text-sm text-muted hover:text-foreground px-3 py-1.5 disabled:opacity-40">
                Cancel
              </button>
              <button type="button" onClick={run} disabled={busy}
                className={`text-sm font-medium text-white px-4 py-1.5 rounded-lg disabled:opacity-50 ${c.danger ? "bg-red-600 hover:bg-red-700" : "bg-accent hover:bg-accent-hover"}`}>
                {busy ? "Working…" : c.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
