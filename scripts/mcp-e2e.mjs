/**
 * MCP 桥 E2E 冒烟（P64c-2）：spawn dist-cli/uartix-mcp.cjs，对其 stdio 说 MCP 协议。
 *
 * 两级断言：
 *   1. 协议层（无需 Uartix+ 在跑）：initialize 版本回显 → tools/list 8 工具 →
 *      tools/call 未知工具协议错误 → tools/call get_status 在 app 缺席时返回
 *      isError 结果（spec：工具执行错误走 result.isError，不走协议错误）。
 *   2. 全链路（app 在跑且「启用 MCP 桥」）：get_status 返回 ok 数据。
 *
 * 运行：npm run build:mcp && npm run mcp:e2e   （协议级断言不过 → 退出码 1）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const CLI = "dist-cli/uartix-mcp.cjs";
if (!existsSync(CLI)) {
  console.error(`缺少 ${CLI}，先运行 npm run build:mcp`);
  process.exit(2);
}

const child = spawn(process.execPath, [CLI], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = [];
let reqId = 0;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const p = pending.shift();
    if (!p) continue;
    try {
      p.resolve(JSON.parse(line));
    } catch (e) {
      p.reject(e);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`  [cli] ${d}`));

function rpc(method, params = undefined) {
  const id = ++reqId;
  const msg = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    child.stdin.write(JSON.stringify(msg) + "\n");
    setTimeout(() => {
      const idx = pending.findIndex((x) => x._id === id);
      if (idx >= 0) {
        pending.splice(idx, 1);
        reject(new Error(`rpc 超时：${method}`));
      }
    }, 5000)._id = id;
  });
}
function notify(method, params = undefined) {
  const msg = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + "\n");
}

let failed = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed++;
};

/* ---- 1. initialize：协议版本回显 + serverInfo ---- */
const VER = "2025-06-18";
const init = await rpc("initialize", { protocolVersion: VER, capabilities: {}, clientInfo: { name: "mcp-e2e", version: "0" } });
ok(init.result?.protocolVersion === VER, `initialize 回显协议版本 ${VER}`);
ok(init.result?.serverInfo?.name === "uartix", "serverInfo.name = uartix");
ok(init.result?.capabilities?.tools !== undefined, "capabilities.tools 已声明");
notify("notifications/initialized");

/* ---- 2. tools/list：8 工具 ---- */
const list = await rpc("tools/list");
const tools = list.result?.tools ?? [];
ok(tools.length === 8, `tools/list 返回 8 个工具（实际 ${tools.length}）`);
ok(tools.every((t) => t.name && t.description && t.inputSchema?.type === "object"), "每个工具 name/description/inputSchema 齐全");

/* ---- 3. 未知工具 → 协议级 -32602 ---- */
const bad = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
ok(bad.error?.code === -32602, "未知工具返回协议错误 -32602");

/* ---- 4. get_status：app 缺席 → isError 工具结果；app 在跑 → 真数据 ---- */
function endpointPath() {
  const name = join("com.uartix.plus", "mcp-endpoint.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? "", name);
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", name);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), name);
}
const status = await rpc("tools/call", { name: "get_status", arguments: {} });
const appLive = existsSync(endpointPath());
if (appLive) {
  let data = null;
  try {
    data = JSON.parse(status.result?.content?.[0]?.text ?? "null");
  } catch {
    /* 非 JSON */
  }
  const live = data && typeof data === "object" && "status" in data;
  ok(live && !status.result?.isError, "全链路 get_status 返回真实状态（app 在跑）");
  if (live) console.log("  └─", JSON.stringify(data));
} else {
  ok(status.result?.isError === true, "app 缺席时 get_status 返回 isError 工具结果（协议层正确）");
  ok(String(status.result?.content?.[0]?.text ?? "").includes("MCP 发现文件"), "错误文案引导用户到 设置 → 集成");
}

child.stdin.end();
setTimeout(() => {
  child.kill();
  console.log(failed === 0 ? "\nE2E 全部通过" : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}, 300);

process.on("unhandledRejection", (e) => {
  console.error("E2E 异常：", e);
  child.kill();
  process.exit(1);
});
