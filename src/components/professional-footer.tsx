import { ProfessionalContact } from "@/lib/types";

export function ProfessionalFooter({
  professional,
}: {
  professional: ProfessionalContact;
}) {
  return (
    <footer className="mx-5 mb-8 mt-4 rounded-xl bg-surface border border-border p-5">
      <p className="text-xs font-medium uppercase tracking-widest text-muted mb-2">
        Your Advisor
      </p>
      <p className="text-base font-semibold text-foreground">
        {professional.name}
      </p>
      {professional.businessName && (
        <p className="text-sm text-muted mt-0.5">
          {professional.businessName}
        </p>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        {professional.phone && (
          <a
            href={`tel:${professional.phone}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover px-4 py-2 rounded-lg transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
              />
            </svg>
            Call {professional.name.split(" ")[0]}
          </a>
        )}
        {professional.phone && (
          <a
            href={`sms:${professional.phone}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent bg-blue-50 hover:bg-blue-100 border border-blue-100 px-4 py-2 rounded-lg transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            Text
          </a>
        )}
        {professional.email && (
          <a
            href={`mailto:${professional.email}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent bg-blue-50 hover:bg-blue-100 border border-blue-100 px-4 py-2 rounded-lg transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            Email
          </a>
        )}
        {professional.websiteUrl && (
          <a
            href={professional.websiteUrl.startsWith("http") ? professional.websiteUrl : `https://${professional.websiteUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent bg-blue-50 hover:bg-blue-100 border border-blue-100 px-4 py-2 rounded-lg transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
              />
            </svg>
            Website
          </a>
        )}
        {professional.links
          ?.filter((link) => link.url && link.url.trim())
          .map((link, index) => (
            <a
              key={index}
              href={link.url.startsWith("http") ? link.url : `https://${link.url}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent bg-blue-50 hover:bg-blue-100 border border-blue-100 px-4 py-2 rounded-lg transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              {link.label.trim() || link.url}
            </a>
          ))}
      </div>
    </footer>
  );
}
