import type { ControlCard } from "./controlsStore";
import { sanitizeManaged } from "./debugPreset";

export interface ControlReceipt {
  status: "blocked" | "completed" | "failed";
  role: string;
  reason: string;
}
export interface SessionActions {
  phase(): string;
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  annotate(text: string): Promise<boolean>;
}

export function managedActionReady(card: ControlCard, phase: string): boolean {
  const role = sanitizeManaged(card.managed)?.role;
  if (card.type !== "button") return false;
  return role === "record.start" ? phase === "idle"
    : role === "record.stop" || role === "annotate" ? phase === "recording" : false;
}

/** This adapter has no transport capability; device actions remain unconfigured. */
export async function executeManagedControl(card: ControlCard, session: SessionActions): Promise<ControlReceipt> {
  const role = sanitizeManaged(card.managed)?.role ?? "blocked";
  if (!managedActionReady(card, session.phase()))
    return { status: "blocked", role, reason: "unconfigured-or-session-state" };
  try {
    const ok = role === "record.start" ? await session.start()
      : role === "record.stop" ? await session.stop() : await session.annotate(card.name);
    return { status: ok ? "completed" : "failed", role, reason: ok ? "application-action" : "application-action-failed" };
  } catch {
    return { status: "failed", role, reason: "application-action-failed" };
  }
}

export function routeSliderValue(
  card: ControlCard,
  value: number,
  saveDraft: (value: number) => void,
  ordinarySend: () => void,
): void {
  saveDraft(value);
  if (card.managed !== undefined) return;
  ordinarySend();
}
