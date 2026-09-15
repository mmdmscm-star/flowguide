// Rendered (with a real HTTP 404) whenever a Sendset page calls notFound() —
// the slug matches no Sendset, or the Sendset is not published. The copy is
// deliberately neutral: it reveals nothing about whether a Sendset ever existed,
// and it speaks the public word for the object ("a Sendset"), never "packet".
export default function PacketNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-5 text-center">
      <div className="text-5xl mb-4">📄</div>
      <h1 className="text-xl font-bold text-foreground mb-2">This Sendset is no longer available.</h1>
      <p className="text-sm text-muted max-w-xs">
        If you were expecting to see it, ask the person who shared the link.
      </p>
      <p className="mt-8 text-xs text-muted/60">Sendset</p>
    </div>
  );
}
