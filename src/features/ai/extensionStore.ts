import { useSyncExternalStore } from "react";

/** 扩展类型：主题包 / 样式层 / 沙箱小部件 / 自定义面板 / 行为脚本 */
export type ExtType = "theme" | "style" | "widget" | "panel" | "script";

/** 权限声明：css=修改界面样式 read=读取数据快照 send=发送数据 script=执行 JS */
export type ExtPerm = "css" | "read" | "send" | "script";

export interface AiExtension {
  id: string;
  type: ExtType;
  name: string;
  desc: string;
  version: string;
  perms: ExtPerm[];
  enabled: boolean;
  createdAt: number;
  vars?: Record<string, string>; // theme
  css?: string; // theme / style
  html?: string; // widget / panel
  code?: string; // script
  /** widget：外观形态。"none" = 无边框透明（无标题栏、窗口背景透明，内容完全自定义） */
  chrome?: "none";
}

export interface ExtSnapshot {
  exts: AiExtension[];
  /** 打开为浮窗的小部件扩展 id */
  openIds: string[];
}

const KEY = "vs.aiExts";
const LEGACY_WIDGETS = "vs.aiWidgets";
const LEGACY_THEME = "vs.aiTheme";

export const EXT_TYPE_LABEL: Record<ExtType, string> = {
  theme: "主题",
  style: "样式",
  widget: "小部件",
  panel: "面板",
  script: "脚本",
};

export const PERM_LABEL: Record<ExtPerm, string> = {
  css: "修改界面样式（CSS）",
  read: "读取数据快照",
  send: "发送串口数据（另受全局发送权限限制）",
  script: "在主界面执行 JS 脚本（高权限）",
};

/** 按类型推导默认权限清单 */
export function permsForType(type: ExtType): ExtPerm[] {
  switch (type) {
    case "theme":
    case "style":
      return ["css"];
    case "widget":
    case "panel":
      return ["read", "send"];
    case "script":
      return ["read", "send", "script"];
  }
}

/** 旧数据迁移：vs.aiWidgets / vs.aiTheme → 统一扩展库 */
function migrate(): AiExtension[] | null {
  const out: AiExtension[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_WIDGETS);
    if (raw) {
      const p = JSON.parse(raw) as { widgets?: { id: string; name: string; html: string; createdAt: number }[] };
      for (const w of p.widgets ?? []) {
        out.push({
          id: w.id,
          type: "widget",
          name: w.name,
          desc: "由旧版小部件迁移",
          version: "0.1.0",
          perms: permsForType("widget"),
          enabled: true,
          createdAt: w.createdAt || Date.now(),
          html: w.html,
        });
      }
    }
  } catch {
    /* 忽略损坏的旧数据 */
  }
  try {
    const raw = localStorage.getItem(LEGACY_THEME);
    if (raw) {
      const vars = JSON.parse(raw) as Record<string, string>;
      if (vars && Object.keys(vars).length > 0) {
        out.push({
          id: crypto.randomUUID(),
          type: "theme",
          name: "AI 自定义主题",
          desc: "由旧版主题迁移",
          version: "0.1.0",
          perms: permsForType("theme"),
          enabled: true,
          createdAt: Date.now(),
          vars,
        });
      }
    }
  } catch {
    /* 忽略损坏的旧数据 */
  }
  return out.length ? out : null;
}

function load(): ExtSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ExtSnapshot>;
      return {
        exts: Array.isArray(p.exts) ? (p.exts as AiExtension[]) : [],
        openIds: Array.isArray(p.openIds) ? p.openIds : [],
      };
    }
    const migrated = migrate();
    if (migrated) {
      // 迁移后清理旧存储
      localStorage.removeItem(LEGACY_WIDGETS);
      localStorage.removeItem(LEGACY_THEME);
      return { exts: migrated, openIds: [] };
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return { exts: [], openIds: [] };
}

let snapshot: ExtSnapshot = load();
const listeners = new Set<() => void>();

function persist() {
  localStorage.setItem(KEY, JSON.stringify(snapshot));
}

function emit() {
  snapshot = { ...snapshot };
  persist();
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  return snapshot;
}

export function useExtensions() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getExt(id: string): AiExtension | undefined {
  return snapshot.exts.find((e) => e.id === id);
}

export interface ExtDraft {
  type: ExtType;
  name: string;
  desc?: string;
  vars?: Record<string, string>;
  css?: string;
  html?: string;
  code?: string;
  chrome?: "none";
}

/** 从 widget HTML 解析形态声明：<meta name="uartix:chrome" content="none"> → 无边框透明形态 */
export function widgetChromeFromHtml(html: string): "none" | undefined {
  return /<meta\s+name=["']uartix:chrome["']\s+content=["']none["']/i.test(html)
    ? "none"
    : undefined;
}

/** 安装扩展（调用方需先完成权限确认） */
export function addExt(draft: ExtDraft, enabled = true): string {
  const id = crypto.randomUUID();
  const ext: AiExtension = {
    id,
    type: draft.type,
    name: draft.name || EXT_TYPE_LABEL[draft.type],
    desc: draft.desc ?? "",
    version: "0.1.0",
    perms: permsForType(draft.type),
    enabled,
    createdAt: Date.now(),
    vars: draft.vars,
    css: draft.css,
    html: draft.html,
    code: draft.code,
    chrome: draft.chrome,
  };
  snapshot = { ...snapshot, exts: [...snapshot.exts, ext] };
  emit();
  return id;
}

export function removeExt(id: string) {
  snapshot = {
    ...snapshot,
    exts: snapshot.exts.filter((e) => e.id !== id),
    openIds: snapshot.openIds.filter((x) => x !== id),
  };
  emit();
}

export function setEnabled(id: string, enabled: boolean) {
  const ext = getExt(id);
  if (!ext || ext.enabled === enabled) return;
  snapshot = {
    ...snapshot,
    exts: snapshot.exts.map((e) => (e.id === id ? { ...e, enabled } : e)),
  };
  emit();
}

export function setOpen(id: string, open: boolean) {
  const has = snapshot.openIds.includes(id);
  if (open === has) return;
  snapshot = {
    ...snapshot,
    openIds: open ? [...snapshot.openIds, id] : snapshot.openIds.filter((x) => x !== id),
  };
  emit();
}

export function isOpen(id: string): boolean {
  return snapshot.openIds.includes(id);
}

/** 导出全部扩展为分享包 */
export function exportAll(): string {
  return JSON.stringify({ kind: "uartix-extensions", version: 1, data: snapshot.exts }, null, 2);
}

/** 从分享包导入（跳过重复 id） */
export function importAll(json: string): { ok: boolean; msg: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, msg: "JSON 解析失败" };
  }
  const obj = parsed as { kind?: string; data?: unknown };
  if (obj.kind !== "uartix-extensions" || !Array.isArray(obj.data)) {
    return { ok: false, msg: "文件格式不正确（需要 uartix-extensions 分享包）" };
  }
  let n = 0;
  const have = new Set(snapshot.exts.map((e) => e.id));
  for (const item of obj.data as AiExtension[]) {
    if (!item || typeof item !== "object" || !item.id || have.has(item.id)) continue;
    if (!["theme", "style", "widget", "panel", "script"].includes(item.type)) continue;
    snapshot.exts.push({ ...item, enabled: false });
    n++;
  }
  if (n === 0) return { ok: false, msg: "没有可导入的扩展（为空或全部重复）" };
  emit();
  return { ok: true, msg: `已导入 ${n} 个扩展（默认停用，请在列表中启用）` };
}

/** 清空全部扩展（重置 AI 创造内容） */
export function clearAll() {
  snapshot = { exts: [], openIds: [] };
  emit();
}
