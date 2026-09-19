/** Generic fenced executor transport; Rust owns all task states and admission. */
import { invoke } from "@tauri-apps/api/core";
import { sequenceAdapters, type TaskAdapter } from "./jobAdapters";
import { onFrames } from "../../ipc/framesBus";
import { getVar } from "../controls/variableStore";
import { getSnapshot as getSettings } from "../settings/settingsStore";

export interface Envelope {
  protocolVersion: 1; bridgeEpoch: number; executorEpoch: string;
  jobId: string; dispatchNonce: string; stateVersion: number;
}
export interface Dispatch { envelope: Envelope; taskType: string; input: unknown; deadlineAt: number; source?: string }
interface Reply { applied: boolean; terminal?: boolean; envelope?: Envelope }
export type Reporter = (report: { envelope: Envelope; kind: string; phase?: string; result?: unknown }) => Promise<Reply>;

export class JobExecutor {
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(private adapters: ReadonlyMap<string, TaskAdapter>, private report: Reporter, private permission: () => void) {}
  cancel(envelope: Envelope) { this.active.get(envelope.jobId)?.abort.abort(); }
  stopAll() { for (const job of this.active.values()) job.abort.abort(); }
  get size() { return this.active.size; }
  dispatch(d: Dispatch): Promise<void> {
    const existing = this.active.get(d.envelope.jobId);
    if (existing) return existing.done;
    const abort = new AbortController();
    const done = Promise.resolve().then(() => this.execute(d, abort)).finally(() => this.active.delete(d.envelope.jobId));
    this.active.set(d.envelope.jobId, { abort, done });
    return done;
  }
  private async execute(d: Dispatch, abort: AbortController) {
    let envelope = d.envelope;
    let chain = Promise.resolve(true);
    const send = (kind: string, fields: { phase?: string; result?: unknown } = {}) => {
      const next = chain.then(async () => {
        let reply = await this.report({ envelope, kind, ...fields });
        // Cancellation increments Rust's version. Rebase one receipt, never replay the business action.
        if (!reply.applied && reply.envelope && !reply.terminal) {
          envelope = reply.envelope;
          reply = await this.report({ envelope, kind, ...fields });
        }
        if (reply.envelope) envelope = reply.envelope;
        if (!reply.applied) abort.abort();
        return reply.applied;
      });
      chain = next.catch(() => { abort.abort(); return false; });
      return chain;
    };
    let started = false;
    // §6：来源由 Rust 宿主分配（MCP socket="mcp"，本机命令="local_agent"）。
    // 仅外部来源受 mcpEnabled 门控；本地 Agent 任务与 MCP 开关解耦。
    const external = (d.source ?? "mcp") !== "local_agent";
    const permission = external ? this.permission : () => {};
    try {
      permission();
      const adapter = this.adapters.get(d.taskType);
      if (!adapter) throw new Error("validation_error");
      const prepared = adapter.prepare(d.input);
      if (abort.signal.aborted || Date.now() >= d.deadlineAt) { await send("rejected"); return; }
      if (!await send("started")) return;
      started = true;
      permission();
      let lastProgress = 0;
      const outcome = await adapter.execute(prepared, {
        signal: abort.signal, deadlineAt: d.deadlineAt, checkPermission: permission,
        progress: (phase) => {
          if (Date.now() - lastProgress < 200 || abort.signal.aborted) return;
          lastProgress = Date.now(); void send("progress", { phase });
        },
      });
      // IPC payload is bounded too. Keep explicit availability instead of looping on an oversized receipt.
      const encoded = JSON.stringify(outcome.result);
      const result = new TextEncoder().encode(encoded).length > 1024 * 1024
        ? { version: 1, resultAvailability: "result_evicted", summary: "Result exceeded 1MiB" } : outcome.result;
      await send(outcome.state, { result });
    } catch (e) {
      await send(started ? "failed" : "rejected", { result: { error: String(e).slice(0, 300) } });
    }
  }
}

/** UI-facing mirror of the authoritative Rust registry (short snapshots only). */
export interface JobRow {
  jobId: string; taskType: string; state: string; phase: string; effectStatus: string;
  resultAvailability: string; createdAt: number; updatedAt: number; finishedAt?: number | null; stopReason: string | null; error: { code: string } | null;
}
const jobListeners = new Set<() => void>();
let jobSnap: { jobs: JobRow[] } = { jobs: [] };
function notifyJobs(rows: JobRow[]) {
  jobSnap = { jobs: rows };
  for (const l of jobListeners) l();
}
export const jobCenter = {
  subscribe(cb: () => void): () => void { jobListeners.add(cb); return () => { jobListeners.delete(cb); }; },
  getSnapshot(): { jobs: JobRow[] } { return jobSnap; },
  async refresh(): Promise<void> {
    try {
      const rows = await invoke<JobRow[]>("bridge_jobs_control", { kind: "list", args: {} });
      notifyJobs(Array.isArray(rows) ? rows : []);
    } catch { /* native bridge unavailable (browser preview) */ }
  },
  async cancel(jobId: string, reason: string): Promise<void> {
    try { await invoke("bridge_jobs_control", { kind: "cancel_job", args: { jobId, reason } }); } catch { /* stopped bridge */ }
    void jobCenter.refresh();
  },
};

let initialized = false;
/** 本地来源活动标记：Agent run 活动（或本地任务在册）时保持轮询，与 mcpEnabled 无关（§6）。 */
let localInterest = false;
export function setLocalJobInterest(on: boolean): void {
  localInterest = on;
}
export async function initJobExecutor(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const adapters = sequenceAdapters({
    send: () => { throw new Error("needs_manual_confirmation"); }, resolveSend: () => null,
    onFrames: (cb) => onFrames((p) => cb(p.rows)), getVar, now: Date.now,
  });
  const executor = new JobExecutor(adapters, (report) => invoke("bridge_jobs_report", { report }), () => {
    if (!getSettings().mcpEnabled) throw new Error("permission_denied");
  });
  try {
    const epoch = await invoke<string>("bridge_jobs_register");
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        if (getSettings().mcpEnabled || localInterest || executor.size > 0) {
          const p = await invoke<{ dispatches?: Dispatch[]; cancels?: Envelope[]; error?: unknown }>("bridge_jobs_poll", { executorEpoch: epoch });
          if (p.error) { executor.stopAll(); closed = true; return; }
          for (const e of p.cancels ?? []) executor.cancel(e);
          for (const d of p.dispatches ?? []) void executor.dispatch(d);
        }
      } catch { executor.stopAll(); }
      finally { if (!closed) timer = setTimeout(() => void poll(), 200); }
    };
    const uiTimer = setInterval(() => void jobCenter.refresh(), 2000);
    window.addEventListener("beforeunload", () => {
      closed = true; clearTimeout(timer); clearInterval(uiTimer); executor.stopAll();
      void invoke("bridge_jobs_control", { kind: "quiesce", args: { reason: "app_exit" } });
    }, { once: true });
    void poll();
    void jobCenter.refresh();
  } catch { initialized = false; /* Browser-only preview has no native bridge. */ }
}
