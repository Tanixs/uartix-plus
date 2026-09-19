import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ParameterObservation, ParameterStep } from "./controlTransaction";
import { ControlTransactionRunner } from "./controlTransaction";

// Deterministic local-simulation tests only: fake clock, fake transport, no serial I/O.
let t: number;
const now = () => t;
const advance = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };

interface Harness {
  runner: ControlTransactionRunner;
  sends: ParameterStep[];
  settleSend(index: number): void;
  rejectSend(index: number): void;
  emit(stepIndex: number, value: number, sequence: number, at?: number): void;
  setGeneration(g: number): void;
  generation: number;
  snapshots: { status: string; steps: { status: string }[] }[];
  unsubscribeCount: () => number;
}

function fb(tolerance = 0.01, holdMs = 0, maxGapMs = 1000, timeoutMs = 60_000) {
  return { tplId: "tpl1", fieldId: "f1", tolerance, holdMs, maxGapMs, timeoutMs };
}

function makeRunner(options: Partial<ConstructorParameters<typeof ControlTransactionRunner>[0]> = {}): Harness {
  const state = {
    sends: [] as ParameterStep[],
    pending: [] as ((error?: Error) => void)[],
    listener: null as ((event: ParameterObservation) => void) | null,
    unsubscribed: 0,
    generation: 7,
    snapshots: [] as { status: string; steps: { status: string }[] }[],
  };
  const runner = new ControlTransactionRunner({
    send: (step) => new Promise<void>((resolve, reject) => {
      state.sends.push(step);
      state.pending.push((error) => (error ? reject(error) : resolve()));
    }),
    subscribeObservations: (listener) => {
      state.listener = listener;
      return () => { state.unsubscribed++; state.listener = null; };
    },
    getGeneration: () => state.generation,
    now,
    ...options,
  });
  runner.subscribe(() => state.snapshots.push(JSON.parse(JSON.stringify(runner.getSnapshot()))));
  return {
    runner,
    get sends() { return state.sends; },
    settleSend: (index) => state.pending[index]!(),
    rejectSend: (index) => state.pending[index]!(new Error("local transport rejected")),
    emit: (_stepIndex, value, sequence, at = t) => {
      state.listener?.({ tplId: "tpl1", fieldId: "f1", value, sequence, receivedAt: at, generation: state.generation });
    },
    setGeneration: (g) => { state.generation = g; },
    generation: 7,
    snapshots: state.snapshots,
    unsubscribeCount: () => state.unsubscribed,
  };
}

const step = (id: string, value: number, feedback?: ParameterStep["feedback"]): ParameterStep =>
  ({ id, value, ...(feedback ? { feedback } : {}) });

beforeEach(() => { t = 0; vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("control transaction runner", () => {
  it("verifies steps in order with fresh identical observations and frozen values", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("kp", 1.5, fb(0.01, 200)), step("ki", 0.2, fb(0.01, 0))]);
    advance(25);
    expect(h.sends).toEqual([step("kp", 1.5, fb(0.01, 200))]);
    h.settleSend(0);
    h.emit(0, 1.499, 10); // fresh identical-value observation, within tolerance
    advance(200);
    h.emit(0, 1.499, 11); // second fresh frame completes hold window
    advance(25);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.runner.getSnapshot().steps[0]).toMatchObject({ status: "verified" });
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toEqual(step("ki", 0.2, fb(0.01, 0))); // frozen value, not live draft
    h.settleSend(1);
    h.emit(1, 0.2, 12);
    advance(25);
    const snapshot = await done;
    expect(snapshot.status).toBe("verified");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["verified", "verified"]);
    expect(h.unsubscribeCount()).toBe(2);
    expect(h.runner.getHistory()).toHaveLength(1);
  });

  it("ignores stale, out-of-order, wrong-target, stale-generation and pre-arrival observations", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("kp", 1, fb(0.01, 0))]);
    advance(25);
    // pre-arrival frames replayed by the cache before arming must not be claimable
    h.emit(0, 1, 1);
    h.emit(0, 1, 2);
    h.settleSend(0);
    // stale sequence and duplicate sequence after arming
    h.emit(0, 1, 2);
    h.emit(0, 1, 1);
    h.emit(0, 1, 3); // fresh identical value with sequence 3 completes verification
    advance(25);
    const snapshot = await done;
    expect(snapshot.status).toBe("verified");
    expect(snapshot.steps[0]!.observation).toMatchObject({ sequence: 3 });
    // wrong template/field/generation/value are rejected even after completion
    expect(h.runner.getSnapshot().steps[0]!.observation!.tplId).toBe("tpl1");
    await done;
  });

  it("does not verify from pre-send cache frames after send resolves", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("kp", 5, fb(0.01, 0, 1000, 500))]);
    advance(25);
    h.settleSend(0);
    await Promise.resolve();
    // no fresh frame within the step timeout
    advance(500);
    const snapshot = await done;
    expect(snapshot.status).toBe("timeout");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["timeout"]);
    expect(h.unsubscribeCount()).toBe(1);
  });

  it("stops after an unverified sent step when the step has no feedback contract", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("mode", 1), step("kp", 2)]);
    advance(25);
    expect(h.runner.getSnapshot().status).toBe("sending");
    h.settleSend(0);
    advance(25);
    const snapshot = await done;
    expect(snapshot.status).toBe("sent");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["sent", "cancelled"]);
    expect(h.sends).toHaveLength(1);
    expect(h.runner.getHistory()[0]!.status).toBe("sent");
  });

  it("enforces plan bounds and invalid feedback specifications without sending", async () => {
    const h = makeRunner();
    const bad: [string, () => unknown][] = [
      ["empty", () => h.runner.start([])],
      ["too many", () => h.runner.start(Array.from({ length: 33 }, (_, i) => step(`p${i}`, 1)))],
      ["duplicate ids", () => h.runner.start([step("a", 1), step("a", 2)])],
      ["non-finite value", () => h.runner.start([step("a", Number.NaN)])],
      ["bad id", () => h.runner.start([step("", 1)])],
      ["hold over timeout", () => h.runner.start([step("a", 1, fb(0, 2000, 100, 1000))])],
      ["zero maxGap", () => h.runner.start([step("a", 1, fb(0, 0, 0, 1000))])],
      ["negative tolerance", () => h.runner.start([step("a", 1, fb(-1))])],
      ["zero timeout", () => h.runner.start([step("a", 1, fb(0, 0, 100, 0))])],
      ["huge timeout", () => h.runner.start([step("a", 1, fb(0, 0, 100, 61_000))])],
      ["missing tpl", () => h.runner.start([{ id: "a", value: 1, feedback: { tplId: "", fieldId: "f", tolerance: 0, holdMs: 0, maxGapMs: 1, timeoutMs: 1000 } }])],
    ];
    for (const [name, run] of bad) expect(() => run(), name).toThrow();
    expect(h.sends).toHaveLength(0);
    expect(h.runner.getSnapshot().status).toBe("idle");
    expect(h.runner.getHistory()).toHaveLength(0);
  });

  it("times out a step waiting for stability and cancels remaining steps once", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("kp", 1, fb(0.01, 500, 1000, 1000)), step("ki", 2, fb())]);
    advance(25);
    h.settleSend(0);
    await Promise.resolve();
    h.emit(0, 1, 1);
    advance(25);
    expect(h.runner.getSnapshot().steps[0]!.status).toBe("settling");
    advance(975);
    const snapshot = await done;
    expect(snapshot.status).toBe("timeout");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["timeout", "cancelled"]);
    expect(h.sends).toHaveLength(1);
  });

  it("enforces the total transaction deadline across bounded steps", async () => {
    const h = makeRunner({ totalTimeoutMs: 1500 });
    const done = h.runner.start([step("a", 1, fb(0, 0, 100, 2000)), step("b", 2, fb(0, 0, 100, 2000))]);
    advance(25);
    h.settleSend(0);
    await Promise.resolve();
    h.emit(0, 1, 1);
    expect(h.sends).toHaveLength(2);
    h.settleSend(1);
    await Promise.resolve();
    advance(1475);
    const snapshot = await done;
    expect(snapshot.status).toBe("timeout");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["verified", "timeout"]);
  });

  it("stop cancels pending steps and marks the in-flight send unknown until it settles", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("a", 1, fb(0, 0, 100, 30_000)), step("b", 2, fb())]);
    advance(25);
    h.runner.stop("user stop");
    advance(25);
    expect(h.runner.getSnapshot().status).toBe("unknown");
    expect(h.runner.getSnapshot().steps.map((s) => s.status)).toEqual(["unknown", "cancelled"]);
    // new transaction is blocked until the in-flight send settles, and never retried
    expect(() => h.runner.start([step("c", 3)])).toThrow();
    h.settleSend(0);
    await Promise.resolve();
    expect(() => h.runner.start([step("c", 3)])).not.toThrow();
    const second = h.runner.getSnapshot();
    expect(second.id).toBe(2);
    expect(second.status).not.toBe("unknown");
    await done;
  });

  it("stop before any send cancels cleanly and start is rejected while busy", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("a", 1), step("b", 2)]);
    advance(25);
    expect(() => h.runner.start([step("x", 1)])).toThrow();
    h.settleSend(0); // no feedback -> "sent" terminal already resolves
    const snapshot = await done;
    expect(snapshot.steps[1]!.status).toBe("cancelled");
    h.runner.stop(); // idle stop is a no-op
    expect(h.runner.getSnapshot().status).toBe("sent");
  });

  it("invalidates the transaction when the target generation changes", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("a", 1, fb(0, 0, 100, 30_000)), step("b", 2)]);
    advance(25);
    h.settleSend(0);
    await Promise.resolve();
    expect(h.runner.getSnapshot().steps[0]!.status).toBe("sent");
    h.setGeneration(8);
    advance(25);
    expect(h.runner.getSnapshot().steps[0]!.status).toBe("unknown");
    expect(h.runner.getSnapshot().steps[0]!.observation).toBeUndefined();
    h.emit(0, 1, 99, t);
    advance(25);
    const snapshot = await done;
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["unknown", "cancelled"]);
    expect(h.sends).toHaveLength(1);
  });

  it("rejects start when the declared generation does not match the live target", () => {
    const h = makeRunner();
    expect(() => h.runner.start([step("a", 1)], 6)).toThrow();
    expect(() => h.runner.start([step("a", 1)], 7)).not.toThrow();
  });

  it("marks a step failed when the transport throws or rejects, without retries", async () => {
    const hThrow = new ControlTransactionRunner({
      send: () => { throw new Error("sync reject"); },
      subscribeObservations: () => () => undefined,
      getGeneration: () => 1,
      now,
    });
    const done1 = hThrow.start([step("a", 1), step("b", 2)]);
    const snapshot1 = await done1;
    expect(snapshot1.status).toBe("failed");
    expect(snapshot1.steps.map((s) => s.status)).toEqual(["failed", "cancelled"]);

    const h = makeRunner();
    const done2 = h.runner.start([step("a", 1), step("b", 2)]);
    advance(25);
    h.rejectSend(0);
    advance(25);
    const snapshot = await done2;
    expect(snapshot.status).toBe("failed");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["failed", "cancelled"]);
    expect(h.sends).toHaveLength(1); // no automatic retry
  });

  it("keeps at most 50 history entries with unique ids", async () => {
    const h = makeRunner();
    for (let i = 0; i < 51; i++) {
      const done = h.runner.start([step("p", i)]);
      advance(25);
      h.settleSend(i);
      const snapshot = await done;
      expect(snapshot.id).toBe(i + 1);
    }
    const history = h.runner.getHistory();
    expect(history).toHaveLength(50);
    expect(history[0]!.id).toBe(2); // oldest (id 1) evicted
    expect(history[49]!.id).toBe(51);
    expect(history.map((s) => s.steps[0]!.step.value)).toContain(50);
  });

  it("mutation of returned snapshots does not affect internal state or history", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("a", 1)]);
    advance(25);
    h.settleSend(0);
    const snapshot = await done;
    snapshot.steps[0]!.status = "verified" as never;
    snapshot.steps[0]!.step.value = 99;
    expect(h.runner.getSnapshot().steps[0]!.step.value).toBe(1);
    expect(h.runner.getHistory()[0]!.steps[0]!.status).not.toBe("verified");
  });

  it("unsubscribes observations exactly once per finished step and stops timers", async () => {
    const h = makeRunner();
    const done = h.runner.start([step("a", 1, fb(0, 0, 100, 30_000))]);
    advance(25);
    h.settleSend(0);
    h.emit(0, 1, 1);
    advance(25);
    await done;
    expect(h.unsubscribeCount()).toBe(1);
    // no stray interval keeps running: advancing far past everything must stay terminal
    advance(400_000);
    expect(h.runner.getSnapshot().status).toBe("verified");
    expect(h.runner.getHistory()).toHaveLength(1);
  });
});
