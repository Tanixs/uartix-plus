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
import { SETTINGS_SCHEMA, schemaEntry, validateValue, describeEntries, agentWritableKeys } from "../settings/settingsSchema";
import type { TaskAdapter, TaskContext, ToolCall, ToolReceipt } from "./types";

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

export type UndoResult = "undone" | "token_expired" | "revision_conflict";

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

function fail(callId: string, code: string): ToolReceipt { return { callId, ok: false, status: "not_executed", code }; }

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

export const settingsAdapter: TaskAdapter = {
  definitions: [
    {
      name: "settings_describe",
      description: "Describe all settings: key, type, range/enum values, group, label, sensitivity (safe/protected/secret), reversibility, restart requirement. No current values, no secrets. Call before read or patch.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "settings_read",
      description: "Read current settings with secrets masked (only 'configured' booleans for API key / token). Returns revision required by settings_preview_patch and settings_apply.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "settings_preview_patch",
      description: "Validate a patch and return the diff plus baseRevision without applying anything. Rejected keys return the reason; nothing changes.",
      parameters: { type: "object", properties: { patch: { type: "object" } }, required: ["patch"], additionalProperties: false },
    },
    {
      name: "settings_apply",
      description: "Atomically apply a validated patch of reversible safe settings (theme, locale, zoom 90/100/110/125, decimals 0..6, perfHud, workspace preset, cellSize, fcCellSize 20..96, showThinking, chartPalette, conWrap, reduceMotion). Requires revision from settings_read; protected/secret keys are rejected as a whole patch. Returns undoToken valid for this session only.",
      parameters: { type: "object", properties: { patch: { type: "object" }, revision: { type: "string" } }, required: ["patch", "revision"], additionalProperties: false },
    },
  ],
  async execute(call: ToolCall, ctx: TaskContext): Promise<ToolReceipt> {
    const failCall = (code: string) => fail(call.callId, code);
    if (ctx.signal.aborted) return failCall("cancelled");
    if (call.name === "settings_describe") {
      return { callId: call.callId, ok: true, status: "read", data: { schema: describeEntries(), writableKeys } };
    }
    if (call.name === "settings_read") {
      return { callId: call.callId, ok: true, status: "read", data: readSettings(), revision: settingsRevision() };
    }
    let args: { patch?: unknown; revision?: string };
    try { args = JSON.parse(call.arguments); } catch { return failCall("invalid_json"); }
    if (call.name === "settings_preview_patch") {
      const v = validatePatch(args.patch);
      if (!v.ok) return failCall(v.reason);
      return { callId: call.callId, ok: true, status: "validated", data: { diff: diffPatch(v.ok ? Object.fromEntries(v.entries) : {}), baseRevision: settingsRevision() } };
    }
    if (call.name !== "settings_apply") return failCall("unknown_tool");
    const v = validatePatch(args.patch);
    if (!v.ok) return failCall(v.reason);
    if (ctx.scope !== "create") return failCall("preview_only");
    if (args.revision !== settingsRevision()) return failCall("revision_conflict");
    const before = safeSettings();
    settings.patch(Object.fromEntries(v.entries) as Partial<Settings>);
    const token = crypto.randomUUID();
    undo.set(token, { before, after: settingsRevision() });
    return { callId: call.callId, ok: true, status: "applied", data: safeSettings(), revision: settingsRevision(), undoToken: token };
  },
};
