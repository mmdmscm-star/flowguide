"use client";
import { INPUT_SHELL } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import ImageUploadField from "./image-upload-field";
import ProfessionalProfileFields from "./professional-profile-fields";
import DeletePacketAction from "./delete-packet-action";
import { PHOTO_ACCEPT_ATTR } from "@/lib/photo-upload";
import { packetMapUrl } from "@/lib/maps-url";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { CompositionModeControl } from "@/components/editor/composition-mode-control";
import ImportProgress from "@/components/ImportProgress";
import OwnershipDecisions from "@/components/OwnershipDecisions";
import { LibraryPicker } from "@/components/library/library-picker";
import { titleLabelFor } from "@/lib/picture-item";
import { uploadCreatorImage } from "@/lib/image-upload-client";
import { BulkPromote } from "@/components/library/bulk-promote";
import { ItemLibraryActions } from "@/components/library/item-library-actions";
import { CreatorNav } from "@/components/nav/creator-nav";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { moveDetail, detailsPayload } from "@/lib/detail-order";

// ============================================================
// Types for editor state
// ============================================================
interface EditorContact {
  id: string;
  name: string;
  role: string;
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
  highlight: string;
  sortOrder: number;
  libraryItemId?: string | null;
  photos: EditorPhoto[];
  links: EditorLink[];
  details: EditorDetail[];
  contacts: EditorContact[];
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
  logoUrl: string;
  headshotUrl: string;
  footerLabel: string;
  websiteUrl: string;
  links: { label: string; url: string }[];
}

// A blank custom identity — a full peer of the account profile, but packet-owned.
// Starts empty (including a blank footer label, so no eyebrow shows by default).
const EMPTY_IDENTITY: EditorProfile = {
  name: "",
  email: "",
  phone: "",
  businessName: "",
  logoUrl: "",
  headshotUrl: "",
  footerLabel: "",
  websiteUrl: "",
  links: [],
};

type IdentityMode = "default" | "none" | "custom";

interface PacketData {
  id: string;
  slug: string;
  /** The professional's own name for this FlowGuide. Backstage only. */
  title: string;
  /** The optional heading a client sees. Blank omits it. */
  clientTitle: string;
  clientName: string;
  personalNote: string;
  mapUrl: string;
  rawInput: string;
  status: string;
  identityMode: IdentityMode;
  customIdentity: EditorProfile | null;
  showQuickNav: boolean;
  createdAt: string;
}

// ============================================================
// Main Editor Component
// ============================================================
// Library actions for a whole packet, shown in BOTH editors so reuse does not
// depend on composition mode. Both are explicitly user-initiated: nothing is
// saved or inserted without the professional opening one of these and choosing.
function LibraryBar({ packetId, sectionId, disabled, itemCount, refreshKey, onSaveItems, onNotice, onRefresh }: {
  packetId: string; sectionId?: string; disabled?: boolean;
  /** How many items this FlowGuide has right now. Saving is only meaningful when
   *  there is something to save, and the bar should say so rather than opening a
   *  modal that reports the same thing one click later. */
  itemCount: number;
  /** Bumped after a save so the bar re-learns whether the Library is still empty. */
  refreshKey: number;
  /** Bulk save lives in the editor, because it is offered from two moments —
   *  here, and again where the work actually finishes. */
  onSaveItems: () => void;
  onNotice: (m: string) => void;
  /** Reload packet content. Inserted items are real rows the editor has not read
   *  yet, so without this the professional is told something was added and sees
   *  nothing — the worst possible pairing. */
  onRefresh: () => void;
}) {
  const [picker, setPicker] = useState(false);
  // Whether this professional has saved ANYTHING yet, which decides which action
  // leads. The first version of this bar always led with "Add from Library" as a
  // filled accent button — so a professional with an empty Library saw a loud
  // control that opens an empty list, while the only action that could populate
  // that list sat beside it as plain text. Precedence now follows the state.
  const [hasSaved, setHasSaved] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/library");
        const data = await res.json();
        if (live && res.ok) setHasSaved((data.items ?? []).length > 0);
      } catch {
        // Unknown, so the bar stays in its reuse-first default rather than
        // telling a professional their Library is empty on a failed request.
      }
    })();
    return () => { live = false; };
  }, [refreshKey]);

  const empty = hasSaved === false;
  const PRIMARY = "flex-none px-3 py-1.5 rounded-[var(--radius-control)] bg-ink hover:bg-ink/90 text-white text-body font-medium disabled:opacity-60";
  const SECONDARY = "flex-none px-3 py-1.5 rounded-[var(--radius-control)] border border-line bg-ground text-body font-medium text-ink hover:border-mark hover:text-mark disabled:opacity-60";

  const addBtn = (
    <button key="add" onClick={() => setPicker(true)} disabled={disabled || empty}
      title={empty ? "You have not saved anything yet" : undefined}
      className={empty ? SECONDARY : PRIMARY}>
      Choose from Library
    </button>
  );
  const saveBtn = (
    <button key="save" onClick={onSaveItems} disabled={disabled || itemCount === 0}
      title={itemCount === 0 ? "Add something first" : undefined}
      className={empty ? PRIMARY : SECONDARY}>
      Save to Library
    </button>
  );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 p-3 rounded-[var(--radius-control)] border border-line bg-ground">
      <div className="min-w-[12rem] flex-1">
        <p className="text-body font-medium text-ink">Library</p>
        <p className="text-meta text-ink-2">
          {empty
            ? "Nothing saved yet. Save something here to reuse it in your next Sendset."
            : "Reuse something you saved, or save one of these for next time."}
        </p>
      </div>
      {empty ? [saveBtn, addBtn] : [addBtn, saveBtn]}
      {picker && (
        <LibraryPicker packetId={packetId} sectionId={sectionId}
          onClose={() => setPicker(false)}
          onInserted={(n) => {
            setPicker(false);
            onRefresh();
            onNotice(`${n === 1 ? "1 thing" : `${n} things`} added from your Library.`);
          }} />
      )}
    </div>
  );
}

export function LegacyPacketEditor() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const packetId = params.id as string;
  // Which photo row is uploading, and why the last one failed. An upload that
  // shows nothing while it works reads as a button that does nothing.
  const [photoUploading, setPhotoUploading] = useState("");
  /** Which section is currently taking a picture, so its control can say so. */
  const [pictureBusy, setPictureBusy] = useState("");
  /** ITS OWN ERROR, not the item photo one. A failure here happens when there
   *  is no item yet, and photoError is rendered inside an item's photo block —
   *  so it would have been written somewhere nobody was looking. */
  const [pictureError, setPictureError] = useState("");
  /** Which item is taking a header-level photo upload. */
  const [newPhotoUploading, setNewPhotoUploading] = useState("");
  const [photoError, setPhotoError] = useState("");

  const [showAiBanner, setShowAiBanner] = useState(searchParams.get("ai") === "1");
  const [packet, setPacket] = useState<PacketData | null>(null);
  const [sections, setSections] = useState<EditorSection[]>([]);
  const [items, setItems] = useState<EditorItem[]>([]);
  const [profile, setProfile] = useState<EditorProfile>({ name: "", email: "", phone: "", businessName: "", logoUrl: "", headshotUrl: "", footerLabel: "Your Advisor", websiteUrl: "", links: [] });
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [publishError, setPublishError] = useState("");
  const [libraryNotice, setLibraryNotice] = useState("");
  // Bulk save is owned here rather than by LibraryBar, because it is offered
  // from two different moments: while building, and again where the work ends.
  const [promoting, setPromoting] = useState(false);
  const [libraryKey, setLibraryKey] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showAppendModal, setShowAppendModal] = useState(false);
  const [appendText, setAppendText] = useState("");
  const [appendLoading, setAppendLoading] = useState(false);
  // When set, the AI modal is in "add items to THIS existing section" mode
  // (Operation 1). When null, it is "add new sections" mode (Operation 2).
  const [appendTargetSection, setAppendTargetSection] = useState<{ id: string; title: string } | null>(null);
  // Active resilient-ingestion run for this packet (Organize / Add with AI). While
  // set, an import is in progress: the ImportProgress panel drives it and publish
  // is blocked. Detected on load so a refresh mid-import reconnects and resumes.
  const [importRunId, setImportRunId] = useState<string | null>(null);
  /** Why the last section delete was refused, shown where the sections are. */
  const [sectionError, setSectionError] = useState("");

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Auto-size the multi-line title field to fit its content (on load and edit)
  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [packet?.title]);

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
      clientTitle: p.client_title || "",
      clientName: p.client_name || "",
      personalNote: p.personal_note || "",
      mapUrl: p.map_url || "",
      rawInput: p.raw_input || "",
      status: p.status,
      createdAt: p.created_at || "",
      identityMode: (p.identity_mode as IdentityMode) || "default",
      // Absent or null reads as ON, matching the recipient renderer.
      showQuickNav: p.show_quick_nav !== false,
      customIdentity: p.custom_identity
        ? {
            name: p.custom_identity.name || "",
            email: p.custom_identity.email || "",
            phone: p.custom_identity.phone || "",
            businessName: p.custom_identity.businessName || "",
            logoUrl: p.custom_identity.logoUrl || "",
            headshotUrl: p.custom_identity.headshotUrl || "",
            footerLabel: p.custom_identity.footerLabel || "",
            websiteUrl: p.custom_identity.websiteUrl || "",
            links: Array.isArray(p.custom_identity.links) ? p.custom_identity.links : [],
          }
        : null,
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
      highlight: i.highlight || "",
      sortOrder: i.sort_order,
      // Inert lineage. Nothing renders differently because of it — it only
      // decides WHICH Library action this item is offered.
      libraryItemId: (i.library_item_id as string | null) ?? null,
      photos: (data.photos || [])
        .filter((ph: Record<string, unknown>) => ph.item_id === i.id)
        .map((ph: Record<string, unknown>) => ({ id: ph.id, url: ph.url })),
      links: (data.links || [])
        .filter((l: Record<string, unknown>) => l.item_id === i.id)
        .map((l: Record<string, unknown>) => ({ id: l.id || crypto.randomUUID(), url: l.url || "", label: l.label || "" })),
      details: (data.details || [])
        .filter((d: Record<string, unknown>) => d.item_id === i.id)
        .map((d: Record<string, unknown>) => ({ id: d.id || crypto.randomUUID(), label: d.label || "", value: d.value || "" })),
      contacts: (data.contacts || [])
        .filter((c: Record<string, unknown>) => c.item_id === i.id)
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
        .map((c: Record<string, unknown>) => ({ id: c.id || crypto.randomUUID(), name: c.name || "", role: c.role || "", phone: c.phone || "", email: c.email || "", website: c.website || "" })),
    }));
    setItems(editorItems);

    if (data.profile) {
      setProfile({
        name: data.profile.name || "",
        email: data.profile.email || "",
        phone: data.profile.phone || "",
        businessName: data.profile.business_name || "",
        logoUrl: data.profile.logo_url || "",
        headshotUrl: data.profile.headshot_url || "",
        footerLabel: data.profile.footer_label ?? "Your Advisor",
        websiteUrl: data.profile.website_url || "",
        links: Array.isArray(data.profile.links) ? data.profile.links : [],
      });
    }

    setLoading(false);
  }, [packetId, router]);

  useEffect(() => { loadPacket(); }, [loadPacket]);

  // Reconnect to an in-progress import (from ?import=, or any active run for this
  // packet) so a refresh mid-import resumes instead of showing an empty packet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromParam = searchParams.get("import");
      if (fromParam) { if (!cancelled) setImportRunId(fromParam); return; }
      const res = await fetch(`/api/packets/${packetId}/ingest`);
      if (!res.ok) return;
      const data = await res.json();
      if (!cancelled && data.activeRun?.runId) setImportRunId(data.activeRun.runId);
    })();
    return () => { cancelled = true; };
  }, [packetId, searchParams]);

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
  // THE MAP LINK SAVES UNDER THE SHARED RULE. Same reasoning as the block
  // editor: this box debounce-saves 500ms after a keystroke, so a half-typed
  // URL would otherwise be answered with a save failure. Blank always saves,
  // because clearing the field is a legitimate edit. The API enforces the same
  // rule regardless of what this does.
  const [mapUnsaved, setMapUnsaved] = useState(false);

  function updateMapUrl(value: string) {
    setPacket((prev) => prev ? { ...prev, mapUrl: value } : prev);
    const sendable = value.trim() === "" || Boolean(packetMapUrl(value));
    setMapUnsaved(!sendable);
    if (!sendable) return;
    debouncedSave(() =>
      fetch(`/api/packets/${packetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapUrl: value }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

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

  // Immediate (non-debounced) save for discrete packet changes like identity
  // mode — a shared debounce timer could otherwise drop it behind a later edit.
  async function savePacketFields(fields: Record<string, unknown>) {
    setSaveStatus("saving");
    try {
      const r = await fetch(`/api/packets/${packetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!r.ok) throw new Error();
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  // A discrete presentation toggle. Saved immediately for the same reason the
  // identity mode is: the shared debounce timer is reset by any later edit, so
  // a click followed by typing could otherwise lose the click.
  function setShowQuickNav(next: boolean) {
    setPacket((prev) => (prev ? { ...prev, showQuickNav: next } : prev));
    savePacketFields({ showQuickNav: next });
  }

  // ============================================================
  // Packet identity (default / none / custom)
  // ============================================================
  function setIdentityMode(mode: IdentityMode) {
    // Seed a blank custom identity the first time custom is chosen, so its
    // fields render. Blank by design — it never copies the default profile.
    const seedCustom = mode === "custom" && !packet?.customIdentity;
    setPacket((prev) =>
      prev ? { ...prev, identityMode: mode, customIdentity: seedCustom ? { ...EMPTY_IDENTITY } : prev.customIdentity } : prev
    );
    const fields: Record<string, unknown> = { identityMode: mode };
    if (seedCustom) fields.customIdentity = { ...EMPTY_IDENTITY };
    savePacketFields(fields);
  }

  // Custom identity is stored as one packet-owned blob; save the whole object.
  // Saves to the PACKET, never to /api/profile — the default profile is untouched.
  function patchCustomIdentity(next: EditorProfile) {
    setPacket((prev) => (prev ? { ...prev, customIdentity: next } : prev));
    debouncedSave(() =>
      fetch(`/api/packets/${packetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customIdentity: next }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  type CustomScalarField =
    | "name" | "email" | "phone" | "businessName"
    | "logoUrl" | "headshotUrl" | "footerLabel" | "websiteUrl";

  function updateCustomField(field: CustomScalarField, value: string) {
    const base = packet?.customIdentity ?? { ...EMPTY_IDENTITY };
    patchCustomIdentity({ ...base, [field]: value });
  }

  function addCustomLink() {
    const base = packet?.customIdentity ?? { ...EMPTY_IDENTITY };
    patchCustomIdentity({ ...base, links: [...base.links, { label: "", url: "" }] });
  }

  function updateCustomLink(index: number, field: "label" | "url", value: string) {
    const base = packet?.customIdentity ?? { ...EMPTY_IDENTITY };
    patchCustomIdentity({ ...base, links: base.links.map((l, i) => (i === index ? { ...l, [field]: value } : l)) });
  }

  function removeCustomLink(index: number) {
    const base = packet?.customIdentity ?? { ...EMPTY_IDENTITY };
    patchCustomIdentity({ ...base, links: base.links.filter((_, i) => i !== index) });
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

  function saveProfileLinks(links: { label: string; url: string }[]) {
    setProfile((prev) => ({ ...prev, links }));
    debouncedSave(() =>
      fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
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
    const res = await fetch("/api/sections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sectionId }),
    });
    // The response was previously discarded and the section removed from local
    // state regardless, so a REFUSED delete looked like it had worked until the
    // next reload. It matters more now that a refusal is a real outcome: the
    // server blocks deleting a section AI is writing into.
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setSectionError(body?.message?.trim() || "Could not delete this section.");
      return;
    }
    setSectionError("");
    setSections((prev) => prev.filter((s) => s.id !== sectionId));
    setItems((prev) => prev.filter((i) => i.sectionId !== sectionId));
  }

  // ============================================================
  // Item operations
  // ============================================================
  // ADD PICTURE — an ordinary item whose content is an image.
  //
  // THE ORDER IS THE FEATURE. Upload first, create the item only once there is
  // something to put in it:
  //
  //   cancel the file picker  -> nothing happened at all
  //   upload refused/failed   -> an error, and still nothing created
  //   upload succeeded        -> an item that already has its picture
  //
  // Creating the item first would have been the shorter code and would leave an
  // untitled empty item behind on both of the first two, which is not merely
  // untidy: an item with no title BLOCKS PUBLISHING, so a cancelled file picker
  // would have quietly broken the Sendset.
  async function addPicture(sectionId: string, file: File) {
    setPictureBusy(sectionId);
    setPictureError("");
    try {
      const body = new FormData();
      body.append("file", file);
      // The same ownership-checked route the per-item upload uses. Nothing new
      // touches storage.
      const up = await fetch(`/api/packets/${packetId}/photos`, { method: "POST", body });
      const stored = await up.json().catch(() => ({}));
      if (!up.ok || !stored?.url) {
        setPictureError(stored?.message || "Could not upload that image.");
        return;
      }

      const created = await addItem(sectionId);
      if (!created) {
        setPictureError("Could not add that picture. Please try again.");
        return;
      }

      const url = stored.url as string;
      setItems((prev) => prev.map((i) =>
        i.id === created ? { ...i, photos: [{ id: crypto.randomUUID(), url }] } : i));
      const res = await fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: created, photos: [{ url }] }),
      });
      if (!res.ok) setPictureError("The picture was uploaded but could not be saved. Try again.");
    } catch {
      setPictureError("Could not upload that image. Check your connection and try again.");
    } finally {
      setPictureBusy("");
    }
  }

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
          highlight: "",
          sortOrder: data.item.sort_order,
          photos: [],
          links: [],
          details: [],
          contacts: [],
        },
      ]);
      // Returned so a caller that has something to put IN the new item can.
      return data.item.id as string;
    }
    return null;
  }

  function moveItemToSection(itemId: string, targetSectionId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item || item.sectionId === targetSectionId) return;

    const targetItems = items.filter((i) => i.sectionId === targetSectionId);
    const newOrder = targetItems.reduce((max, i) => Math.max(max, i.sortOrder), -1) + 1;
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId ? { ...i, sectionId: targetSectionId, sortOrder: newOrder } : i
      )
    );

    setSaveStatus("saving");
    fetch("/api/items", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId, sectionId: targetSectionId }),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        setSaveStatus("saved");
      })
      .catch(() => setSaveStatus("error"));
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
        body: JSON.stringify({ id: itemId, details: detailsPayload(updatedDetails) }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  // ORDER IS THE ARRAY. update_item_content assigns item_details.sort_order from
  // the position of each entry in the details array it is sent, and every read
  // path — the live FlowGuide, print, email, the Library — already selects
  // `order("sort_order")`. So reordering is a move within this array followed by
  // the save that editing a row already performs. Nothing new is persisted and
  // no value is touched; only the sequence changes.
  function reorderDetail(itemId: string, activeId: string, overId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item || activeId === overId) return;
    const updatedDetails = moveDetail(item.details, activeId, overId);
    if (updatedDetails === item.details) return;      // nothing moved: no save
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, details: updatedDetails } : i)));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, details: detailsPayload(updatedDetails) }),
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
        body: JSON.stringify({ id: itemId, details: detailsPayload(updatedDetails) }),
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

  // Persist an item's full ordered contacts list (blank rows dropped, order kept).
  function persistContacts(itemId: string, contacts: EditorContact[]) {
    const payload = contacts
      .filter((c) => c.name || c.phone || c.email || c.website)
      .map((c) => ({ name: c.name, role: c.role, phone: c.phone, email: c.email, website: c.website }));
    debouncedSave(() =>
      fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, contacts: payload }),
      }).then((r) => { if (!r.ok) throw new Error(); })
    );
  }

  function addItemContact(itemId: string) {
    // Append a blank contact; not saved until it has content (persistContacts drops blanks).
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, contacts: [...i.contacts, { id: crypto.randomUUID(), name: "", role: "", phone: "", email: "", website: "" }] }
          : i
      )
    );
  }

  function updateItemContact(itemId: string, contactId: string, field: "name" | "role" | "phone" | "email" | "website", value: string) {
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId ? { ...i, contacts: i.contacts.map((c) => (c.id === contactId ? { ...c, [field]: value } : c)) } : i
      )
    );
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    persistContacts(itemId, item.contacts.map((c) => (c.id === contactId ? { ...c, [field]: value } : c)));
  }

  function removeItemContact(itemId: string, contactId: string) {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, contacts: i.contacts.filter((c) => c.id !== contactId) } : i)));
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    persistContacts(itemId, item.contacts.filter((c) => c.id !== contactId));
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

  // UPLOAD, then reuse the ordinary URL path.
  //
  // The file goes to the packet's photo route, which decides whether to keep it
  // and what to call it, and returns a URL. From there this is the same flow as
  // pasting one: updatePhoto writes it and the existing debounced save
  // persists it. Nothing downstream needs to know the difference.
  async function uploadPhoto(itemId: string, photoId: string, file: File) {
    setPhotoUploading(photoId);
    setPhotoError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/packets/${packetId}/photos`, { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        setPhotoError(data?.message || "Could not upload that image.");
        return;
      }
      updatePhoto(itemId, photoId, data.url as string);
    } catch {
      setPhotoError("Could not upload that image. Check your connection and try again.");
    } finally {
      setPhotoUploading("");
    }
  }

  // UPLOAD STRAIGHT INTO AN EXISTING ITEM.
  //
  // Uploading has been possible here for a while, but only for someone who
  // first pressed "+ Add" to make a blank URL row and then noticed the small
  // Upload beside it. So the capability existed and the affordance did not.
  //
  // Same order as the section-level one: the file is stored first, and the
  // photo is appended only once there is a URL. A cancelled picker and a
  // refused upload both leave the item's photos exactly as they were, rather
  // than leaving an empty row behind.
  async function uploadNewPhoto(itemId: string, file: File) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    setNewPhotoUploading(itemId);
    setPhotoError("");
    try {
      const res = await uploadCreatorImage(`/api/packets/${packetId}/photos`, file);
      if ("error" in res) { setPhotoError(res.error); return; }
      const updatedPhotos = [...item.photos, { id: crypto.randomUUID(), url: res.url }];
      setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, photos: updatedPhotos } : i)));
      debouncedSave(() =>
        fetch("/api/items", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: itemId, photos: updatedPhotos.map((ph) => ({ url: ph.url })) }),
        }).then((r) => { if (!r.ok) throw new Error(); })
      );
    } finally {
      setNewPhotoUploading("");
    }
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
  // Reorder items within a section (drag and drop)
  // ============================================================
  function handleItemDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeItem = items.find((i) => i.id === active.id);
    if (!activeItem) return;

    const sectionItems = items
      .filter((i) => i.sectionId === activeItem.sectionId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const oldIndex = sectionItems.findIndex((i) => i.id === active.id);
    const newIndex = sectionItems.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const orderedIds = arrayMove(sectionItems, oldIndex, newIndex).map((i) => i.id);
    const orderMap = new Map(orderedIds.map((id, index) => [id, index]));
    setItems((prev) =>
      prev.map((i) => (orderMap.has(i.id) ? { ...i, sortOrder: orderMap.get(i.id)! } : i))
    );

    setSaveStatus("saving");
    fetch("/api/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The packet is what the server scopes the write to — without it the
      // route cannot tell whose rows these are.
      body: JSON.stringify({ type: "items", packetId, orderedIds }),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        setSaveStatus("saved");
      })
      .catch(() => setSaveStatus("error"));
  }

  // ============================================================
  // Reorder sections within a packet (drag and drop)
  // ============================================================
  function handleSectionDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const ordered = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);
    const oldIndex = ordered.findIndex((s) => s.id === active.id);
    const newIndex = ordered.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const orderedIds = arrayMove(ordered, oldIndex, newIndex).map((s) => s.id);
    const orderMap = new Map(orderedIds.map((id, index) => [id, index]));
    setSections((prev) =>
      prev.map((s) => (orderMap.has(s.id) ? { ...s, sortOrder: orderMap.get(s.id)! } : s))
    );

    setSaveStatus("saving");
    fetch("/api/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "sections", packetId, orderedIds }),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        setSaveStatus("saved");
      })
      .catch(() => setSaveStatus("error"));
  }

  // ============================================================
  // Publish
  // ============================================================
  async function publishPacket(skipProfileCheck: boolean) {
    if (importRunId) {
      setPublishError("An import is still in progress. Finish or discard it before publishing.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setPublishError("");
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
          publishPacket(true);
        }
        return;
      }
      // PHOTO OWNERSHIP HAS A HOME, AND IT IS NOT HERE.
      //
      // This refusal is a decision to make — which item a photo belongs on —
      // and the panel that makes it lives on the share step. Falling through to
      // the banner below left the one message a professional cannot act on in
      // the one place with nothing to press. `OwnershipDecisions` above shows
      // decisions already MADE, deliberately not findings, and turning it into
      // a second gate is the duplication this avoids.
      //
      // The reason travels in the URL, so the arrival explains itself.
      if (res.status === 409 && data.error === "ownership_unresolved") {
        router.push(`/preview/${packetId}?resolve=photos`);
        return;
      }
      // Everything else stays here and says so. `ownership_unavailable` is a
      // 503 meaning the CHECK could not run — there is no panel to draw for it
      // and the server's own sentence already says to try again.
      const errMsg = data.message || data.error || "Could not publish";
      setPublishError(errMsg);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setPacket((prev) => prev ? { ...prev, status: "published" } : prev);
    // ONE POST-PUBLISH EXPERIENCE, AND IT IS THE GOOD ONE.
    //
    // This used to open a dialog holding the link and nothing else, while
    // publishing from Preview landed on a page with the client message written
    // for you, the email version, Print/Save as PDF and a way back. Same
    // action, same endpoint, two different outcomes decided by which button you
    // happened to press — and the weaker one was in the editor's own bottom
    // bar, which is where the work happens. A professional could publish for
    // months and never learn the other half existed.
    //
    // Preview reads the packet's status on the server, so arriving now lands
    // directly on the share step rather than on a page offering to publish
    // something already published.
    router.push(`/preview/${packetId}`);
  }

  async function handleUnpublish() {
    if (!confirm("Unpublish this Sendset? The link will stop working.")) return;
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

  async function handleAppend() {
    if (!appendText.trim() || appendText.trim().length < 10) return;
    setAppendLoading(true);
    try {
      // Both "Add with AI" (new sections) and section-level "Add items with AI"
      // now go through the SAME resilient ingestion pipeline as Organize — a
      // persisted, resumable run that the ImportProgress panel drives. A small
      // paste is a one-chunk run; a large one is chunked automatically.
      const entryPoint = appendTargetSection ? "section_append" : "append";
      const res = await fetch(`/api/packets/${packetId}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryPoint, rawText: appendText, targetSectionId: appendTargetSection?.id ?? null }),
      });
      const data = await res.json();
      if (res.ok && data.runId) {
        setImportRunId(data.runId);
      } else if (res.status === 409 && data.runId) {
        setImportRunId(data.runId); // an import is already active — reconnect to it
      } else {
        alert(data.message || data.error || "Could not start adding items.");
        return;
      }
      setAppendText("");
      setShowAppendModal(false);
      setAppendTargetSection(null);
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setAppendLoading(false);
    }
  }

  // ============================================================
  // Render
  // ============================================================
  if (loading || !packet) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-ink-2">Loading...</p>
      </main>
    );
  }

  const sortedSections = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="min-h-screen bg-canvas">
      {/* THE SAME CHROME AS THE LIBRARY AND THE DASHBOARD. This nav sat in the
          page body and scrolled away with the content, while every other
          authoring surface keeps it pinned — so the editor was the one screen
          where the way out moved. Save status and the draft/published state
          ride here too: they describe THIS packet as a whole, which is what a
          bar across the top of it is for.

          The pills lost their borders and their green box. Draft is the resting
          state of most packets and is quiet; Published is the event. */}
      <div className="sticky top-0 z-20 bg-canvas/85 backdrop-blur-sm border-b border-line">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-2 sm:py-3.5 flex items-center gap-2 sm:gap-3">
          <CreatorNav
            pinned={
              <span className="flex items-center gap-2 whitespace-nowrap">
                <span className="text-meta text-ink-3" role="status">
                  {saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save failed" : "Saved"}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-micro font-medium ${
                  packet.status === "published"
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-ground-3 text-ink-2"
                }`}>
                  {packet.status === "published" ? "Published" : "Draft"}
                </span>
              </span>
            }
          />
        </div>
      </div>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 pb-32">

      {/* Reverted-from-blocks success notice */}
      {searchParams.get("reverted") === "1" && (
        <div className="mb-4 p-3 rounded-[var(--radius-control)] bg-green-50 border border-green-200 text-body text-green-800">
          Reverted to the legacy section editor. Item content was preserved; block-only headings and ordering were discarded.
        </div>
      )}

      {/* Deliberate conversion control — only for owned DRAFT legacy packets. */}
      {packet.status === "draft" && (
        <div className="mb-4 flex items-center justify-between gap-3 p-3 rounded-[var(--radius-control)] border border-line bg-ground-2">
          <div className="min-w-0">
            <p className="text-body font-medium text-ink">Composition: sections</p>
            <p className="text-meta text-ink-2">Switch to the flat block editor to freely order headings and items.</p>
          </div>
          <CompositionModeControl packetId={packetId} direction="convert" />
        </div>
      )}

      {/* Publish error */}
      {publishError && (
        <div className="mb-4 p-3 rounded-[var(--radius-control)] bg-red-50 border border-red-200 text-body text-red-700">
          {publishError}
        </div>
      )}

      <OwnershipDecisions packetId={packetId} />

      {/* Resilient import in progress (Organize / Add with AI) */}
      {importRunId && (
        <ImportProgress
          packetId={packetId}
          runId={importRunId}
          onDone={() => { setImportRunId(null); setShowAiBanner(true); loadPacket(); }}
          onDiscarded={() => { setImportRunId(null); loadPacket(); }}
          // Content applied, so show it — but keep the panel mounted and the
          // success banner suppressed. "AI organized your info" over a blocked
          // packet is how a safety state became a dead end.
          onNeedsReview={() => { loadPacket(); }}
          // Keeping a note as private writes it into an item. Without this the
          // card vanished and the Private Notes field below kept showing its
          // old value until the browser was reloaded.
          onItemsChanged={() => { loadPacket(); }}
        />
      )}

      {/* AI review banner */}
      {showAiBanner && !importRunId && (
        <div className="mb-4 p-3 rounded-[var(--radius-control)] bg-blue-50 border border-blue-200 text-body text-blue-800 flex items-center justify-between">
          <span>AI organized your info. Review and edit anything before publishing.</span>
          <button
            onClick={() => setShowAiBanner(false)}
            className="ml-3 text-blue-500 hover:text-blue-700 flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* TWO NAMES, BECAUSE THEY DO TWO JOBS.
          The first is how the professional finds this again; the second is what
          a client reads, if they should read one at all. They were the same
          field, which is why "Options for Bonnie Smith" was also the heading
          Bonnie Smith saw. Two labelled inputs, no toggle and no settings. */}
      <div className="mb-6">
        <label className="block text-meta font-medium uppercase tracking-wide text-ink-2 mb-1">
          Sendset name
        </label>
        <textarea
          ref={titleRef}
          value={packet.title}
          onChange={(e) => updatePacketField("title", e.target.value)}
          placeholder="Options for the Smith family"
          rows={1}
          className="w-full text-page font-bold text-ink bg-transparent border-none outline-none resize-none overflow-hidden placeholder:text-ink-3/45"
        />
        <p className="text-meta text-ink-2">Only you see this. It is how you find this Sendset later.</p>

        <label className="mt-4 block text-meta font-medium uppercase tracking-wide text-ink-2 mb-1">
          Title your client sees <span className="normal-case font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={packet.clientTitle}
          onChange={(e) => updatePacketField("clientTitle", e.target.value)}
          placeholder="Senior Living Communities"
          className="w-full text-body font-semibold text-ink bg-transparent border-none outline-none placeholder:text-ink-3/45"
        />
        <p className="text-meta text-ink-2">Leave blank and your client sees no title at all.</p>

        <input
          type="text"
          value={packet.clientName}
          onChange={(e) => updatePacketField("clientName", e.target.value)}
          placeholder="Prepared for (optional)"
          className="w-full mt-4 text-body text-ink-2 bg-transparent border-none outline-none placeholder:text-ink-3/45"
        />
      </div>

      {/* Library. BELOW the title and identity on purpose: the FlowGuide being
          created is the primary thing on this screen, and reuse is a tool for
          building it rather than the headline. */}
      <LibraryBar
        packetId={packetId}
        itemCount={items.length}
        refreshKey={libraryKey}
        onSaveItems={() => setPromoting(true)}
        onNotice={setLibraryNotice}
        onRefresh={loadPacket}
      />
      {libraryNotice && <p className="mb-4 text-body text-green-700">{libraryNotice}</p>}

      {/* Personal note */}
      <div className="mb-8">
        <label className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-2">
          Note
        </label>
        <textarea
          value={packet.personalNote}
          onChange={(e) => updatePacketField("personalNote", e.target.value)}
          placeholder="Add a welcome, some context, or instructions…"
          rows={4}
          className={`${INPUT_SHELL} resize-y`}
        />
      </div>

      {/* Map URL */}
      <div className="mb-8">
        <label className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-2">
          Map Link (optional)
        </label>
        <input
          type="url"
          value={packet.mapUrl}
          onChange={(e) => updateMapUrl(e.target.value)}
          placeholder="Paste a Google My Maps or any map link"
          className={INPUT_SHELL}
        />
        {mapUnsaved && (
          <p className="mt-1.5 text-meta text-amber-700">
            Not saved — a map link needs to start with http:// or https://.
          </p>
        )}
      </div>

      {/* PRESENTATION, not content — placed here because it governs how the
          sections below it render. Default on, so every existing FlowGuide is
          unchanged. There is deliberately no per-section version of this. */}
      <div className="mb-8">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={packet.showQuickNav}
            onChange={(e) => setShowQuickNav(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-line text-mark focus:ring-2 focus:ring-mark/15"
          />
          <span className="min-w-0">
            <span className="block text-body font-medium text-ink">Show quick navigation</span>
            <span className="mt-0.5 block text-body text-ink-2">
              Display a clickable list of items at the top of sections with multiple items.
            </span>
          </span>
        </label>
      </div>

      {/* Sections */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleSectionDragEnd}
      >
        {/* A refused section delete, said where the sections are — the server
            blocks deleting a section AI is actively writing into. */}
        {sectionError && (
          <p className="mb-3 rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 px-3 py-2 text-body text-amber-900">
            {sectionError}
          </p>
        )}
        <SortableContext
          items={sortedSections.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
      {sortedSections.map((section) => {
        const sectionItems = items
          .filter((i) => i.sectionId === section.id)
          .sort((a, b) => a.sortOrder - b.sortOrder);

        return (
          <SortableSection key={section.id} id={section.id}>
            {(handle) => (
              <>
            {/* Section header */}
            <div className="flex items-start justify-between gap-2 mb-3">
              <button
                type="button"
                {...handle.attributes}
                {...handle.listeners}
                aria-label="Drag to reorder section"
                className="text-ink-3 hover:text-ink cursor-grab active:cursor-grabbing flex-shrink-0 touch-none -ml-1 mt-1 p-1"
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <circle cx="7" cy="4" r="1.5" />
                  <circle cx="13" cy="4" r="1.5" />
                  <circle cx="7" cy="10" r="1.5" />
                  <circle cx="13" cy="10" r="1.5" />
                  <circle cx="7" cy="16" r="1.5" />
                  <circle cx="13" cy="16" r="1.5" />
                </svg>
              </button>
              <div className="flex-1">
                <input
                  type="text"
                  value={section.title}
                  onChange={(e) => updateSection(section.id, "title", e.target.value)}
                  placeholder="Section title"
                  className="w-full text-title font-bold text-ink bg-transparent border-none outline-none placeholder:text-ink-3/45"
                />
                <input
                  type="text"
                  value={section.description}
                  onChange={(e) => updateSection(section.id, "description", e.target.value)}
                  placeholder="Section description (optional)"
                  className="w-full mt-0.5 text-body text-ink-2 bg-transparent border-none outline-none placeholder:text-ink-3/45"
                />
              </div>
              <button
                onClick={() => deleteSection(section.id)}
                className="text-body text-red-400 hover:text-red-600 mt-1 flex-shrink-0"
              >
                Delete
              </button>
            </div>

            {/* Items */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleItemDragEnd}
            >
              <SortableContext
                items={sectionItems.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-3">
                  {sectionItems.map((item) => (
                    <ItemEditor
                      key={item.id}
                      item={item}
                      sections={sections}
                      onMove={moveItemToSection}
                      onUpdateField={updateItem}
                      onDelete={deleteItem}
                      onLibraryChanged={(m) => {
                        setLibraryNotice(m);
                        // A per-item save changes both the bar's precedence and
                        // that card's lineage, so re-read rather than leaving
                        // the editor showing a state that is no longer true.
                        setLibraryKey((k) => k + 1);
                        loadPacket();
                      }}
                      onAddDetail={addDetail}
                      onUpdateDetail={updateDetail}
                      onReorderDetail={reorderDetail}
                      onRemoveDetail={removeDetail}
                      onAddLink={addLink}
                      onUpdateLink={updateLink}
                      onRemoveLink={removeLink}
                      onAddContact={addItemContact}
                      onUpdateContact={updateItemContact}
                      onRemoveContact={removeItemContact}
                      onAddPhoto={addPhoto}
                      onUpdatePhoto={updatePhoto}
                      onRemovePhoto={removePhoto}
                      onUploadPhoto={uploadPhoto}
                      onUploadNewPhoto={uploadNewPhoto}
                      newPhotoUploading={newPhotoUploading}
                      photoUploading={photoUploading}
                      photoError={photoError}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            <div className="mt-3 flex items-center gap-4">
              <button
                onClick={() => addItem(section.id)}
                className="text-body text-mark hover:text-mark/80 font-medium"
              >
                + Add Item
              </button>
              {/* A PICTURE IS A THING YOU ADD, not a field inside something you
                  already added. Uploading has been possible for a while, but
                  only for someone who had already made an item and gone looking
                  inside it for Photos — so a map, a diagram or a screenshot
                  meant inventing a thing to hang it on first. */}
              <label
                className={`text-body font-medium cursor-pointer ${
                  pictureBusy === section.id
                    ? "text-ink-2 pointer-events-none"
                    : "text-mark hover:text-mark/80"}`}
              >
                {pictureBusy === section.id ? "Adding picture…" : "+ Add picture"}
                <input
                  type="file"
                  accept={PHOTO_ACCEPT_ATTR}
                  className="hidden"
                  disabled={pictureBusy === section.id}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // Cleared so choosing the same file twice still fires.
                    e.target.value = "";
                    if (f) addPicture(section.id, f);
                  }}
                />
              </label>
              <button
                onClick={() => {
                  setAppendTargetSection({ id: section.id, title: section.title });
                  setAppendText("");
                  setShowAppendModal(true);
                }}
                className="text-body text-mark hover:text-mark/80 font-medium"
              >
                + Add items with AI
              </button>
            </div>
            {pictureError && (
              <p className="mt-1 text-body text-red-600">{pictureError}</p>
            )}
              </>
            )}
          </SortableSection>
        );
      })}
        </SortableContext>
      </DndContext>

      <div className="flex gap-3 mb-8">
        <button
          onClick={addSection}
          className="flex-1 py-3 border-2 border-dashed border-line rounded-[var(--radius-panel)] text-body font-medium text-ink-2 hover:text-mark hover:border-mark transition-colors"
        >
          + Add Section
        </button>
        <button
          onClick={() => {
            setAppendTargetSection(null);
            setAppendText("");
            setShowAppendModal(true);
          }}
          className="flex-1 py-3 border-2 border-dashed border-mark/30 rounded-[var(--radius-panel)] text-body font-medium text-mark hover:bg-ink hover:text-white transition-colors"
        >
          + Add new sections with AI
        </button>
      </div>

      {/* WHERE THE WORK ACTUALLY ENDS. The Library bar sits above the note and
          every section, which is the right place to REUSE something and the
          wrong place to be told you can SAVE — by the time the items exist, that
          bar is far off the top of the screen and the only controls in view are
          Preview and Publish. This is the same action, offered at the moment a
          professional is actually finished. Draft or published is irrelevant:
          saving to the Library has never had anything to do with publishing. */}
      {items.length > 0 && (
        <div className="mb-8 rounded-[var(--radius-panel)] border border-line bg-ground p-4">
          <p className="text-body font-medium text-ink">Reuse any of these next time?</p>
          <p className="mt-1 text-meta text-ink-2">
            Save any of these to your Library and use them in your next Sendset. You
            do not have to publish this one first.
          </p>
          <button
            onClick={() => setPromoting(true)}
            className="mt-3 px-3 py-1.5 rounded-[var(--radius-control)] bg-ink hover:bg-ink/90 text-white text-body font-medium"
          >
            Save to Library
          </button>
        </div>
      )}

      {promoting && (
        <BulkPromote
          packetId={packetId}
          onClose={() => setPromoting(false)}
          onDone={(m) => {
            setPromoting(false);
            setLibraryNotice(m);
            // The Library is no longer empty; the bar's precedence depends on
            // that, and the item cards now have lineage to show.
            setLibraryKey((k) => k + 1);
            loadPacket();
          }}
        />
      )}

      {/* Add with AI modal */}
      {showAppendModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-5">
          <div className="bg-ground rounded-[var(--radius-panel)] shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto p-6">
            <h2 className="text-title font-bold text-ink mb-1">
              {appendTargetSection ? "Add items with AI" : "Add new sections with AI"}
            </h2>
            <p className="text-body text-ink-2 mb-4">
              {appendTargetSection ? (
                <>
                  Paste new information below. AI will structure it into items and add them to{" "}
                  <span className="font-medium text-ink">
                    {appendTargetSection.title?.trim() || "this section"}
                  </span>
                  {" "}— it won&apos;t create new sections or change existing content.
                </>
              ) : (
                "Paste new information below. AI will organize it into one or more new sections and add them to this Sendset without changing existing content."
              )}
            </p>
            <textarea
              value={appendText}
              onChange={(e) => setAppendText(e.target.value)}
              placeholder="Paste new recommendations, community info, or any raw data..."
              className="w-full h-48 px-4 py-3 rounded-[var(--radius-panel)] border border-line text-body focus:outline-none focus:ring-2 focus:ring-mark/15 resize-none"
              autoFocus
            />
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => { setShowAppendModal(false); setAppendText(""); setAppendTargetSection(null); }}
                className="px-4 py-2 text-body font-medium text-ink-2 hover:text-ink transition-colors"
                disabled={appendLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleAppend}
                disabled={appendLoading || appendText.trim().length < 10}
                className="px-6 py-2 rounded-[var(--radius-control)] bg-ink hover:bg-ink/90 text-white text-body font-medium transition-colors disabled:opacity-50"
              >
                {appendLoading ? "Organizing..." : "Organize with AI"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Original input (collapsible, read-only) */}
      {packet.rawInput && (
        <OriginalInput text={packet.rawInput} />
      )}

      {/* Selected sender's details — rendered just above the Sender chooser so
          the chooser stays pinned at the very bottom. Nothing shows for "No sender". */}
      {packet.identityMode === "default" && (
        <div className="mb-8 border border-line rounded-[var(--radius-panel)] p-4">
          <label className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-1">
            Your Default Profile
          </label>
          <p className="text-meta text-ink-2 mb-3">
            Editing these updates your profile on <strong>every</strong> Sendset set to “My default profile.”
          </p>
          <ProfessionalProfileFields
            value={profile}
            onField={updateProfile}
            onLinks={saveProfileLinks}
          />
        </div>
      )}

      {packet.identityMode === "custom" && (
        <div className="mb-8 border border-line rounded-[var(--radius-panel)] p-4">
          <label className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-1">
            Custom Organization
          </label>
          <p className="text-meta text-ink-2 mb-3">
            These details apply to this Sendset only. Editing them does <strong>not</strong> change your default profile.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={packet.customIdentity?.name || ""}
              onChange={(e) => updateCustomField("name", e.target.value)}
              placeholder="Name"
              className={INPUT_SHELL}
            />
            <input
              type="text"
              value={packet.customIdentity?.businessName || ""}
              onChange={(e) => updateCustomField("businessName", e.target.value)}
              placeholder="Business name (optional)"
              className={INPUT_SHELL}
            />
            <input
              type="email"
              value={packet.customIdentity?.email || ""}
              onChange={(e) => updateCustomField("email", e.target.value)}
              placeholder="Email"
              className={INPUT_SHELL}
            />
            <input
              type="tel"
              value={packet.customIdentity?.phone || ""}
              onChange={(e) => updateCustomField("phone", e.target.value)}
              placeholder="Phone"
              className={INPUT_SHELL}
            />
          </div>
          <div className="mt-3">
            <input
              type="text"
              value={packet.customIdentity?.footerLabel || ""}
              onChange={(e) => updateCustomField("footerLabel", e.target.value)}
              placeholder="Footer label (optional)"
              className={INPUT_SHELL}
            />
            <p className="mt-1 text-meta text-ink-2">Shown above the name on the Sendset. Leave blank to hide it.</p>
          </div>
          <div className="mt-3">
            <ImageUploadField
              value={packet.customIdentity?.logoUrl || ""}
              onChange={(url) => updateCustomField("logoUrl", url)}
              placeholder="Logo URL, or upload"
              preview={<img src={packet.customIdentity!.logoUrl} alt="Logo" className="h-10 w-auto max-w-[120px] object-contain rounded" />}
            />
          </div>
          <div className="mt-2">
            <ImageUploadField
              value={packet.customIdentity?.headshotUrl || ""}
              onChange={(url) => updateCustomField("headshotUrl", url)}
              placeholder="Headshot URL, or upload"
              preview={<img src={packet.customIdentity!.headshotUrl} alt="Headshot" className="w-10 h-10 rounded-full object-cover flex-shrink-0 border border-line" />}
            />
          </div>
          <input
            type="url"
            value={packet.customIdentity?.websiteUrl || ""}
            onChange={(e) => updateCustomField("websiteUrl", e.target.value)}
            placeholder="Website URL (optional)"
            className={`${INPUT_SHELL} mt-2`}
          />

          <div className="mt-4">
            <label className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-2">
              Links (optional)
            </label>
            {(packet.customIdentity?.links.length ?? 0) > 0 && (
              <div className="space-y-2 mb-2">
                {packet.customIdentity!.links.map((link, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={link.label}
                      onChange={(e) => updateCustomLink(index, "label", e.target.value)}
                      placeholder="Label (e.g. Facebook)"
                      className={`${INPUT_SHELL} w-36 flex-shrink-0`}
                    />
                    <input
                      type="url"
                      value={link.url}
                      onChange={(e) => updateCustomLink(index, "url", e.target.value)}
                      placeholder="https://..."
                      className={`${INPUT_SHELL} min-w-0 flex-1`}
                    />
                    <button
                      type="button"
                      onClick={() => removeCustomLink(index)}
                      aria-label="Remove link"
                      className="text-ink-2 hover:text-red-600 px-1 flex-shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={addCustomLink}
              className="text-body text-mark hover:text-mark/80 font-medium"
            >
              + Add link
            </button>
          </div>
        </div>
      )}

      {/* Sender chooser — pinned at the very bottom, where the signature sits.
          The selected sender's details (if any) render just above this block. */}
      <div className="mb-8 border border-line rounded-[var(--radius-panel)] p-4">
        <label className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-1">
          Sender
        </label>
        <p className="text-meta text-ink-2 mb-3">
          Who is this packet from? Applies to this packet only.
        </p>
        <div className="space-y-2">
          {([
            { value: "default", title: "My default profile", desc: "Show your saved default contact information on this Sendset." },
            { value: "none", title: "No sender", desc: "No sender shown — no name, logo, or contact footer." },
            { value: "custom", title: "Custom organization", desc: "Enter a name, logo, and contact info just for this Sendset." },
          ] as { value: IdentityMode; title: string; desc: string }[]).map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 rounded-[var(--radius-control)] border border-line p-3 cursor-pointer transition-colors ${
                packet.identityMode === opt.value ? "ring-2 ring-accent" : "hover:border-muted"
              }`}
            >
              <input
                type="radio"
                name="identityMode"
                value={opt.value}
                checked={packet.identityMode === opt.value}
                onChange={() => setIdentityMode(opt.value)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-body font-medium text-ink">{opt.title}</span>
                <span className="block text-body text-ink-2">{opt.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {packet.identityMode === "none" && (
          <p className="mt-4 text-meta text-ink-2">
            No sender will appear on this packet — no name, logo, or contact footer.
          </p>
        )}
      </div>

      <DeletePacketAction
        packetId={packet.id}
        packet={{
          title: packet.title,
          clientName: packet.clientName,
          status: packet.status,
          createdAt: packet.createdAt,
        }}
      />

      {/* THE BAR THAT SENDS THE THING. It is the only place on this screen
          where an action leaves the workspace, so it keeps its own ground and
          the one hairline separating it from the page — and it now matches the
          page's width instead of the old 2xl column, so Preview no longer sat
          inboard of everything above it.

          Publish is the ink primary. Copy link WAS a blue-on-blue bordered
          button, which made the thing you do after publishing louder than
          publishing; it is a plain secondary now. Unpublish keeps `danger`,
          which is quiet until it is pointed at. */}
      <div className="fixed bottom-0 left-0 right-0 bg-ground/95 backdrop-blur-sm border-t border-line px-4 sm:px-6 py-2.5 sm:py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-2">
          <Button variant="ghost" size="md"
            onClick={() => window.open(`/preview/${packet.id}`, "_blank")}>
            Preview
          </Button>
          <div className="flex items-center gap-2">
            {packet.status === "published" && (
              <>
                <Button variant="secondary" size="md" onClick={copyPacketLink}>
                  {copiedLink ? "Copied!" : "Copy link"}
                </Button>
                <Button variant="danger" size="md" onClick={handleUnpublish}>
                  Unpublish
                </Button>
              </>
            )}
            {packet.status === "draft" && (
              <Button variant="primary" size="md" onClick={() => publishPacket(false)}>
                Publish
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Publish success modal */}
      </main>
    </div>
  );
}

// ============================================================
// Sortable Section wrapper (drag handle provided to children)
// ============================================================
type SectionHandleProps = {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
};

function SortableSection({
  id,
  children,
}: {
  id: string;
  children: (handle: SectionHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="mb-8 border border-line rounded-[var(--radius-panel)] p-4">
      {children({ attributes, listeners })}
    </div>
  );
}

// ============================================================
// Item Editor Component
// ============================================================
// Detail rows — reorderable, same mental model as items and sections
//
// Import order is where a Detail list starts, not where it has to stay: the
// professional decides what a family reads first. The alternative was retyping
// rows to move one line, which is what prompted this.
//
// The order IS the array. update_item_content assigns item_details.sort_order
// from array position, and every renderer already reads `order("sort_order")`,
// so a move here reaches the live FlowGuide, print and email without any of
// them changing.
//
// Its own DndContext, nested inside the item and section ones exactly as the
// item list already nests inside the section list — a detail drag must not be
// interpreted as dragging the card it lives in. Sensors are declared here for
// the same reason, and include the KeyboardSensor the rest of the editor uses,
// so the handle is reachable with a keyboard rather than a mouse only.
// ============================================================
function DetailRows({
  item,
  onUpdateDetail,
  onReorderDetail,
  onRemoveDetail,
}: {
  item: EditorItem;
  onUpdateDetail: (itemId: string, detailId: string, field: "label" | "value", value: string) => void;
  onReorderDetail: (itemId: string, activeId: string, overId: string) => void;
  onRemoveDetail: (itemId: string, detailId: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(e: DragEndEvent) => {
        const { active, over } = e;
        if (over && active.id !== over.id) onReorderDetail(item.id, String(active.id), String(over.id));
      }}
    >
      <SortableContext items={item.details.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        {item.details.map((detail) => (
          <SortableDetailRow
            key={detail.id}
            itemId={item.id}
            detail={detail}
            onUpdateDetail={onUpdateDetail}
            onRemoveDetail={onRemoveDetail}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableDetailRow({
  itemId,
  detail,
  onUpdateDetail,
  onRemoveDetail,
}: {
  itemId: string;
  detail: EditorDetail;
  onUpdateDetail: (itemId: string, detailId: string, field: "label" | "value", value: string) => void;
  onRemoveDetail: (itemId: string, detailId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: detail.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // The label names the row for anyone who cannot see it being dragged; an
  // unlabelled row still says which one it is by falling back to its value.
  const named = detail.label.trim() || detail.value.trim();

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 mb-1.5">
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={named ? `Reorder detail: ${named}` : "Reorder detail"}
        className="text-ink-3/45 hover:text-ink-2 cursor-grab active:cursor-grabbing flex-shrink-0 touch-none p-1 -ml-1"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="7" cy="4" r="1.5" />
          <circle cx="13" cy="4" r="1.5" />
          <circle cx="7" cy="10" r="1.5" />
          <circle cx="13" cy="10" r="1.5" />
          <circle cx="7" cy="16" r="1.5" />
          <circle cx="13" cy="16" r="1.5" />
        </svg>
      </button>
      <input
        type="text"
        value={detail.label}
        onChange={(e) => onUpdateDetail(itemId, detail.id, "label", e.target.value)}
        placeholder="Label"
        className="flex-1 px-2.5 py-1.5 rounded border border-line text-body focus:outline-none focus:ring-2 focus:ring-mark/15 placeholder:text-ink-3/45"
      />
      <input
        type="text"
        value={detail.value}
        onChange={(e) => onUpdateDetail(itemId, detail.id, "value", e.target.value)}
        placeholder="Value"
        className="flex-1 px-2.5 py-1.5 rounded border border-line text-body focus:outline-none focus:ring-2 focus:ring-mark/15 placeholder:text-ink-3/45"
      />
      <button
        onClick={() => onRemoveDetail(itemId, detail.id)}
        className="text-body text-red-400 hover:text-red-600 px-1"
        aria-label={named ? `Remove detail: ${named}` : "Remove detail"}
      >
        ×
      </button>
    </div>
  );
}


// ============================================================
function ItemEditor({
  item,
  sections,
  onMove,
  onUpdateField,
  onDelete,
  onLibraryChanged,
  onAddDetail,
  onUpdateDetail,
  onReorderDetail,
  onRemoveDetail,
  onAddLink,
  onUpdateLink,
  onRemoveLink,
  onAddContact,
  onUpdateContact,
  onRemoveContact,
  onAddPhoto,
  onUpdatePhoto,
  onUploadPhoto,
  onUploadNewPhoto,
  newPhotoUploading,
  photoUploading,
  photoError,
  onRemovePhoto,
}: {
  item: EditorItem;
  sections: { id: string; title: string }[];
  onMove: (itemId: string, targetSectionId: string) => void;
  onUpdateField: (id: string, field: string, value: string) => void;
  onDelete: (id: string) => void;
  onLibraryChanged: (message: string) => void;
  onAddDetail: (itemId: string) => void;
  onUpdateDetail: (itemId: string, detailId: string, field: "label" | "value", value: string) => void;
  onReorderDetail: (itemId: string, activeId: string, overId: string) => void;
  onRemoveDetail: (itemId: string, detailId: string) => void;
  onAddLink: (itemId: string) => void;
  onUpdateLink: (itemId: string, linkId: string, field: "url" | "label", value: string) => void;
  onRemoveLink: (itemId: string, linkId: string) => void;
  onAddContact: (itemId: string) => void;
  onUpdateContact: (itemId: string, contactId: string, field: "name" | "role" | "phone" | "email" | "website", value: string) => void;
  onRemoveContact: (itemId: string, contactId: string) => void;
  onAddPhoto: (itemId: string) => void;
  onUpdatePhoto: (itemId: string, photoId: string, url: string) => void;
  onUploadPhoto: (itemId: string, photoId: string, file: File) => void;
  onUploadNewPhoto: (itemId: string, file: File) => void;
  newPhotoUploading: string;
  photoUploading: string;
  photoError: string;
  onRemovePhoto: (itemId: string, photoId: string) => void;
}) {
  // Open expanded by default so the full canonical editor is visible immediately
  // (including for new/empty manual items). The collapse control still works.
  const [expanded, setExpanded] = useState(true);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const otherSections = sections.filter((s) => s.id !== item.sectionId);

  return (
    <div ref={setNodeRef} style={style} className="border border-line rounded-[var(--radius-control)] p-3 bg-ground">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          className="text-ink-3 hover:text-ink cursor-grab active:cursor-grabbing flex-shrink-0 touch-none -ml-1 p-1"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <circle cx="7" cy="4" r="1.5" />
            <circle cx="13" cy="4" r="1.5" />
            <circle cx="7" cy="10" r="1.5" />
            <circle cx="13" cy="10" r="1.5" />
            <circle cx="7" cy="16" r="1.5" />
            <circle cx="13" cy="16" r="1.5" />
          </svg>
        </button>
        <input
          type="text"
          value={item.title}
          onChange={(e) => onUpdateField(item.id, "title", e.target.value)}
          placeholder={titleLabelFor(item)}
          aria-label={titleLabelFor(item)}
          className="flex-1 font-medium text-body text-ink bg-transparent border-none outline-none placeholder:text-ink-3/45"
        />
        <div className="flex items-center gap-1 flex-shrink-0">
          {otherSections.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) onMove(item.id, e.target.value);
              }}
              aria-label="Move to section"
              className="text-body text-ink-2 border border-line rounded px-1 py-0.5 bg-ground max-w-[8rem] focus:outline-none focus:ring-2 focus:ring-mark/15"
            >
              <option value="">Move to…</option>
              {otherSections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title || "Untitled section"}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-body text-ink-2 hover:text-ink px-1"
          >
            {expanded ? "▾" : "▸"}
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="text-body text-red-400 hover:text-red-600 px-1"
          >
            ×
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Library: which action is offered is decided by lineage, not a menu
              that always shows everything. */}
          <ItemLibraryActions
            packetItemId={item.id}
            itemTitle={item.title}
            libraryItemId={item.libraryItemId ?? null}
            onChanged={onLibraryChanged}
          />

          {/* Address */}
          <div className="flex items-center gap-2">
            <span className="text-ink-3 text-body flex-shrink-0">📍</span>
            <input
              type="text"
              value={item.address}
              onChange={(e) => onUpdateField(item.id, "address", e.target.value)}
              placeholder="Address (auto-links to Google Maps)"
              className={`${INPUT_SHELL} flex-1`}
            />
          </div>

          {/* Description */}
          <textarea
            value={item.description}
            onChange={(e) => onUpdateField(item.id, "description", e.target.value)}
            placeholder="Description"
            rows={2}
            className={`${INPUT_SHELL} resize-y`}
          />

          {/* Details */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-meta font-medium text-ink-2 uppercase tracking-wide">Details</span>
              <button onClick={() => onAddDetail(item.id)} className="text-body text-mark hover:text-mark/80">
                + Add
              </button>
            </div>
            <DetailRows
              item={item}
              onUpdateDetail={onUpdateDetail}
              onReorderDetail={onReorderDetail}
              onRemoveDetail={onRemoveDetail}
            />
          </div>

          {/* Links */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-meta font-medium text-ink-2 uppercase tracking-wide">Links</span>
              <button onClick={() => onAddLink(item.id)} className="text-body text-mark hover:text-mark/80">
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
                  className="flex-[2] px-2.5 py-1.5 rounded border border-line text-body focus:outline-none focus:ring-2 focus:ring-mark/15 placeholder:text-ink-3/45"
                />
                <input
                  type="text"
                  value={link.label}
                  onChange={(e) => onUpdateLink(item.id, link.id, "label", e.target.value)}
                  placeholder="Label"
                  className="flex-1 px-2.5 py-1.5 rounded border border-line text-body focus:outline-none focus:ring-2 focus:ring-mark/15 placeholder:text-ink-3/45"
                />
                <button
                  onClick={() => onRemoveLink(item.id, link.id)}
                  className="text-body text-red-400 hover:text-red-600 px-1"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Photos */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-meta font-medium text-ink-2 uppercase tracking-wide">Photos</span>
              <div className="flex items-center gap-3">
                {/* THE ACTION, NOT A STEP TOWARDS IT. Upload was previously
                    reachable only by pressing "+ Add" first and then noticing a
                    small button beside the URL field it produced — so the thing
                    most people want was two moves behind the thing most people
                    do not. Pasting a URL stays, one button along. */}
                <label
                  className={`text-body ${
                    newPhotoUploading === item.id
                      ? "text-ink-2 pointer-events-none"
                      : "text-mark hover:text-mark/80 cursor-pointer"}`}
                >
                  {newPhotoUploading === item.id ? "Uploading…" : "Upload"}
                  <input
                    type="file"
                    accept={PHOTO_ACCEPT_ATTR}
                    className="hidden"
                    disabled={newPhotoUploading === item.id}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      // Cleared so choosing the same file twice still fires.
                      e.target.value = "";
                      if (f) onUploadNewPhoto(item.id, f);
                    }}
                  />
                </label>
                <button onClick={() => onAddPhoto(item.id)} className="text-body text-mark hover:text-mark/80">
                  + Add URL
                </button>
              </div>
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
                        className="w-16 h-16 rounded-[var(--radius-control)] object-cover border border-line"
                      />
                      <button
                        onClick={() => onRemovePhoto(item.id, photo.id)}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-meta flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
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
                    className="flex-1 px-2.5 py-1.5 rounded border border-line text-body focus:outline-none focus:ring-2 focus:ring-mark/15 placeholder:text-ink-3/45"
                  />
                  {/* Upload sits BESIDE the URL field, not instead of it. A
                      professional who already keeps images somewhere should not
                      have to re-upload them to keep working. */}
                  <label
                    className={`shrink-0 px-2.5 py-1.5 rounded border border-line text-body cursor-pointer
                                hover:bg-ground-2 ${photoUploading === photo.id ? "opacity-60 pointer-events-none" : ""}`}
                  >
                    {photoUploading === photo.id ? "Uploading…" : "Upload"}
                    <input
                      type="file"
                      accept={PHOTO_ACCEPT_ATTR}
                      className="hidden"
                      disabled={photoUploading === photo.id}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        // Cleared so choosing the same file twice still fires.
                        e.target.value = "";
                        if (f) onUploadPhoto(item.id, photo.id, f);
                      }}
                    />
                  </label>
                  <button
                    onClick={() => onRemovePhoto(item.id, photo.id)}
                    className="text-body text-red-400 hover:text-red-600 px-1"
                  >
                    ×
                  </button>
                </div>
              ))}
            {photoError && <p className="text-body text-red-600 mt-1">{photoError}</p>}
          </div>

          {/* TWO FIELDS, TWO AUDIENCES — and the labels have to make that
              unmistakable. The single field that used to live here said
              "shown as a highlighted callout" long after the callout stopped
              reaching recipients (8bcb0ab), so it promised the opposite of what
              it did. Each field now states its audience above the box. */}

          {/* Shown to the client. */}
          <div>
            <label className="block text-meta font-medium text-amber-800 mb-1">
              Highlight for Client
              <span className="ml-1.5 font-normal text-amber-700/80">
                Shown to your client as a highlighted callout.
              </span>
            </label>
            <textarea
              value={item.highlight}
              onChange={(e) => onUpdateField(item.id, "highlight", e.target.value)}
              placeholder="e.g. I checked and they heat their pool to 82 degrees, because you asked."
              rows={2}
              className="w-full px-3 py-2 rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 text-body resize-y focus:outline-none focus:ring-2 focus:ring-amber-300 placeholder:text-amber-400/70"
            />
          </div>

          {/* NOT shown to the client. Deliberately styled differently from the
              amber box above so the two are not mistaken for each other at a
              glance — same shape would invite writing a client note here. */}
          <div>
            <label className="block text-meta font-medium text-ink-2 mb-1">
              Private Notes
              <span className="ml-1.5 font-normal text-ink-2/80">
                Only you see this. Never shown to your client, or in print or email.
              </span>
            </label>
            <textarea
              value={item.notes}
              onChange={(e) => onUpdateField(item.id, "notes", e.target.value)}
              placeholder="For your reference only"
              rows={2}
              className={`${INPUT_SHELL} resize-y bg-ground-2`}
            />
          </div>

          {/* Contacts — an ordered list; an item may have multiple people. */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-meta font-medium text-ink-2">Contacts (people)</span>
              <button
                onClick={() => onAddContact(item.id)}
                className="text-body text-mark hover:text-mark/80 font-medium"
              >
                + Add contact
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {item.contacts.map((c, ci) => {
                const cInput = "px-2.5 py-1.5 rounded border border-line text-body focus:outline-none focus:ring-2 focus:ring-mark/15 placeholder:text-ink-3/45";
                return (
                  <div key={c.id} className="rounded-[var(--radius-control)] border border-line p-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-meta font-medium text-ink-2">Contact {ci + 1}</span>
                      <button onClick={() => onRemoveContact(item.id, c.id)} className="text-meta text-red-400 hover:text-red-600 font-medium">Remove</button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input type="text" value={c.name} onChange={(e) => onUpdateContact(item.id, c.id, "name", e.target.value)} placeholder="Name" className={cInput} />
                      <input type="text" value={c.role} onChange={(e) => onUpdateContact(item.id, c.id, "role", e.target.value)} placeholder="Role (optional)" className={cInput} />
                      <input type="tel" value={c.phone} onChange={(e) => onUpdateContact(item.id, c.id, "phone", e.target.value)} placeholder="Phone" className={cInput} />
                      <input type="email" value={c.email} onChange={(e) => onUpdateContact(item.id, c.id, "email", e.target.value)} placeholder="Email" className={cInput} />
                      <input type="url" value={c.website} onChange={(e) => onUpdateContact(item.id, c.id, "website", e.target.value)} placeholder="Website (this person's own)" className={`${cInput} col-span-2`} />
                    </div>
                  </div>
                );
              })}
            </div>
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
    <div className="mb-8 border border-line rounded-[var(--radius-panel)] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-ground-2 transition-colors"
      >
        <span className="text-meta font-medium uppercase tracking-widest text-ink-2">
          Original Input
        </span>
        <span className="text-meta text-ink-2">{open ? "▾ Hide" : "▸ Show"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <pre className="text-meta text-ink-2 leading-relaxed whitespace-pre-wrap font-sans bg-ground-2 rounded-[var(--radius-control)] p-3 max-h-64 overflow-y-auto">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
