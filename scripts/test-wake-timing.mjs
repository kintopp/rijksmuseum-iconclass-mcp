#!/usr/bin/env node
// Wake-timing probe — verifies HTTP mode answers /health + the MCP `initialize`
// handshake BEFORE the e5-base embedding model finishes loading. That property
// is what makes Railway scale-to-zero (App Sleeping) viable: a cold wake must
// answer the client's connect handshake within its timeout, not be held while
// the ~seconds-long ONNX model load + DB mmap warm complete.
//
// Spawns `node dist/index.js --http`, then from t0 (spawn) measures:
//   - t(/health 200)                        — should be ~node-boot time
//   - t(initialize 200)                     — handshake works while still warming
//   - t("Embedding model loaded" stderr)    — the slow load, now off the critical path
//   - t("Background warmup complete")       — warmCorePages + model ready
//
// PASS: /health + initialize both succeed under WAKE_BUDGET_MS AND land before
// the model finishes loading (proving the load no longer gates the handshake).
// Re-runnable; needs a built ./dist + the local iconclass DB.
//
//   node scripts/test-wake-timing.mjs

import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3195;
const BASE = `http://127.0.0.1:${PORT}`;
const WAKE_BUDGET_MS = 8000;

const t0 = Date.now();
const ms = () => Date.now() - t0;
const sleep = (n) => new Promise((r) => setTimeout(r, n));

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${pathname}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  });
}

function initialize() {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "wake-probe", version: "1.0" } },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}/mcp`,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}

async function pollUntil(fn, label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fn(); if (r) return r; } catch { /* not up yet */ }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), "--http"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), ALLOWED_ORIGINS: "*" },
  stdio: ["ignore", "pipe", "pipe"],
});

let modelLoadedAt = null;
let warmCompleteAt = null;
function watch(stream) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.includes("Embedding model loaded") && modelLoadedAt === null) modelLoadedAt = ms();
      if (line.includes("Background warmup complete") && warmCompleteAt === null) warmCompleteAt = ms();
    }
  });
}
watch(child.stdout); watch(child.stderr);

let exited = false;
let done = false;
child.on("exit", (code) => { exited = true; if (!done) { console.error(`\n✗ server exited early (code ${code}) at ${ms()}ms`); process.exit(1); } });

try {
  await pollUntil(async () => { const r = await get("/health"); return r.status === 200 ? r : null; }, "/health 200");
  const healthAt = ms();
  const init = await initialize();
  const initAt = ms();
  const initOk = init.status === 200 && /serverInfo|"result"/.test(init.body);

  // Let the background load finish so we can report where it landed.
  await pollUntil(async () => (warmCompleteAt !== null ? true : null), "background warmup complete");
  done = true;

  console.log("\n── Wake-timing results (ms from process spawn) ──");
  console.log(`  /health 200:                ${healthAt}`);
  console.log(`  initialize 200:             ${initAt}  (ok=${initOk}, http=${init.status})`);
  console.log(`  embedding model loaded:     ${modelLoadedAt ?? "n/a"}`);
  console.log(`  background warmup complete:  ${warmCompleteAt}`);
  console.log(`  ── wake-to-handshake:       ${Math.max(healthAt, initAt)}ms (budget ${WAKE_BUDGET_MS}ms)`);

  const handshake = Math.max(healthAt, initAt);
  const beatModel = modelLoadedAt === null || handshake < modelLoadedAt;
  const pass = initOk && healthAt < WAKE_BUDGET_MS && initAt < WAKE_BUDGET_MS && beatModel;
  console.log(
    `\n${pass ? "✓ PASS" : "✗ FAIL"} — cold-wake /health + initialize answered in ${handshake}ms` +
      (modelLoadedAt !== null ? `, ${modelLoadedAt - handshake}ms before the model finished loading.` : "."),
  );
  child.kill("SIGTERM");
  await sleep(300);
  if (!exited) child.kill("SIGKILL");
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error(`\n✗ probe error at ${ms()}ms: ${err.message}`);
  child.kill("SIGKILL");
  process.exit(1);
}
