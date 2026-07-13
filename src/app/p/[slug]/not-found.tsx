// Rendered (with a real HTTP 404) whenever a packet page calls notFound() —
// i.e. the slug matches no packet, or the packet is not published. The copy is
// deliberately generic: it reveals nothing about whether a packet ever existed.
export default function PacketNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-5 text-center">
      <div className="text-5xl mb-4">📄</div>
      <h1 className="text-xl font-bold text-foreground mb-2">Packet not found</h1>
      <p className="text-sm text-muted max-w-xs">
        This link doesn&apos;t match any packet. Check the URL and try again.
      </p>
      <p className="mt-8 text-xs text-muted/60">FlowGuide</p>
    </div>
  );
}
