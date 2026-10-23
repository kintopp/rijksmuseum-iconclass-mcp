/**
 * Manual probe companion to diff-heap-snapshots.mjs: for objects of a given
 * name that exist in B but not in A (node ids are stable across snapshots of
 * one process), print the shortest strong retaining path from the GC root.
 *
 * Run:  node --max-old-space-size=8192 scripts/tests/retainers-heap-snapshot.mjs A.heapsnapshot B.heapsnapshot <name> [--n 3]
 */
import { readFileSync } from "node:fs";

const [fa, fb, target] = process.argv.slice(2).filter((s) => !s.startsWith("--"));
const ni = process.argv.indexOf("--n");
const N = ni === -1 ? 3 : Number(process.argv[ni + 1]);

function load(file) {
  const snap = JSON.parse(readFileSync(file, "utf8"));
  const m = snap.snapshot.meta;
  return { snap, m, ns: m.node_fields.length, es: m.edge_fields.length };
}

const A = load(fa);
const iIdA = A.m.node_fields.indexOf("id");
const idsA = new Set();
for (let i = 0; i < A.snap.nodes.length; i += A.ns) idsA.add(A.snap.nodes[i + iIdA]);
A.snap = null;

const { snap, m, ns, es } = load(fb);
const { nodes, edges, strings } = snap;
const nf = m.node_fields, ef = m.edge_fields;
const iType = nf.indexOf("type"), iName = nf.indexOf("name"), iId = nf.indexOf("id"), iEc = nf.indexOf("edge_count");
const eType = ef.indexOf("type"), eName = ef.indexOf("name_or_index"), eTo = ef.indexOf("to_node");
const nodeTypes = m.node_types[iType], edgeTypes = m.edge_types[eType];
const count = nodes.length / ns;

const firstEdge = new Uint32Array(count + 1);
for (let n = 0, e = 0; n < count; n++) { firstEdge[n] = e; e += nodes[n * ns + iEc] * es; }
firstEdge[count] = edges.length;

const label = (n) => {
  const t = nodeTypes[nodes[n * ns + iType]];
  return `${t}:${strings[nodes[n * ns + iName]].slice(0, 60)}`;
};
const edgeLabel = (e) => {
  const t = edgeTypes[edges[e + eType]];
  const v = edges[e + eName];
  return t === "element" || t === "hidden" ? `[${v}]` : `.${strings[v]}`;
};

// BFS from the root over strong edges; parent pointers give shortest paths.
const parent = new Int32Array(count).fill(-1);
const viaEdge = new Int32Array(count).fill(-1);
parent[0] = 0;
const queue = new Uint32Array(count);
let head = 0, tail = 0;
queue[tail++] = 0;
while (head < tail) {
  const n = queue[head++];
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += es) {
    if (edgeTypes[edges[e + eType]] === "weak") continue;
    const to = edges[e + eTo] / ns;
    if (parent[to] !== -1) continue;
    parent[to] = n; viaEdge[to] = e;
    queue[tail++] = to;
  }
}

let shown = 0;
for (let n = 0; n < count && shown < N; n++) {
  if (strings[nodes[n * ns + iName]] !== target || idsA.has(nodes[n * ns + iId]) || parent[n] === -1) continue;
  const path = [];
  for (let c = n; c !== 0; c = parent[c]) path.push(`${edgeLabel(viaEdge[c])} → ${label(c)}`);
  console.log(`\n#${++shown} ${label(n)} @${nodes[n * ns + iId]}`);
  for (const step of path.reverse()) console.log(`  ${step}`);
}
if (shown === 0) console.log(`no new reachable '${target}' objects in B`);
