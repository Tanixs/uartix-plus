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

/** 逐字节掩码模式：用于帧头/识别位里「某几位无所谓」的字节（如 Modbus 任意从站地址） */
export interface HexPattern {
  bytes: number[];
  /** 与 bytes 等长；0xFF=精确，0x00=整字节通配，其余为按位约束 */
  mask: number[];
}

/**
 * 解析带通配的字节模式。除 parseHexBytes 的普通写法外，每个字节还可写：
 *   `??`      整字节通配（mask 0x00）
 *   `A?` `?5` 半字节通配（mask 0xF0 / 0x0F）
 *   `80&F0`   显式按位掩码：值 0x80、只比较高 4 位
 * 掩码全为 0xFF 时返回的 mask 仍为等长数组，调用方可在自己的存储里省略以兼容旧数据。
 */
export function parseHexPattern(text: string): HexPattern | null {
  const t = text.trim().replace(/，/g, ",").replace(/；/g, ";");
  if (!t) return { bytes: [], mask: [] };
  const words = t.split(/[\s,;]+/).filter((w) => w.length > 0);
  const bytes: number[] = [];
  const mask: number[] = [];
  for (const w of words) {
    const body = /^0x/i.test(w) ? w.slice(2) : w;
    const amp = body.indexOf("&");
    if (amp >= 0) {
      const v = body.slice(0, amp);
      const m = body.slice(amp + 1);
      if (!/^[0-9a-fA-F]{1,2}$/.test(v) || !/^[0-9a-fA-F]{1,2}$/.test(m)) return null;
      bytes.push(parseInt(v, 16) & 0xff);
      mask.push(parseInt(m, 16) & 0xff);
      continue;
    }
    if (/^\?\?$/.test(body)) {
      bytes.push(0);
      mask.push(0x00);
      continue;
    }
    const hi = /^([0-9a-fA-F])\?$/.exec(body);
    if (hi) {
      bytes.push((parseInt(hi[1], 16) << 4) & 0xff);
      mask.push(0xf0);
      continue;
    }
    const lo = /^\?([0-9a-fA-F])$/.exec(body);
    if (lo) {
      bytes.push(parseInt(lo[1], 16) & 0x0f);
      mask.push(0x0f);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,2}$/.test(body)) return null;
    bytes.push(parseInt(body, 16) & 0xff);
    mask.push(0xff);
  }
  return { bytes, mask };
}

/** 掩码是否全为精确匹配（是则可省略 mask 字段，保持与旧数据/旧模板一致） */
export function isExactMask(mask: number[]): boolean {
  return mask.every((m) => m === 0xff);
}

/** 反向格式化：精确字节照常输出，通配按 `??` / `A?` / `?5` / `NN&MM` 还原 */
export function formatHexPattern(bytes: number[], mask?: number[] | null): string {
  if (!mask || mask.length === 0 || isExactMask(mask)) return formatHexBytes(bytes);
  return bytes
    .map((b, i) => {
      const m = mask[i] ?? 0xff;
      if (m === 0xff) return b.toString(16).toUpperCase().padStart(2, "0");
      if (m === 0x00) return "??";
      if (m === 0xf0 && (b & 0x0f) === 0) return `${((b >> 4) & 0x0f).toString(16).toUpperCase()}?`;
      if (m === 0x0f && (b & 0xf0) === 0) return `?${(b & 0x0f).toString(16).toUpperCase()}`;
      return `${b.toString(16).toUpperCase().padStart(2, "0")}&${m
        .toString(16)
        .toUpperCase()
        .padStart(2, "0")}`;
    })
    .join(" ");
}

export const HEX_BYTES_HINT = "十六进制字节，空格或逗号分隔，如 AA 55 0C（可带 0x 前缀）";
export const HEX_PATTERN_HINT =
  "字节模式：AA=精确、??=任意值、A?/?5=高/低半字节、80&F0=按位掩码（如 Modbus 任意从站地址写 ??）";
