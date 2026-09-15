// READ-ONLY rollout gate for the reader switch. Writes nothing.
//
//   node --env-file=.env.local --import tsx scripts/publication-backfill/verify-readers.mts
//
// For every published Sendset: does its frozen publication give recipients the
// same output the live rows give them today — as data (by value) and as
// rendered markup (page components, print, email)? And what will its editor say
// (Published / Changes not published)? Run it after the backfill and again
// immediately before deploying the switch. Deploy only on "missing: 0" and
// "differs: 0". Prints ids and verdicts only, never content.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServerClient } from "../../src/lib/supabase.ts";
import { getLiveRowsPublishedPacket, readPublication } from "../../src/lib/queries.ts";
import { canonicalJson } from "../../src/lib/canonical-json.ts";
import { getPublicationState } from "../../src/lib/publication-state.ts";
import { renderPacketEmail, renderPacketEmailText } from "../../src/lib/email-render.ts";
import { publicSendsetUrl } from "../../src/lib/public-url.ts";
import { PrintPacket } from "../../src/components/print/print-packet.tsx";
import { PacketHeader } from "../../src/components/packet-header.tsx";
import { PersonalNote } from "../../src/components/personal-note.tsx";
import { SectionGroup } from "../../src/components/section-group.tsx";
import { PacketBlockBody } from "../../src/components/packet-block-body.tsx";
import { ProfessionalFooter } from "../../src/components/professional-footer.tsx";
import type { Packet } from "../../src/lib/types.ts";

function output(packet: Packet): string {
  const r = (el: React.ReactElement) => renderToStaticMarkup(el);
  const liveUrl = publicSendsetUrl(packet.slug);
  return [
    r(React.createElement(PacketHeader, { title: packet.clientTitle, clientName: packet.clientName, professional: packet.professional })),
    packet.personalNote ? r(React.createElement(PersonalNote, { note: packet.personalNote })) : "",
    packet.compositionMode === "blocks"
      ? r(React.createElement(PacketBlockBody, { blocks: packet.blocks ?? [] }))
      : packet.sections.map((s) => r(React.createElement(SectionGroup, { key: s.id, section: s, showQuickNav: packet.showQuickNav !== false }))).join(""),
    packet.professional.name ? r(React.createElement(ProfessionalFooter, { professional: packet.professional })) : "",
    JSON.stringify([packet.mapUrl, packet.styleTreatment, packet.showQuickNav, packet.compositionMode]),
    r(React.createElement(PrintPacket, { packet, liveUrl } as never)),
    packet.compositionMode === "blocks" ? "" : renderPacketEmail(packet, { liveUrl }) + renderPacketEmailText(packet, { liveUrl }),
  ].join("\n");
}

const db = createServerClient();
const { data: rows, error } = await db.from("packets").select("id, slug, user_id").eq("status", "published").order("id");
if (error) throw new Error(error.message);

const tally = { published: rows!.length, same: 0, differs: 0, missing: 0, state_current: 0, state_changed: 0, state_unavailable: 0 };
for (const p of rows as { id: string; slug: string; user_id: string }[]) {
  const pub = await readPublication(db, p.id);
  let verdict: string;
  if (!pub) { tally.missing++; verdict = "MISSING publication (fallback would render live rows)"; }
  else {
    const live = await getLiveRowsPublishedPacket(p.slug, db);
    const frozen = { ...pub.content, title: "" } as Packet;
    const { title: _t, ...liveRecipient } = live as Packet; void _t;
    const sameData = canonicalJson(JSON.parse(JSON.stringify(liveRecipient))) === canonicalJson(pub.content);
    const sameRender = output(frozen) === output({ ...(live as Packet), title: "" });
    if (sameData && sameRender) { tally.same++; verdict = "same"; }
    else { tally.differs++; verdict = `DIFFERS (data ${sameData ? "same" : "differs"}, render ${sameRender ? "same" : "differs"})`; }
  }
  let state = "unavailable";
  try {
    const s = await getPublicationState(db, p.id, p.user_id);
    state = s && s.published ? s.publication : "unavailable";
  } catch { /* reported as unavailable */ }
  if (state === "current") tally.state_current++; else if (state === "changed") tally.state_changed++; else if (state !== "missing") tally.state_unavailable++;
  console.log(`${p.id.slice(0, 8)} ${verdict}; editor: ${state}`);
}
console.log(JSON.stringify(tally));
process.exit(tally.missing === 0 && tally.differs === 0 ? 0 : 1);
