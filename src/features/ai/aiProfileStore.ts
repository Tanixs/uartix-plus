/**
 * P110-B1：AI **供应商 / 模型档案表**。
 *
 * 为什么单独一个 store，而不是往 `Settings` 里加四个键：
 *  - `settingsSchema.ts` 的 `SettingEntry` 是一个**只有标量**的可判别联合
 *    （enum / int / number / boolean / string），塞一张表进去要么给它加第 6 个分支、
 *    要么把表 JSON 化成一个 `string` 键——后者会让 `validateValue` 退化成"长度 ≤ n"，
 *    而"哪个模型属于哪个供应商"这种结构问题根本不在它的表达力里；
 *  - 更要紧的是 `settingsTools.readSettings()` 是**按 schema 逐键吐值**的（`settingsSchema`
 *    驱动），一张含 `apiKey` 的表被它原样序列化出去，就是"把密钥发给模型"的事故
 *    （§8-38：能力面开放、权限面封闭）。独立 store = 默认不进那条通路，
 *    要暴露什么投影由这里明说（`redactedProjection()`）。
 *
 * 依赖纪律：本模块**只**从 `settings/settingsStore` 取类型与预置模板，不 import
 * `agent/provider`（那边会 import 本模块，双向就是环——`check-import-cycles` 门会红）。
 * 因此"发送前清洗"不在这里做：这里存的是**用户贴进去的原样**，清洗只有一个地方（provider.ts）。
 *
 * 零兼容（用户 2026-09-22 裁决：未发布、无存量用户）：这张表**没有版本号也不做迁移**，
 * 旧的四个标量字段直接消失，第一次启动按预置建一条默认供应商。
 */
import { useSyncExternalStore } from "react";
import { AI_PRESETS, type AiFormat } from "../settings/settingsStore";

/** 一档"思考强度"：界面显示名 + 这一档实际下发给 API 的**静态**参数对象 */
/**
 * 一档思考强度的参数值。**允许一层嵌套**：真实形状就有嵌套的——Anthropic 是
 * `thinking: {type:"enabled", budget_tokens:8192}`，只收标量的扁平表表达不了它。
 * 深度、每层键数、键名字符集都在读取时钳死（sanitizeParams），越界整档丢弃：
 * 这些键值直接进 HTTP body，不能变成代码（详设 §2′.7.2）。
 */
export type ThinkingParamValue =
  | string | number | boolean | null | ThinkingParamValue[] | { [key: string]: ThinkingParamValue };

export interface ThinkingLevel {
  label: string;
  /** 空对象 = 这一档什么都不发。允许一层嵌套（见 ThinkingParamValue 的注释） */
  params: Record<string, ThinkingParamValue>;
}

export interface AiProvider {
  id: string;
  /** 界面上说的名字（"我的 DeepSeek"） */
  label: string;
  baseUrl: string;
  /** 原样存储；清洗只发生在发送那一刻 */
  apiKey: string;
  format: AiFormat;
  /** 留空 = 跟随系统 / 无 */
  proxy: string;
  noProxy: string;
  enabled: boolean;
  createdAt: number;
}

export interface AiModelProfile {
  id: string;
  /** 归属：一模型一供应商。"把同一个模型挂到多个供应商"不借 ——
   *  那正是"每个模型一份 baseUrl"的分叉源头（详设 §2′.7 对表最后一列） */
  providerId: string;
  label: string;
  /** 真正发给 API 的名字 */
  model: string;
  /** 上下文窗口：压缩阈值的分母（详设 §2′.3） */
  contextTokens: number;
  /** 单次回复的输出上限；宿主侧另有钳制，见 provider 的 maxTokens 阶梯 */
  maxOutputTokens: number;
  /** 思考强度档位。空 / 缺省 = 这个模型没有思考开关 ⇒ 界面上那枚选择器**整个不出现** */
  thinkingLevels: ThinkingLevel[];
  /** `thinkingLevels[].label` 之一；对不上时按"未选"处理 */
  defaultThinking: string;
  /** 逐模型温度；不填跟随全局 `aiTemperature` */
  temperature?: number;
  /**
   * 会不会看图。P112-B 加的一枚徽标位 —— 它是"用户填一次的事实"，不是我们从模型名猜的：
   * 猜错会让人把图片发给一个收不了的模型。老档案没这个字段就是 undefined ⇒ 不显示徽标
   * （零兼容裁决 2026-09-22：未发布、无存量用户，不做迁移表）。
   */
  vision?: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface AiProfileState {
  providers: AiProvider[];
  models: AiModelProfile[];
  /** 当前使用的那一对。id 不存在时按"第一个可用"回落（见 activeRef） */
  activeProviderId: string;
  activeModelId: string;
}

const KEY = "vs.aiProfiles";
const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/** 内置预置 → 第一次启动的默认供应商/模型（只建一条，不是把七家都塞进列表） */
function seed(): AiProfileState {
  const p = AI_PRESETS.deepseek;
  const now = Date.now();
  const provider: AiProvider = {
    id: "deepseek",
    label: p.label,
    baseUrl: p.baseUrl,
    apiKey: "",
    format: "chat",
    proxy: "",
    noProxy: "",
    enabled: true,
    createdAt: now,
  };
  const model: AiModelProfile = {
    id: "deepseek-v4-pro",
    providerId: provider.id,
    label: p.model,
    model: p.model,
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    thinkingLevels: [],
    defaultThinking: "",
    enabled: true,
    createdAt: now,
  };
  return { providers: [provider], models: [model], activeProviderId: provider.id, activeModelId: model.id };
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const finite = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;

const FORMATS: readonly AiFormat[] = ["chat", "anthropic", "responses"];

/** 静态参数清洗：只收标量与有限的对象/数组；深度 ≤3、每层 ≤12 键、键名限 [w.-]{1,64} */
function sanitizeParams(v: unknown, depth = 0): Record<string, ThinkingParamValue> {
  const out: Record<string, ThinkingParamValue> = {};
  if (!v || typeof v !== "object" || Array.isArray(v) || depth > 3) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 12)) {
    if (!/^[w.-]{1,64}$/.test(k)) continue;
    out[k] = cleanParam(val, depth + 1);
  }
  return out;
}
function cleanParam(val: unknown, depth: number): ThinkingParamValue {
  if (val === null) return null;
  const t = typeof val;
  if (t === "string") return (val as string).slice(0, 512);
  if (t === "number") return Number.isFinite(val as number) ? (val as number) : null;
  if (t === "boolean") return val as boolean;
  if (depth > 3) return null;
  if (Array.isArray(val)) return val.slice(0, 12).map((x) => cleanParam(x, depth + 1));
  if (t === "object") return sanitizeParams(val, depth);
  return null; // function / symbol / bigint 一律丢
}

function readThinkingLevels(v: unknown): ThinkingLevel[] {
  if (!Array.isArray(v)) return [];
  const out: ThinkingLevel[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    // params 只收字面量：任何数组/对象/函数形状都整档丢掉（宁可少一档，也不把结构带进请求体）
    const params: ThinkingLevel["params"] = {};
    const p = o.params;
    if (p && typeof p === "object" && !Array.isArray(p)) {
      for (const [k, val] of Object.entries(p as Record<string, unknown>)) {
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean" || val === null) {
          params[k] = val;
        }
      }
    }
    if (label) out.push({ label, params });
  }
  return out.slice(0, 8);
}

function normalizeProvider(raw: unknown): AiProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, "").trim();
  if (!id) return null;
  const format = FORMATS.includes(o.format as AiFormat) ? (o.format as AiFormat) : "chat";
  return {
    id,
    label: str(o.label, id),
    baseUrl: str(o.baseUrl, ""),
    apiKey: str(o.apiKey, ""),
    format,
    proxy: str(o.proxy, ""),
    noProxy: str(o.noProxy, ""),
    enabled: bool(o.enabled, true),
    createdAt: finite(o.createdAt, Date.now()),
  };
}

function normalizeModel(raw: unknown): AiModelProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, "").trim();
  const providerId = str(o.providerId, "").trim();
  if (!id || !providerId) return null;
  const temperature =
    typeof o.temperature === "number" && Number.isFinite(o.temperature)
      ? Math.max(0, Math.min(2, o.temperature))
      : undefined;
  return {
    id,
    providerId,
    label: str(o.label, str(o.model, id)),
    model: str(o.model, ""),
    contextTokens: finite(o.contextTokens, DEFAULT_CONTEXT_TOKENS),
    maxOutputTokens: finite(o.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    thinkingLevels: readThinkingLevels(o.thinkingLevels),
    defaultThinking: str(o.defaultThinking, ""),
    ...(temperature === undefined ? {} : { temperature }),
    enabled: bool(o.enabled, true),
    createdAt: finite(o.createdAt, Date.now()),
  };
}

/** 读档：任何一步坏掉都整表退回 seed（半张表比空表更危险——它会让人以为配好了） */
function load(): AiProfileState {
  const fresh = seed();
  if (typeof localStorage === "undefined") return fresh;
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    parsed = JSON.parse(raw);
  } catch {
    return fresh;
  }
  if (!parsed || typeof parsed !== "object") return fresh;
  const o = parsed as Record<string, unknown>;
  const providers = (Array.isArray(o.providers) ? o.providers : [])
    .map(normalizeProvider)
    .filter((x): x is AiProvider => !!x);
  const models = (Array.isArray(o.models) ? o.models : [])
    .map(normalizeModel)
    .filter((x): x is AiModelProfile => !!x);
  if (!providers.length || !models.length) return fresh;
  // 孤儿模型（供应商被删了）整条丢掉：留着它，`activeRef` 就得替它编一个不存在的 baseUrl
  const kept = models.filter((m) => providers.some((p) => p.id === m.providerId));
  if (!kept.length) return fresh;
  return {
    providers,
    models: kept,
    activeProviderId: str(o.activeProviderId, fresh.activeProviderId),
    activeModelId: str(o.activeModelId, kept[0].id),
  };
}

let snapshot: AiProfileState = load();
const subs = new Set<() => void>();

function commit(next: AiProfileState): void {
  snapshot = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // 存不下（配额/隐私模式）：内存里的这份仍然有效，界面照常工作。
      // 不弹错误条——那是"你的这次改动会丢"级别的事，重启后回到 seed 才看得见。
    }
  }
  subs.forEach((f) => f());
}

export function subscribeAiProfiles(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getAiProfiles(): AiProfileState {
  return snapshot;
}

/** 组件侧订阅（与 `settingsStore.useSettings` 同一形状：store 不引组件，钩子住在 store 里） */
export function useAiProfiles(): AiProfileState {
  return useSyncExternalStore(subscribeAiProfiles, getAiProfiles);
}

/* ================= 选择器（读的全部口径都收在这里） ================= */

export interface ActiveAi {
  provider: AiProvider;
  model: AiModelProfile;
}

/** 回环地址的供应商不需要密钥（本地 Ollama / LM Studio / vLLM）。
 *  这条取代旧的 `aiPreset === "ollama"` 特判：按**名字**判明暗的老毛病在主题那批也犯过——
 *  名字不是事实，算出来的值才是。 */
export function providerNeedsKey(p: AiProvider): boolean {
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(p.baseUrl.trim());
}

/** 当前可用的那一对；没有任何可用组合时返回 null（= 界面该说"未配置"而不是发一个空请求） */
export function activeRef(st: AiProfileState = snapshot): ActiveAi | null {
  const usableProvider = (p: AiProvider) =>
    p.enabled && p.baseUrl.trim().length > 0 && (!providerNeedsKey(p) || p.apiKey.trim().length > 0);
  const pair = (pid: string, mid: string): ActiveAi | null => {
    const provider = st.providers.find((p) => p.id === pid && usableProvider(p));
    const model = st.models.find((m) => m.id === mid && m.enabled && m.providerId === pid);
    return provider && model ? { provider, model } : null;
  };
  const exact = pair(st.activeProviderId, st.activeModelId);
  if (exact) return exact;
  for (const p of st.providers) {
    if (!usableProvider(p)) continue;
    const m = st.models.find((x) => x.providerId === p.id && x.enabled);
    if (m) return { provider: p, model: m };
  }
  return null;
}

/** 发送框下那枚选择器要的东西：当前这对 + 所有能选的模型（禁用的排在后面并标原因） */
export function selectableModels(st: AiProfileState = snapshot): (ActiveAi & { usable: boolean })[] {
  const out: (ActiveAi & { usable: boolean })[] = [];
  for (const m of st.models) {
    const p = st.providers.find((x) => x.id === m.providerId);
    if (!p) continue;
    out.push({ provider: p, model: m, usable: p.enabled && m.enabled && p.baseUrl.trim().length > 0 });
  }
  return out.sort((a, b) => Number(b.usable) - Number(a.usable) || a.provider.label.localeCompare(b.provider.label));
}

/** 给自省工具看的投影：**没有密钥**（`readSettings` 那条通路会原样序列化 schema 里的键，
 *  这张表不走那条路，出口只有自己写一个脱敏版） */
export function redactedProjection(st: AiProfileState = snapshot) {
  return {
    active: activeRef(st) ? { providerId: st.activeProviderId, modelId: st.activeModelId } : null,
    providers: st.providers.map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      format: p.format,
      enabled: p.enabled,
      hasKey: p.apiKey.trim().length > 0,
      models: st.models
        .filter((m) => m.providerId === p.id)
        .map((m) => ({
          id: m.id,
          label: m.label,
          model: m.model,
          contextTokens: m.contextTokens,
          maxOutputTokens: m.maxOutputTokens,
          thinkingLevels: m.thinkingLevels.map((t) => t.label),
          enabled: m.enabled,
        })),
    })),
  };
}

/* ================= 写入（人改的口子；Agent 侧本批不开） ================= */

const slug = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function newId(base: string, taken: Set<string>): string {
  const clean = slug(base) || "item";
  if (!taken.has(clean)) return clean;
  for (let n = 2; n < 200; n++) if (!taken.has(`${clean}-${n}`)) return `${clean}-${n}`;
  return `${clean}-${Date.now().toString(36)}`;
}

export function addProvider(input: Partial<AiProvider>): AiProvider {
  const taken = new Set(snapshot.providers.map((p) => p.id));
  const base = input.baseUrl ?? AI_PRESETS.deepseek.baseUrl;
  const presetLabel = input.label ?? AI_PRESETS.deepseek.label;
  const p: AiProvider = {
    ...seed().providers[0],
    id: newId(input.id ?? slug(presetLabel) ?? base, taken),
    label: presetLabel,
    baseUrl: base,
    apiKey: input.apiKey ?? "",
    format: input.format ?? "chat",
    proxy: input.proxy ?? "",
    noProxy: input.noProxy ?? "",
    enabled: input.enabled ?? true,
    createdAt: Date.now(),
  };
  commit({ ...snapshot, providers: [...snapshot.providers, p] });
  return p;
}

export function updateProvider(id: string, patch: Partial<AiProvider>): void {
  commit({
    ...snapshot,
    providers: snapshot.providers.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p)),
  });
}

/** 删供应商。名下还有模型 ⇒ 默认**禁止**（`ok:false, reason:"has_models"`）：
 *  静默级联删模型 = 用户丢配置，这类事在本仓库一律要一次明确确认。 */
export function removeProvider(id: string, cascade = false): { ok: boolean; reason?: string; droppedModels: string[] } {
  const children = snapshot.models.filter((m) => m.providerId === id);
  if (children.length && !cascade) return { ok: false, reason: "has_models", droppedModels: [] };
  const providers = snapshot.providers.filter((p) => p.id !== id);
  const models = cascade ? snapshot.models.filter((m) => m.providerId !== id) : snapshot.models;
  if (!providers.length || !models.length) {
    // 删空了就回到 seed：这张表没有任何一种"空状态"是有意义的
    commit(seed());
    return { ok: true, droppedModels: children.map((m) => m.id) };
  }
  const next: AiProfileState = {
    ...snapshot,
    providers,
    models,
    activeProviderId: snapshot.activeProviderId === id ? providers[0].id : snapshot.activeProviderId,
  };
  if (!models.some((m) => m.id === next.activeModelId)) next.activeModelId = models[0].id;
  if (next.activeProviderId !== next.models.find((m) => m.id === next.activeModelId)?.providerId) {
    next.activeProviderId = next.models.find((m) => m.id === next.activeModelId)?.providerId ?? providers[0].id;
  }
  commit(next);
  return { ok: true, droppedModels: children.map((m) => m.id) };
}

export function addModel(input: Partial<AiModelProfile> & { providerId: string }): AiModelProfile | null {
  const provider = snapshot.providers.find((p) => p.id === input.providerId);
  if (!provider) return null;
  const taken = new Set(snapshot.models.map((m) => m.id));
  const base = input.model ?? input.label ?? "model";
  const m: AiModelProfile = {
    ...seed().models[0],
    id: newId(input.id ?? base, taken),
    providerId: provider.id,
    label: input.label ?? base,
    model: base,
    contextTokens: input.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    thinkingLevels: input.thinkingLevels ?? [],
    defaultThinking: input.defaultThinking ?? "",
    enabled: true,
    createdAt: Date.now(),
  };
  commit({ ...snapshot, models: [...snapshot.models, m] });
  return m;
}

export function updateModel(id: string, patch: Partial<AiModelProfile>): void {
  commit({
    ...snapshot,
    models: snapshot.models.map((m) => (m.id === id ? { ...m, ...patch, id: m.id } : m)),
  });
}

export function removeModel(id: string): void {
  const models = snapshot.models.filter((m) => m.id !== id);
  if (!models.length) return;
  const next: AiProfileState = { ...snapshot, models };
  if (next.activeModelId === id) {
    const first = models[0];
    next.activeModelId = first.id;
    next.activeProviderId = first.providerId;
  }
  commit(next);
}

/** 选中并（如果被停用过）顺手启用：点了却没反应是假开关，这里不留那种状态 */
export function setActive(providerId: string, modelId: string): boolean {
  const model = snapshot.models.find((m) => m.id === modelId && m.providerId === providerId);
  if (!model) return false;
  commit({
    ...snapshot,
    providers: snapshot.providers.map((p) => (p.id === providerId ? { ...p, enabled: true } : p)),
    models: snapshot.models.map((m) => (m.id === modelId ? { ...m, enabled: true } : m)),
    activeProviderId: providerId,
    activeModelId: modelId,
  });
  return true;
}

/**
 * 编辑态用的那一对：故意**不做"可用"过滤**。
 * `activeRef()` 会滤掉"密钥还空着"的供应商，设置页若用它取编辑对象，
 * 一进来就没东西可填，用户永远填不上 Key（先有鸡还是先有蛋）。
 */
export function editingPair(st: AiProfileState = snapshot): { provider: AiProvider; model: AiModelProfile } {
  const provider = st.providers.find((p) => p.id === st.activeProviderId) ?? st.providers[0] ?? seed().providers[0];
  const model =
    st.models.find((m) => m.id === st.activeModelId && m.providerId === provider.id) ??
    st.models.find((m) => m.providerId === provider.id) ??
    st.models[0] ??
    seed().models[0];
  return { provider, model };
}

/** 表为空时（理论上不会：每次删空都回 seed）也要能写，所以写入按 editingPair 的 id 落 */
export function patchEditingProvider(patch: Partial<AiProvider>): void {
  updateProvider(editingPair().provider.id, patch);
}

export function patchEditingModel(patch: Partial<AiModelProfile>): void {
  updateModel(editingPair().model.id, patch);
}

/** Key 输入框那句提示：按 baseUrl 反查是哪家的模板（存的是值不是"预设 id"，所以查得到就有提示） */
export function keyHintFor(baseUrl: string): string | undefined {
  const v = baseUrl.trim().replace(/\/+$/, "");
  return Object.values(AI_PRESETS).find((p) => p.baseUrl.replace(/\/+$/, "") === v)?.keyHint;
}

/** 套模板：改这家的地址/协议/模型名，**不动密钥**（旧行为，P108 定下的） */
export function applyTemplate(presetKey: keyof typeof AI_PRESETS): void {
  const t = AI_PRESETS[presetKey];
  const { provider, model } = editingPair();
  commit({
    ...snapshot,
    providers: snapshot.providers.map((p) =>
      p.id === provider.id ? { ...p, label: t.label, baseUrl: t.baseUrl, format: presetKey === "anthropic" ? "anthropic" : "chat" } : p,
    ),
    models: snapshot.models.map((m) =>
      m.id === model.id ? { ...m, model: t.model, label: m.label === m.model ? t.model : m.label } : m,
    ),
  });
}

/** 表里**当前选中**那一对的模板名（设置页那枚 select 的 value；对不上就是 custom） */
export function templateOf(baseUrl: string): keyof typeof AI_PRESETS {
  const hit = (Object.keys(AI_PRESETS) as (keyof typeof AI_PRESETS)[]).find(
    (k) => AI_PRESETS[k].baseUrl.replace(/\/+$/, "") === baseUrl.trim().replace(/\/+$/, ""),
  );
  return hit ?? "deepseek";
}

/**
 * P110-B5：把“当前选中的思考强度档”翻成要下发的静态参数对象。
 *
 * 三条口径：
 *  - 这台模型没配档位 ⇒ null，也就是**什么都不多发**（不是发一个我们猜的默认值）；
 *  - 选中的名字在这台模型上不存在 ⇒ 退回该档案自己的 `defaultThinking`；再找不到还是 null
 *    （换了模型而设置里还留着上一台模型的档位名，是这条规则存在的唯一理由）；
 *  - 参数只做浅拷贝：不在这层求值、不拼表达式、不替不认识的平台编字段名（详设 §2′.7.2）。
 */
export function thinkingParamsFor(
  model: AiModelProfile,
  wanted: string,
): Record<string, ThinkingParamValue> | null {
  if (!model.thinkingLevels.length) return null;
  const hit =
    model.thinkingLevels.find((l) => l.label === wanted) ||
    model.thinkingLevels.find((l) => l.label === model.defaultThinking);
  return hit ? { ...hit.params } : null;
}

/** 界面上那枚选择器的候选。空数组 = 这台模型没有思考开关 ⇒ 选择器整个不出现（不留假开关） */
export function thinkingLabels(model: AiModelProfile | null | undefined): string[] {
  return model ? model.thinkingLevels.map((l) => l.label) : [];
}

/**
 * 当前那台模型的单次输出上限；没有可用档案时返回 null，调用方退回兜底阶梯。
 * 上限之外宿主侧还有一道 clamp —— 这层只负责“别拿硬编码 16384 去顶一台 4k 的模型”。
 */
export function activeMaxOutputTokens(st: AiProfileState = snapshot): number | null {
  const a = activeRef(st);
  return a ? Math.min(a.model.maxOutputTokens, 32_768) : null;
}

/** 测试连接/发送用的默认温度仍住在 `Settings.aiTemperature`（那是全局偏好，不是档案字段） */
export { DEFAULT_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS };
