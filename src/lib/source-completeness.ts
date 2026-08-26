// LABELLED SOURCE FACTS MUST NOT VANISH WITHOUT SAYING SO.
//
// The price gate answers "is this value real?". This answers the opposite
// question — "did a fact the source states survive at all?" — for the three
// kinds a directory-style source labels explicitly: phones, websites, emails.
//
// Measured on the real 65-community import: 43 communities silently lost a
// labelled phone, always one of the two the source gives (a community's main
// line and a named person's cell). No schema forced it; the extraction simply
// emitted one contact. A loss nobody is told about is the failure mode this
// project keeps returning to, so it is reported rather than tolerated.
//
// SURFACED, NOT BLOCKING. Unlike an unsupported price — which is a false
// statement to a client — a missing phone is an omission. It is shown for a
// decision, and never silently dropped.

/** Only phones the source LABELS as such. A bare ten-digit run is as likely to
 *  be an image version string as a number — that false positive is why this is
 *  label-anchored rather than a digit scan. */
const LABELLED_PHONE = /(?:community\s+phone|cell\s+phone|phone|tel|telephone)\s*[:\-]\s*(\+?1?[-.\s(]*\d{3}[-.\s)]*\d{3}[-.\s]*\d{4})/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;
const WEB = /https?:\/\/[^\s"'<>)\]]+/gi;

const digits = (s: string) => s.replace(/\D/g, "");

/** A website reduced to what two spellings of it agree on. `http://x.com` and
 *  `https://www.x.com/` are one site; comparing them literally reports a loss
 *  that did not happen — which it did, twice, before this existed. */
export function siteKey(url: string): string {
  let u = String(url).trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return u;
}

export interface Completeness {
  phones: string[];
  emails: string[];
  websites: string[];
  ok: boolean;
}

/** Labelled facts present in the source and absent from the record. */
export function missingFrom(record: unknown, source: string): Completeness {
  const rec = JSON.stringify(record ?? {});
  const recDigits = digits(rec);
  const recLower = rec.toLowerCase();
  const recSites = new Set((rec.match(WEB) ?? []).map(siteKey));

  const phones: string[] = [];
  for (const m of String(source).matchAll(LABELLED_PHONE)) {
    const d = digits(m[1]);
    if (d.length >= 10 && !recDigits.includes(d) && !phones.includes(m[1].trim())) phones.push(m[1].trim());
  }
  const emails: string[] = [];
  for (const e of String(source).match(EMAIL) ?? []) {
    if (!recLower.includes(e.toLowerCase()) && !emails.includes(e)) emails.push(e);
  }
  const websites: string[] = [];
  for (const w of String(source).match(WEB) ?? []) {
    // Image hosts are media, accounted for elsewhere; a photo URL is not a
    // community's website and reporting it here would bury the real ones.
    if (/res\.cloudinary\.com|\.(jpe?g|png|gif|webp|heic)(\?|$)/i.test(w)) continue;
    if (!recSites.has(siteKey(w)) && !websites.includes(w)) websites.push(w);
  }
  return { phones, emails, websites, ok: !phones.length && !emails.length && !websites.length };
}

/**
 * Facts a chunk's source states that NONE of the records it produced carry.
 *
 * THE UNIT OF AUDIT IS THE CHUNK, not the record — and getting that wrong is
 * how this check first reported nonsense. A chunk routinely holds several
 * communities (15 of 49 did on the real source), so comparing ONE record
 * against the WHOLE chunk reports its NEIGHBOURS' phones and emails as missing:
 * Aegis Living Corte Madera was warned about Solano Life House's email. A fact
 * is only lost when no record from that chunk carries it.
 */
export function missingFromChunk(records: unknown[], chunkText: string): Completeness {
  return missingFrom(records, chunkText);
}

/** What the professional reads when something did not survive. */
export function completenessWarnings(record: unknown, source: string): string[] {
  const m = missingFrom(record, source);
  return [
    ...m.phones.map((p) => `phone not carried over: ${p}`),
    ...m.emails.map((e) => `email not carried over: ${e}`),
    ...m.websites.map((w) => `website not carried over: ${w}`),
  ];
}
