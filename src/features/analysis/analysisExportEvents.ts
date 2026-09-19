import type { AnalysisSnapshot } from "./analysisSnapshot";

export function subscribeAnalysisExport(
  open: (snapshot: AnalysisSnapshot | undefined) => void,
  target: EventTarget = window,
): () => void {
  const listener = (event: Event) => open((event as CustomEvent<AnalysisSnapshot>).detail);
  target.addEventListener("vs-analysis-export", listener);
  return () => target.removeEventListener("vs-analysis-export", listener);
}
