/**
 * P99c-C1b：命令行插件工具的**纯逻辑**（参数解析 / 命令→动作映射 / 输出渲染）。
 *
 * 单独一个文件只为一件事：**能被测试**。带 `main()` 的那个文件与 mcp-cli 同形
 * （模块加载即运行），vitest 引不到它；而"哪条命令发哪个 kind""截断有没有说"
 * 恰恰是最该钉的三件。
 */

/** 命令 → 桥上的 `cli.` 动作。**装包/更新不在这里**（要走任务面，下一批） */
export const COMMANDS = {
  status: "cli.market_status",
  list: "cli.market_list",
  info: "cli.market_info",
  installed: "cli.plugins_installed",
} as const;

export type Command = keyof typeof COMMANDS;

export interface Parsed {
  command: Command;
  /** 位置参数（`info <id>` 用） */
  id: string;
  query: string;
  category: string;
  sort: string;
  limit: number;
  json: boolean;
  help: boolean;
}

export const USAGE = [
  "uartix-plugin —— 在终端里看 Uartix+ 的插件货架（只读）",
  "",
  "用法：uartix-plugin <命令> [选项]",
  "  status                 货架状态：几条 / 有没有被剔除 / 走了镜像没 / 上次失败原因",
  "  list [--query 词] [--category id] [--sort updated|name|category] [--limit N]",
  "                         列出货架条目（含与本机对照的结果）",
  "  info <id>              看一条：能力逐条人话、来源、字节、哈希前 12 位",
  "  installed              本机库与货架的对照（只按 id，不猜）",
  "",
  "  --json                 机器可读输出（脚本里用）",
  "  --help                 这段字",
  "",
  "前提：Uartix+ 正在运行且 设置 → 集成 打开了「启用 MCP 桥」。",
  "装包与更新暂时不在命令行里：那条路要走任务面（桥单次调用只等 3 秒），下一批接。",
].join("\n");

const COMMAND_WORDS = Object.keys(COMMANDS) as Command[];

/** 解析命令行。返回 `help:true` 表示该打用法；抛错表示这个参数根本没法执行（不猜默认值）。 */
export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { command: "status", id: "", query: "", category: "", sort: "", limit: 0, json: false, help: false };
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
      if (out.id) throw new Error(`只接受一个 id，多出来的是：${a}`);
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
    } else throw new Error(`不认识选项 --${key}（--help 看可用项）`);
  }
  if (out.command === "info" && !out.id) throw new Error("info 要跟一个货架 id（用 list 先查）");
  if ((out.command === "info" || out.command === "installed") && (out.query || out.category || out.sort)) {
    throw new Error(`${out.command} 不接受 ${out.query ? "--query" : out.category ? "--category" : "--sort"}`);
  }
  return out;
}

/** 命令 → 动作；顺手守住"这条通道只发 `cli.`"（越界就是设计被改坏了） */
export function kindFor(command: Command): string {
  const kind = COMMANDS[command];
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
  if (p.command === "info") a.id = p.id;
  return a;
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
  const on = (d.onShelf ?? []) as Record<string, unknown>[];
  const off = (d.offShelf ?? []) as Record<string, unknown>[];
  return [
    `本机 ${String(d.total ?? 0)} 个包`,
    ...on.map((r) => line(`${String(r.name)}`, `本机 v${String(r.local)}`, `货架 v${String(r.shelf)}`, String(r.state ?? ""))),
    off.length ? `不在货架上的 ${off.length} 个：${off.map((r) => String(r.name)).join("、")}` : "",
    off.length ? String(d.offShelfNote ?? "") : "",
  ]
    .filter(Boolean)
    .join("\n");
}
