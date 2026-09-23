/**
 * P99c-C1b：命令行插件工具的**纯逻辑**（参数解析 / 命令→动作映射 / 输出渲染）。
 *
 * 单独一个文件只为一件事：**能被测试**。带 `main()` 的那个文件与 mcp-cli 同形
 * （模块加载即运行），vitest 引不到它；而"哪条命令发哪个 kind""截断有没有说"
 * 恰恰是最该钉的三件。
 */

/** 命令 → 桥上的 `cli.` 动作。装包是**异步**的：`install` 只起一次请求，`progress` 问结果 */
export const COMMANDS = {
  status: "cli.market_status",
  list: "cli.market_list",
  info: "cli.market_info",
  installed: "cli.plugins_installed",
  install: "cli.plugin_install",
  progress: "cli.plugin_status",
} as const;

export type Command = keyof typeof COMMANDS;

/**
 * P99b-N6：`validate` 是**本地命令**——不连应用、不联网、不读设置（详设 §2E）。
 * 它不进 `COMMANDS` 那张表，正是为了保住"这张表里的每一条都走桥"那条钉：
 * 哪天有人给它加个 `cli.market_validate`，投稿校验就又开始要求"应用得先开着"，那句话就退回假话。
 */
export const LOCAL_COMMANDS = ["validate"] as const;
export type LocalCommand = (typeof LOCAL_COMMANDS)[number];

/** 需要跟一个位置参数（id / token / 路径）的命令 */
const NEEDS_ARG: readonly string[] = ["info", "install", "progress", "validate"];

export interface Parsed {
  command: Command | LocalCommand;
  /** 位置参数（`info <id>`、`install <id>`、`progress <token>`、`validate <路径>` 用） */
  id: string;
  query: string;
  category: string;
  sort: string;
  limit: number;
  /** `install` 替人等多久（秒）。等不到终态只说"我没等到"，不下结论 */
  wait: number;
  json: boolean;
  help: boolean;
}

/** 默认与封顶：与货架索引的取回量级相称，也不超过应用侧那张表 10 分钟的窗口 */
export const WAIT_DEFAULT_S = 120;
export const WAIT_MAX_S = 600;

export const USAGE = [
  "uartix-plugin —— 在终端里看与装 Uartix+ 的插件货架",
  "",
  "用法：uartix-plugin <命令> [选项]",
  "  status                 货架状态：几条 / 有没有被剔除 / 走了镜像没 / 上次失败原因",
  "  list [--query 词] [--category id] [--sort updated|name|category] [--limit N]",
  "                         列出货架条目（含与本机对照的结果）",
  "  info <id>              看一条：能力逐条人话、来源、字节、哈希前 12 位",
  "  installed              本机库与货架的对照（只按 id，不猜）",
  "  install <id> [--wait 秒]  起一次装包请求并等它跑完（默认等 120 秒，封顶 600）",
  "  progress <token>       问一次某次请求到哪一步了（token 由 install 给出）",
  "",
  "本地命令（不用开应用、不联网）：",
  "  validate <包路径>      投稿前自检：跑的就是上架会跑的那几道校验器。",
  "                         路径给 market/pkg/<名>.uartix.json 或目录源 market/pkg/<名>/manifest.json；",
  "                         回执会列出跑了哪几道、用的哪一版校验器。退出码 0 通过 / 1 不通过。",
  "",
  "  --json                 机器可读输出（脚本里用）",
  "  --help                 这段字",
  "",
  "除 validate 外的前提：Uartix+ 正在运行且 设置 → 集成 打开了「启用 MCP 桥」。",
  "装新包是停用态、随时可卸载，所以命令行全程零打断；",
  "覆盖已有版本会停在「等你确认」：要点开 Uartix+ 的 设置 → 插件管理 在确认卡上点「装入」——",
  "这里没有跳过确认的开关（那等于让终端替本机决定装谁的代码）。",
  "卸载与启停不在命令行：那是删本机内容的动作，单独一批做。",
].join("\n");

const BRIDGE_WORDS = Object.keys(COMMANDS) as Command[];
const COMMAND_WORDS = [...BRIDGE_WORDS, ...LOCAL_COMMANDS] as (Command | LocalCommand)[];

/** 解析命令行。返回 `help:true` 表示该打用法；抛错表示这个参数根本没法执行（不猜默认值）。 */
export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { command: "status", id: "", query: "", category: "", sort: "", limit: 0, wait: WAIT_DEFAULT_S, json: false, help: false };
  const args = [...argv];
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { ...out, help: true };
  }
  const word = args.shift() as string;
  if (!(COMMAND_WORDS as string[]).includes(word)) {
    throw new Error(`没有这个命令：${word}。可用：${COMMAND_WORDS.join(" / ")}（或 --help）`);
  }
  out.command = word as Command;
  while (args.length) {
    const a = args.shift() as string;
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      if (out.id) throw new Error(`只接受一个参数，多出来的是：${a}`);
      out.id = a;
      continue;
    }
    const key = a.slice(2);
    const val = args.shift() ?? "";
    if (!val) throw new Error(`--${key} 后面要跟一个值`);
    if (key === "query") out.query = val;
    else if (key === "category") out.category = val;
    else if (key === "sort") out.sort = val;
    else if (key === "limit") {
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit 要正整数，收到 ${val}`);
      out.limit = n;
    } else if (key === "wait") {
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--wait 要正整数（秒），收到 ${val}`);
      out.wait = Math.min(n, WAIT_MAX_S);
    } else throw new Error(`不认识选项 --${key}（--help 看可用项）`);
  }
  if (NEEDS_ARG.includes(out.command) && !out.id) {
    const want =
      out.command === "progress"
        ? "token（install 给的那串）"
        : out.command === "validate"
          ? "包路径（market/pkg/<名>.uartix.json，或目录源 market/pkg/<名>/manifest.json）"
          : "货架 id（用 list 先查）";
    throw new Error(`${out.command} 要跟一个参数：${want}`);
  }
  if (!["list", "status", "installed"].includes(out.command) && (out.query || out.category || out.sort || out.limit)) {
    throw new Error(`${out.command} 不接受 ${out.query ? "--query" : out.category ? "--category" : out.sort ? "--sort" : "--limit"}`);
  }
  if (out.command !== "install" && out.wait !== WAIT_DEFAULT_S) throw new Error("--wait 只对 install 有意义");
  return out;
}

/** 这条命令是不是本地跑的（不发桥） */
export function isLocalCommand(command: Command | LocalCommand): boolean {
  return (LOCAL_COMMANDS as readonly string[]).includes(command);
}

/** 命令 → 动作；顺手守住"这条通道只发 `cli.`"（越界就是设计被改坏了） */
export function kindFor(command: Command | LocalCommand): string {
  if (isLocalCommand(command)) {
    throw new Error(`内部错误：${command} 是本地命令，不该来要桥动作（发桥的只有 ${BRIDGE_WORDS.join(" / ")}）`);
  }
  const kind = COMMANDS[command as Command];
  if (!kind.startsWith("cli.")) throw new Error(`内部错误：${command} 映射到了非命令行动作 ${kind}`);
  return kind;
}

/** 发给应用侧的参数：只带这条命令用得到的字段（不把空选项当"什么都要"传过去） */
export function argsFor(p: Parsed): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  if (p.command === "list") {
    if (p.query) a.query = p.query;
    if (p.category) a.category = p.category;
    if (p.sort) a.sort = p.sort;
    if (p.limit) a.limit = p.limit;
  }
  if (p.command === "info" || p.command === "install") a.id = p.id;
  if (p.command === "progress") a.token = p.id;
  return a;
}

/** 轮询用的参数（install 起来之后按 token 问） */
export function progressArgs(token: string): Record<string, unknown> {
  return { token };
}

export interface PollVerdict {
  /** 该不该停止轮询 */
  settled: boolean;
  /** 进程退出码：0 装好了 / 1 没装或没等到 */
  exit: 0 | 1;
  /** 打给人看的最后一行 */
  line: string;
}

/**
 * 一次轮询结果 → 要不要继续问。**这条判据只认应用侧给的 phase**，CLI 自己不算时间也不猜结论。
 * `working`/`awaiting_you` 之外都是终态；`gone`（token 过期或被淘汰）也终态但要说清"本机可能已经变了"。
 */
export function pollVerdict(data: unknown): PollVerdict {
  const d = (data ?? {}) as Record<string, unknown>;
  const phase = String(d.phase ?? "");
  const text = String(d.text || d.msg || "");
  if (phase === "done") return { settled: true, exit: 0, line: text };
  if (phase === "failed" || phase === "rejected" || phase === "gone") {
    return { settled: true, exit: 1, line: text };
  }
  if (phase === "awaiting_you") return { settled: true, exit: 1, line: `${text}\n停在「等你确认」：点开 Uartix+ 的 设置 → 插件管理 在确认卡上点「装入」，或再问一次 progress ${String(d.token ?? "")}` };
  if (phase === "working") return { settled: false, exit: 1, line: text };
  // 认不出来的 phase 就说认不出来，不把它翻译成一个像样的结论（§8-46 那条同族）
  return { settled: true, exit: 1, line: `应用给了一个我不认识的状态「${phase || "(空)"}」：原话是「${text || "没有正文"}」` };
}

/** 等不到终态时的那句人话：重点是"我不知道结果"，不是"失败了" */
export function waitedOutLine(token: string, seconds: number): string {
  return `我没等到回执（等了 ${seconds} 秒）。这不等于没装上：去 Uartix+ 的 设置 → 插件管理 看，或再问一次 progress ${token}`;
}

function line(...cells: (string | number)[]): string {
  return cells.map((c) => String(c)).join("  ");
}

export interface RenderInput {
  parsed: Parsed;
  data: unknown;
}

/** 人读输出。三件必须说清的：列了几条 / 有没有截断 / 索引此刻不可用时为什么。 */
export function render({ parsed, data }: RenderInput): string {
  const d = (data ?? {}) as Record<string, unknown>;
  if (parsed.command === "status") {
    const bits = [
      `状态 ${String(d.status ?? "?")}`,
      `${String(d.entries ?? 0)} 条`,
      `被剔除 ${String(d.dropped ?? 0)} 条`,
      `收藏 ${String(d.favorites ?? 0)} 条`,
      d.viaMirror ? "走的镜像" : "",
      d.appVersion ? `本机 v${String(d.appVersion)}` : "本机版本未知",
    ].filter(Boolean);
    return [bits.join(" · "), d.error ? `上次失败：${String(d.error)}` : "", d.source ? `来源：${String(d.source)}` : ""]
      .filter(Boolean)
      .join("\n");
  }
  if (parsed.command === "list") {
    const cards = (d.cards ?? []) as Record<string, unknown>[];
    const head = [`货架 ${String(d.total ?? cards.length)} 条${d.shown && d.shown !== d.total ? `，这里列 ${String(d.shown)} 条` : ""}`];
    if (Array.isArray(d.categories) && d.categories.length) head.push(`分类：${(d.categories as string[]).join(" | ")}`);
    const rows = cards.map((c) =>
      line(
        `${String(c.name)}〈${String(c.category)}〉`,
        `v${String(c.version)}`,
        String(c.install ?? ""),
        ((c.caps ?? []) as string[]).join("、"),
      ),
    );
    const tail = [
      d.truncated ? String(d.truncated) : "",
      d.note ? String(d.note) : "",
      cards.length ? "" : "（一条也没有：上面那句就是原因）",
    ].filter(Boolean);
    return [...head, ...rows, ...tail].join("\n");
  }
  if (parsed.command === "info") {
    const caps = (d.caps ?? []) as { name: string; note: string; blocked: boolean }[];
    return [
      line(`${String(d.name)}〈${String(d.category)}〉`, `v${String(d.version)}`, String(d.install ?? "")),
      `作者 ${String(d.author ?? "?")} · 更新于 ${String(d.updated ?? "?")} · ${String(d.size ?? "")} · sha256 ${String(d.sha256_12 ?? "")}… · ${String(d.screenshots ?? 0)} 张图`,
      `${String(d.compat ?? "")}`,
      `${String(d.descZh ?? "")}`,
      ...caps.map((c) => `  ${c.blocked ? "〔不放行〕" : ""}${c.name}：${c.note}`),
      String(d.note ?? ""),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (parsed.command === "install") {
    const bits = [String(d.msg ?? ""), String(d.note ?? "")].filter(Boolean);
    return [d.ok ? "已受理（还没装好，正在应用里跑）" : "没有开始", ...bits].join("\n");
  }
  if (parsed.command === "progress") {
    const bits = [`${String(d.phase ?? "?")}｜${String(d.phaseText ?? d.msg ?? "")}`];
    if (d.entryId) bits.push(String(d.entryId));
    if (d.code) bits.push(`码 ${String(d.code)}`);
    if (typeof d.awaiting === "number" && d.awaiting > 0) bits.push(`另有 ${String(d.awaiting)} 条等你确认`);
    return [bits.join(" · "), String(d.text ?? "")].filter(Boolean).join("\n");
  }
  const on = (d.onShelf ?? []) as Record<string, unknown>[];
  const off = (d.offShelf ?? []) as Record<string, unknown>[];
  return [
    `本机 ${String(d.total ?? 0)} 个包`,
    ...on.map((r) => line(`${String(r.name)}`, `本机 v${String(r.local)}`, `货架 v${String(r.shelf)}`, String(r.state ?? ""))),
    off.length ? `不在货架上的 ${off.length} 个：${off.map((r) => `${String(r.name)} v${String(r.version)}（${String(r.state)}）`).join("、")}` : "",
    off.length ? String(d.offShelfNote ?? "") : "",
  ]
    .filter(Boolean)
    .join("\n");
}
