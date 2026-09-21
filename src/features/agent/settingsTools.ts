/**
 * P88b-1 §8：设置工具四件套（describe / read / preview_patch / apply）。
 * 校验器与可写白名单全部派生自 SettingsSchema 单一来源（settingsSchema.ts），
 * 不再维护独立 validators Map。
 * - read：safe 键返回值；protected 键返回值（非秘密配置）；secret 键只返回 configured。
 * - preview_patch：零副作用，返回 diff 与 baseRevision。
 * - apply：仅 safe 且可撤销键；逐字段验证；非法/受保护键混入则整体拒绝；
 *   revision 冲突拒绝；一次修改一步撤销；撤销令牌仅会话内有效（详设 §5.4）。
 */
import * as settings from "../settings/settingsStore";
import type { Settings } from "../settings/settingsStore";
import { SETTINGS_SCHEMA, schemaEntry, validateValue, describeEntries, agentWritableKeys, agentWritableHint } from "../settings/settingsSchema";
import { DOMAIN_ZH } from "./scopeTiers";
import { adapterFromEntries, buildToolCtx, defineTool, newRunScratch, type AgentToolEntry, type ToolRegistry } from "./toolRegistry";
import type { ApprovalGate } from "./toolRegistry";
import type { TaskAdapter, ToolReceipt } from "./types";

/** 独立设置适配器没有 UI 可以弹批准卡：这条 gate 恒不授权，需要批准的工具一律回 needs_local_approval。
 *  设置四工具里有副作用的只有 settings_apply，且它由域门裁决、不走批准，所以这里永远是空转。 */
const silentGate: ApprovalGate = { request: () => {}, takeToken: () => null, reject: () => {} };
const HOST = { kind: "host" } as const;

const writableKeys = agentWritableKeys();

export function safeSettings() {
  const state = settings.getSnapshot();
  return Object.fromEntries(writableKeys.map((key) => [key, state[key]]));
}

/** 全量脱敏快照：safe/protected 给值，secret 只给 configured */
export function readSettings() {
  const state = settings.getSnapshot();
  const out: Record<string, unknown> = {};
  for (const entry of SETTINGS_SCHEMA) {
    const value = state[entry.key];
    if (entry.sensitivity === "secret") out[entry.key as string] = { configured: Boolean(value) };
    else out[entry.key as string] = value;
  }
  return out;
}

export function settingsRevision() { return JSON.stringify(safeSettings()); }

interface UndoItem { before: Partial<Settings>; after: string }
const undo = new Map<string, UndoItem>();

export type UndoResult = "undone" | "token_expired" | "revision_conflict" | "unrouted_tool";

/** 撤销结果三态：成功 / 令牌不存在（跨重启或已消费）/ 之后又被修改（详设 §5.4 H3） */
export function undoSettingsDetailed(token: string): UndoResult {
  const item = undo.get(token);
  if (!item) return "token_expired";
  if (settingsRevision() !== item.after) return "revision_conflict";
  settings.patch(item.before);
  undo.delete(token);
  return "undone";
}

export function undoSettings(token: string): boolean {
  return undoSettingsDetailed(token) === "undone";
}

function fail(callId: string, code: string, data?: unknown): ToolReceipt {
  return { callId, ok: false, status: "not_executed", code, ...(data !== undefined ? { data } : {}) };
}

/** 逐字段验证 patch；返回 null 表示合法，否则返回拒绝原因。 */
export function validatePatch(patch: unknown): { ok: true; entries: [string, unknown][] } | { ok: false; reason: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, reason: "invalid_patch_shape" };
  const entries = Object.entries(patch as Record<string, unknown>);
  if (!entries.length) return { ok: false, reason: "empty_patch" };
  for (const [key, value] of entries) {
    const entry = schemaEntry(key);
    if (!entry) return { ok: false, reason: `unknown_setting:${key}` };
    if (entry.sensitivity !== "safe") return { ok: false, reason: `protected_or_secret_setting:${key}` };
    if (!entry.reversible) return { ok: false, reason: `irreversible_setting:${key}` };
    if (!validateValue(entry, value)) return { ok: false, reason: `invalid_value:${key}` };
  }
  return { ok: true, entries };
}

/** preview 与 apply 共用的 diff 计算（基于 safe 可写键快照） */
export function diffPatch(patch: Record<string, unknown>) {
  const before = safeSettings();
  return Object.entries(patch).map(([key, next]) => ({ key, from: before[key], to: next }));
}

/**
 * 设置四工具的五件套（P99a-A2）：一条 entry 同时给出 schema、中文名、授权域、副作用、
 * 参数摘要与撤销路由。此前这些散在 defs / TOOL_LABEL / summarizeArgs / UNDO_ROUTES /
 * 本文件内的 hasDomain 五处，加一支工具要改五个地方且漏一处不报错。
 */
export const settingsToolEntries: AgentToolEntry[] = [
  defineTool({
    name: "settings_describe",
    labelZh: "设置项目录",
    effect: "read",
    domain: null,
    provenance: HOST,
    description: "Describe all settings: key, type, range/enum values, group, label, sensitivity (safe/protected/secret), reversibility, restart requirement. No current values, no secrets. Call before read or patch.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "查询可改设置项",
    execute: (_a, ctx) => ({ callId: ctx.callId, ok: true, status: "read", data: { schema: describeEntries(), writableKeys } }),
  }),
  defineTool({
    name: "settings_read",
    labelZh: "读取设置",
    effect: "read",
    domain: null,
    provenance: HOST,
    description: "Read current settings with secrets masked (only 'configured' booleans for API key / token). Returns revision required by settings_preview_patch and settings_apply.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "读取当前设置",
    execute: (_a, ctx) => ({ callId: ctx.callId, ok: true, status: "read", data: readSettings(), revision: settingsRevision() }),
  }),
  defineTool({
    name: "settings_preview_patch",
    labelZh: "预览设置补丁",
    effect: "read",
    domain: null,
    provenance: HOST,
    description: "Validate a patch and return the diff plus baseRevision without applying anything. Rejected keys return the reason; nothing changes.",
    parameters: { type: "object", properties: { patch: { type: "object" } }, required: ["patch"], additionalProperties: false },
    summarize: (a) => {
      const keys = Object.keys((a.patch as Record<string, unknown>) ?? {});
      return keys.length ? `修改 ${keys.slice(0, 4).join("、")}${keys.length > 4 ? ` 等 ${keys.length} 项` : ""}` : "应用设置修改";
    },
    execute: (a, ctx) => {
      const v = validatePatch(a.patch);
      if (!v.ok) return fail(ctx.callId, v.reason);
      return { callId: ctx.callId, ok: true, status: "validated", data: { diff: diffPatch(v.ok ? Object.fromEntries(v.entries) : {}), baseRevision: settingsRevision() } };
    },
  }),
  defineTool({
    name: "settings_apply",
    labelZh: "应用设置",
    // validatePatch 已挡掉 protected/secret 键，所以这里能走到就只是"可逆的安全键写入"
    effect: "config_write",
    domain: "config",
    provenance: HOST,
    description: `Atomically apply a validated patch of reversible safe settings (${agentWritableHint()}). Needs the ${DOMAIN_ZH.config} authorization. Requires revision from settings_read; protected/secret keys are rejected as a whole patch. Returns undoToken valid for this session only.`,
    parameters: { type: "object", properties: { patch: { type: "object" }, revision: { type: "string" } }, required: ["patch", "revision"], additionalProperties: false },
    summarize: (a) => {
      const keys = Object.keys((a.patch as Record<string, unknown>) ?? {}).filter((k) => k !== "revision");
      return keys.length ? `修改 ${keys.slice(0, 4).join("、")}${keys.length > 4 ? ` 等 ${keys.length} 项` : ""}` : "应用设置修改";
    },
    undoRoute: (token) => undoSettingsDetailed(token),
    execute: (a, ctx) => {
      const callId = ctx.callId;
      const v = validatePatch(a.patch);
      if (!v.ok) return fail(callId, v.reason);
      // P92-C：域门由管线的 entry.domain 执行，这里不再自判"是不是 create 档"
      if (a.revision !== settingsRevision()) return fail(callId, "revision_conflict");
      const before = safeSettings();
      settings.patch(Object.fromEntries(v.entries) as Partial<Settings>);
      const token = crypto.randomUUID();
      undo.set(token, { before, after: settingsRevision() });
      return { callId, ok: true, status: "applied", data: safeSettings(), revision: settingsRevision(), undoToken: token };
    },
  }),
];

/**
 * 独立设置适配器：MCP 与测试仍按"只挂设置四工具"用它，但走的**必须是同一条管线**——
 * 留着一条不带门的第二执行路径，就是 §1.2 里第 5 号静默点的又一个副本。
 */
export const settingsAdapter: TaskAdapter & { registry: ToolRegistry } = adapterFromEntries(
  settingsToolEntries,
  { truncate: (r) => r, gate: silentGate, now: () => Date.now(), newRequestId: () => crypto.randomUUID() },
  (t) => buildToolCtx(t, { scope: t.scope, authorized: () => true, operatorLocked: false, deviceContext: "unknown" }, newRunScratch()),
);
