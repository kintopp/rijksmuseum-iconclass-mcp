#!/usr/bin/env node
/**
 * test-skill-bundle.mjs — the committed skill bundles match their source folder,
 * and SKILL.md's frontmatter conforms to the Agent Skills spec.
 *
 * Failure modes:
 *  - SKILL.md or a reference edited without `npm run build:skill`: stale bundle.
 *  - package.json bumped without a rebuild: stale metadata.version.
 *  - Builder emits consistent garbage: the bundles are parsed here independently.
 *  - Archive with loose files at its root, or macOS junk entries.
 *  - Top-level `version:`/`last_updated:`: only `metadata` may carry them, and the
 *    spec's validator rejects any other top-level key.
 *  - Skill folder renamed away from `name`, or a description over the 1024-char cap.
 *  - license or compatibility dropped. Their values are per-server choices, so only
 *    presence and the spec's length cap are checked.
 *  - SKILL.md hard-wraps a paragraph, which ChatGPT's skill page shows as broken lines.
 *  - plugin/rijksmuseum-iconclass/ goes stale: its skill copy differs from the source
 *    folder, or a manifest keeps an old version, so installed plugins never update.
 *  - A plugin MCP config points elsewhere, uses the other platform's transport name,
 *    carries a key the Agent Plugins schema rejects, or renames the connector (every
 *    user would have to reconnect).
 *  - The plugin gains a top-level bin/, which claude.ai refuses.
 *  - An upload zip is missing, stale, nests its files in a folder, or carries the
 *    other platform's manifest; ChatGPT's shortDescription runs over 57 characters.
 *  - A manifest loses the display name, or ChatGPT shows the skill as "Iconclass Mcp".
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_NAME = "iconclass-mcp";
const SKILL_DIR = join(ROOT, "skill", SKILL_NAME);
const SPEC_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Central directory first, as a real unzip reads it.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error("no end-of-central-directory record");
  const entries = new Map();
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at entry ${i}`);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

const rebuild = spawnSync(process.execPath, [join(ROOT, "scripts/build-skill.mjs"), "--check"], { encoding: "utf8" });
check("bundles and metadata.version are a rebuild of the source", rebuild.status === 0, rebuild.stderr.trim());

const bundleBytes = readFileSync(join(ROOT, "skill", `${SKILL_NAME}.skill`));
const bundle = readZip(bundleBytes);
check(".skill.zip is a byte-identical copy of the .skill", readFileSync(join(ROOT, "skill", `${SKILL_NAME}.skill.zip`)).equals(bundleBytes));

const names = [...bundle.keys()];
check("SKILL.md is the first entry, inside the skill folder", names[0] === `${SKILL_NAME}/SKILL.md`, names[0]);
check("every entry sits inside the skill folder", names.every((n) => n.startsWith(`${SKILL_NAME}/`)));
check("no macOS junk entries", !names.some((n) => /__MACOSX|\.DS_Store/.test(n)));

const sourceFiles = readdirSync(SKILL_DIR, { recursive: true })
  .map((rel) => String(rel).split(sep).join("/"))
  .filter((rel) => !rel.includes(".DS_Store") && statSync(join(SKILL_DIR, rel)).isFile());
check("bundle lists every source file", sourceFiles.length === names.length, `${sourceFiles.length} vs ${names.length}`);
for (const rel of sourceFiles) {
  check(`bundle matches ${rel}`, bundle.get(`${SKILL_NAME}/${rel}`)?.equals(readFileSync(join(SKILL_DIR, rel))));
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const bundledMd = bundle.get(`${SKILL_NAME}/SKILL.md`).toString("utf8");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(bundledMd)?.[1] ?? "";
const lines = frontmatter.split("\n");

const topLevel = lines.map((l) => /^([A-Za-z_-]+):/.exec(l)?.[1]).filter(Boolean);
const offSpec = topLevel.filter((key) => !SPEC_FIELDS.has(key));
check("top-level frontmatter keys are all in the spec", offSpec.length === 0, offSpec.join(", "));
check("name matches the parent folder", /^name: (\S+)$/m.exec(frontmatter)?.[1] === SKILL_NAME);

const descStart = lines.findIndex((l) => l.startsWith("description:"));
const descEnd = lines.findIndex((l, i) => i > descStart && /^\S/.test(l));
const description = lines.slice(descStart + 1, descEnd).map((l) => l.trim()).join(" ");
check(`description is 1-1024 characters (${description.length})`, description.length >= 1 && description.length <= 1024);

check("license is present", /^license: \S/m.test(frontmatter));
const compatibility = /^compatibility: (.+)$/m.exec(frontmatter)?.[1] ?? "";
check(`compatibility is 1-500 characters (${compatibility.length})`, compatibility.length >= 1 && compatibility.length <= 500);

const metaStart = lines.indexOf("metadata:");
const metaEnd = lines.findIndex((l, i) => i > metaStart && /^\S/.test(l));
const metadata = lines.slice(metaStart + 1, metaEnd === -1 ? undefined : metaEnd);
check("metadata values are quoted strings", metadata.length > 0 && metadata.every((l) => /^ {2}[a-z_]+: ".*"$/.test(l)), metadata.join(" | "));
check("metadata.version equals package.json", metadata.includes(`  version: "${pkg.version}"`), metadata.join(" | "));
check("metadata.last_updated is a date", metadata.some((l) => /^ {2}last_updated: "\d{4}-\d{2}-\d{2}"$/.test(l)));

// ChatGPT's skill page keeps line breaks inside a paragraph; Claude joins them.
const body = bundledMd.slice(bundledMd.indexOf("\n---\n", 4) + 5).replace(/^ *```[\s\S]*?^ *```$/gm, "");
// A line that opens no list item, table row, heading or quote must not follow another line.
const wrapped = body.split("\n").filter((line, i, all) =>
  i > 0 && all[i - 1].trim() !== "" && line.trim() !== "" && !/^\s*([-*+>] |#{1,6} |\||\d+\. )/.test(line));
check("each paragraph and list item of the skill body is one line", wrapped.length === 0, wrapped.map((l) => l.slice(0, 60)).join(" | "));

// --- plugin/rijksmuseum-iconclass/: what a marketplace installs on Claude and ChatGPT ---
// A git-subdir install sees only this folder, so the skill there is a real copy.
const PLUGIN = join(ROOT, "plugin", "rijksmuseum-iconclass");
const REBUILD = "run `npm run build:skill` and commit the result";
const readJson = (...p) => JSON.parse(readFileSync(join(PLUGIN, ...p), "utf8"));
function tree(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).split(sep).join("/"))
    .filter((rel) => !rel.split("/").some((seg) => seg.startsWith(".")) && statSync(join(dir, rel)).isFile())
    .sort()
    .map((rel) => [rel, readFileSync(join(dir, rel), "utf8")]);
}
const sourceTree = tree(SKILL_DIR);
check("source skill folder is non-empty", sourceTree.length > 0);
check("plugin carries an exact copy of the skill folder",
  JSON.stringify(tree(join(PLUGIN, "skills", SKILL_NAME))) === JSON.stringify(sourceTree), REBUILD);

const claudeManifest = readJson(".claude-plugin", "plugin.json");
const agentManifest = readJson("plugin.json");
for (const [label, m] of [["Claude", claudeManifest], ["Agent Plugins", agentManifest]]) {
  check(`${label} manifest is named rijksmuseum-iconclass`, m.name === "rijksmuseum-iconclass", m.name);
  check(`${label} manifest carries package.json's version`, m.version === pkg.version, `${m.version}: ${REBUILD}`);
}
check("Agent Plugins manifest declares its schema", agentManifest.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
check('Claude manifest shows "Rijksmuseum Iconclass"', claudeManifest.displayName === "Rijksmuseum Iconclass");
check('Agent Plugins manifest shows "Rijksmuseum Iconclass"',
  agentManifest.extensions?.["com.openai"]?.interface?.displayName === "Rijksmuseum Iconclass");

// The key is the connector's label on both platforms. Claude calls the transport "http",
// the Agent Plugins schema "streamable-http", and that schema allows no other server keys.
const url = "https://rijksmuseum-iconclass-mcp-production.up.railway.app/mcp";
check(".mcp.json serves the hosted server as Iconclass over http",
  JSON.stringify(readJson(".mcp.json")) === JSON.stringify({ mcpServers: { Iconclass: { type: "http", url } } }));
check("mcp.json serves the hosted server as Iconclass over streamable-http",
  JSON.stringify(readJson("mcp.json")) === JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { Iconclass: { type: "streamable-http", url } },
  }));
check("plugin has no top-level bin/, which claude.ai refuses", !existsSync(join(PLUGIN, "bin")));

// ChatGPT cuts the plugin's short description off after 57 characters.
const shortDescription = agentManifest.extensions?.["com.openai"]?.interface?.shortDescription ?? "";
check(`ChatGPT shortDescription is 1-57 characters (${[...shortDescription].length})`,
  [...shortDescription].length >= 1 && [...shortDescription].length <= 57);

// The upload zips: each holds exactly its platform's plugin files, at the root.
const skillPaths = sourceFiles.map((rel) => `skills/${SKILL_NAME}/${rel}`);
const uploads = {
  claude: [".claude-plugin/plugin.json", ".mcp.json", ...skillPaths.filter((p) => !p.includes("/agents/"))],
  chatgpt: ["plugin.json", "mcp.json", ...skillPaths],
};
for (const [platform, expected] of Object.entries(uploads)) {
  const zipPath = join(ROOT, "plugin", `rijksmuseum-iconclass-${platform}.zip`);
  const zip = existsSync(zipPath) ? readZip(readFileSync(zipPath)) : new Map();
  const zipNames = [...zip.keys()].sort();
  check(`${platform} zip holds exactly its platform's files`,
    JSON.stringify(zipNames) === JSON.stringify([...expected].sort()), `${zipNames.join(", ")}; ${REBUILD}`);
  check(`${platform} zip matches the plugin folder`,
    expected.every((n) => zip.get(n)?.equals(readFileSync(join(PLUGIN, n)))), REBUILD);
}

// ChatGPT otherwise title-cases the skill's name into "Iconclass Mcp".
const openaiYaml = readFileSync(join(SKILL_DIR, "agents", "openai.yaml"), "utf8");
check('agents/openai.yaml shows the skill as "Iconclass"', /^interface:\n {2}display_name: "Iconclass"$/m.test(openaiYaml));

if (failures > 0) {
  console.error(`skill-bundle: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("skill-bundle: all checks passed");
