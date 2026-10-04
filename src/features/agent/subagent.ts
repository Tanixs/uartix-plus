/**
 * P135-B：只读子代理（任务 #57 的后半，P88b §5.3 那句从没实现的规划）。
 *
 * 三件事是这批的全部：**只读、受同一总预算、不能再扩权**。三件事各有落点：
 *  - 只读 ⇒ `SUBAGENT_FACE` 是一张**点名白名单**（不是按 `effect` 反射筛，理由写在名单注释上）；
 *  - 同预算 ⇒ `subagentCaps()` 从父任务的实际剩余量折算，跑完由 `chargeNested` 记回父账；
 *  - 不扩权 ⇒ 子适配器拿的是父任务**同一份** `(scope, allowed)` 再裁一次，且挂的是发不出批准卡的门。
 *
 * 依赖纪律：本文件只 import 叶子（toolRegistry / types / settingsStore），
 * **不 import hostEntries**——组面是装配方（`agentAdapter`）的活，反过来 import 就成环（§8-33）。
 */
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { defineTool, notExecuted, type ToolResultBody } from "./toolRegistry";
import type { BudgetLeft, ToolProvenance } from "./types";

const HOST: ToolProvenance = { kind: "host" };

/**
 * 子代理能用的工具（点名 21 支）。**故意不是"按 effect 自动筛"**，三条都是实测出来的理由：
 *  - `run_app_action` 声明 `effect:"read"`，但它的 `assess` 按内层 kind 重新定档，能升到
 *    `destructive_write` / `device_send` —— 按 effect 反射会把它请进只读面；
 *  - `plot_channels` / `plot_window` 只读但申请**数据租约**，租约由 `agentRun.finalize` 按 runId 回收，
 *    而子任务不是一个 run 视图 ⇒ 没人回收，租约泄漏；
 *  - `task_plan` 只读声明但写计划台账，而闭环判据（`openPlan`）绑的是父 runId。
 * 漏配的方向是安全的：新的只读工具忘了进名单，子面只是少一支；
 * 反过来谁把写类塞进来，`subagent.test.ts` 第一条逐个查 effect 直接红。
 * ⚠ 名单里**没有 `subagent` 自己**：递归在结构上不存在，不靠运行时深度计数器拦。
 */
export const SUBAGENT_FACE = [
  "settings_describe", "settings_read", "settings_preview_patch",
  "theme_read", "asset_list", "image_swatch",
  "ui_inventory", "ui_inspect", "theme_audit",
  "app_catalog", "app_read", "app_state", "list_plugins",
  "read_artifact",
  "fs_read", "fs_list", "fs_grep", "fs_glob", "session_read",
  "web_fetch", "web_search",
] as const;

/**
 * 子任务自己那一档的上限。为什么不是"不设限"：一次派发等于若干轮真实模型请求（用户的钱包），
 * 而父任务那三条预算（`agentMaxRounds` 等）默认是 0=不限。
 * 所以这里是**双重夹取**：既夹自己的档，也夹父任务的剩余（`subagentCaps`）。
 */
export const SUBAGENT_CAPS = { maxRounds: 6, maxCalls: 16, timeoutMs: 180_000 };

/**
 * P137：这一趟是**撞了哪一项顶**才停的（`null` = 三项都没碰线）。
 * 三个常数现在是拍的（详设 C5），但"拍的数够不够"要有读数的地方——
 * 界面上 `额度 6/6 轮` 与一句"轮数用尽，它可能没查完"才是回头校准它的依据。
 * 判据用 `>=` 而不是 `===`：轮数与调用数由 loop 累加，超限那一档也可能一次加过头。
 */
export type SubagentCapHit = "rounds" | "calls" | "ms" | null;
export function subagentCapHit(
  caps: { maxRounds: number; maxCalls: number; timeoutMs: number },
  usage: { rounds: number; calls: number; elapsedMs: number },
): SubagentCapHit {
  if (usage.rounds >= caps.maxRounds) return "rounds";
  if (usage.calls >= caps.maxCalls) return "calls";
  if (usage.elapsedMs >= caps.timeoutMs) return "ms";
  return null;
}

/** 撞顶说法（穷举 Record：漏一项就编译不过，§8-35①） */
const CAP_HIT_ZH: Record<Exclude<SubagentCapHit, null>, string> = {
  rounds: "轮数已用尽，它可能没查完",
  calls: "调用次数已用尽，它可能没查完",
  ms: "时间到了",
};

/**
 * 从父任务的剩余折算子的上限。返回 `null` = **这一趟不该开跑**（额度已经没了）。
 *
 * 这里就是那颗雷：宿主 caps 的线上形态是 `0 = 不限制`（P109-A 裁决，`deadlineAt: 0` 同理，
 * 因为 `Infinity` 过不了 JSON 落盘）。如果"还剩 0"也用 0 表达，
 * "父预算用尽"与"父没设上限"就是同一个数 ⇒ `Math.min(档, 0)` 会得到 0 ⇒ 传进 loop 变成"不限"
 * ⇒ 派子任务成了一条绕过预算的路。所以 `BudgetLeft` 用 `null` 表示不限，
 * 而**数字 0 在这里是硬闸**，宁可拒一次要说清原因，不许静默放行。
 */
export function subagentCaps(left?: BudgetLeft): { maxRounds: number; maxCalls: number; timeoutMs: number } | null {
  const own = SUBAGENT_CAPS;
  if (!left) return { ...own };
  if (left.rounds === 0 || left.calls === 0 || left.ms === 0) return null;
  return {
    maxRounds: left.rounds === null ? own.maxRounds : Math.min(own.maxRounds, left.rounds),
    maxCalls: left.calls === null ? own.maxCalls : Math.min(own.maxCalls, left.calls),
    timeoutMs: left.ms === null ? own.timeoutMs : Math.min(own.timeoutMs, left.ms),
  };
}

export const subagentToolEntries = [
  defineTool({
    name: "subagent",
    labelZh: "派只读子代理",
    // 只派"去查"这件事，不派"去做"：它的工具面上没有一支写类工具（见 SUBAGENT_FACE 注释）。
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      `Dispatch a READ-ONLY sub-agent: it gets its own short run with a subset of these tools (${SUBAGENT_FACE.join(", ")}), reports back one text answer, and CANNOT write settings, files, plugins, appearance or the device - the tool face it inherits is this task's own authorization domains, so a task that cannot read files produces a sub-agent that cannot either. Args: { goal: string - one concrete question to answer, e.g. "which fields in frame A look like a checksum and why" }. The receipt carries { goal, answer, rounds, calls, toolsUsed, status, caps, elapsedMs }, plus capHit when it stopped on one of its limits. Three things to know before using it. (1) It burns the SAME budget as this run: its rounds and tool calls are charged back to this task's counters, and if this task has no rounds left the dispatch is refused (subagent_budget_exhausted) rather than silently unlimited. (2) It cannot ask the user anything and cannot be approved past its read-only face, so it is for digging, not for deciding. (3) Its answer is a REPORT, not evidence that anything happened: to change something you still call the write tools yourself and read their receipts. Needs the "Agent 只读子代理" master switch in settings (off by default) because each dispatch costs real model requests.`,
    parameters: {
      type: "object",
      properties: { goal: { type: "string", description: "要子代理回答的那一个具体问题" } },
      required: ["goal"],
      additionalProperties: false,
    },
    summarize: (a) => `派只读子代理查「${String(a.goal ?? "").slice(0, 48)}」`,
    /** 总开关关着就地拒、**不弹批准卡**（与 repo_check 同一条理由：白要一次人工确认＝把用户训练成橡皮图章） */
    assess: (a, ctx) => {
      if (!String(a.goal ?? "").trim()) {
        return {
          refuse: notExecuted(ctx.callId, "subagent_no_goal", {
            hint: "goal 不能为空：要子代理查的那一个具体问题（空问题只会白烧一轮）",
          }),
        };
      }
      if (!getSettings().agentSubagent) {
        return {
          refuse: notExecuted(ctx.callId, "subagent_disabled", {
            hint: "设置 → AI 服务 → 「Agent 只读子代理」总开关未开启（它每次派发都要花真实的模型请求，所以默认关）",
          }),
        };
      }
      if (!ctx.scratch.subagent) {
        return {
          refuse: notExecuted(ctx.callId, "subagent_unavailable", {
            hint: "这条任务通路没有接到子代理装配（MCP 与独立适配器走不到它）；要派活请用 AI 助手面板里的任务",
          }),
        };
      }
      if (!subagentCaps(ctx.remaining)) {
        return {
          refuse: notExecuted(ctx.callId, "subagent_budget_exhausted", {
            hint: "本任务的轮数或调用数已经用完：这是额度没了，不是子代理坏了。请让任务续跑，或把目标拆成几次",
          }),
        };
      }
      return {
        // 只读面 + 同一份授权域 + 同一份预算：三类危险性都不升档（P135-B §3-4）
        meta: { effect: "read", idempotent: false, reversible: true, mayTouchDevice: false },
      };
    },
    execute: async (a, ctx): Promise<ToolResultBody> => {
      const goal = String(a.goal ?? "").trim();
      const dispatch = ctx.scratch.subagent;
      if (!dispatch) return { ...notExecuted(ctx.callId, "subagent_unavailable") };
      const rep = await dispatch(goal, ctx);
      // 用量记回父账（loop 实现的那一处），于是界面上的 N/24 轮包含子任务烧掉的量
      ctx.chargeNested?.({ rounds: rep.rounds, calls: rep.calls, tools: rep.tools });
      const done = rep.status === "succeeded";
      const hit = subagentCapHit(rep.caps, { rounds: rep.rounds, calls: rep.calls, elapsedMs: rep.elapsedMs });
      return {
        ok: done,
        status: done ? "read" : "error",
        ...(!done ? { code: "subagent_incomplete" } : {}),
        data: {
          goal,
          answer: rep.text,
          rounds: rep.rounds,
          calls: rep.calls,
          toolsUsed: rep.tools,
          subStatus: rep.status,
          // P137：额度读数随回执走（不是只在实时表里）——台账与导出日志也要答得出"跑在哪个顶上"
          caps: rep.caps,
          elapsedMs: rep.elapsedMs,
          ...(!done && hit ? { capHit: hit } : {}),
          note: done
            ? "这是子代理查出来的**报告**，不是任何改动已经发生的证据；要落改动仍需你自己调用写类工具并读回执"
            : `子代理没跑完（终态 ${rep.status}${hit ? `，${CAP_HIT_ZH[hit]}` : ""}）：上面是它到此为止拿到的东西。需要更多就缩小问题，或让任务续跑`,
        },
      };
    },
  }),
];
