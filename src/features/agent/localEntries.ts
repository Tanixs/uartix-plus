/**
 * 本机适配器自带的数据面工具（取回回执 / 曲线 / 动作 / 计划 / 宿主目录）。
 *
 * 为什么单独一个文件而不是留在 `agentAdapter`：**显示层要从 entry 派生**
 * （中文名、参数摘要、撤销路由），而 toolDisplay 不能 import agentAdapter
 * （那条边会绕回适配器自己，就是环）。
 * 于是 per-run 状态从闭包改走 `ctx.scratch`，entry 本身降级为模块级常量——
 * 这一步顺带把"工具只在适配器闭包里存在、显示层只能手抄一份标签"的旧结构拆了。
 */
import { getSnapshot as getSerial } from "../serial/serialStore";
import { getSnapshot as getOperator } from "../operator/operatorStore";
import * as plot from "../plot/plotStore";
import { acquireDataLease, hasDataLease } from "../plot/dataLease";
import { CATALOG_VIEWS, catalogMenu, readCatalog } from "./hostCatalog";
import type { CatalogReadResult } from "./hostCatalog";
import { isKnownActionKind, runAppActionSurface } from "./appActionSurface";
import { actionKindLabel } from "./toolCatalog";
import { actionMeta } from "./toolCatalog";
import { channelStats, decimate } from "./runMath";
import { defineTool, notExecuted, type AgentToolEntry, type ToolCtx, type ToolResultBody } from "./toolRegistry";
import { setPlan, type PlanItem, type PlanStatus } from "./planLedger";

/**
 * 一页取多少字节（P94-G3）。**刻意不等于 `RECEIPT_DATA_LIMIT`**，两条线是两件事：
 * 那条是"要不要截断"的阈值，这条是"一次传多少"的传输经济（模型每页都得把它吃进上下文）。
 * P138-B 抬阈值时这里是别名，等于顺手把每页成本抬了一档——本批把它拆回 8 KiB，
 * **保持与改动前的行为一致**。（我一度在注释里写"相等时页会被适配器再截一层"，
 * 用变异探针打不出去 ⇒ 那句没被证明 ⇒ 撤掉，只留能证的部分。）
 */
export const ARTIFACT_PAGE_BYTES = 8 * 1024;
/** plot_window 每通道抽稀点数硬顶。 */
export const PLOT_WINDOW_MAX_POINTS = 2000;
/**
 * `app_state` 每段只给前 N 项（它是"概览"，明细归 `app_read`）。
 * P90 F 的聚合上限就是这个"每段几项"：P99a-C1 起不再需要"整包 6KiB 折半瘦身"那套，
 * 分段上限就是唯一的瘦身规则，折半循环会把"我给了多少"再次变成隐式事实（A7 的反面）。
 */
export const OVERVIEW_LIMIT = 8;
/** P94-G4：清单类回执的统一封顶（超出必带 count/truncated，让模型知道"只看到一部分"）。 */
export const LIST_CAP = { channels: 40 } as const;

const HOST = { kind: "host" } as const;

const PLAN_STATUSES: PlanStatus[] = ["pending", "doing", "done", "skipped"];

/** task_plan 的参数摘要（时间线展开用）：只报"几项 / 几项没闭环"，不把计划全文塞进卡片 */
function planArgsSummary(a: Record<string, unknown>): string {
  const items = Array.isArray(a?.items) ? (a.items as PlanItem[]) : [];
  const open = items.filter((i) => i.status === "pending" || i.status === "doing").length;
  return `计划 ${items.length} 项` + (open ? ` · 未闭环 ${open}` : " · 全部闭环");
}

/**
 * task_plan 的执行：整表替换（计划是快照语义，不是补丁），然后回一份"宿主记成了什么"，
 * 让模型下一轮能自查。参数不合法一律 `not_executed` —— 静默收下坏计划比拒收更坏：
 * 那等于后面那道完成检查建立在一个模型以为存在的计划上。
 */
function writePlan(callId: string, ctx: ToolCtx, a: Record<string, unknown>): ToolResultBody {
  const raw = Array.isArray(a?.items) ? (a.items as Partial<PlanItem>[]) : null;
  if (!raw || raw.length === 0 || raw.length > 12) return notExecuted(callId, "invalid_items");
  const items: PlanItem[] = [];
  for (const it of raw) {
    if (!it || typeof it.id !== "string" || typeof it.text !== "string") return notExecuted(callId, "invalid_items");
    if (!PLAN_STATUSES.includes(it.status as PlanStatus)) return notExecuted(callId, "invalid_status");
    items.push({ id: it.id.slice(0, 24), text: it.text.slice(0, 200), status: it.status as PlanStatus });
  }
  setPlan(ctx.runId, items);
  const open = items.filter((i) => i.status === "pending" || i.status === "doing").map((i) => i.id);
  return {
    callId,
    ok: true,
    status: "applied",
    data: {
      total: items.length,
      open,
      note: open.length
        ? `${open.length} item(s) still open; the task will not be accepted as finished until they are done or skipped.`
        : "all plan items closed",
    },
  };
}
/** 人类可读的批准计划（§7.1：目标、实际影响、差异提示）。 */
function describePlan(kind: string, effect: string, args: Record<string, unknown>): string {
  const target = typeof args.id === "string" ? `（目标 ${args.id}）` : "";
  switch (effect) {
    case "device_send": return `动作「${kind}」可能向已连接设备/总线发送数据${target}。确认目标设备与参数后批准；无法判定实车时不自动执行。`;
    case "destructive_write": return `动作「${kind}」会删除或覆盖你已定义的内容${target}。批准前请查看参数；新建副本不需要批准。`;
    case "safety_boundary": return `动作「${kind}」触及安全边界（急停/校准/全局控制）${target}，必须人工确认。`;
    case "protected_config": return `动作「${kind}」修改受保护配置${target}，需要人工确认。`;
    case "irreversible": return `动作「${kind}」不可恢复${target}，需要人工确认。`;
    default: return `动作「${kind}」需要人工批准（${effect}）${target}。`;
  }
}

/** 首次读数据要申请后台租约（§6.1）；申请不到就如实说申请不到。 */
async function ensureDataLease(ctx: ToolCtx): Promise<ToolResultBody | null> {
  if (ctx.scratch.leaseRequested) return null;
  ctx.scratch.leaseRequested = true;
  const granted = await acquireDataLease(ctx.runId, ctx.signal);
  return granted ? null : notExecuted(ctx.callId, "lease_busy", { hint: "数据租约队列超时或任务已取消，稍后重试或减少并发采集任务" });
}

export const localToolEntries: AgentToolEntry[] = [
  defineTool({
    name: "read_artifact",
    labelZh: "取回回执",
    effect: "read",
    domain: null,
    provenance: HOST,
    // 取回的是"已经裁过的那份原文"，再过一遍裁剪会变成自我循环（P94-G3 的原始事故）
    truncate: false,
    description: `Fetch a previously truncated tool receipt from this run's cache, one page at a time (page = ${ARTIFACT_PAGE_BYTES} bytes). Args: { ref: string (the artifactRef from the truncated receipt, e.g. "call:<callId>"), from?: number (byte offset, default 0) }. Returns { text, from, totalBytes, hasMore, nextFrom }; keep calling with nextFrom until hasMore is false. Cache lives only in this run's memory: after the task ends or the app restarts you get artifact_expired, so re-call the original tool instead. Read-only.`,
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, from: { type: "number" } },
      required: ["ref"],
      additionalProperties: false,
    },
    summarize: (a) => {
      const ref = String(a.ref ?? "").replace(/^call:/, "");
      const from = Number(a.from);
      return `取回回执 ${ref.slice(0, 12)}${Number.isFinite(from) && from > 0 ? ` · 自 ${from}B` : ""}`;
    },
    execute: (a, ctx) => {
      const callId = ctx.callId;
      const ref = String(a.ref ?? "").trim();
      if (!ref) return notExecuted(callId, "invalid_args", { hint: "ref 必须是裁剪回执里给出的 artifactRef（形如 call:<callId>）" });
      if (!ctx.scratch.artifacts.has(ref)) {
        return notExecuted(callId, "artifact_expired", {
          ref,
          hint: "该缓存已随任务结束或应用重启失效（缓存只活在本任务内存里，不落盘）；请重新调用产生它的原工具，并用更小的范围参数控制体积",
        });
      }
      const text = JSON.stringify(ctx.scratch.artifacts.get(ref));
      const from = Math.min(Math.max(0, Math.floor(Number(a.from)) || 0), text.length);
      const page = text.slice(from, from + ARTIFACT_PAGE_BYTES);
      const nextFrom = from + page.length;
      const hasMore = nextFrom < text.length;
      return {
        callId,
        ok: true,
        status: "read",
        data: {
          ref,
          from,
          totalBytes: text.length,
          text: page,
          hasMore,
          /** 恒回传：只在有下一页时才给，会让调用方（和测试）拿 undefined 当偏移、退回头一页 */
          nextFrom,
          ...(hasMore ? { hint: `用 read_artifact { ref: "${ref}", from: ${nextFrom} } 取下一页` } : {}),
        },
      };
    },
  }),
  defineTool({
    name: "plot_channels",
    labelZh: "通道统计",
    effect: "analysis",
    domain: null,
    provenance: HOST,
    description: "List 2D plot channels with per-channel stats (points/last/min/max/sampleRate) and data coverage. Requests a background data lease on first call so sampling continues while panels are closed. Read-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "读取通道统计",
    execute: async (_a, ctx) => {
      const busy = await ensureDataLease(ctx);
      if (busy) return busy;
      const channels = plot.getSnapshot().channels;
      const origin = plot.timeOrigin();
      const coverage = { originMs: origin, live: hasDataLease(ctx.runId), note: hasDataLease(ctx.runId) ? "租约生效，数据持续采样" : "无实时订阅，仅返回已有缓存窗口" };
      // P94-G4：通道数封顶并回 count/truncated——旧实现无上限，几十通道就是一份大回执
      const shown = channels.slice(0, LIST_CAP.channels);
      return {
        callId: ctx.callId,
        ok: true,
        status: "read",
        data: {
          channels: shown.map((c) => ({ id: c.id, name: c.name, tplId: c.tplId, fieldId: c.fieldId, ...channelStats(c.id) })),
          count: channels.length,
          returned: shown.length,
          truncated: shown.length < channels.length,
          ...(shown.length < channels.length ? { hint: `通道多于 ${LIST_CAP.channels} 个，仅返回前 ${shown.length} 个；需要其它通道请用 plot_window 指定 channelIds` } : {}),
          coverage,
        },
      };
    },
  }),
  defineTool({
    name: "plot_window",
    labelZh: "采样窗口",
    effect: "analysis",
    domain: null,
    provenance: HOST,
    description: "Read a downsampled time window of given channels (defaults to all). Args: channelIds?: string[], maxPoints?: number (per channel, cap 2000). Returns relative seconds since session start. Read-only.",
    parameters: { type: "object", properties: { channelIds: { type: "array", items: { type: "string" } }, maxPoints: { type: "number" } }, additionalProperties: false },
    summarize: (a) => {
      const ch = Array.isArray(a.channelIds) ? a.channelIds.length : 0;
      const pts = typeof a.maxPoints === "number" ? a.maxPoints : null;
      return `采样 ${ch || "全部"} 通道${pts ? ` · 每道 ${pts} 点` : ""}`;
    },
    execute: async (a, ctx) => {
      const busy = await ensureDataLease(ctx);
      if (busy) return busy;
      const channels = plot.getSnapshot().channels;
      const origin = plot.timeOrigin();
      const coverage = { originMs: origin, live: hasDataLease(ctx.runId), note: hasDataLease(ctx.runId) ? "租约生效，数据持续采样" : "无实时订阅，仅返回已有缓存窗口" };
      const ids = Array.isArray(a.channelIds) ? a.channelIds.map(String) : channels.map((c) => c.id);
      const maxPoints = Math.min(Math.max(Math.floor(Number(a.maxPoints)) || 500, 10), PLOT_WINDOW_MAX_POINTS);
      const series = [];
      for (const id of ids) {
        const ch = channels.find((c) => c.id === id);
        if (!ch) continue;
        const d = plot.getChanData(id);
        series.push({ id, name: ch.name, ...decimate(d.t, d.v, maxPoints) });
      }
      return { callId: ctx.callId, ok: true, status: "read", data: { series, relativeSeconds: true, coverage } };
    },
  }),
  defineTool({
    name: "run_app_action",
    labelZh: "执行应用动作",
    // 真实风险在**内层 kind** 上，由 assess 从 toolCatalog 的宿主侧标注取——绝不读模型自报
    effect: "read",
    domain: null,
    provenance: HOST,
    description: "Run a named app action (openPanel/setTheme/applyPreset/addChannel/writeCard/writeTemplate/writeSendSpec/writeCommand/writeCodec/listProtocols/listCommands/listCards/xrayEvidence/…). Args: { kind: string, args?: object }. Deletion, overwrite, device send and protected operations require local approval and return needs_local_approval with the plan.",
    parameters: { type: "object", properties: { kind: { type: "string" }, args: { type: "object" } }, required: ["kind"], additionalProperties: false },
    summarize: (a) => {
      const kind = String(a.kind ?? "");
      if (!kind) return "执行应用动作";
      const inner = (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, unknown>;
      const named = String(inner.name ?? inner.id ?? inner.title ?? inner.path ?? "");
      return `${actionKindLabel(kind)}${named ? `「${named.slice(0, 30)}」` : ""}`;
    },
    assess: (a, ctx) => {
      const kind = String(a.kind ?? "");
      if (!isKnownActionKind(kind)) return { refuse: notExecuted(ctx.callId, "unknown_action", { kind }) };
      const meta = actionMeta(kind);
      if (!meta) return { refuse: notExecuted(ctx.callId, "unknown_action", { kind }) };
      return { meta };
    },
    // 批准卡署名与令牌作用域都用**内层 kind**（用户批的是"删除卡片"，不是"执行应用动作"）
    approvalSubject: (a) => String(a.kind ?? "run_app_action"),
    planFor: (a, meta) => describePlan(String(a.kind ?? ""), meta.effect, (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, unknown>),
    execute: async (a, ctx) => {
      const kind = String(a.kind ?? "");
      const actionArgs = (a.args && typeof a.args === "object" && !Array.isArray(a.args) ? a.args : {}) as Record<string, unknown>;
      // P99a-F1：执行核与 MCP 面共用（appActionSurface）。Agent 侧的高权限**判定**在这里恒成立——
      // 不是因为这里是"高权限"，而是因为档位/授权域与批准卡已经在这条管线前面拦过了。
      const r = await runAppActionSurface(kind, actionArgs, { highPriv: true });
      if (!r.ok) return { callId: ctx.callId, ok: false, status: "error", code: r.code, data: { err: r.msg } };
      return { callId: ctx.callId, ok: true, status: r.readOnly ? "read" : "applied", data: r.data };
    },
  }),
  // P109-C：任务计划。它是**完成契约**不是权限闸——不拦写操作、不改审批语义（§8-44），
  // 只把"还有步骤没闭环就想收工"变成宿主侧可查的事实，而不是模型自己的一句话。
  defineTool({
    name: "task_plan",
    labelZh: "记录任务计划",
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      "Record or update your step plan for the current task. Call it before multi-step work, then update statuses as you go. While items stay 'pending' or 'doing' the task will not be accepted as finished - close them with 'done', or move them to 'skipped' and say why in your reply. Re-sending the full list replaces the plan (it is a snapshot, not a patch).",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "short stable id, e.g. p1" },
              text: { type: "string", description: "what this step delivers" },
              status: { type: "string", enum: ["pending", "doing", "done", "skipped"] },
            },
            required: ["id", "text", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    summarize: (a) => planArgsSummary(a),
    execute: async (a, ctx) => writePlan(ctx.callId, ctx, a),
  }),
  defineTool({
    /* —— P99a-C1：宿主自省面。先看菜单再点菜（DSH `cordis_inspect_list` 口径） —— */
    name: "app_catalog",
    labelZh: "查看可读目录",
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      "List every part of THIS app you may read, grouped, with the exact fields each path returns and its size cap. Call it before app_read when you are unsure what exists — the menu is derived from the single host-catalog declaration, so it can never advertise a path that does not actually read. Read-only, no args.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "列出可读的宿主视图",
    execute: async (_a, ctx) => ({ callId: ctx.callId, ok: true, status: "read", data: catalogMenu() }),
  }),
  defineTool({
    name: "app_read",
    labelZh: "读取宿主信息",
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      // 路径清单**从目录派生**（C1b）：这里原先手抄了 13 条路径，本批接进七面之后
      // 模型看这句仍只会去点老几样——一份写死的清单就是第二真相（§8-36①）。
      `Read one view from the host catalog. Args: { path: string, id?: string, cursor?: number, limit?: number }. ` +
      `Paths come ONLY from app_catalog (${CATALOG_VIEWS.map((v) => v.path).join(" | ")}). ` +
      "List views paginate: the receipt carries total/returned/nextCursor/truncated — follow nextCursor rather than guessing a bigger limit. " +
      "Unknown paths are refused with suggestions; there is no reflection into stores the catalog does not expose. Read-only.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        id: { type: "string" },
        cursor: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    summarize: (a) => `读取 ${String(a.path ?? "?")}`,
    async execute(a, ctx) {
      const callId = ctx.callId;
      const path = typeof a.path === "string" ? a.path.trim() : "";
      if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是 app_catalog 里的路径" });
      const r = await readCatalog(path, {
        ...(typeof a.id === "string" && a.id.trim() ? { id: a.id.trim() } : {}),
        ...(typeof a.cursor === "number" ? { cursor: a.cursor } : {}),
        ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
      });
      if (!r.ok) return notExecuted(callId, r.code, r.data);
      return {
        callId,
        ok: true,
        status: "read",
        data: {
          path: r.path,
          cursor: r.cursor,
          ...(r.total !== undefined ? { total: r.total, returned: r.returned } : {}),
          nextCursor: r.nextCursor,
          truncated: r.truncated,
          bytes: r.bytes,
          ...(r.truncated && r.nextCursor !== null ? { hint: `还有内容没给完：接着用 cursor=${r.nextCursor} 取下一页` } : {}),
          result: r.data,
        },
      };
    },
  }),
  defineTool({
    name: "app_state",
    labelZh: "读取软件现状",
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      "One-shot overview of the whole app so you don't have to probe tool by tool: transport, operator lock, session record-replay + bridge, protocol templates, 2D channels with point counts, parse stats, plugin library. **This is the overview: each list section carries only the first few items and reports `total` — read the full content with app_read(path, {cursor, limit}) instead of re-calling this tool.** Args: { sections?: string[] } subset of serial|session|protocols|channels|frames|plugins (default all). Read-only.",
    parameters: {
      type: "object",
      properties: { sections: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
    summarize: () => "汇总串口/协议/通道/插件/最近帧",
    async execute(a, ctx) {
      /**
       * P99a-C1 收编（A 段留的 TODO 到此结清）：以前这段自己 `getSnapshot()` 六个 store、
       * 自己定"24 条 × 24 字段"的切片，与 `app_read` 会读的是**两份口径**——同一件事两个门
       * （§8-37① 的只读版）。现在每段都从 hostCatalog 的同一个读者取，切片规则也只有一处。
       */
      const ALL = ["serial", "session", "protocols", "channels", "frames", "plugins"];
      const want = new Set<string>(Array.isArray(a.sections) && a.sections.length ? a.sections.map(String) : ALL);
      const out: Record<string, unknown> = {};
      const grab = async (key: string, path: string) => {
        const r = await readCatalog(path, { limit: OVERVIEW_LIMIT });
        out[key] = r.ok ? r.data : { error: r.code };
      };
      /**
       * `runtime` 一次调用内只读一遍：serial 段与 session 段的 `operatorLocked` 必须来自
       * **同一次**快照。分两次读的话，两次 `getSnapshot()` 之间用户解锁/加锁就会产出一条
       * 自相矛盾的回执（"串口那行说在操纵者模式、会话那行说没锁"），模型据此做出的判断无法复现。
       */
      let runtimeOnce: Promise<CatalogReadResult> | null = null;
      const runtime = () => (runtimeOnce ??= readCatalog("runtime"));
      if (want.has("serial")) {
        const r = await runtime();
        out.serial = r.ok ? (r.data as { serial?: unknown }).serial ?? r.data : { error: r.code };
      }
      if (want.has("session")) {
        const [s, r] = await Promise.all([readCatalog("session"), runtime()]);
        out.session = s.ok
          ? { ...(s.data as object), operatorLocked: r.ok ? Boolean((r.data as { operatorLocked?: boolean }).operatorLocked) : false }
          : { error: s.code };
      }
      if (want.has("protocols")) await grab("protocols", "protocols");
      if (want.has("channels")) await grab("channels", "channels");
      if (want.has("frames")) {
        const [st, latest] = await Promise.all([readCatalog("frames.stats"), readCatalog("frames.latest", { limit: OVERVIEW_LIMIT })]);
        out.frames = { stats: st.ok ? st.data : { error: st.code }, latest: latest.ok ? latest.data : { error: latest.code } };
      }
      if (want.has("plugins")) await grab("plugins", "plugins");
      out.note = `各段清单只给前 ${OVERVIEW_LIMIT} 项（见各自 total）；完整内容用 app_read，可读路径见 app_catalog。`;
      return { callId: ctx.callId, ok: true, status: "read", data: out };
    },
  }),
];

/** plot_channels/plot_window 用到的纯计算，单独放 runMath 以免 toolDisplay→hostEntries→本文件→plotStore 之外再拖进 UI 依赖 */
export function deviceContextOf(): "real" | "sim" | "unknown" {
  const s = getSerial();
  // 无法判定是否实车时按 unknown 处理，不猜成仿真（HANDOVER §6.3）
  return s.status === "connected" ? "real" : "unknown";
}

export function operatorLocked(): boolean {
  return getOperator().pkg !== null;
}

export function leaseActiveFor(runId: string): boolean {
  return hasDataLease(runId);
}
