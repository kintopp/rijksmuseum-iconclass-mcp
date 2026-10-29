#!/usr/bin/env node
/**
 * icmcp — headless CLI over the Iconclass MCP server's tools.
 *
 * An MCP *client*: it drives the real server, so a CLI query and an LLM query
 * make the same callTool() and get the same result. There is no second
 * implementation of any lookup logic here.
 *
 * Transport (one connect() seam, two backends):
 *   --http <url>   Streamable HTTP against a running server (`npm run serve`, Railway).
 *   (default)      stdio: spawns `node dist/index.js` — needs `npm run build` + DBs in data/.
 *   --protocol <legacy|auto|2026-07-28>   protocol era (default legacy).
 *
 * Output is JSON-first for pipes and agents:
 *   default   list commands → JSONL on stdout; browse → one compact JSON object.
 *   --json    the whole structuredContent, pretty-printed.
 *   --table   terse human table.
 *   --fields  a,b,c   top-level key projection per row.
 *   --stdin   batch: read the positional from stdin, one per line.
 *   Counts, paging hints and `note:` caveats go to STDERR, so stdout stays pure JSONL.
 *
 * Exit codes:  0 ok · 1 tool/connection error · 2 usage error.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const PROTOCOLS = ["legacy", "auto", "2026-07-28"];

// Bad input the user can fix → exit 2, not 1.
class UsageError extends Error {}

const errMsg = (err) => err?.message ?? String(err);

// Mirrors of server limits the tool schemas don't expose: TOOL_LIMITS.semanticDepth
// and IconclassDb.MAX_CHILDREN_PER_PARENT. Change them together.
const SEMANTIC_DEPTH = 500;
const CHILDREN_PER_PAGE = 25;

// ── Verb → tool table (presentation metadata only; schemas come from listTools) ──
// `pos`      = the input param the positional maps to.
// `multi`    = every positional goes into `pos` as an array; --stdin batches lines.
// `required` = the verb needs `pos` even though the schema marks it optional.
// `list`     = structuredContent key holding the result rows; absent → single object.
// `total`    = key holding the full count for the paging summary (null: none exists).
// `cap`      = the schema param that --max/-n maps to.
// `page`     = the offset param, for the "pass --offset N for more" hint.
const VERBS = {
  search:   { tool: "search",        pos: "query",         required: true, list: "results",     total: "totalResults",     cap: "maxResults",     page: "offset" },
  semantic: { tool: "search",        pos: "semanticQuery", required: true, list: "results",     total: null,               cap: "maxResults",     page: "offset" },
  browse:   { tool: "browse",        pos: "notation",                                                                     cap: "maxKeyVariants" },
  resolve:  { tool: "resolve",       pos: "notation",      multi: true,    list: "notations" },
  keys:     { tool: "expand_keys",   pos: "notation",                      list: "keyVariants", total: "totalKeyVariants", cap: "maxResults",     page: "offset" },
  prefix:   { tool: "search_prefix", pos: "notation",                      list: "results",     total: "totalResults",     cap: "maxResults",     page: "offset" },
  artworks: { tool: "find_artworks", pos: "notation",      multi: true,    list: "notations" },
};

// The one piece of hand-written copy per verb: everything else in --help is read
// live from the tool. Every notation here is in the test fixture, and the suite
// runs each example, so they can't go stale silently.
const VERB_EXAMPLE = {
  search:   `icmcp search "crucifixion" --max 5 --fields notation,text`,
  semantic: `icmcp semantic "grief and mourning" --max 5 --fields notation,text,similarity`,
  browse:   `icmcp browse 73D8 --depth 2 --fields notation,subtree`,
  resolve:  `icmcp resolve 25F23 "25F23(+46)" 73D82 --fields notation,text`,
  keys:     `icmcp keys 25F23 --max 5 --fields notation,keyId,text`,
  prefix:   `icmcp prefix 73D8 --table`,
  artworks: `icmcp artworks 73D6 "73D82(CROSS)" --fields notation,collections`,
};

// Global flags, consumed by the CLI and never forwarded as tool args. `--compact`
// is not here: it only means something to `tools`, which reads argv directly.
const GLOBAL_BOOL = new Set(["json", "table", "quiet", "show-call", "help", "stdin"]);
const GLOBAL_VALUE = new Set(["http", "protocol", "fields"]);
// `max` is resolved per verb to cfg.cap in buildToolArgs.
const FLAG_ALIASES = { n: "max", h: "help" };
// Value-taking flags to skip, with their value, while pre-scanning for the verb.
const PRESCAN_VALUE = new Set([...GLOBAL_VALUE, "max"]);

// The commonest flag slip is punctuation or case, not spelling: `--parent-notation`.
function nearestFlag(key, candidates) {
  const squash = (s) => s.replace(/[-_]/g, "").toLowerCase();
  return [...candidates].find((c) => c !== key && squash(c) === squash(key)) || null;
}

// One message for "that flag doesn't exist", whether the tokenizer (`--typo` with
// no value) or validateToolArgs (`--typo value`) catches it.
function unknownFlagError(key, { verb, candidates, list }) {
  const near = nearestFlag(key, candidates);
  return new UsageError(
    `--${key} is not a flag${verb ? ` for "${verb}"` : ""}.`
    + `${near ? ` Did you mean --${near}?` : ""}`
    + `${list ? ` Tool flags: ${list}` : ""}`
    + `${verb ? ` (see \`icmcp ${verb} --help\`)` : ""}`,
  );
}

const isFlagLike = (t) => t.startsWith("--")
  || (t.startsWith("-") && t.length === 2 && /[a-z]/i.test(t[1]));

// Must return a real boolean: the globals are read with `=== true`.
function boolFlagValue(key, val, next) {
  if (val === undefined) {
    if (next === "true" || next === "false") {
      throw new UsageError(
        `--${key} is a boolean flag and takes no separate value — write --${key} for true, `
        + `or --${key}=${next} to be explicit`,
      );
    }
    return true;
  }
  const v = String(val).toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new UsageError(`--${key} is a boolean flag — write --${key}=true or --${key}=false (got "${val}")`);
}

// `boolSet` = flags that take no value; `known` = every key the tokenizer should
// recognise, used only to tell a typo from a flag whose value went missing.
function flagSetsFor(schema, cfg) {
  const props = schema?.properties ?? {};
  const boolSet = new Set(GLOBAL_BOOL);
  const known = new Set([...GLOBAL_BOOL, ...GLOBAL_VALUE, ...Object.keys(props)]);
  for (const [name, prop] of Object.entries(props)) {
    if (propType(prop) === "boolean") boolSet.add(name);
  }
  if (cfg?.cap) known.add("max");
  return { boolSet, known };
}

// ── Tiny arg tokenizer ────────────────────────────────────────────────────────
// Which flags are boolean is only known after listTools(), so parseArgs can't be
// used: a flag is boolean if it's in `boolSet`, otherwise it takes the next token.
function tokenize(args, boolSet, { known, verb } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { positionals.push(...args.slice(i + 1)); break; }
    if (!isFlagLike(a)) {
      positionals.push(a);
      continue;
    }
    const dashless = a.replace(/^--?/, "");
    const eq = dashless.indexOf("=");
    let key = eq === -1 ? dashless : dashless.slice(0, eq);
    let val = eq === -1 ? undefined : dashless.slice(eq + 1);
    key = FLAG_ALIASES[key] || key;
    const isBool = boolSet.has(key);
    if (isBool) {
      val = boolFlagValue(key, val, args[i + 1]);
    } else if (val === undefined) {
      const next = args[i + 1];
      // `--key=value` is the escape hatch for a value that starts with a dash.
      if (next === undefined || isFlagLike(next)) {
        if (known && !known.has(key)) throw unknownFlagError(key, { verb, candidates: known });
        throw new UsageError(`--${key} requires a value (use --${key}=<value> if the value starts with a dash)`);
      }
      val = next;
      i++;
    }
    // Repeats collect into an array, except booleans (last wins): `[true, true]`
    // would fail every `=== true` read.
    if (key in flags && !isBool) flags[key] = [].concat(flags[key], val);
    else flags[key] = val;
  }
  return { flags, positionals };
}

// ── JSON Schema → arg classification ────────────────────────────────────────────
function propType(prop) {
  if (!prop || typeof prop !== "object") return "string";
  if (prop.type === "array") return "array";
  if (prop.type === "integer" || prop.type === "number") return "number";
  if (prop.type === "boolean") return "boolean";
  // resolve/find_artworks.notation is string | string[]
  if (Array.isArray(prop.anyOf) && prop.anyOf.some((b) => b?.type === "array")) return "array";
  return "string";
}

// The array branch's maxItems for a string | string[] param (25 for resolve).
function maxItemsOf(prop) {
  const branch = prop?.type === "array" ? prop : prop?.anyOf?.find((b) => b?.type === "array");
  return typeof branch?.maxItems === "number" ? branch.maxItems : Infinity;
}

function coerce(value, type, name) {
  if (type === "number") {
    // NaN would reach the wire as null; reject it here with an actionable message.
    const arr = [].concat(value).map((v) => {
      const n = v === "" ? NaN : Number(v);
      if (Number.isNaN(n)) throw new UsageError(`--${name} expects a number, got "${v}"`);
      return n;
    });
    return arr.length === 1 ? arr[0] : arr;
  }
  if (type === "array") return [].concat(value);
  return value;
}

function buildToolArgs(verb, cfg, schema, flags, positionals) {
  const props = schema?.properties ?? {};
  const args = {};
  for (const [key, raw] of Object.entries(flags)) {
    if (GLOBAL_BOOL.has(key) || GLOBAL_VALUE.has(key)) continue;
    let name = key;
    if (key === "max") {
      if (!cfg.cap) throw new UsageError(`--max/-n is not a flag for "${verb}" — see \`icmcp ${verb} --help\``);
      name = cfg.cap;
    }
    args[name] = coerce(raw, propType(props[name]), name);
  }
  // Empty positionals never go on the wire: required params get the CLI's own
  // "requires <pos>" error instead of a schema error about "".
  const given = positionals.filter((p) => p !== "");
  if (cfg.multi) {
    if (given.length) {
      if (args[cfg.pos] !== undefined) {
        throw new UsageError(`pass <${cfg.pos}> as positionals or as --${cfg.pos}, not both`);
      }
      args[cfg.pos] = given;
    }
    return args;
  }
  let consumed = 0;
  if (given.length && args[cfg.pos] === undefined) {
    args[cfg.pos] = coerce(given[0], propType(props[cfg.pos]), cfg.pos);
    consumed = 1;
  }
  const extra = given.slice(consumed);
  if (extra.length) {
    const shown = extra.map((e) => `"${e}"`).join(", ");
    throw new UsageError(
      `unexpected extra argument(s): ${shown} — "${verb}" takes a single <${cfg.pos}> positional; `
      + `quote a multi-word query, and pass other values as flags (see \`icmcp ${verb} --help\`)`,
    );
  }
  return args;
}

// The schema's required params, plus the positional for a verb that needs it.
function requiredOf(schema, cfg) {
  const required = new Set(schema?.required ?? []);
  if (cfg.required) required.add(cfg.pos);
  return required;
}

// Checked before anything is printed or sent, so --show-call never shows a call
// the server's strict schema would reject.
function validateToolArgs(verb, cfg, schema, args) {
  const props = schema?.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!(key in props)) {
      throw unknownFlagError(key, {
        verb,
        candidates: Object.keys(props),
        list: Object.keys(props).map((p) => `--${p}`).join(", "),
      });
    }
  }
  if (cfg.multi && Array.isArray(args[cfg.pos])) {
    const max = maxItemsOf(props[cfg.pos]);
    if (args[cfg.pos].length > max) {
      throw new UsageError(
        `"${verb}" takes at most ${max} <${cfg.pos}> values per call (got ${args[cfg.pos].length}) — `
        + `pipe them through --stdin to batch`,
      );
    }
  }
  for (const req of requiredOf(schema, cfg)) {
    if (args[req] === undefined) {
      throw new UsageError(`"${verb}" requires <${req}> (positional or --${req}) — see \`icmcp ${verb} --help\``);
    }
  }
}

// ── Transport / connection ───────────────────────────────────────────────────
async function connect(httpUrl, protocol) {
  // Imported here so help and usage errors, which never connect, don't load the SDK.
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const serverErr = [];
  let transport;
  if (httpUrl) {
    transport = new StreamableHTTPClientTransport(new URL(httpUrl));
  } else {
    const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      cwd: PROJECT_ROOT,
      // The whole env, so ICONCLASS_DB_PATH etc. reach the server (the transport
      // otherwise passes only a safe allowlist). Skipping the startup warm-up
      // saves ~1.6 s per call; a semantic query still waits for the model.
      env: { ...process.env, STRUCTURED_CONTENT: "true", MCP_SKIP_STARTUP_WARM: "1" },
      // Kept out of our stderr, which carries the counts and notes; shown only if
      // the connection fails, where it holds the real diagnosis.
      stderr: "pipe",
    });
  }
  const onServerErr = (c) => serverErr.push(c.toString());
  transport.stderr?.on("data", onServerErr);
  const versionNegotiation =
    protocol === "auto" ? { mode: "auto" } : protocol === "2026-07-28" ? { mode: { pin: "2026-07-28" } } : undefined;
  const client = new Client(
    { name: "icmcp", version: "0.1" },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
  try {
    await client.connect(transport);
  } catch (err) {
    const tail = serverErr.join("").trim();
    throw new Error(tail ? `${errMsg(err)}\n${tail}` : errMsg(err), { cause: err });
  }
  transport.stderr?.off("data", onServerErr);
  return client;
}

// ── Result helpers ─────────────────────────────────────────────────────────────
const textOf = (res) => (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

function parseFields(f) {
  return f ? String(f).split(",").map((s) => s.trim()).filter(Boolean) : null;
}

function project(obj, fields) {
  if (!fields || !obj || typeof obj !== "object") return obj;
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

function renderTable(rows, fields) {
  if (!rows.length) return "(no results)";
  const cols = (fields && fields.length ? fields : Object.keys(rows[0]).filter((k) => {
    const v = rows[0][k];
    return v == null || typeof v !== "object";
  })).slice(0, 6);
  const cell = (v) => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const fmt = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join("  ").trimEnd();
  const lines = [fmt(cols), fmt(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) lines.push(fmt(cols.map((c) => cell(r[c]))));
  return lines.join("\n");
}

function paginationSummary(cfg, data, list, args) {
  const offset = Number(args?.[cfg.page] ?? 0) || 0;
  const total = cfg.total ? data[cfg.total] : undefined;
  if (!cfg.page) return `${list.length} shown`;
  if (typeof total === "number") {
    const s = `${list.length} shown (offset ${offset}) of ${total}`;
    return offset + list.length < total ? `${s}; pass --offset ${offset + list.length} for more` : s;
  }
  // No corpus total (semantic): a full page may have more behind it, up to
  // the server's semantic depth cap (offset + maxResults ≤ 500).
  const s = `${list.length} shown (offset ${offset})`;
  const cap = args?.[cfg.cap];
  const next = offset + list.length;
  if (typeof cap !== "number" || list.length !== cap || next >= SEMANTIC_DEPTH) return s;
  return next + cap <= SEMANTIC_DEPTH
    ? `${s}; pass --offset ${next} for more`
    : `${s}; pass --offset ${next} --max ${SEMANTIC_DEPTH - next} for more`;
}

// Caveats the tools state only in their text channel, which JSONL replaces —
// without them a capped or partial result reads as a complete one.
function resultNotes(verb, data, args) {
  const notes = [];
  if (Array.isArray(data.notFound) && data.notFound.length) {
    notes.push(`not found (${data.notFound.length}): ${data.notFound.join(", ")}`);
  }
  if (verb === "artworks") {
    // find_artworks echoes the code as the label rather than rejecting it.
    const bare = (data.notations ?? []).filter((n) => n.text === n.notation).map((n) => n.notation);
    if (bare.length) {
      notes.push(`no label for ${bare.join(", ")} — not in the local DB, or unlabelled in this --lang; `
        + "check with `icmcp resolve`");
    }
  }
  if (verb === "prefix" && data.totalResults > 200) {
    notes.push(`large subtree (${data.totalResults} notations) — `
      + (args?.baseOnly ? "" : "--baseOnly skips key variants; ") + "a longer prefix narrows it faster than paging");
  }
  if (verb === "browse") {
    const top = (data.subtree ?? []).filter((c) => c.depth === 1);
    const children = data.entry?.children ?? [];
    const childOffset = Number(args?.childOffset ?? 0) || 0;
    // Positions, not rows: a dangling child link resolves to nothing. Mirrors browse's text output.
    const next = data.subtreeCapped && top.length
      ? children.indexOf(top[top.length - 1].notation, childOffset) + 1
      : Math.min(children.length, childOffset + CHILDREN_PER_PAGE);
    if (childOffset > 0 || next < children.length) {
      notes.push(`showing ${top.length} direct children from positions ${childOffset + 1}–${next} of ${children.length}`
        + (next < children.length ? `; pass --childOffset ${next} for more` : ""));
    }
    const cut = (data.subtree ?? []).filter((c) => c.truncated);
    if (cut.length) {
      notes.push(`children capped for ${cut.map((c) => `${c.notation} (${c.totalChildren})`).join(", ")} — browse that notation`);
    }
    if (data.subtreeCapped) {
      notes.push(`subtree capped at ${(data.subtree ?? []).length} entries — browse a child notation or lower --depth`);
    }
    const kv = data.keyVariants?.length ?? 0;
    const offset = Number(args?.keyOffset ?? 0) || 0;
    if (data.totalKeyVariants > offset + kv) {
      notes.push(`key variants ${offset + 1}–${offset + kv} of ${data.totalKeyVariants}; pass --keyOffset ${offset + kv} for more`);
    }
  }
  return notes;
}

function renderResult(res, verb, cfg, flags, args) {
  const fields = parseFields(flags.fields);
  const data = res.structuredContent;
  const quiet = flags.quiet === true;

  if (!data || typeof data !== "object") {
    // No structuredContent (STRUCTURED_CONTENT=false on an --http server).
    process.stdout.write(textOf(res) + "\n");
    return;
  }
  // Nothing is elided, hence no notes: they only compensate for what the
  // projected views drop.
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  const emitNotes = () => {
    if (quiet) return;
    for (const note of resultNotes(verb, data, args)) process.stderr.write(`note: ${note}\n`);
  };
  if (!cfg.list) {
    if (flags.table === true) process.stdout.write(renderTable([data], fields) + "\n");
    else process.stdout.write(JSON.stringify(project(data, fields)) + "\n");
    emitNotes();
    return;
  }
  const list = Array.isArray(data[cfg.list]) ? data[cfg.list] : [];
  if (flags.table === true) {
    process.stdout.write(renderTable(list, fields) + "\n");
  } else {
    for (const row of list) process.stdout.write(JSON.stringify(project(row, fields)) + "\n");
  }
  if (!quiet) process.stderr.write(paginationSummary(cfg, data, list, args) + "\n");
  emitNotes();
}

// Trimmed lines, with blanks and `#` comments dropped.
async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// ── Help / discovery ─────────────────────────────────────────────────────────
// Static: renders without connecting, so it works with no build, no DBs and a
// stale ICMCP_HTTP.
function topUsage() {
  const capMap = Object.entries(VERBS).filter(([, c]) => c.cap).map(([v, c]) => `${c.cap} (${v})`).join(" · ");
  const lines = [
    "icmcp — headless CLI over the Iconclass MCP tools",
    "",
    "Usage: icmcp [--http <url>] [--protocol <era>] <command> [args] [flags]",
    "       icmcp tools [--compact|--json]   list tool capabilities (compact = agent bootstrap)",
    "       icmcp <command> --help           full description, flags + an example for one command",
    "",
    "Commands:",
  ];
  for (const [verb, cfg] of Object.entries(VERBS)) {
    const arg = cfg.multi ? `<${cfg.pos}...>` : `<${cfg.pos}>`;
    lines.push(`  ${verb.padEnd(9)} ${arg.padEnd(16)} → ${cfg.tool}`);
  }
  lines.push(
    "",
    "Common flags:",
    "  --fields a,b,c   project every row to these top-level keys (biggest token saver)",
    `  --max N  (-n)    result cap → ${capMap}`,
    "  --json           full structuredContent payload, pretty-printed",
    "  --table          terse human-readable table",
    "  --quiet          suppress the stderr summary and note lines",
    "  --show-call      print the resolved {tool, arguments} WITHOUT executing (cheap dry-run)",
    "  --stdin          batch: read the positional from stdin, one per line (one connection;",
    "                   resolve/artworks send up to 25 lines per call)",
    "",
    "Transports:",
    "  --http <url>      a running server (`npm run serve`, or Railway); env: ICMCP_HTTP",
    "  (default)         stdio — spawns `node dist/index.js`; needs `npm run build` + DBs in data/",
    `  --protocol <era>  ${PROTOCOLS.join(" | ")} (default legacy)`,
    "",
    "Output:  list commands → JSONL · browse → one compact JSON · counts + notes → stderr.",
    "Exit:    0 ok · 1 tool/connection error · 2 usage error",
  );
  return lines.join("\n");
}

// First line of a description, cut on a word boundary.
function clip(text, n) {
  const s = (text ?? "").split("\n")[0];
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut) + "…";
}

function enumValues(prop) {
  const vals = Array.isArray(prop?.enum) ? prop.enum
    : Array.isArray(prop?.items?.enum) ? prop.items.enum
      : null;
  if (!vals || !vals.length) return null;
  const joined = vals.map(String).join("|");
  return joined.length <= 60 ? `{${joined}}` : `{${vals.length} values — see \`tools --json\`}`;
}

// With `tool` (server reachable): its live description and flags. Without: the
// header, the example and a hint.
function verbHelp(verb, cfg, tool) {
  const lines = [`${verb} → ${cfg.tool}`, ""];
  if (tool?.description) lines.push(tool.description, "");
  lines.push(cfg.multi
    ? `Positionals: <${cfg.pos}...>  (all positionals map to --${cfg.pos})`
    : `Positional: <${cfg.pos}>  (maps to --${cfg.pos})`, "");
  if (tool) {
    const props = tool.inputSchema?.properties ?? {};
    const required = requiredOf(tool.inputSchema, cfg);
    lines.push("Flags:");
    for (const [name, prop] of Object.entries(props)) {
      const req = required.has(name) ? " (required)" : "";
      const enums = enumValues(prop);
      lines.push(`  --${name} <${propType(prop)}>${req}  ${clip(prop?.description, 90)}${enums ? "  " + enums : ""}`);
    }
    if (cfg.cap) lines.push("", `Aliases:  --max, -n  → ${cfg.cap}`);
  }
  lines.push("", "Example:", "  " + VERB_EXAMPLE[verb]);
  if (!tool) lines.push(
    "",
    "(The description and flag list are read live from the server, which was not reachable.",
    " Run `npm run build` with the DBs in data/, or pass --http <url>.)",
  );
  return lines.join("\n");
}

function toolsHelp() {
  return [
    "tools — list the commands' tool capabilities (introspection; not a tool call)",
    "",
    "Usage: icmcp tools [--compact|--json]",
    "",
    "  (default)   verb → tool-name table",
    "  --compact   compact manifest for agent bootstrap: verb, tool, positional, result",
    "              shape, paging, args as name→type (`!` = required)",
    "  --json      full input + output JSON Schema per verb",
    "",
    "All three read the live schema, so they need a server: --http <url>, or dist/ + DBs.",
  ].join("\n");
}

function toolsDump(toolMap, asJson) {
  const rows = Object.entries(VERBS).map(([verb, cfg]) => {
    const t = toolMap.get(cfg.tool);
    return { verb, name: cfg.tool, description: t?.description, inputSchema: t?.inputSchema, outputSchema: t?.outputSchema };
  });
  if (asJson) return JSON.stringify(rows, null, 2);
  return rows.map((r) => `${r.verb.padEnd(9)} ${r.name}`).join("\n");
}

function toolsCompact(toolMap) {
  return Object.entries(VERBS).map(([verb, cfg]) => {
    const schema = toolMap.get(cfg.tool)?.inputSchema;
    const required = requiredOf(schema, cfg);
    const args = {};
    for (const [k, prop] of Object.entries(schema?.properties ?? {})) {
      args[k] = propType(prop) + (required.has(k) ? "!" : "");
    }
    const entry = { verb, tool: cfg.tool, positional: cfg.multi ? `${cfg.pos}...` : cfg.pos, result: cfg.list ?? "single", args };
    if (cfg.page) entry.page = cfg.page;
    return entry;
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  // Pre-scan for the transport and the verb (the first bare token), skipping the
  // value of each value-taking global so it isn't mistaken for the verb.
  let httpUrl = process.env.ICMCP_HTTP || null;
  let protocol = "legacy";
  let verb;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      if (verb === undefined) verb = a;
      continue;
    }
    const bare = a.replace(/^--?/, "").split("=")[0];
    const key = FLAG_ALIASES[bare] ?? bare;
    const inline = a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined;
    const value = inline ?? argv[i + 1];
    if (key === "http") httpUrl = value;
    if (key === "protocol") protocol = value;
    if (PRESCAN_VALUE.has(key) && inline === undefined) i++;
    if (a === "--") break;
  }

  const wantsHelp = argv.includes("--help") || argv.includes("-h") || verb === "help" || argv.length === 0;
  if (wantsHelp && (verb === "help" || verb === undefined)) {
    process.stdout.write(topUsage() + "\n");
    return;
  }
  if (wantsHelp && verb === "tools") {
    process.stdout.write(toolsHelp() + "\n");
    return;
  }
  const cfg = VERBS[verb];
  if (!cfg && verb !== "tools") {
    process.stderr.write(`Unknown command: ${verb ?? "(none)"}\n\n${topUsage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (!PROTOCOLS.includes(protocol)) {
    process.stderr.write(`--protocol must be one of ${PROTOCOLS.join(", ")} (got "${protocol}")\n`);
    process.exitCode = 2;
    return;
  }
  const isVerbHelp = wantsHelp && !!cfg;

  let client;
  try {
    client = await connect(httpUrl, protocol);
  } catch (err) {
    if (isVerbHelp) {
      process.stdout.write(verbHelp(verb, cfg, null) + "\n");
      return;
    }
    process.stderr.write(`Connection failed: ${errMsg(err)}\n`);
    if (!httpUrl) process.stderr.write("Hint: run `npm run build` and check the DBs in data/, or pass --http <url>.\n");
    process.exitCode = 1;
    return;
  }

  // A signal would skip the `finally` and orphan the spawned server, which holds
  // the 3.2 GB DB mmap; close first, then exit 128+signal.
  const onSignal = (code) => {
    client.close().catch(() => {}).finally(() => process.exit(code));
  };
  process.on("SIGINT", () => onSignal(130));
  process.on("SIGTERM", () => onSignal(143));

  try {
    const listed = await client.listTools();
    const toolMap = new Map(listed.tools.map((t) => [t.name, t]));

    if (verb === "tools") {
      if (argv.includes("--compact")) process.stdout.write(JSON.stringify(toolsCompact(toolMap), null, 2) + "\n");
      else process.stdout.write(toolsDump(toolMap, argv.includes("--json")) + "\n");
      return;
    }

    const tool = toolMap.get(cfg.tool);
    if (!tool) {
      process.stderr.write(`Tool ${cfg.tool} is not available on this server.\n`);
      process.exitCode = 1;
      return;
    }
    if (isVerbHelp) {
      process.stdout.write(verbHelp(verb, cfg, tool) + "\n");
      return;
    }

    const { boolSet, known } = flagSetsFor(tool.inputSchema, cfg);
    const { flags, positionals } = tokenize(argv, boolSet, { known, verb });
    const rest = positionals[0] === verb ? positionals.slice(1) : positionals;

    const call = async (toolArgs, label) => {
      if (flags["show-call"] === true) {
        process.stdout.write(JSON.stringify({ tool: cfg.tool, arguments: toolArgs }, null, label ? 0 : 2) + "\n");
        return true;
      }
      const res = await client.callTool({ name: cfg.tool, arguments: toolArgs });
      if (res.isError) {
        process.stderr.write(`${label ? `[${label}] ` : ""}${textOf(res)}\n`);
        return false;
      }
      renderResult(res, verb, cfg, flags, toolArgs);
      return true;
    };

    if (flags.stdin === true) {
      const stray = rest.filter((p) => p !== "");
      if (stray.length) {
        throw new UsageError(
          `unexpected extra argument(s): ${stray.map((e) => `"${e}"`).join(", ")} — with --stdin the `
          + `<${cfg.pos}> is read from stdin, one per line`,
        );
      }
      if (process.stdin.isTTY) {
        throw new UsageError(`--stdin set but stdin is a TTY — pipe input (e.g. \`printf '25F23\\n73D82\\n' | icmcp ${verb} --stdin\`)`);
      }
      const lines = await readStdinLines();
      const baseArgs = buildToolArgs(verb, cfg, tool.inputSchema, flags, []);
      if (baseArgs[cfg.pos] !== undefined) {
        throw new UsageError(`with --stdin the <${cfg.pos}> comes from stdin — drop --${cfg.pos}`);
      }
      // Once for every batch: they differ only in the positional, which is never
      // empty and never over maxItems. "" stands in for it.
      validateToolArgs(verb, cfg, tool.inputSchema, { ...baseArgs, [cfg.pos]: "" });
      const posProp = tool.inputSchema?.properties?.[cfg.pos];
      const size = cfg.multi ? maxItemsOf(posProp) : 1;
      const batches = [];
      for (let i = 0; i < lines.length; i += size) batches.push(lines.slice(i, i + size));
      let failures = 0;
      for (const batch of batches) {
        const value = cfg.multi ? batch : coerce(batch[0], propType(posProp), cfg.pos);
        const toolArgs = { ...baseArgs, [cfg.pos]: value };
        const label = batch.length === 1 ? batch[0] : `${batch[0]} … ${batch[batch.length - 1]}`;
        try {
          if (!(await call(toolArgs, label))) failures++;
        } catch (err) {
          process.stderr.write(`[${label}] Error: ${errMsg(err)}\n`);
          failures++;
        }
      }
      if (failures) {
        process.stderr.write(`${failures} of ${batches.length} call(s) failed\n`);
        process.exitCode = 1;
      }
      return;
    }

    const toolArgs = buildToolArgs(verb, cfg, tool.inputSchema, flags, rest);
    validateToolArgs(verb, cfg, tool.inputSchema, toolArgs);
    if (!(await call(toolArgs, null))) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main();
