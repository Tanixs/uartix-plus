import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { AnnOut, SessionMeta, SessionPhase, SessionStatus } from "../../ipc/types";
import * as templateStore from "../protocol/templateStore";
import * as serialStore from "../serial/serialStore";
import { toast } from "../ai/extRuntime";
import { tx } from "../../i18n/strings";

/**
 * 会话录制回放（HANDOFF 十六 16.2 / P1）前端状态机：
 * idle → recording → recorded → playing/paused → idle。会话态不持久化。
 * Rust 侧为权威状态源（session.rs），本 store 只做镜像 + 命令转发；
 * 回放进度由 Rust 线程 10Hz `session:progress` 事件推送。
 */

export interface SessionSnapshot {
  state: SessionPhase;
  frameCount: number;
  durationMs: number;
  posMs: number;
  fileName: string;
  /** 最近一次打开/录制完成的会话 meta（展示用） */
  meta: SessionMeta | null;
  /** 桥接服务端（P3a 虚拟设备）：None = 未开桥 */
  bridgeListening: boolean;
  bridgePort: number;
  bridgeClients: number;
  /** 时间线首/末事件 ts（标注跳转 ratio 换算用） */
  firstTs: number;
  lastTs: number;
}

let snap: SessionSnapshot = {
  state: "idle",
  frameCount: 0,
  durationMs: 0,
  posMs: 0,
  fileName: "",
  meta: null,
  bridgeListening: false,
  bridgePort: 0,
  bridgeClients: 0,
  firstTs: 0,
  lastTs: 0,
};

/** 标注独立快照：仅标注变化时替换引用（Plot2D 等叶子订阅不受 10Hz posMs 刷新惊动） */
let annSnap: AnnOut[] = [];

export function getAnnotations(): AnnOut[] {
  return annSnap;
}

const listeners = new Set<() => void>();
let inited = false;

function set(patch: Partial<SessionSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  return snap;
}

/** 回放中（含暂停）——frameStore 归档门控据此放宽（回放中始终归档） */
export function isReplaying() {
  return snap.state === "playing" || snap.state === "paused";
}

export function isRecording() {
  return snap.state === "recording";
}

async function refresh() {
  try {
    const st = await invoke<SessionStatus>("session_status");
    set({
      state: st.state,
      frameCount: st.frameCount,
      durationMs: st.durationMs,
      posMs: st.posMs,
      fileName: st.fileName,
      bridgeListening: st.bridgeListening,
      bridgePort: st.bridgePort,
      bridgeClients: st.bridgeClients,
      firstTs: st.firstTs,
      lastTs: st.lastTs,
    });
  } catch {
    /* Rust 侧尚未就绪（启动间隙）——忽略 */
  }
}

export function init() {
  if (inited) return;
  inited = true;
  // 回放进度：10Hz 低频推送，只更新 posMs（叶子组件订阅，不惊动全局）
  void listen<{ posMs: number; frameIdx: number }>("session:progress", (e) => {
    set({ posMs: e.payload.posMs });
  });
  // 录制触顶护栏：Rust 已自动停止，这里提示 + 刷新状态
  void listen("session:autostop", () => {
    toast(
      tx(
        "录制已达上限（2M 帧/512MB），已自动停止",
        "Recording hit the cap (2M frames/512MB), auto-stopped",
      ),
    );
    void refresh();
  });
  void listen("session:ended", () => {
    void refresh();
  });
  // 桥接状态（P3a）：开/关/客户端连入/断连剔除时 Rust 推送
  void listen<{ listening: boolean; port: number; clients: number }>(
    "session:bridge",
    (e) => {
      set({
        bridgeListening: e.payload.listening,
        bridgePort: e.payload.port,
        bridgeClients: e.payload.clients,
      });
    },
  );
  // 标注（P3b）：事件全量推送（annotate/open/start/discard 等所有变化点）
  void listen<AnnOut[]>("session:annotations", (e) => {
    annSnap = e.payload;
    listeners.forEach((l) => l());
  });
  // init 对账：拉一次当前标注（覆盖页面刷新后事件已过窗口的情况）
  void invoke<AnnOut[]>("session_annotations")
    .then((list) => {
      annSnap = list;
      listeners.forEach((l) => l());
    })
    .catch(() => {});
  // 录制时长秒表：仅录制中轮询（1Hz）
  window.setInterval(() => {
    if (snap.state === "recording") void refresh();
  }, 1000);
  void refresh();
}

export function fmtDur(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------- 录制 ----------

export async function startRecord() {
  try {
    // 端口来源快照（仅展示）：串口 / 网络 / 演示源
    let demo = false;
    try {
      demo = await invoke<boolean>("demo_running");
    } catch {
      demo = false;
    }
    const s = serialStore.getSnapshot();
    const port =
      s.status === "connected"
        ? s.iface === "serial"
          ? { kind: "serial", portName: s.config.port, baud: s.config.baud }
          : { kind: s.iface, portName: s.portName, baud: null }
        : demo
          ? { kind: "demo", portName: null, baud: null }
          : { kind: "unknown", portName: null, baud: null };
    await invoke("session_start_record", {
      rules: templateStore.getSnapshot().rules,
      port,
    });
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

export async function stopRecord() {
  try {
    await invoke("session_stop_record");
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

// ---------- 会话文件 ----------

export async function saveSession(): Promise<boolean> {
  const path = await saveDialog({
    title: tx("保存会话录制", "Save session recording"),
    filters: [
      { name: tx("会话录制 (*.usess)", "Session recording (*.usess)"), extensions: ["usess"] },
    ],
  });
  if (!path) return false;
  try {
    await invoke("session_save", { path });
    await refresh();
    toast(tx("会话已保存", "Session saved"));
    return true;
  } catch (e) {
    toast(String(e));
    return false;
  }
}

export async function discardSession() {
  try {
    await invoke("session_discard");
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

export async function openSession(): Promise<boolean> {
  // 防呆：有未保存的内存录制时打开新文件会丢弃它
  if (snap.state === "recorded" && !snap.fileName) {
    if (
      !window.confirm(
        tx(
          "有未保存的录制，打开新会话将丢弃它，继续？",
          "Unsaved recording will be discarded. Continue?",
        ),
      )
    ) {
      return false;
    }
  }
  const path = await openDialog({
    multiple: false,
    title: tx("打开会话录制", "Open session recording"),
    filters: [
      { name: tx("会话录制 (*.usess)", "Session recording (*.usess)"), extensions: ["usess"] },
    ],
  });
  if (typeof path !== "string") return false;
  try {
    const meta = await invoke<SessionMeta>("session_open", { path });
    await refresh();
    toast(
      tx(
        `已加载会话「${snap.fileName}」：${snap.frameCount} 帧 · ${fmtDur(snap.durationMs)}`,
        `Session "${snap.fileName}" loaded: ${snap.frameCount} frames · ${fmtDur(snap.durationMs)}`,
      ),
    );
    // 模板快照防呆（16.2）：按模板名 diff，会话内嵌模板本地缺失时 confirm 导入副本。
    // importTemplates 只追加不覆盖（重名自动 (n) 后缀）；副本保留原 id，回放帧按 tpl_id 对应。
    const names = new Set(templateStore.getSnapshot().rules.templates.map((t) => t.name));
    const missing = (meta.tplRules?.templates ?? []).filter((t) => !names.has(t.name));
    if (missing.length > 0) {
      if (
        window.confirm(
          tx(
            `会话内含 ${missing.length} 个当前缺失的模板，导入副本？（不覆盖现有协议）`,
            `Session contains ${missing.length} templates missing locally. Import as copies? (existing protocols are never overwritten)`,
          ),
        )
      ) {
        templateStore.importTemplates(missing);
        toast(
          tx(
            `已导入 ${missing.length} 个模板副本，可回放完整解析`,
            `Imported ${missing.length} template copies for full replay parsing`,
          ),
        );
      }
    }
    return true;
  } catch (e) {
    toast(String(e));
    return false;
  }
}

// ---------- 回放 ----------

/**
 * 开始回放。前端预检串口连接（最常见冲突，Rust 侧对演示源/网络二次把关）。
 * speed：1 = 1× 节奏回放；0 = 去节奏全速回放。
 */
export async function play(speed: number) {
  const s = serialStore.getSnapshot();
  if (s.status !== "disconnected") {
    toast(
      tx(
        "回放前请先断开连接（避免双源混淆）",
        "Disconnect before replay (avoid mixed sources)",
      ),
    );
    return;
  }
  try {
    if (await invoke<boolean>("demo_running")) {
      toast(tx("回放前请先停止演示数据源", "Stop the demo source before replay"));
      return;
    }
  } catch {
    /* 忽略查询失败，Rust 侧仍会把关 */
  }
  try {
    await invoke("session_play", { speed });
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

export async function pause() {
  try {
    await invoke("session_pause");
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

export async function resume() {
  try {
    await invoke("session_resume");
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

export async function stopPlay() {
  try {
    await invoke("session_stop");
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

// ---------- 桥接（P3a 虚拟设备） ----------

/**
 * 开桥：Rust 监听端口，外部上位机/调试工具连入即当「真机」收数据流。
 * 先开桥等客户端、再点播放是自然流程；停止回放时 Rust 自动关桥。
 * port ≤ 0 或 >65535 由 Rust 校验（bind 失败报友好错误）。
 */
export async function bridgeStart(port: number) {
  try {
    await invoke("session_bridge_start", { port });
    await refresh();
    toast(tx(`桥接已开启 :${port}，可连入后开始回放`, `Bridge listening on :${port} — connect then start replay`));
  } catch (e) {
    toast(String(e));
  }
}

export async function bridgeStop() {
  try {
    await invoke("session_bridge_stop");
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}

// ---------- 标注（P3b 时间轴标注） ----------

/**
 * 打标注（录制中/回放中均可；Rust 侧锚定 ts：录制=起始+经过，回放=first+pos）。
 * 空文本直接忽略；成功后列表由 session:annotations 事件全量推送更新。
 */
export async function annotate(text: string) {
  if (!text.trim()) return;
  try {
    await invoke("session_annotate", { text });
  } catch (e) {
    toast(String(e));
  }
}

/** 标注 ts → seek 比例（时间线外钳制到 [0,1]） */
export function annotationRatio(ts: number): number {
  const span = snap.lastTs - snap.firstTs;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (ts - snap.firstTs) / span));
}

/**
 * 进度条跳转（v1 语义，Rust 侧执行）：清空 hex 环 → 从头全速快进到目标点 →
 * 恢复 speed 节奏继续回放。recorded 态下点进度条 = 从该处开始播放。
 * speed：与 play 一致（0 = 全速）。
 */
export async function seek(ratio: number, speed: number) {
  try {
    await invoke("session_seek", { ratio, speed });
    await refresh();
  } catch (e) {
    toast(String(e));
  }
}
