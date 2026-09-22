/**
 * MCP 执行端（P64b）——Rust 内控桥（bridge.rs）的前端搭档。
 *
 * 职责：
 *   1. 生命周期：订阅 settings（mcpEnabled/mcpPort/mcpToken）→ invoke
 *      bridge_start/bridge_stop；开关关闭 = 全链路零开销（仅一个 noop gate）；
 *   2. 执行：listen("mcp://call") → dispatch(kind,args) → bridge_respond 回传；
 *   3. 门控：send/run_sequence 需「允许远程发送」；HIGH_ONLY 动作需「允许高权限」
 *      （与 AI 脚本同一 HIGH_ONLY 集合，语义单源）；
 *   4. 数据：自带 1024 帧环形（表格面板关闭后 framesStore 停止入库——用户红线，
 *      MCP 是服务不是面板，自己维持有界缓冲，且仅在运行中 ingest）；
 *   5. 审计：每次 call 记 50 条环形（设置页可见），破坏性动作沿用 runAppAction 的 toast。
 *
 * 重模块（appActions/sequencer）动态 import：不拖慢启动，首次远程调用才加载。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onFrames } from "../../ipc/framesBus";
import type { FrameRow } from "../../ipc/types";
import { toast } from "../ai/extRuntime";
import {
  getSnapshot as getSettings,
  subscribe as subscribeSettings,
} from "../settings/settingsStore";
import { getSnapshot as getSerial } from "../serial/serialStore";
import { sendData } from "../serial/serialStore";
import { getSnapshot as getTelemetry } from "../protocol/telemetryStore";
import { curveStatsText } from "../ai/contextCollector";
import { getSnapshot as getSentinel } from "../sentinel/sentinelStore";
import {
  ASYNC_REQUIRED, NEEDS_MANUAL, SETTING_SEND, TOOL_DEFS, compactFrame, gateHighPriv, pageFrames, type McpToolDef,
} from "./mcpTools";
import { handleCli, isCliKind } from "../market/marketCli";

const RING_CAP = 1024; // P66-1：256→1024，配合 beforeSeq 游标分页回看更深历史（compactFrame 已限单帧体积）
const AUDIT_CAP = 50;
const FIELD_CAP = 400;

export interface McpStatus {
  running: boolean;
  port: number;
  clients: number;
  frames: number;
  audit: { ts: number; kind: string; ok: boolean; ms: number }[];
}

let running = false;
let port = 0;
let clients = 0;
let initialized = false;
/** 上次启动用的 port@token：变化且仍启用 → 重启 */
let startKey = "";
/** 运行中的帧环形：push + 读取时切片，高频路径零拷贝 */
const ring: FrameRow[] = [];
const audit: McpStatus["audit"] = [];
const listeners = new Set<() => void>();
/** 缓存快照：useSyncExternalStore 要求 getSnapshot 引用稳定，仅在 notify 时重建 */
let snap: McpStatus = { running: false, port: 0, clients: 0, frames: 0, audit: [] };

function notify() {
  snap = {
    running,
    port,
    clients,
    frames: ring.length,
    audit: audit.slice(-AUDIT_CAP),
  };
  for (const l of listeners) l();
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getStatus(): McpStatus {
  return snap;
}

export function toolDefs(): McpToolDef[] {
  return TOOL_DEFS;
}

/* ================= 生命周期 ================= */

export function init() {
  if (initialized) return;
  initialized = true;
  void import("./jobExecutor").then((m) => m.initJobExecutor());
  // 帧环形：单订阅，关闭时 handler 一行 gate（每批一次布尔判断，开销可忽略）
  onFrames((p) => {
    if (!running || p.rows.length === 0) return;
    for (const r of p.rows) {
      ring.push(r);
    }
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  });
  void (async () => {
    // 模块级单例随页面存活：unlisten 无需保存
    await listen<{ reqId: number; kind: string; args: Record<string, unknown> }>(
      "mcp://call",
      (e) => {
        void handleCall(e.payload);
      },
    );
    await listen<number>("mcp://clients", (e) => {
      clients = Number(e.payload) || 0;
      notify();
    });
  })();
  subscribeSettings(() => void sync());
  void sync();
}

/** 配置变更 → 去抖重启（端口逐键输入不产生重启风暴/错误 toast 刷屏） */
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** 代际守卫：只有最新一次 sync 的启动允许落盘，防乱序覆盖 */
let syncGen = 0;
const SYNC_DEBOUNCE_MS = 400;

function sync() {
  const s = getSettings();
  if (!s.mcpEnabled) {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (running) void stop();
    return;
  }
  const key = `${s.mcpPort}@${s.mcpToken}@${s.mcpAllowSend}@${s.mcpHighPriv}`;
  if (running && key === startKey) return;
  if (running) void invoke("bridge_jobs_control", { kind: "quiesce", args: {} });
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void doStart(key, ++syncGen);
  }, SYNC_DEBOUNCE_MS);
}

async function doStart(key: string, gen: number) {
  if (gen !== syncGen) return; // 期间又有新配置变更：本次放弃
  try {
    if (running) await invoke("bridge_stop");
    const info = await invoke<{ running: boolean; port: number }>("bridge_start", {
      port: getSettings().mcpPort,
      token: getSettings().mcpToken,
    });
    running = info.running;
    port = info.port;
    startKey = key;
  } catch (e) {
    running = false;
    port = 0;
    startKey = "";
    toast(`MCP 桥启动失败：${String(e).replace(/^Error:\s*/, "")}`);
  }
  notify();
}

async function stop() {
  try {
    await invoke("bridge_stop");
  } catch {
    /* 忽略：进程退出路径 */
  }
  running = false;
  startKey = "";
  notify();
}

/* ================= 执行端 ================= */

async function handleCall(p: { reqId: number; kind: string; args: Record<string, unknown> }) {
  const t0 = performance.now();
  let ok = true;
  let data: unknown = null;
  let err: string | null = null;
  try {
    data = await dispatch(p.kind, p.args ?? {});
  } catch (e) {
    ok = false;
    err = String(e).replace(/^Error:\s*/, "").slice(0, 300);
  }
  audit.push({ ts: Date.now(), kind: p.kind, ok, ms: Math.round(performance.now() - t0) });
  if (audit.length > AUDIT_CAP) audit.splice(0, audit.length - AUDIT_CAP);
  try {
    await invoke("bridge_respond", { reqId: p.reqId, ok, data, err });
  } catch {
    /* 桥已停止：响应无处投递，忽略 */
  }
  notify();
}

function needSend(): void {
  if (!getSettings().mcpAllowSend) {
    // 设置项名与 `send` 的工具描述同源（mcpTools.SETTING_SEND）：外部调用方读到的说明和实际错误不能是两句话
    throw new Error(`此工具需要远程发送权限：请到 Uartix+ 设置 → 集成 开启「${SETTING_SEND}」`);
  }
}

/**
 * 执行核的失败码 → **MCP 这一侧的话术**（P99a-F1）。判定在 `appActionSurface` 里只做一次，
 * 这里决定"远程调用方该看到哪句"：高权限那条要说清去设置里开哪个开关（`gateHighPriv`），
 * 后台起势那条要说"得本地起"（`NEEDS_MANUAL`），未知动作沿用与 Agent 面同一写法。
 */
function surfaceError(r: {
  code: "unknown_action" | "needs_high_priv" | "needs_manual" | "action_failed";
  msg: string;
}): string {
  if (r.code === "needs_high_priv") return gateHighPriv(r.msg);
  if (r.code === "needs_manual") return NEEDS_MANUAL;
  if (r.code === "unknown_action") return `未知动作：${r.msg}`;
  return r.msg || "动作执行失败";
}

async function dispatch(kind: string, args: Record<string, unknown>): Promise<unknown> {
  // `cli.` 前缀＝命令行专用面（Q7「AI 只读不装」）：这些名字从来不在 TOOL_DEFS 里，
  // `mcp-cli` 也只转发清单内的名字，所以模型那条路够不到；路由放在工具名检查之前，
  // 否则命令行请求会被"未知工具"挡掉，两边的话术就对不上了。
  if (isCliKind(kind)) return handleCli(kind, args);
  if (!TOOL_DEFS.some((t) => t.name === kind)) {
    throw new Error(`未知工具：${kind}`);
  }
  switch (kind) {
    case "get_status": {
      const s = getSerial();
      const t = getTelemetry();
      return {
        status: s.status,
        iface: s.iface,
        port: s.portName,
        baud: s.config.baud,
        rxTotal: s.rxTotal,
        txTotal: s.txTotal,
        bps: s.bps,
        frames: t.stats,
        mcpClients: clients,
      };
    }
    case "get_fields": {
      const t = getTelemetry();
      const entries = Object.entries(t.latest).slice(0, FIELD_CAP);
      return {
        total: Object.keys(t.latest).length,
        truncated: Object.keys(t.latest).length > entries.length,
        fields: entries.map(([id, v]) => ({ id, value: v.value, text: v.text, ts: v.ts })),
        stats: t.stats,
      };
    }
    case "get_frames": {
      const raw = args.beforeSeq;
      const before = raw === undefined || raw === null ? null : Number(raw);
      const p = pageFrames(ring, Number(args.count) || 32, before);
      return {
        count: p.page.length,
        frames: p.page.map(compactFrame),
        nextBeforeSeq: p.nextBeforeSeq,
        hasMore: p.hasMore,
      };
    }
    case "get_plot_stats":
      return { text: curveStatsText() };
    case "get_alerts": {
      const s = getSentinel();
      return {
        running: s.running,
        health: s.health,
        unack: s.unack,
        activeCrit: s.activeCrit,
        activeWarn: s.activeWarn,
        totals: s.totals,
        alerts: s.alerts.slice(-20).reverse().map((a) => ({
          ts: a.ts,
          level: a.level,
          key: a.key,
          msg: a.msg,
          count: a.count,
          acked: a.acked,
        })),
      };
    }
    case "send": {
      needSend();
      const text = typeof args.text === "string" ? args.text : "";
      // 只判 `!text` 的话，`send("   ")` 会真的往总线上发三个空格：外部调用方的手滑
      // 不该变成设备侧的一次收发。内容本身不 trim（十六进制串里空格是分隔符）。
      if (!text.trim()) throw new Error("text 不能为空");
      const mode = args.mode === "hex" ? "hex" : "ascii";
      await sendData(mode, text);
      return { sent: text, mode };
    }
    case "get_orchestrator":
    case "get_plot3d": {
      // 只读：经 appActions 的 Read 动作取同一份快照（HIGH_ONLY 门控天然不拦，因两 Read 未入该集合）
      const { runAppActionSurface } = await import("../agent/appActionSurface");
      const r = await runAppActionSurface(
        kind === "get_orchestrator" ? "orchestratorRead" : "plot3dRead",
        {},
        { highPriv: getSettings().mcpHighPriv, background: true },
      );
      if (!r.ok) throw new Error(surfaceError(r));
      return r.data;
    }
    case "run_action": {
      const akind = typeof args.kind === "string" ? args.kind : "";
      const aargs =
        args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {};
      // P99a-F1：名单校验、"后台不得代为启动"那条规则、高权限判定与执行形状全在
      // `appActionSurface` 里，与 Agent 的 `run_app_action` 同一份核；MCP 只负责**自己的**话术
      // （去设置里开哪个闸），闸门语义仍是"设置里各拨一次"，不逐条弹卡（§8-44）。
      const { runAppActionSurface } = await import("../agent/appActionSurface");
      const r = await runAppActionSurface(akind, aargs, {
        highPriv: getSettings().mcpHighPriv,
        background: true,
      });
      if (!r.ok) throw new Error(surfaceError(r));
      return r.data;
    }
    case "run_sequence":
      // 与 `run_sequence` 的工具描述同一句（TS 侧只有一份；Rust 侧那份靠 mcpTools.test 钉同文）
      throw new Error(ASYNC_REQUIRED);
    default:
      throw new Error(`未知工具：${kind}`);
  }
}
