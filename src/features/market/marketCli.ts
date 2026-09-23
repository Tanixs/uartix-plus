/**
 * P99c-C1b/C1c：命令行专用动作（`cli.*`）——四条只读 + 装包的**异步写侧**。
 *
 * 为什么单独一个命名空间而不加进 MCP 工具清单：Q7 的口径是**陌生人的代码进本机由人批准**
 * （模型能装自己生成的包，那条链在 `localEntries` 里；但货架这条链它够不到）——
 * 装第三方代码是"做了收不回"的动作，而模型能读到的判断材料（描述/manifest/作者名）都是投稿人写的。
 * `scripts/mcp-cli.ts` 只转发 `ALL_TOOL_DEFS` 里有的名字，所以 `cli.` 从模型那条路**够不到**；
 * 反过来 `scripts/plugin-cli.ts` 只发 `cli.`。两条通道各自收窄，各有一条测试钉着。
 *
 * 一条硬约束决定了形态：**桥在 Rust 侧只等 3 秒**（`bridge.rs: CALL_TIMEOUT`）。
 * 所以：索引没拉过时"起一次拉取、最多等 1.5 秒、拿不到就说还在拉"；装包这种可能几十秒的活
 * **绝不在一次调用里等**——`cli.plugin_install` 只起一张异步请求并立刻回 token，
 * CLI 拿 token 去轮 `cli.plugin_status`（详设 §8.1；为什么不借道 jobs 任务面见 `marketPending.ts` 头注释）。
 */
import { PLUGIN_STATE_LABEL, getSnapshot as getPlugins } from "../plugins/pluginStore";
import { browseEntries, cardFacts, emptyTalk, facetCategories, missingFavorites, offShelfOf, type BrowseContext } from "./marketBrowse";
import { compareInstall } from "./marketIndex";
import { awaitingMarketInstalls, readMarketPending, requestMarketInstall } from "./marketPending";
import { getMarketSnapshot, refreshIndex } from "./marketStore";

/** 一次最多列这么多：截断必须说"还有几条"，不能静默少给（A7） */
const LIST_PAGE = 50;
/** 索引冷启动时最多替调用法等这么久（桥的上限是 3 秒，留一半余量回话） */
const REFRESH_WAIT_MS = 1500;

export type CliKind =
  | "cli.market_status"
  | "cli.market_list"
  | "cli.market_info"
  | "cli.plugins_installed"
  | "cli.plugin_install"
  | "cli.plugin_status";

/** 命令行开放的全部 kinds。装包这条是**异步的**：`plugin_install` 只起一次请求并立刻回 token。 */
export const CLI_KINDS: readonly CliKind[] = [
  "cli.market_status",
  "cli.market_list",
  "cli.market_info",
  "cli.plugins_installed",
  "cli.plugin_install",
  "cli.plugin_status",
];

/** 命令行通道的命名空间前缀（`mcpServer` 用它决定路由，`plugin-cli` 用它自检只发这一族） */
export const CLI_PREFIX = "cli.";

export function isCliKind(kind: string): boolean {
  return kind.startsWith(CLI_PREFIX);
}

/** 命令行输出用中文（与其它 CLI 一致；终端里没有界面语言这回事） */
function browseCtx(): BrowseContext {
  const snap = getMarketSnapshot();
  const versions = new Map(getPlugins().plugins.map((r) => [r.pkg.id, r.pkg.version]));
  return {
    lang: "zh",
    appVersion: snap.appVersion,
    favorites: snap.favorites,
    installOf: (e) => compareInstall(e, versions.get(e.id)),
  };
}

/** 索引没就绪时的有界等待：起一次拉取，最多等 REFRESH_WAIT_MS，不撒谎也不挂死 */
async function indexReady(): Promise<{ index: ReturnType<typeof getMarketSnapshot>["index"]; note: string }> {
  const cur = getMarketSnapshot();
  if (cur.index) return { index: cur.index, note: "" };
  if (cur.status === "idle" || cur.status === "failed") void refreshIndex();
  await new Promise((r) => setTimeout(r, REFRESH_WAIT_MS));
  const after = getMarketSnapshot();
  return {
    index: after.index,
    note: after.index
      ? ""
      : `索引还没拿到（桥只等 3 秒，我不挂着）：稍后再问一次，或在应用里打开 设置 → 插件管理 → 插件市场，或直接点标题栏那颗拼图图标。${after.error ? `上次失败原因：${after.error}` : "正在拉取中。"}`,
  };
}

function strArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key].trim() : "";
}

function numArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback;
}

export async function handleCli(kind: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(CLI_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `命令行动作未开放：${kind}。这一族只有 ${CLI_KINDS.join(" / ")}；卸载/启停还没做（删除是本机动作，单独一批），AI 那条路永远到不了这里`,
    );
  }
  const ctx = browseCtx();
  const snap = getMarketSnapshot();

  if (kind === "cli.market_status") {
    return {
      status: snap.status,
      indexName: snap.index?.name ?? "",
      source: snap.index?.source ?? "",
      generatedAt: snap.index?.generatedAt ?? "",
      entries: snap.index?.entries.length ?? 0,
      dropped: snap.index?.dropped.length ?? 0,
      viaMirror: snap.viaMirror,
      elapsedMs: snap.elapsedMs,
      error: snap.error,
      favorites: snap.favorites.length,
      appVersion: snap.appVersion,
    };
  }

  // 这两条**不排在索引门后面**：status 问的是本机那张队列，索引有没有拉来与它无关
  if (kind === "cli.plugin_status") {
    const v = readMarketPending(strArg(args, "token"));
    if ("phase" in v) {
      return {
        ok: v.phase === "done",
        token: v.token,
        entryId: v.entryId,
        phase: v.phase,
        phaseText: v.phaseText,
        code: v.code,
        text: v.text,
        /** 还有几条停在"等你确认"：CLI 顺手说一句，省得人在两个地方数 */
        awaiting: awaitingMarketInstalls().length,
      };
    }
    return { ok: false, phase: "gone", code: v.code, msg: v.msg, text: "" };
  }

  if (kind === "cli.plugin_install") {
    // 只起一次请求并**立刻**回 token：慢的一半（取回/校验/暂存）在应用里后台跑。
    // 在这里等它就是那条 3 秒超时的悬案——CLI 收到超时、应用还在装，两边各有事实。
    const ready = await indexReady();
    if (!ready.index) {
      return { ok: false, token: "", msg: ready.note || "索引还没拿到", note: "没有开始任何取回" };
    }
    const r = requestMarketInstall(strArg(args, "id"));
    return {
      ok: r.ok,
      token: r.token,
      msg: r.msg,
      note: r.ok
        ? "受理不等于装好：用 status <token> 问下一步。覆盖已有版本会停在「等你确认」，要在应用里点"
        : "没有开始任何取回",
    };
  }

  const { index, note } = await indexReady();
  if (!index) {
    // 拿不到索引不是"没有插件"：给空清单 + 一句为什么，CLI 照原话打印
    return { cards: [], total: 0, note: note || snap.error || "索引还没拉过来" };
  }

  if (kind === "cli.market_list") {
    const input = {
      ...ctx,
      index,
      tab: "discover" as const,
      query: strArg(args, "query"),
      category: strArg(args, "category") || "all",
      sort: (strArg(args, "sort") || "updated") as "updated" | "name" | "category",
    };
    const all = browseEntries(input);
    const limit = numArg(args, "limit", LIST_PAGE);
    const shown = all.slice(0, limit);
    const empty = emptyTalk(input, all.length);
    return {
      cards: shown.map((e) => {
        const c = cardFacts(index, e, ctx);
        return {
          id: c.id, name: c.name, author: c.author, category: c.category, version: c.version,
          updated: c.updated, install: c.installText, grayed: c.grayed, size: c.sizeText,
          caps: c.caps.map((x) => x.name), desc: c.description,
        };
      }),
      total: all.length,
      shown: shown.length,
      truncated: all.length > shown.length ? `还有 ${all.length - shown.length} 条没列出（--limit 或 --query 收窄）` : "",
      categories: facetCategories(index, browseEntries({ ...input, category: "all" })).map((f) => `${f.label} ${f.count}`),
      dropped: index.dropped.length,
      note: empty ? empty.text : note,
    };
  }

  if (kind === "cli.market_info") {
    const id = strArg(args, "id");
    const e = index.entries.find((x) => x.id === id);
    if (!e) throw new Error(`货架上没有「${id || "(空 id)"}」（当前 ${index.entries.length} 条，用 plugin list --query 关键字 找）`);
    const c = cardFacts(index, e, ctx);
    return {
      id: c.id, name: c.name, author: c.author, category: c.category, version: c.version,
      updated: c.updated, descZh: e.description.zh, descEn: e.description.en ?? "",
      install: c.installText, compat: c.compatText, grayed: c.grayed,
      size: c.sizeText, sha256_12: c.sha12, screenshots: c.screenshotCount,
      caps: c.caps, homepage: e.homepage ?? "", discussion: e.discussion ?? "",
      note: "列表不等于背书：条目来自当前索引，不代表内容安全。",
    };
  }

  // cli.plugins_installed：本机库 + 与货架的对照（只按 id，不猜哪个对应哪个）。
  // "哪些是本机多出来的"这条判定只有一份：货架页那句「本机另有 N 个包不在这份索引里」用的是同一个 `offShelfOf`。
  const local = getPlugins().plugins;
  const offShelf = offShelfOf(index, local.map((r) => ({
    id: r.pkg.id,
    name: r.pkg.name,
    version: r.pkg.version,
    state: PLUGIN_STATE_LABEL[r.state],
  })));
  const onShelf: unknown[] = [];
  for (const r of local) {
    const e = index.entries.find((x) => x.id === r.pkg.id);
    if (!e) continue; // 多出来的那些已由 offShelfOf 收走，不在这里重复列一遍
    const c = cardFacts(index, e, ctx);
    onShelf.push({ id: r.pkg.id, name: r.pkg.name, local: r.pkg.version, shelf: e.version, state: c.installText });
  }
  return {
    total: local.length,
    onShelf,
    offShelf,
    offShelfNote: `不在货架上的 ${offShelf.length} 个只按 id 对照，不猜哪个对应哪个；启停与卸载去插件库看。`,
    favoritesMissing: missingFavorites(index, snap.favorites),
  };
}
