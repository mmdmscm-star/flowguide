// ONE INPUT TREATMENT, AND A LABEL THAT IS ACTUALLY TIED TO IT.
//
// The old surface had inputs with borders, inputs without, placeholder-as-label
// and label-as-placeholder. An input is a recessed ground with a hairline that
// only asserts itself on focus.
import type { InputHTMLAttributes, ReactNode } from "react";

export const INPUT_SHELL =
  `w-full rounded-[var(--radius-control)] bg-ground border border-line px-3 py-2 text-body
   text-ink placeholder:text-ink-3 transition-colors
   focus:outline-none focus:border-mark focus:ring-2 focus:ring-mark/15`;

export function Field({
  label, hint, error, id, children, className = "",
}: { label: string; hint?: ReactNode; error?: string; id: string;
     children?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-meta font-medium text-ink">{label}</label>
      {children}
      {error
        ? <p className="mt-1 text-meta text-red-700">{error}</p>
        : hint ? <p className="mt-1 text-meta text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${INPUT_SHELL} ${className}`} />;
}
