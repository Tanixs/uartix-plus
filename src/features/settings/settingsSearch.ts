import { SETTINGS_SCHEMA } from "./settingsSchema";

export interface SettingsTabLike {
  key: string;
  label: string;
  group: string;
  sub?: string;
}

export interface SettingsSearchHit {
  kind: "tab" | "setting";
  tab: string;
  label: string;
  hint: string;
  key?: string;
}

const GROUP_TAB: Record<string, string> = {
  appearance: "appearance",
  layout: "workspace",
  ai: "ai",
  behavior: "general",
  mcp: "mcp",
};

export function searchSettings(
  query: string,
  tabs: readonly SettingsTabLike[],
  limit = 14,
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const tabLabels = new Map(tabs.map((t) => [t.key, t.label]));
  const scored: { hit: SettingsSearchHit; rank: number }[] = [];

  for (const t of tabs) {
    const hay = `${t.label} ${t.group} ${t.sub ?? ""} ${t.key}`.toLowerCase();
    if (!hay.includes(q)) continue;
    scored.push({
      hit: { kind: "tab", tab: t.key, label: t.label, hint: t.group },
      rank: t.label.toLowerCase().startsWith(q) ? 0 : 2,
    });
  }

  for (const e of SETTINGS_SCHEMA) {
    const tab = GROUP_TAB[e.group];
    if (!tab || !tabLabels.has(tab)) continue;
    if (!e.label.toLowerCase().includes(q)) continue;
    scored.push({
      hit: {
        kind: "setting",
        tab,
        label: e.label,
        hint: tabLabels.get(tab) ?? tab,
        key: String(e.key),
      },
      rank: e.label.toLowerCase().startsWith(q) ? 1 : 3,
    });
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((x) => x.hit);
}
