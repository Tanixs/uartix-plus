import type { AnalysisSnapshot } from "./analysisSnapshot";
import type { MetricRange } from "./metrics";

export interface ExportSelection {
  channelIds: string[];
  groupIds: string[];
  range: MetricRange | null;
}

export function initialExportSelection(
  snapshot: Pick<AnalysisSnapshot, "channels" | "trajectories" | "range" | "request"> | undefined,
  defaultChannelIds: string[],
  cacheRange: (channelIds: string[], groupIds: string[]) => MetricRange | null,
): ExportSelection {
  const channelIds = snapshot ? snapshot.request ? [...snapshot.request.channelIds] : snapshot.channels.map(c => c.id) : [...defaultChannelIds];
  const groupIds = snapshot ? snapshot.request ? [...snapshot.request.groupIds] : snapshot.trajectories.map(g => g.id) : [];
  // An empty frozen selection must never expand silently to the current cache.
  const range = snapshot ? snapshot.range : cacheRange(channelIds, groupIds);
  return { channelIds, groupIds, range: range ? { startMs: range.startMs, endMs: range.endMs } : null };
}
