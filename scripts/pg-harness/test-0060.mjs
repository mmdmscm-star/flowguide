// 0060 against real PostgreSQL 17: the source-document manifest. Its shape, its
// shared lifetime with source_text on every clearing path (a direct clear, the
// real scheduled purge, a library discard), existing runs untouched, the
// rollback, and mutants of the migration.
//
//   scripts/pg-harness/harness.sh replay pre0060 0059
//   node scripts/pg-harness/test-0060.mjs [path/to/0060.sql]
import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCKET = process.env.PGHARNESS_DIR ?? join(homedir(), ".sendset-pg-harness");
const PORT = Number(process.env.PGHARNESS_PORT ?? 55432);
const MIGRATION = readFileSync(process.argv[2] ?? join(ROOT, "supabase/migrations/0060_ingestion_source_documents.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/0060_ingestion_source_documents_down.sql"), "utf8");
const TEMPLATE = "pre0060";
const OWNER = "00000000-0000-4000-8000-000000000001";
const H = "ab".repeat(32);

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const connect = async (database) => { const c = new pg.Client({ host: SOCKET, port: PORT, user: "postgres", database }); await c.connect(); return c; };
const attempt = async (c, sql, args) => {
  try { return { ok: true, res: await c.query(sql, args) }; }
  catch (err) { try { await c.query("rollback"); } catch { /* none */ } return { ok: false, err }; }
};
const admin = await connect("postgres");
const created = new Set();
async function freshDb(name, { sql = MIGRATION, before } = {}) {
  await admin.query(`drop database if exists "${name}"`);
  await admin.query(`create database "${name}" template "${TEMPLATE}"`);
  created.add(name);
  const c = await connect(name);
  if (before) await before(c);
  if (sql !== null) await c.query(sql);
  await c.end();
  return name;
}

const SOURCE = "Harbor House\t$2,400\nThe Loft\t$1,950";
const manifest = (over = {}) => [{
  kind: "pdf", name: "prices.pdf", bytes: 1016, sha256: H, pageCount: 2,
  extractor: "pdfjs-dist@6.3.289+sendset-pdf-layout@1",
  pages: [
    { page: 1, chars: SOURCE.length, sha256: H, start: 0, end: SOURCE.length },
    { page: 2, chars: 0, sha256: H, start: null, end: null },
  ],
  ...over,
}];
async function run(c, { text = SOURCE, destination = "packet" } = {}) {
  const { rows: [p] } = await c.query(
    "insert into public.packets (user_id, slug, title) values ($1, 'r-' || substr(md5(random()::text),1,10), 'T') returning id", [OWNER]);
  const { rows: [r] } = await c.query(
    `insert into public.ingestion_runs (user_id, packet_id, entry_point, source_text, source_hash, source_len, segmenter_version, destination)
     values ($1, $2, $3, $4, 'x', $5, 'seg-test', $6) returning id`,
    [OWNER, destination === "packet" ? p.id : null, destination === "packet" ? "organize" : "library_import", text, text?.length ?? 0, destination]);
  return { runId: r.id, packetId: p.id };
}
const docsOf = async (c, id) => (await c.query("select source_documents as d, source_text as t from public.ingestion_runs where id = $1", [id])).rows[0];

async function main() {
  // --- EXISTING RUNS: UNTOUCHED, AND NO MANIFEST ------------------------------
  {
    let before;
    const db = await freshDb("r60_existing", {
      before: async (c) => {
        await run(c);
        await run(c, { text: "an older paste" });
        before = (await c.query("select id, source_text, source_len, status, updated_at::text as u from public.ingestion_runs order by id")).rows;
      },
    });
    const c = await connect(db);
    const after = (await c.query("select id, source_text, source_len, status, updated_at::text as u, source_documents from public.ingestion_runs order by id")).rows;
    ok(after.length === 2, "the existing runs are still there");
    ok(JSON.stringify(after.map(({ source_documents, ...r }) => r)) === JSON.stringify(before), "and are byte-for-byte as they were");
    ok(after.every((r) => r.source_documents === null), "with no manifest");
    await c.end();
  }

  // --- THE SHAPE ---------------------------------------------------------------
  {
    const db = await freshDb("r60_shape");
    const c = await connect(db);
    const { runId } = await run(c);
    const set = (m) => attempt(c, "update public.ingestion_runs set source_documents = $2 where id = $1", [runId, JSON.stringify(m)]);
    ok((await set(manifest())).ok, "a well-formed manifest is accepted");
    ok((await set([...manifest(), ...manifest({ name: "second.pdf" })])).ok, "and so are two documents");

    const cases = [
      ["a manifest that is not a list", {}],
      ["an empty list", []],
      ["a document that is not a PDF", manifest({ kind: "docx" })],
      ["a file hash that is not a SHA-256", manifest({ sha256: "abc" })],
      ["a page count that disagrees with the pages", manifest({ pageCount: 3 })],
      ["more than 50 pages", manifest({ pageCount: 51 })],
      ["a file over 20 MB", manifest({ bytes: 20 * 1024 * 1024 + 1 })],
      ["a nameless file", manifest({ name: "" })],
      ["pages out of order", manifest({ pages: [{ ...manifest()[0].pages[1], page: 1 }, { ...manifest()[0].pages[0], page: 2 }].reverse() })],
      ["a span shorter than its text", manifest({ pages: [{ ...manifest()[0].pages[0], end: SOURCE.length - 1 }, manifest()[0].pages[1]] })],
      ["half a span", manifest({ pages: [{ ...manifest()[0].pages[0], start: null }, manifest()[0].pages[1]] })],
      ["a blank page that points somewhere", manifest({ pages: [manifest()[0].pages[0], { ...manifest()[0].pages[1], start: 0, end: 1 }] })],
      ["21 documents", Array.from({ length: 21 }, () => manifest()[0])],
    ];
    for (const [what, m] of cases) {
      const r = await set(m);
      ok(!r.ok && r.err.code === "23514", `refused: ${what}`);
    }
    await c.end();
  }

  // --- THE SHARED LIFETIME, ON EVERY PATH --------------------------------------
  {
    const db = await freshDb("r60_lifetime");
    const c = await connect(db);

    const a = await run(c);
    await c.query("update public.ingestion_runs set source_documents = $2 where id = $1", [a.runId, JSON.stringify(manifest())]);
    await c.query("update public.ingestion_runs set source_text = null where id = $1", [a.runId]);
    ok((await docsOf(c, a.runId)).d === null, "clearing the source clears the manifest in the same statement");

    const b = await run(c);
    await c.query("update public.ingestion_runs set source_documents = $2, evidence_purge_after = now() - interval '1 minute' where id = $1",
      [b.runId, JSON.stringify(manifest())]);
    const keep = await run(c);
    await c.query("update public.ingestion_runs set source_documents = $2, evidence_purge_after = now() + interval '10 days' where id = $1",
      [keep.runId, JSON.stringify(manifest())]);
    await c.query("select public.purge_ingestion_evidence()");
    const purged = await docsOf(c, b.runId), kept = await docsOf(c, keep.runId);
    ok(purged.t === null && purged.d === null, "the REAL scheduled purge clears the manifest with the source");
    ok(kept.t !== null && kept.d !== null, "and leaves a run still inside its window alone");

    const stale = await attempt(c, "update public.ingestion_runs set source_documents = $2 where id = $1", [a.runId, JSON.stringify(manifest())]);
    ok(!stale.ok && stale.err.code === "23514", "a manifest cannot be attached to a run whose source is gone");
    const both = await attempt(c,
      `insert into public.ingestion_runs (user_id, packet_id, entry_point, source_text, source_hash, source_len, segmenter_version, source_documents)
       values ($1, $2, 'organize', null, 'x', 0, 'seg-test', $3)`, [OWNER, a.packetId, JSON.stringify(manifest())]);
    ok(!both.ok && both.err.code === "23514", "nor inserted without one");

    // Setting both in one statement — the manifest replaced and the source
    // cleared — still ends with neither.
    const d = await run(c);
    await c.query("update public.ingestion_runs set source_documents = $2 where id = $1", [d.runId, JSON.stringify(manifest())]);
    await c.query("update public.ingestion_runs set source_text = null, source_documents = $2 where id = $1", [d.runId, JSON.stringify(manifest({ name: "x.pdf" }))]);
    ok((await docsOf(c, d.runId)).d === null, "an UPDATE that clears the source and writes a manifest keeps neither");

    // Deleting the run takes the manifest with it — there is nothing else to clean.
    await c.query("delete from public.ingestion_runs where id = $1", [keep.runId]);
    ok((await c.query("select count(*)::int as n from public.ingestion_runs where id = $1", [keep.runId])).rows[0].n === 0,
      "deleting a run needs nothing else cleaned up");
    await c.end();
  }

  // --- THE ROLLBACK ------------------------------------------------------------
  {
    const db = await freshDb("r60_rollback");
    const c = await connect(db);
    const r = await run(c);
    await c.query("update public.ingestion_runs set source_documents = $2 where id = $1", [r.runId, JSON.stringify(manifest())]);
    const done = await attempt(c, ROLLBACK);
    ok(done.ok, "the rollback runs");
    const left = (await c.query(`select
        (select count(*)::int from information_schema.columns where table_name = 'ingestion_runs' and column_name = 'source_documents') as col,
        to_regprocedure('public.ingestion_source_documents_valid(jsonb)') as f1,
        to_regprocedure('public.ingestion_clear_source_documents()') as f2,
        (select source_text from public.ingestion_runs where id = '${r.runId}') as text`)).rows[0];
    ok(left.col === 0 && !left.f1 && !left.f2, "every 0060 object is gone");
    ok(left.text === SOURCE, "and the source text it described is untouched");
    await c.end();
  }

  // --- MUTANTS: each must abort the migration, for its own reason ---------------
  const aborting = [
    ["no trigger", (s) => s.replace(/create trigger trg_ingestion_clear_source_documents[\s\S]*?execute function public\.ingestion_clear_source_documents\(\);/, ""),
      /manifest outlived its source|a manifest was stored without a source|check constraint/],
    ["no manifest-needs-source check", (s) => s.replace("check (source_documents is null or source_text is not null)", "check (true)"),
      /a manifest was stored without a source/],
    ["spans need not match their text", (s) => s.replace("if (p->>'end')::numeric - (p->>'start')::numeric <> (p->>'chars')::numeric then return false; end if;", ""),
      /a malformed manifest was accepted/],
    ["any kind of document", (s) => s.replace("if d->>'kind' is distinct from 'pdf' then return false; end if;", ""),
      /a malformed manifest was accepted/],
    ["page count unchecked", (s) => s.replace("or jsonb_array_length(d->'pages') <> (d->>'pageCount')::int then return false; end if;", "then return false; end if;"),
      /a malformed manifest was accepted/],
    ["the migration quietly edits an existing run", (s) => s.replace("-- 1. THE SHAPE.", "-- 1. THE SHAPE.\nupdate public.ingestion_runs set error = 'touched';"),
      /an existing run changed/],
    ["the trigger function is callable by anyone", (s) => s.replace("revoke all on function public.ingestion_clear_source_documents() from public, anon, authenticated;",
      "grant execute on function public.ingestion_clear_source_documents() to anon;"),
      /callable by an unprivileged role/],
  ];
  for (const [i, [name, mutate, reason]] of aborting.entries()) {
    const sql = mutate(MIGRATION);
    ok(sql !== MIGRATION, `MUTANT prepared: ${name}`);
    const db = await freshDb(`r60_mut_${i}`, {
      sql: null,
      // Existing runs for the "edits an existing run" mutant to find.
      before: async (c) => { await run(c); },
    });
    const c = await connect(db);
    const r = await attempt(c, sql);
    ok(!r.ok && reason.test(r.err.message),
      `MUTANT aborts the migration FOR ITS OWN REASON: ${name}${r.ok ? " — IT DID NOT ABORT" : ` — ${r.err.message.slice(0, 70)}`}`);
    await c.end();
  }

  for (const db of created) await admin.query(`drop database if exists "${db}"`);
  await admin.end();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
