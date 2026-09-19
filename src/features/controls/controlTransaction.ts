/** Pure, foreground local-simulation core. No device adapter or approval authority.
 * The host must supply a known local simulator; this API does not authorize hardware.
 */
export interface ParameterStep {
  id: string;
  value: number;
  feedback?: {
    tplId: string;
    fieldId: string;
    tolerance: number;
    holdMs: number;
    maxGapMs: number;
    timeoutMs: number;
  };
}

/** sequence increases within a generation; receivedAt uses the injected clock domain.
 * subscribeObservations must report fresh arrivals, not replay a cached value as new.
 */
export interface ParameterObservation {
  tplId: string;
  fieldId: string;
  value: number;
  sequence: number;
  receivedAt: number;
  generation: number;
}

export type TransactionStatus = "idle" | "sending" | "sent" | "settling" | "verified"
  | "failed" | "timeout" | "unknown" | "cancelled";
export interface ParameterStepResult {
  step: ParameterStep;
  status: TransactionStatus;
  startedAt?: number;
  finishedAt?: number;
  observation?: ParameterObservation;
  reason?: string;
}
export interface TransactionSnapshot {
  id: number;
  generation: number;
  status: TransactionStatus;
  active: boolean;
  startedAt?: number;
  finishedAt?: number;
  steps: ParameterStepResult[];
}
export interface ControlTransactionOptions {
  send(step: ParameterStep): Promise<void>;
  subscribeObservations(listener: (event: ParameterObservation) => void): () => void;
  getGeneration(): number;
  now?: () => number;
  /** Includes send time. Default 5 minutes, never greater than 5 minutes. */
  totalTimeoutMs?: number;
  /** Used for steps without feedback. Default 60 seconds. */
  sendTimeoutMs?: number;
}

const MAX_TOTAL_MS = 300_000;
const MAX_STEP_MS = 60_000;
const copyStep = (step: ParameterStep): ParameterStep => ({
  id: step.id, value: step.value,
  ...(step.feedback ? { feedback: { ...step.feedback } } : {}),
});
const copySnapshot = (s: TransactionSnapshot): TransactionSnapshot => ({
  ...s, steps: s.steps.map(r => ({ ...r, step: copyStep(r.step),
    ...(r.observation ? { observation: { ...r.observation } } : {}) })),
});
const validDuration = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;

/** One runner per simulation target. Never retries or rolls back effects.
 * start rejects invalid/busy plans synchronously, otherwise resolves a terminal receipt.
 * stop releases observation/timers immediately; an unresolved send remains unknown and
 * blocks a new start until its Promise settles. Rejection means a definite local send
 * failure; adapters with ambiguous delivery must not use this simulator-only contract.
 */
export class ControlTransactionRunner {
  private readonly now: () => number;
  private readonly totalTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private snapshot: TransactionSnapshot = { id: 0, generation: 0, status: "idle", active: false, steps: [] };
  private history: TransactionSnapshot[] = [];
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private totalTimer?: ReturnType<typeof setTimeout>;
  private stepTimer?: ReturnType<typeof setTimeout>;
  private watchTimer?: ReturnType<typeof setInterval>;
  private resolve?: (snapshot: TransactionSnapshot) => void;
  private index = 0;
  private sending = false;
  private armed = false;
  private lastSequence = -1;
  private lastReceivedAt = -Infinity;
  private stableSince?: number;
  private stableLast?: number;
  private qualified = false;
  private deadline = Infinity;
  private totalDeadline = Infinity;

  constructor(private readonly options: ControlTransactionOptions) {
    this.now = options.now ?? (() => performance.now());
    this.totalTimeoutMs = options.totalTimeoutMs ?? MAX_TOTAL_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? MAX_STEP_MS;
    if (!validDuration(this.totalTimeoutMs, 100, MAX_TOTAL_MS)
      || !validDuration(this.sendTimeoutMs, 100, MAX_STEP_MS)) throw new Error("Invalid transaction timeout");
  }

  getSnapshot = (): TransactionSnapshot => copySnapshot(this.snapshot);
  getHistory = (): TransactionSnapshot[] => this.history.map(copySnapshot);
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(steps: readonly ParameterStep[], generation = this.options.getGeneration()): Promise<TransactionSnapshot> {
    if (this.snapshot.active || this.sending) throw new Error("Transaction runner is busy");
    if (!Number.isSafeInteger(generation) || generation < 0 || generation !== this.options.getGeneration())
      throw new Error("Target generation is invalid or changed");
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 32) throw new Error("Expected 1–32 steps");
    const ids = new Set<string>();
    for (const step of steps) {
      if (!step || typeof step.id !== "string" || !step.id.trim() || step.id.length > 128
        || ids.has(step.id) || !Number.isFinite(step.value)) throw new Error("Invalid parameter step");
      ids.add(step.id);
      const f = step.feedback;
      if (f && (typeof f.tplId !== "string" || !f.tplId.trim() || f.tplId.length > 128
        || typeof f.fieldId !== "string" || !f.fieldId.trim() || f.fieldId.length > 128
        || !validDuration(f.timeoutMs, 100, MAX_STEP_MS)
        || !validDuration(f.holdMs, 0, f.timeoutMs)
        || !Number.isFinite(f.maxGapMs) || f.maxGapMs <= 0
        || !Number.isFinite(f.tolerance) || f.tolerance < 0)) throw new Error("Invalid feedback specification");
    }
    const startedAt = this.now();
    this.snapshot = { id: this.snapshot.id + 1, generation, status: "idle", active: true, startedAt,
      steps: steps.map(step => ({ step: copyStep(step), status: "idle" })) };
    this.index = 0;
    this.lastSequence = -1;
    this.lastReceivedAt = -Infinity;
    this.totalDeadline = startedAt + this.totalTimeoutMs;
    const result = new Promise<TransactionSnapshot>(resolve => { this.resolve = resolve; });
    this.totalTimer = setTimeout(() => this.expire("Total transaction deadline exceeded"), this.totalTimeoutMs);
    // Detect target invalidation even when the simulator emits nothing.
    this.watchTimer = setInterval(() => {
      if (!this.check()) return;
      if (this.stableLast !== undefined && this.now() - this.stableLast > this.current().step.feedback!.maxGapMs) {
        this.resetStability();
        if (!this.sending) this.setStatus("sent");
      }
    }, 25);
    this.beginStep();
    return result;
  }

  stop(reason = "Stopped locally; no device effects were undone"): void {
    if (!this.snapshot.active) return;
    this.finish(this.sending ? "unknown" : "cancelled", reason);
  }

  private current(): ParameterStepResult { return this.snapshot.steps[this.index]; }
  private publish(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Presentation errors cannot interrupt execution/cleanup. */ }
    }
  }
  private setStatus(status: TransactionStatus): void {
    this.current().status = status;
    this.snapshot.status = status;
    this.publish();
  }
  private resetStability(): void {
    this.stableSince = undefined;
    this.stableLast = undefined;
    this.qualified = false;
  }
  private releaseObserver(): void {
    this.armed = false;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    try { unsubscribe?.(); } catch { /* Always complete the remaining lifecycle cleanup. */ }
    clearTimeout(this.stepTimer);
    this.stepTimer = undefined;
  }
  private check(): boolean {
    if (!this.snapshot.active) return false;
    let generation: number;
    try { generation = this.options.getGeneration(); }
    catch { this.finish("unknown", "Target generation unavailable"); return false; }
    if (generation !== this.snapshot.generation) {
      this.finish(this.current().startedAt === undefined ? "cancelled" : "unknown", "Target generation changed");
      return false;
    }
    if (this.now() >= Math.min(this.deadline, this.totalDeadline)) {
      this.expire("Transaction deadline exceeded");
      return false;
    }
    return true;
  }
  private expire(reason: string): void {
    if (this.snapshot.active) this.finish(this.sending ? "unknown" : "timeout", reason);
  }

  private beginStep(): void {
    this.deadline = Infinity;
    if (!this.check()) return;
    this.resetStability();
    const runId = this.snapshot.id;
    const index = this.index;
    const isCurrent = () => this.snapshot.active && this.snapshot.id === runId && this.index === index;
    try {
      // Synchronous cache replay during subscription only establishes the sequence barrier.
      const unsubscribe = this.options.subscribeObservations(event => {
        if (isCurrent()) this.observe(event);
      });
      if (!isCurrent()) { unsubscribe(); return; }
      this.unsubscribe = unsubscribe;
    } catch {
      this.finish("failed", "Observation subscription failed");
      return;
    }
    if (!this.check()) return;
    const r = this.current();
    r.startedAt = this.now();
    this.deadline = r.startedAt + (r.step.feedback?.timeoutMs ?? this.sendTimeoutMs);
    this.stepTimer = setTimeout(() => this.expire("Step deadline exceeded"), this.deadline - this.now());
    // Publish before invoking transport so a synchronous stop still prevents dispatch.
    this.setStatus("sending");
    if (!isCurrent() || !this.check()) return;
    this.armed = true;
    this.sending = true;
    let promise: Promise<void>;
    try { promise = this.options.send(copyStep(r.step)); }
    catch (error) { promise = Promise.reject(error); }
    Promise.resolve(promise).then(() => {
      this.sending = false;
      if (!isCurrent() || !this.check()) return;
      if (!r.step.feedback) { this.finish("sent", "Sent without feedback; remaining steps cancelled as unverified"); return; }
      if (this.stableLast !== undefined && this.now() - this.stableLast > r.step.feedback.maxGapMs) this.resetStability();
      if (this.qualified) { this.verify(); return; }
      this.setStatus(this.stableSince === undefined ? "sent" : "settling");
    }, () => {
      this.sending = false;
      if (isCurrent() && this.check()) this.finish("failed", "Local simulation transport rejected send");
    });
  }

  private observe(event: ParameterObservation): void {
    if (!this.check() || event.generation !== this.snapshot.generation
      || !Number.isSafeInteger(event.sequence) || event.sequence < 0
      || !Number.isFinite(event.receivedAt) || event.receivedAt > this.now()
      || !Number.isFinite(event.value)) return;
    if (!this.armed) {
      this.lastSequence = Math.max(this.lastSequence, event.sequence);
      return;
    }
    const r = this.current();
    const f = r.step.feedback;
    if (!f || event.tplId !== f.tplId || event.fieldId !== f.fieldId
      || event.sequence <= this.lastSequence || event.receivedAt < this.lastReceivedAt
      || event.receivedAt < r.startedAt! || this.now() - event.receivedAt > f.maxGapMs) return;
    this.lastSequence = event.sequence;
    this.lastReceivedAt = event.receivedAt;
    r.observation = { ...event };
    if (Math.abs(event.value - r.step.value) > f.tolerance) {
      this.resetStability();
      if (!this.sending) this.setStatus("sent");
      return;
    }
    if (this.stableLast === undefined || event.receivedAt - this.stableLast > f.maxGapMs)
      this.stableSince = event.receivedAt;
    this.stableLast = event.receivedAt;
    this.qualified = event.receivedAt - this.stableSince! >= f.holdMs;
    // Never verify solely because a timer elapsed; a new matching frame must prove hold.
    if (!this.sending) {
      if (this.qualified) this.verify();
      else this.setStatus("settling");
    }
  }

  private verify(): void {
    const r = this.current();
    r.status = "verified";
    r.finishedAt = this.now();
    this.releaseObserver();
    if (this.index === this.snapshot.steps.length - 1) { this.finish("verified"); return; }
    this.snapshot.status = "verified";
    this.publish();
    if (!this.snapshot.active) return;
    this.index++;
    this.beginStep();
  }

  private finish(status: TransactionStatus, reason?: string): void {
    if (!this.snapshot.active) return;
    const finishedAt = this.now();
    const r = this.current();
    // A stop called by a subscriber at a step boundary must preserve verified evidence.
    if (r.status !== "verified") Object.assign(r, { status, reason, finishedAt });
    for (let i = this.index + 1; i < this.snapshot.steps.length; i++)
      Object.assign(this.snapshot.steps[i], { status: "cancelled", reason: "Prior step did not permit continuation", finishedAt });
    Object.assign(this.snapshot, { status, active: false, finishedAt });
    this.releaseObserver();
    clearTimeout(this.totalTimer);
    clearInterval(this.watchTimer);
    this.totalTimer = undefined;
    this.watchTimer = undefined;
    this.history.push(copySnapshot(this.snapshot));
    if (this.history.length > 50) this.history.shift();
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(this.getSnapshot());
    this.publish();
  }
}
