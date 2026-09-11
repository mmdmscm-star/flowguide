"use client";

import { useCallback, useEffect, useState } from "react";
import OwnershipResolution, { type OwnershipState } from "./OwnershipResolution";
import { Button, buttonClass } from "./ui/button";
import ClientMessagePanel from "./client-message-panel";
import EmailVersionPanel from "./email-version-panel";

type Props = {
  packetId: string;
  slug: string;
  initialStatus: string;
  /** For the client message. All optional - it degrades a line at a time. */
  title?: string | null;
  clientName?: string | null;
  professionalName?: string | null;
  /** Set when the professional was sent here BY a publish that was refused for
   *  photo ownership. The reason travels in the URL so the arrival explains
   *  itself and can be linked to, reloaded, or shared with support. */
  resolveOwnership?: boolean;
};

export function PreviewActions({ packetId, slug, initialStatus, title, clientName, professionalName, resolveOwnership }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Set only by a publish that was actually blocked on ownership. The panel is
  // driven by the 409 rather than mounted speculatively, so a professional whose
  // packet is fine never sees a photo-checking screen at all.
  const [ownership, setOwnership] = useState<OwnershipState | null>(null);
  // The email version is fetched on demand and never stored: a saved copy is a
  // second source of truth that goes stale when the packet changes.
  const [emailDoc, setEmailDoc] = useState<{ html: string; text: string } | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [resolved, setResolved] = useState(false);

  // The 409 carries the findings, but not what may be DONE about each one. That
  // is derived by the ownership route, which is the single place that decides
  // what FlowGuide is willing to offer — so the panel is loaded from there
  // rather than from a second, thinner copy of the same facts.
  /** FETCHING AND SETTING ARE SEPARATE. A function that returns the state lets
   *  the effect below decide whether the component is still mounted before
   *  storing it, and keeps the store out of the effect's synchronous body,
   *  which is what the cascading-render rule is about. */
  const fetchOwnership = useCallback(async (): Promise<OwnershipState | null> => {
    try {
      const res = await fetch(`/api/packets/${packetId}/ownership`);
      if (!res.ok) return null;   // includes 503: an unavailable check has no panel to draw
      return (await res.json()) as OwnershipState;
    } catch {
      // Leaving the panel unmounted falls back to the 409's own sentence, which
      // already says what is wrong even when it cannot say what to press.
      return null;
    }
  }, [packetId]);

  const loadOwnership = useCallback(async () => {
    const next = await fetchOwnership();
    if (next) setOwnership(next);
  }, [fetchOwnership]);

  // ARRIVING BECAUSE OF THE PHOTOS, rather than discovering it by pressing
  // Publish a second time.
  //
  // The editor's Publish can be refused for unresolved photo ownership, and the
  // editor has nothing to draw for it — the resolution panel lives here. It now
  // sends the professional here and says why, and this is the half that makes
  // that worth doing: without it they would land on a page that looks entirely
  // normal and would have to press Publish again to find out.
  //
  // Asked for explicitly rather than fetched on every mount: someone opening
  // Preview to look at their Sendset is not asking about photo provenance, and
  // a request nobody needs is a request that can fail in front of them.
  useEffect(() => {
    if (!resolveOwnership) return;
    let cancelled = false;
    void (async () => {
      const next = await fetchOwnership();
      if (!cancelled && next) setOwnership(next);
    })();
    return () => { cancelled = true; };
  }, [resolveOwnership, fetchOwnership]);

  async function publishPacket(skipProfileCheck: boolean) {
    setError("");
    setPublishing(true);
    try {
      const res = await fetch(`/api/packets/${packetId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish", skipProfileCheck }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 422 && (data.error === "no_profile" || data.error === "no_contact")) {
          const proceed = confirm(
            "This Sendset does not include professional contact information. You can still publish it, but the contact footer will not appear."
          );
          if (proceed) {
            await publishPacket(true);
          }
          return;
        }
        if (res.status === 409 && data.error === "ownership_unresolved") {
          setResolved(false);
          setError(data.message || "Some photos need checking before you can publish.");
          await loadOwnership();
          return;
        }
        // The check did not run. Not the professional's fault and not their
        // problem to fix, so no panel and no findings — just the retry.
        if (res.status === 503 && data.error === "ownership_unavailable") {
          setResolved(false);
          setOwnership(null);
          setError(data.message || "Photo checks are temporarily unavailable. Try again in a moment.");
          return;
        }
        setError(data.message || data.error || "Could not publish");
        return;
      }
      setStatus("published");
    } finally {
      setPublishing(false);
    }
  }

  // ONE definition, used by the link copy and by the message, so the two can
  // never disagree about where the packet lives. Empty during SSR; the panel
  // only renders after publish, which is client-side.
  const shareUrl = typeof window === "undefined" ? `/p/${slug}` : `${window.location.origin}/p/${slug}`;

  async function createEmailVersion() {
    setEmailBusy(true);
    setEmailError("");
    try {
      const res = await fetch(`/api/packets/${packetId}/email`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.html) {
        setEmailError(data?.message || "Could not build the email version.");
        return;
      }
      setEmailDoc({ html: data.html, text: data.text ?? "" });
    } catch {
      setEmailError("Could not build the email version. Check your connection and try again.");
    } finally {
      setEmailBusy(false);
    }
  }

  // AWAITED AND CAUGHT. This used to fire writeText() without awaiting it and
  // set "Copied!" unconditionally, so an insecure context, a denied permission
  // or a browser that refuses without a user gesture all reported success the
  // professional did not have — observed live, in a browser that denies
  // clipboard writes. The failure now says so, in the same shape the client
  // message and email panels already use.
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  if (status === "published") {
    return (
      <section aria-labelledby="share-heading" className="pt-8 pb-8 sm:pt-10">
        {/* THE MOMENT OF ARRIVAL, not an alert about it.
            This was a full-bleed green band — green ground, green rules, green
            text on green — carrying every word of the share step inside it.
            Green-on-green is the shape of a system message, and it kept saying
            "notice this" for as long as the professional stayed on the page,
            which is the opposite of finished. The state itself is worth one
            quiet mark: the SAME pill the Dashboard already uses to say a
            Sendset is published, so the two surfaces agree. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 id="share-heading" className="text-page font-semibold tracking-[-0.02em] text-ink">
            Ready to send
          </h1>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-micro font-medium text-emerald-800">
            Published
          </span>
        </div>
        <p className="mt-2 max-w-prose text-meta text-ink-2">
          Anyone with the link can open this Sendset — no sign-in required. Share
          it only with people you want to see it.
        </p>

        {/* The message CONTAINS the link, so it takes precedence and
            "Copy link only" is the quieter action beside it. The link
            behaviour itself is unchanged. */}
        <div className="mt-6">
          <ClientMessagePanel
            title={title}
            clientName={clientName}
            professionalName={professionalName}
            url={shareUrl}
            onCopyLink={copyLink}
            linkCopied={copied}
          />
        </div>

        {copyFailed && (
          <p role="alert" className="mt-2 text-meta text-red-700">
            Your browser blocked the copy — the link is {shareUrl}
          </p>
        )}

        {/* ONE SENDSET, THREE RENDERERS — SO THEY READ AS PEERS.
            The email version and the print route were underlined links stacked
            under the message panel at two different sizes, which ranked two of
            the three delivery methods as afterthoughts. They are the same
            Sendset, delivered differently, and they are grouped as such. No
            capability is added or removed here. */}
        <div className="mt-4 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-ground">
          <div className="border-b border-line bg-ground-2 px-4 py-3">
            <h2 className="text-body font-medium text-ink">Other ways to send it</h2>
            <p className="mt-0.5 text-meta text-ink-2">
              The same Sendset, delivered differently.
            </p>
          </div>
          <div className="p-4">
            {emailDoc ? (
              <EmailVersionPanel html={emailDoc.html} text={emailDoc.text} onClose={() => setEmailDoc(null)} />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="md" onClick={createEmailVersion} disabled={emailBusy}>
                  {emailBusy ? "Building…" : "Email version"}
                </Button>
                {/* Opened in a new tab rather than navigated to, so the share
                    step stays where the professional left it. */}
                <a
                  href={`/p/${slug}/print`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass("secondary", "md")}
                >
                  Print / Save as PDF
                </a>
              </div>
            )}
            {emailError && <p role="alert" className="mt-2 text-meta text-red-700">{emailError}</p>}
          </div>
        </div>

        <div className="mt-6">
          <a href={`/edit/${packetId}`} className={buttonClass("ghost", "md", "-ml-4.5 sm:-ml-4")}>
            ← Back to editor
          </a>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="preview-heading" className="pt-8 pb-8 sm:pt-10">
      <h1 id="preview-heading" className="text-page font-semibold tracking-[-0.02em] text-ink">
        Preview
      </h1>
      <p className="mt-2 max-w-prose text-meta text-ink-2">
        This is how your client will see it. Publish when you are happy with it.
      </p>

      {/* The block and the way out are the same screen. Sending someone
          elsewhere to fix this and back again to retry is how a safety state
          turns into a dead end. */}
      {ownership && (
        <div className="mt-5">
          <OwnershipResolution
            packetId={packetId}
            state={ownership}
            onState={(next) => {
              setOwnership(next);
              if (next.blockingCount > 0) {
                setError("");
                setResolved(false);   // an undo puts the block back
              }
            }}
            // NOT unmounted. The panel still holds the undo for anything just
            // kept, and taking that away the instant the last finding clears
            // would make every Keep final at exactly the moment a misclick gets
            // noticed. It renders itself away when there is nothing left to say.
            onResolved={() => {
              setError("");
              setResolved(true);
            }}
          />
        </div>
      )}

      {resolved && (
        <p className="mt-4 text-meta text-emerald-800">
          Photos sorted — you can publish now.
        </p>
      )}
      {error && <p role="alert" className="mt-4 text-meta text-red-700">{error}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="md" onClick={() => publishPacket(false)} disabled={publishing}>
          {publishing ? "Publishing…" : "Publish"}
        </Button>
        <a href={`/edit/${packetId}`} className={buttonClass("ghost", "md")}>
          ← Back to editor
        </a>
      </div>
    </section>
  );
}
