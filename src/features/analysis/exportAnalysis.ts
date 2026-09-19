/** Pure export primitives. No store access, network, GPU, clock or filesystem writes. */
export interface ExportWindow {
  /** Absolute source milliseconds, not necessarily Unix time. Both ends inclusive. */
  fromMs: number;
  toMs: number;
}
export type ExportCell = string | number | boolean | null;
export interface ExportRow {
  tsMs: number;
  values: readonly ExportCell[];
}
export const MAX_EXPORT_ROWS = 2000;
export const MAX_EXPORT_COLUMNS = 32;
export const MAX_EXPORT_CELL_CHARS = 512;

function validateWindow(window: ExportWindow): void {
  if (!Number.isFinite(window.fromMs) || !Number.isFinite(window.toMs)
    || window.fromMs > window.toMs) throw new Error("Invalid absolute source millisecond range");
}

/** Inclusive source-ms window, preserving source order and duplicate timestamps. */
export function windowRows<T extends { tsMs: number }>(
  rows: readonly T[], window: ExportWindow,
): T[] {
  validateWindow(window);
  return rows.filter(row => Number.isFinite(row.tsMs)
    && row.tsMs >= window.fromMs && row.tsMs <= window.toMs);
}

/** exportTriples display seconds must be converted BEFORE windowing. */
export function displaySecondsToSourceMs(seconds: number, originMs: number): number {
  const result = originMs + seconds * 1000;
  if (![seconds, originMs, result].every(Number.isFinite)) throw new Error("Invalid trajectory time");
  return result;
}

/** RFC 4180 quoting. Nonfinite values are explicitly missing, never invented. */
export function csvCell(value: ExportCell): string {
  const text = value === null || (typeof value === "number" && !Number.isFinite(value))
    ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Names/IDs stay in metadata, not paths. Index must come from current selection. */
export function exportFileKey(kind: "waveform" | "trajectory", index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid file index");
  return `${kind}_${index}.csv`;
}

/**
 * Bounded CSV + JSON preview: first N matching rows, at most 32 columns and
 * 512 UTF-16 units per string. This is not a full recording or disk manifest.
 * Returned coverage is that of emitted rows, not the requested or retained buffer.
 */
export function serializeWindow(
  rows: readonly ExportRow[],
  columns: readonly string[],
  window: ExportWindow,
  requestedLimit = MAX_EXPORT_ROWS,
): { csv: string; json: string } {
  validateWindow(window);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error("Invalid row limit");
  const limit = Math.min(requestedLimit, MAX_EXPORT_ROWS);
  const headers = columns.slice(0, MAX_EXPORT_COLUMNS).map(name => name.slice(0, MAX_EXPORT_CELL_CHARS));
  let stringsTruncated = headers.some((name, i) => name !== columns[i]);
  const selected: ExportRow[] = [];
  let matchingRows = 0;
  let invalidTimestampRows = 0;
  let missingCells = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.tsMs)) { invalidTimestampRows++; continue; }
    if (row.tsMs < window.fromMs || row.tsMs > window.toMs) continue;
    matchingRows++;
    if (selected.length >= limit) continue;
    const values = headers.map((_, i): ExportCell => {
      const value = row.values[i] ?? null;
      if (value === null || (typeof value === "number" && !Number.isFinite(value))) {
        missingCells++;
        return null;
      }
      if (typeof value === "string" && value.length > MAX_EXPORT_CELL_CHARS) {
        stringsTruncated = true;
        return value.slice(0, MAX_EXPORT_CELL_CHARS);
      }
      return value;
    });
    selected.push({ tsMs: row.tsMs, values });
  }
  const times = selected.map(row => row.tsMs);
  const actualRange = times.length ? { fromMs: Math.min(...times), toMs: Math.max(...times) } : null;
  const snapshot = {
    schema: "vs-analysis-export-preview/v1",
    timeUnit: "ms", timeDomain: "absolute-source", rangeBoundary: "inclusive",
    requestedRange: { ...window }, actualRange,
    rowLimit: limit, matchingRows, emittedRows: selected.length,
    truncation: { rows: matchingRows > selected.length, columns: columns.length > headers.length, strings: stringsTruncated },
    invalidTimestampRows, missingCells,
    metadata: { units: null, pairing: null, transform: null, algorithm: "first-N-in-source-order/v1" },
    unavailable: { raw: "No reliable raw byte source supplied", parameterLedger: "No reliable parameter ledger supplied" },
    missingNotes: ["Units, pairing and transform are not supplied to this preview helper.",
      "Nonfinite/missing values are null in JSON and empty in CSV. Source order is preserved; no interpolation."],
    columns: headers, rows: selected,
  };
  const csv = [ ["t_ms", ...headers].map(csvCell).join(","),
    ...selected.map(row => [row.tsMs, ...row.values].map(csvCell).join(",")),
  ].join("\r\n") + "\r\n";
  return { csv, json: JSON.stringify(snapshot) };
}
