import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { libraryCopyFailure, CREATE_FAILED_MESSAGE, ADD_FAILED_MESSAGE } from "./library-copy-failure.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const bodyOf = (p: string) => codeOf(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CREATE_ROUTE = "src/app/api/packets/from-library/route.ts";
const ADD_ROUTE = "src/app/api/packets/[id]/items/from-library/route.ts";

/** Run something with console.error captured. */
function capturing<T>(fn: () => T): { value: T; logged: string[] } {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try { return { value: fn(), logged }; } finally { console.error = original; }
}

// ---------------------------------------------------------------------------
// THE OBSERVED DEFECT: the database's own text reached the modal.
// ---------------------------------------------------------------------------
const RAW = "function public.update_item_content(uuid, uuid, uuid, unknown, text, text, " +
            "text, text, jsonb, jsonb, jsonb, jsonb) does not exist";

test("THE REPORTED ERROR never reaches the professional", () => {
  const { value, logged } = capturing(() =>
    libraryCopyFailure(RAW, "create-from-library", { error: "create_failed", message: CREATE_FAILED_MESSAGE }));
  assert.equal(value.message, CREATE_FAILED_MESSAGE);
  assert.doesNotMatch(value.message, /update_item_content|uuid|jsonb|function public\./,
    "the schema is still being published to the modal");
  assert.equal(value.error, "create_failed");
  assert.equal(value.status, 400);
  // ...and the detail is not thrown away, or there is nothing left to diagnose.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /update_item_content/, "the raw text was not logged");
  assert.match(logged[0], /create-from-library/, "the log does not say which path failed");
});

test("an unexpected failure on the ADD path is equally quiet, with its own wording", () => {
  const { value, logged } = capturing(() =>
    libraryCopyFailure(RAW, "add-from-library", { error: "insert_failed", message: ADD_FAILED_MESSAGE }));
  assert.equal(value.message, ADD_FAILED_MESSAGE);
  assert.match(value.message, /nothing was changed/i, "it does not say the Sendset was left alone");
  assert.match(logged[0], /add-from-library/);
});

test("both product messages say what happened and what to do, without jargon", () => {
  for (const m of [CREATE_FAILED_MESSAGE, ADD_FAILED_MESSAGE]) {
    assert.doesNotMatch(m, /uuid|jsonb|function|sql|rpc|postgres|null/i, `leaks implementation: ${m}`);
    assert.match(m, /try again/i, `gives the professional nothing to do: ${m}`);
  }
});

// ---------------------------------------------------------------------------
// Refusals the professional CAN act on keep their own wording.
// ---------------------------------------------------------------------------
test("a missing or foreign entry stays actionable, and stays a 409", () => {
  const { value } = capturing(() => libraryCopyFailure(
    "library: 2 of 4 chosen entries are missing or not yours", "create-from-library",
    { error: "create_failed", message: CREATE_FAILED_MESSAGE }));
  assert.equal(value.error, "entries_unavailable");
  assert.equal(value.status, 409);
  assert.match(value.message, /no longer available/i);
});

test("an empty selection and a foreign section keep their own answers", () => {
  const empty = capturing(() => libraryCopyFailure("library: choose at least one saved item", "x",
    { error: "create_failed", message: CREATE_FAILED_MESSAGE })).value;
  assert.match(empty.message, /Choose something from your Library/i);
  const section = capturing(() => libraryCopyFailure("library: section does not belong to this Sendset", "x",
    { error: "insert_failed", message: ADD_FAILED_MESSAGE })).value;
  assert.match(section.message, /not part of this Sendset/i);
});

test("every recognised refusal is logged too — a spike in them is worth seeing", () => {
  const { logged } = capturing(() => libraryCopyFailure(
    "library: 1 of 2 chosen entries are missing or not yours", "add-from-library",
    { error: "insert_failed", message: ADD_FAILED_MESSAGE }));
  assert.equal(logged.length, 1);
});

test("a non-string error object does not crash the handler", () => {
  const { value } = capturing(() => libraryCopyFailure({ message: RAW }, "x",
    { error: "create_failed", message: CREATE_FAILED_MESSAGE }));
  assert.equal(value.message, CREATE_FAILED_MESSAGE);
  const nothing = capturing(() => libraryCopyFailure(undefined, "x",
    { error: "create_failed", message: CREATE_FAILED_MESSAGE })).value;
  assert.equal(nothing.message, CREATE_FAILED_MESSAGE);
});

// ---------------------------------------------------------------------------
// NEITHER ROUTE MAY HAND A DATABASE MESSAGE TO THE CLIENT.
// ---------------------------------------------------------------------------
test("neither Library route returns a raw database message", () => {
  for (const p of [CREATE_ROUTE, ADD_ROUTE]) {
    const body = bodyOf(p);
    assert.doesNotMatch(body, /message:\s*(error|rpcErr|lastError)\.message/,
      `${p} returns the database's own text to the client`);
    assert.doesNotMatch(body, /message:\s*lastError\b/, `${p} returns the retained raw error`);
    assert.match(body, /libraryCopyFailure\(/, `${p} does not route failures through the shared classifier`);
  }
});

// ---------------------------------------------------------------------------
// THE SIGNATURE MISMATCH ITSELF — the narrow check tied to this failure.
//
// Not a general SQL analyser: it reads the ONE call this incident was about and
// compares it with the CURRENT declaration of the one function it calls.
// ---------------------------------------------------------------------------
const MIG = "supabase/migrations";
const migrations = readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
const latestWith = (needle: string) => {
  for (let i = migrations.length - 1; i >= 0; i--) {
    const text = codeOf(`${MIG}/${migrations[i]}`);
    if (text.includes(needle)) return { file: migrations[i], text };
  }
  return null;
};
/** Split an argument list on TOP-LEVEL commas — coalesce(a, b) is one argument. */
function topLevelArgs(list: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0, quoted = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && c === "," && depth === 0) { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  out.push(list.slice(start).trim());
  return out.filter((a) => a.length > 0);
}

test("the Library copy calls update_item_content with the arity it currently declares", () => {
  const decl = latestWith("create or replace function public.update_item_content(")!;
  const declBody = decl.text.slice(decl.text.indexOf("create or replace function public.update_item_content("));
  const params = topLevelArgs(declBody.slice(declBody.indexOf("(") + 1, declBody.indexOf(")")));

  const call = latestWith("perform public.update_item_content(")!;
  const at = call.text.indexOf("perform public.update_item_content(");
  const open = call.text.indexOf("(", at);
  let depth = 0, close = open;
  for (let i = open; i < call.text.length; i++) {
    if (call.text[i] === "(") depth++;
    else if (call.text[i] === ")") { depth--; if (depth === 0) { close = i; break; } }
  }
  const args = topLevelArgs(call.text.slice(open + 1, close));

  assert.equal(args.length, params.length,
    `${call.file} calls update_item_content with ${args.length} arguments; ` +
    `${decl.file} declares ${params.length}. This is the exact mismatch that broke ` +
    `both Library entry points — postgres only notices when the body runs.`);

  // ...and the highlight it passes is empty, because Library material is reused
  // across clients and must never carry one client's Highlight for Client text.
  const highlightAt = params.findIndex((p) => p.startsWith("p_highlight"));
  assert.ok(highlightAt >= 0, "p_highlight is no longer a parameter — revisit this check");
  assert.equal(args[highlightAt], "''",
    `the Library copy passes ${args[highlightAt]} as p_highlight; it must pass '' so a ` +
    `highlight written for one client cannot ride into another's Sendset`);
});

test("library_items still has no highlight column to copy FROM", () => {
  const added = migrations.some((f) =>
    /alter table (public\.)?library_items[\s\S]*?add column[^;]*highlight/i.test(codeOf(`${MIG}/${f}`)));
  assert.equal(added, false,
    "a highlight column reached library_items — 0033 excluded it deliberately, because a " +
    "highlight belongs to one client and Library material is reused across clients");
});
