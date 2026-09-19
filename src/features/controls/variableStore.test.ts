import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldDef, FieldOut, FrameRow, FrameTemplate, FramesEventPayload } from "../../ipc/types";

const mocks = vi.hoisted(() => ({
  onFrames: vi.fn<(cb: (payload: FramesEventPayload) => void) => () => void>(),
  subscribe: vi.fn<(cb: () => void) => () => void>(),
  getSnapshot: vi.fn<() => { rules: { templates: FrameTemplate[] } }>(),
}));
vi.mock("../../ipc/framesBus", () => ({ onFrames: mocks.onFrames }));
vi.mock("../protocol/templateStore", () => ({
  subscribe: mocks.subscribe,
  getSnapshot: mocks.getSnapshot,
}));

function field(id = "value", overrides: Partial<FieldDef> = {}): FieldDef {
  return { id, name: id, role: "data", offset: 0, type: "float32", endian: "little", color: "#fff", ...overrides };
}
function template(id = "a", fields = [field()], enabled = true): FrameTemplate {
  return { id, name: id, enabled, color: "#fff", fields, checksum: null,
    boundary: { mode: "fixedLength", headerBytes: [], fixedLength: 4, maxLength: 512 } };
}
function output(value = 42, overrides: Partial<FieldOut> = {}): FieldOut {
  return { id: "value", name: "value", raw: value, value, text: null, ...overrides };
}
function row(overrides: Partial<FrameRow> = {}): FrameRow {
  return { tplId: "a", tplName: "a", color: "#fff", tsMs: 1_000_000, seq: 10,
    len: 4, valid: true, error: null, fields: [output()], ...overrides };
}

let store: typeof import("./variableStore");
let ingest: (payload: FramesEventPayload) => void;
let rebuild: () => void;
function emit(...rows: FrameRow[]) {
  ingest({ rows, total: rows.length, errors: rows.filter(r => !r.valid).length });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.onFrames.mockReset().mockImplementation(cb => { ingest = cb; return () => {}; });
  mocks.subscribe.mockReset().mockImplementation(cb => { rebuild = cb; return () => {}; });
  mocks.getSnapshot.mockReset().mockReturnValue({ rules: { templates: [template()] } });
  store = await import("./variableStore");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("variableStore freshness", () => {
  it("emits identical finite arrivals synchronously with local sequence and monotonic receive time", async () => {
    expect(store.getObservationGeneration()).toBe(0);
    await store.init();
    const observe = vi.fn();
    store.subscribeObservations(observe);
    const notify = vi.fn();
    store.subscribe(notify);
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    emit(row());
    expect(observe).toHaveBeenCalledExactlyOnceWith({ tplId: "a", fieldId: "value", value: 42,
      sequence: 1, receivedAt: 100, generation: 1 });
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(1);
    const version = store.getSnapshot();
    clock.mockReturnValue(125);
    // Parser sequence and wall-clock timestamps can reset; local freshness cannot.
    emit(row({ seq: 0, tsMs: 0 }));
    expect(observe).toHaveBeenLastCalledWith({ tplId: "a", fieldId: "value", value: 42,
      sequence: 2, receivedAt: 125, generation: 1 });
    vi.advanceTimersByTime(200);
    expect(store.getSnapshot()).toBe(version);
    expect(store.getVar("value")).toBe(42);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("never emits or replays manual setVar writes and preserves interpolation", async () => {
    await store.init();
    store.setVar("value", 42);
    const observe = vi.fn();
    store.subscribeObservations(observe);
    store.setVar("value", 42);
    store.setVar("text", "hello");
    vi.advanceTimersByTime(300);
    expect(observe).not.toHaveBeenCalled();
    expect(store.resolveVars("{value:.2f} {text} {unknown}")).toBe("42.00 hello {unknown}");
    emit(row());
    expect(observe).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    store.subscribeObservations(late);
    expect(late).not.toHaveBeenCalled();
  });

  it("ignores wrong or disabled templates and scopes colliding field IDs to the actual row template", async () => {
    mocks.getSnapshot.mockReturnValue({ rules: { templates: [template(), template("b"), template("disabled", [field()], false)] } });
    await store.init();
    const observe = vi.fn();
    store.subscribeObservations(observe);
    emit(row({ tplId: "wrong" }), row({ tplId: "disabled" }));
    expect(observe).not.toHaveBeenCalled();
    expect(store.getVar("value")).toBeUndefined();
    expect(store.getVar("value_1")).toBeUndefined();
    emit(row(), row({ tplId: "b", fields: [output(17)] }));
    expect(store.getVar("value")).toBe(42);
    expect(store.getVar("value_1")).toBe(17);
    expect(observe.mock.calls.map(([e]) => [e.tplId, e.fieldId, e.value])).toEqual([
      ["a", "value", 42], ["b", "value", 17],
    ]);
  });

  it("ignores invalid frames without changing values or publishing observations", async () => {
    await store.init();
    store.setVar("value", 9);
    const observe = vi.fn();
    store.subscribeObservations(observe);
    emit(row({ valid: false, error: "checksum" }));
    expect(store.getVar("value")).toBe(9);
    expect(observe).not.toHaveBeenCalled();
  });

  it("excludes nonfinite, string, header and unknown fields from observations while preserving stored values", async () => {
    mocks.getSnapshot.mockReturnValue({ rules: { templates: [template("a", [
      field(), field("text", { type: "ascii" }), field("header", { role: "header" }),
    ])] } });
    await store.init();
    const observe = vi.fn();
    store.subscribeObservations(observe);
    for (const value of [NaN, Infinity, -Infinity]) {
      emit(row({ fields: [output(value)] }));
      expect(store.getVar("value")).toBe(value);
    }
    emit(row({ fields: [output(3, { id: "text", text: "hello" }),
      output(4, { id: "header" }), output(5, { id: "unknown" })] }));
    expect(store.getVar("text")).toBe("hello");
    expect(store.getVar("header")).toBeUndefined();
    expect(store.getVar("unknown")).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
    emit(row({ fields: [output(0)] }));
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("scopes dynamic numeric fields by template and retains their existing registry behavior", async () => {
    mocks.getSnapshot.mockReturnValue({ rules: { templates: [template("a", [field("csv", { type: "csv" })]),
      template("b", [field("csv", { type: "csv" })])] } });
    await store.init();
    const observe = vi.fn();
    store.subscribeObservations(observe);
    emit(row({ tplId: "wrong", fields: [output(1, { id: "csv#0", name: "wrong" })] }));
    expect(store.listVars()).toHaveLength(2);
    emit(row({ fields: [output(2, { id: "csv#0", name: "a0" })] }),
      row({ tplId: "b", fields: [output(3, { id: "csv#0", name: "b0" })] }));
    expect(store.listVars()).toHaveLength(4);
    expect(store.getVar("a0")).toBe(2);
    expect(store.getVar("b0")).toBe(3);
    expect(observe.mock.calls.map(([e]) => [e.tplId, e.fieldId, e.value])).toEqual([
      ["a", "csv#0", 2], ["b", "csv#0", 3],
    ]);
  });

  it("increments generation on every rebuild, clears values, and never adds a second frame subscription", async () => {
    await store.init();
    const observe = vi.fn();
    store.subscribeObservations(observe);
    emit(row());
    const before = observe.mock.calls[0][0];
    rebuild();
    expect(store.getObservationGeneration()).toBe(before.generation + 1);
    expect(store.getVar("value")).toBeUndefined();
    expect(observe).toHaveBeenCalledTimes(1);
    emit(row());
    const after = observe.mock.calls[1][0];
    expect(after.generation).toBe(store.getObservationGeneration());
    expect(after.sequence).toBeGreaterThan(before.sequence);
    mocks.getSnapshot.mockReturnValue({ rules: { templates: [] } });
    rebuild();
    expect(store.getObservationGeneration()).toBe(after.generation + 1);
    emit(row());
    expect(observe).toHaveBeenCalledTimes(2);
    await store.init();
    expect(mocks.onFrames).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("isolates throwing listeners and supports unsubscribe without interrupting acquisition", async () => {
    await store.init();
    const stopThrowing = store.subscribeObservations(() => { throw new Error("consumer failure"); });
    const observe = vi.fn();
    const unsubscribe = store.subscribeObservations(observe);
    expect(() => emit(row(), row({ fields: [output(7)] }))).not.toThrow();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(store.getVar("value")).toBe(7);
    vi.advanceTimersByTime(100);
    expect(store.getSnapshot()).toBe(2);
    unsubscribe();
    stopThrowing();
    emit(row());
    expect(observe).toHaveBeenCalledTimes(2);
    expect(store.getVar("value")).toBe(42);
  });
});
