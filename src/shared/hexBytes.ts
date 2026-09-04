/**
 * Hex 字节序列解析/格式化（单一实现）。
 * 帧头/帧尾/识别值在帧画布对话框与属性面板内联输入共用同一套规则，
 * 避免两处校验分叉导致「画布能存、属性面板存不进」这类不一致。
 */

/** 支持：空格 / 半角逗号 / 全角逗号 / 分号分隔；可选 0x 前缀；非法返回 null，空串返回 [] */
export function parseHexBytes(text: string): number[] | null {
  const t = text.trim().replace(/，/g, ",").replace(/；/g, ";");
  if (!t) return [];
  const words = t.split(/[\s,;]+/).filter((w) => w.length > 0);
  const out: number[] = [];
  for (const w of words) {
    const body = /^0x/i.test(w) ? w.slice(2) : w;
    if (!/^[0-9a-fA-F]{1,2}$/.test(body)) return null;
    const v = parseInt(body, 16);
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    out.push(v);
  }
  return out;
}

/** 统一显示格式：大写、两位补零、空格分隔（如 "AA 55 0C"） */
export function formatHexBytes(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export const HEX_BYTES_HINT = "十六进制字节，空格或逗号分隔，如 AA 55 0C（可带 0x 前缀）";
