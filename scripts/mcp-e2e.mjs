/** Isolated MCP stdio + fake loopback bridge regression. Never reads a real endpoint or sends to devices. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "uartix-mcp-test-"));
const endpoint = join(dir, "endpoint.json");
const sockets = new Set();
let jobsSupported = true;
let callCount = 0;
const server = createServer((socket) => {
  sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const i = buf.indexOf("\n"); if (i < 0) break;
      const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (req.op === "auth") {
        socket.write(JSON.stringify({ ok: true, data: { proto: 1, capabilities: jobsSupported ? { jobs: { version: 1 } } : {} } }) + "\n");
      } else if (req.op === "call") {
        callCount++;
        if (req.kind === "get_status") {
          // Regression: connect timer must NOT linger as a two-second socket idle timer.
          const timer = setTimeout(() => socket.write(JSON.stringify({ ok: true, data: { status: "test", delayedMs: 2300 } }) + "\n"), 2300);
          socket.once("close", () => clearTimeout(timer));
        } else if (req.kind === "run_sequence") socket.write(JSON.stringify({ ok: false, err: "async_required: no execution" }) + "\n");
        else if (req.kind === "create_job") socket.write(JSON.stringify({ ok: true, data: { accepted: true, jobId: "fake:one", state: "queued" } }) + "\n");
        else if (req.kind === "wait_event") setTimeout(() => {
          if (!socket.destroyed) socket.write(JSON.stringify({ ok: true, data: { events: [], eventSeq: 1 } }) + "\n");
        }, 1000);
        else socket.write(JSON.stringify({ ok: true, data: { jobId: "fake:one", state: "succeeded" } }) + "\n");
      }
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(endpoint, JSON.stringify({ port: server.address().port, token: "synthetic-test-token-only", pid: process.pid }));
const child = spawn(process.execPath, [resolve("dist-cli/uartix-mcp.cjs")], {
  stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, UARTIX_ENDPOINT: endpoint },
});
let buf = ""; let id = 0; const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const i = buf.indexOf("\n"); if (i < 0) break;
    const res = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const p = pending.get(res.id); if (p) { pending.delete(res.id); clearTimeout(p.timer); p.resolve(res); }
  }
});
child.stderr.resume();
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const reqId = ++id;
  const timer = setTimeout(() => { pending.delete(reqId); reject(new Error(`RPC timeout: ${method}`)); }, 8000);
  pending.set(reqId, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
});
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
const data = (r) => JSON.parse(r.result.content[0].text);
let checks = 0;
function check(cond, label) { assert.ok(cond, label); checks++; console.log(`PASS ${label}`); }
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  check(init.result.protocolVersion === "2025-06-18", "initialize version echo");
  const list = await rpc("tools/list");
  check(list.result.tools.length === 14, "jobs v1 publishes 14 tools");
  check(["create_job", "get_job", "wait_event", "cancel_job"].every((n) => list.result.tools.some((t) => t.name === n)), "four job tools negotiated");
  check((await rpc("tools/call", { name: "unknown" })).error.code === -32602, "unknown tool is protocol error");
  check(data(await call("get_status")).delayedMs === 2300, "connected RPC survives more than two seconds idle");
  check(data(await call("create_job", { taskType: "sequence.validate", idempotencyKey: "test" })).accepted, "create receipt forwarded without final wait");
  check(data(await call("wait_event", { jobId: "fake:one", afterSeq: 1, waitMs: 1000 })).events.length === 0, "one-second empty event wait succeeds");
  check((await call("run_sequence")).result.isError, "legacy async_required remains an error, not a queued success");
  jobsSupported = false;
  check((await rpc("tools/list")).result.tools.length === 10, "old app hides job tools on renegotiation");
  const before = callCount;
  const unsupported = await call("create_job");
  check(unsupported.result.isError && unsupported.result.content[0].text.includes("jobs_not_supported") && callCount === before, "old app rejects job call before dispatch and never falls back");
  jobsSupported = true;
  check((await rpc("tools/list")).result.tools.length === 14, "capabilities are not stale after app change");
  console.log(`MCP isolated integration: ${checks} checks passed; no native app/device exercised.`);
} finally {
  child.stdin.end(); child.kill();
  for (const p of pending.values()) clearTimeout(p.timer);
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
}
