import type { InstalledPlugin } from "./pluginEngine";

/** 旧插件库搜索框的同一套匹配：名称 / id / 描述，空查询全过。 */
export function pluginMatches(
  p: InstalledPlugin,
  q: string,
  meta?: { name?: string; description?: string },
): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return (
    (meta?.name || p.manifest.name).toLowerCase().includes(t) ||
    p.id.toLowerCase().includes(t) ||
    (meta?.description || p.manifest.description || "").toLowerCase().includes(t)
  );
}
