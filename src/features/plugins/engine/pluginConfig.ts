/**
 * P174-B2：插件配置值的**纯判据**。
 *
 * `contributes.settings` 早就被清单校验过（键名/类型/默认值），但一直没有"值"存哪儿。
 * 这里补最后一段：默认值 + 用户覆盖值 → 生效值；以及键级 patch（`null` = 删除覆盖、回落默认）。
 *
 * 两条刻意的做法：
 * 1. **只存覆盖值**，不存一份"默认值快照"——清单升级改了默认值时，没动过的字段要能自动跟上；
 * 2. **校验按字段声明走**，不在 pluginEngine 里再手写一遍类型判断。两处各写一遍，漂移时
 *    症状是"面板说保存了、插件读到的是旧值"。
 */

import type { PluginSettingField } from "./manifest";

/** 单个插件的覆盖值体积上限。配置是偏好，不是数据仓库。 */
export const PLUGIN_CONFIG_MAX_BYTES = 64 * 1024;
/** 所有插件覆盖值合计上限（写进 `settings.json`，必须给个顶）。 */
export const PLUGIN_CONFIG_TOTAL_MAX_BYTES = 1024 * 1024;

const MAX_STRING_LEN = 2048;

export interface ConfigValueResult {
  ok: boolean;
  errors: string[];
  /** 校验通过的覆盖值（只含用户改过的键）。 */
  values: Record<string, string | number | boolean>;
}

/** 默认值表：只由清单决定，不读存储。 */
export function defaultPluginConfig(fields: readonly PluginSettingField[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) out[f.key] = f.default;
  return out;
}

/** 生效值 = 默认值 + 覆盖值（覆盖值里不认识/类型不对的键不会进到这里，写入口已挡）。 */
export function effectivePluginConfig(
  fields: readonly PluginSettingField[],
  overrides: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out = defaultPluginConfig(fields);
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(overrides, f.key)) {
      const v = overrides[f.key];
      if (checkValue(f, v) === null) out[f.key] = v as string | number | boolean;
    }
  }
  return out;
}

function checkValue(f: PluginSettingField, v: unknown): string | null {
  switch (f.type) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `「${f.key}」必须是数字`;
      if (typeof f.min === "number" && v < f.min) return `「${f.key}」不能小于 ${f.min}`;
      if (typeof f.max === "number" && v > f.max) return `「${f.key}」不能大于 ${f.max}`;
      return null;
    case "boolean":
      return typeof v === "boolean" ? null : `「${f.key}」必须是 true / false`;
    case "enum":
      if (typeof v !== "string") return `「${f.key}」必须是选项之一`;
      return Array.isArray(f.options) && f.options.includes(v)
        ? null
        : `「${f.key}」只能是：${(f.options ?? []).join(" / ")}`;
    case "string":
      if (typeof v !== "string") return `「${f.key}」必须是字符串`;
      if (v.length > MAX_STRING_LEN) return `「${f.key}」超过 ${MAX_STRING_LEN} 字符`;
      return null;
  }
}

function byteLen(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 应用一次键级 patch。
 *
 * - patch 里出现的键必须在清单里声明过，否则**整单拒绝**（静默忽略会造出"保存了但不生效"）；
 * - `null` = 删除该键的覆盖值（回落默认）；
 * - 结果只保留"与默认值不同"的键——用户把值改回默认时，覆盖自然消失，清单升级时能继续跟上。
 */
export function applyPluginConfigPatch(
  fields: readonly PluginSettingField[],
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): ConfigValueResult {
  const errors: string[] = [];
  const declared = new Map(fields.map((f) => [f.key, f]));
  const next: Record<string, string | number | boolean> = {};

  // 先把现有覆盖值里合法的键收进来（存储可能被手改过）
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(current, f.key)) continue;
    const v = current[f.key];
    if (checkValue(f, v) === null) next[f.key] = v as string | number | boolean;
  }

  for (const [key, value] of Object.entries(patch)) {
    const f = declared.get(key);
    if (!f) {
      errors.push(`清单里没有配置项「${key}」`);
      continue;
    }
    if (value === null) {
      delete next[key];
      continue;
    }
    const err = checkValue(f, value);
    if (err) {
      errors.push(err);
      continue;
    }
    next[key] = value as string | number | boolean;
  }

  if (errors.length) return { ok: false, errors, values: next };

  // 去掉等于默认值的覆盖：只存差异，默认值升级才能自动跟上
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(next, f.key) && next[f.key] === f.default) delete next[f.key];
  }

  if (byteLen(next) > PLUGIN_CONFIG_MAX_BYTES) {
    return { ok: false, errors: [`配置超过 ${Math.round(PLUGIN_CONFIG_MAX_BYTES / 1024)}KB`], values: {} };
  }
  return { ok: true, errors: [], values: next };
}

/** 用完整覆盖值替换（撤销/回退用；不走键级合并）。 */
export function normalizePluginConfig(
  fields: readonly PluginSettingField[],
  values: Readonly<Record<string, unknown>>,
): ConfigValueResult {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(values)) patch[key] = values[key];
  return applyPluginConfigPatch(fields, {}, patch);
}

/** 与当前覆盖值相比，把一个目标覆盖值表达成一组键级 patch（含删除多出来的键）。 */
export function diffPluginConfig(
  fields: readonly PluginSettingField[],
  current: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const declared = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(current)) {
    if (declared.has(key) && !Object.prototype.hasOwnProperty.call(target, key)) patch[key] = null;
  }
  for (const [key, value] of Object.entries(target)) {
    if (declared.has(key)) patch[key] = value;
  }
  return patch;
}
