"use client";
import { Button } from "@/components/ui/button";
import { MODAL_SCRIM, MODAL_PANEL, MODAL_TITLE, MODAL_LEDE, MODAL_FOOT }
  from "@/components/ui/modal";

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
      {/* SWITCHING EDITOR IS NOT THE JOB. This was a filled primary sitting at
          the top of the editor, so the loudest control on the screen offered to
          change how the packet is composed rather than to work on it. It is a
          secondary now — and reverting, which discards headings and order,
          keeps `danger`: quiet until it is pointed at, then unmistakable. */}
      <Button
        variant={direction === "convert" ? "secondary" : "danger"}
        size="sm"
        onClick={() => { setError(""); setOpen(true); }}
      >
        {c.button}
      </Button>

      {open && (
        <div className={MODAL_SCRIM} role="dialog">
          <div className={`${MODAL_PANEL} max-w-md my-12 p-5`}>
            <h2 className={MODAL_TITLE}>{c.title}</h2>
            {c.lead && <p className={`${MODAL_LEDE} ${c.danger ? "text-red-700" : ""}`}>{c.lead}</p>}
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-body text-ink">
              {c.points.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
            {error && <p className="mt-3 text-meta text-red-700">{error}</p>}
            <div className={`${MODAL_FOOT} justify-end`}>
              <Button variant="ghost" size="md" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant={c.danger ? "danger" : "primary"} size="md" onClick={run} disabled={busy}>
                {busy ? "Working…" : c.confirm}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
