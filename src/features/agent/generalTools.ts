/**
 * P88e B1：Agent 通用工具——fs_read / fs_list / fs_write / web_fetch / web_search / shell_exec。
 * P99a-A2/A3：迁入注册表。**授权域与审批不再由本文件自行裁决**——域门与批准卡由
 * `toolRegistry.runToolCall` 统一执行，本文件只声明"这支工具要什么域、这一 call 有多危险"。
 *
 * 授权模型（宿主可信层校验，Rust 只负责隔离执行）：
 *   · fs_read / fs_list / web_fetch / web_search：勾选 files / network 域后可用；
 *   · fs 路径必须落在设置页「Agent 文件白名单」内（默认空=功能关闭），读侧绝不暴露写/删/移动；
 *   · shell_exec 三重门：设置总开关（默认关）+ 勾选 shell 域 + 每次逐条审批，缺一不可。
 *     总开关关着时**不弹批准卡**（白要一次人工确认＝把用户训练成橡皮图章），这条走 assess。
 *   · fs_write：新建直接写，**覆盖已有文件逐条批准**（应用不提供撤销）——风险由 stat 才知道，
 *     所以它的 effect 也在 assess 里定，而不是写死在 entry 上。
 * - 网络出口复用 Rust agent_http_get（SSRF 基础防护：拒内网/本机地址、15s 超时、1MB 限量读流），
 *   代理沿用 AI 服务的 aiProxy/aiNoProxy 设置；
 * - web_search 用 DuckDuckGo HTML 端点（免 API Key），正则解析，最多 8 条；
 * - shell 走 Rust agent_shell_exec（Windows cmd /C 隐藏窗口、10s 硬超时 kill、64KB 截断）。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { DOMAIN_ZH, type Domain } from "./scopeTiers";
import { defineTool, notExecuted, type AgentToolEntry, type Assessment, type ToolCtx, type ToolResultBody } from "./toolRegistry";

/**
 * 工具 → 所需授权域（P93-A6）。P99a 起这条映射**只有一处**：写在 entry.domain 上，
 * 定义下发裁剪与实际调用拒绝都从它派生（旧实现另有一份 GENERAL_TOOL_DOMAIN 供适配器过滤，
 * 于是"外观与内联九支根本不进裁剪"——看得见却调不动的老毛病就是这么来的）。
 */
export const GENERAL_DOMAINS: Domain[] = ["files", "network", "write", "shell"];

function failed(callId: string, err: unknown): ToolResultBody {
  return { callId, ok: false, status: "error", code: "tool_failed", data: { err: String(err).slice(0, 300) } };
}

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
  // P99a-A6：`..` 段必须在匹配之前先拒。归一化不折叠 `..`，旧写法下
  // `D:\w\..\..\Windows\x` 以 `D:\w\` 开头照样通过——Rust 侧同一条规则，两边一起补。
  if (path.split(/[/\\]/).some((seg) => seg === ".." || seg === ".")) return false;
  const np = normPath(path);
  if (!np) return false;
  return roots.some((r) => {
    const nr = normPath(r);
    return np === nr || np.startsWith(nr + "\\");
  });
}

const NOT_IN_WL = (callId: string): ToolResultBody => notExecuted(callId, "path_outside_whitelist", {
  hint: "路径不在「Agent 文件白名单」内（设置 → AI 服务）；白名单为空表示文件工具关闭",
});

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

/** fs_read 单页字节上限（P94-G4）。旧实现整份文件进回执，一份大日志就能撞爆请求体积。 */
export const FS_READ_PAGE_MAX = 64 * 1024;

async function fsRead(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
  if (!inWhitelist(path)) return NOT_IN_WL(callId);
  const from = Math.max(0, Math.floor(Number(parsed.from)) || 0);
  const maxBytes = Math.min(Math.max(1, Math.floor(Number(parsed.maxBytes)) || FS_READ_PAGE_MAX), FS_READ_PAGE_MAX);
  try {
    const r = await invoke<{
      text: string; from: number; totalBytes: number; hasMore: boolean; nextFrom: number;
    }>("agent_fs_read_text", { path, from, maxBytes });
    return {
      callId,
      ok: true,
      status: "read",
      data: {
        path,
        from: r.from,
        bytes: r.totalBytes,
        returned: r.text.length,
        truncated: r.hasMore,
        content: r.text,
        // 偏移恒回传（末页 = 文件末尾）：只在新页才给会让翻页循环退回头一页
        nextFrom: r.nextFrom,
        ...(r.hasMore
          ? { hint: `文件共 ${r.totalBytes} 字节，本次只返回 ${r.text.length} 字节；用 fs_read { path, from: ${r.nextFrom} } 继续读` }
          : {}),
      },
    };
  } catch (e) {
    return failed(callId, e);
  }
}

async function fsList(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
  if (!inWhitelist(path)) return NOT_IN_WL(callId);
  const depthRaw = Number(parsed.depth);
  const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(Math.round(depthRaw), 1), 3) : 2;
  try {
    const r = await invoke<{ path: string; truncated: boolean; entries: unknown }>("agent_fs_list", { path, depth });
    return { callId, ok: true, status: "read", data: r };
  } catch (e) {
    return failed(callId, e);
  }
}

async function webFetch(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const url = String(parsed.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return notExecuted(callId, "invalid_args", { hint: "url 必须是 http/https 地址" });
  }
  try {
    const r = await httpGet(url);
    return { callId, ok: true, status: "read", data: r };
  } catch (e) {
    return failed(callId, e);
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

async function webSearch(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
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
    return failed(callId, e);
  }
}

async function shellExec(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const command = String(parsed.command ?? "").trim();
  try {
    const r = await invoke<{
      exitCode: number; stdout: string; stderr: string; timedOut: boolean;
      stdoutBytes: number; stdoutTruncated: boolean; stderrBytes: number; stderrTruncated: boolean;
    }>("agent_shell_exec", { command });
    // 命令执行本身是成功回执（退出码/超时交给模型判断），避免把合法观察误判为故障
    return { callId, ok: true, status: "read", data: { command, ...r } };
  } catch (e) {
    return failed(callId, e);
  }
}

/** P97-I4：单次写入上限（字符）。超过就该"分几次写"或改生成模板，而不是把巨块塞进一次工具调用。 */
const FS_WRITE_MAX_CHARS = 1_000_000;

interface FileStat { exists?: boolean; bytes?: number; isDir?: boolean }

/** fs_write 的前置校验与风险判定：新建=draft_write，覆盖=irreversible（逐条批准）。 */
async function assessFsWrite(
  args: Record<string, unknown>, ctx: ToolCtx,
): Promise<Assessment> {
  const callId = ctx.callId;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const content = typeof args.content === "string" ? args.content : "";
  if (!path || !content.trim()) {
    return { refuse: notExecuted(callId, "invalid_args", { hint: "path 与 content 都必填（content 不接受纯空白）" }) };
  }
  if (content.length > FS_WRITE_MAX_CHARS) {
    return { refuse: notExecuted(callId, "too_large", { chars: content.length, max: FS_WRITE_MAX_CHARS, hint: "分几次写，或先写模板再补数据" }) };
  }
  if (!inWhitelist(path)) {
    return { refuse: notExecuted(callId, "path_outside_whitelist", { path, hint: `把目标目录加入 设置 → AI 服务 → 「${DOMAIN_ZH.files}」白名单` }) };
  }
  let st: FileStat;
  try {
    st = await invoke<FileStat>("agent_fs_stat", { path });
  } catch (e) {
    return { refuse: failed(callId, `stat 失败：${String(e).slice(0, 200)}`) };
  }
  if (st.isDir) return { refuse: notExecuted(callId, "is_dir", { path, hint: "目标是目录，请给完整文件名" }) };
  if (!st.exists) {
    return { meta: { effect: "draft_write", idempotent: false, reversible: false, mayTouchDevice: false } };
  }
  // 批准卡要把"会被替换掉多少字节"说清楚——这个事实只有这里的 stat 知道
  return {
    meta: { effect: "irreversible", idempotent: false, reversible: false, mayTouchDevice: false },
    plan: `覆盖已有文件：\n${path}\n\n现有 ${st.bytes ?? 0} 字节会被替换成新写的 ${content.length} 字符，应用不提供撤销。确认路径与内容后再批准。`,
  };
}

async function fsWrite(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  const content = typeof parsed.content === "string" ? parsed.content : "";
  let st: FileStat;
  try {
    // 再 stat 一次只为回执说清"覆盖了多少字节"；放行判定已在 assess 里做完，这里不重复设门
    st = await invoke<FileStat>("agent_fs_stat", { path });
    // P99a-A6：写文件走专属命令，白名单根由宿主传入并在 **Rust 侧**判定——
    // 旧实现调通用的 save_text_file（界面导出也在用、不带根判定），门只存在于渲染层。
    await invoke("agent_fs_write", { path, content, roots: parseFsRoots(getSettings().agentFsRoots) });
  } catch (e) {
    return failed(callId, e);
  }
  return {
    callId,
    ok: true,
    status: "applied",
    data: {
      path,
      chars: content.length,
      ...(st.exists ? { overwroteBytes: st.bytes ?? 0 } : { created: true }),
      hint: st.exists
        ? "已覆盖旧文件（不可撤销）。把写入路径告诉用户；下轮再改同一文件仍需再次批准"
        : "已新建文件。把写入路径告诉用户",
    },
  };
}

const HOST = { kind: "host" } as const;

export const generalToolEntries: AgentToolEntry[] = [
  defineTool({
    name: "fs_read",
    labelZh: "读取文件",
    effect: "read",
    domain: "files",
    provenance: HOST,
    description:
      "Read a UTF-8 text file inside the user-approved whitelist roots (settings 'Agent 文件白名单', empty = disabled). Args: { path: string, from?: number (byte offset, default 0), maxBytes?: number (default and cap 65536) }. Returns { content, from, bytes, returned, truncated, nextFrom } and pages through big files with from=nextFrom until truncated is false; never assume a truncated file was read completely. Read-only; requires the files authorization domain.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, from: { type: "number" }, maxBytes: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
    summarize: (a) => `读取 ${String(a.path ?? "")}`,
    execute: (a, ctx) => fsRead(ctx.callId, a),
  }),
  defineTool({
    name: "fs_list",
    labelZh: "列出目录",
    effect: "read",
    domain: "files",
    provenance: HOST,
    description:
      "List a directory tree inside the whitelist roots. Args: { path: string, depth?: number (1-3, default 2) }. Max 500 entries; files report size. Read-only; requires custom scope with the files domain.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, depth: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    },
    summarize: (a) => `列出 ${String(a.path ?? "")}${a.depth ? ` · ${a.depth} 层` : ""}`,
    execute: (a, ctx) => fsList(ctx.callId, a),
  }),
  defineTool({
    name: "fs_write",
    labelZh: "写入文件",
    // 真实风险由 assessFsWrite 按"新建 / 覆盖"逐 call 判定；这里声明的是**下界**（写类，非只读）
    effect: "draft_write",
    domain: "write",
    provenance: HOST,
    description:
      `Write a UTF-8 text file inside the Agent file whitelist (设置 → AI 服务 → Agent 文件白名单): reports {path, bytes, created|overwroteBytes}. **Creating a new file applies immediately; overwriting an existing one needs a per-call user approval** (irreversible). Use it for generated artifacts (configs, scripts, reports, plugin sources) — not for the app's own settings (use settings_apply) or plugins (use save_plugin). Args: { path: string, content: string }. Needs the ${DOMAIN_ZH.write} authorization.`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    summarize: (a) => `写入 ${String(a.path ?? "")}`,
    assess: assessFsWrite,
    approvalBinding: (a) => ({ path: a.path, bytes: String(a.content ?? "").length }),
    execute: (a, ctx) => fsWrite(ctx.callId, a),
  }),
  defineTool({
    name: "web_fetch",
    labelZh: "抓取网页",
    effect: "read",
    domain: "network",
    provenance: HOST,
    description:
      "HTTP GET a public http(s) URL: returns status/contentType/body (1MB cap; localhost/private-network addresses blocked). Args: { url: string }. Read-only; requires custom scope with the network domain.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    summarize: (a) => `抓取 ${String(a.url ?? "").slice(0, 60)}`,
    execute: (a, ctx) => webFetch(ctx.callId, a),
  }),
  defineTool({
    name: "web_search",
    labelZh: "搜索网页",
    effect: "read",
    domain: "network",
    provenance: HOST,
    description:
      "Web search via DuckDuckGo HTML endpoint (no API key): returns top results {title,url,snippet} (max 8). Args: { query: string }. Read-only; requires custom scope with the network domain.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    summarize: (a) => `搜索「${String(a.query ?? "").slice(0, 40)}」`,
    execute: (a, ctx) => webSearch(ctx.callId, a),
  }),
  defineTool({
    name: "shell_exec",
    labelZh: "执行命令",
    effect: "irreversible",
    domain: "shell",
    provenance: HOST,
    description:
      "Run a short shell command (Windows: cmd /C; 10s hard timeout then kill; output beyond 64 KiB is clipped keeping BOTH ends, with stdoutBytes/stdoutTruncated stating the original size). Read the tail for failure causes. Every call requires explicit per-call user approval and the shell master switch in settings. Args: { command: string }.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    summarize: (a) => `执行 ${String(a.command ?? "").slice(0, 60)}`,
    /** 三重门之一：总开关关着就地拒，**不弹批准卡**（旧实现同序，别把无意义的确认要回来） */
    assess: (a, ctx) => {
      const command = String(a.command ?? "").trim();
      if (!command) return { refuse: notExecuted(ctx.callId, "invalid_args", { hint: "command 必须是非空字符串" }) };
      if (!getSettings().agentShellEnabled) {
        return { refuse: notExecuted(ctx.callId, "shell_disabled", { hint: "设置页「Agent 允许执行命令」总开关未开启" }) };
      }
      return { meta: { effect: "irreversible", idempotent: false, reversible: false, mayTouchDevice: false } };
    },
    approvalBinding: (a) => ({ tool: "shell_exec", command: String(a.command ?? "").trim() }),
    planFor: (a) => `在系统 Shell 执行命令：\n${String(a.command ?? "")}\n\n超时 10s 自动终止；输出截断 64KB。请确认命令来源与影响后批准。`,
    execute: (a, ctx) => shellExec(ctx.callId, a),
  }),
];
