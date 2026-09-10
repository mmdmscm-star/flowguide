"use client";
import { FilterChip, ChipCount, CHIP_ROW } from "@/components/ui/chip";
import { CreatorNav } from "@/components/nav/creator-nav";
import { Button } from "@/components/ui/button";
import { INPUT_SHELL } from "@/components/ui/field";

import { useEffect, useState, useCallback } from "react";
import { deleteConfirmMessage, deletePacketRequest } from "@/lib/delete-packet";
import { useRouter } from "next/navigation";
import { filterPackets, isPublished, type StatusFilter } from "@/lib/packet-filter";

interface PacketSummary {
  id: string;
  slug: string;
  title: string;
  client_name: string;
  status: string;
  viewed: boolean;
  created_at: string;
  updated_at: string;
}

// The first-run identity prompt is NOT here. It lives in the server shell so it
// appears immediately rather than waiting behind this component's loading gate,
// which means this component needs to know nothing about it.
export default function DashboardWorkspace() {
  const router = useRouter();
  const [packets, setPackets] = useState<PacketSummary[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  // FINDING, not fetching. The list is already fully loaded, so filtering it
  // client-side needs no API and no schema change - and it stays instant, which
  // an unbounded list that only ever grows benefits from more than pagination
  // would. Ordering is untouched: whatever survives the filter stays in
  // updated_at order.
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const visiblePackets = filterPackets(packets, query, statusFilter);

  const loadPackets = useCallback(async () => {
    const res = await fetch("/api/packets");
    if (res.status === 401) {
      router.push("/login");
      return;
    }
    const data = await res.json();
    setPackets(data.packets || []);
    setLoading(false);
  }, [router]);

  useEffect(() => {
    loadPackets();
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) setUserEmail(d.user.email);
        else router.push("/login");
      });
  }, [loadPackets, router]);

  async function createPacket() {
    const res = await fetch("/api/packets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    const data = await res.json();
    if (data.packet) {
      router.push(`/edit/${data.packet.id}`);
    }
  }

  // THE SAME mechanism the editors use: same confirmation wording, same request
  // helper. Previously this discarded the response entirely — a 500 or a 401
  // was indistinguishable from success, because the list simply reloaded with
  // the packet still in it and nothing said why.
  async function deletePacket(packet: PacketSummary) {
    if (!confirm(deleteConfirmMessage({
      title: packet.title,
      clientName: packet.client_name,
      status: packet.status,
      createdAt: packet.created_at,
    }))) return;

    setDeleteError("");
    try {
      await deletePacketRequest(packet.id);
      loadPackets();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete that Sendset.");
    }
  }

  async function duplicatePacket(id: string) {
    if (duplicatingId) return;
    setDuplicatingId(id);
    try {
      const res = await fetch(`/api/packets/${id}/duplicate`, { method: "POST" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `Duplicate failed (${res.status})`);
      }
      const data = await res.json();
      if (!data.packet?.id) throw new Error("Duplicate failed: no packet returned.");
      // Navigate to the editor for the new draft copy (component unmounts on success)
      router.push(`/edit/${data.packet.id}`);
    } catch (err) {
      setDuplicatingId(null);
      alert(err instanceof Error ? err.message : "Could not duplicate this Sendset. Please try again.");
    }
  }

  async function copyLink(slug: string, id: string) {
    const url = `${window.location.origin}/p/${slug}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
    // Long enough to read the sharing warning shown below the packet's actions.
    setTimeout(() => setCopiedId(null), 6000);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-canvas">
        <p className="text-body text-ink-3">Loading…</p>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      {/* THE SAME CHROME AS EVERY OTHER CREATOR SURFACE.
          The Dashboard was the one top-level authoring screen NOT wearing
          CreatorNav: Library and Your details were buttons in its own header,
          so moving between the two surfaces changed where navigation lived and
          what it looked like. Same nav, same sticky treatment, same boundary.
          Sign out takes the right end — it is the one thing here that leaves
          the workspace entirely, and it is the only item the shared nav has no
          place for. */}
      <div className="sticky top-0 z-20 bg-canvas/85 backdrop-blur-sm border-b border-line">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-2 sm:py-3.5 flex items-center gap-2 sm:gap-3">
          <CreatorNav
            current="packets"
            trailing={
              <button
                onClick={handleLogout}
                className="flex h-11 items-center whitespace-nowrap rounded-[var(--radius-control)] px-3
                           text-body text-ink-3 transition-colors hover:bg-ground-3 hover:text-ink
                           sm:h-auto sm:px-0 sm:text-meta sm:hover:bg-transparent"
              >
                Sign out
              </button>
            }
          />
        </div>
      </div>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 pb-28">
        <header className="pt-10 pb-4">
          <h1 className="text-page font-semibold tracking-[-0.02em] text-ink">My Sendsets</h1>
          {/* WHOSE workspace this is. It was the same size as the page's body
              text and read as a line of content; it is a quiet attribution. */}
          <p className="mt-2 text-meta text-ink-3">{userEmail}</p>
        </header>

        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="relative">
            <Button
              variant="primary"
              size="md"
              onClick={() => setShowNewMenu(!showNewMenu)}
            >
              New Sendset
            </Button>
            {showNewMenu && (
              <div className="absolute left-0 top-full mt-2 w-72 bg-ground rounded-[var(--radius-panel)] border border-line
                              shadow-[0_12px_40px_-12px_rgb(26_26_28_/_0.28)] z-10 overflow-hidden divide-y divide-line">
                {/* ONE COMPOSER, REACHED FROM BOTH DOORS.
                    This used to open a modal picker: a second implementation of
                    the same job, with its own selection state, its own filters
                    and its own Create. Once the Library grew a real composition
                    workspace — two panes, drag or Add, an ordered tray — the
                    modal was the older of two answers to one question, and the
                    professional's experience depended on which door they came
                    through. So this now goes to the same place. */}
                <button
                  onClick={() => { setShowNewMenu(false); router.push("/library?compose=1"); }}
                  className="w-full text-left px-4 py-3 hover:bg-ground-3 transition-colors"
                >
                  <div className="text-body font-medium text-ink">Use my Library</div>
                  <div className="mt-0.5 text-meta text-ink-2">Choose things you’ve already saved</div>
                </button>
                <button
                  onClick={() => { setShowNewMenu(false); router.push("/new"); }}
                  className="w-full text-left px-4 py-3 hover:bg-ground-3 transition-colors"
                >
                  <div className="text-body font-medium text-ink">Paste &amp; organize with AI</div>
                  <div className="mt-0.5 text-meta text-ink-2">Start with information you already have</div>
                </button>
                <button
                  onClick={() => { setShowNewMenu(false); createPacket(); }}
                  className="w-full text-left px-4 py-3 hover:bg-ground-3 transition-colors"
                >
                  <div className="text-body font-medium text-ink">Start blank</div>
                  <div className="mt-0.5 text-meta text-ink-2">Build from scratch</div>
                </button>
              </div>
            )}
          </div>
        </div>

      {/* ONE SURFACE, THE WAY THE LIBRARY IS ONE SURFACE.
          Search, the status filters and the list were three blocks sitting
          directly on the page at the same elevation as the heading above them.
          The controls that narrow the list now sit inside the thing they
          narrow, on a quiet band, divided from the results by the one line
          that earns itself: above it you change what you are looking at, below
          it is what you got. */}
      <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-ground">
        {/* Shown only once there is something to sift through — a search box
            above an empty account is furniture. */}
        {packets.length > 0 && (
          <div className="border-b border-line bg-ground-2 px-3 sm:px-4 py-3.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your Sendsets…"
              aria-label="Search your Sendsets"
              className={INPUT_SHELL}
            />
            {/* THE SAME CHIP THE LIBRARY WEARS — the component, not a
                lookalike. These were a second spelling of it, which is how the
                Library's chips ended up 44px tall on a phone while these
                stayed 34. */}
            <div className={`-mx-3 mt-2.5 px-3 sm:mx-0 sm:px-0 ${CHIP_ROW}`}
                 role="group" aria-label="Filter by status">
              {([
                ["all", "All", packets.length],
                ["draft", "Drafts", packets.filter((p) => !isPublished(p)).length],
                ["published", "Published", packets.filter(isPublished).length],
              ] as const).map(([value, label, count]) => (
                <FilterChip
                  key={value}
                  active={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                  label={`${label} — ${count}`}
                >
                  {label}
                  <ChipCount active={statusFilter === value}>{count}</ChipCount>
                </FilterChip>
              ))}
            </div>
          </div>
        )}
        <div className="px-1 sm:px-2.5 py-3">

      {/* Packet list */}
      {deleteError && (
        <p role="alert" className="mx-2 mb-3 rounded-[var(--radius-control)] bg-red-50 px-3 py-2 text-meta text-red-700">
          {deleteError}
        </p>
      )}

      {packets.length === 0 ? (
        /* NO EMOJI. A 4xl 📦 was the largest and most saturated thing a new
           professional saw on their first screen, and it said nothing the
           heading below it did not. The empty state is now the same quiet
           centred block the Library uses. */
        <div className="px-3 py-16 text-center">
          <h2 className="text-title font-semibold text-ink">No Sendsets yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-body text-ink-2">
            Create your first Sendset to share recommendations with a client.
          </p>
          <Button variant="primary" size="md" className="mt-5"
            onClick={() => router.push("/new")}>
            Create your first Sendset
          </Button>
        </div>
      ) : visiblePackets.length === 0 ? (
        // NOT the same as having no FlowGuides. Saying "none yet" here would be
        // a lie about the account, and the way out is to clear the filter, so
        // the way out is what this offers.
        <div className="px-3 py-12 text-center">
          <p className="text-body text-ink-2">
            {query.trim()
              ? <>Nothing matches “{query.trim()}”{statusFilter !== "all" ? " in this view" : ""}.</>
              : <>You have no {statusFilter === "published" ? "published" : "draft"} Sendsets.</>}
          </p>
          <Button variant="secondary" size="sm" className="mt-4"
            onClick={() => { setQuery(""); setStatusFilter("all"); }}>
            Clear filters
          </Button>
        </div>
      ) : (
        /* A LIST, NOT A STACK OF CARDS. Every row carried its own outline, so
           six Sendsets read as six containers. The row is a plain surface that
           lifts on hover, exactly as a Library row does. */
        <div className="space-y-0.5">
          {visiblePackets.map((packet) => (
            <div
              key={packet.id}
              className="rounded-[var(--radius-control)] px-3 py-3.5 transition-colors hover:bg-ground-3"
            >
              {/* THE ACTIONS STOP COMPETING WITH THE NAME ON A PHONE.
                  Four controls beside a title in 390px left the title with
                  almost nothing — "Santa Rosa — large communities" rendered as
                  "S…". Side by side where there is room; underneath where
                  there is not. Every action stays present either way. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <button
                  onClick={() =>
                    router.push(
                      packet.status === "published"
                        ? `/p/${packet.slug}`
                        : `/edit/${packet.id}`
                    )
                  }
                  className="text-left flex-1 min-w-0"
                >
                  <h3 className="truncate text-body font-medium text-ink">
                    {packet.title || "Untitled Packet"}
                  </h3>
                  {packet.client_name && (
                    <p className="truncate text-meta text-ink-2">
                      For {packet.client_name}
                    </p>
                  )}
                  {/* FOUR BORDERED PILLS IN A ROW WAS THE DENSEST THING ON THE
                      SCREEN, and three of the four were saying "ordinary".
                      Draft and Not yet viewed are the resting states of every
                      Sendset, so they are now quiet text on the meta line.
                      Colour is spent on the two facts that are actually events:
                      it went out, and someone opened it. Viewed is the one blue
                      thing on this screen, which is what makes it worth
                      looking at. */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-micro text-ink-3">
                    <span>Updated {formatDate(packet.updated_at)}</span>
                    <span aria-hidden>·</span>
                    <span className={`rounded-full px-2 py-0.5 font-medium ${
                      packet.status === "published"
                        ? "bg-emerald-50 text-emerald-800"
                        : "bg-ground-3 text-ink-2"
                    }`}>
                      {packet.status === "published" ? "Published" : "Draft"}
                    </span>
                    {packet.status === "published" && (
                      <span className={`rounded-full px-2 py-0.5 font-medium ${
                        packet.viewed
                          ? "bg-mark-soft text-mark"
                          : "bg-ground-3 text-ink-3"
                      }`}>
                        {packet.viewed ? "Viewed" : "Not yet viewed"}
                      </span>
                    )}
                  </div>
                </button>
                {/* FOUR ACTIONS AT THE SAME WEIGHT, AND DELETE IN RED, meant
                    the most destructive one was also the most visible thing on
                    every row. They are one family now, and Delete only stops
                    being quiet when the pointer is on it. */}
                <div className="-ml-2 flex flex-wrap items-center gap-0.5 sm:ml-0 sm:flex-none">
                  {packet.status === "published" && (
                    <>
                      <Button variant="ghost" size="sm"
                        onClick={() => router.push(`/edit/${packet.id}`)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm"
                        onClick={() => copyLink(packet.slug, packet.id)}
                        title="Anyone with this link can open the packet — no sign-in required.">
                        {copiedId === packet.id ? "Copied!" : "Copy link"}
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="sm"
                    onClick={() => duplicatePacket(packet.id)}
                    disabled={duplicatingId === packet.id}>
                    {duplicatingId === packet.id ? "Duplicating…" : "Duplicate"}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => deletePacket(packet)}>
                    Delete
                  </Button>
                </div>
              </div>
              {copiedId === packet.id && (
                /* KEPT AMBER, and kept its emphasis. This is the same class of
                   thing as Highlight for Client: it says something left the
                   workspace and is now readable by anyone holding the link.
                   That is worth more voice than the rest of the row. */
                <p className="mt-3 rounded-[var(--radius-control)] bg-amber-50 px-3 py-2 text-meta text-amber-900">
                  Link copied. Anyone with this link can view and forward the
                  packet. No sign-in is required.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
        </div>
      </div>
      </main>
    </div>
  );
}
