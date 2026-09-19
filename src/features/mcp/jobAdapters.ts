/** Explicit task adapters. No arbitrary App Action and no hardware approval inference. */
import { normalizeSuite } from "../sequencer/sequencerStore";
import { startRun, type SequencerDeps } from "../sequencer/runner";
import type { Suite } from "../sequencer/types";

export interface JobContext {
  signal: AbortSignal;
  deadlineAt: number;
  checkPermission(): void;
  progress(phase: string): void;
}
export interface JobOutcome { state: "succeeded" | "failed" | "cancelled"; result: unknown }
export interface TaskAdapter {
  prepare(input: unknown): unknown;
  execute(prepared: unknown, context: JobContext): Promise<JobOutcome>;
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("validation_error");
  return v as Record<string, unknown>;
};
/** Check raw tree BEFORE normalizer can discard unknown/invalid steps. Stable IDs are local only. */
export function prepareSequence(input: unknown, run: boolean): Suite {
  const i = object(input);
  let raw: unknown = typeof i.json === "string" ? JSON.parse(i.json) : structuredClone(i.suite);
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new Error("validation_error");
    raw = raw[0];
  }
  const suite = object(raw);
  let count = 0;
  const walk = (steps: unknown, depth: number): unknown[] => {
    if (!Array.isArray(steps) || depth > 5) throw new Error("validation_error");
    return steps.map((rawStep) => {
      if (++count > 1000) throw new Error("validation_error");
      const s = object(rawStep);
      if (!["note", "wait", "waitForFrame", "assertVar", "group", "send"].includes(String(s.kind)) || (run && s.kind === "send")) {
        throw new Error("needs_manual_confirmation");
      }
      const out = { ...s, id: typeof s.id === "string" && s.id ? s.id : `job_step_${count}` };
      if (s.kind === "group") {
        if (depth > 4) throw new Error("validation_error");
        return { ...out, children: walk(s.children, depth + 1) };
      }
      return out;
    });
  };
  const steps = walk(suite.steps, 1);
  const normalized = normalizeSuite({ ...suite, id: suite.id || "job_suite", steps, trigger: { mode: "manual" } });
  if (!normalized) throw new Error("validation_error");
  const size = (list: Suite["steps"]): number => list.reduce((n, s) => n + 1 + (s.kind === "group" ? size(s.children) : 0), 0);
  if (size(normalized.steps) !== count) throw new Error("validation_error");
  return normalized;
}

export function sequenceAdapters(deps: SequencerDeps): ReadonlyMap<string, TaskAdapter> {
  return new Map<string, TaskAdapter>([
    ["sequence.validate", {
      prepare: (input) => prepareSequence(input, false),
      execute: async (prepared, ctx) => {
        ctx.checkPermission();
        if (ctx.signal.aborted) return { state: "cancelled", result: null };
        const suite = prepared as Suite;
        const classify = (steps: Suite["steps"]): boolean => steps.some((s) => s.kind === "send" || (s.kind === "group" && classify(s.children)));
        const needsApproval = classify(suite.steps);
        return { state: "succeeded", result: { version: 1, valid: true, suite, runCapability: needsApproval ? "needs_manual_confirmation" : "side_effect_free", deviceSendSupported: false } };
      },
    }],
    ["sequence.run", {
      prepare: (input) => prepareSequence(input, true),
      execute: async (prepared, ctx) => {
        ctx.checkPermission();
        if (ctx.signal.aborted || Date.now() >= ctx.deadlineAt) return { state: "cancelled", result: null };
        // Defense in depth: this task family has no send capability, even if a future parser regresses.
        const restricted: SequencerDeps = { ...deps, send: () => { throw new Error("needs_manual_confirmation"); }, resolveSend: () => null };
        const r = startRun(prepared as Suite, restricted, {
          onProgress: (p) => { if (p.status !== "finished") ctx.progress(p.currentStepId ? `step ${p.currentStepId}` : p.status); },
        });
        if (!r.ok) throw new Error(`busy: ${r.error}`);
        let stopped = false;
        const stop = () => { if (!stopped) { stopped = true; r.handle.stop(); } };
        ctx.signal.addEventListener("abort", stop, { once: true });
        if (ctx.signal.aborted) stop();
        const timer = setTimeout(stop, Math.max(0, ctx.deadlineAt - Date.now()));
        try {
          const result = await r.handle.done;
          return { state: result.status === "aborted" ? "cancelled" : result.status === "failed" ? "failed" : "succeeded", result: { version: 1, ...result } };
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", stop);
        }
      },
    }],
  ]);
}
