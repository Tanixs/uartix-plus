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
  csv: null,
};

export function fieldSize(f: FieldDef): number {
  const base =
    f.type === "csv"
      ? 1
      : (FIELD_SIZES[f.type] ?? f.size ?? (f.type === "bcd" ? 2 : 4));
  return Math.max(base, f.disc?.length ?? 0);
}
