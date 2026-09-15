"use client";

// THE SENDSET'S QR CODE, AS ONE MORE WAY TO SEND IT.
//
// Shown on the share step beside the email version and the printed copy. It is
// the same link as a scannable image — for a flyer, a sign, a slide or a
// printed page — not a new workflow: view it, save it, done.
//
// The image is an <img>, not an inline drawing, so it can also be saved the way
// any image is (long-press on a phone, right-click on a computer), which is the
// dependable path where a browser ignores download links.
import { useMemo, useState } from "react";
import { Button } from "./ui/button";
import { drawSendsetQr, sendsetQr, sendsetQrFileName, sendsetQrPngScale, sendsetQrSvg } from "@/lib/sendset-qr";

function save(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export default function QrCodePanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const qr = useMemo(() => sendsetQr(slug), [slug]);
  const svg = useMemo(() => sendsetQrSvg(qr), [qr]);
  const [pngFailed, setPngFailed] = useState(false);

  function downloadPng() {
    setPngFailed(false);
    const scale = sendsetQrPngScale(qr);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = qr.size * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) { setPngFailed(true); return; }
    drawSendsetQr(ctx, qr, scale);
    canvas.toBlob((blob) => {
      if (blob) save(blob, sendsetQrFileName(slug, "png"));
      else setPngFailed(true);
    }, "image/png");
  }

  function downloadSvg() {
    save(new Blob([svg], { type: "image/svg+xml" }), sendsetQrFileName(slug, "svg"));
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      {/* Black on white regardless of the Sendset's treatment: contrast is what scans.
          A plain <img> on purpose: the source is a local data URL, which
          next/image cannot optimise, and a real image is what a phone can save. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
        alt={`QR code that opens ${qr.url}`}
        width={200}
        height={200}
        className="h-[200px] w-[200px] max-w-full shrink-0 rounded-[var(--radius-control)] border border-line bg-white"
      />
      <div className="min-w-0">
        <p className="text-meta text-ink-2">
          Scanning opens <span className="break-all font-medium text-ink">{qr.url}</span> — the same
          link as above. It keeps working when you edit and republish; unpublishing turns it off.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* PNG is the everyday file; SVG is for print shops and signage. */}
          <Button variant="primary" size="md" onClick={downloadPng}>Download PNG</Button>
          <Button variant="secondary" size="md" onClick={downloadSvg}>Download SVG</Button>
          <Button variant="ghost" size="md" onClick={onClose}>Done</Button>
        </div>
        {pngFailed && (
          <p role="alert" className="mt-2 text-meta text-red-700">
            This browser couldn&apos;t create the PNG. Download the SVG, or save the image above.
          </p>
        )}
      </div>
    </div>
  );
}
