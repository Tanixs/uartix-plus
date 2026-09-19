import { describe, expect, it } from "vitest";
import {
  csvCell, displaySecondsToSourceMs, exportFileKey, MAX_EXPORT_CELL_CHARS,
  MAX_EXPORT_COLUMNS, MAX_EXPORT_ROWS, serializeWindow, windowRows,
} from "./exportAnalysis";

const range = { fromMs: 1000, toMs: 2000 };

describe("analysis export windowing", () => {
  it("includes both endpoints, keeps duplicate timestamps and source order", () => {
    const rows = [2000, 999, 1000, 1000, 2001, NaN, Infinity].map(tsMs => ({ tsMs }));
    expect(windowRows(rows, range).map(row => row.tsMs)).toEqual([2000, 1000, 1000]);
    expect(rows).toHaveLength(7);
  });
  it("rejects invalid ranges and accepts a single instant", () => {
    expect(() => windowRows([], { fromMs: 2, toMs: 1 })).toThrow();
    expect(() => windowRows([], { fromMs: NaN, toMs: 1 })).toThrow();
    expect(() => windowRows([], { fromMs: 0, toMs: Infinity })).toThrow();
    expect(windowRows([{ tsMs: 3 }], { fromMs: 3, toMs: 3 })).toHaveLength(1);
  });
  it("converts trajectory seconds with the supplied origin before slicing", () => {
    const rows = [0, 0.5, 1, 1.1].map(seconds => ({ tsMs: displaySecondsToSourceMs(seconds, 1000) }));
    expect(windowRows(rows, range).map(row => row.tsMs)).toEqual([1000, 1500, 2000]);
    expect(() => displaySecondsToSourceMs(NaN, 0)).toThrow();
    expect(() => displaySecondsToSourceMs(1, Infinity)).toThrow();
  });
});

describe("analysis export serialization", () => {
  it("escapes commas, quotes, CR and LF; nonfinite values are missing", () => {
    expect(csvCell('a,"b"\r\nc')).toBe('"a,""b""\r\nc"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(false)).toBe("false");
    expect([null, NaN, Infinity, -Infinity].map(csvCell)).toEqual(["", "", "", ""]);
    const output = serializeWindow([{ tsMs: 1000, values: ['a,"b"\nc', NaN] }], ["label", "value"], range);
    expect(output.csv).toBe('t_ms,label,value\r\n1000,"a,""b""\nc",\r\n');
    expect(JSON.parse(output.json).rows[0].values).toEqual(['a,"b"\nc', null]);
  });
  it("reports requested and actual emitted coverage separately", () => {
    const rows = [1900, 1100, 1500, NaN].map(tsMs => ({ tsMs, values: [1] }));
    const snapshot = JSON.parse(serializeWindow(rows, ["v"], range, 2).json);
    expect(snapshot.requestedRange).toEqual(range);
    expect(snapshot.actualRange).toEqual({ fromMs: 1100, toMs: 1900 });
    expect(snapshot.matchingRows).toBe(3);
    expect(snapshot.emittedRows).toBe(2);
    expect(snapshot.truncation.rows).toBe(true);
    expect(snapshot.invalidTimestampRows).toBe(1);
    expect(snapshot.unavailable.raw).toContain("No reliable");
    expect(snapshot.unavailable.parameterLedger).toContain("No reliable");
    expect(snapshot.metadata.units).toBeNull();
  });
  it("leaves empty coverage null and distinguishes missing cells from zero", () => {
    expect(JSON.parse(serializeWindow([], ["v"], range).json).actualRange).toBeNull();
    const result = JSON.parse(serializeWindow([{ tsMs: 1000, values: [0] }], ["a", "b"], range).json);
    expect(result.rows[0].values).toEqual([0, null]);
    expect(result.missingCells).toBe(1);
  });
  it("bounds rows, columns and strings without mutating inputs", () => {
    const long = "x".repeat(MAX_EXPORT_CELL_CHARS + 1);
    const columns = Array.from({ length: MAX_EXPORT_COLUMNS + 1 }, () => long);
    const rows = Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => ({ tsMs: 1000, values: [long] }));
    const snapshot = JSON.parse(serializeWindow(rows, columns, range, MAX_EXPORT_ROWS + 100).json);
    expect(snapshot.rows).toHaveLength(MAX_EXPORT_ROWS);
    expect(snapshot.columns).toHaveLength(MAX_EXPORT_COLUMNS);
    expect(snapshot.rows[0].values[0]).toHaveLength(MAX_EXPORT_CELL_CHARS);
    expect(snapshot.truncation).toEqual({ rows: true, columns: true, strings: true });
    expect(rows[0].values[0]).toHaveLength(MAX_EXPORT_CELL_CHARS + 1);
    expect(() => serializeWindow([], [], range, 0)).toThrow();
    expect(() => serializeWindow([], [], range, 1.5)).toThrow();
    expect(() => serializeWindow([], [], range, Infinity)).toThrow();
  });
  it("uses indexed file keys independent of arbitrary group/channel names", () => {
    expect(exportFileKey("trajectory", 0)).toBe("trajectory_0.csv");
    expect(exportFileKey("trajectory", 9)).toBe("trajectory_9.csv");
    expect(exportFileKey("waveform", 9)).toBe("waveform_9.csv");
    expect(() => exportFileKey("trajectory", -1)).toThrow();
    expect(() => exportFileKey("trajectory", 0.5)).toThrow();
  });
});
