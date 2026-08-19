/**
 * Start a new FlowGuide from saved Library material.
 *
 * One client-side call shared by both entry points — the New FlowGuide menu and
 * the Library itself — so the two cannot drift on what they send or on how they
 * report a failure.
 */
export async function createFromLibrary(
  libraryItemIds: string[],
): Promise<{ packetId?: string; count?: number; message?: string }> {
  try {
    const res = await fetch("/api/packets/from-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryItemIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { message: data.message || data.error || "Could not create it." };
    return { packetId: data.packetId as string, count: data.count as number };
  } catch {
    return { message: "Could not create it. Check your connection." };
  }
}
