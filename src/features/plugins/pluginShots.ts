import { SHOTS_MAX } from "./pluginManifest";

export function appendShots(
  current: readonly string[],
  added: readonly string[],
  max = SHOTS_MAX,
): { next: string[]; dropped: number } {
  const room = Math.max(0, max - current.length);
  const take = added.slice(0, room);
  return { next: [...current, ...take], dropped: added.length - take.length };
}

export function removeShot(current: readonly string[], index: number): string[] {
  if (index < 0 || index >= current.length) return [...current];
  return current.filter((_, i) => i !== index);
}
