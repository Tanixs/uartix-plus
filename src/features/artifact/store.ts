/**
 * P174-A18：**AI 产物的存储与生命周期**（主题 / 小部件 / 面板）。
 *
 * 这一层是从旧 `plugins/pluginStore.ts` 里剥出来的那半边——它从来不是"旧第三方插件系统"，
 * 而是 AI 现在唯一能落地东西的地方。旧的清单（`uartix-plugin` s2）与它的
 * `KIND_TABLE_DEF`/`validate()` 随旧系统一起退役，这里是**按今天的产物形态重新定义**的种类表：
 * 只有 theme / widget / panel 三种，能力与载荷校验都挂在这一处。
 *
 * 三条刻意保留的旧契约（改掉任何一条，用户看到的东西都会变）：
 * 1. 同名再存＝原地升版，旧版压进历史栈，而不是长出 `-2` 副本；
 * 2. 主题互斥：同一时刻只有一枚主题在画，启用一枚会挤掉另一枚（启用入口收敛在这里）；
 * 3. 影子扩展 id 仍是 `plg:<产物 id>:main`——WidgetDesktop / ExtPanel / 外观选择器
 *    都按这个 id 找"在画的那一枚"，换形状会让三处同时失联。
 *
 * 新增的一条（A18）：每个产物拿到一个 `createScope()`。副作用（iframe 之外的定时器、
 * 监听、窗口……）必须登记在它自己的 scope 里，停用/卸载/隔离时**逆序**撤销。
 * 今天的三种产物还没有手写副作用（iframe 随投影消失），但先把入口建好，
 * 以后加桌宠时不需要再补一次"卸载清理漏了一半"的账。
 */
import { useSyncExternalStore } from "react";
import * as extStore from "../ai/extensionStore";
import { createScope, type EffectScope } from "./effects";
import { agentPluginId, freeAgentId, isSameAgentArtifact } from "./id";
import { renderDeclarativeHtml, type AnyBlock } from "./declarative";
import { guardStyleText } from "../styles/styleSanitize";
import { danglingAssetRefs, validateAssetList } from "../styles/assetGuard";
import { APPEARANCE_TOKENS, checkThemeVars, type ThemeAsset } from "../../styles/themeCore";

/* ============================ 产物种类（唯一一份） ============================ */

export interface ArtifactKindMeta {
  label: string;
  labelEn: string;
  /** 这类产物在影子扩展里声明能用的桥能力（写死在种类上，模型没有加码的余地） */
  caps: readonly string[];
  /** 旧包形状里的 contributions 键（兼容层翻译用；新代码只认 kind） */
  contribKey: string;
}

/**
 * 种类表。加一类就必须同时给出名字、能力与载荷校验——没有"忘了配就走默认通过"的分支。
 * `theme.tokens` / `ui.widget` / `ui.panel` 是桥侧仍在裁决的那几个名字；
 * `telemetry.read` 是"只读订阅遥测"，任何产物都不会带 `serial.send`（AI 造的东西不碰设备发送）。
 */
export const ARTIFACT_KIND_META = {
  theme: { label: "主题", labelEn: "Theme", caps: ["theme.tokens"], contribKey: "themes" },
  widget: { label: "小部件", labelEn: "Widget", caps: ["ui.widget", "telemetry.read"], contribKey: "widgets" },
  panel: { label: "面板", labelEn: "Panel", caps: ["ui.panel", "telemetry.read"], contribKey: "panels" },
} as const satisfies Record<string, ArtifactKindMeta>;

export type ArtifactKind = keyof typeof ARTIFACT_KIND_META;
export const ARTIFACT_KINDS = Object.keys(ARTIFACT_KIND_META) as ArtifactKind[];

export function artifactKindMeta(kind: ArtifactKind): ArtifactKindMeta {
  return ARTIFACT_KIND_META[kind];
}

/** 模型给的 kind 可能不在枚举里：原样回显，不替它编一个名字。 */
export function artifactKindLabel(kind: string): string {
  return kind in ARTIFACT_KIND_META ? ARTIFACT_KIND_META[kind as ArtifactKind].label : kind;
}

/** 主题 CSS 上限。`save_theme_extension`、`style_commit` 与主题产物校验共用这一个数。 */
export const THEME_CSS_MAX_BYTES = 64 * 1024;
const MAX_HTML = 512 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

/* ============================ 载荷校验 ============================ */

export interface ArtifactValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateBlocks(blocks: unknown, out: ArtifactValidation): void {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 64) {
    out.errors.push("blocks 必须是 1..64 个的数组");
    return;
  }
  for (const b of blocks) {
    if (!isPlainObject(b)) {
      out.errors.push("块必须是对象");
      continue;
    }
    switch (b.type) {
      case "metric":
        if (typeof b.title !== "string" || !b.title.trim()) out.errors.push("metric 缺少 title");
        if (b.channel !== undefined && typeof b.channel !== "string") out.errors.push("metric.channel 必须是字符串");
        if (
          b.precision !== undefined &&
          (!Number.isInteger(b.precision) || (b.precision as number) < 0 || (b.precision as number) > 8)
        ) {
          out.errors.push("metric.precision 必须是 0..8 整数");
        }
        break;
      case "spark":
        if (typeof b.channel !== "string" || !b.channel.trim()) out.errors.push("spark 缺少 channel");
        if (
          b.seconds !== undefined &&
          (!Number.isFinite(b.seconds) || (b.seconds as number) < 1 || (b.seconds as number) > 3600)
        ) {
          out.errors.push("spark.seconds 必须在 1..3600");
        }
        break;
      case "text":
        if (typeof b.text !== "string" || b.text.length > 8192) out.errors.push("text 内容必须是 ≤8KiB 字符串");
        break;
      case "html":
        if (typeof b.html !== "string" || b.html.length > 64 * 1024) out.errors.push("html 块内容必须 ≤64KiB");
        break;
      default:
        out.errors.push(`未知块类型：${String(b.type)}`);
    }
  }
}

function validateTheme(payload: Record<string, unknown>, out: ArtifactValidation): void {
  const vars = payload.vars;
  if (!isPlainObject(vars)) {
    out.errors.push("theme.vars 必须是对象");
    return;
  }
  const keys = Object.keys(vars);
  if (keys.length === 0 && typeof payload.css !== "string") out.errors.push("theme.vars 不能为空");
  if (keys.length > 128) out.errors.push("theme.vars 数量超过 128");
  for (const [k, v] of Object.entries(vars)) {
    if (!k.startsWith("--")) out.errors.push(`主题变量键必须以 -- 开头：${k}`);
    if (typeof v !== "string" || v.length > 200) out.errors.push(`主题变量值必须是 ≤200 字符字符串：${k}`);
  }
  out.errors.push(...checkThemeVars(vars as Record<string, string>, APPEARANCE_TOKENS).errors);
  if (payload.scheme !== undefined && payload.scheme !== "dark" && payload.scheme !== "light") {
    out.errors.push(`theme.scheme 只认 dark / light，实际「${String(payload.scheme)}」`);
  }
  if (payload.css !== undefined) {
    if (typeof payload.css !== "string" || payload.css.length > THEME_CSS_MAX_BYTES) {
      out.errors.push(`theme.css 必须是 ≤${THEME_CSS_MAX_BYTES} 字节字符串`);
    } else {
      const g = guardStyleText(payload.css, THEME_CSS_MAX_BYTES, []);
      if (!g.ok) out.errors.push(...g.problems.slice(0, 8).map((p) => `theme.css 未通过净化：${p}`));
      else if (g.problems.length) out.warnings.push(...g.problems.slice(0, 8));
    }
  }
  out.errors.push(...validateAssetList(payload.assets));
  if (typeof payload.css === "string" && payload.css) {
    const assets = Array.isArray(payload.assets) ? (payload.assets as ThemeAsset[]) : [];
    for (const id of danglingAssetRefs(payload.css, assets)) out.errors.push(`asset_reference_not_declared:${id}`);
  }
}

function validateUi(payload: Record<string, unknown>, out: ArtifactValidation, allowChrome: boolean): void {
  const format = payload.format ?? (typeof payload.html === "string" ? "html" : undefined);
  if (format === "html") {
    if (typeof payload.html !== "string" || !payload.html.trim()) out.errors.push("html 内容为空");
    else if (payload.html.length > MAX_HTML) out.errors.push("html 超过 512KiB 上限");
    else {
      if (/(?:src|href)\s*=\s*["']https?:\/\//i.test(payload.html)) {
        out.warnings.push("html 引用外链资源，沙箱 iframe 将按 CSP 拦截（建议改用内联或 data:）");
      }
      if (/<script[^>]+src=/i.test(payload.html)) out.warnings.push("html 含外部 script，沙箱 iframe 将按 CSP 拦截");
    }
    if (payload.chrome !== undefined && allowChrome && payload.chrome !== "none") out.errors.push('chrome 仅支持 "none"');
  } else if (format === "declarative") {
    validateBlocks(payload.blocks, out);
  } else {
    out.errors.push('widget/panel 内容必须是 { format: "html" | "declarative", … }');
  }
}

/** 校验一份产物载荷。errors 非空即拒；warnings 不阻塞。 */
export function validateArtifactPayload(kind: ArtifactKind, payload: unknown): ArtifactValidation {
  const out: ArtifactValidation = { ok: true, errors: [], warnings: [] };
  if (!isPlainObject(payload)) return { ok: false, errors: ["产物内容必须是对象"], warnings: [] };
  const bytes = JSON.stringify(payload).length;
  if (bytes > MAX_ARTIFACT_BYTES) {
    return { ok: false, errors: [`产物超过单 JSON 1MiB 上限（${bytes} 字节）`], warnings: [] };
  }
  if (kind === "theme") validateTheme(payload, out);
  else if (kind === "widget") validateUi(payload, out, true);
  else validateUi(payload, out, false);
  out.ok = out.errors.length === 0;
  return out;
}

/* ============================ 记录与快照 ============================ */

export interface ArtifactVersion {
  version: string;
  createdAt: number;
  data: Record<string, unknown>;
}

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  name: string;
  desc: string;
  version: string;
  enabled: boolean;
  /** 多次违反 iframe 隔离约束后被隔离（与旧插件库同一条判据：60 秒 3 次） */
  quarantined: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: "agent" | "user" | "import";
  /** 桥握手 nonce（iframe → 宿主的每条 aiw:* 消息都要带它） */
  nonce: string;
  /** 旧版本（回滚栈）；只留最近 5 个 */
  versions: ArtifactVersion[];
  /** 产物正文：theme = {vars,css?,assets?,scheme?}；widget/panel = {format,html|blocks,chrome?} */
  data: Record<string, unknown>;
}

export interface ArtifactSnapshot {
  artifacts: ArtifactRecord[];
}

const KEY = "vs.aiArtifacts.v1";
const MAX_VERSIONS = 5;
const VIOLATION_WINDOW_MS = 60_000;
const VIOLATION_THRESHOLD = 3;

function load(): ArtifactSnapshot {
  // node 测试环境没有 localStorage：返回空账本即可（不能抛，模块求值期抛会连累所有 import 它的测试）
  if (typeof localStorage === "undefined") return { artifacts: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ArtifactSnapshot>;
      const all = Array.isArray(p.artifacts) ? (p.artifacts as ArtifactRecord[]) : [];
      return {
        artifacts: all
          .filter((a) => !!a && typeof a === "object" && (ARTIFACT_KINDS as readonly string[]).includes(a.kind))
          .map((a) => ({
            ...a,
            enabled: a.enabled === true && a.quarantined !== true,
            versions: Array.isArray(a.versions) ? a.versions.slice(-MAX_VERSIONS) : [],
            nonce: typeof a.nonce === "string" && a.nonce ? a.nonce : crypto.randomUUID(),
          })),
      };
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return { artifacts: [] };
}

let snapshot: ArtifactSnapshot = load();
const listeners = new Set<() => void>();

function emit(): void {
  // 与旧插件库同一条契约：广播出去的数组引用必须是新的，否则以 `[artifacts]` 为依赖的
  // useMemo 永远等不到重算（"装完主题要重进设置页才刷新"就是这条的指纹）。
  snapshot = { artifacts: [...snapshot.artifacts] };
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshot));
    } catch (e) {
      console.warn(`[artifact] 保存失败（本地存储配额超限）：${String(e).slice(0, 120)}`);
    }
  }
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): ArtifactSnapshot {
  return snapshot;
}

export function useArtifacts(): ArtifactSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getArtifact(id: string): ArtifactRecord | undefined {
  return snapshot.artifacts.find((a) => a.id === id);
}

export function listArtifacts(): readonly ArtifactRecord[] {
  return snapshot.artifacts;
}

/* ============================ 样式层回调（禁止静态 import extRuntime） ============================ */

/**
 * 与旧 pluginStore 同一条理由（P92-F）：`extRuntime → chatStore → agentRun → …` 会绕回来，
 * 静态 import extRuntime 会在 dev 的 ESM 求值顺序里撞 TDZ，整窗白屏。所以由 extRuntime
 * 在自身求值时注册回调；这里只负责"投影变了，请重贴样式层"。
 */
let applyStyleFn: (() => void) | null = null;
let stylesDirty = false;

function scheduleStyles(): void {
  if (!applyStyleFn) {
    stylesDirty = true;
    return;
  }
  stylesDirty = false;
  applyStyleFn();
}

export function setStyleApplier(fn: () => void): void {
  applyStyleFn = fn;
  if (stylesDirty) scheduleStyles();
}

/* ============================ Effect 作用域 ============================ */

const scopes = new Map<string, EffectScope>();

function ensureScope(id: string): EffectScope {
  let s = scopes.get(id);
  if (!s || s.disposed) {
    s = createScope(`artifact:${id}`);
    scopes.set(id, s);
  }
  return s;
}

/** 停用/卸载/隔离时逆序撤销这个产物登记过的所有副作用。 */
function disposeScope(id: string): void {
  const s = scopes.get(id);
  scopes.delete(id);
  if (s && !s.disposed) {
    // 单个 disposer 抛错不阻断其余撤销（effects.ts 已收集），这里只把失败数说出来
    void s.disposeAll().then(({ failed }) => {
      if (failed) console.warn(`[artifact] ${id} 有 ${failed} 条副作用撤销失败`);
    });
  }
}

/** 给产物登记一条副作用；未启用时也会先建 scope（第一次 enable 时沿用）。 */
export function registerArtifactEffect(id: string, label: string, dispose: () => void | Promise<void>): () => void {
  return ensureScope(id).add(label, dispose);
}

/** 错误信息与测试用的只读句柄。 */
export function artifactScopeOf(id: string): EffectScope | undefined {
  return scopes.get(id);
}

/* ============================ 投影 ============================ */

export function shadowExtId(artifactId: string, contribId = "main"): string {
  return `plg:${artifactId}:${contribId}`;
}

/** 产物正文 → 影子扩展 HTML（declarative 由宿主渲染器生成，html 原样）。 */
function artifactHtml(payload: Record<string, unknown>): string {
  const format = payload.format ?? (typeof payload.html === "string" ? "html" : "declarative");
  if (format === "declarative") {
    return renderDeclarativeHtml((payload.blocks ?? []) as AnyBlock[], { title: "" });
  }
  return typeof payload.html === "string" ? payload.html : "";
}

function project(record: ArtifactRecord): void {
  const sid = shadowExtId(record.id);
  const base = {
    id: sid,
    name: record.name,
    desc: record.desc || `AI 作品 ${record.name}`,
    version: record.version,
    enabled: true,
    createdAt: record.createdAt,
    pluginRef: record.id,
  };
  if (record.kind === "theme") {
    const d = record.data;
    extStore.upsertProjection({
      ...base,
      type: "theme",
      vars: (d.vars as Record<string, string>) ?? {},
      ...(d.scheme === "dark" || d.scheme === "light" ? { scheme: d.scheme } : {}),
      ...(typeof d.css === "string" && d.css ? { css: d.css } : {}),
      ...(Array.isArray(d.assets) && d.assets.length ? { assets: d.assets as ThemeAsset[] } : {}),
    });
    return;
  }
  extStore.upsertProjection({
    ...base,
    type: record.kind,
    html: artifactHtml(record.data),
    ...(record.kind === "widget" && record.data.chrome === "none" ? { chrome: "none" as const } : {}),
  });
}

function removeProjection(id: string): void {
  extStore.removeProjection(shadowExtId(id));
}

/**
 * 启动时重建全部已启用产物的投影。
 *
 * **不在模块求值期调用**（check-import-cycles 会把顶层裸调用记成"把启动顺序写进模块体"）：
 * 由 `extRuntime.startExtRuntime()` 在 App 启动钩子里显式叫一次。幂等，重复叫不会叠投影。
 */
export function restoreProjections(): void {
  let changed = false;
  for (const a of snapshot.artifacts) {
    if (!a.enabled || a.quarantined) continue;
    project(a);
    ensureScope(a.id);
    changed = true;
  }
  if (changed) scheduleStyles();
}

/* ============================ 写入 / 启停 / 回滚 ============================ */

export interface WriteArtifactInput {
  id?: string;
  kind: ArtifactKind;
  name: string;
  desc?: string;
  version?: string;
  payload: Record<string, unknown>;
  createdBy?: "agent" | "user" | "import";
  /** 写完立即启用（纯 UI 产物默认如此，与旧 save_plugin enable:true 同义） */
  enable?: boolean;
}

export interface WriteArtifactResult {
  ok: boolean;
  msg: string;
  id?: string;
  version?: string;
  enabled?: boolean;
  updated?: boolean;
}

function nextPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return `0.1.${Date.now() % 100000}`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function pushHistory(record: ArtifactRecord): void {
  record.versions = [
    ...record.versions.slice(-(MAX_VERSIONS - 1)),
    { version: record.version, createdAt: record.updatedAt, data: record.data },
  ];
}

/**
 * 写入一份产物（新建或原地升版）。
 *
 * **同名同 id 才原地升版**——id 靠名称哈希，中文名不会退化；id 撞了但名字不同仍按新 id 另立门户
 * （调用方用 `freeAgentId` 找空位）。这条是旧系统里被事故逼出来的，不能退。
 */
export function writeArtifact(input: WriteArtifactInput): WriteArtifactResult {
  const name = input.name.trim().slice(0, 60);
  if (!name) return { ok: false, msg: "name 必须是 1..60 字符" };
  if (!(ARTIFACT_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, msg: `未知产物类型：${String(input.kind)}` };
  }
  const v = validateArtifactPayload(input.kind, input.payload);
  if (!v.ok) return { ok: false, msg: v.errors.slice(0, 8).join("；") };

  const existing = input.id ? getArtifact(input.id) : undefined;
  const same = isSameAgentArtifact(existing, `user.agent.${input.kind}`, name);
  const now = Date.now();
  let record: ArtifactRecord;

  if (existing && same) {
    record = { ...existing, data: { ...input.payload } };
    pushHistory(record);
    record.name = name;
    record.desc = input.desc ?? existing.desc;
    record.version = input.version ?? nextPatch(existing.version);
    record.updatedAt = now;
  } else if (existing) {
    // 调用方明确指向一个已存在 id、但名字不同：拒，不静默覆盖别人的作品
    return { ok: false, msg: `产物 id ${existing.id} 已被「${existing.name}」占用` };
  } else {
    const base = input.id ?? agentPluginId(`user.agent.${input.kind}`, name);
    const id = input.id ?? freeAgentId(base, (cand) => !!getArtifact(cand));
    record = {
      id,
      kind: input.kind,
      name,
      desc: input.desc ?? "",
      version: input.version ?? "0.1.0",
      enabled: false,
      quarantined: false,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? "agent",
      nonce: crypto.randomUUID(),
      versions: [],
      data: { ...input.payload },
    };
  }

  const idx = snapshot.artifacts.findIndex((a) => a.id === record.id);
  const artifacts =
    idx >= 0 ? snapshot.artifacts.map((a, i) => (i === idx ? record : a)) : [...snapshot.artifacts, record];
  snapshot = { artifacts };
  const updated = existing != null;
  // 每个产物从创建那一刻就拿到自己的作用域；就算今天还没有手写副作用，入口也先建好
  // （以后加桌宠/定时器时不需要再补一次"卸载清理漏了一半"的账）。
  ensureScope(record.id);

  let enabled = record.enabled;
  if (input.enable === true) {
    const r = setEnabled(record.id, true);
    if (!r.ok) {
      emit();
      return { ok: false, msg: r.msg, id: record.id, version: record.version, updated };
    }
    enabled = true;
  } else {
    emit();
    if (record.enabled) project(record);
  }
  return { ok: true, msg: `已保存「${name}」v${record.version}`, id: record.id, version: record.version, enabled, updated };
}

/**
 * 直接替换一份产物的正文与版本号（更新链的"批准"那一步）。
 *
 * 与 `writeArtifact` 分开是因为更新链的 id 由旧调用方指定（`user.agent.panel` 这类不是名称哈希），
 * 用"同名同哈希"判同一份会把它误判成别人的作品。调用方必须先走校验与候选确认。
 */
export function replaceArtifact(
  id: string,
  input: { name?: string; desc?: string; version: string; payload: Record<string, unknown> },
): { ok: boolean; msg: string } {
  const record = getArtifact(id);
  if (!record) return { ok: false, msg: "产物不存在" };
  const v = validateArtifactPayload(record.kind, input.payload);
  if (!v.ok) return { ok: false, msg: v.errors.slice(0, 8).join("；") };
  const next: ArtifactRecord = {
    ...record,
    ...(input.name ? { name: input.name.trim().slice(0, 60) } : {}),
    desc: input.desc ?? record.desc,
    version: input.version,
    updatedAt: Date.now(),
    versions: [
      ...record.versions.slice(-(MAX_VERSIONS - 1)),
      { version: record.version, createdAt: record.updatedAt, data: record.data },
    ],
    data: { ...input.payload },
  };
  snapshot = { artifacts: snapshot.artifacts.map((a) => (a.id === id ? next : a)) };
  if (next.enabled) project(next);
  emit();
  return { ok: true, msg: `已更新到 v${next.version}` };
}

/** 启用/停用。主题互斥在这个唯一入口收敛（与旧 pluginStore 同一条规矩）。 */
export function setEnabled(id: string, enabled: boolean): { ok: boolean; msg: string; pushed?: string[] } {
  const record = getArtifact(id);
  if (!record) return { ok: false, msg: "产物不存在" };
  if (enabled && record.quarantined) {
    return { ok: false, msg: "该产物已被隔离（多次违反隔离约束），请删除后重新创建" };
  }
  const pushed: string[] = [];
  if (enabled) {
    ensureScope(id);
    if (record.kind === "theme") {
      for (const other of snapshot.artifacts) {
        if (other.id === id || !other.enabled || other.kind !== "theme") continue;
        removeProjection(other.id);
        disposeScope(other.id);
        const off = { ...other, enabled: false, updatedAt: Date.now() };
        snapshot = { artifacts: snapshot.artifacts.map((a) => (a.id === other.id ? off : a)) };
        pushed.push(other.name);
      }
    }
    const next = { ...record, enabled: true, updatedAt: Date.now() };
    snapshot = { artifacts: snapshot.artifacts.map((a) => (a.id === id ? next : a)) };
    project(next);
    scheduleStyles();
    emit();
    return {
      ok: true,
      msg: pushed.length
        ? `已启用「${record.name}」；主题互斥，同时停用了 ${pushed.length} 枚：${pushed.join("、")}`
        : `已启用「${record.name}」`,
      pushed,
    };
  }
  removeProjection(id);
  disposeScope(id);
  snapshot = {
    artifacts: snapshot.artifacts.map((a) => (a.id === id ? { ...a, enabled: false, updatedAt: Date.now() } : a)),
  };
  scheduleStyles();
  emit();
  return { ok: true, msg: `已停用「${record.name}」`, pushed };
}

/** 卸载一份产物：投影、scope、历史一起走。 */
export function removeArtifact(id: string): { ok: boolean; msg: string } {
  const record = getArtifact(id);
  if (!record) return { ok: false, msg: "产物不存在" };
  removeProjection(id);
  disposeScope(id);
  snapshot = { artifacts: snapshot.artifacts.filter((a) => a.id !== id) };
  scheduleStyles();
  emit();
  return { ok: true, msg: `已删除「${record.name}」（历史版本一并删除）` };
}

/** 冻结进历史栈的那一版换回来（当前版压回栈，所以再调一次即切回来）。 */
export function rollbackArtifact(id: string): { ok: boolean; msg: string } {
  const record = getArtifact(id);
  if (!record) return { ok: false, msg: "产物不存在" };
  const prev = record.versions[record.versions.length - 1];
  if (!prev) return { ok: false, msg: "没有可回滚的历史版本" };
  const next: ArtifactRecord = {
    ...record,
    data: prev.data,
    version: prev.version,
    updatedAt: Date.now(),
    versions: [
      ...record.versions.slice(0, -1),
      { version: record.version, createdAt: record.updatedAt, data: record.data },
    ],
  };
  snapshot = { artifacts: snapshot.artifacts.map((a) => (a.id === id ? next : a)) };
  if (next.enabled) project(next);
  scheduleStyles();
  emit();
  return { ok: true, msg: `已回滚到 v${next.version}` };
}

/* ============================ 隔离约束 ============================ */

const violationLog = new Map<string, number[]>();

/** iframe 隔离约束违规上报：60 秒内累计 3 次 ⇒ 隔离（停用 + 投影移除 + scope 撤销）。 */
export function reportViolation(artifactId: string, code: string): void {
  const record = getArtifact(artifactId);
  if (!record) return;
  const now = Date.now();
  const list = (violationLog.get(artifactId) ?? []).filter((t) => now - t < VIOLATION_WINDOW_MS);
  list.push(now);
  violationLog.set(artifactId, list);
  if (list.length < VIOLATION_THRESHOLD) {
    console.warn(`[产物隔离] ${artifactId} 违规（${code}）${list.length}/${VIOLATION_THRESHOLD}`);
    return;
  }
  violationLog.delete(artifactId);
  removeProjection(artifactId);
  disposeScope(artifactId);
  snapshot = {
    artifacts: snapshot.artifacts.map((a) =>
      a.id === artifactId ? { ...a, enabled: false, quarantined: true, updatedAt: now } : a,
    ),
  };
  scheduleStyles();
  emit();
  console.warn(`[产物隔离] ${artifactId} 已隔离（60 秒内违规 ${VIOLATION_THRESHOLD} 次，最近：${code}）`);
}

/* ============================ iframe 上下文 ============================ */

export interface ArtifactFrameCtx {
  pkgId: string;
  caps: readonly string[];
  nonce: string;
}

/** 由影子扩展的 pluginRef 解析隔离上下文；非本层产物返回 undefined。 */
export function artifactFrameCtx(pluginRef: string | undefined): ArtifactFrameCtx | undefined {
  if (!pluginRef) return undefined;
  const record = getArtifact(pluginRef);
  if (!record) return undefined;
  return { pkgId: record.id, caps: ARTIFACT_KIND_META[record.kind].caps, nonce: record.nonce };
}

/* ============================ 供旧调用方用的纯信息 ============================ */

/** 名字留给工具面/提示词：哪些种类可以自动启用（今天三种都是纯 UI）。 */
export function autoEnableableKindLabels(): string[] {
  return ARTIFACT_KINDS.map((k) => ARTIFACT_KIND_META[k].label);
}

export function autoEnableBlockedCaps(): string[] {
  return [];
}
