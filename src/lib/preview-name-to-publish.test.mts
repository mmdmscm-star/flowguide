// NAMING A SENDSET WITHOUT LEAVING THE SHARE STEP.
//
// Publish refused a Sendset with no private name and said so — "Packet needs a
// title" — on a screen with no field to type one into. The way out was: back to
// the editor, name it, back to Preview, press Publish again. Four navigations
// for one word, and the only blocker on the list whose fix is a single field.
//
// The fix is the same shape as the photo-ownership panel beside it: the block
// and the way out are the same screen. What these tests hold is that it stayed
// NARROW — one field, the canonical private name, and then the ordinary publish
// with every other gate intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments stripped: these assertions are about what the code
 *  DOES, and a sentence in a comment must not satisfy one. */
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

const PREVIEW = codeOf("src/components/preview-actions.tsx");
const PUBLISH_ROUTE = codeOf("src/app/api/packets/[id]/publish/route.ts");
const PATCH_ROUTE = codeOf("src/app/api/packets/[id]/route.ts");

/** The save-then-publish handler, by brace matching from its signature. */
function saveHandler(): string {
  const at = PREVIEW.indexOf("async function saveNameAndPublish");
  assert.ok(at >= 0, "the share step no longer offers a way to name a Sendset");
  const open = PREVIEW.indexOf("{", PREVIEW.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < PREVIEW.length; i++) {
    if (PREVIEW[i] === "{") depth++;
    else if (PREVIEW[i] === "}" && --depth === 0) return PREVIEW.slice(open, i + 1);
  }
  throw new Error("unbalanced braces in saveNameAndPublish");
}

// ---------------------------------------------------------------------------
// THE DEAD END IS GONE
// ---------------------------------------------------------------------------

test("a missing name is a CODE the share step can act on, not a sentence to print", () => {
  // Preview can only branch on something stable. The old refusal was a bare
  // string in an `error` field, which is why it could only ever be displayed.
  assert.match(PUBLISH_ROUTE, /error: "name_required"/, "the refusal carries no code");
  assert.equal(PUBLISH_ROUTE.match(/error: "name_required"/g)?.length, 2,
    "the route check and the database refusal must answer alike");
  assert.ok(!/Packet needs a title/.test(PUBLISH_ROUTE),
    "the old dead-end wording survives in the publish route");
  assert.ok(!/Packet needs a title/.test(PREVIEW),
    "the old dead-end wording survives on the share step");
  // And the share step actually branches on it rather than printing it.
  assert.match(PREVIEW, /data\.error === "name_required"/, "Preview does not recognise the refusal");
  assert.match(PREVIEW, /setNeedsName\(true\)/, "recognising it does not open the field");
});

test("the old Packet word is gone from what this flow SAYS", () => {
  // Scoped to the strings a professional reads on these two surfaces. Internal
  // identifiers — packetId, packets, packet_publish_token — are untouched by
  // design and are not what this is about.
  for (const [name, src] of [["preview", PREVIEW], ["publish route", PUBLISH_ROUTE]] as const) {
    for (const m of src.matchAll(/(?:message|error):\s*"([^"]+)"/g)) {
      assert.ok(!/\bpacket\b/i.test(m[1]), `${name} still says "packet" to a professional: ${m[1]}`);
    }
  }
});

// ---------------------------------------------------------------------------
// THE FIX IS NARROW
// ---------------------------------------------------------------------------

test("Save & publish writes the CANONICAL private name, and only that", () => {
  const body = saveHandler();
  // The same PATCH the editor uses — not a new write path with its own rules.
  assert.match(body, /fetch\(`\/api\/packets\/\$\{packetId\}`/, "the name is not saved through the packet route");
  assert.match(body, /method: "PATCH"/);
  assert.match(body, /JSON\.stringify\(\{ title: trimmed \}\)/,
    "the save sends something other than exactly the private name");
  // THE CLIENT-FACING HEADING IS A DIFFERENT FIELD AND IS NOT TOUCHED. This is
  // the failure that would be invisible: a client's page silently gaining a
  // heading the professional wrote for themselves.
  for (const forbidden of ["clientTitle", "client_title", "clientName", "personalNote"]) {
    assert.ok(!body.includes(forbidden), `the naming step also writes ${forbidden}`);
  }
  // The PATCH route keeps them separate at the other end.
  assert.match(PATCH_ROUTE, /title: "title"/);
  assert.match(PATCH_ROUTE, /clientTitle: "client_title"/);
});

test("the name is the professional's own words — nothing is generated", () => {
  const body = saveHandler();
  assert.match(body, /const trimmed = name\.trim\(\)/, "the name is stored untrimmed");
  assert.match(body, /if \(!trimmed[\s\S]{0,40}\) return/, "an empty name is saved and published");
  // The action is inert until there is something to save, so nothing is ever
  // published under a name nobody chose.
  assert.match(PREVIEW, /disabled=\{!name\.trim\(\) \|\| savingName \|\| publishing\}/,
    "Save & publish is pressable with no name");
  for (const guess of ["Untitled", "New Sendset", "Draft", "slug", "clientName ||", "new Date()"]) {
    assert.ok(!saveHandler().includes(guess), `the name is auto-generated from ${guess}`);
  }
});

test("Preview did not become an editor", () => {
  // One field, the one that blocks. Anything else about the Sendset is still
  // only editable where it was.
  const inputs = PREVIEW.match(/<input\b/g) ?? [];
  assert.equal(inputs.length, 1, "the share step grew a second input");
  assert.match(PREVIEW, /id="sendset-name"/, "the one input is not the name field");
  assert.match(PREVIEW, /htmlFor="sendset-name"/, "the field has no label");
  // It appears only when a publish was actually refused for it.
  assert.equal(PREVIEW.match(/setNeedsName\(true\)/g)?.length, 1,
    "the field is opened from more than one place");
  assert.match(PREVIEW, /const \[needsName, setNeedsName\] = useState\(false\)/,
    "the field is mounted speculatively rather than driven by the refusal");
});

// ---------------------------------------------------------------------------
// AND IT BYPASSES NOTHING
// ---------------------------------------------------------------------------

test("saving the name PUBLISHES THROUGH THE NORMAL PATH, gates and all", () => {
  const body = saveHandler();
  // It calls the same function the Publish button calls. It does not post to
  // the publish endpoint itself, and it does not skip the profile check.
  assert.match(body, /await publishPacket\(false\)/,
    "the naming step publishes by some other route, or skips the profile check");
  assert.ok(!/action: "publish"/.test(body),
    "the naming step talks to the publish endpoint directly, around the gates");
  assert.ok(!/skipProfileCheck: true/.test(body));
  // The refusal is cleared only after the save succeeded.
  const ordered = body.indexOf("setNeedsName(false)") < body.indexOf("await publishPacket(false)");
  assert.ok(ordered && body.indexOf("setNeedsName(false)") > body.indexOf("if (!res.ok)"),
    "the field closes before the name is known to be saved");
});

test("EVERY OTHER BLOCKER STILL BLOCKS, and still says why", () => {
  // The route's other refusals are untouched, in their order. A naming fix that
  // quietly relaxed one of these would be far worse than the dead end it
  // replaced.
  for (const refusal of ["Add at least one item", "All items need titles",
                         "Block composition is inconsistent; cannot publish",
                         "Add at least one section"]) {
    assert.ok(PUBLISH_ROUTE.includes(refusal), `the publish gate lost: ${refusal}`);
  }
  for (const code of ["ownership_unresolved", "ownership_unavailable", "no_profile"]) {
    assert.ok(PREVIEW.includes(code), `the share step stopped handling ${code}`);
  }
  // The refusals Preview does NOT name are shown through its fallback, which is
  // why that fallback has to keep preferring the server's own sentence.
  for (const code of ["changed_while_publishing", "import_in_progress"]) {
    assert.ok(PUBLISH_ROUTE.includes(code), `the publish route stopped refusing ${code}`);
  }
  assert.match(PREVIEW, /setError\(data\.message \|\| data\.error \|\| "Could not publish"\)/,
    "an unnamed refusal would lose the server's explanation");
  // And the publish route still reads the Sendset's state itself and mints its
  // own token per request. That is what makes save-then-publish acceptable —
  // NOT that the two requests are atomic, which they are not. The publish
  // validates whatever is true when it runs, under the row lock, rather than
  // trusting anything the share step believed a moment earlier.
  assert.match(PUBLISH_ROUTE, /rpc\("packet_publish_token"/);
  assert.match(PUBLISH_ROUTE, /p_expected_token: publishToken/);
  assert.ok(!/p_expected_token/.test(PREVIEW), "the client now carries a publish token");
});

test("one publish at a time, including this one", () => {
  // The share step guards against a second click landing before the disabled
  // state renders. The new path is a publish too, so it takes the same guard.
  const body = saveHandler();
  assert.match(body, /if \([\s\S]{0,40}publishInFlight\.current\) return/,
    "Save & publish can be pressed twice");
  assert.match(body, /publishInFlight\.current = true/);
  assert.match(body, /finally \{[\s\S]*publishInFlight\.current = false/,
    "a failed save leaves the share step unable to publish");
  // The ordinary Publish button cannot be pressed while the field is open —
  // it would only produce the same refusal again.
  assert.match(PREVIEW, /onClick=\{startPublish\} disabled=\{publishing \|\| needsName\}/,
    "Publish stays live beside the field that exists because it failed");
});
