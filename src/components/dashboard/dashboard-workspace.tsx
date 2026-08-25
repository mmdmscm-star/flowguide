"use client";

import { useEffect, useState, useCallback } from "react";
import { deleteConfirmMessage, deletePacketRequest } from "@/lib/delete-packet";
import { useRouter } from "next/navigation";
import { UseLibraryPicker } from "@/components/library/use-library-picker";
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
  const [useLibrary, setUseLibrary] = useState(false);
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
      setDeleteError(e instanceof Error ? e.message : "Could not delete that FlowGuide.");
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
      alert(err instanceof Error ? err.message : "Could not duplicate this FlowGuide. Please try again.");
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
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-5 py-8">
      {useLibrary && <UseLibraryPicker onClose={() => setUseLibrary(false)} />}

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My FlowGuides</h1>
          <p className="text-sm text-muted mt-0.5">{userEmail}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* The Library is authoring-side and packet-independent, so it belongs
              at the top level rather than inside a packet. */}
          <button
            onClick={() => router.push("/library")}
            className="px-3 py-2 rounded-lg border border-border text-sm font-medium text-muted hover:text-foreground transition-colors"
          >
            Library
          </button>
          {/* Reachable whether or not there is a gap: the prompt above appears
              only while the profile is unpublishable, and a professional who
              has filled it in still needs a way back to change a phone number. */}
          <button
            onClick={() => router.push("/settings")}
            className="px-3 py-2 rounded-lg border border-border text-sm font-medium text-muted hover:text-foreground transition-colors"
          >
            Your details
          </button>
          <div className="relative">
            <button
              onClick={() => setShowNewMenu(!showNewMenu)}
              className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
            >
              New FlowGuide
            </button>
            {showNewMenu && (
              <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-border shadow-lg z-10 overflow-hidden">
                <button
                  onClick={() => { setShowNewMenu(false); setUseLibrary(true); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-border"
                >
                  <div className="font-medium text-sm text-foreground">Use my Library</div>
                  <div className="text-sm text-muted mt-0.5">Choose things you’ve already saved</div>
                </button>
                <button
                  onClick={() => { setShowNewMenu(false); router.push("/new"); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-border"
                >
                  <div className="font-medium text-sm text-foreground">Paste &amp; organize with AI</div>
                  <div className="text-sm text-muted mt-0.5">Start with information you already have</div>
                </button>
                <button
                  onClick={() => { setShowNewMenu(false); createPacket(); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="font-medium text-sm text-foreground">Start blank</div>
                  <div className="text-sm text-muted mt-0.5">Build from scratch</div>
                </button>
              </div>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Search and status filter. Shown only once there is something to sift
          through - a search box above an empty account is furniture. */}
      {packets.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your FlowGuides…"
            aria-label="Search your FlowGuides"
            className="flex-1 px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex items-center gap-1" role="group" aria-label="Filter by status">
            {([
              ["all", "All", packets.length],
              ["draft", "Drafts", packets.filter((p) => !isPublished(p)).length],
              ["published", "Published", packets.filter(isPublished).length],
            ] as const).map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                aria-pressed={statusFilter === value}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  statusFilter === value
                    ? "bg-accent text-white"
                    : "border border-border text-muted hover:text-foreground"
                }`}
              >
                {label} {count}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Packet list */}
      {deleteError && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {deleteError}
        </p>
      )}

      {packets.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-4">📦</div>
          <h2 className="text-lg font-semibold text-foreground mb-2">
            No FlowGuides yet
          </h2>
          <p className="text-sm text-muted mb-6 max-w-xs mx-auto">
            Create your first FlowGuide to share recommendations with a client.
          </p>
          <button
            onClick={() => router.push("/new")}
            className="px-6 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
          >
            Create your first FlowGuide
          </button>
        </div>
      ) : visiblePackets.length === 0 ? (
        // NOT the same as having no FlowGuides. Saying "none yet" here would be
        // a lie about the account, and the way out is to clear the filter, so
        // the way out is what this offers.
        <div className="text-center py-12">
          <p className="text-sm text-muted">
            {query.trim()
              ? <>Nothing matches “{query.trim()}”{statusFilter !== "all" ? " in this view" : ""}.</>
              : <>You have no {statusFilter === "published" ? "published" : "draft"} FlowGuides.</>}
          </p>
          <button
            onClick={() => { setQuery(""); setStatusFilter("all"); }}
            className="mt-3 px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-muted hover:text-foreground"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {visiblePackets.map((packet) => (
            <div
              key={packet.id}
              className="border border-border rounded-xl p-4 hover:border-accent/30 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
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
                  <h3 className="font-semibold text-foreground truncate">
                    {packet.title || "Untitled Packet"}
                  </h3>
                  {packet.client_name && (
                    <p className="text-sm text-muted truncate">
                      For {packet.client_name}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted">
                    <span>Updated {formatDate(packet.updated_at)}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-medium ${
                        packet.status === "published"
                          ? "bg-green-50 text-green-700 border border-green-200"
                          : "bg-gray-50 text-gray-600 border border-gray-200"
                      }`}
                    >
                      {packet.status === "published" ? "Published" : "Draft"}
                    </span>
                    {packet.status === "published" && (
                      <span
                        className={`px-2 py-0.5 rounded-full font-medium ${
                          packet.viewed
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : "bg-gray-50 text-gray-500 border border-gray-200"
                        }`}
                      >
                        {packet.viewed ? "Viewed" : "Not yet viewed"}
                      </span>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {packet.status === "published" && (
                    <>
                      <button
                        onClick={() => router.push(`/edit/${packet.id}`)}
                        className="px-3 py-1.5 text-xs font-medium text-muted hover:text-accent hover:bg-blue-50 rounded-lg transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => copyLink(packet.slug, packet.id)}
                        title="Anyone with this link can open the packet — no sign-in required."
                        className="px-3 py-1.5 text-xs font-medium text-accent hover:bg-blue-50 rounded-lg transition-colors"
                      >
                        {copiedId === packet.id ? "Copied!" : "Copy Link"}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => duplicatePacket(packet.id)}
                    disabled={duplicatingId === packet.id}
                    className="px-3 py-1.5 text-xs font-medium text-muted hover:text-accent hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {duplicatingId === packet.id ? "Duplicating…" : "Duplicate"}
                  </button>
                  <button
                    onClick={() => deletePacket(packet)}
                    className="px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {copiedId === packet.id && (
                <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Link copied. Anyone with this link can view and forward the
                  packet. No sign-in is required.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
