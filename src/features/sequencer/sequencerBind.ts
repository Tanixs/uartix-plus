/**
 * 序列器与外部世界的接线层（T3）。
 *
 * 职责（且仅此四件）：
 * 1. SequencerDeps 的 Tauri 实现（发送 / cmdId·工厂解析 / 帧流 / 变量 / 时钟）；
 * 2. 运行进度的单点广播（面板订阅渲染；引擎互斥在 runner，这里不重复）；
 * 3. 「帧触发」套件的自动启动（防重入 + 冷却）；
 * 4. 面板生命周期：关闭「测试序列器」面板 → 停止运行（用户红线：关掉的面板
 *    绝不允许在后台继续发包）。帧触发同样只在面板打开时生效。
 *
 * 模块级单例、首次 import 即生效；CLI（T5）不走这里，直接用自己的 deps 调 runner。
 */

import * as runner from "./runner";
import type { RunProgress, SendPayload, Suite } from "./types";
import { onFrames } from "../../ipc/framesBus";
import * as panelActivity from "../../panels/panelActivity";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "../controls/variableStore";
import * as commandStore from "../controls/commandStore";
import { CODECS, userCodecToCodec, type Codec } from "../console/commandFactory";
import * as userCodecStore from "../console/userCodecStore";
import * as sequencerStore from "./sequencerStore";

const PANEL_ID = "sequencer";

function codecById(id: string): Codec | undefined {
  const builtIn = CODECS.find((c) => c.id === id);
  if (builtIn) return builtIn;
  const def = userCodecStore.getById(id.startsWith("user:") ? id.slice(5) : id);
  return def ? userCodecToCodec(def) : undefined;
}

/** 载荷 → 实际发送内容。null = 解析失败（引擎记 fail） */
function resolveSend(payload: SendPayload): { mode: "ascii" | "hex"; text: string } | null {
  if (payload.type === "hex") {
    return payload.text.trim() ? { mode: "hex", text: payload.text } : null;
  }
  if (payload.type === "ascii") {
    // 转义与快捷栏同语义：\r \n \t \\ \xNN；原文 UTF-8 直发
    return payload.text ? { mode: "ascii", text: payload.text } : null;
  }
  if (payload.type === "cmd") {
    const item = commandStore.getCommand(payload.cmdId);
    if (!item || !item.template.trim()) return null;
    // 变量占位 {var} 与控制画布同语义；脚本命令暂不支持（v2：经 scriptRunner 执行）
    return { mode: item.sendMode, text: variableStore.resolveVars(item.template) };
  }
  // factory：单帧直接组帧发送；多帧需逐步骤表达（v2 评估 sendFrames 步骤）
  try {
    const spec = payload.spec as { codecId?: string; vals?: Record<string, string> } | undefined;
    if (!spec?.codecId) return null;
    const codec = codecById(spec.codecId);
    if (!codec) return null;
    const r = codec.build(spec.vals ?? {});
    if (r.frames.length !== 1 || !r.frames[0].trim()) return null;
    return { mode: "hex", text: r.frames[0] };
  } catch {
    return null;
  }
}

export const deps: runner.SequencerDeps = {
  send: async (mode, text) => {
    await serialStore.sendData(mode, text);
  },
  resolveSend,
  onFrames: (cb) => onFrames((p) => cb(p.rows)),
  getVar: (name) => variableStore.getVar(name),
  now: () => Date.now(),
};

/* ================= 运行进度广播 ================= */

let progress: RunProgress | null = null;
const runListeners = new Set<() => void>();

export function subscribeRun(cb: () => void): () => void {
  runListeners.add(cb);
  return () => {
    runListeners.delete(cb);
  };
}

export function getRunProgress(): RunProgress | null {
  return progress;
}

function setProgress(p: RunProgress) {
  progress = p;
  runListeners.forEach((l) => l());
}

/** 当前是否有运行（供 UI 判运行态；与 runner.isRunning 同步随进度事件刷新） */
export function isRunning(): boolean {
  return runner.isRunning();
}

/** 启动套件。返回 null = 成功启动；否则为拒绝原因（互斥等） */
export function startSuite(suite: Suite, opts: { stepMode?: boolean } = {}): string | null {
  const r = runner.startRun(suite, deps, {
    ...opts,
    onProgress: setProgress,
  });
  return r.ok ? null : r.error;
}

export function stopSuite(): void {
  runner.stopRun();
}

/** 单步模式放行下一步 */
export function resumeSuite(): void {
  runner.resumeRun();
}

/* ================= 面板生命周期 ================= */

// 关闭面板 → 停止运行 + 停触发（红线：关掉的面板不允许后台发包）
panelActivity.subscribe(() => {
  if (!panelActivity.isOpen(PANEL_ID)) runner.stopRun();
});

/* ================= 帧触发 ================= */

const lastFire = new Map<string, number>();

onFrames((p) => {
  if (!panelActivity.isOpen(PANEL_ID)) return;
  if (runner.isRunning()) return; // 防重入：运行中忽略触发
  const rows = p.rows;
  if (!rows.length) return;
  for (const s of sequencerStore.getSnapshot().suites) {
    const trig = s.trigger; // 属性路径收窄不保留进闭包，提为 const
    if (trig.mode !== "onFrame") continue;
    if (!s.steps.length) continue;
    const hit = rows.some(
      (row) => row.valid && runner.testFrameMatch(row, trig.match, deps.getVar),
    );
    if (!hit) continue;
    const now = Date.now();
    if (now - (lastFire.get(s.id) ?? 0) < trig.cooldownMs) continue;
    lastFire.set(s.id, now);
    startSuite(s);
    break; // 互斥：一帧至多拉起一个序列
  }
});
