/**
 * Manual probe companion to probe-heap-growth.mjs: per-constructor object
 * count and self size in two .heapsnapshot files, largest growth first.
 *
 * Run:  node --max-old-space-size=8192 scripts/tests/diff-heap-snapshots.mjs A.heapsnapshot B.heapsnapshot [--top 25]
 */
import { readFileSync } from "node:fs";

function summarize(file) {
  const snap = JSON.parse(readFileSync(file, "utf8"));
  const { node_fields, node_types } = snap.snapshot.meta;
  const stride = node_fields.length;
  const iType = node_fields.indexOf("type"), iName = node_fields.indexOf("name"), iSize = node_fields.indexOf("self_size");
  const types = node_types[iType];
  const byKey = new Map();
  let total = 0;
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = types[snap.nodes[i + iType]];
    const name = type === "object" || type === "closure" ? snap.strings[snap.nodes[i + iName]] : `(${type})`;
    const size = snap.nodes[i + iSize];
    total += size;
    const e = byKey.get(name) ?? { count: 0, size: 0 };
    e.count++; e.size += size;
    byKey.set(name, e);
  }
  return { byKey, total };
}

const [a, b] = process.argv.slice(2).filter((s) => !s.startsWith("--"));
const ti = process.argv.indexOf("--top");
const top = ti === -1 ? 25 : Number(process.argv[ti + 1]);
const A = summarize(a), B = summarize(b);
const mb = (x) => (x / 1048576).toFixed(2);
console.log(`total self size: A=${mb(A.total)} MB  B=${mb(B.total)} MB  Δ=${mb(B.total - A.total)} MB\n`);
const rows = [...new Set([...A.byKey.keys(), ...B.byKey.keys()])].map((k) => {
  const x = A.byKey.get(k) ?? { count: 0, size: 0 }, y = B.byKey.get(k) ?? { count: 0, size: 0 };
  return { k, dc: y.count - x.count, ds: y.size - x.size, cb: y.count };
}).sort((p, q) => Math.abs(q.ds) - Math.abs(p.ds)).slice(0, top);
for (const r of rows) console.log(`${(r.ds / 1024).toFixed(0).padStart(9)} KB  ${String(r.dc).padStart(8)} objs  (B: ${r.cb})  ${r.k}`);
