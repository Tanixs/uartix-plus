import { useSyncExternalStore } from "react";

/**
 * 扩展类型：主题包 / 样式层 / 沙箱小部件 / 自定义面板。
 *
 * **没有 `"script"`**（P99a-D1c）：那条通道是主世界里的 `new Function`——无超时、不可中断、
 * `perms` 从不生效，而 `api.app.*` 一律带 `highPriv:true`；同时**没有任何生产者会写它**
 * （插件投影只产下面这三种）。零兼容裁决（详设 §13.1）下直接删，主世界不留第二个 JS 口子：
 * 能跑代码的合法形态只有专用 Worker 那一条（`logic.run` + realm 封网 + 启用前自证）。
 */
export type ExtType = "theme" | "style" | "widget" | "panel";

/**
 * 权限声明词汇也一起删了（旧 `ExtPerm = css|read|send|script`）：它全仓**零读取者**，
 * 只在投影写入时填个字面值——留着一个"看着像门、其实没人查"的字段，比没有字段更危险
 * （M2 清退 `aiScript` 时立的同一条规矩：假装生效的安全控件＝骗用户）。
 * 真正的权限面只有一个：插件 manifest 的 `caps`（`PLUGIN_CAPS`）+ 桥侧 `MSG_CAP_REQUIREMENT` 裁决。
 */
export interface AiExtension {
  id: string;
  type: ExtType;
  name: string;
  desc: string;
  version: string;
  enabled: boolean;
  createdAt: number;
  vars?: Record<string, string>; // theme
  css?: string; // theme / style
  /** theme：作者声明的明暗归属。缺省＝没声明，由 `--bg` 亮度算（详设 S4） */
  scheme?: "dark" | "light"; // theme
  html?: string; // widget / panel
  /** widget：外观形态。"none" = 无边框透明（无标题栏、窗口背景透明，内容完全自定义） */
  chrome?: "none";
  /** P88b-3：插件库投影的影子扩展（来源插件包 ID）；本 store 现仅承载投影记录 */
  pluginRef?: string;
}

export interface ExtSnapshot {
  exts: AiExtension[];
  /** 打开为浮窗的小部件扩展 id */
  openIds: string[];
}

const KEY = "vs.aiExts";
const LEGACY_WIDGETS = "vs.aiWidgets";
const LEGACY_THEME = "vs.aiTheme";

/**
 * 读取持久化快照：旧扩展（用户/AI 直接创建的独立扩展）已废弃，
 * 只保留带 pluginRef 的插件库投影记录；openIds 中指向已丢弃记录的同步过滤。
 *
 * P91 D1：**theme 投影不再持久化**——主题的唯一真相是插件库里的 artifact
 * （vs.pluginLib.v1），投影由 pluginStore 启动时重建。旧实现把 vars 同时写进
 * 两边，任一持久化失败就出现"库里显示已启用、界面却没生效"的分裂状态。
 * 顺带清理更早的 vs.aiWidgets / vs.aiTheme 遗留键。
 */
const isDerivedOnly = (e: AiExtension) => e.type === "theme";

function load(): ExtSnapshot {
  let exts: AiExtension[] = [];
  let openIds: string[] = [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ExtSnapshot>;
      exts = Array.isArray(p.exts)
        ? (p.exts as AiExtension[]).filter(
            (e) => !!e && typeof e === "object" && !!e.pluginRef && !isDerivedOnly(e),
          )
        : [];
      const ids = new Set(exts.map((e) => e.id));
      openIds = Array.isArray(p.openIds) ? p.openIds.filter((x) => ids.has(x)) : [];
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  try {
    localStorage.removeItem(LEGACY_WIDGETS);
    localStorage.removeItem(LEGACY_THEME);
  } catch {
    /* 忽略 */
  }
  return { exts, openIds };
}

let snapshot: ExtSnapshot = load();
const listeners = new Set<() => void>();

/** 持久化只写非派生类投影（theme 由插件库重建，写两份就是两份真相） */
function persist() {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      exts: snapshot.exts.filter((e) => e.pluginRef && !isDerivedOnly(e)),
      openIds: snapshot.openIds,
    }),
  );
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

/* —— P88b-3 插件库投影（影子扩展）：由 pluginStore 维护，UI 只读展示 —— */

/** 插件启用：创建/替换影子扩展（保留 openIds 状态）。 */
export function upsertProjection(ext: AiExtension) {
  const idx = snapshot.exts.findIndex((e) => e.id === ext.id);
  if (idx >= 0) {
    const exts = [...snapshot.exts];
    exts[idx] = { ...ext, createdAt: exts[idx].createdAt };
    snapshot = { ...snapshot, exts };
  } else {
    snapshot = { ...snapshot, exts: [...snapshot.exts, ext] };
  }
  emit();
}

/** 插件停用/卸载：移除影子扩展（含浮窗打开状态）。 */
export function removeProjection(id: string) {
  const has = snapshot.exts.some((e) => e.id === id);
  if (!has) return;
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
