"use client";

import { INPUT_SHELL } from "@/components/ui/field";

// The search box, above the list rather than inside it.
//
// It has to survive the switch between the structured Library and the flat
// result list — typing is precisely what causes that switch, and a box that
// vanished at the first keystroke would be unusable. So the surfaces that can
// show both own the input and hand the term down.
export function LibrarySearch({
  value, onChange, className = "",
}: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search your Library…"
      aria-label="Search your Library"
      className={`${INPUT_SHELL} ${className}`}
    />
  );
}
