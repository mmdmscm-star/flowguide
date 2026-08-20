import { test } from "node:test";
import assert from "node:assert/strict";
import { locate, intendedField, judge, isRecipientVisible } from "./placement.ts";

const item = (o: Record<string, unknown>) => o;

test("locate finds a value wherever it landed, across every field shape", () => {
  const it = item({
    title: "Fairview Gardens", address: "1200 Example Rd",
    notes: "Community fee is $3,500 one time",
    details: [{ label: "Capacity", value: "84 residents" }],
    contacts: [{ name: "Pat", phone: "707-555-0101", email: "pat@f.example.com" }],
    links: [{ url: "https://f.example.com", label: "Website" }],
    photos: ["https://img.example.com/a.jpg"],
  });
  assert.deepEqual(locate(it, "$3,500"), ["notes"]);
  assert.deepEqual(locate(it, "84 residents"), ["details"]);
  assert.deepEqual(locate(it, "(707) 555 0101"), ["contacts"]);   // format-insensitive
  assert.deepEqual(locate(it, "https://img.example.com/a.jpg"), ["photos"]);
  assert.deepEqual(locate(it, "nothing like this"), []);
});

test("a value in two fields is duplicated", () => {
  const it = item({ notes: "Call 707-555-0101", contacts: [{ phone: "707-555-0101" }] });
  const p = judge(it, { value: "707-555-0101" });
  assert.deepEqual(p.found, ["notes", "contacts"]);
  assert.equal(p.duplicated, true);
});

test("the contract only states what the prompts state", () => {
  assert.equal(intendedField({ value: "https://x.example.com/a.jpg" })?.expect, "photos");
  assert.equal(intendedField({ value: "https://x.example.com" })?.expect, "links");
  assert.equal(intendedField({ value: "pat@x.example.com" })?.expect, "contacts");
  assert.equal(intendedField({ label: "Community Fee", value: "$3,500" })?.expect, "details");
  assert.equal(intendedField({ label: "Level of Care", value: "$450" })?.expect, "details");
  // Nothing in any prompt says where "Capacity" or "Type" belongs.
  assert.equal(intendedField({ label: "Capacity", value: "84 residents" }), null);
  assert.equal(intendedField({ label: "Type", value: "Assisted Living" }), null);
});

test("cost guidance is marked packet-only — the Library prompt does not carry it", () => {
  assert.equal(intendedField({ label: "Community Fee", value: "$3,500" })?.statedIn, "packet-only");
  assert.equal(intendedField({ value: "pat@x.example.com" })?.statedIn, "both");
});

test("a fee in notes is MISPLACED; an unruled label in notes is NEEDS_JUDGEMENT", () => {
  const inNotes = item({ notes: "Community fee is $3,500 one time" });
  assert.equal(judge(inNotes, { value: "$3,500", label: "Community Fee" }).verdict, "MISPLACED");
  // No prompt states where Capacity goes, so this is a question, not a defect.
  const cap = item({ notes: "Capacity is 84 residents" });
  assert.equal(judge(cap, { value: "84 residents", label: "Capacity" }).verdict, "NEEDS_JUDGEMENT");
});

test("prose that genuinely belongs in notes is never called wrong", () => {
  // The instruction is explicit that notes is a real destination. A subjective
  // observation carrying a number must not be scored as a misplaced price.
  const it = item({ notes: "The director was candid about the $3,500 fee and the waitlist." });
  assert.equal(judge(it, { value: "The director was candid" }).verdict, "NEEDS_JUDGEMENT");
});

test("a fact in the right field is CORRECT, and absence is ABSENT not misplaced", () => {
  const good = item({ details: [{ label: "Community Fee", value: "$3,500" }] });
  assert.equal(judge(good, { value: "$3,500", label: "Community Fee" }).verdict, "CORRECT");
  assert.equal(judge(item({}), { value: "$3,500", label: "Community Fee" }).verdict, "ABSENT");
});

test("notes is not a recipient-visible field", () => {
  // Since the 2026-08-20 privacy fix. If this ever flips back, the whole
  // severity model below flips with it — re-derive it, do not patch the test.
  assert.equal(isRecipientVisible("notes"), false);
  for (const f of ["title", "address", "description", "details", "links", "photos", "contacts"] as const)
    assert.equal(isRecipientVisible(f), true, `${f} should reach the recipient`);
});

test("a fact that landed ONLY in notes is hidden from the recipient", () => {
  const p = judge({ notes: "Community fee is $3,500 one time" }, { value: "$3,500", label: "Community Fee" });
  assert.equal(p.hiddenFromRecipient, true);
  assert.equal(p.verdict, "MISPLACED");   // and the prompts do state where it belongs
});

test("hiddenFromRecipient is independent of the verdict", () => {
  // The severity that matters is not "is this defensible" but "does the client
  // ever see it". A note the prompts do not rule on is still an omission.
  const p = judge({ notes: "Capacity is 84 residents" }, { value: "84 residents", label: "Capacity" });
  assert.equal(p.verdict, "NEEDS_JUDGEMENT");
  assert.equal(p.hiddenFromRecipient, true);
});

test("a fact present in a visible field is not hidden, even if also in notes", () => {
  const p = judge({ notes: "fee $3,500", details: [{ label: "Community Fee", value: "$3,500" }] },
                  { value: "$3,500", label: "Community Fee" });
  assert.equal(p.duplicated, true);
  assert.equal(p.hiddenFromRecipient, false);
  assert.equal(p.verdict, "CORRECT");
});

test("an absent fact is not reported as hidden", () => {
  // ABSENT and hidden are different failures and must not be conflated: one is
  // a lost fact, the other is a fact the professional can still see and fix.
  assert.equal(judge({}, { value: "$3,500", label: "Community Fee" }).hiddenFromRecipient, false);
});
