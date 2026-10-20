export type HexSliceLike = {
  start: number;
  total: number;
  bytes: { length: number };
};

/**
 * Hex 取片覆盖判据：
 * - total 只增不减时，旧切片仍可复用（旧实现要求 sl.total === total，持续收流下
 *   永远不成立，导致每个 rAF 都 invoke 一次 hex_fetch）；
 * - total 回退（清空/复位）或切片尾部不够时才需要重取；
 * - 起点必须不晚于请求起点。
 */
export function hexSliceCovers(
  sl: HexSliceLike | null | undefined,
  wantStart: number,
  wantEnd: number,
  total: number,
): boolean {
  if (!sl) return false;
  if (sl.total > total) return false;
  return sl.start <= wantStart && sl.start + sl.bytes.length >= wantEnd;
}
