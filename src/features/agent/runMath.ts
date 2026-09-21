/**
 * P99a-A5：通道统计与抽稀的取数小件。
 * 从 `agentAdapter` 里拆出来是为了让"本机九支工具"能待在模块级常量里（显示层要从 entry 派生），
 * 而显示层不能 import 适配器——那条边会绕成 agentAdapter→pluginStore→…→agentAdapter 的环（§8-33）。
 */
import * as plot from "../plot/plotStore";

/** 每通道统计（尾部窗口），供 plot_channels 回执。 */
export function channelStats(id: string) {
  const d = plot.getChanData(id);
  const n = d.v.length;
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const v = d.v[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    points: n,
    last: n ? d.v[n - 1] : null,
    min: n ? min : null,
    max: n ? max : null,
    sampleRate: plot.sampleRate(id),
  };
}

/** 等间隔抽稀（保首尾），供 plot_window 回执。 */
export function decimate(t: number[], v: number[], maxPoints: number): { t: number[]; v: number[] } {
  const n = t.length;
  if (n <= maxPoints) return { t: [...t], v: [...v] };
  const out = { t: [] as number[], v: [] as number[] };
  const step = (n - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    out.t.push(t[idx]);
    out.v.push(v[idx]);
  }
  return out;
}
