/**
 * P88b-2 §12：本机 Agent 工具适配器（本地唯一执行面）。
 * - 组合设置四工具（SettingsSchema 单源）+ APP_ACTION_KINDS 全量动作 + Agent 专属只读工具；
 * - 每次执行前经 toolPolicy.decide() 判定（宿主可信代码；不读模型提交的 risk 字段）：
 *   require_local_approval / preview 档位 → 生成不可变批准请求并回执 not_executed；
 *   批准令牌绑定 (runId, tool, argsHash)，参数变化或过期即失效，重新评估（§7）；
 * - 数据分析场景：plot_channels / plot_window 只读工具，首次调用申请数据订阅租约（§6.1）；
 *   回执含 coverage（起止时间与 live 标记），不伪造新鲜数据；
 * - read_artifact：大回执 data 截断后的取回通道（context.ts 的 artifactRef=call:<id> 约定）。
 */
import { runAppAction } from "../ai/appActions";
import { APP_ACTION_KINDS } from "../ai/appActionKinds";
import { getSnapshot as getSerial } from "../serial/serialStore";
import { getSnapshot as getOperator } from "../operator/operatorStore";
import * as plot from "../plot/plotStore";
import { acquireDataLease, hasDataLease } from "../plot/dataLease";
import { actionMeta } from "./toolCatalog";
import { decide, type PolicyContext } from "./toolPolicy";
import { settingsAdapter } from "./settingsTools";
import { GENERAL_TOOLS, generalToolDefs, executeGeneralTool } from "./generalTools";
import { APPEARANCE_TOOLS, appearanceToolDefs, executeAppearanceTool } from "./appearanceTools";
import { RECEIPT_DATA_LIMIT } from "./context";
import {
  stagePackage,
  installStaged,
  setEnabled,
  getPlugin,
  getSnapshot as getPlugins,
} from "../plugins/pluginStore";
import { PURE_UI_CAPS, KIND_CONTRIB_KEY, type PluginCap } from "../plugins/pluginManifest";
import { ARTIFACT_KINDS, type ArtifactKind } from "../plugins/artifact";
import type { TaskAdapter, TaskContext, ToolCall, ToolReceipt } from "./types";

/** 单个 artifact 全量取回上限；超出返回截断说明（不整包塞给模型）。 */
export const ARTIFACT_READ_LIMIT = 64 * 1024;
/** plot_window 每通道抽稀点数硬顶。 */
export const PLOT_WINDOW_MAX_POINTS = 2000;
/** 批准令牌有效期：绑定单次执行，过期重新评估（§7.4）。 */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** save_plugin 派生能力：按产物类型最小授权，默认不含 serial.send（§9.3）。 */
const KIND_CAPS: Record<ArtifactKind, PluginCap[]> = {
  theme: ["theme.tokens"],
  widget: ["ui.widget", "telemetry.read"],
  panel: ["ui.panel", "telemetry.read"],
  motionPreset: ["motion.preset"],
  workspacePreset: ["workspace.preset"],
  workflow: ["workflow.compose"],
  reportView: ["report.view"],
};

/** save_plugin 默认 id：名称 slug 化 + user.agent 前缀（末段截短，留冲突后缀空间）。 */
function slugPluginId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "plugin";
  return `user.agent.${slug}`;
}

/** 与 pluginManifest 的 ID_RE 同形（本地预检给出更可读的错误码）。 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})+$/;

export interface ApprovalRequest {
  id: string; runId: string; callId: string; tool: string;
  argsSummary: string; argsHash: string; effect: string; plan: string;
  createdAt: number; expiresAt: number;
}

/** 审批门：UI 宿主实现；request 展示批准卡，takeToken 消费已批准令牌。 */
export interface ApprovalGate {
  request(req: ApprovalRequest): void;
  takeToken(runId: string, tool: string, argsHash: string, now: number): string | null;
  /** 用户拒绝：登记后同参数重试返回 approval_rejected，不重复弹卡 */
  reject(req: ApprovalRequest): void;
}

/** 参数摘要绑定：宿主端 FNV-1a（非加密，仅用于变更检测；绑定执行仍在宿主侧）。 */
export function argsHash(args: unknown): string {
  const s = JSON.stringify(args ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function deviceContext(): "real" | "sim" | "unknown" {
  const s = getSerial();
  // 无法判定是否实车时按 unknown 处理，不猜成仿真（HANDOVER §6.3）
  return s.status === "connected" ? "real" : "unknown";
}

function operatorLocked(): boolean {
  return getOperator().pkg !== null;
}

/** 每通道统计（尾部窗口），供 plot_channels 回执。 */
export function channelStats(id: string) {
  const d = plot.getChanData(id);
  const n = d.v.length;
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const v = d.v[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    points: n,
    last: n ? d.v[n - 1] : null,
    min: n ? min : null,
    max: n ? max : null,
    sampleRate: plot.sampleRate(id),
  };
}

/** 等间隔抽稀（保首尾），供 plot_window 回执。 */
export function decimate(t: number[], v: number[], maxPoints: number): { t: number[]; v: number[] } {
  const n = t.length;
  if (n <= maxPoints) return { t: [...t], v: [...v] };
  const out = { t: [] as number[], v: [] as number[] };
  const step = (n - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    out.t.push(t[idx]);
    out.v.push(v[idx]);
  }
  return out;
}

export interface LocalAgentAdapterOpts {
  runId: string;
  gate: ApprovalGate;
}

export function createLocalAgentAdapter(opts: LocalAgentAdapterOpts): TaskAdapter & {
  artifacts: Map<string, unknown>;
  leaseActive: () => boolean;
} {
  const { runId, gate } = opts;
  const artifacts = new Map<string, unknown>();
  let leaseRequested = false;

  const policyCtx = (ctx: TaskContext): PolicyContext => ({
    scope: ctx.scope,
    // 常规创造档位：授权范围=本任务全部 config_write；自定义档位按勾选域（P88b-3 §4.3）
    authorized: (key) => (ctx.scope === "create" ? true : (ctx.allowed ?? []).includes(key)),
    operatorLocked: operatorLocked(),
    deviceContext: deviceContext(),
  });

  const rememberArtifact = (receipt: ToolReceipt): ToolReceipt => {
    if (receipt.data === undefined) return receipt;
    if (JSON.stringify(receipt.data).length <= RECEIPT_DATA_LIMIT) return receipt;
    artifacts.set(`call:${receipt.callId}`, receipt.data);
    return {
      ...receipt,
      data: { truncated: true, artifactRef: `call:${receipt.callId}`, fullBytes: JSON.stringify(receipt.data).length },
    };
  };

  const notExecuted = (callId: string, code: string, data?: unknown): ToolReceipt => ({
    callId, ok: false, status: "not_executed", code, ...(data !== undefined ? { data } : {}),
  });

  const adapter: TaskAdapter & { artifacts: Map<string, unknown>; leaseActive: () => boolean } = {
    artifacts,
    leaseActive: () => hasDataLease(runId),
    definitions: [
      ...settingsAdapter.definitions,
      ...generalToolDefs,
      ...appearanceToolDefs,
      {
        name: "read_artifact",
        description: "Fetch the full data of a previously truncated tool receipt by artifactRef (call:<callId>). Read-only.",
        parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false },
      },
      {
        name: "plot_channels",
        description: "List 2D plot channels with per-channel stats (points/last/min/max/sampleRate) and data coverage. Requests a background data lease on first call so sampling continues while panels are closed. Read-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "plot_window",
        description: "Read a downsampled time window of given channels (defaults to all). Args: channelIds?: string[], maxPoints?: number (per channel, cap 2000). Returns relative seconds since session start. Read-only.",
        parameters: { type: "object", properties: { channelIds: { type: "array", items: { type: "string" } }, maxPoints: { type: "number" } }, additionalProperties: false },
      },
      {
        name: "run_app_action",
        description: "Run a named app action (openPanel/setTheme/applyPreset/addChannel/writeCard/writeTemplate/writeCommand/writeCodec/listProtocols/listCommands/listCards/xrayEvidence/…). Args: { kind: string, args?: object }. Deletion, overwrite, device send and protected operations require local approval and return needs_local_approval with the plan.",
        parameters: { type: "object", properties: { kind: { type: "string" }, args: { type: "object" } }, required: ["kind"], additionalProperties: false },
      },
      {
        name: "save_plugin",
        description: "Save an artifact as a reusable local plugin package (uartix-plugin). Args: { kind: one of theme|motionPreset|widget|panel|workspacePreset|workflow|reportView, name: string, payload: object (artifact content per kind; widget/panel payload = {format:'html',html} | {format:'declarative',blocks}), id?: string (dotted lowercase, default user.agent.*), desc?: string, enable?: boolean (auto-enable pure-UI plugin) }. Creates a NEW plugin; existing plugins are never overwritten. Plugins carry no device-send capability by default.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string" },
            name: { type: "string" },
            payload: { type: "object" },
            id: { type: "string" },
            desc: { type: "string" },
            enable: { type: "boolean" },
          },
          required: ["kind", "name", "payload"],
          additionalProperties: false,
        },
      },
      {
        name: "enable_plugin",
        description: "Enable an installed-but-disabled local plugin by id. Pure-UI plugins auto-enable within scope; plugins carrying serial.send require local approval. Args: { id: string }.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      },
      {
        name: "list_plugins",
        description: "List local plugin library entries (id/name/version/state/capabilities). Read-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    async execute(call: ToolCall, ctx: TaskContext): Promise<ToolReceipt> {
      if (ctx.signal.aborted) return notExecuted(call.callId, "cancelled");
      let parsed: Record<string, unknown> = {};
      if (call.arguments && call.arguments.trim()) {
        try { parsed = JSON.parse(call.arguments) as Record<string, unknown>; } catch { return notExecuted(call.callId, "invalid_json"); }
      }

      /* —— 设置四工具：schema 单源校验在 settingsAdapter —— */
      if (call.name.startsWith("settings_")) {
        return rememberArtifact(await settingsAdapter.execute(call, ctx));
      }

      /* —— read_artifact：大回执全量取回 —— */
      if (call.name === "read_artifact") {
        const ref = String(parsed.ref ?? "");
        if (!artifacts.has(ref)) return notExecuted(call.callId, "artifact_not_found", { ref });
        const data = artifacts.get(ref);
        const text = JSON.stringify(data);
        if (text.length > ARTIFACT_READ_LIMIT) {
          return { callId: call.callId, ok: true, status: "read", data: { truncated: true, head: text.slice(0, ARTIFACT_READ_LIMIT), totalBytes: text.length, note: "artifact exceeds read limit; request a narrower tool call" } };
        }
        return { callId: call.callId, ok: true, status: "read", data };
      }

      /* —— 数据分析只读工具（§6.1 租约）—— */
      if (call.name === "plot_channels" || call.name === "plot_window") {
        if (!leaseRequested) {
          leaseRequested = true;
          const granted = await acquireDataLease(runId, ctx.signal);
          if (!granted) return notExecuted(call.callId, "lease_busy", { hint: "数据租约队列超时或任务已取消，稍后重试或减少并发采集任务" });
        }
        const channels = plot.getSnapshot().channels;
        const origin = plot.timeOrigin();
        const coverage = { originMs: origin, live: hasDataLease(runId), note: hasDataLease(runId) ? "租约生效，数据持续采样" : "无实时订阅，仅返回已有缓存窗口" };
        if (call.name === "plot_channels") {
          return rememberArtifact({
            callId: call.callId, ok: true, status: "read",
            data: {
              channels: channels.map((c) => ({ id: c.id, name: c.name, tplId: c.tplId, fieldId: c.fieldId, ...channelStats(c.id) })),
              coverage,
            },
          });
        }
        const ids = Array.isArray(parsed.channelIds) ? parsed.channelIds.map(String) : channels.map((c) => c.id);
        const maxPoints = Math.min(Math.max(Math.floor(Number(parsed.maxPoints)) || 500, 10), PLOT_WINDOW_MAX_POINTS);
        const series = [];
        for (const id of ids) {
          const ch = channels.find((c) => c.id === id);
          if (!ch) continue;
          const d = plot.getChanData(id);
          series.push({ id, name: ch.name, ...decimate(d.t, d.v, maxPoints) });
        }
        return rememberArtifact({ callId: call.callId, ok: true, status: "read", data: { series, relativeSeconds: true, coverage } });
      }

      /* —— 应用动作：策略门 → 审批绑定 → 执行 —— */
      if (call.name === "run_app_action") {
        const kind = String(parsed.kind ?? "");
        if (!(APP_ACTION_KINDS as readonly string[]).includes(kind)) return notExecuted(call.callId, "unknown_action", { kind });
        const meta = actionMeta(kind);
        if (!meta) return notExecuted(call.callId, "unknown_action", { kind });
        const actionArgs = (parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args) ? parsed.args : {}) as Record<string, unknown>;
        const decision = decide(meta, policyCtx(ctx));
        if (decision === "deny") return notExecuted(call.callId, "denied_by_policy", { kind, effect: meta.effect, hint: "Operator 锁生效或策略禁止" });
        if (decision === "preview_only") return notExecuted(call.callId, "preview_only", { kind, hint: "当前档位为仅预览：内容已可生成草稿，不改动工作区" });
        if (decision === "require_local_approval") {
          const hash = argsHash({ kind, args: actionArgs });
          const now = Date.now();
          const token = gate.takeToken(runId, kind, hash, now);
          if (!token) {
            gate.request({
              id: crypto.randomUUID(), runId, callId: call.callId, tool: kind,
              argsSummary: JSON.stringify(actionArgs).slice(0, 600), argsHash: hash,
              effect: meta.effect, plan: describePlan(kind, meta.effect, actionArgs),
              createdAt: now, expiresAt: now + APPROVAL_TTL_MS,
            });
            return notExecuted(call.callId, "needs_local_approval", { kind, effect: meta.effect, hint: "等待用户在任务卡批准；批准后用相同参数重试" });
          }
          const r = await runAppAction(kind, actionArgs, { highPriv: true });
          if (!r.ok) return { callId: call.callId, ok: false, status: "error", code: "action_failed", data: { err: r.err ?? "动作执行失败" } };
          return rememberArtifact({ callId: call.callId, ok: true, status: "applied", data: r.data ?? null, revision: hash });
        }
        const r = await runAppAction(kind, actionArgs, { highPriv: true });
        if (!r.ok) return { callId: call.callId, ok: false, status: "error", code: "action_failed", data: { err: r.err ?? "动作执行失败" } };
        return rememberArtifact({
          callId: call.callId, ok: true,
          status: meta.effect === "read" || meta.effect === "analysis" ? "read" : "applied",
          data: r.data ?? null,
        });
      }

      /* —— 本地插件库（P88b-3 §9.3/§12）：list / save / enable —— */
      if (call.name === "list_plugins") {
        const plugins = getPlugins().plugins.map((p) => ({
          id: p.pkg.id, name: p.pkg.name, version: p.pkg.version, state: p.state, caps: p.pkg.capabilities,
        }));
        return { callId: call.callId, ok: true, status: "read", data: { plugins } };
      }

      if (call.name === "save_plugin") {
        // 档位门（§4.3）：preview 只预览；custom 需勾选「插件库」授权域
        if (ctx.scope === "preview") {
          return notExecuted(call.callId, "preview_only", { hint: "当前档位为仅预览：内容可生成但不会保存为插件" });
        }
        if (ctx.scope === "custom" && !(ctx.allowed ?? []).includes("plugins")) {
          return notExecuted(call.callId, "unauthorized_scope", { hint: "自定义档位未勾选「插件库」授权域，无法保存插件" });
        }
        const kind = String(parsed.kind ?? "") as ArtifactKind;
        if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
          return notExecuted(call.callId, "invalid_kind", { kind, supported: ARTIFACT_KINDS });
        }
        const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 60) : "";
        if (!name) return notExecuted(call.callId, "invalid_name", { hint: "name 必须是 1..60 字符" });
        const payload = parsed.payload;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          return notExecuted(call.callId, "invalid_payload", { hint: "payload 必须是对象（widget/panel 用 {format:'html'|'declarative',…}）" });
        }
        // id：用户指定或按名称 slug 化；与现有插件冲突自动加序号后缀，绝不覆盖
        const provided = typeof parsed.id === "string" ? parsed.id.trim().toLowerCase() : "";
        if (provided && !PLUGIN_ID_RE.test(provided)) {
          return notExecuted(call.callId, "invalid_id", { id: provided, hint: "id 必须是小写点分标识（每段 ≤32 字符），如 user.agent.battery-panel" });
        }
        let id = provided || slugPluginId(name);
        if (getPlugin(id)) {
          let n = 2;
          while (getPlugin(`${id}-${n}`)) n++;
          id = `${id}-${n}`;
        }
        const desc = typeof parsed.desc === "string" ? parsed.desc.trim().slice(0, 300) : "";
        const manifest = {
          format: "uartix-plugin",
          schemaVersion: 2,
          id,
          version: "0.1.0",
          name,
          ...(desc ? { desc } : {}),
          hostApi: "^1.0",
          capabilities: [...KIND_CAPS[kind]],
          contributions: { [KIND_CONTRIB_KEY[kind]]: [{ id: "main", entry: "main.json", name }] },
          artifacts: { "main.json": { ...payload, kind } },
          provenance: { createdBy: "agent", reviewed: false },
        };
        const stagedResult = stagePackage(manifest);
        if (!stagedResult.ok || !stagedResult.stagingId) {
          return notExecuted(call.callId, "invalid_package", { errors: stagedResult.errors.slice(0, 8) });
        }
        const installed = installStaged(stagedResult.stagingId);
        if (!installed.ok || !installed.id) {
          return notExecuted(call.callId, "install_failed", { msg: installed.msg });
        }
        // enable=true 且纯 UI 能力 → 自动启用；含 serial.send 的包保持停用（走 enable_plugin 审批）
        const pureUi = KIND_CAPS[kind].every((c) => (PURE_UI_CAPS as readonly string[]).includes(c));
        let enabled = false;
        if (parsed.enable === true && pureUi) {
          enabled = setEnabled(installed.id, true).ok;
        }
        return rememberArtifact({
          callId: call.callId, ok: true, status: "applied",
          data: { pluginId: installed.id, state: enabled ? "enabled" : "installed_disabled", caps: KIND_CAPS[kind], enabled, warnings: stagedResult.warnings },
        });
      }

      if (call.name === "enable_plugin") {
        const id = String(parsed.id ?? "");
        const record = getPlugin(id);
        if (!record) return notExecuted(call.callId, "plugin_not_found", { id });
        if (ctx.scope === "preview") {
          return notExecuted(call.callId, "preview_only", { id, hint: "当前档位为仅预览：不改变插件状态" });
        }
        if (ctx.scope === "custom" && !(ctx.allowed ?? []).includes("plugins")) {
          return notExecuted(call.callId, "unauthorized_scope", { id, hint: "自定义档位未勾选「插件库」授权域" });
        }
        if (record.state === "enabled") {
          return { callId: call.callId, ok: true, status: "applied", data: { id, state: "enabled", note: "插件已是启用状态" } };
        }
        // 携带 serial.send 等非纯 UI 能力 → 审批门（§4.3/§7）；纯 UI 直接启用
        const pureUi = record.pkg.capabilities.every((c) => (PURE_UI_CAPS as readonly string[]).includes(c));
        if (!pureUi) {
          const hash = argsHash({ tool: "enable_plugin", id });
          const now = Date.now();
          const token = gate.takeToken(runId, "enable_plugin", hash, now);
          if (!token) {
            gate.request({
              id: crypto.randomUUID(), runId, callId: call.callId, tool: "enable_plugin",
              argsSummary: JSON.stringify({ id }), argsHash: hash,
              effect: "device_send",
              plan: `启用插件「${record.pkg.name}」（${id}）将授予能力（${record.pkg.capabilities.join("、")}），插件可向已连接设备发送数据。确认来源可信后批准。`,
              createdAt: now, expiresAt: now + APPROVAL_TTL_MS,
            });
            return notExecuted(call.callId, "needs_local_approval", { id, caps: record.pkg.capabilities, hint: "等待用户在任务卡批准；批准后用相同参数重试" });
          }
        }
        const r = setEnabled(id, true);
        if (!r.ok) return notExecuted(call.callId, "enable_failed", { id, msg: r.msg });
        return { callId: call.callId, ok: true, status: "applied", data: { id, state: "enabled", caps: record.pkg.capabilities } };
      }

      /* —— P88e B1 通用工具：fs/web/shell（域门与 shell 三重门在 generalTools 内裁决）—— */
      if ((GENERAL_TOOLS as readonly string[]).includes(call.name)) {
        return rememberArtifact(await executeGeneralTool(call, ctx, runId, gate));
      }

      /* —— P88b-4 A2 外观工具：token 读写/配方/取色/保存主题（档位门在 appearanceTools 内裁决）—— */
      if ((APPEARANCE_TOOLS as readonly string[]).includes(call.name)) {
        return rememberArtifact(await executeAppearanceTool(call, ctx));
      }

      return notExecuted(call.callId, "unknown_tool");
    },
  };
  return adapter;
}

/** 人类可读的批准计划（§7.1：目标、实际影响、差异提示）。 */
function describePlan(kind: string, effect: string, args: Record<string, unknown>): string {
  const target = typeof args.id === "string" ? `（目标 ${args.id}）` : "";
  switch (effect) {
    case "device_send": return `动作「${kind}」可能向已连接设备/总线发送数据${target}。确认目标设备与参数后批准；无法判定实车时不自动执行。`;
    case "destructive_write": return `动作「${kind}」会删除或覆盖你已定义的内容${target}。批准前请查看参数；新建副本不需要批准。`;
    case "safety_boundary": return `动作「${kind}」触及安全边界（急停/校准/全局控制）${target}，必须人工确认。`;
    case "protected_config": return `动作「${kind}」修改受保护配置${target}，需要人工确认。`;
    default: return `动作「${kind}」需要人工批准（${effect}）${target}。`;
  }
}
