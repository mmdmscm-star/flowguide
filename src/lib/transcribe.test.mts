// READING A PICTURE INTO SOURCE MATERIAL.
//
// The architecture this protects: image -> transcription -> A HUMAN CORRECTS IT
// -> source_text -> the pipeline that already exists. The model reads; it never
// owns what the document said. Every test here is about keeping that ordering
// true, because each shortcut past it looks like a simplification and is a way
// for a misread price to become "source-supported".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSCRIPTION_PROMPT, callTranscriptionModel } from "./transcribe.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOf = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

const TRANSCRIBE = codeOf("src/lib/transcribe.ts");
const ROUTE = codeOf("src/app/api/ingest/transcribe/route.ts");
const ORGANIZE = codeOf("src/app/api/ingest/organize/route.ts");
const NEW = codeOf("src/components/new/new-packet-workspace.tsx");
const SOURCE_IMAGE = codeOf("src/app/api/ingest/source-image/route.ts");
const AI = codeOf("src/lib/ai-structure.ts");

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const withFetch = async (impl: unknown, fn: () => Promise<void>) => {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try { await fn(); } finally { globalThis.fetch = orig; }
};
const call = () => callTranscriptionModel({
  bytes: PNG, mime: "image/png", apiKey: "k", model: "m", maxOutputTokens: 100 });

// ---------------------------------------------------------------------------
// THE PROMPT IS THE CONTRACT
// ---------------------------------------------------------------------------

test("the transcription prompt forbids everything that would make review impossible", () => {
  const p = TRANSCRIPTION_PROMPT.toLowerCase();
  for (const [rule, needle] of [
    ["summarising", "do not summarise"],
    ["reorganising", "do not reorganise"],
    ["inferring a missing value", "do not infer"],
    ["normalising prices", "do not normalise"],
    ["inventing attribution", "do not attribute"],
  ] as const) assert.ok(p.includes(needle), `the prompt does not forbid ${rule}`);
  // What it must PRESERVE, because the guards downstream read these.
  for (const keep of ["currency", "phone", "email", "heading", "row", "exactly"])
    assert.ok(p.includes(keep), `the prompt does not ask to preserve ${keep}`);
  // Uncertainty is marked, not guessed.
  assert.ok(p.includes("[unclear]"), "the prompt lets the model guess at unreadable text");
});

// ---------------------------------------------------------------------------
// TRANSPORT AND PRIVACY
// ---------------------------------------------------------------------------

test("THE BYTES TRAVEL IN OUR REQUEST, not as a URL for the provider to fetch", async () => {
  let sent: Record<string, unknown> = {};
  await withFetch(async (_u: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
  }, async () => { await call(); });

  const msg = (sent.messages as { role: string; content: unknown }[])[1];
  const parts = msg.content as { type: string; image_url?: { url: string } }[];
  const img = parts.find((x) => x.type === "image_url");
  assert.ok(img, "no image part was sent");
  assert.match(img!.image_url!.url, /^data:image\/png;base64,/,
    "the image is not a data URL, so the provider fetches it from our bucket");
  assert.ok(!/storage\/v1\/object\/public/.test(JSON.stringify(sent)),
    "a public storage URL was handed to the provider");
});

test("THE PRIVACY ROUTING IS THE SAME AS EVERY OTHER CALL", async () => {
  let sent: Record<string, unknown> = {};
  await withFetch(async (_u: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
  }, async () => { await call(); });
  assert.deepEqual(sent.provider, { data_collection: "deny", zdr: true },
    "an image is routed with weaker privacy than a paste");
  assert.equal(sent.temperature, 0, "transcription is not deterministic");
});

// ---------------------------------------------------------------------------
// FAILURES, AND WHOSE THEY ARE
// ---------------------------------------------------------------------------

test("A PROVIDER REFUSAL IS REPORTED AS THEIRS — no invented size ceiling", async () => {
  // The provider's per-image limit has NOT been measured. A 413 from them must
  // not be dressed up as a rule of ours.
  await withFetch(async () => ({ ok: false, status: 413, text: async () => "image too large" }),
    async () => {
      const r = await call();
      assert.ok(!r.ok && r.source === "provider", "a provider refusal is attributed to us");
      assert.match(r.ok ? "" : r.message, /AI service/, "the message does not say whose refusal it was");
    });
  // And our module states no byte ceiling of its own.
  assert.ok(!/\b\d{6,}\b/.test(TRANSCRIBE), "transcribe.ts hard-codes a size number");
});

test("a truncated reading FAILS CLOSED", async () => {
  await withFetch(async () => ({
    ok: true, json: async () => ({ choices: [{ finish_reason: "length", message: { content: "half a page" } }] }),
  }), async () => {
    const r = await call();
    assert.ok(!r.ok && r.error === "truncated",
      "a cut-off transcription is returned as if it were the whole document");
  });
});

test("an empty reading is a failure, not an empty source", async () => {
  await withFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "   " } }] }) }),
    async () => {
      const r = await call();
      assert.ok(!r.ok && r.error === "empty_transcription");
    });
});

test("no private endpoint is surfaced, never silently downgraded", async () => {
  await withFetch(async () => ({ ok: false, status: 404, text: async () => "No endpoints found matching data policy" }),
    async () => {
      const r = await call();
      assert.ok(!r.ok && r.error === "no_private_endpoint");
      assert.match(r.ok ? "" : r.message, /zero data retention/);
    });
});

// ---------------------------------------------------------------------------
// THE ROUTE'S ORDERING
// ---------------------------------------------------------------------------

test("TRANSCRIPTION STORES NOTHING — reading is not keeping", () => {
  // A professional who photographs a client document, reads what came back and
  // then abandons the page has not asked us to hold their document. Storing on
  // transcription left one in the bucket for every abandoned attempt, attached
  // to no run and so outside the evidence lifecycle entirely.
  const body = ROUTE.slice(ROUTE.indexOf("export async function POST"));
  assert.ok(!/storeCreatorImage/.test(ROUTE),
    "the transcription route still persists the source document");
  assert.ok(!/createServerClient|storage/i.test(body),
    "the transcription route still reaches storage");
  assert.match(body, /json\(\{ ok: true, text: read\.text \}\)/,
    "the transcription route returns something other than text");
  assert.ok(!/url:/.test(body.slice(body.indexOf("return NextResponse.json({ ok: true"))),
    "a stored URL is still returned from transcription");
});

test("ABANDONING AFTER TRANSCRIPTION CANNOT STORE ANYTHING", () => {
  // The picture is held as a File in the browser with a local object URL. The
  // only upload on this screen happens inside the organize handler, after the
  // professional has committed.
  // SENT TO BE READ IS NOT KEPT. The bytes necessarily go to the transcription
  // route — nothing can read an image locally — so what matters is that they go
  // ONLY there, and that reading returns no stored URL to hold on to.
  const pic = NEW.slice(NEW.indexOf("async function handlePicture"), NEW.indexOf("async function handleFile"));
  assert.match(pic, /\/api\/ingest\/transcribe/, "the picture is not read at all");
  assert.ok(!/\/api\/ingest\/source-image/.test(pic),
    "reading a picture also persists it, so abandoning leaves a stored document");
  assert.ok(!/data\.url/.test(pic), "reading still takes a stored URL from the response");
  assert.match(pic, /URL\.createObjectURL/, "the preview is not local");
  assert.match(NEW, /sourceImage.*\{ file: File; preview: string \}/s,
    "the component holds a URL rather than the File it has not sent");
  // Removing it revokes the local URL rather than deleting anything remote.
  assert.match(NEW, /URL\.revokeObjectURL/, "the local preview leaks");
});

test("EXPLICIT CONTINUE IS WHAT PERSISTS THE SOURCE IMAGE", () => {
  const org = NEW.slice(NEW.indexOf("async function handleOrganize"));
  const upload = org.indexOf("/api/ingest/source-image");
  const create = org.indexOf("/api/ingest/organize");
  assert.ok(upload > -1, "Continue does not persist the picture");
  assert.ok(create > -1, "Continue does not create the run");
  assert.ok(upload < create, "the run is created before its image is stored");
  // A failed store creates nothing at all.
  assert.match(org.slice(upload, create), /setProcessing\(false\);\s*\n\s*return;/,
    "a failed image store still goes on to create a run");
  // And the source-image route stores without attaching.
  assert.match(SOURCE_IMAGE, /getSession\(\)/, "the source-image route is unauthenticated");
  assert.match(SOURCE_IMAGE, /storeCreatorImage/, "it does not use the shared store");
  assert.ok(!/ingestion_runs|create_organize_run/.test(SOURCE_IMAGE),
    "the upload route attaches the image to a run itself");
});

test("OUR VALIDATION AND THEIRS ARE SEPARATE", () => {
  assert.match(ROUTE, /source: "ours"/, "our own refusals are not labelled");
  assert.match(ROUTE, /source: read\.source/, "the provider's refusal is relabelled as ours");
  // Type is proved by the bytes, never by the uploader's Content-Type.
  assert.match(ROUTE, /sniffImageType\(bytes\)/, "the route trusts the declared type");
  assert.match(ROUTE, /MAX_PHOTO_BYTES/, "our own size gate is gone");
});

test("the route stores bytes and cannot start a run", () => {
  assert.match(ROUTE, /getSession\(\)/, "unauthenticated callers can transcribe");
  assert.ok(!/create_organize_run|ingestion_runs|buildRunChunks/.test(ROUTE),
    "the transcription route can begin structuring without a human reading it");
});

// ---------------------------------------------------------------------------
// THE HUMAN STEP, AND WHAT COMES AFTER IT
// ---------------------------------------------------------------------------

test("THE TRANSCRIPTION LANDS IN THE EDITABLE BOX, not in a run", () => {
  const fn = NEW.slice(NEW.indexOf("async function handlePicture"), NEW.indexOf("async function handleFile"));
  assert.match(fn, /setRawText\(/, "the transcription does not reach the editable text");
  assert.ok(!/ingest\/organize/.test(fn), "reading a picture starts organizing by itself");
  // Organize stays the professional's own act, on the text they can see.
  assert.match(NEW, /const source = rawText\.trim\(\);/,
    "organize no longer submits the text the professional edited");
});

test("THE STRUCTURING CONTRACT IS UNTOUCHED", () => {
  assert.match(AI, /rawText: string;/, "callStructuringModel no longer takes text only");
  assert.ok(!/image_url|data:image|base64/.test(AI),
    "the structuring path learned about images");
  // And the picture is not smuggled into the run as content.
  assert.ok(!/sourceImageUrl/.test(codeOf("src/lib/ingestion.ts")),
    "segmentation knows about the image");
});

test("PROVENANCE IS STAMPED IN ONE UPDATE, or 0045 refuses it", () => {
  const u = ORGANIZE.slice(ORGANIZE.indexOf("if (sourceImageUrl)"));
  assert.match(u, /source_origin: "image", source_image_url: sourceImageUrl/,
    "the two columns are set separately, which the coherence CHECK rejects");
  assert.match(u, /\.eq\("user_id", session\.userId\)/, "the stamp is not owner-scoped");
  assert.match(ORGANIZE, /sourceImageUrl.*\? body\.sourceImageUrl\.trim\(\) : null/s,
    "the field is not optional, so text runs would be mislabelled");
});

test("A FAILED PROVENANCE STAMP STOPS THE REQUEST", () => {
  // 0045 exists so an image-origin run cannot be mistaken for a paste. A run
  // that lost its provenance is invisible afterwards — the text reads like any
  // other source — so this must not be survivable.
  const u = ORGANIZE.slice(ORGANIZE.indexOf("if (sourceImageUrl)"));
  const fail = u.indexOf("if (markError)");
  assert.ok(fail > -1, "the stamp result is not checked");
  const branch = u.slice(fail, u.indexOf("return NextResponse.json({ packetId:"));
  assert.match(branch, /status: 500/, "a failed stamp does not fail the request");
  assert.match(branch, /provenance_not_recorded/, "the failure is not named");
  assert.ok(!/console\.error[\s\S]*\}\s*\}\s*$/.test(branch) || /return NextResponse/.test(branch),
    "the failure is only logged");
  // The success payload must come AFTER the guard, so a failed stamp can never
  // hand back a packet the browser would follow into the editor.
  assert.ok(ORGANIZE.indexOf("provenance_not_recorded") < ORGANIZE.indexOf("return NextResponse.json({ packetId:"),
    "the packet is returned before the provenance is known");
});

test("IMAGE-ORIGIN STRUCTURING CANNOT FALL BACK TO TEXT PROVENANCE", () => {
  // No model work happens in this route at all — structuring runs later, in the
  // chunk routes, which the editor drives only after a SUCCESS response. So
  // withholding that response is what keeps image-derived text out of the
  // pipeline without its provenance.
  assert.ok(!/callStructuringModel|openrouter/i.test(ORGANIZE),
    "the organize route structures text itself, so a failed stamp comes too late");
  // And nothing downgrades an image run to a text one.
  assert.ok(!/source_origin: "text"/.test(ORGANIZE),
    "the route can write text provenance onto an image run");
  const u = ORGANIZE.slice(ORGANIZE.indexOf("if (sourceImageUrl)"));
  assert.ok(!/catch/.test(u), "the stamp failure is swallowed by a catch");
});
