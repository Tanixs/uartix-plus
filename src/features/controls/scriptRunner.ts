let audioCtx: AudioContext | null = null;

export function beep(freq: number, durationMs: number): void {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = Math.max(20, Math.min(20000, freq));
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + Math.max(10, durationMs) / 1000);
  } catch {
    return;
  }
}

export interface ScriptApi {
  send: (text: string, mode?: "ascii" | "hex") => Promise<void>;
  beep: (freq: number, durationMs: number) => void;
  delay_ms: (ms: number) => Promise<void>;
  get: (name: string) => number | string | undefined;
}

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

export async function runScript(
  code: string,
  api: ScriptApi,
  vars: { name: string; value: number | string }[],
): Promise<void> {
  const names: string[] = [];
  const vals: unknown[] = [];
  for (const v of vars) {
    if (IDENT.test(v.name)) {
      names.push(v.name);
      vals.push(v.value);
    }
  }
  names.push("send", "beep", "delay_ms", "get");
  vals.push(api.send, api.beep, api.delay_ms, api.get);
  const AsyncFunctionCtor = Object.getPrototypeOf(async function () {
    return 0;
  }).constructor as {
    new (...args: string[]): (...args: unknown[]) => Promise<void>;
  };
  const fn = new AsyncFunctionCtor(...names, `"use strict";\n${code}`);
  await fn(...vals);
}
