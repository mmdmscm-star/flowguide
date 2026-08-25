"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const PACKET_TYPES = [
  { value: "senior-placement", label: "Senior placement" },
  { value: "real-estate", label: "Real estate" },
  { value: "general", label: "General" },
];

export default function NewPacketWorkspace() {
  const router = useRouter();
  const [rawText, setRawText] = useState("");
  const [packetType, setPacketType] = useState("general");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  // Stable idempotency key for the Organize POST, generated once per source. A
  // retry after a lost response reuses it (server returns the same packet/run);
  // changing the source mints a new key (a genuinely new import).
  const requestKeyRef = useRef<string | null>(null);
  const keySourceRef = useRef<string>("");

  async function handleOrganize() {
    const source = rawText.trim();
    if (!source) {
      setError("Paste some text first.");
      return;
    }
    setError("");
    setProcessing(true);

    if (!requestKeyRef.current || keySourceRef.current !== source) {
      requestKeyRef.current = crypto.randomUUID();
      keySourceRef.current = source;
    }

    try {
      // ONE atomic call creates the draft packet + ingestion run + chunk plan +
      // origin marker together, so a partial failure can't leave an orphan draft.
      // The request key makes a duplicate/retried POST return the same packet.
      const ing = await fetch("/api/ingest/organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText: source, packetType, requestKey: requestKeyRef.current }),
      });
      if (ing.status === 401) { router.push("/login"); return; }
      const data = await ing.json();
      if (!ing.ok || !data.packetId || !data.runId) {
        setError(data.message || data.error || "Could not start organizing. Try again.");
        setProcessing(false);
        return;
      }

      // Hand off to the editor, which hosts the import progress + resume.
      router.push(`/edit/${data.packetId}?import=${data.runId}`);
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

  const ready = Boolean(rawText.trim()) && !processing;

  return (
    <main className="mx-auto max-w-2xl px-5 py-8">
      <button
        onClick={() => router.push("/dashboard")}
        className="mb-8 inline-block text-sm text-muted transition-colors hover:text-foreground"
      >
        &larr; Back to dashboard
      </button>

      {/* The heading names the professional's situation rather than the
          machine's job. The packet is the product; AI is one input. */}
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Start with what you already have
      </h1>
      <p className="mt-2 max-w-xl text-base leading-relaxed text-muted">
        Paste notes, a spreadsheet, an email thread, or anything else you&rsquo;re working from.
        FlowGuide will shape it into a packet you can review, refine, and send.
      </p>

      {/* THE CREATION SURFACE.
          One card, using the same rounded-xl / border language as an item card,
          so the thing you compose in visually rhymes with the thing you are
          composing. `focus-within` lights the WHOLE surface rather than just the
          field — the page responds to you, instead of a control switching on. */}
      <div className="mt-7 overflow-hidden rounded-xl border border-border bg-card transition-shadow duration-200 focus-within:border-accent/40 focus-within:shadow-[0_0_0_3px_rgb(37_99_235_/_0.08)]">
        {/* Packet type lives here as document metadata rather than a mode
            switch. Still visible, still one tap to change — it was previously
            the loudest element on a page whose subject is the paste area. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2.5">
          <span className="text-xs text-muted">Packet type</span>
          <div className="flex flex-wrap gap-1">
            {PACKET_TYPES.map((type) => {
              const active = packetType === type.value;
              return (
                <button
                  key={type.value}
                  onClick={() => setPacketType(type.value)}
                  aria-pressed={active}
                  disabled={processing}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? "bg-card text-foreground ring-1 ring-border"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {type.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* text-base is 16px — below 16 iOS Safari auto-zooms the page on focus,
            which is a real bug on the authoring surface of a product whose
            recipient reading tier was deliberately raised for older eyes. */}
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="Paste your notes here…"
          aria-label="Your notes"
          disabled={processing}
          className="block h-64 w-full resize-y border-0 bg-card px-4 py-3.5 text-base leading-relaxed text-foreground outline-none placeholder:text-gray-400 disabled:opacity-60 sm:h-80"
        />

        {/* Guidance lives BELOW the field, not inside the placeholder, so it
            survives the first keystroke. */}
        <p className="border-t border-border bg-surface px-4 py-2.5 text-xs leading-relaxed text-muted">
          It doesn&rsquo;t need to be tidy. Spreadsheet rows, names, prices, links and contacts all work.
        </p>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          onClick={handleOrganize}
          disabled={!ready}
          // A faded-accent disabled state reads as a BROKEN primary button on
          // arrival. Neutral-until-ready reads as "not yet", and turning accent
          // the moment there is something to work with is a small earned moment.
          className={`rounded-lg px-6 py-3 text-base font-medium transition-colors ${
            ready
              ? "bg-accent text-white hover:bg-accent-hover"
              : "cursor-not-allowed bg-gray-100 text-gray-400"
          }`}
        >
          {processing ? "Creating first draft…" : "Create first draft"}
        </button>
        {/* A text link: as a bordered button it competed at equal weight with
            the primary path at the exact moment of commitment. */}
        <button
          onClick={handleStartBlank}
          disabled={processing}
          className="text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
        >
          Start blank instead
        </button>
      </div>

      {processing && (
        <div className="mt-6 flex items-center gap-3 text-sm text-muted">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          AI is reading your notes and organizing them into sections...
        </div>
      )}
    </main>
  );
}
