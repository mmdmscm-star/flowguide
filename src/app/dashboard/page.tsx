"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

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

export default function DashboardPage() {
  const router = useRouter();
  const [packets, setPackets] = useState<PacketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);

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

  async function deletePacket(id: string, title: string) {
    if (!confirm(`Delete "${title || "Untitled Packet"}"? This cannot be undone.`)) return;
    await fetch(`/api/packets/${id}`, { method: "DELETE" });
    loadPackets();
  }

  async function copyLink(slug: string, id: string) {
    const url = `${window.location.origin}/p/${slug}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
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
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Packets</h1>
          <p className="text-sm text-muted mt-0.5">{userEmail}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <button
              onClick={() => setShowNewMenu(!showNewMenu)}
              className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
            >
              New Packet
            </button>
            {showNewMenu && (
              <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-border shadow-lg z-10 overflow-hidden">
                <button
                  onClick={() => { setShowNewMenu(false); router.push("/new"); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-border"
                >
                  <div className="font-medium text-sm text-foreground">Paste &amp; organize with AI</div>
                  <div className="text-xs text-muted mt-0.5">Paste notes, AI structures them</div>
                </button>
                <button
                  onClick={() => { setShowNewMenu(false); createPacket(); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="font-medium text-sm text-foreground">Start blank</div>
                  <div className="text-xs text-muted mt-0.5">Build from scratch</div>
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

      {/* Packet list */}
      {packets.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-4">📦</div>
          <h2 className="text-lg font-semibold text-foreground mb-2">
            No packets yet
          </h2>
          <p className="text-sm text-muted mb-6 max-w-xs mx-auto">
            Create your first packet to share recommendations with a client.
          </p>
          <button
            onClick={() => router.push("/new")}
            className="px-6 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
          >
            Create Your First Packet
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {packets.map((packet) => (
            <div
              key={packet.id}
              className="border border-border rounded-xl p-4 hover:border-accent/30 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <button
                  onClick={() => router.push(`/edit/${packet.id}`)}
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
                    <button
                      onClick={() => copyLink(packet.slug, packet.id)}
                      className="px-3 py-1.5 text-xs font-medium text-accent hover:bg-blue-50 rounded-lg transition-colors"
                    >
                      {copiedId === packet.id ? "Copied!" : "Copy Link"}
                    </button>
                  )}
                  <button
                    onClick={() => deletePacket(packet.id, packet.title)}
                    className="px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
