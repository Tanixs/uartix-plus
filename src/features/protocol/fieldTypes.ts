import type { FieldDef, FieldType } from "../../ipc/types";

export const FIELD_SIZES: Record<FieldType, number | null> = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
  float64: 8,
  ascii: null,
  bcd: null,
  bits: 1,
  // csv 是解析侧的显示类型：宽度由分隔符与整帧决定，这里恒给 1 占一格（与两侧历史兜底一致）
  csv: 1,
};

/** 只有这两种的宽度不在类型里，得由作者声明 */
export const VARIABLE_TYPES: FieldType[] = ["ascii", "bcd"];

/**
 * 一块占几个字节 —— 接收侧与发送侧**共用这一张表**。
 *
 * 过去两边各写一遍，兜底还不一样（`ascii` 没声明长度时接收按 4、发送按 1），
 * 于是同一块字节在两个方向上不是同一个宽度 —— "能解出来却发不出去"的一类根因就在这。
 * 现在变长类型没声明长度就返回 `null`：**不猜**。猜一个数会让两边各自猜出不同的数，
 * 而 `null` 逼着调用方自己决定怎么交代（界面给一个写明的默认值、投影拒绝派生、布局塌成 0 格）。
 */
export function widthOf(type: FieldType, size?: number | null): number | null {
  const fixed = FIELD_SIZES[type];
  if (fixed !== null && fixed !== undefined) return fixed;
  return Number.isFinite(size as number) && (size as number) > 0 ? (size as number) : null;
}

/** 属性面板的**界面默认**：写进字段里，不是藏在宽度算式里的兜底 */
export const DECLARED_DEFAULT: Partial<Record<FieldType, number>> = { ascii: 4, bcd: 2, csv: 1 };

export function fieldSize(f: FieldDef): number {
  return Math.max(widthOf(f.type, f.size) ?? 0, f.disc?.length ?? 0);
}
