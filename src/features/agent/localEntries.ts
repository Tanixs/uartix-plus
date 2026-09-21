/**
 * P99a-A2/A5：本机适配器自带的九支工具（数据面 + 插件面 + 全局现状）。
 *
 * 为什么单独一个文件而不是留在 `agentAdapter`：**显示层要从 entry 派生**
 * （中文名、参数摘要、撤销路由），而 toolDisplay 不能 import agentAdapter
 * （agentAdapter→pluginStore→extRuntime→chatStore→agentRun 会绕回 agentAdapter，就是环）。
 * 于是 per-run 状态从闭包改走 `ctx.scratch`，entry 本身降级为模块级常量——
 * 这一步顺带把"九支工具只在适配器闭包里存在、显示层只能手抄一份标签"的旧结构拆了。
 */
import { getSnapshot as getSerial } from "../serial/serialStore";
import { getSnapshot as getOperator } from "../operator/operatorStore";
import * as plot from "../plot/plotStore";
import { acquireDataLease, hasDataLease } from "../plot/dataLease";
import { catalogMenu, readCatalog } from "./hostCatalog";
import type { CatalogReadResult } from "./hostCatalog";
import { runAppAction } from "../ai/appActions";
import { APP_ACTION_KINDS } from "../ai/appActionKinds";
import { actionKindLabel } from "./toolCatalog";
import { actionMeta } from "./toolCatalog";
import {
  stagePackage, installStaged, setEnabled, getPlugin,
  proposeUpdate, approveUpdate, rollback as rollbackPlugin,
  armModulePackage,
} from "../plugins/pluginStore";
import { PURE_UI_CAPS, KIND_CONTRIB_KEY, type PluginCap } from "../plugins/pluginManifest";
import { ARTIFACT_KINDS, artifactKindLabel, type ArtifactKind } from "../plugins/artifact";
import { agentPluginId, freeAgentId } from "../plugins/pluginId";
import { RECEIPT_DATA_LIMIT } from "./context";
import { channelStats, decimate } from "./runMath";
import { defineTool, notExecuted, type AgentToolEntry, type ToolCtx, type ToolResultBody } from "./toolRegistry";

/** 按引用取回时的单页字节上限（P94-G3）。等于回执裁剪线，保证"取回来的这一页"不会再被裁。 */
export const ARTIFACT_PAGE_BYTES = RECEIPT_DATA_LIMIT;
/** plot_window 每通道抽稀点数硬顶。 */
export const PLOT_WINDOW_MAX_POINTS = 2000;
/** P90 F：app_state 聚合回执上限——超限逐段瘦身并如实标注，不静默截半 JSON。
 *  P94-G3：留出余量低于 RECEIPT_DATA_LIMIT(8KB)，否则聚合结果永远"刚好卡在裁剪线上"，
 *  每次都要再多一轮 read_artifact 才看得全。 */
/**
 * `app_state` 每段只给前 N 项（它是"概览"，明细归 `app_read`）。
 * P99a-C1 起不再需要"整包 6KiB 折半瘦身"那套：分段上限就是唯一的瘦身规则，
 * 折半循环会把"我给了多少"这件事再次变成隐式事实（A7 的反面）。
 */
export const OVERVIEW_LIMIT = 8;
/** P94-G4：清单类回执的统一封顶（超出必带 count/truncated，让模型知道"只看到一部分"）。 */
export const LIST_CAP = { channels: 40, plugins: 60 } as const;

/** save_plugin 派生能力：按产物类型最小授权，默认不含 serial.send（§9.3）。 */
export const KIND_CAPS: Record<ArtifactKind, PluginCap[]> = {
  theme: ["theme.tokens"],
  widget: ["ui.widget", "telemetry.read"],
  panel: ["ui.panel", "telemetry.read"],
  motionPreset: ["motion.preset"],
  workspacePreset: ["workspace.preset"],
  workflow: ["workflow.compose"],
  reportView: ["report.view"],
  // 逻辑模块：只给"能跑"，不给"能加工具"（agent.tool 归 B2 的注册门）
  module: ["logic.run"],
};

/** save_plugin 默认 id：名称稳定哈希 + user.agent 前缀（P92 D2，中文名不再退化成单字母）。 */
function slugPluginId(name: string): string {
  return agentPluginId("user.agent", name);
}

/**
 * P97-I6 版本链：`save_plugin` 更新已有插件时的下一个版本号。
 * 必须与当前版本**不同**——`proposeUpdate` 对同版本号一律拒绝，而那条错误模型读不懂就会原地重试。
 * 非 x.y.z 形态挂时间戳后缀，不猜语义。
 */
export function nextVersion(cur: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur.trim());
  if (!m) return `${(cur.trim() || "0.0.0").replace(/[+;].*$/, "")}+a${Date.now().toString(36)}`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** 与 pluginManifest 的 ID_RE 同形（本地预检给出更可读的错误码）。 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})+$/;

const HOST = { kind: "host" } as const;
const PURE = PURE_UI_CAPS as readonly string[];
const isPureUiCaps = (caps: readonly string[]) => caps.every((c) => PURE.includes(c));

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
    description: "Run a named app action (openPanel/setTheme/applyPreset/addChannel/writeCard/writeTemplate/writeCommand/writeCodec/listProtocols/listCommands/listCards/xrayEvidence/…). Args: { kind: string, args?: object }. Deletion, overwrite, device send and protected operations require local approval and return needs_local_approval with the plan.",
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
      if (!(APP_ACTION_KINDS as readonly string[]).includes(kind)) return { refuse: notExecuted(ctx.callId, "unknown_action", { kind }) };
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
      const r = await runAppAction(kind, actionArgs, { highPriv: true });
      if (!r.ok) return { callId: ctx.callId, ok: false, status: "error", code: "action_failed", data: { err: r.err ?? "动作执行失败" } };
      const meta = actionMeta(kind);
      const readOnly = meta?.effect === "read" || meta?.effect === "analysis";
      return { callId: ctx.callId, ok: true, status: readOnly ? "read" : "applied", data: r.data ?? null };
    },
  }),
  defineTool({
    name: "list_plugins",
    labelZh: "查看插件库",
    effect: "read",
    domain: null,
    provenance: HOST,
    description: "List local plugin library entries (id/name/version/state/capabilities/createdBy/history/pending candidate). Read-only. Same reader as app_read path `plugins` — this one just keeps the historical receipt shape.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "查看插件库",
    async execute(_a, ctx) {
      // P99a-C1：字段与分页都改由 hostCatalog 的 `plugins` 视图出（以前这里自己 map 一份 store，
      // 与目录里那份就是同一件事的两个门——加一个字段必然只改一处）
      const r = await readCatalog("plugins", { limit: LIST_CAP.plugins });
      if (!r.ok) return notExecuted(ctx.callId, r.code, r.data);
      const d = r.data as { total: number; items: Record<string, unknown>[] };
      const shown = d.items;
      return {
        callId: ctx.callId,
        ok: true,
        status: "read",
        data: {
          plugins: shown,
          count: d.total,
          returned: shown.length,
          truncated: shown.length < d.total,
          ...(shown.length < d.total ? { hint: `库内共 ${d.total} 项，仅返回前 ${shown.length} 项` } : {}),
        },
      };
    },
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
      "Read one view from the host catalog. Args: { path: string, id?: string, cursor?: number, limit?: number }. Paths come ONLY from app_catalog (runtime | protocols | protocols/<id> for the FULL field table incl. offset/type/endian/scale/unit/bits/discrete maps | commands | commands/<id> | controls | controls/<id> | frames.recent | frames.stats | frames.latest | session | channels | plugins). List views paginate: the receipt carries total/returned/nextCursor/truncated — follow nextCursor rather than guessing a bigger limit. Unknown paths are refused with suggestions; there is no reflection into stores the catalog does not expose. Read-only.",
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
  defineTool({
    name: "save_plugin",
    labelZh: "保存插件",
    // 新建/改自己的旧版都是 draft_write：能力由 KIND_CAPS 派生且永不含 serial.send，
    // 所以这条路本身不能提权（详设 §9.3），不需要逐次批准。
    effect: "draft_write",
    domain: "plugins",
    provenance: HOST,
    description:
      `Save an artifact as a reusable local plugin package (uartix-plugin). Args: { kind: one of ${ARTIFACT_KINDS.join("|")}, name: string, payload: object (artifact content per kind; widget/panel payload = {format:'html',html} | {format:'declarative',blocks}; module payload = {format:'js',code}); id?: string (dotted lowercase, default user.agent.*), desc?: string, enable?: boolean (auto-enable pure-UI plugin), update?: string (existing plugin id to revise), version?: string }. ` +
      "Iterating on your own work: pass update (or just the same id) — it bumps the version and pushes the previous package onto the rollback stack instead of creating a near-duplicate plugin. " +
      "Only plugins you (the agent) created can be revised silently; user/imported plugins return update_needs_user and are never overwritten. Plugins carry no device-send capability by default.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string" },
        name: { type: "string" },
        payload: { type: "object" },
        id: { type: "string" },
        desc: { type: "string" },
        enable: { type: "boolean" },
        update: { type: "string" },
        version: { type: "string" },
      },
      required: ["kind", "name", "payload"],
      additionalProperties: false,
    },
    summarize: (a, truncated) => {
      const k = artifactKindLabel(String(a.kind ?? ""));
      const nm = String(a.name ?? "") || (truncated ? "参数过长，见日志" : "?");
      const verb = String(a.update ?? "") ? "更新插件" : `保存${k}插件`;
      return `${verb}「${nm}」${a.enable === true ? "并启用" : ""}`;
    },
    execute: (a, ctx) => {
      const callId = ctx.callId;
      const kind = String(a.kind ?? "") as ArtifactKind;
      if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
        return notExecuted(callId, "invalid_kind", { kind, supported: ARTIFACT_KINDS });
      }
      const name = typeof a.name === "string" ? a.name.trim().slice(0, 60) : "";
      if (!name) return notExecuted(callId, "invalid_name", { hint: "name 必须是 1..60 字符" });
      const payload = a.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return notExecuted(callId, "invalid_payload", { hint: "payload 必须是对象（widget/panel 用 {format:'html'|'declarative',…}）" });
      }
      // id：用户指定或按名称 slug 化。给的 id 若已存在 ⇒ 走下面的版本链更新；
      // 只有"名字撞车但没显式指向它"才加序号后缀，绝不静默覆盖别人的插件
      const provided = typeof a.id === "string" ? a.id.trim().toLowerCase() : "";
      if (provided && !PLUGIN_ID_RE.test(provided)) {
        return notExecuted(callId, "invalid_id", { id: provided, hint: "id 必须是小写点分标识（每段 ≤32 字符），如 user.agent.battery-panel" });
      }
      const id = freeAgentId(provided || slugPluginId(name), (cand) => !!getPlugin(cand));
      const desc = typeof a.desc === "string" ? a.desc.trim().slice(0, 300) : "";
      const buildManifest = (pkgId: string, version: string) => ({
        format: "uartix-plugin",
        schemaVersion: 2,
        id: pkgId,
        version,
        name,
        ...(desc ? { desc } : {}),
        hostApi: "^1.0",
        // 能力恒由 kind 派生且 KIND_CAPS 永不含 serial.send ⇒ 更新路径同样无法提权
        capabilities: [...KIND_CAPS[kind]],
        contributions: { [KIND_CONTRIB_KEY[kind]]: [{ id: "main", entry: "main.json", name }] },
        artifacts: { "main.json": { ...payload, kind } },
        provenance: { createdBy: "agent", reviewed: false },
      });

      /**
       * P97-I6 迭代闭环：改自己上一个作品应当**升版本走版本链**，而不是再造一个插件。
       * 触发条件取显式 `update` 或"给的 id 已存在"二者之一。
       * 只对 Agent 自己创建的插件直改直生效：`duplicate()` 会把 provenance 翻成 user，
       * 因此用户副本、导入件、迁移件一律回 `update_needs_user`，改动留给用户在插件库里批准。
       */
      const targetId = typeof a.update === "string" && a.update.trim()
        ? a.update.trim().toLowerCase()
        : provided && getPlugin(provided) ? provided : "";
      if (targetId) {
        const rec = getPlugin(targetId);
        if (!rec) return notExecuted(callId, "plugin_not_found", { id: targetId });
        if (rec.pkg.provenance.createdBy !== "agent") {
          return notExecuted(callId, "update_needs_user", {
            id: targetId,
            createdBy: rec.pkg.provenance.createdBy,
            hint: "该插件不是 Agent 创建的：Agent 只自动改自己存的东西。可以另存一个新 id 交付，或请用户在插件库里批准候选",
          });
        }
        const version = typeof a.version === "string" && a.version.trim() ? a.version.trim() : nextVersion(rec.pkg.version);
        const prop = proposeUpdate(targetId, buildManifest(targetId, version));
        if (!prop.ok) return notExecuted(callId, "update_rejected", { id: targetId, msg: prop.msg });
        const ap = approveUpdate(targetId);
        if (!ap.ok) return notExecuted(callId, "update_failed", { id: targetId, msg: ap.msg });
        const after = getPlugin(targetId);
        const pureUi = isPureUiCaps(KIND_CAPS[kind]);
        const enabled = a.enable === true && pureUi ? setEnabled(targetId, true).ok : after?.state === "enabled";
        return {
          callId,
          ok: true,
          status: "applied",
          data: {
            pluginId: targetId, version, updated: true, enabled,
            history: after?.versions.length ?? 0,
            warnings: prop.warnings?.slice(0, 8) ?? [],
            hint: `已升版到 v${version}（旧版进版本栈，改坏了用 rollback_plugin 退回）`,
          },
        };
      }

      const manifest = buildManifest(id, "0.1.0");
      const stagedResult = stagePackage(manifest);
      if (!stagedResult.ok || !stagedResult.stagingId) {
        return notExecuted(callId, "invalid_package", { errors: stagedResult.errors.slice(0, 8) });
      }
      const installed = installStaged(stagedResult.stagingId);
      if (!installed.ok || !installed.id) {
        return notExecuted(callId, "install_failed", { msg: installed.msg });
      }
      // enable=true 且纯 UI 能力 → 自动启用；含 serial.send / agent.tool 的包保持停用（走 enable_plugin 批准）
      const pureUi = isPureUiCaps(KIND_CAPS[kind]);
      let enabled = false;
      if (a.enable === true && pureUi) {
        enabled = setEnabled(installed.id, true).ok;
      }
      return {
        callId,
        ok: true,
        status: "applied",
        data: {
          pluginId: installed.id, version: "0.1.0", state: enabled ? "enabled" : "installed_disabled",
          caps: KIND_CAPS[kind], enabled, warnings: stagedResult.warnings,
          // 让模型知道下次该带 update 而不是再存一份副本
          hint: `要改这个插件请带 update="${installed.id}"，会升版本而不是另建一个`,
        },
      };
    },
  }),
  defineTool({
    name: "enable_plugin",
    labelZh: "启用插件",
    effect: "draft_write",
    domain: "plugins",
    provenance: HOST,
    description:
      "Enable an installed-but-disabled local plugin by id. Pure-UI plugins auto-enable within scope; plugins carrying serial.send require local approval. A plugin with a `module` artifact must first pass the realm egress lockdown probe — module_probe_failed means it stayed disabled, with the per-entry reason. Args: { id: string }.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    summarize: (a) => `启用插件 ${String(a.id ?? "")}`,
    /** 携带非纯 UI 能力＝把"能向设备发送"重新挂回投影 → 无条件逐次批准（与旧实现同标准） */
    assess: (a, ctx) => {
      const record = getPlugin(String(a.id ?? ""));
      if (!record) return { refuse: notExecuted(ctx.callId, "plugin_not_found", { id: String(a.id ?? "") }) };
      return isPureUiCaps(record.pkg.capabilities)
        ? { meta: { effect: "draft_write", idempotent: true, reversible: true, mayTouchDevice: false } }
        : { meta: { effect: "protected_config", idempotent: false, reversible: true, mayTouchDevice: true } };
    },
    approvalBinding: (a) => ({ tool: "enable_plugin", id: String(a.id ?? "") }),
    planFor: (a) => {
      const id = String(a.id ?? "");
      const record = getPlugin(id);
      return `启用插件「${record?.pkg.name ?? id}」（${id}）将授予能力（${record?.pkg.capabilities.join("、") ?? "?"}），插件可向已连接设备发送数据。确认来源可信后批准。`;
    },
    execute: async (a, ctx) => {
      const id = String(a.id ?? "");
      const record = getPlugin(id);
      if (!record) return notExecuted(ctx.callId, "plugin_not_found", { id });
      if (record.state === "enabled") {
        return { callId: ctx.callId, ok: true, status: "applied", data: { id, state: "enabled", note: "插件已是启用状态" } };
      }
      // P99a-B1/B2：带逻辑模块（module 产物）的包必须先臂起 worker 并过封网自证才配启用。
      // 失败就停在这儿，回执带原因——不是"启用了以后再标红"。
      const probe = await armModulePackage(id);
      if (!probe.ok) return notExecuted(ctx.callId, "module_probe_failed", { id, msg: probe.msg });
      const r = setEnabled(id, true);
      if (!r.ok) return notExecuted(ctx.callId, "enable_failed", { id, msg: r.msg });
      return {
        callId: ctx.callId,
        ok: true,
        status: "applied",
        data: { id, state: "enabled", caps: record.pkg.capabilities, ...(probe.modules ? { modules: probe.modules, note: probe.msg } : {}) },
      };
    },
  }),
  defineTool({
    /* —— P97-I6：退回上一版。版本栈是"来回切换"（当前版会压回栈），所以再调一次即切回来 —— */
    name: "rollback_plugin",
    labelZh: "退回插件上一版",
    effect: "draft_write",
    domain: "plugins",
    provenance: HOST,
    description: "Revert a local plugin to its previous saved version (the stack the agent's own save_plugin updates build). Args: { id: string }. The stack toggles: calling it again returns to the version you just left. Requires the plugin-library authorization domain; enabled non-pure-UI plugins need local approval.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    summarize: (a) => `退回插件 ${String(a.id ?? "")} 上一版`,
    /** 启用中的非纯 UI 件回滚＝把另一版的能力重新挂回投影，与 enable_plugin 同标准 */
    assess: (a, ctx) => {
      const record = getPlugin(String(a.id ?? ""));
      if (!record) return { refuse: notExecuted(ctx.callId, "plugin_not_found", { id: String(a.id ?? "") }) };
      return !isPureUiCaps(record.pkg.capabilities) && record.state === "enabled"
        ? { meta: { effect: "protected_config", idempotent: false, reversible: true, mayTouchDevice: true } }
        : { meta: { effect: "draft_write", idempotent: false, reversible: true, mayTouchDevice: false } };
    },
    approvalBinding: (a) => ({ tool: "rollback_plugin", id: String(a.id ?? "") }),
    planFor: (a) => {
      const id = String(a.id ?? "");
      const record = getPlugin(id);
      return `回滚启用中的插件「${record?.pkg.name ?? id}」（${id}）到 v${record?.versions[record.versions.length - 1]?.version ?? "?"}，该版本的能力（${record?.pkg.capabilities.join("、") ?? "?"}）将重新生效。`;
    },
    execute: (a, ctx) => {
      const id = String(a.id ?? "");
      const r = rollbackPlugin(id);
      if (!r.ok) return notExecuted(ctx.callId, "rollback_failed", { id, msg: r.msg });
      return {
        callId: ctx.callId,
        ok: true,
        status: "applied",
        data: { id, version: getPlugin(id)?.pkg.version ?? "", msg: r.msg, remaining: getPlugin(id)?.versions.length ?? 0 },
      };
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
