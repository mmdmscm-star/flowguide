export function PersonalNote({ note }: { note: string }) {
  return (
    <div className="mx-5 mb-8 rounded-xl bg-surface border border-border p-5">
      <p className="text-base leading-relaxed text-foreground whitespace-pre-line">
        {note}
      </p>
    </div>
  );
}
