import type { AlertLevel } from "./sentinelEngine";

/**
 * 哨兵提示音（P62-S2）：Web Audio 合成，零音频资源文件。
 * crit=高音双短哔，warn=中音单短哔，recover=上行双柔音。
 * AudioContext 懒建；浏览器自动播放策略下需用户先有交互（失败静默，不影响报警链路）。
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

function beep(c: AudioContext, t0: number, freq: number, dur: number, gain: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 播报警提示音。kind=recover 走柔音；其余按 level（info 不响）；volume 0-100 */
export function playAlertTone(level: AlertLevel, recover: boolean, volume = 70): void {
  if (!recover && level === "info") return;
  const v = Math.max(0, Math.min(100, volume)) / 100;
  if (v <= 0) return;
  const c = ensureCtx();
  if (!c) return;
  const t = c.currentTime + 0.02;
  if (recover) {
    beep(c, t, 523, 0.14, 0.05 * v);
    beep(c, t + 0.13, 659, 0.18, 0.05 * v);
  } else if (level === "crit") {
    beep(c, t, 880, 0.12, 0.09 * v);
    beep(c, t + 0.16, 880, 0.12, 0.09 * v);
    beep(c, t + 0.34, 988, 0.16, 0.09 * v);
  } else {
    beep(c, t, 660, 0.16, 0.07 * v);
  }
}
