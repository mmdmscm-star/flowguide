import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";
import type { Packet } from "./types.ts";

const LIVE = "https://flowguide.example.com/p/abc123";
const PACKET = {
  slug: "abc123",
  // The two are now different things, and the fixture says so: the internal
  // name is what the professional files it under, and it must never reach the
  // email. The client title is the heading a reader actually sees.
  title: "INTERNAL Alvarez options — do not show",
  clientTitle: "Senior Living Options",
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
  assert.ok(!html.includes("INTERNAL Alvarez options"),
    "the professional's internal Sendset name reached the client's email");
  for (const needed of ["WHITFIELD SENIOR ADVISORS", "Senior Living Options", "the Alvarez family",
    "Here are the three I&#39;d start with.", "Recommended Communities", "In order of fit.",
    "Vine Ridge Senior Living", "1247 Sonoma Ave", "A warm boutique community.",
    "Monthly cost", "$4,800 - $6,200", "Website", "Maria Santos", "(707) 555-1041",
    "Dana Whitfield", "YOUR ADVISOR", "Cedar Ridge Commons"]) {
    assert.ok(html.includes(needed), `missing from the email: ${needed}`);
  }
  assert.ok(html.indexOf("Vine Ridge") < html.indexOf("Cedar Ridge"), "item order not preserved");
});

test("the live Sendset appears, at the top and the bottom", () => {
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
  // The payload goes in the field that actually reaches the HTML. It used to be
  // `title`; the heading is now `clientTitle`, and a guard aimed at a field the
  // renderer no longer reads would pass while escaping nothing.
  const nasty = { ...PACKET, clientTitle: '<script>alert(1)</script>',
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
  assert.ok(!text.includes("INTERNAL Alvarez options"),
    "the internal name reached the plain-text email");
  for (const needed of ["Senior Living Options", "Vine Ridge Senior Living", "Monthly cost: $4,800 - $6,200",
    "Maria Santos", LIVE]) {
    assert.ok(text.includes(needed), `missing from plain text: ${needed}`);
  }
});

// ---------------------------------------------------------------------------
// EVERY PHOTO, AND THE WHOLE PROFESSIONAL IDENTITY.
//
// The fixture above has one photo per item and a minimal professional, so it
// passed unchanged both before and after this behaviour existed. A test that
// cannot fail cannot protect anything, hence a second fixture that actually
// exercises a gallery and a full identity.
// ---------------------------------------------------------------------------

const CLD = "https://res.cloudinary.com/demo/image/upload";
const GALLERY_LIVE = "https://flowguide.example.com/p/xyz";
const GALLERY = {
  slug: "xyz",
  title: "Communities",
  clientName: "Rick",
  personalNote: "Hi Rick,\n\nHave a look.\n\nThank you,\n\nRamona",
  compositionMode: "legacy",
  professional: {
    name: "Ramona Maurer", email: "r@example.com", phone: "(707) 391-0111",
    businessName: "Assisted Living Locators", footerLabel: "Your Advisor",
    logoUrl: "https://brand.example.com/logo.png",
    headshotUrl: "https://people.example.com/ramona.jpg",
    websiteUrl: "santarosa.example.com",
    links: [{ url: "https://reviews.example.com/ramona", label: "Reviews" }],
  },
  sections: [{
    id: "s1", title: "Sonoma", items: [
      { id: "itemA", title: "Cogir of Sonoma",
        photos: [`${CLD}/v1/one.jpg`, `${CLD}/v1/two.jpg`, `${CLD}/v1/three.jpg`,
                 `${CLD}/v1/four.jpg`, `${CLD}/v1/five.jpg`, "https://elsewhere.example.com/six.jpg"] },
      { id: "itemB", title: "Single Photo Place", photos: [`${CLD}/v1/only.jpg`] },
      { id: "itemC", title: "No Photos Place" },
    ],
  }],
} as unknown as Packet;

const g = renderPacketEmail(GALLERY, { liveUrl: GALLERY_LIVE });

test("EVERY recipient-visible photo survives, in packet order", () => {
  for (const name of ["one", "two", "three", "four", "five", "six", "only"]) {
    assert.ok(g.includes(name), `photo dropped from the email: ${name}`);
  }
  // Order, not merely presence.
  const at = (n: string) => g.indexOf(n);
  const seq = ["one", "two", "three", "four", "five", "six"].map(at);
  assert.ok(seq.every((v, i) => v > -1 && (i === 0 || v > seq[i - 1])), "photo order not preserved");
  // 6 + 1 photos, plus the logo and the headshot.
  assert.equal((g.match(/<img /g) ?? []).length, 9);
});

test("the hero is bounded, the rest are squared BY THE SOURCE", () => {
  // object-fit does not exist in Outlook, so a tile squared in CSS arrives
  // stretched. The crop has to be in the URL.
  assert.doesNotMatch(g, /object-fit/, "a CSS-squared tile is a stretched tile in Outlook");
  assert.match(g, /c_limit,w_1104,q_auto,f_auto\/v1\/one\.jpg/, "hero rendition missing");
  for (const n of ["two", "three", "four", "five"]) {
    assert.ok(g.includes(`c_fill,g_auto,ar_1:1,w_264,q_auto,f_auto/v1/${n}.jpg`), `tile not squared: ${n}`);
  }
  // A source with no rendition service still renders — just uncropped.
  assert.ok(g.includes("https://elsewhere.example.com/six.jpg"));
});

test("one stated way into the gallery, not forty-two silent ones", () => {
  const all = g.match(/View all \d+ photos/g) ?? [];
  assert.deepEqual(all, ["View all 6 photos"], "expected exactly one gallery link, naming the true total");
  assert.ok(g.includes(`${GALLERY_LIVE}#item-itemA`), "the gallery link does not reach the item");
  // A single-photo item has nothing to expand, and an item with no photos
  // contributes no gallery at all.
  assert.doesNotMatch(g, /View all 1 photos/);
  assert.ok(g.indexOf("No Photos Place") > -1);
});

test("the professional identity matches the live page, field for field", () => {
  for (const needed of [
    "https://brand.example.com/logo.png",      // header logo
    "ASSISTED LIVING LOCATORS",                // header eyebrow
    "YOUR ADVISOR",                            // footer label
    "ramona.jpg",                              // headshot
    "Ramona Maurer",                           // name
    "Assisted Living Locators",                // business, under the name
    "tel:7073910111", "Call Ramona",
    "mailto:r@example.com", ">Email<",
    "https://santarosa.example.com", ">Website<",   // bare domain, prefixed
    "https://reviews.example.com/ramona", ">Reviews<",
  ]) {
    assert.ok(g.includes(needed), `missing from the professional identity: ${needed}`);
  }
});

test("NO TEXT BUTTON IN EMAIL — a control that does nothing is worse than none", () => {
  // Tested on a real phone in a real mail client: tapping Text did nothing.
  // The live FlowGuide keeps it; this renderer must not offer it.
  assert.ok(!g.includes("sms:"), "the email still renders an sms: link");
  assert.ok(!g.includes(">Text<"), "the email still renders a Text button");
  // The three that DO work must survive — removing Text must not remove a
  // working way to reach the professional.
  for (const kept of ["Call Ramona", ">Email<", ">Website<"]) {
    assert.ok(g.includes(kept), `removing Text also removed ${kept}`);
  }
  // And the order the professional expects: Call · Email · Website.
  assert.ok(g.indexOf("Call Ramona") < g.indexOf(">Email<"), "Call is not first");
  assert.ok(g.indexOf(">Email<") < g.indexOf(">Website<"), "Email does not precede Website");
});

test("removing Text leaves no gap — every button carries its own spacing", () => {
  // Each button IS a <td> with padding:0 8px 8px 0, so the remaining cells sit
  // adjacent with the same rhythm. A gap would mean spacing lived somewhere
  // else and the removal had a visual side effect.
  // Each button is its own nested table, so match the button CELL directly
  // rather than trying to capture the row around them.
  const cells = g.match(/<td style="padding:0 8px 8px 0">/g) ?? [];
  // Call, Email, Website, Reviews — four, not five.
  assert.equal(cells.length, 4, `expected 4 buttons, found ${cells.length}`);
  // And no cell was left empty where Text used to be.
  assert.ok(!/<td style="padding:0 8px 8px 0">\s*<\/td>/.test(g),
    "an empty cell was left where Text used to be");
  // The spacing itself is unchanged: every button still carries the same
  // padding, so the row keeps its rhythm with one fewer cell.
  assert.equal((g.match(/padding:9px 16px/g) ?? []).length, 4, "button padding changed");
});

test("THE LIVE FOOTER STILL OFFERS TEXT — this change is renderer-scoped", () => {
  const live = readFileSync("src/components/professional-footer.tsx", "utf8");
  assert.match(live, /sms:\$\{professional\.phone\}/, "the live page lost its Text action");
});

test("the headshot keeps its own proportions rather than being forced square", () => {
  // Deliberate: the live page crops a circle with object-fit, which Outlook
  // ignores — forcing 56x56 there would squash a 920x560 portrait.
  const img = /<img[^>]+ramona\.jpg[^>]*>/.exec(g)?.[0] ?? "";
  assert.ok(img, "headshot not rendered");
  assert.match(img, /height:56px/);
  assert.match(img, /width:auto/);
  assert.doesNotMatch(img, /width="\d+"/, "a width attribute would distort a non-square headshot");
});

test("the personal note keeps its own sign-off, untouched", () => {
  assert.ok(g.includes("Thank you,"), "the note was rewritten");
  assert.ok(g.includes("Ramona"), "the note's sign-off was removed");
  // And the footer is a labelled card rather than a second signature line.
  assert.ok(g.indexOf("YOUR ADVISOR") > g.indexOf("Thank you,"));
});

test("a hostile professional URL cannot become a live link", () => {
  const hostile = renderPacketEmail({
    ...GALLERY,
    professional: { ...(GALLERY as Packet).professional,
      websiteUrl: "javascript:alert(1)",
      links: [{ url: "data:text/html,<script>", label: "Bad" }] },
  } as unknown as Packet, { liveUrl: GALLERY_LIVE });
  assert.doesNotMatch(hostile, /href="javascript:/i);
  assert.doesNotMatch(hostile, /href="data:/i);
  assert.doesNotMatch(hostile, /https:\/\/javascript:/i, "a bad scheme must be refused, not prefixed");
});
