import type { ValueLabel } from "../ipc/types";

/**
 * 值标签（枚举注解）：把解码值映射成人能读懂的文字。
 * 纯显示层能力——数值通道、变量、曲线仍走原始数字，这里只负责
 * 「表格里 2 → 2 非法数据地址」这类注释性呈现（Modbus 异常码、状态字、模式字）。
 */

/** 查值对应的文字；未命中标签返回 null。整数精确匹配，浮点按 1e-9 容差 */
export function labelText(labels: ValueLabel[] | null | undefined, v: number): string | null {
  if (!labels || labels.length === 0) return null;
  if (!Number.isFinite(v)) return null;
  const hit = labels.find((l) => Math.abs(l.v - v) < 1e-9);
  return hit ? hit.t : null;
}

/** 单元格显示：数字后附标签（无标签时只显示数字） */
export function labeledValue(
  labels: ValueLabel[] | null | undefined,
  v: number,
  fmt: (n: number) => string,
): string {
  const num = fmt(v);
  const lb = labelText(labels, v);
  return lb ? `${num} ${lb}` : num;
}

/** 编辑用文本："1=非法功能码" 每条一行（也允许用 ; / ； 分隔写在同一行）；空值/非法条目忽略 */
export function parseLabelSpec(text: string): ValueLabel[] {
  const out: ValueLabel[] = [];
  for (const line of text.split(/\r?\n|[;；]/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const raw = t.slice(0, i).trim();
    const label = t.slice(i + 1).trim();
    if (!label) continue;
    const v = /^0[xX][0-9a-fA-F]+$/.test(raw)
      ? Number.parseInt(raw, 16)
      : Number(raw);
    if (!Number.isFinite(v)) continue;
    out.push({ v, t: label });
  }
  return out;
}

/** 标签列表 → 编辑用文本（单行分号分隔，与 parseLabelSpec 往返一致） */
export function formatLabelSpec(labels: ValueLabel[] | null | undefined): string {
  if (!labels || labels.length === 0) return "";
  return labels.map((l) => `${l.v}=${l.t}`).join("; ");
}
