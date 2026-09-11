/**
 * Operator 只读模式运行时（P67-O2）：
 * 激活 = 校验 .uopk → 临时解锁应用载荷（模板替换/控制页重建/命令库替换/设置子集）
 * → 重新上锁 → 横幅展示包名；布局由 App 消费 payload.layout 应用到 dockview。
 * 退出 = 解锁并清除（已导入的配置保留在界面里，可继续编辑）。
 *
 * 锁本身在 lock.ts（零依赖），store 门禁引用它；本模块负责置位/复位与持久化。
 */
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as templateStore from "../protocol/templateStore";
import * as controlsStore from "../controls/controlsStore";
import * as commandStore from "../controls/commandStore";
import { patch as patchSettings } from "../settings/settingsStore";
import { setOperatorLocked } from "./lock";
import { validatePkg, OPERATOR_KIND, type OperatorPkg } from "./operatorPkg";

const KEY = "vs.operator";

export interface OperatorSnapshot {
  /** 当前生效的部署包；null = 普通模式 */
  pkg: OperatorPkg | null;
  /** 启动时从 localStorage 恢复（App 用它跳过布局自动备份） */
  restored: boolean;
}

function loadSaved(): OperatorPkg | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return validatePkg(JSON.parse(raw));
  } catch {
    return null;
  }
}

let snapshot: OperatorSnapshot = { pkg: loadSaved(), restored: false };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): OperatorSnapshot {
  return snapshot;
}

export function useOperator(): OperatorSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function isOperatorMode(): boolean {
  return snapshot.pkg !== null;
}

/** 启动恢复：有持久化的部署包则进入只读模式（布局随 vs.layout.v2 自然恢复）；
 *  同时接管「双击 .uopk 打开」：取走启动暂存路径 + 监听运行中的新打开请求。 */
export async function init() {
  if (snapshot.pkg) {
    snapshot = { ...snapshot, restored: true };
    setOperatorLocked(true);
    emit();
  }
  // 文件关联（P67-O3）：单实例插件把新路径放进 Rust 端暂存并 emit operator:open
  let lastPath = "";
  const openFromPath = async (path: string) => {
    if (!path || path === lastPath) return;
    lastPath = path;
    try {
      const content = await invoke<string>("read_text_file", { path });
      const obj = JSON.parse(content) as { kind?: string; data?: unknown };
      if (obj.kind !== OPERATOR_KIND) return;
      activate(obj.data);
    } catch {
      /* 文件不可读/格式不对：静默（路径可能已失效） */
    }
  };
  try {
    await listen("operator:open", () => {
      void invoke<string | null>("take_pending_open").then((p) => p && void openFromPath(p));
    });
    const pending = await invoke<string | null>("take_pending_open");
    if (pending) void openFromPath(pending);
  } catch {
    /* 非 Tauri 环境（单测/预览）无文件关联 */
  }
}

/** 激活部署包（raw 为文件外壳解包后的 data）。返回用户可读结果。 */
export function activate(raw: unknown): string {
  const pkg = validatePkg(raw);
  // 应用载荷期间临时解锁：替换语义的导入需要写权限；finally 恢复锁定
  setOperatorLocked(false);
  try {
    const p = pkg.payload;
    if (p.templates) {
      if (p.templates.groups) templateStore.importGroupsMeta(p.templates.groups);
      if (p.templates.templates.length) templateStore.replaceRules(p.templates.templates);
    }
    if (p.controls) {
      for (const id of controlsStore.getSnapshot().pages.map((x) => x.id)) {
        controlsStore.removePage(id);
      }
      for (const page of p.controls) {
        controlsStore.importPage(page as unknown as { name?: string; cards?: Record<string, unknown>[] });
      }
    }
    if (p.commands?.length) {
      for (const g of commandStore.getSnapshot().groups) {
        commandStore.removeNode(g.id);
      }
      commandStore.importGroupsMerge(p.commands);
    }
    if (p.settings) patchSettings(p.settings);
  } finally {
    setOperatorLocked(true);
  }
  snapshot = { pkg, restored: false };
  emit();
  try {
    localStorage.setItem(KEY, JSON.stringify(pkg));
  } catch {
    /* 持久化失败不阻塞本会话 */
  }
  return `Operator 模式已生效：${pkg.meta.name}`;
}

/** 退出只读模式：解锁 + 清除持久化；已导入的配置保留在界面中 */
export function exit() {
  setOperatorLocked(false);
  snapshot = { pkg: null, restored: false };
  emit();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
