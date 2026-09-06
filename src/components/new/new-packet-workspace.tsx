"use client";

import { useEffect, useRef, useState } from "react";
import { PHOTO_ACCEPT_ATTR } from "@/lib/photo-upload";
import { TEXT_FILE_ACCEPT, readTextFile, TextFileError, delimiterForFile } from "@/lib/text-file-import";
import { planBundle, blockingImage, blockingMessage, type BundleItem } from "@/lib/source-bundle";
import { removeContributedBlock } from "@/lib/contributed-block";
import { useRouter } from "next/navigation";

/** ONE PAGE OF THE SOURCE, still on this device.
 *
 *  `preview` is an object URL and is revoked on removal and on unmount — one
 *  blob per page adds up, and the previous single-image version leaked its one
 *  on every abandoned visit. */
interface SourceImage {
  id: string;
  file: File;
  preview: string;
  status: "reading" | "done" | "failed";
  /** Named so a failure can say WHICH page, rather than "an image failed".
   *  From a monotonic counter, never from the list length: removing a picture
   *  used to renumber the ones after it, so two could end up called "Picture 2"
   *  and the one job the label has — naming the failure — was defeated. */
  label: string;
  /** EXACTLY what this picture put in the box, kept so it can be taken back out
   *  byte-for-byte or not at all. Present only once the picture is `done`. */
  contributedText?: string;
  error?: string;
}

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
  /** OPTIONAL, AND OFF. Ambiguous grouping happens with pasted text, a CSV and
   *  a photograph alike, so this lives at the organize layer rather than beside
   *  any one input. Nobody is asked to classify anything to use the product;
   *  bulk messy input organized automatically is still the whole point. */
  const [keepTogether, setKeepTogether] = useState(false);
  const [groupingTitle, setGroupingTitle] = useState("");
  /** THE PICTURES, STILL ON THIS DEVICE, IN THE ORDER THEY WERE GIVEN.
   *
   *  Held as the Files themselves with local object URLs — nothing has been
   *  uploaded. They are sent to be KEPT only when the professional presses
   *  Organize, so abandoning this page leaves no copy of their documents.
   *
   *  ALL OF THEM, which is the change. A photographed three-page brochure used
   *  to keep exactly one preview, because the state was a single slot that each
   *  new picture overwrote — so the transcription accumulated and the evidence
   *  did not, and a mis-read licence number on page three could not be checked
   *  against pages one and two because they no longer existed anywhere. */
  const [sourceImages, setSourceImages] = useState<SourceImage[]>([]);
  /** The page open in the inspector, or null. Tiny print is the whole reason
   *  this exists: a 112px thumbnail cannot be read at six point. */
  const [inspecting, setInspecting] = useState<SourceImage | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Monotonic, so "Picture 4" means the fourth picture added in this session
   *  and keeps meaning that after any number of removals. */
  const pictureSeq = useRef(0);
  /** WHICH PICTURES ARE STILL LIVE, readable synchronously.
   *
   *  A transcription request is in flight for the length of a model call, and
   *  the professional can remove its picture in that time. React state is not
   *  readable from inside the awaited handler, so a ref carries the answer —
   *  and `removeImage` updates it synchronously, so the check immediately
   *  before appending cannot race. Without it a removed picture's text still
   *  landed in the box: text with no evidence behind it, arrived at from the
   *  other direction. */
  const liveIds = useRef<Set<string>>(new Set());
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
  // goes into, and a text file is never uploaded or stored. What gets organized
  // is text either way, so nothing downstream can tell the difference.
  //
  // The text is SHOWN rather than submitted straight through, so a professional
  // sees what was actually read — a mangled encoding or a spreadsheet that
  // exported strangely is visible before anything is created.

  /** Append one contribution to the box, blank-line separated.
   *
   *  NO PAGE MARKERS. A "--- Image 2 ---" line would become part of source_text
   *  and reach the claim parser, the record detector and the omission check as
   *  though the professional had written it — and a repeated top-level marker
   *  is exactly the shape detectListRecords looks for. A blank line is what a
   *  paste already uses and it carries no meaning downstream. */
  const append = (text: string) => {
    const t = String(text ?? "").trim();
    if (!t) return;
    setRawText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${t}` : t));
  };

  /** ONE PICTURE, ONE MODEL CALL. Never several images in one request: that is
   *  the cross-image inference this pipeline refuses, and it would also destroy
   *  per-page failure attribution. */
  async function transcribeOne(entry: SourceImage): Promise<boolean> {
    const body = new FormData();
    body.append("file", entry.file);
    try {
      const res = await fetch("/api/ingest/transcribe", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.text) {
        // WHOSE REFUSAL THIS WAS. "That image is larger than 10MB" is our rule;
        // "the AI service would not accept that image" is theirs, and telling
        // them apart is the difference between a fixable file and a retry.
        // AND WHICH PAGE. "An image could not be read" is useless with five.
        const message = data?.message || "That picture could not be read.";
        setSourceImages((prev) => prev.map((x) =>
          x.id === entry.id ? { ...x, status: "failed", error: message } : x));
        setError(`${entry.label}: ${message}`);
        return false;
      }
      // STILL LIVE? Checked here, immediately before the append, because this
      // is the last instant at which the answer can change.
      if (!liveIds.current.has(entry.id)) return false;
      append(data.text);
      setSourceImages((prev) => prev.map((x) =>
        x.id === entry.id ? { ...x, status: "done", contributedText: String(data.text).trim() } : x));
      return true;
    } catch {
      const message = "Could not reach the AI service.";
      setSourceImages((prev) => prev.map((x) =>
        x.id === entry.id ? { ...x, status: "failed", error: message } : x));
      setError(`${entry.label}: ${message} Check your connection and try again.`);
      return false;
    }
  }

  async function readOneTextFile(file: File) {
    const text = await readTextFile(file);
    append(text);
    setFileName(file.name);
    setDelimiterHint((prev) => {
      const declared = delimiterForFile(file.name);
      // Two files with different delimiters describe one source that is
      // neither; claiming either would be a hint we cannot stand behind.
      if (!declared) return prev;
      return prev && prev !== declared ? null : declared;
    });
  }

  // THE ONE WAY IN. Browsing and dropping both land here, so there is no second
  // idea of what a supported file is and no second upload path.
  //
  // STRICTLY IN THE ORDER SUPPLIED, and sequentially. A text file is read on
  // the device in microseconds and would otherwise finish first and jump ahead
  // of an image it was dropped after; awaiting each in turn makes the order the
  // professional gave the order the transcription reads in. It also keeps this
  // browser to one provider request at a time — six at once is the shape that
  // once triggered a capacity refusal and shredded a 110-item import.
  async function ingestFiles(files: File[]) {
    setError("");
    const plan = planBundle(files);
    if (!plan.ok) { setError(plan.message); return; }

    // Every picture gets its slot and its preview BEFORE any reading starts, so
    // the professional sees the whole bundle immediately and watches it fill in.
    const entries = new Map<BundleItem, SourceImage>();
    for (const item of plan.items) {
      if (item.kind !== "image") continue;
      const id = crypto.randomUUID();
      liveIds.current.add(id);
      entries.set(item, {
        id, file: item.file,
        preview: URL.createObjectURL(item.file),
        status: "reading", label: `Picture ${++pictureSeq.current}`,
      });
    }
    if (entries.size) {
      setSourceImages((prev) => [...prev, ...plan.items.flatMap((i) => {
        const e = entries.get(i); return e ? [e] : [];
      })]);
      setReadingImage(true);
    }

    try {
      for (const item of plan.items) {
        if (item.kind === "text") {
          try { await readOneTextFile(item.file); }
          catch (e) {
            setFileName("");
            setError(e instanceof TextFileError ? e.message : "That file couldn’t be read.");
          }
          continue;
        }
        const entry = entries.get(item);
        if (entry) await transcribeOne(entry);
      }
    } finally {
      setReadingImage(false);
    }
    // A photographed table is not a delimited file, and claiming a delimiter
    // for it would be a hint we cannot stand behind.
    if (entries.size) setDelimiterHint(null);
  }

  /** Read a failed picture again.
   *
   *  The OTHER exit from a blocked Organize. Without it the only way past a
   *  picture the service refused once is to remove it and find the file again,
   *  which is a poor answer to a transient 429. It reuses the File already in
   *  hand and the same single-image path; nothing new reaches the server. */
  async function retryImage(id: string) {
    const target = sourceImages.find((x) => x.id === id);
    if (!target || target.status !== "failed") return;
    setError("");
    liveIds.current.add(id);
    setSourceImages((prev) => prev.map((x) =>
      x.id === id ? { ...x, status: "reading", error: undefined } : x));
    setReadingImage(true);
    try { await transcribeOne({ ...target, status: "reading" }); }
    finally { setReadingImage(false); }
  }

  /** Remove a picture, and with it exactly the text it contributed.
   *
   *  A `reading` picture cannot be removed at all: its request is in flight and
   *  a control whose effect depends on network timing is the wrong affordance.
   *  A `failed` one contributed nothing and goes freely. A `done` one goes only
   *  if its block is still there, untouched and unique — otherwise the refusal
   *  is explained and the professional's own text is left alone. */
  function removeImage(id: string) {
    const target = sourceImages.find((x) => x.id === id);
    if (!target) return;
    if (target.status === "reading") {
      setError(`${target.label} is still being read. Wait for it to finish first.`);
      return;
    }

    if (target.status === "done") {
      // EVERY OTHER LIVE PICTURE'S BLOCK GOES WITH THE QUESTION. Two photographs
      // of the same page contribute identical text; once the professional
      // deletes one copy by hand it appears exactly once, and neither picture
      // can be shown to own the survivor.
      const siblings = sourceImages
        .filter((x) => x.id !== id && x.status === "done" && x.contributedText)
        .map((x) => x.contributedText as string);
      const cut = removeContributedBlock(rawText, target.contributedText ?? "", siblings);
      if (!cut.ok) { setError(`${target.label}: ${cut.message}`); return; }
      setRawText(cut.text);
    }

    setError("");
    liveIds.current.delete(id);
    URL.revokeObjectURL(target.preview);
    setSourceImages((prev) => prev.filter((x) => x.id !== id));
    setInspecting((cur) => (cur?.id === id ? null : cur));
  }

  // EVERY OBJECT URL, ON THE WAY OUT. One blob per page is not free, and the
  // single-image version never revoked its one on unmount at all.
  const imagesRef = useRef<SourceImage[]>([]);
  useEffect(() => { imagesRef.current = sourceImages; }, [sourceImages]);
  useEffect(() => () => {
    for (const img of imagesRef.current) URL.revokeObjectURL(img.preview);
  }, []);

  // The inspector is a modal: Escape closes it, as a modal must.
  useEffect(() => {
    if (!inspecting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setInspecting(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspecting]);

  async function handleOrganize() {
    const source = rawText.trim();
    if (!source) {
      setError("Paste some text first.");
      return;
    }
    if (keepTogether && !groupingTitle.trim()) {
      setError("Name the item, or turn off keeping it together.");
      return;
    }
    // EVERY PICTURE SETTLED FIRST, and this is the guarantee rather than the
    // disabled button below — a control can be stale, a handler cannot.
    //
    // Organizing around an unsettled picture breaks provenance in one direction
    // or the other. A READING one has not put its text in the box yet, and
    // `source` was snapshotted on the line above, so the run would be created
    // from text missing a page while storing the image that page came from. A
    // FAILED one never will, so storing it puts an image in source_image_urls
    // with nothing behind it. 0048 sees neither: it checks that the evidence a
    // run CLAIMS is coherent, not that the claim is complete.
    const blocked = blockingImage(sourceImages);
    if (blocked) { setError(blockingMessage(blocked)); return; }
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
      // SEQUENTIALLY, AND IN ORDER. The array IS the order — 0048's rule ties
      // its first entry to the singular column, and the run is the only record
      // of which page was which. One failure stops everything: a run that
      // cannot carry its full provenance must not exist (0045).
      //
      // ONE REQUEST PER PICTURE, and that is forced rather than chosen. A batch
      // would need one multipart body carrying every image, and the deployed
      // platform refuses a function request body over roughly 4.5MB — measured:
      // 4300 KB reaches the function, 4400 KB does not. Several pictures cannot
      // travel together, so they travel one at a time.
      //
      // KNOWN AND NOT FIXED HERE — a retention window this package does not
      // close and does not pretend to:
      //
      //   * picture 1 and 2 store, picture 3 fails, nothing is created;
      //   * or every picture stores and /api/ingest/organize then fails.
      //
      // In both cases the objects already in packet-photos are left with no run
      // and no pointer, and nothing in this codebase deletes a storage object.
      // The second case shipped long before this change, with one image; this
      // widens it to N. Closing it needs either an atomic storage+organize
      // request or a signed rollback capability — a server-verifiable proof
      // that THIS request created THIS object — because the bucket is shared
      // with recipient-facing photos and an object path proves nothing about
      // who owns it. Both are their own package.
      const sourceImageUrls: string[] = [];
      // ONLY THE TRANSCRIBED ONES, and only the ones still in the list. The
      // guard above already means these are all of them; saying it here as well
      // is deliberate, because this loop is what actually writes provenance and
      // it should not depend on a check twenty lines away to be correct. A
      // picture removed earlier is not in `sourceImages` at all — removeImage
      // takes it out with its contributed text, together or not at all.
      for (const img of sourceImages.filter((x) => x.status === "done")) {
        const body = new FormData();
        body.append("file", img.file);
        const up = await fetch("/api/ingest/source-image", { method: "POST", body });
        const stored = await up.json().catch(() => ({}));
        if (!up.ok || !stored?.url) {
          setError(stored?.message
            || `Could not save ${img.label.toLowerCase()}, so nothing was organized. Please try again.`);
          setProcessing(false);
          return;
        }
        sourceImageUrls.push(stored.url as string);
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
          // BOTH SHAPES, one deploy apart: the singular column is what already-
          // deployed code and 0045's CHECK read, the array is the ordered truth
          // 0048 added. A single picture is simply a one-element array.
          ...(sourceImageUrls.length
            ? { sourceImageUrl: sourceImageUrls[0], sourceImageUrls }
            : {}),
          // Present only when the creator asked for it, so every other path
          // stays on automatic detection.
          ...(keepTogether
            ? { groupingIntent: "keep_together", groupingTitle: groupingTitle.trim() }
            : {}),
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

  // The SAME predicate the handler enforces, so a disabled button and a refused
  // action can never disagree about why.
  const blockingNow = blockingImage(sourceImages);
  const ready = Boolean(rawText.trim()) && !processing && !blockingNow;

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
      {/* THE DROP SURFACE IS THE WHOLE CARD, and it is deliberately not
          image-specific: a professional dragging a spreadsheet at the paste box
          means the same thing as one dragging a photograph, and the next file
          type we learn to read should need no new target. It carries no logic
          of its own — it normalises a DataTransfer into File[] and hands it to
          the same function the pickers call. */}
      <div
        onDragOver={(e) => { e.preventDefault(); if (!processing && !readingImage) setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (processing || readingImage) return;
          const dropped = Array.from(e.dataTransfer?.files ?? []);
          if (dropped.length) ingestFiles(dropped);
        }}
        className={`mt-7 overflow-hidden rounded-xl border bg-card transition-shadow duration-200 focus-within:border-accent/40 focus-within:shadow-[0_0_0_3px_rgb(37_99_235_/_0.08)] ${
          dragging ? "border-accent shadow-[0_0_0_3px_rgb(37_99_235_/_0.16)]" : "border-border"}`}>
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
        {sourceImages.length > 0 && (
          <div className="border-b border-border bg-card/60 px-4 py-3">
            <p className="text-sm font-medium text-foreground">
              {sourceImages.length === 1 ? "Read from your picture" : `Read from your ${sourceImages.length} pictures`}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Check the text against each picture and fix anything it misread — especially
              prices, phone numbers and licence or registration numbers.{" "}
              <span className="font-medium text-foreground">Tap a picture to see it full size.</span>{" "}
              What you organize is the text below, not the pictures.
            </p>

            {/* EVERY PAGE, IN ORDER, AND EACH ONE OPENABLE.
                The tiny print that started this — a licence number at six point
                on the third page of a brochure — is unreadable at any thumbnail
                size, so the thumbnail's job is only to be a target. */}
            <ul className="mt-2.5 flex flex-wrap gap-2">
              {sourceImages.map((img) => (
                <li key={img.id} className="relative">
                  <button
                    type="button"
                    onClick={() => setInspecting(img)}
                    aria-label={`${img.label} — open full size`}
                    className="block overflow-hidden rounded-lg border border-border bg-white transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent/50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.preview} alt={img.label}
                         className="h-24 w-24 object-contain sm:h-28 sm:w-28" />
                    <span className="block border-t border-border px-1.5 py-1 text-left text-[11px] text-muted">
                      {img.status === "reading" ? "Reading…"
                        : img.status === "failed" ? "Couldn’t read" : img.label}
                    </span>
                  </button>
                  {img.status === "failed" && (
                    <button
                      type="button"
                      onClick={() => retryImage(img.id)}
                      disabled={processing || readingImage}
                      className="mt-1 block w-full rounded-md border border-border py-0.5 text-[11px] font-medium text-accent hover:text-accent-hover disabled:opacity-60"
                    >
                      Try again
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    disabled={processing || readingImage}
                    aria-label={`Remove ${img.label}`}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-xs leading-none text-muted shadow-sm hover:text-foreground disabled:opacity-60"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>

            {/* TWO PATHS, TWO DIFFERENT ANSWERS. A .csv is read on the device
                and never leaves it; nothing can read a picture locally, so
                these were sent to be transcribed. Saying so is cheap, and a
                professional photographing a client document is entitled to
                know which of the two just happened. */}
            <p className="mt-2 text-xs text-muted/80">
              Sent to our AI provider for transcription using zero-data-retention
              routing, one picture at a time. If you continue, Sendset keeps the
              source pictures with the ingestion evidence for the normal retention
              period. A .csv, .txt or .md file is read on your device instead.
            </p>
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
            Drag files or pictures here, or click to choose. It doesn&rsquo;t need to be tidy —
            spreadsheet rows, names, prices, links and contacts all work.
          </p>
          {/* A PICTURE IS SOURCE MATERIAL, not content. It is read into the box
              below, where it can be corrected, and only the corrected text is
              ever structured. The picture itself never reaches a client. */}
          <label className={`ml-auto shrink-0 cursor-pointer text-xs font-medium text-accent hover:text-accent-hover ${
            processing || readingImage ? "pointer-events-none opacity-60" : ""}`}>
            {readingImage ? "Reading your pictures…" : "or use pictures"}
            <input
              type="file"
              accept={PHOTO_ACCEPT_ATTR}
              multiple
              className="hidden"
              disabled={processing || readingImage}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                // Cleared so choosing the same file twice still fires.
                e.target.value = "";
                if (picked.length) ingestFiles(picked);
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
                const picked = Array.from(e.target.files ?? []);
                // Cleared so choosing the same file twice still fires.
                e.target.value = "";
                if (picked.length) ingestFiles(picked);
              }}
            />
          </label>
        </div>
      </div>

      {/* THE INSPECTOR. The whole point of this package: a licence number at six
          point on a photographed page is unreadable at 112px, and the review
          step asks the professional to CORRECT the transcription — a correction
          you cannot check against the original is a guess.

          FULL VIEWPORT, natural size, and scrollable in both directions, so the
          browser's own pinch and scroll do the zooming. A bespoke zoom control
          would be a worse version of what every device already has. */}
      {inspecting && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${inspecting.label}, full size`}
          onClick={() => setInspecting(null)}
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
        >
          <div className="flex flex-none items-center justify-between gap-3 px-4 py-3 text-white">
            <span className="text-sm font-medium">{inspecting.label}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setInspecting(null); }}
              className="rounded-md border border-white/30 px-2.5 py-1 text-xs font-medium hover:bg-white/10"
            >
              Close
            </button>
          </div>
          {/* overflow-auto, and the image at its NATURAL size rather than
              contained: a page scaled to fit the viewport is a bigger thumbnail,
              not an inspectable document. */}
          <div className="min-h-0 flex-1 overflow-auto p-3" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={inspecting.preview} alt={`${inspecting.label}, full size`}
                 className="mx-auto block max-w-none" />
          </div>
          <p className="flex-none px-4 py-2 text-center text-xs text-white/70">
            Pinch or scroll to zoom. Tap anywhere outside to close.
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* THE OVERRIDE, AND IT IS AN OVERRIDE. Off by default and never in the
          way: the ordinary path is still paste-and-organize with nobody asked
          anything. It sits at the organize layer rather than beside the picture
          control because a pasted rate sheet and a photographed one have the
          same problem — and a CSV of one venue's rooms does too. */}
      <div className="mt-5 rounded-lg border border-border bg-card/60 p-3">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={keepTogether}
            disabled={processing || readingImage}
            onChange={(e) => {
              setKeepTogether(e.target.checked);
              if (!e.target.checked) setGroupingTitle("");
            }}
            className="mt-0.5 flex-none"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              Keep this together as one item
            </span>
            <span className="block text-xs text-muted">
              Everything in this source will be organized under one item, with the
              rest kept as its details. Leave this off and Sendset works out the
              structure itself.
            </span>
          </span>
        </label>
        {keepTogether && (
          <div className="mt-3 pl-7">
            <label htmlFor="grouping-title" className="block text-xs font-medium text-foreground">
              Name this item
            </label>
            <input
              id="grouping-title"
              type="text"
              value={groupingTitle}
              onChange={(e) => setGroupingTitle(e.target.value)}
              placeholder="e.g. Spring Lake Village"
              disabled={processing || readingImage}
              className="mt-1 w-full max-w-sm rounded-lg border border-border bg-white px-3 py-2 text-sm
                         text-foreground outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-muted/80">
              Your words, not the model&rsquo;s — this is what your client will see.
            </p>
          </div>
        )}
      </div>

      {/* A DISABLED PRIMARY BUTTON WITH NO REASON READS AS BROKEN. The blocking
          picture is named here, with the way out, rather than leaving the
          professional to discover it by pressing something inert. */}
      {blockingNow && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {blockingMessage(blockingNow)}
        </p>
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
