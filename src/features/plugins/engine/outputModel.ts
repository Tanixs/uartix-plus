/**
 * P174-R7②：「运行日志」这一面的**纯形状**（行模型 + 过滤 + 成文）。
 *
 * 为什么单独一个文件：这一面的价值全在"看得懂、筛得动"，而那两件事错了都是**静默**的——
 * 过滤条件写反了不会报错，只会让用户在 500 行里自己找错误；账本事件漏了一类也不会报错，
 * 只会让"谁批准了哪一版"这条链在这一面上缺一块。所以判据要能脱离 Tauri、脱离 React 被逐条钉住。
 *
 * 两个通道故意不是一条总线：
 *  - `host` 是**进程说的话**（stdout/stderr、协议层日志），活在内存环形缓冲里，现在也落一份盘；
 *  - `ledger` 是**应用对插件做过什么**（装/批/启用/命令/场景），append-only、可重放校验。
 * 两者的寿命与可信度都不一样，合成一条流就等于把"插件说自己错了"和"用户让它做的"排在一起。
 */

import type { InstalledPlugin } from "./pluginEngine";
import type { PluginLogLevel, PluginLogLine, PluginPhase } from "./runtime";
import type { JournalEvent } from "./journal";

export type OutputChannel = "host" | "ledger";

/** 一行给人看的东西。`at` 为 0 = 没有时刻（账本里的老事件不该假装知道时间）。 */
export interface OutputLine {
  at: number;
  channel: OutputChannel;
  /** 哪个插件（通道内用）；账本里主题事件可以为空。 */
  pluginId: string;
  pluginName: string;
  level: PluginLogLevel;
  text: string;
}

/** 级别的可比序：筛"警告及以上"这种判据靠它，不靠字符串比较。 */
export const LEVEL_ORDER: Record<PluginLogLevel, number> = {
  debug: 0,
  raw: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export const HOST_LEVELS: PluginLogLevel[] = ["debug", "raw", "info", "warn", "error"];

/** 这一面能显示哪两个通道（UI 的通道选择器由这里派生，不另写一份清单）。 */
export const CHANNELS: { id: OutputChannel; zh: string; en: string }[] = [
  { id: "host", zh: "宿主输出", en: "Host output" },
  { id: "ledger", zh: "操作账本", en: "Action ledger" },
];

/** 落盘上限。真正的轮转（从头部截、保尾巴、只断在换行）在 Rust 的 `plugin_fs_append` 里做。 */
export const LOG_CAP_BYTES = 2 * 1024 * 1024;

/** 一行进程日志落盘的形状：`[ISO 时刻] [级别] 文本`。级别留着，否则 grep 只能靠猜。 */
export function formatHostLine(line: PluginLogLine): string {
  return `[${new Date(line.at).toISOString()}] [${line.level}] ${line.text}`.replace(/\r?\n/g, "\n");
}

/**
 * 一批攒好的日志 → 一次追加的内容。
 *
 * 分隔符固定 `\n`：Windows 上混进 `\r` 会让这份文件每一行都带个看不见的尾巴，
 * 而 grep/复制出来的文本会多一个空字符。
 */
export function logBatchText(lines: readonly PluginLogLine[]): string {
  if (!lines.length) return "";
  return lines.map(formatHostLine).join("\n") + "\n";
}

/** 进程日志 → 行模型。名称由调用方给（列表里现成的 manifest.name，不在这儿查表）。 */
export function hostLinesOf(p: { id: string; name: string }, logs: readonly PluginLogLine[]): OutputLine[] {
  return logs.map((l) => ({
    at: l.at,
    channel: "host" as const,
    pluginId: p.id,
    pluginName: p.name,
    level: l.level,
    text: l.text,
  }));
}

/** 把所有插件的进程日志按时间汇成一列（多插件并行时的读法就是这个顺序）。 */
export function hostLinesOfAll(entries: readonly InstalledPlugin[]): OutputLine[] {
  const out: OutputLine[] = [];
  for (const e of entries) out.push(...hostLinesOf({ id: e.id, name: e.manifest.name }, e.logs));
  return out.sort((a, b) => a.at - b.at);
}

/** 账本事件里 `id` 是哪个插件；主题类事件没有插件，落空串（过滤器据此放行）。 */
function pluginIdOfEvent(ev: JournalEvent): string {
  return ev.t === "theme" ? "" : ev.id;
}

/**
 * 一条账本事件 → 一句话说的是什么。
 *
 * 八类事件在这里**穷举**：以后 `journal.ts` 加一类而这里没加，TS 会当场报错——
 * 这一面最怕的就是"账本里有、这一面看不见"，所以宁可让编译器盯着。
 */
export function describeJournalEvent(
  ev: JournalEvent,
  nameOf: (id: string) => string,
): { text: string; level: PluginLogLevel } {
  // 主题事件没有插件归属（它记的是"界面在用什么"，不是"某个插件怎么了"），所以先判它
  const name = ev.t === "theme" ? "" : nameOf(ev.id) || ev.id;
  switch (ev.t) {
    case "install":
      return { text: `安装 ${name} v${ev.item.version}（${ev.item.source}）`, level: "info" };
    case "uninstall":
      return { text: `卸载 ${name}`, level: "warn" };
    case "enable":
      return { text: `启用 ${name}`, level: "info" };
    case "disable":
      return { text: `停用 ${name}`, level: "info" };
    case "theme":
      return { text: `切换主题 ${ev.key || "（回到内置）"}`, level: "info" };
    case "approve":
      return { text: `批准 ${name} v${ev.trust.version} 的权限（${ev.trust.grantedSummary.length} 项）`, level: "info" };
    case "command":
      // `ok` 是"这次执行有没有结果"，不是"插件逻辑成不成功"——文案不能说成"命令失败"
      return { text: `执行命令 ${ev.command}：${ev.ok ? "有结果" : "无结果/出错"}`, level: ev.ok ? "info" : "error" };
    case "profile":
      return {
        text: `场景「${ev.name}」${ev.action === "apply" ? "已应用" : "已回退"}`,
        level: "info",
      };
    case "root": {
      // 绑定表是进程写笼子的来源，所以**给了写目录**要显眼一点（warn），只读绑定与清除是普通事实
      const who = ev.id ? nameOf(ev.id) || ev.id : "用户自己";
      const to = ev.path || "（清除）";
      return { text: `绑定 ${ev.spec} → ${to}（${who} · ${ev.forWrite ? "写" : "只读"}）`, level: ev.forWrite && ev.path ? "warn" : "info" };
    }
  }
}

/** 账本（oldest→newest）→ 行模型，最新在前由调用方决定。 */
export function ledgerLinesOf(book: readonly JournalEvent[], nameOf: (id: string) => string): OutputLine[] {
  return book.map((ev) => {
    const d = describeJournalEvent(ev, nameOf);
    return {
      at: ev.at,
      channel: "ledger" as const,
      pluginId: pluginIdOfEvent(ev),
      pluginName: ev.t === "theme" ? "主题" : nameOf(ev.id) || ev.id,
      level: d.level,
      text: d.text,
    };
  });
}

export interface OutputFilter {
  channel: OutputChannel;
  /** 空串 = 全部插件（账本通道的主题事件不受影响）。 */
  pluginId: string;
  /** 显示这个级别**及以上**；`null` = 全部。 */
  minLevel: PluginLogLevel | null;
  query: string;
}

/**
 * 过滤。三条判据都是"漏了不会报错"的那类，所以逐条钉：
 *  - 关键词**大小写不敏感**（用户在找 `EACCES`，日志里写的是 `eacces` 也得出来）；
 *  - 账本通道按插件筛时，主题事件（没有插件归属）在"全部插件"下必须可见；
 *  - `minLevel` 用序而不是等值，"警告及以上"要能同时给出 warn 与 error。
 */
export function filterLines(lines: readonly OutputLine[], f: OutputFilter): OutputLine[] {
  const q = f.query.trim().toLowerCase();
  return lines.filter((l) => {
    if (l.channel !== f.channel) return false;
    if (f.pluginId && l.pluginId !== f.pluginId) return false;
    if (f.minLevel && LEVEL_ORDER[l.level] < LEVEL_ORDER[f.minLevel]) return false;
    if (q && !`${l.pluginName} ${l.text}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** 复制/存文件用的成文：最新在上（与屏幕一致），时刻用本地时区而不是 ISO——给人读的。 */
export function renderText(lines: readonly OutputLine[], withTime = true): string {
  return lines.map((l) => `${withTime && l.at ? `${hhmmss(l.at)} ` : ""}[${l.level}] ${l.pluginName ? `${l.pluginName} · ` : ""}${l.text}`).join("\n");
}

function p2(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** 屏幕上的时刻：`HH:MM:SS.mmm`。毫秒留着——宿主启动的竞态就发生在百毫秒级。 */
export function hhmmss(at: number): string {
  if (!at) return "--:--:--";
  const d = new Date(at);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`;
}

/**
 * 上一次的状态 → 这一次，哪些插件**新落到 failed**。
 *
 * 只报 failed，不报 stopped：`stopped` 有两种来路（进程自己退了 / 空闲 60 秒被回收），
 * 后者是设计里的正常回收，为它弹一条通知就是把正常行为当错误喊。
 * 而 `failed` 一定得有人看见——它意味着"点了没反应，但没人说为什么"。
 */
export function newlyFailed(
  prev: Readonly<Record<string, PluginPhase>>,
  entries: readonly InstalledPlugin[],
): { id: string; name: string; error: string }[] {
  const out: { id: string; name: string; error: string }[] = [];
  for (const e of entries) {
    if (e.phase !== "failed") continue;
    if (prev[e.id] === "failed") continue; // 已经failed过：不该每次刷新都喊一遍
    out.push({ id: e.id, name: e.manifest.name, error: e.error ?? "" });
  }
  return out;
}

/**
 * 这一面顶部那句状态：谁在跑、有多少错误。
 *
 * `running === 0 && errored > 0` 这一支是真机最常见的形状——插件崩了、面板关了，
 * 用户只剩这一面能看见它挂过。
 */
export function statusOf(entries: readonly InstalledPlugin[]): {
  running: { id: string; name: string; phase: PluginPhase; pid?: number }[];
  errored: number;
} {
  const running = entries
    .filter((e) => e.phase === "running" || e.phase === "starting")
    .map((e) => ({ id: e.id, name: e.manifest.name, phase: e.phase, pid: e.pid }));
  const errored = entries.reduce((n, e) => n + e.logs.filter((l) => l.level === "error").length, 0);
  return { running, errored };
}
