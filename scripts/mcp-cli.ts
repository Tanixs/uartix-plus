/**
 * UARTIX-MCP 桥（P64c）：把 Uartix+ 暴露成 MCP stdio 服务器。
 *
 *   Claude Desktop / Cursor（MCP stdio 客户端）
 *     ↕ 换行分隔 JSON-RPC（stdio）
 *   本进程（本文件，零依赖 Node ≥ 18）
 *     ↕ 127.0.0.1:<port> 换行 JSON，首行 token 握手（Rust 内控桥 bridge.rs）
 *   Uartix+ 前端执行端（mcpServer.ts dispatch）
 *
 * 定位：发现文件 %APPDATA%/com.uartix.plus/mcp-endpoint.json（Rust 启动时写、
 * 停止即删），端口/token 变化无需改客户端配置。MCP 协议只实现 stdio 必需面：
 * initialize / tools/list / tools/call / ping；工具执行错误按 spec 以
 * isError result 返回（协议级错误仅用于未知方法/参数）。
 *
 * 打包：npm run build:mcp → dist-cli/uartix-mcp.cjs（esbuild 单文件）。
 * 日志一律走 stderr（stdout 是协议通道）。
 */

import { bridgeCall, readEndpoint, type Capabilities, type Endpoint } from "./bridge-client";
import { TOOL_DEFS, JOB_TOOL_DEFS, ALL_TOOL_DEFS, type McpToolDef } from "../src/features/mcp/mcpTools";

const VERSION = "0.1.0";
const FALLBACK_PROTOCOL_VERSION = "2025-03-26";
/** stdio 进来的单行上限（与桥的 `MAX_LINE` 是两回事：这里管外部 IDE 写进来的行） */
const MAX_STDIO_LINE = 1024 * 1024;

/** jobs 能力门（从桥客户端里搬出来放这儿：这是 MCP 面自己的策略，不是连接协议的一部分） */
function jobGate(kind: string) {
  return (auth: Capabilities): string | undefined =>
    JOB_TOOL_DEFS.some((t) => t.name === kind) && auth?.capabilities?.jobs?.version !== 1
      ? "jobs_not_supported: upgrade Uartix+; no legacy execution fallback"
      : undefined;
}

/* ================= stderr 日志 ================= */

const log = (...a: unknown[]) => console.error("[uartix-mcp]", ...a);

/* ================= MCP stdio 服务器 ================= */

interface RpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function wireSend(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function rpcResult(id: RpcReq["id"], result: Record<string, unknown>) {
  wireSend({ jsonrpc: "2.0", id, result });
}

function rpcError(id: RpcReq["id"], code: number, message: string) {
  wireSend({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toolFail(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** tools/list：TOOL_DEFS 单源（与前端执行端/单测同一份） */
function toolsList(): Record<string, unknown> {
  return { tools: TOOL_DEFS.map((t: McpToolDef) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
}

/** capability gate: legacy apps expose no jobs namespace; short tools stay usable. */
function publishableTools(caps: Capabilities | null): McpToolDef[] {
  return caps?.capabilities?.jobs?.version === 1 ? ALL_TOOL_DEFS : TOOL_DEFS;
}

/** 只转发工具清单里有的名字（`cli.` 前缀的命令行专用动作从来不在清单里 ⇒ 模型这条路够不到装包） */
function forwardableTool(name: string): boolean {
  return ALL_TOOL_DEFS.some((t) => t.name === name);
}

async function toolCapabilities(ep: Endpoint): Promise<Capabilities> {
  return bridgeCall<Capabilities>(ep, "__capabilities", {}, { stopAfterAuth: true, log });
}

async function toolsCall(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = typeof params.name === "string" ? params.name : "";
  if (!forwardableTool(name)) {
    throw new RpcClientError(-32602, `未知工具：${name}`);
  }
  const ep = readEndpoint();
  try {
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      const data = await bridgeCall(ep, name, args, { afterAuth: jobGate(name), log });
      return toolText(data);
    } catch (e) {
      return toolFail(String(e instanceof Error ? e.message : e));
    }
  } catch (e) {
    return toolFail(String(e instanceof Error ? e.message : e));
  }
}

class RpcClientError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle(req: RpcReq): Promise<void> {
  const isNotify = req.id === undefined || req.id === null;
  switch (req.method) {
    case "initialize":
      // 协议版本回显客户端请求值（spec 允许）；能力面只声明 tools
      rpcResult(req.id, {
        protocolVersion:
          typeof req.params?.protocolVersion === "string"
            ? req.params.protocolVersion
            : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "uartix", title: "Uartix+ 串口协议分析器", version: VERSION },
      });
      return;
    case "notifications/initialized":
      return; // 通知不回包
    case "ping":
      if (!isNotify) rpcResult(req.id, {});
      return;
    case "tools/list":
      if (!isNotify) {
        try {
          const caps = await toolCapabilities(readEndpoint()).catch(() => null);
          rpcResult(req.id, { tools: publishableTools(caps).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        } catch {
          rpcResult(req.id, toolsList());
        }
      }
      return;
    case "tools/call": {
      if (isNotify) return;
      const params = req.params ?? {};
      try {
        rpcResult(req.id, await toolsCall(params));
      } catch (e) {
        if (e instanceof RpcClientError) rpcError(req.id, e.code, e.message);
        else rpcResult(req.id, toolFail(String(e instanceof Error ? e.message : e)));
      }
      return;
    }
    default:
      if (!isNotify) rpcError(req.id, -32601, `方法不存在：${req.method ?? "?"}`);
  }
}

/* ================= 入口 ================= */

function printHelp(): void {
  process.stderr.write(
    [
      "uartix-mcp — Uartix+ MCP 桥（stdio）",
      "",
      "用法（Claude Desktop / Cursor 配置里的 command 即 node，args 指向本文件）:",
      "  node uartix-mcp.cjs                # 以 MCP stdio 服务器运行（默认）",
      "  node uartix-mcp.cjs --status       # 检查发现文件与内控桥连通性",
      "  node uartix-mcp.cjs --help",
      "",
      "环境变量 UARTIX_ENDPOINT 可覆盖发现文件路径。",
      "前置条件：Uartix+ 已启动且 设置 → 集成 「启用 MCP 桥」。",
      "",
    ].join("\n"),
  );
}

async function cmdStatus(): Promise<number> {
  try {
    const ep = readEndpoint();
    log(`发现文件：port=${ep.port} pid=${ep.pid} appVersion=${ep.version}`);
    const pong = await bridgeCall<{ pong: boolean; ts: number }>(ep, "ping", {});
    log(`内控桥连通：pong=${pong.pong}`);
    return 0;
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  if (argv.includes("--status")) return cmdStatus();

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (line.length > MAX_STDIO_LINE) {
        log("超长请求行已丢弃");
        continue;
      }
      let req: RpcReq;
      try {
        req = JSON.parse(line) as RpcReq;
      } catch {
        log(`无法解析的行：${line.slice(0, 120)}`);
        continue;
      }
      void handle(req).catch((e) => log("handler 异常：", e));
    }
  });
  process.stdin.on("end", () => {
    log("stdin 关闭，退出");
  });
  // stdin 结束后自然退出；进程级兜底
  process.on("uncaughtException", (e) => {
    log("uncaughtException：", e);
  });
  await new Promise<void>((res) => {
    process.stdin.on("close", res);
  });
  return 0;
}

void main().then((code) => {
  process.exitCode = code;
});
