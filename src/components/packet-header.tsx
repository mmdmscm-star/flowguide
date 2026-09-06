import { ProfessionalContact } from "@/lib/types";

// THE HEADING A CLIENT READS, WHEN THERE IS ONE.
//
// `title` here is the packet's CLIENT title, not the professional's internal
// name for the FlowGuide. The two used to be one field, so "Options for Bonnie
// Smith" — a useful thing to file a FlowGuide under — was also the first thing
// Bonnie Smith read.
//
// Blank is a legitimate choice, not a missing value: plenty of FlowGuides read
// better with the professional's own branding above the content and no heading
// between them. So the <h1> is omitted rather than rendered empty, and the
// header's spacing closes up instead of leaving a gap where something failed.
export function PacketHeader({
  title,
  clientName,
  professional,
}: {
  /** The recipient-facing title. Blank or absent omits the heading entirely. */
  title?: string;
  clientName?: string;
  professional: ProfessionalContact;
}) {
  const heading = String(title ?? "").trim();
  return (
    <header className="px-[var(--sg-page-gutter)] pt-8 pb-6">
      {professional.logoUrl && (
        <img
          src={professional.logoUrl}
          alt={professional.businessName || "Logo"}
          className="h-12 w-auto max-w-[180px] object-contain mb-4"
        />
      )}
      {professional.businessName && (
        <p className={`text-xs font-medium uppercase tracking-widest text-[color:var(--sg-muted)] ${heading ? "mb-1" : ""}`}>
          {professional.businessName}
        </p>
      )}
      {heading && (
        <h1 className="text-[length:var(--sg-page-title)] font-bold leading-tight text-[color:var(--sg-ink)] whitespace-pre-line">
          {heading}
        </h1>
      )}
      {clientName && (
        <p className={`${heading ? "mt-2" : "mt-1"} text-[length:var(--sg-small)] text-[color:var(--sg-muted)]`}>
          Prepared for {clientName}
        </p>
      )}
    </header>
  );
}
