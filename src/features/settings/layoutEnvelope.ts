/**
 * P104-B13①：停靠布局的**版本信封**。
 *
 * 为什么要信封：v2 的存档就是裸的 `api.toJSON()`，没有版本号。于是任何一次格式变更
 * 都只能靠"改键名"来表达（`vs.layout` → `vs.layout.v2` 就是这么来的），
 * 而改键名意味着旧数据要么被忽略、要么被误删 —— 没有"读旧写新"的位置。
 * 有了 `v` 字段，将来才是加一个 case，而不是再赌一次键名。
 *
 * 形态：
 *   v3 = { v: 3, layout: <dockview toJSON()> }
 *   v2 = 裸的 toJSON()（无 v 字段）
 *
 * ⚠ 这里**故意不删 v2 键**。迁移后 v3 与 v2 会并存一段时间：
 * 布局是用户自己摆出来的东西，改错了不可重试；留一份原样旧档是唯一的后悔药。
 * 代价只是几 KB 和一个"为什么有两个键"的疑问 —— 值。
 * 清理它的时机是"v3 跑过至少一个完整版本周期且没人报布局丢失"，不是这次。
 *
 * 本模块是叶子：纯函数、不 import store、不碰 React、不碰 localStorage，
 * 所以能在 node 环境下直接测（§8-33 求值期纪律）。
 */

/** v2 的键名。只用于"读旧档"与"留备份"，不再写入。 */
export const LAYOUT_KEY_V2 = "vs.layout.v2";
/** v3 的键名。当前唯一的写入目标。 */
export const LAYOUT_KEY_V3 = "vs.layout.v3";
/** 解析不了的存档**不删**，挪到这里留着取证（见 unwrap 的 `bad`）。 */
export const LAYOUT_KEY_CORRUPT = "vs.layout.corrupt";

export const LAYOUT_ENVELOPE_V = 3;

export interface LayoutEnvelope {
  v: number;
  layout: unknown;
}

export type Unwrapped =
  /** 带 `v` 的信封，且版本认得 */
  | { kind: "envelope"; layout: unknown }
  /** 裸的 dockview JSON（v2 及更早）：内容能用，但没有版本标记 */
  | { kind: "bare"; layout: unknown }
  /** 键在但内容读不出来 / 认不出版本 —— 绝不能当成"没有存档"顺手清掉 */
  | { kind: "bad"; raw: string };

/** 写：把 dockview 的 toJSON() 结果包成 v3 信封字符串。 */
export function packEnvelope(layout: unknown): string {
  return JSON.stringify({ v: LAYOUT_ENVELOPE_V, layout } satisfies LayoutEnvelope);
}

/**
 * 读：把一段存档文本解成"能不能用 + 是不是旧格式"。
 *
 * 判定顺序刻意保守：先 JSON.parse，再认 `v`，最后才把整包当裸布局。
 * `looksLikeLayout` 由调用方注入（它才知道 dockview 的形态），
 * 这里不复制那份判定 —— 否则 dockview 一升级就得改两个地方。
 */
export function unwrapEnvelope(
  raw: string | null,
  looksLikeLayout: (v: unknown) => boolean,
): Unwrapped | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "bad", raw };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (typeof o.v === "number") {
      // 只认当前版本。将来加 v4 时在这里补 `if (o.v === 3) return migrate3to4(o.layout)`，
      // 而不是又去赌一个键名。
      if (o.v === LAYOUT_ENVELOPE_V && looksLikeLayout(o.layout)) {
        return { kind: "envelope", layout: o.layout };
      }
      // 认不出的版本：**不要**硬喂给 dockview，也不要删。降级到"用默认布局"，
      // 原档留在 v3 键里等这一版学会读它。
      return { kind: "bad", raw };
    }
    if (looksLikeLayout(o)) return { kind: "bare", layout: o };
  }
  return { kind: "bad", raw };
}
