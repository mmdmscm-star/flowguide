"use client";
import { useEffect, useState } from "react";
import OwnershipResolution, { type OwnershipState } from "./OwnershipResolution";

// The standing home for ownership decisions, inside the editor.
//
// WHY THIS EXISTS SEPARATELY FROM THE PUBLISH FLOW. A Keep suppresses its own
// finding — that is what a Keep is — so after the publish panel is dismissed
// there is nothing left that would ever surface it again. The undo RPC existed,
// but an undo the professional cannot find is not a reversal, and "reversible
// via the API" is not reversible in the product.
//
// It is the SAME component as the publish-time panel, mounted in a different
// default state rather than forked into a second surface. There is one place
// that decides how an ownership finding is described and what may be done about
// it; a second copy would drift from it the first time either changed.
//
// It appears ONLY when a decision actually exists. A professional who never kept
// anything never sees an ownership section in their editor.
export default function OwnershipDecisions({ packetId }: { packetId: string }) {
  const [state, setState] = useState<OwnershipState | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/packets/${packetId}/ownership`);
        if (!live) return;
        // 503 is the check not having run. Rendering nothing would say "no
        // decisions", which is the one thing an unavailable check cannot tell us.
        if (res.status === 503) { setUnavailable(true); return; }
        if (!res.ok) return;
        setState(await res.json());
      } catch {
        if (live) setUnavailable(true);
      }
    })();
    return () => { live = false; };
  }, [packetId]);

  if (unavailable) {
    return (
      <p className="mb-5 text-xs text-muted">
        Photo decisions couldn&apos;t be loaded just now. Reload the page to try again.
      </p>
    );
  }

  // Gated on decisions, not on findings. An unresolved finding already has a
  // home — the publish flow — and the editor is not trying to become a second
  // gate. But when the surface IS shown, it shows everything it knows: hiding a
  // live problem from the person best placed to fix it would be worse than the
  // extra density.
  if (!state || state.kept.length === 0) return null;

  return (
    <OwnershipResolution
      packetId={packetId}
      state={state}
      onState={setState}
    />
  );
}
