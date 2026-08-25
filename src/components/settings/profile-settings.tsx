"use client";

import { useRef, useState } from "react";
import ProfessionalProfileFields, { type ProfileFields } from "../editor/professional-profile-fields";
import { identityGap, IDENTITY_GAP_PROMPT } from "@/lib/professional-identity";

// The account's professional identity, on its own page.
//
// Same nine fields as the editor, same PATCH endpoint, same debounced
// auto-save — the editor's own pattern rather than a new one, so a
// professional who has used one surface already knows this one.
//
// The readiness line uses the PUBLISH RULE, not a local guess. If it says the
// profile is ready, publish will accept it; if it names something missing, that
// is the thing publish would refuse on. Onboarding and publishing cannot
// disagree because they are asking the same function.
export default function ProfileSettings({ initial }: { initial: ProfileFields }) {
  const [profile, setProfile] = useState<ProfileFields>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "Nothing happened" is usually missing feedback rather than broken logic, so
  // every edit says which of the four states it is in.
  function save(patch: Record<string, unknown>) {
    if (timer.current) clearTimeout(timer.current);
    setStatus("saving");
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error();
        setStatus("saved");
      } catch {
        setStatus("error");
      }
    }, 1000);
  }

  function onField(field: string, value: string) {
    setProfile((prev) => ({ ...prev, [field]: value }));
    save({ [field]: value });
  }

  function onLinks(links: { label: string; url: string }[]) {
    setProfile((prev) => ({ ...prev, links }));
    save({ links });
  }

  const gap = identityGap(profile);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-lg font-semibold text-foreground">Your details</h2>
        <span className="text-sm text-muted" aria-live="polite">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && <span className="text-red-600">Could not save — check your connection</span>}
        </span>
      </div>

      <p className="text-sm text-muted mb-4">
        This is how you appear to clients — at the top of every FlowGuide, and in
        the contact card at the bottom. It is used by the web, email and printed
        versions alike. Changes apply to FlowGuides you publish from now on;
        already-published FlowGuides keep the details they were published with.
      </p>

      {/* The gap, when there is one — said once, here, where it can be fixed. */}
      {gap && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {IDENTITY_GAP_PROMPT[gap]} Until then, publishing will ask you to
          confirm before sending a FlowGuide with no contact details.
        </p>
      )}

      <ProfessionalProfileFields value={profile} onField={onField} onLinks={onLinks} />
    </div>
  );
}
