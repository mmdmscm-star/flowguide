"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PACKET_TYPES = [
  { value: "senior-placement", label: "Senior Placement" },
  { value: "real-estate", label: "Real Estate" },
  { value: "general", label: "General" },
];

export default function NewPacketPage() {
  const router = useRouter();
  const [rawText, setRawText] = useState("");
  const [packetType, setPacketType] = useState("general");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");

  async function handleOrganize() {
    if (!rawText.trim()) {
      setError("Paste some text first.");
      return;
    }
    setError("");
    setProcessing(true);

    try {
      // 1. Create the packet with type
      const createRes = await fetch("/api/packets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "", packetType }),
      });
      if (createRes.status === 401) { router.push("/login"); return; }
      const { packet } = await createRes.json();
      if (!packet) { setError("Could not create packet."); setProcessing(false); return; }

      // 2. Start a persisted, resumable ingestion run (segments the source; the
      //    editor drives the chunks and shows real progress, so an ordinary or a
      //    large source both complete reliably instead of timing out all-at-once).
      const ing = await fetch(`/api/packets/${packet.id}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryPoint: "organize", rawText: rawText.trim(), packetType }),
      });
      const data = await ing.json();
      if (!ing.ok || !data.runId) {
        setError(data.message || data.error || "Could not start organizing. Try again.");
        setProcessing(false);
        return;
      }

      // 3. Hand off to the editor, which hosts the import progress + resume.
      router.push(`/edit/${packet.id}?import=${data.runId}`);
    } catch {
      setError("Something went wrong. Please try again.");
      setProcessing(false);
    }
  }

  async function handleStartBlank() {
    const res = await fetch("/api/packets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "", packetType }),
    });
    if (res.status === 401) { router.push("/login"); return; }
    const { packet } = await res.json();
    if (packet) router.push(`/edit/${packet.id}`);
  }

  return (
    <main className="max-w-2xl mx-auto px-5 py-8">
      <button
        onClick={() => router.push("/dashboard")}
        className="text-sm text-muted hover:text-foreground mb-6 inline-block"
      >
        &larr; Back to dashboard
      </button>

      <h1 className="text-2xl font-bold text-foreground mb-2">New Packet</h1>
      <p className="text-sm text-muted mb-6">
        Paste your notes, recommendations, or any raw info. AI will organize it into a shareable packet.
      </p>

      {/* Packet type selector */}
      <div className="mb-6">
        <label className="block text-xs font-medium uppercase tracking-widest text-muted mb-2">
          Packet Type
        </label>
        <div className="flex flex-wrap gap-2">
          {PACKET_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => setPacketType(type.value)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                packetType === type.value
                  ? "bg-accent text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>

      <textarea
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
        placeholder={"Paste your notes here...\n\nExamples of what works well:\n• Meeting notes with recommendations\n• A list of options you discussed with a client\n• Copied text from a spreadsheet or CRM\n• Any freeform text with names, details, links, contacts"}
        className="w-full h-64 px-4 py-3 rounded-xl border border-border bg-white text-sm text-foreground placeholder:text-gray-400 resize-y focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
        disabled={processing}
      />

      {error && (
        <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={handleOrganize}
          disabled={processing || !rawText.trim()}
          className="px-6 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {processing ? "Organizing..." : "Organize with AI"}
        </button>
        <button
          onClick={handleStartBlank}
          disabled={processing}
          className="px-4 py-2.5 rounded-lg text-sm font-medium text-muted hover:text-foreground border border-border hover:border-gray-300 transition-colors disabled:opacity-50"
        >
          Start blank instead
        </button>
      </div>

      {processing && (
        <div className="mt-6 flex items-center gap-3 text-sm text-muted">
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          AI is reading your notes and organizing them into sections...
        </div>
      )}
    </main>
  );
}
