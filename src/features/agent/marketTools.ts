/**
 * P99c-C2：插件市场这一支的 AI 侧工具。目前只有一支，而且它**什么都不装**。
 *
 * 为什么单独一个文件：市场要引的东西全在 `await import()` 里（环纪律 §8-33），
 * 而"这支工具只能讲计划"这件事必须能被一条源文本钉看住——混在 650 行的 `localEntries.ts` 里，
 * 那条钉就会变成对整个本地工具面的误伤（那里确实有写侧）。
 *
 * 用户裁的是「放开一点好」＝**AI 可以提名，人仍然批准**。所以边界画在三行上：
 *  - `assess` 不联网（批准卡那句只用内存里的货架声明拼，见 §详设 刀1-②）；
 *  - `execute` 只叫 `planMarketInstall`（取回 + 校验 + 比能力），一次都不叫 stage/apply/pending；
 *  - 回执不出现"已装/已暂存"这类词，并指向真能落地的那两处。
 */
import { getPlugin } from "../plugins/pluginStore";
import { INSTALL_CODE_ZH } from "../market/marketIndex";
import { defineTool, notExecuted, type AgentToolEntry, type Assessment } from "./toolRegistry";

const HOST = { kind: "host" } as const;

/** 货架最多给模型看这么多条 id（超出照实标 truncated；它本来也该用 `app_read market.entries` 分页读） */
const ID_LIST_CAP = 40;

/** 提名这一条时给用户看的那句计划：内核那句（唯一渲染处）+ 本工具自己的承诺。 */
async function planSentence(entryId: string): Promise<string> {
  const [{ getMarketSnapshot }, { describeFacts, factsFromEntry }] = await Promise.all([
    import("../market/marketStore"),
    import("../market/marketInstall"),
  ]);
  const entry = getMarketSnapshot().index?.entries.find((e) => e.id === entryId);
  if (!entry) return "";
  const facts = factsFromEntry(entry, getPlugin(entry.id)?.pkg.version ?? "");
  return `${describeFacts(facts)} ｜批准这一条＝允许我下载这一枚包并按货架声明校验一遍，**不装、不启用、不进插件库**。`;
}

/** 取一次货架里的 id 清单（拒绝话术要能指路，不能只说"不存在"）。 */
async function shelfIds(): Promise<string[]> {
  const { getMarketSnapshot } = await import("../market/marketStore");
  return (getMarketSnapshot().index?.entries ?? []).slice(0, ID_LIST_CAP).map((e) => e.id);
}

export const marketToolEntries: readonly AgentToolEntry[] = Object.freeze([
  defineTool({
    name: "propose_market_install",
    labelZh: "提名安装市场插件",
    /**
     * `protected_config` 而不是 `read`：它确实不写本机，但**会向外取字节**（下载一枚包）。
     * 标成 read 就等于对门禁撒谎——批准卡上那句"允许我下载"就没处挂了（§8-35 同一族）。
     * `domain: null`：域门是"谁能写插件库"的门，这支什么都不写；判批准只按 effect 走，
     * 于是三档一律逐次批准（详设 §8.6 的原始口径）。
     */
    effect: "protected_config",
    domain: null,
    provenance: HOST,
    description:
      "Report what installing one market-shelf package WOULD do: download the package, verify it against the shelf's declared sha256 / bytes / capabilities, and return that plan. " +
      "It never installs, never stages, never enables, and never writes the pending table — landing a package always stays a human click in 插件市场 (or `uartix plugin install <id>` in a terminal). " +
      "Needs local approval on every call because it does download bytes. Pick the id from `app_read` path `market.entries` first (that view is free and offline). " +
      "A shelf is only present after the user opens the 插件市场 page once. Args: { entryId: string }.",
    parameters: {
      type: "object",
      properties: { entryId: { type: "string", description: "Shelf entry id, e.g. the `id` field from market.entries" } },
      required: ["entryId"],
      additionalProperties: false,
    },
    summarize: (a) => `提名安装 ${String(a.entryId ?? "")}`,
    approvalBinding: (a) => ({ tool: "propose_market_install", entryId: String(a.entryId ?? "") }),
    /**
     * 批准卡那句**不联网**：只拼内存里那份货架声明（数字来源在句子里点明）。
     * 为了拼这句话先去下载包，就成了"用户还没批，包已经在路上了"。
     */
    assess: async (a, ctx) => {
      const id = String(a.entryId ?? "");
      const { getMarketSnapshot } = await import("../market/marketStore");
      const s = getMarketSnapshot();
      if (!s.index) {
        return {
          refuse: notExecuted(ctx.callId, "market_not_loaded", {
            entryId: id,
            hint: "本机还没取过货架索引（只有打开「插件市场」那一页才联网，我不替你点开）。请让用户打开那一页，或改读 `market.entries` 确认现状",
          }),
        };
      }
      const entry = s.index.entries.find((e) => e.id === id);
      if (!entry) {
        return {
          refuse: notExecuted(ctx.callId, "unknown_id", {
            entryId: id,
            want: s.index.entries.slice(0, ID_LIST_CAP).map((e) => e.id),
            total: s.index.entries.length,
            hint: "id 必须来自货架索引，不能自己编",
          }),
        };
      }
      return {
        // 不写任何东西，所以幂等与可逆都是真话（不是 `defaultMeta` 那种保守兜底）
        meta: { effect: "protected_config", idempotent: true, reversible: true, mayTouchDevice: false },
        plan: await planSentence(id),
      } satisfies Assessment;
    },
    execute: async (a, ctx) => {
      const id = String(a.entryId ?? "");
      const [{ getMarketSnapshot }, { describePlan, planMarketInstall }] = await Promise.all([
        import("../market/marketStore"),
        import("../market/marketInstall"),
      ]);
      const entry = getMarketSnapshot().index?.entries.find((e) => e.id === id);
      if (!entry) {
        return notExecuted(ctx.callId, "unknown_id", {
          entryId: id,
          want: await shelfIds(),
          hint: "id 必须来自货架索引；先 `app_read` 路径 `market.entries`",
        });
      }
      const plan = await planMarketInstall(entry);
      const text = describePlan(plan);
      if (!plan.ok) {
        // 内核原话直接回，不粉成"已提名"——包取不回来/哈希不符/带了指望外的能力，是三件不同的事
        return notExecuted(ctx.callId, plan.code, {
          entryId: id,
          codeZh: INSTALL_CODE_ZH[plan.code],
          text,
          hint: "这是货架与包本身的问题，不是没批准；重试同一参数也不会变成另一个结论",
        });
      }
      return {
        callId: ctx.callId,
        ok: true,
        status: "validated",
        data: {
          entryId: id,
          action: plan.action,
          text,
          installed: false,
          staged: false,
          enabled: false,
          next:
            "我到此为止：没装、没暂存、没启用。要落地请让用户在「插件市场」那一页那一支上点「装入」（覆盖本机已有版本的那种会再过一次确认卡），或在终端跑 uartix plugin install " +
            plan.entry.id,
        },
      };
    },
  }),
]);
