"use client";
import { useEffect, useState } from "react";
import type { ContentDiff, SaveBackDecision } from "@/lib/library";

// "Update Library version" — the compounding step, and the one place a
// replacement can quietly destroy work.
//
// Two ways that happens, and both are ordinary rather than edge cases:
//
//   TAILORED  — the packet copy was deliberately pruned for one recipient, so
//               replacing the base deletes the rest for every future packet.
//   STALE     — the entry was edited directly after this copy was taken, so
//               replacing overwrites those newer edits.
//
// The dialog does not merge and does not synchronize. It DESCRIBES what a
// replacement would do, and lets that description decide which action is
// offered first. `decideSaveBack` on the server makes that call; this renders
// it. Nothing here re-derives the decision, because two implementations of the
// same rule is how they stop agreeing.

type Payload = { diff: ContentDiff | null; decision: SaveBackDecision; ancestor: { id: string; title: string; revision: number } | null };

const FIELD_LABEL: Record<string, string> = {
  details: "detail", links: "link", photos: "photo", contacts: "contact",
};

/** "3 details, 1 photo" — plain counting, no jargon. */
function summarise(diff: ContentDiff | null, kind: "removed" | "added" | "changed"): string[] {
  if (!diff) return [];
  return diff.fields
    .filter((f) => f[kind].length > 0)
    .map((f) => {
      const n = f[kind].length;
      const noun = FIELD_LABEL[f.field] ?? f.field;
      return `${n} ${noun}${n === 1 ? "" : "s"}`;
    });
}

export function SaveBackDialog({
  packetItemId, libraryItemId, itemTitle, onDone, onCancel,
}: {
  packetItemId: string;
  libraryItemId: string;
  itemTitle: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The comparison is computed server-side and re-fetched here, so what the
  // professional reviews is the state that will actually be replaced.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/library/${libraryItemId}/update-from-item?itemId=${packetItemId}`);
        const data = await res.json();
        if (!live) return;
        if (!res.ok) { setError(data.message || data.error || "Could not compare."); return; }
        setState(data as Payload);
      } catch {
        if (live) setError("Could not compare. Check your connection.");
      }
    })();
    return () => { live = false; };
  }, [libraryItemId, packetItemId]);

  async function act(action: "update" | "save_as_new") {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/library/${libraryItemId}/update-from-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: packetItemId, action,
          // The revision the professional actually reviewed. The server refuses
          // if it moved, rather than replacing a state nobody looked at.
          ...(action === "update" ? { expectedRevision: state?.ancestor?.revision } : {}),
        }),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === "revision_conflict") {
        // Show the RECOMPUTED comparison. They decide again with what is true
        // now, instead of retrying against something stale.
        setState({ diff: data.diff, decision: data.decision, ancestor: state?.ancestor ? { ...state.ancestor, revision: data.currentRevision } : null });
        setError("Your saved version changed while you were reviewing. This is how it compares now.");
        return;
      }
      if (!res.ok) { setError(data.message || data.error || "That didn't go through."); return; }

      onDone(action === "update" ? "Library version updated." : "Saved as a new Library item.");
    } catch {
      setError("That didn't go through. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !state) {
    return <Shell onCancel={onCancel}><p className="text-xs text-red-700">{error}</p></Shell>;
  }
  if (!state) {
    return <Shell onCancel={onCancel}><p className="text-xs text-muted">Comparing…</p></Shell>;
  }

  const { diff, decision } = state;
  const removals = summarise(diff, "removed");
  const additions = summarise(diff, "added");
  const changes = summarise(diff, "changed");
  const removedLabels = (diff?.fields ?? []).flatMap((f) => f.removed).slice(0, 6);

  // Ancestor deleted: the only honest offer is a new entry.
  if (decision.primary === "save_new_ancestor_gone") {
    return (
      <Shell onCancel={onCancel}>
        <p className="text-sm font-medium text-foreground">This item is no longer in your Library</p>
        <p className="mt-1 text-xs text-muted">
          “{itemTitle}” was removed from your Library. You can save this version as a new
          Library item.
        </p>
        {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        <Actions
          primary={{ label: busy ? "Saving…" : "Save to Library", onClick: () => act("save_as_new") }}
          busy={busy} onCancel={onCancel}
        />
      </Shell>
    );
  }

  if (decision.primary === "none") {
    return (
      <Shell onCancel={onCancel}>
        <p className="text-sm font-medium text-foreground">Nothing to update</p>
        <p className="mt-1 text-xs text-muted">
          This item matches your saved version{decision.ancestorMovedOn ? ", though your saved version has changed since you added this one" : ""}.
        </p>
        <Actions busy={busy} onCancel={onCancel} cancelLabel="Close" />
      </Shell>
    );
  }

  const removalsFirst = decision.wouldRemoveContent;

  return (
    <Shell onCancel={onCancel}>
      {/* A TAILORED COPY IS NORMAL, not a mistake. This FlowGuide's version is
          shorter because it was written for one audience; the saved version is
          the fuller base. So the choice is framed as keeping both versus
          replacing the saved one — the safeguard is unchanged, the alarm is
          gone. */}
      {removalsFirst ? (
        <>
          <p className="text-sm font-medium text-foreground">This version is shorter than the one you saved</p>
          <p className="mt-1 text-xs text-muted">
            You trimmed {removals.join(", ")} here
            {removedLabels.length > 0 && <>: <span className="text-foreground">{removedLabels.join(" · ")}</span></>}.
            Your saved version still has {removedLabels.length === 1 ? "it" : "them"}.
          </p>
          <p className="mt-2 text-xs text-muted">
            <span className="font-medium text-foreground">Keep both</span> to save this shorter version
            alongside the fuller one, or <span className="font-medium text-foreground">replace</span> if the
            trimmed version is the one you want to reuse from now on.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground">Update your saved version of “{itemTitle}”?</p>
          <p className="mt-1 text-xs text-muted">
            {[...additions.map((a) => `${a} added`), ...changes.map((c) => `${c} changed`)].join(" · ") || "Text changed"}.
          </p>
        </>
      )}

      {decision.ancestorMovedOn && (
        <p className="mt-2 text-xs text-muted">
          Your saved version has also changed since you added this one. Replacing will
          use this version instead.
        </p>
      )}

      <p className="mt-2 text-xs text-muted">
        Any FlowGuide already using this item stays as it is.
      </p>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      <Actions
        busy={busy}
        onCancel={onCancel}
        primary={removalsFirst
          ? { label: busy ? "Saving…" : "Keep both", onClick: () => act("save_as_new") }
          : { label: busy ? "Updating…" : "Update saved version", onClick: () => act("update") }}
        secondary={removalsFirst
          ? { label: "Replace saved version", onClick: () => act("update") }
          : { label: "Keep both instead", onClick: () => act("save_as_new") }}
      />
    </Shell>
  );
}

function Shell({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-xl border border-border bg-white p-4" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function Actions({
  primary, secondary, busy, onCancel, cancelLabel = "Cancel",
}: {
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  busy: boolean;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {primary && (
        <button onClick={primary.onClick} disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium disabled:opacity-60">
          {primary.label}
        </button>
      )}
      {secondary && (
        <button onClick={secondary.onClick} disabled={busy}
          className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted hover:text-foreground disabled:opacity-60">
          {secondary.label}
        </button>
      )}
      <button onClick={onCancel} disabled={busy}
        className="ml-auto text-xs font-medium text-muted hover:text-foreground disabled:opacity-60">
        {cancelLabel}
      </button>
    </div>
  );
}
