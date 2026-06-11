"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";

// ============================================================
// Types for editor state
// ============================================================
interface EditorContact {
  name: string;
  phone: string;
  email: string;
  website: string;
}

interface EditorDetail {
  id: string;
  label: string;
  value: string;
}

interface EditorLink {
  id: string;
  url: string;
  label: string;
}

interface EditorPhoto {
  id: string;
  url: string;
}

interface EditorItem {
  id: string;
  sectionId: string;
  title: string;
  address: string;
  description: string;
  notes: string;
  sortOrder: number;
  photos: EditorPhoto[];
  links: EditorLink[];
  details: EditorDetail[];
  contact: EditorContact | null;
}

interface EditorSection {
  id: string;
  title: string;
  description: string;
  sortOrder: number;
}

interface EditorProfile {
  name: string;
  email: string;
  phone: string;
  businessName: string;
}

interface PacketData {
  id: string;
  slug: string;
  title: string;
  clientName: string;
  personalNote: string;
  mapUrl: string;
  rawInput: string;
  status: string;
}

// ============================================================
// Main Editor Component
// ============================================================
export default function PacketEditorPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const packetId = params.id as string;

  const [showAiBanner, setShowAiBanner] = useState(searchParams.get("ai") === "1");
  const [packet, setPacket] = useState<PacketData | null>(null);
  const [sections, setSections] = useState<EditorSection[]>([]);
  const [items, setItems] = useState<EditorItem[]>([]);
  const [profile, setProfile] = useState<EditorProfile>({ name: "", email: "", phone: "", businessName: "" });
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [publishError, setPublishError] = useState("");
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ============================================================
  // Load packet data
  // ============================================================
  const loadPacket = useCallback(async () => {
    const res = await fetch(`/api/packets/${packetId}`);
    if (res.status === 401) { router.push("/login"); return; }
    if (res.status === 404) { router.push("/dashboard"); return; }

    const data = await res.json();
    const p = data.packet;

    setPacket({
      id: p.id,
      slug: p.slug,
      title: p.title || "",
      clientName: p.client_name || "",
      personalNote: p.personal_note || "",
      mapUrl: p.map_url || "",
      rawInput: p.raw_input || "",
      status: p.status,
    });

    setSections(
      (data.sections || []).map((s: Record<string, unknown>) => ({
        id: s.id,
        title: s.title || "",
        description: s.description || "",
        sortOrder: s.sort_order,
      }))
    );

    const editorItems: EditorItem[] = (data.items || []).map((i: Record<string, unknown>) => ({
      id: i.id,
      sectionId: i.section_id,
      title: i.title || "",
      address: i.address || "",
      description: i.description || "",
      notes: i.notes || "",
      sortOrder: i.sort_order,
      photos: (data.photos || [])
        .filter((ph: Record<string, unknown>) => ph.item_id === i.id)
        .map((ph: Record<string, unknown>) => ({ id: ph.id, url: ph.url })),
      links: (data.links || [])
        .filter((l: Record<string, unknown>) => l.item_id === i.id)
        .map((l: Record<string, unknown>) => ({ id: l.id || crypto.randomUUID(), url: l.url || "", label: l.label || "" })),
      details: (data.details || [])
        .filter((d: Record<string, unknown>) => d.item_id === i.id)
        .map((d: Record<string, unknown>) => ({ id: d.id || crypto.randomUUID(), label: d.label || "", value: d.value || "" })),
      contact: (() => {
        const c = (data.contacts || []).find((c: Record<string, unknown>) => c.item_id === i.id);
        return c ? { name: c.name || "", phone: c.phone || "", email: c.email || "", website: c.website || "" } : null;
      })(),
    }));
    setItems(editorItems);

    if (data.profile) {
      setProfile({
        name: data.profile.name || "",
        email: data.profile.email || "",
        phone: data.profile.phone || "",
        businessName: data.profile.business_name || "",
      });
    }

    setLoading(false);
  }, [packetId, router]);

  useEffect(() => { loadPacket(); }, [loadPacket]);

  // ============================================================
  // Auto-save helpers
  // ============================================================
  function debouncedSave(saveFn: () => Promise<void>) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus("saving");
    saveTimerRef.current = setTimeout(async () => {
      try {
        await saveFn();
        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
      }
    }, 1000);
  }

  // ============================================================
  // Packet field updates
  // ============================================================
  function updatePacketField(field: string, value: string) {
    setPacket((prev) => prev ? { ...prev, [field]: value } : prev);
    debouncedSave(() =>
      fetch(`/api/packets/${packetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  // ============================================================
  // Profile updates
  // ============================================================
  function updateProfile(field: string, value: string) {
    setProfile((prev) => ({ ...prev, [field]: value }));
    debouncedSave(() =>
      fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  // ============================================================
  // Section operations
  // ============================================================
  async function addSection() {
    const maxOrder = sections.reduce((max, s) => Math.max(max, s.sortOrder), -1);
    const res = await fetch("/api/sections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packetId, sortOrder: maxOrder + 1 }),
    });
    const data = await res.json();
    if (data.section) {
      setSections((prev) => [
        ...prev,
        { id: data.section.id, title: "", description: "", sortOrder: data.section.sort_order },
      ]);
    }
  }

  function updateSection(sectionId: string, field: string, value: string) {
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, [field]: value } : s)));
    debouncedSave(() =>
      fetch("/api/sections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sectionId, [field]: value }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  async function deleteSection(sectionId: string) {
    const sectionItems = items.filter((i) => i.sectionId === sectionId);
    if (sectionItems.length > 0 && !confirm("Delete this section and all its items?")) return;
    await fetch("/api/sections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sectionId }),
    });
    setSections((prev) => prev.filter((s) => s.id !== sectionId));
    setItems((prev) => prev.filter((i) => i.sectionId !== sectionId));
  }

  // ============================================================
  // Item operations
  // ============================================================
  async function addItem(sectionId: string) {
    const sectionItems = items.filter((i) => i.sectionId === sectionId);
    const maxOrder = sectionItems.reduce((max, i) => Math.max(max, i.sortOrder), -1);
    const res = await fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionId, sortOrder: maxOrder + 1 }),
    });
    const data = await res.json();
    if (data.item) {
      setItems((prev) => [
        ...prev,
        {
          id: data.item.id,
          sectionId,
          title: "",
          address: "",
          description: "",
          notes: "",
          sortOrder: data.item.sort_order,
          photos: [],
          links: [],
          details: [],
          contact: null,
        },
      ]);
    }
  }

  function updateItem(itemId: string, field: string, value: string) {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, [field]: value } : i)));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, [field]: value }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  async function deleteItem(itemId: string) {
    await fetch("/api/items", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId }),
    });
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  }

  // ============================================================
  // Item sub-field operations
  // ============================================================
  function addDetail(itemId: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, details: [...i.details, { id: crypto.randomUUID(), label: "", value: "" }] }
          : i
      )
    );
  }

  function updateDetail(itemId: string, detailId: string, field: "label" | "value", value: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, details: i.details.map((d) => (d.id === detailId ? { ...d, [field]: value } : d)) }
          : i
      )
    );
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const updatedDetails = item.details.map((d) => (d.id === detailId ? { ...d, [field]: value } : d));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, details: updatedDetails.map((d) => ({ label: d.label, value: d.value })) }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  function removeDetail(itemId: string, detailId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const updatedDetails = item.details.filter((d) => d.id !== detailId);
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, details: updatedDetails } : i)));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, details: updatedDetails.map((d) => ({ label: d.label, value: d.value })) }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  function addLink(itemId: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, links: [...i.links, { id: crypto.randomUUID(), url: "", label: "" }] }
          : i
      )
    );
  }

  function updateLink(itemId: string, linkId: string, field: "url" | "label", value: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, links: i.links.map((l) => (l.id === linkId ? { ...l, [field]: value } : l)) }
          : i
      )
    );
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const updatedLinks = item.links.map((l) => (l.id === linkId ? { ...l, [field]: value } : l));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, links: updatedLinks.map((l) => ({ url: l.url, label: l.label })) }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  function removeLink(itemId: string, linkId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const updatedLinks = item.links.filter((l) => l.id !== linkId);
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, links: updatedLinks } : i)));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, links: updatedLinks.map((l) => ({ url: l.url, label: l.label })) }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  function updateItemContact(itemId: string, field: string, value: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? {
              ...i,
              contact: { ...(i.contact || { name: "", phone: "", email: "", website: "" }), [field]: value },
            }
          : i
      )
    );
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const updatedContact = { ...(item.contact || { name: "", phone: "", email: "", website: "" }), [field]: value };
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, contact: updatedContact }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  function toggleItemContact(itemId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    if (item.contact) {
      setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, contact: null } : i)));
      debouncedSave(() =>
        fetch("/api/items", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: itemId, contact: null }),
        }).then((r) => { if (!r.ok) throw new Error(); })
      );
    } else {
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, contact: { name: "", phone: "", email: "", website: "" } }
            : i
        )
      );
    }
  }

  // ============================================================
  // Photo operations
  // ============================================================
  function addPhoto(itemId: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, photos: [...i.photos, { id: crypto.randomUUID(), url: "" }] }
          : i
      )
    );
  }

  function updatePhoto(itemId: string, photoId: string, url: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, photos: i.photos.map((p) => (p.id === photoId ? { ...p, url } : p)) }
          : i
      )
    );
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const updatedPhotos = item.photos.map((p) => (p.id === photoId ? { ...p, url } : p));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, photos: updatedPhotos.map((p) => ({ url: p.url })) }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  function removePhoto(itemId: string, photoId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const updatedPhotos = item.photos.filter((p) => p.id !== photoId);
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, photos: updatedPhotos } : i)));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, photos: updatedPhotos.map((p) => ({ url: p.url })) }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  // ============================================================
  // Publish
  // ============================================================
  async function handlePublish() {
    setPublishError("");
    const res = await fetch(`/api/packets/${packetId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "publish" }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error || "Could not publish";
      setPublishError(errMsg);
      // Scroll to top so user sees the error
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setPacket((prev) => prev ? { ...prev, status: "published" } : prev);
    setShowPublishModal(true);
  }

  async function handleUnpublish() {
    if (!confirm("Unpublish this packet? The link will stop working.")) return;
    await fetch(`/api/packets/${packetId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unpublish" }),
    });
    setPacket((prev) => prev ? { ...prev, status: "draft" } : prev);
  }

  function copyPacketLink() {
    if (!packet) return;
    navigator.clipboard.writeText(`${window.location.origin}/p/${packet.slug}`);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  // ============================================================
  // Render
  // ============================================================
  if (loading || !packet) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </main>
    );
  }

  const sortedSections = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <main className="max-w-2xl mx-auto px-5 py-6 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; My Packets
        </button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">
            {saveStatus === "saving" ? "Saving..." : saveStatus === "error" ? "Save failed" : "Saved"}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              packet.status === "published"
                ? "bg-green-50 text-green-700 border border-green-200"
                : "bg-gray-50 text-gray-600 border border-gray-200"
            }`}
          >
            {packet.status === "published" ? "Published" : "Draft"}
          </span>
        </div>
      </div>

      {/* Publish error */}
      {publishError && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {publishError}
        </div>
      )}

      {/* AI review banner */}
      {showAiBanner && (
        <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800 flex items-center justify-between">
          <span>AI organized your info. Review and edit anything before publishing.</span>
          <button
            onClick={() => setShowAiBanner(false)}
            className="ml-3 text-blue-500 hover:text-blue-700 flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Packet title & client name */}
      <div className="mb-6">
        <input
          type="text"
          value={packet.title}
          onChange={(e) => updatePacketField("title", e.target.value)}
          placeholder="Packet title"
          className="w-full text-2xl font-bold text-foreground bg-transparent border-none outline-none placeholder:text-gray-300"
        />
        <input
          type="text"
          value={packet.clientName}
          onChange={(e) => updatePacketField("clientName", e.target.value)}
          placeholder="Client name (optional)"
          className="w-full mt-1 text-sm text-muted bg-transparent border-none outline-none placeholder:text-gray-300"
        />
      </div>

      {/* Personal note */}
      <div className="mb-8">
        <label className="block text-xs font-medium uppercase tracking-widest text-muted mb-2">
          Personal Note
        </label>
        <textarea
          value={packet.personalNote}
          onChange={(e) => updatePacketField("personalNote", e.target.value)}
          placeholder="Add a personal note for your client..."
          rows={4}
          className="w-full px-3.5 py-3 rounded-lg border border-border bg-white text-sm text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-gray-300"
        />
      </div>

      {/* Map URL */}
      <div className="mb-8">
        <label className="block text-xs font-medium uppercase tracking-widest text-muted mb-2">
          Map Link (optional)
        </label>
        <input
          type="url"
          value={packet.mapUrl}
          onChange={(e) => updatePacketField("mapUrl", e.target.value)}
          placeholder="Paste a Google My Maps or any map link"
          className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-white text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-gray-300"
        />
      </div>

      {/* Sections */}
      {sortedSections.map((section) => {
        const sectionItems = items
          .filter((i) => i.sectionId === section.id)
          .sort((a, b) => a.sortOrder - b.sortOrder);

        return (
          <div key={section.id} className="mb-8 border border-border rounded-xl p-4">
            {/* Section header */}
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="flex-1">
                <input
                  type="text"
                  value={section.title}
                  onChange={(e) => updateSection(section.id, "title", e.target.value)}
                  placeholder="Section title"
                  className="w-full text-lg font-bold text-foreground bg-transparent border-none outline-none placeholder:text-gray-300"
                />
                <input
                  type="text"
                  value={section.description}
                  onChange={(e) => updateSection(section.id, "description", e.target.value)}
                  placeholder="Section description (optional)"
                  className="w-full mt-0.5 text-sm text-muted bg-transparent border-none outline-none placeholder:text-gray-300"
                />
              </div>
              <button
                onClick={() => deleteSection(section.id)}
                className="text-xs text-red-400 hover:text-red-600 mt-1 flex-shrink-0"
              >
                Delete
              </button>
            </div>

            {/* Items */}
            <div className="space-y-3">
              {sectionItems.map((item) => (
                <ItemEditor
                  key={item.id}
                  item={item}
                  onUpdateField={updateItem}
                  onDelete={deleteItem}
                  onAddDetail={addDetail}
                  onUpdateDetail={updateDetail}
                  onRemoveDetail={removeDetail}
                  onAddLink={addLink}
                  onUpdateLink={updateLink}
                  onRemoveLink={removeLink}
                  onToggleContact={toggleItemContact}
                  onUpdateContact={updateItemContact}
                  onAddPhoto={addPhoto}
                  onUpdatePhoto={updatePhoto}
                  onRemovePhoto={removePhoto}
                />
              ))}
            </div>

            <button
              onClick={() => addItem(section.id)}
              className="mt-3 text-sm text-accent hover:text-accent-hover font-medium"
            >
              + Add Item
            </button>
          </div>
        );
      })}

      <button
        onClick={addSection}
        className="w-full py-3 border-2 border-dashed border-border rounded-xl text-sm font-medium text-muted hover:text-accent hover:border-accent transition-colors mb-8"
      >
        + Add Section
      </button>

      {/* Original input (collapsible, read-only) */}
      {packet.rawInput && (
        <OriginalInput text={packet.rawInput} />
      )}

      {/* Professional contact */}
      <div className="mb-8 border border-border rounded-xl p-4">
        <label className="block text-xs font-medium uppercase tracking-widest text-muted mb-3">
          Your Contact Information
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            value={profile.name}
            onChange={(e) => updateProfile("name", e.target.value)}
            placeholder="Your name"
            className="px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            type="text"
            value={profile.businessName}
            onChange={(e) => updateProfile("businessName", e.target.value)}
            placeholder="Business name (optional)"
            className="px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            type="email"
            value={profile.email}
            onChange={(e) => updateProfile("email", e.target.value)}
            placeholder="Email"
            className="px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            type="tel"
            value={profile.phone}
            onChange={(e) => updateProfile("phone", e.target.value)}
            placeholder="Phone"
            className="px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      {/* Action bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border px-5 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <button
            onClick={() => window.open(`/preview/${packet.id}`, "_blank")}
            className="text-sm text-accent hover:text-accent-hover font-medium"
          >
            Preview
          </button>
          <div className="flex items-center gap-2">
            {packet.status === "published" && (
              <>
                <button
                  onClick={copyPacketLink}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-accent bg-blue-50 hover:bg-blue-100 border border-blue-100 transition-colors"
                >
                  {copiedLink ? "Copied!" : "Copy Link"}
                </button>
                <button
                  onClick={handleUnpublish}
                  className="text-sm text-muted hover:text-red-500 transition-colors"
                >
                  Unpublish
                </button>
              </>
            )}
            {packet.status === "draft" && (
              <button
                onClick={handlePublish}
                className="px-6 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
              >
                Publish
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Publish success modal */}
      {showPublishModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-5">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full text-center">
            <div className="text-4xl mb-3">🎉</div>
            <h2 className="text-xl font-bold text-foreground mb-2">Your packet is live!</h2>
            <p className="text-sm text-muted mb-4">Share this link with your client:</p>
            <div className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-foreground mb-4 break-all">
              {typeof window !== "undefined" ? `${window.location.origin}/p/${packet.slug}` : ""}
            </div>
            <button
              onClick={() => {
                copyPacketLink();
                setShowPublishModal(false);
              }}
              className="w-full px-4 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors mb-2"
            >
              Copy Link
            </button>
            <button
              onClick={() => setShowPublishModal(false)}
              className="text-sm text-muted hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

// ============================================================
// Item Editor Component
// ============================================================
function ItemEditor({
  item,
  onUpdateField,
  onDelete,
  onAddDetail,
  onUpdateDetail,
  onRemoveDetail,
  onAddLink,
  onUpdateLink,
  onRemoveLink,
  onToggleContact,
  onUpdateContact,
  onAddPhoto,
  onUpdatePhoto,
  onRemovePhoto,
}: {
  item: EditorItem;
  onUpdateField: (id: string, field: string, value: string) => void;
  onDelete: (id: string) => void;
  onAddDetail: (itemId: string) => void;
  onUpdateDetail: (itemId: string, detailId: string, field: "label" | "value", value: string) => void;
  onRemoveDetail: (itemId: string, detailId: string) => void;
  onAddLink: (itemId: string) => void;
  onUpdateLink: (itemId: string, linkId: string, field: "url" | "label", value: string) => void;
  onRemoveLink: (itemId: string, linkId: string) => void;
  onToggleContact: (itemId: string) => void;
  onUpdateContact: (itemId: string, field: string, value: string) => void;
  onAddPhoto: (itemId: string) => void;
  onUpdatePhoto: (itemId: string, photoId: string, url: string) => void;
  onRemovePhoto: (itemId: string, photoId: string) => void;
}) {
  const [expanded, setExpanded] = useState(
    !!(item.address || item.description || item.notes || item.details.length || item.links.length || item.photos.length || item.contact)
  );

  return (
    <div className="border border-border rounded-lg p-3 bg-white">
      <div className="flex items-start justify-between gap-2">
        <input
          type="text"
          value={item.title}
          onChange={(e) => onUpdateField(item.id, "title", e.target.value)}
          placeholder="Item title"
          className="flex-1 font-medium text-sm text-foreground bg-transparent border-none outline-none placeholder:text-gray-300"
        />
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted hover:text-foreground px-1"
          >
            {expanded ? "▾" : "▸"}
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="text-xs text-red-400 hover:text-red-600 px-1"
          >
            ×
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Address */}
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-sm flex-shrink-0">📍</span>
            <input
              type="text"
              value={item.address}
              onChange={(e) => onUpdateField(item.id, "address", e.target.value)}
              placeholder="Address (auto-links to Google Maps)"
              className="flex-1 px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
            />
          </div>

          {/* Description */}
          <textarea
            value={item.description}
            onChange={(e) => onUpdateField(item.id, "description", e.target.value)}
            placeholder="Description"
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-border text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
          />

          {/* Details */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted uppercase tracking-wide">Details</span>
              <button onClick={() => onAddDetail(item.id)} className="text-xs text-accent hover:text-accent-hover">
                + Add
              </button>
            </div>
            {item.details.map((detail) => (
              <div key={detail.id} className="flex gap-2 mb-1.5">
                <input
                  type="text"
                  value={detail.label}
                  onChange={(e) => onUpdateDetail(item.id, detail.id, "label", e.target.value)}
                  placeholder="Label"
                  className="flex-1 px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
                <input
                  type="text"
                  value={detail.value}
                  onChange={(e) => onUpdateDetail(item.id, detail.id, "value", e.target.value)}
                  placeholder="Value"
                  className="flex-1 px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
                <button
                  onClick={() => onRemoveDetail(item.id, detail.id)}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Links */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted uppercase tracking-wide">Links</span>
              <button onClick={() => onAddLink(item.id)} className="text-xs text-accent hover:text-accent-hover">
                + Add
              </button>
            </div>
            {item.links.map((link) => (
              <div key={link.id} className="flex gap-2 mb-1.5">
                <input
                  type="url"
                  value={link.url}
                  onChange={(e) => onUpdateLink(item.id, link.id, "url", e.target.value)}
                  placeholder="https://..."
                  className="flex-[2] px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
                <input
                  type="text"
                  value={link.label}
                  onChange={(e) => onUpdateLink(item.id, link.id, "label", e.target.value)}
                  placeholder="Label"
                  className="flex-1 px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
                <button
                  onClick={() => onRemoveLink(item.id, link.id)}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Photos */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted uppercase tracking-wide">Photos</span>
              <button onClick={() => onAddPhoto(item.id)} className="text-xs text-accent hover:text-accent-hover">
                + Add
              </button>
            </div>
            {/* Thumbnail grid for photos that have URLs */}
            {item.photos.some((p) => p.url && p.url.startsWith("http")) && (
              <div className="flex flex-wrap gap-2 mb-2">
                {item.photos
                  .filter((p) => p.url && p.url.startsWith("http"))
                  .map((photo) => (
                    <div key={photo.id} className="relative group">
                      <img
                        src={photo.url}
                        alt=""
                        className="w-16 h-16 rounded-lg object-cover border border-border"
                      />
                      <button
                        onClick={() => onRemovePhoto(item.id, photo.id)}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    </div>
                  ))}
              </div>
            )}
            {/* Input row for photos that are empty (newly added) */}
            {item.photos
              .filter((p) => !p.url || !p.url.startsWith("http"))
              .map((photo) => (
                <div key={photo.id} className="flex gap-2 mb-1.5 items-center">
                  <input
                    type="url"
                    value={photo.url}
                    onChange={(e) => onUpdatePhoto(item.id, photo.id, e.target.value)}
                    placeholder="Paste image URL..."
                    autoFocus
                    className="flex-1 px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                  />
                  <button
                    onClick={() => onRemovePhoto(item.id, photo.id)}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>

          {/* Notes */}
          <textarea
            value={item.notes}
            onChange={(e) => onUpdateField(item.id, "notes", e.target.value)}
            placeholder="Notes (shown as a highlighted callout)"
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-amber-300 placeholder:text-amber-300"
          />

          {/* Contact */}
          <div>
            <button
              onClick={() => onToggleContact(item.id)}
              className="text-xs text-accent hover:text-accent-hover font-medium"
            >
              {item.contact ? "Remove contact" : "+ Add contact info"}
            </button>
            {item.contact && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <input
                  type="text"
                  value={item.contact.name}
                  onChange={(e) => onUpdateContact(item.id, "name", e.target.value)}
                  placeholder="Contact name"
                  className="px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
                <input
                  type="tel"
                  value={item.contact.phone}
                  onChange={(e) => onUpdateContact(item.id, "phone", e.target.value)}
                  placeholder="Phone"
                  className="px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
                <input
                  type="email"
                  value={item.contact.email}
                  onChange={(e) => onUpdateContact(item.id, "email", e.target.value)}
                  placeholder="Email"
                  className="px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
                <input
                  type="url"
                  value={item.contact.website}
                  onChange={(e) => onUpdateContact(item.id, "website", e.target.value)}
                  placeholder="Website"
                  className="px-2.5 py-1.5 rounded border border-border text-xs focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Original Input (collapsible, read-only)
// ============================================================
function OriginalInput({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-8 border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-xs font-medium uppercase tracking-widest text-muted">
          Original Input
        </span>
        <span className="text-xs text-muted">{open ? "▾ Hide" : "▸ Show"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <pre className="text-xs text-muted leading-relaxed whitespace-pre-wrap font-sans bg-gray-50 rounded-lg p-3 max-h-64 overflow-y-auto">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
