import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";
import type { Packet } from "./types.ts";

const LIVE = "https://flowguide.example.com/p/abc123";
const PACKET = {
  slug: "abc123",
  title: "Senior Living Options",
  clientName: "the Alvarez family",
  personalNote: "Here are the three I'd start with.",
  compositionMode: "legacy",
  professional: { name: "Dana Whitfield", email: "dana@example.com", phone: "(206) 555-0100",
    businessName: "Whitfield Senior Advisors", footerLabel: "Your Advisor" },
  sections: [{
    id: "s1", title: "Recommended Communities", description: "In order of fit.",
    items: [
      { id: "i1", title: "Vine Ridge Senior Living", address: "1247 Sonoma Ave, Santa Rosa, CA",
        description: "A warm boutique community.",
        notes: "SECRET-PRIVATE-NOTE-must-never-appear",
        photos: ["https://cdn.example.com/vine.jpg"],
        details: [{ label: "Monthly cost", value: "$4,800 - $6,200" }, { label: "Care level", value: "Assisted Living" }],
        links: [{ url: "https://vineridge.example.com", label: "Website" }],
        contacts: [{ name: "Maria Santos", role: "Director", phone: "(707) 555-1041", email: "m@example.com" }] },
      { id: "i2", title: "Cedar Ridge Commons", description: "Larger community." },
    ],
  }],
} as unknown as Packet;

const html = renderPacketEmail(PACKET, { liveUrl: LIVE });

test("PRIVATE NOTES NEVER APPEAR, and the field is never even read", () => {
  // notes is professional-only on the web card; this is a recipient surface.
  assert.doesNotMatch(html, /SECRET-PRIVATE-NOTE/);
  assert.doesNotMatch(renderPacketEmailText(PACKET, { liveUrl: LIVE }), /SECRET-PRIVATE-NOTE/);
  const src = readFileSync("src/lib/email-render.ts", "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(src, /\.notes/, "the email renderer reads item.notes");
});

test("every packet field the brief names survives, in packet order", () => {
  // The business name and footer label are UPPERCASED, matching the live
  // header. Done by transforming the string rather than with text-transform,
  // which several email clients ignore.
  for (const needed of ["WHITFIELD SENIOR ADVISORS", "Senior Living Options", "the Alvarez family",
    "Here are the three I&#39;d start with.", "Recommended Communities", "In order of fit.",
    "Vine Ridge Senior Living", "1247 Sonoma Ave", "A warm boutique community.",
    "Monthly cost", "$4,800 - $6,200", "Website", "Maria Santos", "(707) 555-1041",
    "Dana Whitfield", "YOUR ADVISOR", "Cedar Ridge Commons"]) {
    assert.ok(html.includes(needed), `missing from the email: ${needed}`);
  }
  assert.ok(html.indexOf("Vine Ridge") < html.indexOf("Cedar Ridge"), "item order not preserved");
});

test("the live FlowGuide link appears, at the top and the bottom", () => {
  assert.equal(html.split(LIVE).length - 1, 2);
});

test("email-safe: tables and inline styles, no <style>, no classes, no modern CSS", () => {
  assert.match(html, /<table/);
  assert.doesNotMatch(html, /<style/i, "Gmail strips <style> blocks");
  assert.doesNotMatch(html, /class=/, "Gmail drops classes");
  assert.doesNotMatch(html, /<script/i);
  for (const modern of [/display:\s*flex/, /display:\s*grid/, /@media/, /position:\s*(absolute|fixed)/]) {
    assert.doesNotMatch(html, modern, `Outlook cannot render ${modern}`);
  }
});

test("single column at 600px — no layout that must collapse", () => {
  assert.match(html, /max-width:600px/);
  assert.match(html, /width="600"/);
});

test("a blocked image loses nothing: alt text, explicit width, and facts in text", () => {
  assert.match(html, /<img[^>]+alt="Vine Ridge Senior Living"/);
  assert.match(html, /<img[^>]+width="552"/);
  // The facts are text, not baked into the picture.
  const withoutImg = html.replace(/<img[^>]*>/g, "");
  assert.ok(withoutImg.includes("Monthly cost") && withoutImg.includes("$4,800 - $6,200"));
});

test("contacts become tel: and mailto: links", () => {
  assert.match(html, /href="tel:7075551041"/);
  assert.match(html, /href="mailto:m@example.com"/);
});

test("an address becomes a maps link", () => {
  assert.match(html, /google\.com\/maps\/search/);
});

test("content is escaped, and only http(s) may become a link", () => {
  const nasty = { ...PACKET, title: '<script>alert(1)</script>',
    sections: [{ id: "s", title: "T", items: [{ id: "x", title: "X",
      links: [{ url: "javascript:alert(1)", label: "Bad" }] }] }] } as unknown as Packet;
  const out = renderPacketEmail(nasty, { liveUrl: LIVE });
  assert.doesNotMatch(out, /<script>alert/);
  assert.match(out, /&lt;script&gt;/);
  assert.doesNotMatch(out, /href="javascript:/);
});

test("an empty-ish packet still renders without holes", () => {
  const bare = { slug: "s", title: "Options", professional: { name: "" },
    sections: [{ id: "s1", title: "", items: [{ id: "i", title: "Only item" }] }] } as unknown as Packet;
  const out = renderPacketEmail(bare, { liveUrl: LIVE });
  assert.ok(out.includes("Only item"));
  assert.doesNotMatch(out, /undefined|null|\[object/);
});

test("the plain-text flavour carries the same facts", () => {
  const text = renderPacketEmailText(PACKET, { liveUrl: LIVE });
  for (const needed of ["Senior Living Options", "Vine Ridge Senior Living", "Monthly cost: $4,800 - $6,200",
    "Maria Santos", LIVE]) {
    assert.ok(text.includes(needed), `missing from plain text: ${needed}`);
  }
});
