/**
 * 自定义布局槽位：用户可将当前 dockview 布局另存为命名布局，
 * 随时切回；内置预设切换前自动把当前布局快照到「自动备份」槽。
 */
import { useSyncExternalStore } from "react";
import {
  LAYOUT_ENVELOPE_V,
  LAYOUT_KEY_CORRUPT,
  LAYOUT_KEY_V2,
  LAYOUT_KEY_V3,
} from "./layoutEnvelope";

export interface LayoutSlot {
  id: string;
  name: string;
  /** dockview api.toJSON() 序列化结果 —— 恒为**裸布局**，不套信封（见下面那条理由） */
  layout: unknown;
  /**
   * 存这份布局时的信封版本（B13①）。旧槽没有这个字段 ⇒ 按 v2 对待。
   *
   * 为什么槽里不套信封、只留一个版本号：命名槽与 Operator 包、设置备份导出都是
   * **对外交换格式**，"裸 dockview JSON"才是它们的稳定契约；把信封塞进去等于
   * 让每个外部消费方都要会剥壳。所以信封只用在 App 自己的活动存档上，
   * 这里只留一个"我认不认识这份格式"的标记 —— 装载失败由 `applyLayoutJson` 回话。
   */
  layoutV?: number;
  ts: number;
  /** true = 切内置预设时的自动备份（最多保留 1 个，被新备份覆盖） */
  auto?: boolean;
}

interface LayoutsSnapshot {
  slots: LayoutSlot[];
}

const KEY = "vs.layouts";

/**
 * 当前停靠布局的存档键。**唯一出处** —— App.tsx 读写、`OperatorGen` 打包导出、
 * `dev/bootOverrides` 重置布局都从这里引。
 *
 * 此前这里写着"唯一出处"，而 `bootOverrides.ts:25` 其实**自己又声明了一遍同一个字面量**
 * （B1 只收掉了 OperatorGen 那份副本，漏了它）。键名一改成 v3，那份副本就会去删一个
 * 已经不写的旧键 ⇒ `?preset=` 静默失去"清掉已存布局"的能力，而 preset 根本不会生效 ——
 * 正是本文件注释里警告过的"下一个改这里的人会误判 preset 没生效"那个形状。
 * 现在它改成 import，物理上不可能再漂。
 *
 * B13①：载荷从裸 `toJSON()` 升成带版本号的信封（`layoutEnvelope.ts`），
 * 键名随之从 `vs.layout.v2` 换到 `vs.layout.v3`；v2 键**保留不删**，作为迁移后的后悔药。
 */
export const LAYOUT_KEY = LAYOUT_KEY_V3;

/** 把当前存档清干净（重置布局 / 换预设时用）。三个键都要管，漏一个就会"复活"。 */
export function clearStoredLayout(): void {
  try {
    localStorage.removeItem(LAYOUT_KEY_V3);
    // v2 是迁移留下的备份：重置布局必须连它一起清，否则下次启动又从备份里读回来
    localStorage.removeItem(LAYOUT_KEY_V2);
    localStorage.removeItem(LAYOUT_KEY_CORRUPT);
  } catch {
    /* 无 localStorage：重置退化为只改内存 */
  }
}

function load(): LayoutsSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { slots?: LayoutSlot[] };
      if (Array.isArray(parsed.slots)) {
        return {
          slots: parsed.slots.filter(
            (s) => s && s.id && typeof s.name === "string" && s.layout,
          ),
        };
      }
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return { slots: [] };
}

let snapshot: LayoutsSnapshot = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  }, 250);
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

export function useLayouts() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getLayout(id: string): LayoutSlot | null {
  return snapshot.slots.find((s) => s.id === id) ?? null;
}

/** 另存为命名布局（最多 12 个） */
export function saveLayout(name: string, layout: unknown): string {
  const slot: LayoutSlot = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 24) || `布局 ${snapshot.slots.length + 1}`,
    layout,
    layoutV: LAYOUT_ENVELOPE_V,
    ts: Date.now(),
  };
  let slots = [...snapshot.slots, slot];
  // 超出容量：优先淘汰最旧的自动备份，再淘汰最旧的手动布局
  if (slots.length > 12) {
    const autoIdx = slots.findIndex((s) => s.auto);
    if (autoIdx >= 0) slots.splice(autoIdx, 1);
    else slots = slots.slice(slots.length - 12);
  }
  snapshot = { slots };
  emit();
  return slot.id;
}

/** 切内置预设前调用：当前布局快照到 auto 槽（覆盖旧的） */
export function backupAutoLayout(layout: unknown) {
  snapshot = {
    slots: [...snapshot.slots.filter((s) => !s.auto), {
      id: "auto-backup",
      name: "上次切换前的布局（自动）",
      layout,
      layoutV: LAYOUT_ENVELOPE_V,
      ts: Date.now(),
      auto: true,
    }],
  };
  emit();
}

export function removeLayout(id: string) {
  snapshot = { slots: snapshot.slots.filter((s) => s.id !== id) };
  emit();
}

export function renameLayout(id: string, name: string) {
  snapshot = {
    slots: snapshot.slots.map((s) =>
      s.id === id ? { ...s, name: name.trim().slice(0, 24) || s.name } : s,
    ),
  };
  emit();
}
