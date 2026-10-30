/**
 * The icmcp CLI (scripts/cli.mjs) end to end on the fixture DB: every check runs
 * the real CLI → v2 client → stdio/HTTP → server → tool chain as a child process.
 *
 * Run:  node scripts/tests/test-cli.mjs   (in `npm test`; needs ./dist)
 *
 * Failure modes guarded:
 *  - static help or an unknown command tries to connect (and so breaks with no
 *    build, no DBs or a stale ICMCP_HTTP)
 *  - --max maps to one global param, so it fails on the server for a verb whose
 *    cap has another name, or is silently forwarded where there is no cap
 *  - a typo'd or unknown flag, a missing positional, a non-number, an unquoted
 *    multi-word query, or too many codes reaches the server (exit 1) instead of
 *    failing as a usage error (exit 2) — or --show-call prints it as valid
 *  - several positionals for resolve/artworks are dropped or sent as a string
 *  - stdout is not pure JSONL: summary, notes or server log lines leak into it,
 *    or the server's stderr floods the CLI's
 *  - a capped or partial result reads as complete: notFound, unlabelled codes,
 *    key variants or children beyond the page, or the "more" offset is wrong
 *    or off by one
 *  - --stdin sends one call per code for resolve instead of batching up to the
 *    tool's 25-code limit, ignores comments/blanks, or hides per-line failures
 *  - a tool error or a dead server exits 0
 *  - the stdio server outlives the client hanging up, or exits without flushing
 *    its usage counters
 *  - the 2026-07-28 / auto eras, or --http, don't work
 *  - a --help example stops running against the data it documents
 *  - PORT in the shell env puts the stdio child in HTTP mode, so the CLI hangs
 *  - a reader closing the pipe (`| head`) crashes with EPIPE and exit 1
 *
 * Not covered (the fixture can't express them, and seed rows are never invented):
 * browse's subtreeCapped / per-parent children caps and the >200 large-subtree
 * note, which need a branch wider than any seeded one; semantic output, which
 * needs embeddings (test-tools.mjs §19 runs it through the CLI on the real DB).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, assertEq, eqList, section, report } from "./_assert.mjs";
import { spawn } from "node:child_process";
import { fixtureEnv } from "./fixture-client.mjs";
import { PROJECT_ROOT } from "./build-fixture-db.mjs";
import { bootHttpServer, runCli, jsonlRows as rows } from "./_server.mjs";

const ENV = fixtureEnv("cli");
// Port 1 refuses connections: anything that tries to connect fails fast.
const DEAD = "http://127.0.0.1:1/mcp";
const VERBS = ["search", "semantic", "browse", "resolve", "keys", "prefix", "artworks"];

const errLines = (r) => r.stderr.split("\n").filter(Boolean);
const notations = (r) => rows(r).map((x) => x.notation);
const usage = (r, msg) => assertEq(r.code, 2, `${msg}: exit 2`);

/** Run every case concurrently (each spawns a server), keyed by name. */
async function runAll(cases) {
  const out = {};
  const entries = Object.entries(cases);
  const results = await Promise.all(entries.map(([, c]) => runCli(c.args, { env: ENV, ...c })));
  entries.forEach(([name], i) => { out[name] = results[i]; });
  return out;
}

// ══════════════════════════════════════════════════════════════════
section("1. static paths never connect");

const deadEnv = { ...ENV, ICMCP_HTTP: DEAD };
const s = await runAll({
  top:     { args: ["--help"], env: deadEnv },
  none:    { args: [], env: deadEnv },
  unknown: { args: ["frobnicate"], env: deadEnv },
  toolsH:  { args: ["tools", "--help"], env: deadEnv },
  protoX:  { args: ["--protocol", "bogus", "resolve", "1"], env: deadEnv },
  verbH:   { args: ["browse", "--help"], env: deadEnv },
});
assertEq(s.top.code, 0, "--help: exit 0");
for (const v of VERBS) {
  assert(new RegExp(`^  ${v}\\b`, "m").test(s.top.stdout), `top help lists ${v}`);
}
assert(s.top.stdout.includes("maxKeyVariants (browse)"), "top help names browse's --max target");
assertEq(s.none.stdout, s.top.stdout, "no arguments prints the same help");
usage(s.unknown, "unknown command");
assert(s.unknown.stderr.startsWith("Unknown command: frobnicate"), "unknown command is named");
assert(!s.unknown.stderr.includes("Connection failed"), "unknown command does not connect");
assertEq(s.toolsH.code, 0, "tools --help: exit 0");
usage(s.protoX, "bad --protocol");
assertEq(s.protoX.stderr, '--protocol must be one of legacy, auto, 2026-07-28 (got "bogus")\n', "bad --protocol message");
assertEq(s.verbH.code, 0, "verb --help without a server: exit 0");
assert(s.verbH.stdout.includes("was not reachable") && s.verbH.stdout.includes("Example:"),
  "verb --help without a server falls back to the example and a hint");

// ══════════════════════════════════════════════════════════════════
section("2. usage errors are caught before the call (exit 2)");

const u = await runAll({
  unknownFlag: { args: ["prefix", "73D", "--parentNotation", "7"] },
  nearMiss:    { args: ["search", "angel", "--parent-notation", "7"] },
  bareTypo:    { args: ["keys", "25F23", "--typo"] },
  maxNoCap:    { args: ["resolve", "25F23", "--max", "3"] },
  extra:       { args: ["browse", "73D", "73D8"] },
  unquoted:    { args: ["search", "crucifixion", "of", "christ"] },
  noPos:       { args: ["browse"] },
  noQuery:     { args: ["search", "--onlyWithArtworks"] },
  nan:         { args: ["keys", "25F23", "-n", "abc"] },
  boolSep:     { args: ["search", "angel", "--onlyWithArtworks", "true"] },
  noValue:     { args: ["keys", "25F23", "--fields"] },
  tooMany:     { args: ["resolve", ...Array.from({ length: 26 }, (_, i) => `X${i}`)] },
  showTypo:    { args: ["prefix", "73D", "--parentNotation", "7", "--show-call"] },
  stdinPos:    { args: ["resolve", "25F23", "--stdin"], input: "73D82\n" },
  stdinFlag:   { args: ["resolve", "--notation", "25F23", "--stdin"], input: "73D82\n" },
});
for (const [name, r] of Object.entries(u)) usage(r, name);
assertEq(u.unknownFlag.stderr,
  'Error: --parentNotation is not a flag for "prefix". Tool flags: --notation, --lang, --collectionId, --baseOnly, --maxResults, --offset (see `icmcp prefix --help`)\n',
  "unknown flag lists the tool's flags");
assert(u.nearMiss.stderr.includes("Did you mean --parentNotation?"), "kebab-case slip suggests the camelCase flag");
assert(u.bareTypo.stderr.startsWith('Error: --typo is not a flag for "keys".'), "a value-less typo reads as a typo, not a missing value");
assertEq(u.maxNoCap.stderr, 'Error: --max/-n is not a flag for "resolve" — see `icmcp resolve --help`\n', "--max on a verb with no cap");
assert(u.extra.stderr.startsWith('Error: unexpected extra argument(s): "73D8"'), "extra positional is named");
assert(u.unquoted.stderr.includes('"of", "christ"'), "unquoted multi-word query names the stray words");
assertEq(u.noPos.stderr, 'Error: "browse" requires <notation> (positional or --notation) — see `icmcp browse --help`\n', "missing notation");
assert(u.noQuery.stderr.startsWith('Error: "search" requires <query>'), "search without a query");
assertEq(u.nan.stderr, 'Error: --maxResults expects a number, got "abc"\n', "non-number names the real param");
assert(u.boolSep.stderr.includes("--onlyWithArtworks is a boolean flag and takes no separate value"), "boolean with a separate value");
assert(u.noValue.stderr.startsWith("Error: --fields requires a value"), "value flag with no value");
assert(u.tooMany.stderr.includes("takes at most 25 <notation> values per call (got 26)"), "26 codes is a usage error, from the schema's maxItems");
assertEq(u.showTypo.stdout, "", "--show-call prints nothing for a call the schema would reject");
assert(u.stdinPos.stderr.includes('unexpected extra argument(s): "25F23"'), "--stdin with a positional");
assert(u.stdinFlag.stderr.includes("drop --notation"), "--stdin with the positional's flag");

// ══════════════════════════════════════════════════════════════════
section("3. --show-call resolves aliases and positionals");

const sc = await runAll({
  search: { args: ["search", "angel", "--onlyWithArtworks", "--lang=de", "-n", "3", "--show-call"] },
  browse: { args: ["browse", "25F23", "--includeKeys", "--max", "7", "--show-call"] },
  keys:   { args: ["keys", "25F23", "--max=4", "--show-call"] },
  multi:  { args: ["resolve", "25F23", "25F23(+46)", "--show-call"] },
  single: { args: ["artworks", "73D6", "--show-call"] },
  kebab:  { args: ["search", "angel", "--semantic", "--show-call"] },
});
const call = (r) => JSON.parse(r.stdout);
if (assertEq(sc.search.code, 0, "search --show-call: exit 0")) {
  eqList(call(sc.search), { tool: "search", arguments: { onlyWithArtworks: true, lang: "de", maxResults: 3, query: "angel" } },
    "search: flags, --lang=, -n → maxResults, positional → query");
}
if (assertEq(sc.browse.code, 0, "browse --show-call: exit 0")) {
  assertEq(call(sc.browse).arguments.maxKeyVariants, 7, "browse: --max → maxKeyVariants");
}
if (assertEq(sc.keys.code, 0, "keys --show-call: exit 0")) {
  assertEq(call(sc.keys).arguments.maxResults, 4, "keys: --max= → maxResults");
}
if (assertEq(sc.multi.code, 0, "resolve --show-call: exit 0")) {
  eqList(call(sc.multi).arguments.notation, ["25F23", "25F23(+46)"], "resolve: every positional, as an array");
}
if (assertEq(sc.single.code, 0, "artworks --show-call: exit 0")) {
  eqList(call(sc.single).arguments.notation, ["73D6"], "artworks: one positional is still an array");
}
usage(sc.kebab, "--semantic is not a flag (semantic is a command)");

// ══════════════════════════════════════════════════════════════════
section("4. JSONL output, summaries and notes");

const o = await runAll({
  search:    { args: ["search", "crucifixion"] },
  page:      { args: ["search", "crucifixion", "-n", "2", "--offset", "2"] },
  lastPage:  { args: ["search", "crucifixion", "-n", "2", "--offset", "4"] },
  resolve:   { args: ["resolve", "25F23", "25F23(+46)", "NONEXISTENT", "--fields", "notation,text"] },
  keys:      { args: ["keys", "25F23", "-n", "5"] },
  prefix:    { args: ["prefix", "2"] },
  browseKv:  { args: ["browse", "25F23", "--includeKeys", "-n", "5", "--fields", "notation,totalKeyVariants"] },
  browseEnd: { args: ["browse", "25F23", "--includeKeys", "-n", "5", "--keyOffset", "25"] },
  browse:    { args: ["browse", "73D", "--fields", "notation"] },
  browseCo:  { args: ["browse", "73D", "--childOffset", "5", "--fields", "notation"] },
  artworks:  { args: ["artworks", "73D6", "11H(FOO)"] },
  json:      { args: ["resolve", "25F23", "NONEXISTENT", "--json"] },
  quiet:     { args: ["resolve", "25F23", "NONEXISTENT", "--quiet"] },
  table:     { args: ["keys", "25F23", "-n", "2", "--table", "--fields", "notation,keyId"] },
});
if (assertEq(o.search.code, 0, "search: exit 0")) {
  eqList(notations(o.search), ["73D6", "31E2356", "73D67", "73D5", "73D6712", "73D671"], "search rows in the tool's order, one JSON object per line");
  eqList(errLines(o.search), ["6 shown (offset 0) of 6"], "search summary on stderr");
}
eqList(notations(o.page), ["73D67", "73D5"], "--offset pages");
eqList(errLines(o.page), ["2 shown (offset 2) of 6; pass --offset 4 for more"], "next offset in the hint");
eqList(errLines(o.lastPage), ["2 shown (offset 4) of 6"], "no 'more' hint on the last page");
if (assertEq(o.resolve.code, 0, "resolve with a miss: exit 0")) {
  eqList(rows(o.resolve), [
    { notation: "25F23", text: "beasts of prey, predatory animals" },
    { notation: "25F23(+46)", text: "beasts of prey, predatory animals (+ sleeping animal(s))" },
  ], "--fields projects each row to exactly those keys");
  eqList(errLines(o.resolve), ["2 shown", "note: not found (1): NONEXISTENT"], "the miss is a note, not a row");
}
eqList(notations(o.keys)[0], "25F23(+0)", "keys rows are the key variants");
eqList(errLines(o.keys), ["5 shown (offset 0) of 30; pass --offset 5 for more"], "keys summary uses totalKeyVariants");
eqList(errLines(o.prefix), ["25 shown (offset 0) of 35; pass --offset 25 for more"], "prefix summary at the tool's default cap");
eqList(rows(o.browseKv), [{ notation: "25F23", totalKeyVariants: 30 }], "browse is one object");
eqList(errLines(o.browseKv), ["note: key variants 1–5 of 30; pass --keyOffset 5 for more"], "browse notes key variants beyond the page");
assertEq(o.browseEnd.stderr, "", "no key-variant note on the last page (25 + 5 = 30)");
eqList(rows(o.browse), [{ notation: "73D" }], "browse --fields");
assertEq(o.browse.stderr, "", "no notes when every child is shown");
eqList(errLines(o.browseCo), ["note: showing 4 direct children from positions 6–9 of 9"], "a --childOffset page names its range, with no 'more' at the end");
if (assertEq(o.artworks.code, 0, "artworks: exit 0")) {
  const [a73] = rows(o.artworks);
  eqList(a73.collections.map((c) => [c.collectionId, c.count, c.url]), [
    ["testmuseum", 500, "https://collection.example.org/search?iconclass=73D6"],
    ["rijksmuseum", 379, null],
  ], "artworks rows carry counts and link-outs");
  eqList(errLines(o.artworks), ["2 shown",
    "note: no label for 11H(FOO) — not in the local DB, or unlabelled in this --lang; check with `icmcp resolve`"],
  "an echoed code is a note");
}
if (assertEq(o.json.code, 0, "--json: exit 0")) {
  const j = JSON.parse(o.json.stdout);
  eqList(j.notFound, ["NONEXISTENT"], "--json is the whole structuredContent");
  assertEq(j.collections.length, 2, "--json keeps top-level keys the rows omit");
  assertEq(o.json.stderr, "", "--json prints no summary or notes");
}
assertEq(o.quiet.stderr, "", "--quiet silences summary and notes");
eqList(o.table.stdout.split("\n").slice(0, 3).map((l) => l.trimEnd()),
  ["notation   keyId", "---------  -----", "25F23(+0)  +0"], "--table: columns as wide as the widest cell");

// stdout purity + server stderr kept out, over every successful JSONL run so far
// (--json and --show-call pretty-print by design).
const ok = Object.values(o).filter((r) => r.code === 0 && !["--table", "--json"].some((f) => r.args.includes(f)));
assert(ok.length >= 10, `purity checks cover the successful runs (${ok.length})`);
assert(ok.every((r) => r.stdout.split("\n").filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } })),
  "every stdout line is JSON");
assert(ok.every((r) => !r.stderr.includes('"level"')), "no server log line reaches the CLI's stderr");

// ══════════════════════════════════════════════════════════════════
section("5. --stdin batching");

const many = Array.from({ length: 26 }, (_, i) => `X${i}`).join("\n");
const b = await runAll({
  resolve: { args: ["resolve", "--stdin", "--fields", "notation"], input: "25F23\n# comment\n\n  73D82  \nNONEXISTENT\n" },
  batch:   { args: ["resolve", "--stdin", "--show-call"], input: many },
  keys:    { args: ["keys", "--stdin", "-n", "1", "--fields", "notation"], input: "25F23\n73D\n" },
  fail:    { args: ["keys", "--stdin", "-n", "1", "--quiet"], input: "25F23(+46)\n25F23\n" },
});
if (assertEq(b.resolve.code, 0, "resolve --stdin: exit 0")) {
  eqList(notations(b.resolve), ["25F23", "73D82"], "comments and blanks skipped, lines trimmed");
  eqList(errLines(b.resolve), ["2 shown", "note: not found (1): NONEXISTENT"], "three codes went in one call");
}
const batches = b.batch.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l).arguments.notation.length);
eqList(batches, [25, 1], "resolve --stdin sends up to 25 codes per call");
eqList(notations(b.keys), ["25F23(+0)"], "keys --stdin: one call per line");
eqList(errLines(b.keys), ["1 shown (offset 0) of 30; pass --offset 1 for more", "0 shown (offset 0) of 0"], "one summary per call");
assertEq(b.fail.code, 1, "a failing line: exit 1");
eqList(errLines(b.fail), [
  '[25F23(+46)] "25F23(+46)" is a key-expanded notation — expand_keys requires a base notation (e.g. "25F23").',
  "1 of 2 call(s) failed",
], "the failing line is labelled, and the rest still run");
assertEq(notations(b.fail).length, 1, "the good line still printed");

// ══════════════════════════════════════════════════════════════════
section("6. errors exit 1, and the stdio server's exit");

// Counters are flushed only by the shutdown path, so the file exists only if the
// server exits through it when the CLI hangs up.
const STATS = path.join(os.tmpdir(), `icmcp-test-cli-${process.pid}-usage.json`);
const e = await runAll({
  tool:     { args: ["browse", "NONEXISTENT"] },
  allMiss:  { args: ["resolve", "NONEXISTENT"] },
  semantic: { args: ["semantic", "grief"] },
  dead:     { args: ["--http", DEAD, "resolve", "25F23"] },
  stats:    { args: ["resolve", "25F23", "--quiet"], env: { ...ENV, USAGE_STATS_PATH: STATS } },
});
assertEq(e.tool.code, 1, "tool error: exit 1");
assertEq(e.tool.stderr, 'Notation "NONEXISTENT" not found in Iconclass.\n', "tool error text on stderr");
assertEq(e.tool.stdout, "", "nothing on stdout");
assertEq(e.allMiss.code, 0, "resolve with no hits is not an error");
assertEq(e.allMiss.stderr, "0 shown\nnote: not found (1): NONEXISTENT\n", "resolve with no hits names the miss");
assertEq(e.semantic.code, 1, "semantic without embeddings: exit 1");
assertEq(e.semantic.stderr, "Semantic search requires embeddings and an embedding model (not available). Use query (keyword search) instead.\n",
  "semantic routes to the search tool's semanticQuery");
assertEq(e.dead.code, 1, "dead --http: exit 1");
assert(e.dead.stderr.startsWith("Connection failed:"), "dead --http says so");
if (assert(fs.existsSync(STATS), "stdio server flushes usage counters when the client hangs up")) {
  assertEq(JSON.parse(fs.readFileSync(STATS, "utf8")).tools.resolve?.calls, 1, "the flushed counters hold the call");
  fs.rmSync(STATS);
}

// ══════════════════════════════════════════════════════════════════
section("7. protocol eras and transports");

const p = await runAll({
  modern: { args: ["--protocol", "2026-07-28", "resolve", "73D82", "--fields", "notation"] },
  auto:   { args: ["--protocol=auto", "resolve", "73D82", "--fields", "notation"] },
});
for (const [era, r] of Object.entries(p)) {
  if (assertEq(r.code, 0, `stdio ${era}: exit 0 (${r.stderr.trim().slice(0, 120)})`)) {
    eqList(notations(r), ["73D82"], `stdio ${era}: result`);
  }
}
const http = await bootHttpServer({ port: process.env.TEST_CLI_PORT ?? "31341", env: ENV });
const VIA_HTTP = { ...ENV, ICMCP_HTTP: http.url };
const h = await runAll({
  legacy: { args: ["--http", http.url, "keys", "25F23", "-n", "1", "--fields", "notation"] },
  modern: { args: ["--http", http.url, "--protocol", "2026-07-28", "keys", "25F23", "-n", "1", "--fields", "notation"] },
  env:    { args: ["keys", "25F23", "-n", "1", "--fields", "notation"], env: VIA_HTTP },
});
for (const [name, r] of Object.entries(h)) {
  if (assertEq(r.code, 0, `http ${name}: exit 0 (${r.stderr.trim().slice(0, 120)})`)) {
    eqList(notations(r), ["25F23(+0)"], `http ${name}: result`);
  }
}
await http.stop();

// ══════════════════════════════════════════════════════════════════
section("8. live help, tools manifest and the documented examples");

const hl = await runAll({
  ...Object.fromEntries(VERBS.map((v) => [v, { args: [v, "--help"] }])),
  compact: { args: ["tools", "--compact"] },
  tools:   { args: ["tools"] },
});
assert(hl.browse.stdout.includes("Browse an Iconclass notation's hierarchy"), "verb help shows the live tool description");
assert(hl.browse.stdout.includes("--notation <string> (required)"), "verb help lists schema flags");
assert(hl.browse.stdout.includes("Aliases:  --max, -n  → maxKeyVariants"), "verb help names the --max target");
assert(hl.search.stdout.includes("--query <string> (required)"), "search help marks the positional as required");
assert(!hl.resolve.stdout.includes("Aliases:"), "no --max alias for resolve");
if (assertEq(hl.compact.code, 0, "tools --compact: exit 0")) {
  const m = JSON.parse(hl.compact.stdout);
  eqList(m.map((x) => x.verb), VERBS, "manifest lists every verb");
  assertEq(m.find((x) => x.verb === "resolve").positional, "notation...", "manifest marks multi positionals");
  assertEq(m.find((x) => x.verb === "semantic").args.semanticQuery, "string!", "semantic requires semanticQuery");
  assertEq(m.find((x) => x.verb === "browse").result, "single", "browse is a single object");
}
assertEq(hl.tools.stdout.split("\n")[2], "browse    browse", "tools table");

// Each example, word-split as a shell would, against the data it documents.
const shellWords = (cmd) => [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
const examples = {};
for (const v of VERBS) {
  const line = hl[v].stdout.split("\n").find((_, i, all) => all[i - 1] === "Example:");
  if (assert(line?.startsWith("  icmcp "), `${v} --help has an example`)) {
    examples[v] = { args: shellWords(line.trim()).slice(1) };
  }
}
const ex = await runAll(examples);
for (const [v, r] of Object.entries(ex)) {
  if (v === "semantic") {
    // The fixture has no embeddings; reaching the tool's own message proves the example parses.
    assert(r.stderr.startsWith("Semantic search requires embeddings"), "semantic example parses and reaches the tool");
  } else if (assertEq(r.code, 0, `${v} example runs (${r.stderr.trim().slice(0, 120)})`)) {
    assert(r.stdout.trim().length > 0, `${v} example prints a result`);
  }
}

// ══════════════════════════════════════════════════════════════════
section("environment and closed pipes");

// PORT is common in a shell env, and any value would put the stdio child in HTTP mode.
const withPort = await runCli(["resolve", "25F23", "--fields", "notation"], { env: { ...ENV, PORT: "3987" } });
if (assertEq(withPort.code, 0, `PORT in the env: resolve still answers on stdio (${withPort.stderr.trim().slice(0, 120)})`)) {
  eqList(notations(withPort), ["25F23"], "PORT in the env: the expected row");
}

// Like `icmcp … | head -1`: the reader goes away while more output is due.
const closedPipe = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "scripts", "cli.mjs"), "prefix", "--stdin", "--fields", "notation"],
    { cwd: PROJECT_ROOT, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.once("data", () => child.stdout.destroy());
  child.on("close", (code) => resolve({ code, stderr }));
  child.stdin.end("73D\n25F\n73D\n25F\n73D\n25F\n73D\n25F\n");
});
assertEq(closedPipe.code, 0, "closed stdout: exit 0, not a false failure");
assert(!/EPIPE|Unhandled|node:internal/.test(closedPipe.stderr), `closed stdout: no stack trace (${closedPipe.stderr.slice(0, 120)})`);

report();
