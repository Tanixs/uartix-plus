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
 *   · fs_write：新建直接写；**覆盖已有文件是 destructive_write**——风险由 stat 才知道，
 *     所以它的 effect 也在 assess 里定，而不是写死在 entry 上。P133-H 起宿主在写之前
 *     留一份旧内容（agent_fs_restore 写回），所以「全权执行」档不再为它弹卡；低一档仍要批准。
 * - 网络出口复用 Rust agent_http_get（SSRF 基础防护：拒内网/本机地址、15s 超时、1MB 限量读流），
 *   代理沿用 AI 服务的 aiProxy/aiNoProxy 设置；
 * - web_search 用 DuckDuckGo HTML 端点（免 API Key），正则解析，最多 8 条；
 * - shell 走 Rust agent_shell_exec（Windows cmd /C 隐藏窗口、10s 硬超时 kill、64KB 截断）。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { DOMAIN_ZH, type Domain } from "./scopeTiers";
import { defineTool, notExecuted, type AgentToolEntry, type Assessment, type ToolCtx, type ToolResultBody } from "./toolRegistry";
import type { UndoResult } from "./settingsTools";

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

/** 路径是否落在**给定的**那几枚根之内（分隔符边界匹配，防 D:\Projects 前缀误配 D:\ProjectsX）。 */
export function isUnderRoots(path: string, roots: string[]): boolean {
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

/** 路径是否落在用户当前设的白名单内。判定本体在 `isUnderRoots`，这里只负责去取那份设置。 */
export function inWhitelist(path: string): boolean {
  return isUnderRoots(path, parseFsRoots(getSettings().agentFsRoots));
}

/**
 * 白名单拒绝要说清是**哪一种**：空 = 功能关（只有用户能改），非空 = 路径不对（模型自己就能换对的那枚）。
 * 合成一句话的后果是它只能回去问用户，而它其实有信息自己纠正——P133-C1 的第一次真跑就卡在这。
 * 非空时把 `candidates` 回出去：那几枚根本来就是它下一步要拼的前缀。
 */
function wlRefuse(callId: string, path: string): ToolResultBody {
  const roots = parseFsRoots(getSettings().agentFsRoots);
  if (!roots.length) {
    return notExecuted(callId, "files_whitelist_empty", {
      hint: "「Agent 文件白名单」为空 ⇒ 文件工具整体关闭。要用户去 设置 → AI 服务 → Agent 文件白名单 加目录；换个路径再撞一次不会有用",
    });
  }
  return notExecuted(callId, "path_outside_whitelist", {
    path,
    candidates: roots,
    hint: "路径不在白名单内。root / path 必须是**绝对路径**且落在 candidates 某枚之内——从里面挑一枚再拼一次，别用相对路径",
  });
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

/** fs_read 单页字节上限（P94-G4）。旧实现整份文件进回执，一份大日志就能撞爆请求体积。 */
export const FS_READ_PAGE_MAX = 64 * 1024;

async function fsRead(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
  if (!inWhitelist(path)) return wlRefuse(callId, path);
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

/* ---------- P109-D2：读会话文件（.usess）---------- */

/** 三种检视模式。名字与 Rust `inspect_usess` 的 match 分支一一对应，两边各留一份就是等着漂。 */
export const SESSION_MODES = ["summary", "frames", "annotations"] as const;
/** 一帧页的时间线条数上限（与 Rust 的 INSPECT_PAGE_MAX 同值；这里只用来把 limit 夹住再报给模型） */
export const SESSION_PAGE_MAX = 40;

/**
 * 只读检视一份录好的会话。
 * 为什么不走界面那条 `session_open`：它会把会话**装进回放引擎**（改全局状态、与真实连接互斥），
 * 那是一支写操作；模型问的是"这段录了什么"，不是"把回放器切到这段"。
 * 白名单两边各判一次（这里 + Rust `agent_session_read`），与 fs_write 同一纵深口径。
 */
async function sessionRead(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是 .usess 文件的绝对路径（先用 fs_glob { pattern: \"*.usess\" } 找）" });
  if (!inWhitelist(path)) return wlRefuse(callId, path);
  const mode = String(parsed.mode ?? "summary").trim();
  if (!(SESSION_MODES as readonly string[]).includes(mode)) {
    return notExecuted(callId, "unknown_mode", {
      mode,
      candidates: [...SESSION_MODES],
      hint: "summary 看这份录了什么（模板/字段直方图）、frames 逐条看时间线、annotations 看标注",
    });
  }
  const cursor = Math.max(0, Math.floor(Number(parsed.cursor)) || 0);
  const limit = Math.min(Math.max(1, Math.floor(Number(parsed.limit)) || SESSION_PAGE_MAX), SESSION_PAGE_MAX);
  try {
    const r = await invoke<Record<string, unknown>>("agent_session_read", {
      path, roots: parseFsRoots(getSettings().agentFsRoots), mode, cursor, limit,
    });
    return { callId, ok: true, status: "read", data: { ...r } };
  } catch (e) {
    return failed(callId, e);
  }
}

/**
 * P109-D：fs_grep / fs_glob 的共用实现。
 * 越界与"根不存在"都回**可操作的话**而不是干巴巴的 error：白名单为空时模型只会换个路径再撞一次，
 * 而把"去设置里加目录"这句话回给它，它就能直接告诉用户下一步做什么。
 */
async function fsSearch(
  callId: string, parsed: Record<string, unknown>, mode: "content" | "paths",
): Promise<ToolResultBody> {
  const root = String(parsed.root ?? "").trim();
  const needle = String(parsed.needle ?? "");
  if (!root || !needle.trim()) {
    return notExecuted(callId, "invalid_args", { hint: "root 与 needle 都必填" });
  }
  if (!inWhitelist(root)) return wlRefuse(callId, root);
  try {
    const r = await invoke<{
      matches: unknown[]; scanned: number; truncated: boolean;
      skipped: { binary: number; oversized: number };
    }>("agent_fs_search", {
      root, needle, mode,
      max: Number.isFinite(Number(parsed.max)) ? Number(parsed.max) : null,
      roots: parseFsRoots(getSettings().agentFsRoots),
    });
    return {
      callId,
      ok: true,
      status: "read",
      data: {
        mode,
        root,
        needle,
        count: r.matches.length,
        matches: r.matches,
        scanned: r.scanned,
        truncated: r.truncated,
        skipped: r.skipped,
        ...(r.matches.length === 0
          ? { hint: `扫了 ${r.scanned} 个文件、跳过二进制 ${r.skipped?.binary ?? 0} 个 / 超大 ${r.skipped?.oversized ?? 0} 个。没命中不等于不存在——先确认根目录与拼写，或改用 fs_glob 找文件名。` }
          : r.truncated
            ? { hint: "结果已达上限被截断，收窄 needle 或换更深的 root 再搜" }
            : {}),
      },
    };
  } catch (e) {
    return failed(callId, e);
  }
}

/**
 * P109-D：fs_edit 的实现。Rust 侧回的是 `not_found` / `ambiguous:N` 这类**决策信息**，
 * 不能糊成一条 error：模型需要知道"是没找到"还是"找到好几处不敢乱改"，两者动作完全不同。
 */
/**
 * fs_edit 的前置校验与风险判定。**顺序就是全部意义**：
 * 白名单必须在批准卡之前判——否则用户点了「允许」才发现路径越界，那张卡就是骗人签的。
 * 改的是已存在的文件 ⇒ destructive_write（§8-44 四类里的「覆盖已有内容」）。
 * P133-H：写之前宿主留整份旧内容，所以这条是可撤销的破坏性写，不再是 irreversible。
 */
async function assessFsEdit(args: Record<string, unknown>, ctx: ToolCtx): Promise<Assessment> {
  const callId = ctx.callId;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const oldText = typeof args.old_text === "string" ? args.old_text : "";
  const newText = typeof args.new_text === "string" ? args.new_text : "";
  if (!path || !oldText) {
    return { refuse: notExecuted(callId, "invalid_args", { hint: "path 与 old_text 必填（old_text 不能为空，空串会命中每一行）" }) };
  }
  if (oldText === newText) {
    return { refuse: notExecuted(callId, "invalid_args", { hint: "old_text 与 new_text 相同，无需改" }) };
  }
  if (!inWhitelist(path)) return { refuse: wlRefuse(callId, path) };
  let st: FileStat;
  try {
    st = await invoke<FileStat>("agent_fs_stat", { path });
  } catch (e) {
    return { refuse: failed(callId, `stat 失败：${String(e).slice(0, 200)}`) };
  }
  if (st.isDir) return { refuse: notExecuted(callId, "is_dir", { path, hint: "目标是目录，请给完整文件名" }) };
  if (!st.exists) {
    return { refuse: notExecuted(callId, "not_found", { path, hint: "fs_edit 只改已存在的文件；新建请用 fs_write" }) };
  }
  return {
    // P133-H：见 assessFsWrite 同处注释——有快照了，类名就跟着事实走。
    meta: { effect: "destructive_write", idempotent: false, reversible: true, mayTouchDevice: false },
    plan: `定点替换已有文件：\n${path}\n\n现有 ${st.bytes ?? 0} 字节，把 ${oldText.length} 字换成 ${newText.length} 字；改之前的整份内容宿主留底，回执上可撤销。原文不唯一时宿主会拒改（ambiguous），批准后同样不改盘。`,
  };
}

/**
 * P133-H：撤销一次覆盖/编辑——把宿主留的旧内容写回磁盘。
 *
 * 异步（要等 IPC），`agentRun.undoReceipt` 因此先落"正在写回"中间态再改终态。
 * 两条出声分开报：令牌没了（跨重启、或被有界表挤掉）与写不回去（文件被别的程序占用、
 * 已被移走）是两回事——前者该让 AI 重新改一次，后者该去关掉占着的程序。
 */
async function restoreSnapshot(token: string): Promise<UndoResult> {
  try {
    await invoke("agent_fs_restore", { token, roots: parseFsRoots(getSettings().agentFsRoots) });
    return "undone";
  } catch (e) {
    return String(e).includes("token_expired") ? "token_expired" : "restore_failed";
  }
}

/**
 * fs_edit 的失败分类。Rust 回的 `not_found` / `ambiguous` 是**决策信息**，不能糊成一条 error：
 * 模型对这两者的正确动作完全不同（前者回去核对原文，后者把 old_text 加长或显式 all:true）。
 * 单独成函数是因为它必须可单测——留在管道里，测试看到的只是管道自己那层包装。
 */
export function editFailure(callId: string, err: unknown): ToolResultBody {
  const msg = String(err).replace(/^Error:\s*/, "");
  if (/^(not_found|ambiguous|path_outside_whitelist)/.test(msg)) {
    return notExecuted(callId, msg.split(/[：:]/)[0].trim(), { detail: msg.slice(0, 300) });
  }
  return failed(callId, msg);
}

async function fsEdit(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  const oldText = typeof parsed.old_text === "string" ? parsed.old_text : "";
  const newText = typeof parsed.new_text === "string" ? parsed.new_text : "";
  if (!path || !oldText) {
    return notExecuted(callId, "invalid_args", { hint: "path 与 old_text 必填（old_text 不能为空，空串会命中每一行）" });
  }
  if (!inWhitelist(path)) return wlRefuse(callId, path);
  try {
    /* Tauri 把 Rust 的 snake_case 形名转成 camelCase 作为 JS 侧的键名：这里发 `old_text`
     * 会得到 `invalid args 'oldText'`，**命令根本没被调用**。P109-D 交付时没发现，
     * 因为单测 mock 掉了 invoke——它测的是"我们怎么调自己"，不是"线上是什么键名"。
     * 现在由第 15 道门 check-invoke-args.cjs 钉住整类错误。 */
    const token = crypto.randomUUID();
    const r = await invoke<{ path: string; replacements: number; bytes: number }>("agent_fs_edit", {
      path, oldText, newText,
      all: parsed.all === true,
      token,
      roots: parseFsRoots(getSettings().agentFsRoots),
    });
    return {
      callId, ok: true, status: "applied", undoToken: token,
      data: { path: r.path, replacements: r.replacements, bytes: r.bytes, hint: "已就地替换，宿主留了改之前的整份内容（用户在任务时间线上可撤销）。改完请读回相关片段确认，别只凭回执宣告完成。" },
    };
  } catch (e) {
    return editFailure(callId, e);
  }
}

async function fsList(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
  if (!inWhitelist(path)) return wlRefuse(callId, path);
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

/** fs_write 的前置校验与风险判定：新建=draft_write，覆盖=destructive_write（有快照，可撤销）。 */
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
  if (!inWhitelist(path)) return { refuse: wlRefuse(callId, path) };
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
    // P133-H：覆盖不再是 `irreversible`——宿主真的留了覆盖前的整份内容（agent_tools.rs 的
    // 快照表 + agent_fs_restore）。类名跟着事实走，全权执行档才敢据此放行；
    // 哪天快照没了，这条就得跟着退回 require_local_approval。
    meta: { effect: "destructive_write", idempotent: false, reversible: true, mayTouchDevice: false },
    plan: `覆盖已有文件：\n${path}\n\n现有 ${st.bytes ?? 0} 字节会被替换成新写的 ${content.length} 字符。覆盖前的整份内容宿主留底，回执上可撤销。`,
  };
}

async function fsWrite(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  const path = String(parsed.path ?? "").trim();
  const content = typeof parsed.content === "string" ? parsed.content : "";
  // P133-H：快照令牌由**宿主**生成、随写请求交给 Rust 存底，撤销时用同一个令牌取回。
  // 不让模型给：它能挑路径已经够了，再能挑令牌就等于能指定"撤销要回到哪"。
  const token = crypto.randomUUID();
  let st: FileStat;
  try {
    // 再 stat 一次只为回执说清"覆盖了多少字节"；放行判定已在 assess 里做完，这里不重复设门
    st = await invoke<FileStat>("agent_fs_stat", { path });
    // P99a-A6：写文件走专属命令，白名单根由宿主传入并在 **Rust 侧**判定——
    // 旧实现调通用的 save_text_file（界面导出也在用、不带根判定），门只存在于渲染层。
    await invoke("agent_fs_write", { path, content, token, roots: parseFsRoots(getSettings().agentFsRoots) });
  } catch (e) {
    return failed(callId, e);
  }
  return {
    callId,
    ok: true,
    status: "applied",
    // 新建没有"之前"，就不给 undoToken——给了会长出一颗按了没用的「撤销」（§8-35）
    ...(st.exists ? { undoToken: token } : {}),
    data: {
      path,
      chars: content.length,
      ...(st.exists ? { overwroteBytes: st.bytes ?? 0 } : { created: true }),
      hint: st.exists
        ? "已覆盖旧文件，宿主留了覆盖前的内容（用户在任务时间线上可撤销）。把写入路径告诉用户；下轮再改同一文件会再留一份底"
        : "已新建文件。把写入路径告诉用户",
    },
  };
}

const HOST = { kind: "host" } as const;

/* ================= P133-A：本仓校验（比 shell_exec 窄一档的自证通路） =================
 * 为什么要单独一支工具：AI 要能改本仓源码并**自证没弄坏东西**，唯一办法是跑门禁与测试。
 * 但今天这件事只能走 `shell_exec`，那条的半径是"任意命令"——把"能跑校验"绑在"能跑任何东西"上，
 * 用户就得多开一次他不必要开的闸。这条通路存在的意义就是**不用开那一道**。
 *
 * 差别全在形状上：命令表是这里的常量，模型只给一个 `check` 名，argv 由宿主拼；
 * Rust 侧无 shell 直启（详设 §5-A），所以参数里出现 `&&` / `|` / `>` 也只是字面量。
 *
 * 每一档的 `covers` 都写清了"绿了证明什么、没证明什么"——一条只会说"passed"的门禁
 * 迟早会被读成"这次改动全对"，那正是 §8-41 说的需要对模型兑现的承诺。
 */

export interface RepoCheckSpec {
  labelZh: string;
  /** PATH 上的裸程序名（Rust 侧再钉一次"不许带路径分隔符"） */
  program: string;
  /** 相对被校验仓库根的程序文件，由宿主拼成绝对路径后才下发 */
  script?: string;
  /** 程序自己的固定参数——模型永远拿不到这一格 */
  args?: readonly string[];
  /** 这一档要模型给一个测试文件路径（唯一允许的字面量入参） */
  needsTestPath?: boolean;
  /** 相对仓库根的子目录（cargo 那一档住在 src-tauri） */
  subdir?: string;
  timeoutSecs: number;
  /** 人话：跑的是什么、绿了证明什么、没证明什么 */
  covers: string;
}

export const REPO_CHECKS: Readonly<Record<string, RepoCheckSpec>> = {
  gates: {
    labelZh: "全部工程门禁",
    program: "node",
    script: ".tools/run-gates.mjs",
    timeoutSecs: 600,
    covers:
      "14 道静态门（对比度 / 未声明变量 / 边框预算 / aria / 动效 / 空态话术 / i18n / chrome / 导入成环 / 命令注册 / 视口单位 / 路径可移植 / 审计账 / 死规则）。绿了证明这些预算与契约没被这次改动弄坏；第一道红即止，后面的门不会跑。",
  },
  types: {
    labelZh: "TypeScript 类型检查",
    program: "node",
    script: "node_modules/typescript/bin/tsc",
    args: ["--noEmit"],
    timeoutSecs: 600,
    covers: "全项目类型（不产出文件）。绿了证明类型层自洽；不证明行为正确，也不证明界面好看。",
  },
  tests: {
    labelZh: "全部单元测试",
    program: "node",
    script: "node_modules/vitest/vitest.mjs",
    args: ["run"],
    timeoutSecs: 1200,
    covers: "整条 vitest 套件。绿了证明既有断言全过——注意断言只覆盖被写下来的东西。",
  },
  one_test: {
    labelZh: "单个测试文件",
    program: "node",
    script: "node_modules/vitest/vitest.mjs",
    args: ["run"],
    needsTestPath: true,
    timeoutSecs: 600,
    covers: "只跑一个测试文件（改完一处先跑它，比整条套件快两个数量级）。",
  },
  rust: {
    labelZh: "Rust 侧单元测试",
    program: "cargo",
    args: ["test", "--lib"],
    subdir: "src-tauri",
    timeoutSecs: 1200,
    covers: "Rust 库内单元测试（串口字节解析、白名单判定、文件写序这些宿主权威门住在这里）。",
  },
};

/** `one_test` 唯一允许模型给的字面量：仓库内测试文件的相对路径形状。 */
const TEST_PATH_RE = /^(?:src|scripts)\/[\w.@\-/]+\.test\.(?:ts|tsx|mjs)$/;

export function validRepoTestPath(p: string): boolean {
  if (!p) return false;
  // `..`/`.` 段必须在形状匹配之前先拒：正则里的 `.` 允许它们，归一化又不折叠它们
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return TEST_PATH_RE.test(p);
}

/** 拼进白名单根之下：分隔符跟着用户机器上那个根走，不在这里猜平台。 */
function joinUnderRoot(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const tail = rel.split("/").filter(Boolean).join(sep);
  const head = root.replace(/[\\/]+$/, "");
  return tail ? `${head}${sep}${tail}` : head;
}

export type RepoCheckPlan =
  | { err: string; extra?: Record<string, unknown> }
  | { check: string; labelZh: string; covers: string; argv: string[]; cwd: string; timeoutSecs: number };

/**
 * 纯展开：`check` 名（+ 可选测试路径）→ 具体 argv。不碰 settings、不碰 invoke，
 * 所以"命令表不可被参数扩展"这件事能在单测里逐条钉住。
 */
export function expandRepoCheck(checkId: string, root: string, testPath = ""): RepoCheckPlan {
  const c = REPO_CHECKS[checkId];
  if (!c) return { err: "unknown_check", extra: { check: checkId, allowed: Object.keys(REPO_CHECKS) } };
  if (!root) return { err: "root_required" };
  if (c.needsTestPath) {
    if (!validRepoTestPath(testPath)) {
      return {
        err: "invalid_test_path",
        extra: { testPath, hint: '仓库内测试文件的相对路径，如 "src/features/agent/generalTools.test.ts"' },
      };
    }
  } else if (testPath) {
    return { err: "test_path_not_accepted", extra: { check: checkId } };
  }
  const argv = [c.program];
  if (c.script) argv.push(joinUnderRoot(root, c.script));
  if (c.args) argv.push(...c.args);
  if (c.needsTestPath && testPath) argv.push(testPath);
  return {
    check: checkId,
    labelZh: c.labelZh,
    covers: c.covers,
    argv,
    cwd: c.subdir ? joinUnderRoot(root, c.subdir) : root,
    timeoutSecs: c.timeoutSecs,
  };
}

/** 加上"工作目录只能落在用户白名单里"这一层（与 fs_* 同一条 `inWhitelist` 门）。 */
export function resolveRepoCheck(
  args: Record<string, unknown>,
  roots: string[],
): RepoCheckPlan {
  if (roots.length === 0) {
    return {
      err: "files_whitelist_empty",
      extra: { hint: "设置 → AI 服务 → 「Agent 文件白名单」为空 ⇒ 文件与校验工具关闭；把本仓目录加进去" },
    };
  }
  const wanted = typeof args.root === "string" ? args.root.trim() : "";
  let root = wanted;
  if (!root && roots.length === 1) root = roots[0];
  if (!root) return { err: "root_required", extra: { candidates: roots } };
  // 用**传进来的**那份 roots 判，不在这里再去看一次 settings：同一件事有两个出处，
  // 迟早漂成"调用方以为的门"和"实际的门"不是一扇（这条是 resolveRepoCheck 能被单测跑的原因）
  if (!isUnderRoots(root, roots)) return { err: "path_outside_whitelist", extra: { root, candidates: roots } };
  return expandRepoCheck(
    String(args.check ?? "").trim(),
    root,
    typeof args.testPath === "string" ? args.testPath.trim() : "",
  );
}

async function repoCheck(callId: string, parsed: Record<string, unknown>): Promise<ToolResultBody> {
  // 只取一次：JS 侧的门与 Rust 侧的门必须看到的是**同一份** roots，
  // 分两次读设置就等于允许中间有人换过白名单
  const roots = parseFsRoots(getSettings().agentFsRoots);
  const plan = resolveRepoCheck(parsed, roots);
  if ("err" in plan) return notExecuted(callId, plan.err, plan.extra);
  try {
    const r = await invoke<{
      exitCode: number; stdout: string; stderr: string; timedOut: boolean;
      stdoutBytes: number; stdoutTruncated: boolean; stderrBytes: number; stderrTruncated: boolean;
    }>("agent_repo_check", {
      argv: plan.argv,
      cwd: plan.cwd,
      roots,
      timeoutSecs: plan.timeoutSecs,
    });
    // 退出码非 0 是**一次真观察**（门禁红了），不是工具故障——与 shell_exec 同一个判据。
    // 但"跑完了"和"绿了"必须分开写：只回 exitCode 就等着被读成"它跑了所以没事"。
    return {
      callId,
      ok: true,
      status: "read",
      data: {
        check: plan.check,
        argv: plan.argv,
        cwd: plan.cwd,
        passed: r.exitCode === 0 && !r.timedOut,
        covers: plan.covers,
        ...r,
      },
    };
  } catch (e) {
    return failed(callId, e);
  }
}

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
      `Write a UTF-8 text file inside the Agent file whitelist (设置 → AI 服务 → Agent 文件白名单): reports {path, bytes, created|overwroteBytes}. **Creating a new file applies immediately; overwriting an existing one is a destructive write** — the host keeps the previous content and the receipt carries an undo, but a tier that doesn't grant 文件写入 still asks first. Use it for generated artifacts (configs, scripts, reports, plugin sources) — not for the app's own settings (use settings_apply) or plugins (use save_plugin). Args: { path: string, content: string }. Needs the ${DOMAIN_ZH.write} authorization.`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    summarize: (a) => `写入 ${String(a.path ?? "")}`,
    assess: assessFsWrite,
    approvalBinding: (a) => ({ path: a.path, bytes: String(a.content ?? "").length }),
    undoRoute: (token) => restoreSnapshot(token),
    execute: (a, ctx) => fsWrite(ctx.callId, a),
  }),
  // P109-D：grep / glob / 定点编辑。三者补的是同一句话："它怎么不自己去翻代码"。
  defineTool({
    name: "fs_grep",
    labelZh: "搜索文件内容",
    effect: "read",
    domain: "files",
    provenance: HOST,
    description:
      "Search text inside a whitelisted directory tree (case-insensitive substring, not regex). Skips node_modules/.git/target/dist/out/__pycache__, binary and >1 MiB files; returns {path,line,text} hits capped at 250. **Check `truncated` and `skipped` before concluding something does not exist** — 'no matches' and 'we skipped 37 binary files' are different facts. Args: { root: string, needle: string, max?: number }. Read-only; requires the files authorization domain.",
    parameters: {
      type: "object",
      properties: { root: { type: "string" }, needle: { type: "string" }, max: { type: "number" } },
      required: ["root", "needle"],
      additionalProperties: false,
    },
    summarize: (a) => `搜索 ${String(a.needle ?? "")} @ ${String(a.root ?? "")}`,
    execute: (a, ctx) => fsSearch(ctx.callId, a, "content"),
  }),
  defineTool({
    name: "fs_glob",
    labelZh: "按名字找文件",
    effect: "read",
    domain: "files",
    provenance: HOST,
    description:
      "Find files whose full path contains a substring (case-insensitive; plain substring, not a glob pattern). Same tree rules as fs_grep. Use it to locate a file before reading it. Args: { root: string, needle: string, max?: number }. Read-only; requires the files authorization domain.",
    parameters: {
      type: "object",
      properties: { root: { type: "string" }, needle: { type: "string" }, max: { type: "number" } },
      required: ["root", "needle"],
      additionalProperties: false,
    },
    summarize: (a) => `找文件 ${String(a.needle ?? "")} @ ${String(a.root ?? "")}`,
    execute: (a, ctx) => fsSearch(ctx.callId, a, "paths"),
  }),
  defineTool({
    name: "fs_edit",
    labelZh: "定点改文件",
    // 改的是**已存在**的文件 ⇒ 覆盖类（destructive_write）。P133-H：类名从 irreversible 改成
    // 这个不是放宽措辞，是事实变了——宿主在写之前留了整份旧内容，回执上真能撤销。
    // 静态声明就够准：它永远落在已有文件上（不存在就报 not_found），所以每次都有快照。
    effect: "destructive_write",
    domain: "write",
    provenance: HOST,
    description:
      "Replace an exact substring inside one existing whitelisted file - prefer this over fs_write, which rewrites the whole file and can erase the user's own edits. `old_text` must match byte-for-byte including indentation and newlines; 0 matches returns not_found, several matches returns ambiguous:N and changes nothing (widen old_text to make it unique, or pass all:true to replace every occurrence on purpose). The host keeps the pre-edit copy and the receipt carries an undo. Args: { path: string, old_text: string, new_text: string, all?: boolean }. Read the file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        all: { type: "boolean" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    summarize: (a) => `改 ${String(a.path ?? "")}（${String(a.old_text ?? "").length} → ${String(a.new_text ?? "").length} 字）`,
    assess: assessFsEdit,
    approvalBinding: (a) => ({ path: a.path, chars: String(a.old_text ?? "").length }),
    undoRoute: (token) => restoreSnapshot(token),
    execute: (a, ctx) => fsEdit(ctx.callId, a),
  }),
  // P109-D2：界面能录能放，模型却看不见"录了什么"——app_read 的 session 视图只有当前状态，
  // 明写"无会话列表"。这里补的是那份文件的内容本身，不是回放控制。
  defineTool({
    name: "session_read",
    labelZh: "读会话文件",
    effect: "read",
    domain: "files",
    provenance: HOST,
    description:
      `Inspect a recorded session file (.usess) inside the Agent file whitelist, read-only and without loading it into playback. Args: { path: string, mode?: "summary" | "frames" | "annotations" (default summary), cursor?: number, limit?: number (default and cap 40) }. summary gives file meta (port, duration, template count) plus a template/field histogram built from **at most the first 200 batches** - histogramCovers and truncated say how much of the file it actually saw, so a histogram is never a census. frames pages the merged timeline ({kind:"rx"|"tx"|"frames"}) with hex capped at 64 bytes per chunk and rowsTruncated/fieldsTruncated on parsed frames; advance with cursor=nextCursor until truncated is false before concluding anything about counts. annotations lists timeline notes. Find files first with fs_glob { pattern: "*.usess" }. This never starts or stops recording; requires the ${DOMAIN_ZH.files} authorization.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: [...SESSION_MODES] },
        cursor: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    summarize: (a) => `读会话 ${String(a.path ?? "").split(/[/\\]/).pop()} · ${String(a.mode ?? "summary")}`,
    execute: (a, ctx) => sessionRead(ctx.callId, a),
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
  defineTool({
    name: "repo_check",
    labelZh: "跑本仓校验",
    // 与 shell_exec 同一类：都是"在这台机器上起一个进程"，§8-44 把命令行列为四类逐次批准之一。
    // 半径的差别在形状上：那一条能跑任何东西，这一条只能跑命令表里那五档，且无 shell。
    effect: "irreversible",
    domain: "files",
    provenance: HOST,
    description:
      `Run THIS REPOSITORY's own verification commands and get back the real exit code plus output. The command table is a host constant — there is no \`command\` parameter, no flags and no working directory for you to pick: argv is assembled from that table and spawned WITHOUT a shell, so \`&&\`, \`|\` and \`>\` inside an argument stay literals. Args: { check: one of ${Object.keys(REPO_CHECKS).join("|")}, root?: string (must be one of the whitelisted dirs; needed only when more than one is whitelisted), testPath?: string (one_test only, repo-relative) }. The receipt carries { check, argv, cwd, passed, exitCode, timedOut, stdout, stdoutTruncated, stderrBytes } where passed = exitCode===0 && !timedOut. Two rules: (1) never tell the user a source change is verified without a repo_check receipt with passed:true — "I edited the file" is not "the gates are green"; (2) one family being green does not mean everything is fine: each check's \`covers\` states plainly what it does NOT prove (static gates cannot see runtime pixels — for what is actually on screen run theme_audit). Needs the ${DOMAIN_ZH.files} authorization domain plus the "Agent 允许跑本仓校验" master switch in settings; on the 界面创造 tier each run also needs one user approval, while 全权执行 runs it without a card because every parameter comes from a host constant table.`,
    parameters: {
      type: "object",
      properties: {
        check: { type: "string", enum: Object.keys(REPO_CHECKS) },
        root: { type: "string" },
        testPath: { type: "string" },
      },
      required: ["check"],
      additionalProperties: false,
    },
    summarize: (a) => `跑本仓校验「${String(a.check ?? "")}」${a.testPath ? ` · ${String(a.testPath).slice(0, 40)}` : ""}`,
    /** 总开关关着就地拒、**不弹批准卡**（与 shell_exec 同一条理由：白要一次人工确认＝把用户训练成橡皮图章） */
    assess: (a, ctx) => {
      if (!getSettings().agentRepoCheck) {
        return {
          refuse: notExecuted(ctx.callId, "repo_check_disabled", {
            hint: "设置 → AI 服务 → 「Agent 允许跑本仓校验」总开关未开启",
          }),
        };
      }
      const plan = resolveRepoCheck(a, parseFsRoots(getSettings().agentFsRoots));
      if ("err" in plan) return { refuse: notExecuted(ctx.callId, plan.err, plan.extra) };
      return {
        // P133-H：`hostBounded` 是它敢在全权执行档跳过批准卡的**唯一**理由——
        // argv 全部来自宿主常量表、无 shell、cwd 必须在白名单内、超时钳死，模型只能挑枚举档。
        // 隔壁 shell_exec 拿的是自由文本，所以永远不算 hostBounded（见 toolPolicy.ts）。
        meta: { effect: "irreversible", idempotent: true, reversible: false, mayTouchDevice: false, hostBounded: true },
        plan:
          `将执行（无 shell、argv 直启，超时 ${plan.timeoutSecs}s）：\n${plan.argv.join(" ")}\n\n` +
          `工作目录：${plan.cwd}\n\n这一档跑的是：${plan.covers}`,
      };
    },
    /** 令牌绑**展开后的 argv**而不是原始参数：白名单被换掉时同一份参数指的是另一条命令，
     *  那一次批准不该复用（默认按 args 哈希就复用上去了）。 */
    approvalBinding: (a) => {
      const p = resolveRepoCheck(a, parseFsRoots(getSettings().agentFsRoots));
      return "argv" in p ? { check: p.check, argv: p.argv, cwd: p.cwd } : { check: String(a.check ?? "") };
    },
    execute: (a, ctx) => repoCheck(ctx.callId, a),
  }),
];
