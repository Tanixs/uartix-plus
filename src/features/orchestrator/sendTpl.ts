/**
 * 发送载荷 {var} 模板插值（纯函数，Node 可测——P74-3 golden 用例）。
 *
 * 语法与序列器/控制画布同源：{name}；未识别的名原样保留（留给人话提示，
 * 不得静默删除）。取值顺序：编排器变量优先，控制画布变量兜底（bind 层对
 * cmd 分支再用 variableStore.resolveVars 走一遍）。
 *
 * HEX 模式语义（直接组字节，不允许出现非法 nibble）：
 * - number：大端最小字节对（5→"05"，300→"012C"）；负数取绝对值并前置 FF
 *   标记（简化两补语义，自动化场景够用）；非有限数原样保留；
 * - bool：true→"01"，false→"00"；
 * - string：UTF-8 逐字节 hex 大写。
 */

const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type Getter = (name: string) => number | string | boolean | undefined;

export function flowInterpolateText(text: string, get: Getter): string {
  return text.replace(VAR_RE, (m, name: string) => {
    const v = get(name);
    return v === undefined ? m : String(v);
  });
}

export function flowInterpolateHex(text: string, get: Getter): string {
  return text.replace(VAR_RE, (m, name: string) => {
    const v = get(name);
    if (v === undefined) return m;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return m;
      let h = Math.round(Math.abs(v)).toString(16).toUpperCase();
      if (h.length % 2) h = `0${h}`;
      return v < 0 ? `FF${h}` : h;
    }
    if (typeof v === "boolean") return v ? "01" : "00";
    const bytes = new TextEncoder().encode(v);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  });
}
