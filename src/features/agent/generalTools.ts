/**
 * P88e B1：Agent 通用工具——fs_read / fs_list / web_fetch / web_search / shell_exec。
 * - 授权模型（详设 §B1，宿主可信层校验，Rust 只负责隔离执行）：
 *   · fs_read / fs_list / web_fetch / web_search：仅「自定义」档位勾选 files / network 域后可用；
 *   · fs 路径必须落在设置页「Agent 文件白名单」内（默认空=功能关闭），只有读文本与列目录，
 *     绝不暴露写/删/移动；
 *   · shell_exec 三重门：设置总开关（默认关）+ 勾选 shell 域 + 每次逐条审批，缺一不可。
 * - 网络出口复用 Rust agent_http_get（SSRF 基础防护：拒内网/本机地址、15s 超时、1MB 限量读流），
 *   代理沿用 AI 服务的 aiProxy/aiNoProxy 设置；
 * - web_search 用 DuckDuckGo HTML 端点（免 API Key），正则解析，最多 8 条；
 * - shell 走 Rust agent_shell_exec（Windows cmd /C 隐藏窗口、10s 硬超时 kill、64KB 截断）。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { argsHash, APPROVAL_TTL_MS, type ApprovalGate } from "./agentAdapter";
import type { ToolCall, ToolDefinition, ToolReceipt, TaskContext } from "./types";

export const GENERAL_TOOLS = ["fs_read", "fs_list", "web_fetch", "web_search", "shell_exec"] as const;
export type GeneralToolName = (typeof GENERAL_TOOLS)[number];

/** 授权域 → 中文（设置提示与拒绝文案共用） */
export const GENERAL_DOMAIN: Record<"files" | "network" | "shell", string> = {
  files: "文件",
  network: "网络",
  shell: "命令行",
};

export const generalToolDefs: ToolDefinition[] = [
  {
    name: "fs_read",
    description:
      "Read a UTF-8 text file inside the user-approved whitelist roots (settings 'Agent 文件白名单', empty = disabled). Args: { path: string }. Read-only; requires custom scope with the files domain.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "fs_list",
    description:
      "List a directory tree inside the whitelist roots. Args: { path: string, depth?: number (1-3, default 2) }. Max 500 entries; files report size. Read-only; requires custom scope with the files domain.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, depth: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description:
      "HTTP GET a public http(s) URL: returns status/contentType/body (1MB cap; localhost/private-network addresses blocked). Args: { url: string }. Read-only; requires custom scope with the network domain.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description:
      "Web search via DuckDuckGo HTML endpoint (no API key): returns top results {title,url,snippet} (max 8). Args: { query: string }. Read-only; requires custom scope with the network domain.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "shell_exec",
    description:
      "Run a short shell command (Windows: cmd /C; 10s hard timeout then kill; 64KB output cap). Every call requires explicit per-call user approval and the shell master switch in settings. Args: { command: string }.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

/* ================= 路径白名单 ================= */

/** 白名单解析：分号/逗号/换行分隔的绝对路径。 */
export function parseFsRoots(v: string): string[] {
  return v
    .split(/[;,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 路径归一化：分隔符统一、盘符大写、压重复分隔符、去尾分隔符；比较统一小写。 */
function normPath(p: string): string {
  let s = p.trim().replace(/\//g, "\\");
  if (/^[a-z]:/i.test(s)) s = s[0].toUpperCase() + s.slice(1);
  s = s.replace(/\\{2,}/g, "\\").replace(/\\$/, "");
  return s.toLowerCase();
}

/** 路径是否落在白名单内（分隔符边界匹配，防 D:\Projects 前缀误配 D:\ProjectsX）。 */
export function inWhitelist(path: string): boolean {
  const roots = parseFsRoots(getSettings().agentFsRoots);
  if (roots.length === 0) return false;
  const np = normPath(path);
  if (!np) return false;
  return roots.some((r) => {
    const nr = normPath(r);
    return np === nr || np.startsWith(nr + "\\");
  });
}

/* ================= 通用小件 ================= */

function notExecuted(callId: string, code: string, data?: unknown): ToolReceipt {
  return { callId, ok: false, status: "not_executed", code, ...(data !== undefined ? { data } : {}) };
}

/** 域门：仅自定义档位 + 勾选对应域；其余一律拒绝（preview/create 均不给）。 */
function domainDenied(callId: string, ctx: TaskContext, domain: "files" | "network" | "shell"): ToolReceipt | null {
  if (ctx.scope !== "custom") {
    return notExecuted(callId, "general_tool_requires_custom", {
      hint: `${GENERAL_DOMAIN[domain]}工具仅在「Agent · 自定义」档位可用（当前档位 ${ctx.scope}）`,
    });
  }
  if (!(ctx.allowed ?? []).includes(domain)) {
    return notExecuted(callId, "unauthorized_scope", {
      hint: `自定义档位未勾选「${GENERAL_DOMAIN[domain]}」授权域`,
    });
  }
  return null;
}

interface HttpResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

/** 网络出口统一走 Rust agent_http_get（SSRF 基础防护在 Rust 层），代理沿用 AI 服务设置。 */
async function httpGet(url: string): Promise<HttpResult> {
  const s = getSettings();
  return invoke<HttpResult>("agent_http_get", {
    url,
    proxy: s.aiProxy || null,
    noProxy: s.aiNoProxy || null,
  });
}

/* ================= 各工具实现 ================= */

async function fsRead(callId: string, parsed: Record<string, unknown>): Promise<ToolReceipt> {
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
  if (!inWhitelist(path)) {
    return notExecuted(callId, "path_outside_whitelist", {
      hint: "路径不在「Agent 文件白名单」内（设置 → AI 服务）；白名单为空表示文件工具关闭",
    });
  }
  try {
    const text = await invoke<string>("read_text_file", { path });
    return { callId, ok: true, status: "read", data: { path, bytes: text.length, content: text } };
  } catch (e) {
    return { callId, ok: false, status: "error", code: "tool_failed", data: { err: String(e).slice(0, 300) } };
  }
}

async function fsList(callId: string, parsed: Record<string, unknown>): Promise<ToolReceipt> {
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
  if (!inWhitelist(path)) {
    return notExecuted(callId, "path_outside_whitelist", {
      hint: "路径不在「Agent 文件白名单」内（设置 → AI 服务）；白名单为空表示文件工具关闭",
    });
  }
  const depthRaw = Number(parsed.depth);
  const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(Math.round(depthRaw), 1), 3) : 2;
  try {
    const r = await invoke<{ path: string; truncated: boolean; entries: unknown }>("agent_fs_list", { path, depth });
    return { callId, ok: true, status: "read", data: r };
  } catch (e) {
    return { callId, ok: false, status: "error", code: "tool_failed", data: { err: String(e).slice(0, 300) } };
  }
}

async function webFetch(callId: string, parsed: Record<string, unknown>): Promise<ToolReceipt> {
  const url = String(parsed.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return notExecuted(callId, "invalid_args", { hint: "url 必须是 http/https 地址" });
  }
  try {
    const r = await httpGet(url);
    return { callId, ok: true, status: "read", data: r };
  } catch (e) {
    return { callId, ok: false, status: "error", code: "tool_failed", data: { err: String(e).slice(0, 300) } };
  }
}

/** HTML 转义反转（DuckDuckGo 摘要常见实体） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** DuckDuckGo 重定向链接（//duckduckgo.com/l/?uddg=<encoded>）还原为真实 URL */
function cleanDdgUrl(u: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(u);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* 保持原样 */
    }
  }
  return u.startsWith("//") ? "https:" + u : u;
}

/** DuckDuckGo HTML 结果解析（正则，避免依赖 DOM 环境便于测试）。 */
export function parseDdgResults(html: string): { title: string; url: string; snippet: string }[] {
  const titles: { title: string; url: string }[] = [];
  const reA = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = reA.exec(html)) !== null) {
    titles.push({ url: cleanDdgUrl(m[1]), title: stripTags(m[2]) });
  }
  const snippets: string[] = [];
  const reS = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = reS.exec(html)) !== null) snippets.push(stripTags(m[1]));
  return titles
    .map((t, i) => ({ title: t.title, url: t.url, snippet: snippets[i] ?? "" }))
    .filter((r) => r.title && r.url)
    .slice(0, 8);
}

async function webSearch(callId: string, parsed: Record<string, unknown>): Promise<ToolReceipt> {
  const query = String(parsed.query ?? "").trim();
  if (!query) return notExecuted(callId, "invalid_args", { hint: "query 必须是非空字符串" });
  try {
    const r = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const results = parseDdgResults(r.body);
    return {
      callId,
      ok: true,
      status: "read",
      data: {
        query,
        results,
        ...(results.length === 0 ? { note: "未解析到结果（可能被限流或无匹配）；可用 web_fetch 直接抓取网页确认" } : {}),
      },
    };
  } catch (e) {
    return { callId, ok: false, status: "error", code: "tool_failed", data: { err: String(e).slice(0, 300) } };
  }
}

async function shellExec(
  call: ToolCall,
  ctx: TaskContext,
  runId: string,
  gate: ApprovalGate,
  parsed: Record<string, unknown>,
): Promise<ToolReceipt> {
  const command = String(parsed.command ?? "").trim();
  if (!command) return notExecuted(call.callId, "invalid_args", { hint: "command 必须是非空字符串" });
  // 三重门 ①②：档位 + shell 域
  const denied = domainDenied(call.callId, ctx, "shell");
  if (denied) return denied;
  // 三重门 ③：设置总开关（默认关）
  if (!getSettings().agentShellEnabled) {
    return notExecuted(call.callId, "shell_disabled", {
      hint: "设置页「Agent 允许执行命令」总开关未开启",
    });
  }
  // 三重门 ④：每次逐条审批（批准令牌绑定命令内容，参数变化即失效）
  const hash = argsHash({ tool: "shell_exec", command });
  const now = Date.now();
  const token = gate.takeToken(runId, "shell_exec", hash, now);
  if (!token) {
    gate.request({
      id: crypto.randomUUID(),
      runId,
      callId: call.callId,
      tool: "shell_exec",
      argsSummary: command.slice(0, 600),
      argsHash: hash,
      effect: "irreversible",
      plan: `在系统 Shell 执行命令：\n${command}\n\n超时 10s 自动终止；输出截断 64KB。请确认命令来源与影响后批准。`,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
    });
    return notExecuted(call.callId, "needs_local_approval", {
      hint: "等待用户在任务卡批准；批准后用相同命令重试",
    });
  }
  try {
    const r = await invoke<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>(
      "agent_shell_exec",
      { command },
    );
    // 命令执行本身是成功回执（退出码/超时交给模型判断），避免把合法观察误判为故障
    return { callId: call.callId, ok: true, status: "read", data: { command, ...r } };
  } catch (e) {
    return { callId: call.callId, ok: false, status: "error", code: "tool_failed", data: { err: String(e).slice(0, 300) } };
  }
}

/* ================= 分发 ================= */

export async function executeGeneralTool(
  call: ToolCall,
  ctx: TaskContext,
  runId: string,
  gate: ApprovalGate,
): Promise<ToolReceipt> {
  if (ctx.signal.aborted) return notExecuted(call.callId, "cancelled");
  let parsed: Record<string, unknown> = {};
  if (call.arguments && call.arguments.trim()) {
    try {
      parsed = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      return notExecuted(call.callId, "invalid_json");
    }
  }
  switch (call.name) {
    case "fs_read": {
      const d = domainDenied(call.callId, ctx, "files");
      if (d) return d;
      return fsRead(call.callId, parsed);
    }
    case "fs_list": {
      const d = domainDenied(call.callId, ctx, "files");
      if (d) return d;
      return fsList(call.callId, parsed);
    }
    case "web_fetch": {
      const d = domainDenied(call.callId, ctx, "network");
      if (d) return d;
      return webFetch(call.callId, parsed);
    }
    case "web_search": {
      const d = domainDenied(call.callId, ctx, "network");
      if (d) return d;
      return webSearch(call.callId, parsed);
    }
    case "shell_exec":
      return shellExec(call, ctx, runId, gate, parsed);
    default:
      return notExecuted(call.callId, "unknown_tool");
  }
}
