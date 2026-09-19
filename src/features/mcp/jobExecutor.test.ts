import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../ipc/framesBus", () => ({ onFrames: vi.fn(() => () => {}) }));
vi.mock("../controls/variableStore", () => ({ getVar: vi.fn() }));
const mcp = vi.hoisted(() => ({ enabled: true }));
vi.mock("../settings/settingsStore", () => ({ getSnapshot: () => ({ mcpEnabled: mcp.enabled }) }));
import { JobExecutor, type Dispatch, type Envelope, type Reporter } from "./jobExecutor";
import { prepareSequence, sequenceAdapters } from "./jobAdapters";
import { isRunning, stopRun } from "../sequencer/runner";

const envelope: Envelope = { protocolVersion: 1, bridgeEpoch: 1, executorEpoch: "test", jobId: "instance:one", dispatchNonce: "nonce", stateVersion: 1 };
const dispatch = (steps: unknown[], source?: string): Dispatch => ({ envelope, taskType: "sequence.run", input: { suite: { name: "No device test", steps } }, deadlineAt: Date.now() + 120000, source });
function setup() {
  const send = vi.fn(); const unsub = vi.fn(); const onFrames = vi.fn(() => unsub);
  const receipts: Parameters<Reporter>[0][] = [];
  let version = 1;
  const report: Reporter = async (r) => {
    receipts.push(r);
    if (r.kind !== "progress") version++;
    return { applied: true, envelope: { ...r.envelope, stateVersion: version } };
  };
  const adapters = sequenceAdapters({ send, resolveSend: () => null, onFrames, getVar: () => 1, now: Date.now });
  return { executor: new JobExecutor(adapters, report, () => { if (!mcp.enabled) throw new Error("permission_denied"); }), send, unsub, onFrames, receipts };
}
afterEach(() => { stopRun(); vi.useRealTimers(); });
describe("P88a side-effect-free executor integration", () => {
  it("acknowledges started before a 5s runner completes, does not duplicate, releases subscription and timer", async () => {
    vi.useFakeTimers(); const t = setup();
    const d = dispatch([{ kind: "wait", ms: 5000 }, { kind: "note", text: "finished" }]);
    const done = t.executor.dispatch(d);
    expect(t.executor.dispatch(d)).toBe(done);
    await vi.advanceTimersByTimeAsync(3001);
    expect(t.receipts[0].kind).toBe("started");
    expect(t.receipts.some((r) => r.kind === "succeeded")).toBe(false);
    expect(isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000); await done;
    expect(t.receipts[t.receipts.length - 1]?.kind).toBe("succeeded");
    expect(t.onFrames).toHaveBeenCalledTimes(1);
    expect(t.unsub).toHaveBeenCalledTimes(1);
    expect(t.send).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(t.executor.size).toBe(0);
  });
  it("confirms cancellation only after runner.done and does not continue steps", async () => {
    vi.useFakeTimers(); const t = setup();
    const done = t.executor.dispatch(dispatch([{ kind: "wait", ms: 5000 }, { kind: "note", text: "must skip" }]));
    await vi.advanceTimersByTimeAsync(100);
    t.executor.cancel(envelope); t.executor.cancel(envelope);
    await done;
    expect(t.receipts[t.receipts.length - 1]?.kind).toBe("cancelled");
    expect(t.unsub).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    expect(t.send).not.toHaveBeenCalled(); expect(isRunning()).toBe(false);
  });
  it("rejects raw nested sends and unknown kinds before runner or subscription regardless of approval flags", async () => {
    const t = setup(); const d = dispatch([{ kind: "group", children: [{ kind: "send", enabled: false, payload: { type: "hex", text: "FF" } }] }]);
    d.input = { ...(d.input as object), highPriv: true, confirmed: true };
    await t.executor.dispatch(d);
    expect(t.receipts.map((r) => r.kind)).toEqual(["rejected"]);
    expect(t.onFrames).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled();
    expect(() => prepareSequence({ suite: { name: "unknown", steps: [{ kind: "calibrate", safe: true }] } }, true)).toThrow("needs_manual_confirmation");
  });
  it("validation describes unavailable send capability but never starts runner", async () => {
    const t = setup(); const d = dispatch([{ kind: "send", payload: { type: "hex", text: "FF" } }]); d.taskType = "sequence.validate";
    await t.executor.dispatch(d);
    expect(t.receipts[t.receipts.length - 1]?.kind).toBe("succeeded");
    expect(t.receipts[t.receipts.length - 1]?.result).toMatchObject({ valid: true, runCapability: "needs_manual_confirmation" });
    expect(t.onFrames).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled();
  });
  it("deadline cleanup and a stale completion receipt rebase without restarting the runner", async () => {
    vi.useFakeTimers();
    const unsub = vi.fn(); const onFrames = vi.fn(() => unsub); const send = vi.fn();
    let finishedAttempts = 0;
    const report: Reporter = async (r) => {
      if (r.kind === "cancelled" && ++finishedAttempts === 1) {
        return { applied: false, envelope: { ...r.envelope, stateVersion: 3 } };
      }
      return { applied: true, envelope: { ...r.envelope, stateVersion: r.envelope.stateVersion + 1 } };
    };
    const executor = new JobExecutor(sequenceAdapters({ send, resolveSend: () => null, onFrames, getVar: () => 1, now: Date.now }), report, () => {});
    const d = dispatch([{ kind: "wait", ms: 5000 }]); d.deadlineAt = Date.now() + 1000;
    const done = executor.dispatch(d);
    await vi.advanceTimersByTimeAsync(1001); await done;
    expect(finishedAttempts).toBe(2);
    expect(onFrames).toHaveBeenCalledTimes(1); expect(unsub).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); expect(executor.size).toBe(0);
  });
  it("business assertion failure is not success", async () => {
    const t = setup(); await t.executor.dispatch(dispatch([{ kind: "assertVar", varName: "v", op: "eq", expected: 2 }]));
    expect(t.receipts[t.receipts.length - 1]?.kind).toBe("failed"); expect(t.unsub).toHaveBeenCalledTimes(1);
  });
  it("P88b-2 §6: local_agent runs while MCP is off, external source stays gated", async () => {
    mcp.enabled = false;
    const t = setup();
    // 外部来源（缺省=mcp）：不派发，拒绝
    await t.executor.dispatch(dispatch([{ kind: "wait", ms: 10 }]));
    expect(t.receipts.map((r) => r.kind)).toEqual(["rejected"]);
    expect(t.unsub).not.toHaveBeenCalled();
    // 本地来源：照常执行
    await t.executor.dispatch(dispatch([{ kind: "note", text: "local ok" }], "local_agent"));
    expect(t.receipts[t.receipts.length - 1]?.kind).toBe("succeeded");
    mcp.enabled = true;
  });
});
