// A PANEL, not an item. It takes the treatment's panel shape — the same
// resolved values the details table uses — so a treatment that rules its
// panels instead of boxing them rules this one too.
export function PersonalNote({ note }: { note: string }) {
  return (
    <div
      className="mx-[var(--sg-page-gutter)] mb-8 p-5"
      style={{
        background: "var(--sg-surface)",
        borderStyle: "solid",
        borderWidth: "var(--sg-details-border-width)",
        borderColor: "var(--sg-line)",
        borderRadius: "var(--sg-card-radius)",
      }}
    >
      <p
        className="leading-relaxed whitespace-pre-line"
        style={{ fontSize: "var(--sg-body)", color: "var(--sg-ink)" }}
      >
        {note}
      </p>
    </div>
  );
}
