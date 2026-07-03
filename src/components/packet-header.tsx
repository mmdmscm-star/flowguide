import { ProfessionalContact } from "@/lib/types";

export function PacketHeader({
  title,
  clientName,
  professional,
}: {
  title: string;
  clientName?: string;
  professional: ProfessionalContact;
}) {
  return (
    <header className="px-5 pt-8 pb-6">
      {professional.logoUrl && (
        <img
          src={professional.logoUrl}
          alt={professional.businessName || "Logo"}
          className="h-12 w-auto max-w-[180px] object-contain mb-4"
        />
      )}
      {professional.businessName && (
        <p className="text-xs font-medium uppercase tracking-widest text-muted mb-1">
          {professional.businessName}
        </p>
      )}
      <h1 className="text-2xl font-bold leading-tight text-foreground whitespace-pre-line">
        {title}
      </h1>
      {clientName && (
        <p className="mt-2 text-sm text-muted">
          Prepared for {clientName}
        </p>
      )}
    </header>
  );
}
