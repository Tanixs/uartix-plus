import { buildAnalysisSnapshot, type AnalysisSnapshot, type BuildAnalysisOptions } from "./analysisSnapshot";

export interface AnalysisState { result: AnalysisSnapshot | null; error: string | null }
let snapshot: AnalysisState = { result: null, error: null };
const listeners = new Set<() => void>();
export function getSnapshot(): AnalysisState { return snapshot; }
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function emit() { listeners.forEach((cb) => cb()); }
/** Only explicit user/action calls calculate. No timers, persistence, or acquisition gate. */
export function refreshAnalysis(options: BuildAnalysisOptions): AnalysisSnapshot | null {
  try {
    const result = buildAnalysisSnapshot(options);
    snapshot = { result, error: null };
    emit();
    return result;
  } catch (error) {
    snapshot = { result: null, error: error instanceof Error ? error.message : String(error) };
    emit();
    return null;
  }
}
export function clearAnalysis(): void { snapshot = { result: null, error: null }; emit(); }
export type AnalysisEventName = "vs-analysis-export" | "vs-analysis-ai";
/** Result-only payload, no raw buffers, group notes, paths or connection configuration.
 * This requests integration UI; it does not export data or initiate a network request.
 */
export function dispatchAnalysisEvent(name: AnalysisEventName, target: EventTarget = window): boolean {
  if (!snapshot.result) return false;
  return target.dispatchEvent(new CustomEvent<AnalysisSnapshot>(name, { detail: structuredClone(snapshot.result) }));
}
