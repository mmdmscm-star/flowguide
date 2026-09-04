"use client";

import { useRef, useState } from "react";
import { PHOTO_ACCEPT_ATTR } from "@/lib/photo-upload";
import { TEXT_FILE_ACCEPT, readTextFile, TextFileError, delimiterForFile } from "@/lib/text-file-import";
import { useRouter } from "next/navigation";

const PACKET_TYPES = [
  { value: "senior-placement", label: "Senior placement" },
  { value: "real-estate", label: "Real estate" },
  { value: "general", label: "General" },
];

export default function NewPacketWorkspace() {
  const router = useRouter();
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [readingImage, setReadingImage] = useState(false);
  /** THE PICTURE, STILL ON THIS DEVICE. Held as the File itself with a local
   *  object URL for the preview — nothing has been uploaded. It is sent to be
   *  KEPT only when the professional presses Organize, so abandoning this page
   *  leaves no copy of their document anywhere. */
  const [sourceImage, setSourceImage] = useState<{ file: File; preview: string } | null>(null);
  // Declared by the file the professional chose, not inferred from the text.
  // Cleared whenever they type, because once the box has been edited by hand
  // the text is no longer the file we were told about.
  const [delimiterHint, setDelimiterHint] = useState<string | null>(null);
  const [packetType, setPacketType] = useState("general");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  // Stable idempotency key for the Organize POST, generated once per source. A
  // retry after a lost response reuses it (server returns the same packet/run);
  // changing the source mints a new key (a genuinely new import).
  const requestKeyRef = useRef<string | null>(null);
  const keySourceRef = useRef<string>("");

  // A FILE IS A SEED. It is read here, its text goes into the same box a paste
  // goes into, and the file is never uploaded or stored. What gets organized is
  // text either way, so nothing downstream can tell the difference.
  //
  // The text is SHOWN rather than submitted straight through, so a professional
  // sees what was actually read — a mangled encoding or a spreadsheet that
  // exported strangely is visible before anything is created.
  // THE PICTURE, AND THE TEXT READ OUT OF IT.
  //
  // The image is kept on screen beside its transcription for exactly one
  // reason: the professional is being asked to CORRECT the text, and a
  // correction you cannot check against the original is a guess. It stays until
  // they remove it or organize.
  async function handlePicture(file: File) {
    setError("");
    setReadingImage(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/ingest/transcribe", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.text) {
        // WHOSE REFUSAL THIS WAS. "That image is larger than 10MB" is our rule;
        // "the AI service would not accept that image" is theirs, and telling
        // them apart is the difference between a fixable file and a retry.
        setError(data?.message || "That image could not be read.");
        return;
      }
      setRawText((prev) => (prev.trim()
        ? `${prev.replace(/\s+$/, "")}\n\n${data.text}`
        : data.text));
      // A local preview. createObjectURL never leaves the browser.
      setSourceImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.preview);
        return { file, preview: URL.createObjectURL(file) };
      });
      // A photographed table is not a delimited file, and claiming a delimiter
      // for it would be a hint we cannot stand behind.
      setDelimiterHint(null);
    } catch {
      setError("Could not read that image. Check your connection and try again.");
    } finally {
      setReadingImage(false);
    }
  }

  async function handleFile(file: File) {
    setError("");
    try {
      const text = await readTextFile(file);
      setRawText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${text}` : text));
      setFileName(file.name);
      setDelimiterHint((prev) => {
        const declared = delimiterForFile(file.name);
        // Two files with different delimiters describe one source that is
        // neither; claiming either would be a hint we cannot stand behind.
        if (!declared) return prev;
        return prev && prev !== declared ? null : declared;
      });
    } catch (e) {
      setFileName("");
      setError(e instanceof TextFileError ? e.message : "That file couldn’t be read.");
    }
  }

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
      // KEEP THE PICTURE ONLY NOW. This is the explicit continue: up to this
      // point the document has never left the device. If storing it fails
      // nothing is created at all, because a run that cannot carry its
      // provenance must not exist (0045).
      let sourceImageUrl: string | null = null;
      if (sourceImage) {
        const body = new FormData();
        body.append("file", sourceImage.file);
        const up = await fetch("/api/ingest/source-image", { method: "POST", body });
        const stored = await up.json().catch(() => ({}));
        if (!up.ok || !stored?.url) {
          setError(stored?.message || "Could not save the picture, so nothing was organized. Please try again.");
          setProcessing(false);
          return;
        }
        sourceImageUrl = stored.url as string;
      }

      // ONE atomic call creates the draft packet + ingestion run + chunk plan +
      // origin marker together, so a partial failure can't leave an orphan draft.
      // The request key makes a duplicate/retried POST return the same packet.
      const ing = await fetch("/api/ingest/organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawText: source, packetType, requestKey: requestKeyRef.current,
          ...(delimiterHint ? { delimiterHint } : {}),
          // Present only for a picture, so every other path stays a text run.
          ...(sourceImageUrl ? { sourceImageUrl } : {}),
        }),
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
        Sendset will shape it into a draft you can review, refine, and send.
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
        {sourceImage && (
          <div className="flex items-start gap-3 border-b border-border bg-card/60 px-4 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sourceImage.preview}
              alt="The picture this text was read from"
              className="h-28 w-28 flex-none rounded-lg border border-border object-contain bg-white sm:h-40 sm:w-40"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Read from your picture</p>
              <p className="mt-0.5 text-xs text-muted">
                Check it against the image and fix anything it misread — especially
                prices and phone numbers. What you organize is the text below, not
                the picture.
              </p>
              {/* TWO PATHS, TWO DIFFERENT ANSWERS. A .csv is read on the device
                  and never leaves it; nothing can read a picture locally, so
                  this one was sent to be transcribed. Saying so is cheap, and a
                  professional photographing a client document is entitled to
                  know which of the two just happened. */}
              <p className="mt-1 text-xs text-muted/80">
                Sent to our AI provider for transcription using zero-data-retention
                routing. If you continue, Sendset keeps the source image with the
                ingestion evidence for the normal retention period. A .csv, .txt or
                .md file is read on your device instead.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (sourceImage) URL.revokeObjectURL(sourceImage.preview);
                  setSourceImage(null);
                }}
                disabled={processing || readingImage}
                className="mt-2 text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-60"
              >
                Remove the picture
              </button>
            </div>
          </div>
        )}
        <textarea
          value={rawText}
          onChange={(e) => { setRawText(e.target.value); setDelimiterHint(null); }}
          placeholder="Paste your notes here…"
          aria-label="Your notes"
          disabled={processing}
          className="block h-64 w-full resize-y border-0 bg-card px-4 py-3.5 text-base leading-relaxed text-foreground outline-none placeholder:text-gray-400 disabled:opacity-60 sm:h-80"
        />

        {/* Guidance lives BELOW the field, not inside the placeholder, so it
            survives the first keystroke. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-surface px-4 py-2.5">
          <p className="text-xs leading-relaxed text-muted">
            It doesn&rsquo;t need to be tidy. Spreadsheet rows, names, prices, links and contacts all work.
          </p>
          {/* A PICTURE IS SOURCE MATERIAL, not content. It is read into the box
              below, where it can be corrected, and only the corrected text is
              ever structured. The picture itself never reaches a client. */}
          <label className={`ml-auto shrink-0 cursor-pointer text-xs font-medium text-accent hover:text-accent-hover ${
            processing || readingImage ? "pointer-events-none opacity-60" : ""}`}>
            {readingImage ? "Reading the picture…" : "or use a picture"}
            <input
              type="file"
              accept={PHOTO_ACCEPT_ATTR}
              className="hidden"
              disabled={processing || readingImage}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Cleared so choosing the same file twice still fires.
                e.target.value = "";
                if (f) handlePicture(f);
              }}
            />
          </label>
          <label className={`shrink-0 cursor-pointer text-xs font-medium text-accent hover:text-accent-hover ${processing || readingImage ? "pointer-events-none opacity-60" : ""}`}>
            {fileName ? `Added ${fileName} — add another` : "or open a .csv, .txt or .md file"}
            <input
              type="file"
              accept={TEXT_FILE_ACCEPT}
              className="hidden"
              disabled={processing || readingImage}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Cleared so choosing the same file twice still fires.
                e.target.value = "";
                if (f) handleFile(f);
              }}
            />
          </label>
        </div>
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
