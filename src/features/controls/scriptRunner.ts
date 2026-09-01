import type { FramesEventPayload } from "../../ipc/types";
import { onFrames } from "../../ipc/framesBus";
import * as variableStore from "./variableStore";
import * as controlsStore from "./controlsStore";

let audioCtx: AudioContext | null = null;

export function beep(freq: number, durationMs: number, volume = 0.08): void {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = Math.max(20, Math.min(20000, freq));
    gain.gain.value = Math.max(0, Math.min(1, volume));
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

/* ---------- 内置扩展 API（无需调用方注入） ---------- */

async function builtinLog(text: unknown): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("script:log", { text: String(text) });
}

let watchInit = false;
const latestVals = new Map<string, number | string>();

async function ensureWatch(): Promise<void> {
  if (watchInit) return;
  watchInit = true;
  onFrames((p: FramesEventPayload) => {
    for (const row of p.rows) {
      if (!row.valid) continue;
      for (const f of row.fields) {
        latestVals.set(f.name, f.text ?? f.value);
      }
    }
  });
}

async function builtinWaitParse(
  fieldName: string,
  timeoutMs = 5000,
): Promise<number | string> {
  await ensureWatch();
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const v = latestVals.get(fieldName);
    if (v !== undefined) return v;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitParse: 等待字段「${fieldName}」超时（${timeoutMs}ms 内未解析到）`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function builtinSet(name: string, value: number | string): void {
  variableStore.setVar(name, value);
}

function builtinSetControl(name: string, value: number): void {
  const found = controlsStore.findCardByName(name);
  if (!found) throw new Error(`setControl: 找不到控件「${name}」`);
  // 通过事件桥交给控制画布按控件类型真正触发（按钮发送/开关切档/滑条设值/键盘遥控方向）
  window.dispatchEvent(
    new CustomEvent("vs-control-trigger", {
      detail: { cardId: found.card.id, value },
    }),
  );
}

async function builtinRepeat(
  n: number,
  fn: (i: number) => void | Promise<void>,
): Promise<void> {
  const times = Math.max(0, Math.min(100000, Math.round(n)));
  for (let i = 0; i < times; i++) {
    await fn(i);
  }
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
  names.push(
    "send",
    "beep",
    "delay_ms",
    "get",
    "set",
    "log",
    "waitParse",
    "setControl",
    "repeat",
  );
  vals.push(
    api.send,
    api.beep,
    api.delay_ms,
    api.get,
    builtinSet,
    builtinLog,
    builtinWaitParse,
    builtinSetControl,
    builtinRepeat,
  );
  const AsyncFunctionCtor = Object.getPrototypeOf(async function () {
    return 0;
  }).constructor as {
    new (...args: string[]): (...args: unknown[]) => Promise<void>;
  };
  const fn = new AsyncFunctionCtor(...names, `"use strict";\n${code}`);
  await fn(...vals);
}
