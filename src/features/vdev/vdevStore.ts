/**
 * 虚拟设备工坊 store（P78c）——规格 normalize、设备库持久化、启停与模板自动配套。
 *
 * 职责：前端先把用户/AI 的松散 JSON 收敛成合法 VDevSpec（错误用户可读中文），
 * Rust vdev.rs 侧仍会再校验一次（双保险）。启动设备时：
 *  1. 规格无 skipAutoTpl → 由同一份 frame 规格构造 FrameTemplate 经
 *     aiActions.writeTemplateFromAiJson 的 {"group","templates"} 管线导入并启用
 *     （启动即出曲线，零配置）；
 *  2. invoke("vdev_start", spec JSON)——互斥（回放/真实接口/演示源）在 Rust 侧裁决。
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tx } from "../../i18n/strings";

/* ================= 类型（与 Rust vdev.rs serde 同形，camelCase） ================= */

export interface VDevField {
  signal: string;
  type: "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32" | "float64";
  endian: "little" | "big";
  scale: number;
}

export interface VDevFrameCfg {
  header: string;
  footer: string;
  checksum: "none" | "sum8" | "xor8" | "crc16_modbus";
  fields: VDevField[];
}

export type VDevModel =
  | { model: "const"; value: number }
  | { model: "sine"; amp: number; freqHz: number; offset: number; phaseDeg: number }
  | { model: "square"; amp: number; freqHz: number; offset: number; duty: number }
  | { model: "triangle"; amp: number; freqHz: number; offset: number }
  | { model: "firstOrder"; from: string; gain: number; tau: number; ambient: number; init: number }
  | { model: "mirror"; of: string };

export type VDevSignal = {
  name: string;
  noise: number;
  driftPerMin: number;
} & VDevModel;

export interface VDevCommand {
  match: {
    type: "ascii" | "hex";
    prefix: string;
    /** 捕获前缀后的数值写入 setInput（如 `SET DUTY 45`）；畸形按未命中 */
    captureNumber?: boolean;
    setInput?: string;
  };
  set: Record<string, number>;
  reply?: { type: "ascii" | "hex"; text: string };
}

export type VDevNetTransport = "udp" | "tcp-client" | "tcp-server" | "serial";

/** 一台设备一条链路（P79）：设备像真的一样在链路上吐帧/收令 */
export interface VDevNet {
  transport: VDevNetTransport;
  host: string; // udp 发射目标 / tcp-client 对端
  port: number; // udp out 端口 / tcp-client 目标端口 / tcp-server 监听端口
  bind: string; // tcp-server 监听地址（默认 127.0.0.1；0.0.0.0=允许局域网）
  listenPort: number; // 仅 udp：命令监听端口（0=关；TCP/串口天然双向）
  listenBind: string;
  path: string; // serial：端口路径（COM5 / /dev/ttyUSB0）
  baud: number;
  /** 仅 udp：额外发射目标（≤4，一帧多投） */
  extraTargets: { host: string; port: number }[];
}

export interface NetStatus {
  transport: string;
  target: string;
  outSent: number;
  outBytes: number;
  outErrs: number;
  inRecv: number;
  clients: number;
  lastError: string | null;
  lastCmd: string | null;
}

export interface VdevStatus {
  running: boolean;
  device: string | null;
  net: NetStatus | null;
}

export interface VDevSpec {
  kind: "uartix-vdev";
  version: 1;
  name: string;
  desc: string;
  periodMs: number;
  /** WIT 等现成预设可解码的设备跳过自动建模板（避免重复解码） */
  skipAutoTpl?: boolean;
  frame: VDevFrameCfg;
  inputs: { name: string; value: number }[];
  signals: VDevSignal[];
  faults: { dropPct: number; stuckPct: number; spikePct: number; spikeAmp: number; spikeSignal: string };
  commands: VDevCommand[];
  /** 缺省 = 纯本地仿真（旧设备 JSON 行为不变） */
  net?: VDevNet;
}

export interface SavedSpec {
  id: string;
  spec: VDevSpec;
}

export interface VdevState {
  running: boolean;
  /** 正在运行的设备名 */
  device: string | null;
  specs: SavedSpec[];
  /** 编辑区当前规格（null = 显示引导） */
  editing: VDevSpec | null;
  /** 编辑内容对应的库条目 id（null = 新建/副本/内置，未入库） */
  editingId: string | null;
  /** 上次入库/载入时的规格快照（dirty 判定基准；null = 从未保存） */
  savedSnapshot: string | null;
  /** 编辑内容未保存（emit 时重算，面板直接读） */
  dirty: boolean;
  err: string | null;
  /** 运行中链路状态（面板轮询刷新） */
  netStatus: NetStatus | null;
}

/* ================= normalize（前端第一道收敛；Rust 侧再校验一次） ================= */

const FIELD_TYPES = new Set(["int8", "uint8", "int16", "uint16", "int32", "uint32", "float32", "float64"]);
const FIELD_SIZE: Record<string, number> = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8 };
const CK_LEN: Record<string, number> = { none: 0, sum8: 1, xor8: 1, crc16_modbus: 2 };

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(v: unknown, def = ""): string {
  return typeof v === "string" ? v : def;
}

/** 松散 JSON → 合法 VDevSpec；失败抛用户可读中文错误 */
export function normalizeSpec(raw: unknown): VDevSpec {
  if (typeof raw !== "object" || raw === null) throw new Error("虚拟设备规格不是对象");
  const r = raw as Record<string, unknown>;
  const name = str(r.name).trim().slice(0, 40);
  if (!name) throw new Error("设备名不能为空");
  const frameRaw = (r.frame ?? {}) as Record<string, unknown>;
  const fieldsRaw = Array.isArray(frameRaw.fields) ? frameRaw.fields : [];
  const fields: VDevField[] = fieldsRaw.slice(0, 32).map((f, i) => {
    const fr = (f ?? {}) as Record<string, unknown>;
    const type = str(fr.type, "float32");
    if (!FIELD_TYPES.has(type)) throw new Error(`字段 ${i + 1} 类型非法：${type}`);
    return {
      signal: str(fr.signal).trim(),
      type: type as VDevField["type"],
      endian: str(fr.endian, "little") === "big" ? "big" : "little",
      scale: num(fr.scale, 1) || 1,
    };
  });
  if (!fields.length) throw new Error("帧格式至少需要一个字段");
  if (fields.some((f) => !f.signal)) throw new Error("帧字段的信号名不能为空");

  const signalsRaw = Array.isArray(r.signals) ? r.signals : [];
  if (!signalsRaw.length) throw new Error("至少定义一个信号");
  const seen = new Set<string>();
  const signals: VDevSignal[] = signalsRaw.slice(0, 32).map((s, i) => {
    const sr = (s ?? {}) as Record<string, unknown>;
    const sname = str(sr.name).trim();
    if (!sname) throw new Error(`第 ${i + 1} 个信号名不能为空`);
    if (seen.has(sname)) throw new Error(`信号名重复：${sname}`);
    seen.add(sname);
    const noise = Math.max(0, num(sr.noise, 0));
    const driftPerMin = num(sr.driftPerMin, 0);
    const model = str(sr.model, "const");
    switch (model) {
      case "const":
        return { name: sname, model, value: num(sr.value, 0), noise, driftPerMin };
      case "sine":
        return { name: sname, model, amp: num(sr.amp, 1), freqHz: num(sr.freqHz, 1), offset: num(sr.offset, 0), phaseDeg: num(sr.phaseDeg, 0), noise, driftPerMin };
      case "square":
        return { name: sname, model, amp: num(sr.amp, 1), freqHz: num(sr.freqHz, 1), offset: num(sr.offset, 0), duty: Math.min(1, Math.max(0.01, num(sr.duty, 0.5))), noise, driftPerMin };
      case "triangle":
        return { name: sname, model, amp: num(sr.amp, 1), freqHz: num(sr.freqHz, 1), offset: num(sr.offset, 0), noise, driftPerMin };
      case "firstOrder": {
        const from = str(sr.from).trim();
        if (!from) throw new Error(`信号 ${sname} 的一阶模型未指定输入量 from`);
        return { name: sname, model, from, gain: num(sr.gain, 1), tau: Math.max(0.02, num(sr.tau, 1)), ambient: num(sr.ambient, 0), init: num(sr.init, num(sr.ambient, 0)), noise, driftPerMin };
      }
      case "mirror": {
        const of = str(sr.of).trim();
        if (!of) throw new Error(`镜像信号 ${sname} 未指定 of`);
        return { name: sname, model, of, noise, driftPerMin };
      }
      default:
        throw new Error(`不支持的信号模型 ${model}（可用 const/sine/square/triangle/firstOrder/mirror）`);
    }
  });

  // mirror/firstOrder 引用检查（信号或输入量）
  const inputNames = new Set(
    (Array.isArray(r.inputs) ? r.inputs : []).map((x) => str((x as Record<string, unknown>)?.name).trim()).filter(Boolean),
  );
  for (const s of signals) {
    if (s.model === "firstOrder" && !inputNames.has(s.from)) {
      throw new Error(`信号 ${s.name} 的一阶模型引用了未声明的输入量 ${s.from}`);
    }
    if (s.model === "mirror") {
      const of = s.of;
      if (!signals.some((x) => x.name === of) && !inputNames.has(of)) {
        throw new Error(`镜像信号 ${s.name} 引用了不存在的信号或输入量 ${of}`);
      }
    }
  }

  const fRaw = (r.faults ?? {}) as Record<string, unknown>;
  const faults = {
    dropPct: Math.min(95, Math.max(0, num(fRaw.dropPct, 0))),
    stuckPct: Math.min(95, Math.max(0, num(fRaw.stuckPct, 0))),
    spikePct: Math.min(95, Math.max(0, num(fRaw.spikePct, 0))),
    spikeAmp: num(fRaw.spikeAmp, 0),
    spikeSignal: str(fRaw.spikeSignal).trim(),
  };
  if (faults.spikePct > 0 && faults.spikeSignal && !signals.some((s) => s.name === faults.spikeSignal)) {
    throw new Error(`毛刺注入的信号 ${faults.spikeSignal} 不存在`);
  }

  const commandsRaw = Array.isArray(r.commands) ? r.commands : [];
  const commands: VDevCommand[] = commandsRaw.slice(0, 32).map((c, i) => {
    const cr = (c ?? {}) as Record<string, unknown>;
    const m = (cr.match ?? {}) as Record<string, unknown>;
    const mtype = str(m.type, "ascii") === "hex" ? "hex" : "ascii";
    const prefix = str(m.prefix).trim();
    if (!prefix) throw new Error(`第 ${i + 1} 条命令的匹配前缀不能为空`);
    if (mtype === "hex" && !/^[0-9a-fA-F\s]+$/.test(prefix)) throw new Error(`第 ${i + 1} 条命令的 HEX 前缀非法：${prefix}`);
    const captureNumber = m.captureNumber === true;
    const setInput = str(m.setInput).trim();
    if (captureNumber) {
      if (mtype !== "ascii") throw new Error(`第 ${i + 1} 条命令：数值捕获仅支持 ascii`);
      if (!setInput) throw new Error(`第 ${i + 1} 条命令：数值捕获需要目标输入量`);
    }
    const set: Record<string, number> = {};
    for (const [k, v] of Object.entries((cr.set ?? {}) as Record<string, unknown>)) {
      if (!k.trim()) continue;
      set[k.trim()] = num(v, 0);
    }
    for (const k of Object.keys(set)) {
      if (!inputNames.has(k)) throw new Error(`命令写入的输入量 ${k} 未在 inputs 中声明`);
    }
    if (captureNumber && !inputNames.has(setInput)) {
      throw new Error(`数值捕获写入的输入量 ${setInput} 未在 inputs 中声明`);
    }
    const replyRaw = (cr.reply ?? null) as Record<string, unknown> | null;
    const reply = replyRaw
      ? { type: str(replyRaw.type, "ascii") === "hex" ? ("hex" as const) : ("ascii" as const), text: str(replyRaw.text) }
      : undefined;
    return {
      match: { type: mtype, prefix, ...(captureNumber ? { captureNumber, setInput } : {}) },
      set,
      ...(reply ? { reply } : {}),
    };
  });

  let net: VDevNet | undefined;
  if (r.net && typeof r.net === "object") {
    const nr = r.net as Record<string, unknown>;
    const transport = str(nr.transport, "udp") as VDevNetTransport;
    if (!["udp", "tcp-client", "tcp-server", "serial"].includes(transport)) {
      throw new Error(`不支持的网络链路类型 ${transport}（可用 udp/tcp-client/tcp-server/serial）`);
    }
    net = {
      transport,
      host: str(nr.host, "127.0.0.1").trim(),
      port: Math.round(num(nr.port, 0)),
      bind: str(nr.bind, "127.0.0.1").trim(),
      listenPort: Math.round(num(nr.listenPort, 0)),
      listenBind: str(nr.listenBind, "127.0.0.1").trim(),
      path: str(nr.path, "").trim(),
      baud: Math.round(num(nr.baud, 115200)),
      extraTargets: (Array.isArray(nr.extraTargets) ? nr.extraTargets : []).slice(0, 4).map((x) => {
        const xr = (x ?? {}) as Record<string, unknown>;
        return { host: str(xr.host, "127.0.0.1").trim(), port: Math.round(num(xr.port, 0)) };
      }),
    };
    if (transport === "udp") {
      if (net.port < 1 || net.port > 65535) throw new Error("UDP 发射端口非法");
      for (const t of net.extraTargets) {
        if (t.port < 1 || t.port > 65535) throw new Error("UDP 附加目标端口非法");
      }
      if (net.listenPort !== 0 && net.listenPort === net.port) throw new Error("UDP 发射与监听端口不能相同（自环）");
    }
    if (transport === "tcp-client" && (net.port < 1 || net.port > 65535)) throw new Error("TCP 对端端口非法");
    if (transport === "tcp-server") {
      if (net.port < 1 || net.port > 65535) throw new Error("TCP 监听端口非法");
      if (net.bind !== "127.0.0.1" && net.bind !== "0.0.0.0") throw new Error("TCP 服务端监听地址仅支持 127.0.0.1 或 0.0.0.0");
    }
    if (transport === "serial" && !net.path) throw new Error("串口链路需要端口路径（如 COM5）");
  }
  const periodMs = Math.min(5000, Math.max(20, Math.round(num(r.periodMs, 100))));
  return {
    kind: "uartix-vdev",
    version: 1,
    name,
    desc: str(r.desc).slice(0, 200),
    periodMs,
    skipAutoTpl: r.skipAutoTpl === true,
    frame: {
      header: str(frameRaw.header, "").trim(),
      footer: str(frameRaw.footer, "").trim(),
      checksum: (["none", "sum8", "xor8", "crc16_modbus"].includes(str(frameRaw.checksum, "sum8"))
        ? str(frameRaw.checksum, "sum8")
        : "sum8") as VDevFrameCfg["checksum"],
      fields,
    },
    inputs: (Array.isArray(r.inputs) ? r.inputs : []).slice(0, 16).map((x) => {
      const ir = (x ?? {}) as Record<string, unknown>;
      return { name: str(ir.name).trim(), value: num(ir.value, 0) };
    }),
    signals,
    faults,
    commands,
    ...(net ? { net } : {}),
  };
}

/* ================= 内置设备 ================= */

export function builtinSpecs(): VDevSpec[] {
  return [
    {
      kind: "uartix-vdev",
      version: 1,
      name: "温控炉",
      desc: "一阶加热对象：HEAT ON / HEAT OFF 控制加热管，温度按一阶惯性爬升（增益 35℃、τ=2s）。这是「PID 继电反馈整定」编排模板的配套被控对象。",
      periodMs: 200,
      frame: {
        header: "54 4D",
        footer: "",
        checksum: "sum8",
        fields: [
          { signal: "temp", type: "int16", endian: "little", scale: 0.1 },
          { signal: "heater", type: "uint8", endian: "little", scale: 1 },
        ],
      },
      inputs: [{ name: "heaterCmd", value: 0 }],
      signals: [
        { name: "heater", model: "mirror", of: "heaterCmd", noise: 0, driftPerMin: 0 },
        { name: "temp", model: "firstOrder", from: "heaterCmd", gain: 35, tau: 2, ambient: 25, init: 25, noise: 0.05, driftPerMin: 0 },
      ],
      faults: { dropPct: 0, stuckPct: 0, spikePct: 0, spikeAmp: 0, spikeSignal: "" },
      commands: [
        { match: { type: "ascii", prefix: "HEAT ON" }, set: { heaterCmd: 1 }, reply: { type: "ascii", text: "OK\n" } },
        { match: { type: "ascii", prefix: "HEAT OFF" }, set: { heaterCmd: 0 }, reply: { type: "ascii", text: "OK\n" } },
        { match: { type: "ascii", prefix: "SET HEAT ", captureNumber: true, setInput: "heaterCmd" }, set: {}, reply: { type: "ascii", text: "OK\n" } },
      ],
    },
    {
      kind: "uartix-vdev",
      version: 1,
      name: "虚拟 MPU6050",
      desc: "输出 WIT 0x51 兼容帧（55 51 + AX/AY/AZ/温度 + SUM）：三轴摆动 + 温度缓慢漂移，5% 丢帧与偶发 AZ 毛刺。用「＋预设 → 维特 WIT 陀螺仪」即可直接解码。",
      periodMs: 100,
      skipAutoTpl: true,
      frame: {
        header: "55 51",
        footer: "",
        checksum: "sum8",
        fields: [
          { signal: "ax", type: "int16", endian: "little", scale: 1 },
          { signal: "ay", type: "int16", endian: "little", scale: 1 },
          { signal: "az", type: "int16", endian: "little", scale: 1 },
          { signal: "t", type: "int16", endian: "little", scale: 1 },
        ],
      },
      inputs: [],
      signals: [
        { name: "ax", model: "sine", amp: 1800, freqHz: 0.8, offset: 0, phaseDeg: 0, noise: 60, driftPerMin: 0 },
        { name: "ay", model: "sine", amp: 1400, freqHz: 0.53, offset: 0, phaseDeg: 120, noise: 60, driftPerMin: 0 },
        { name: "az", model: "sine", amp: 600, freqHz: 0.21, offset: 16384, phaseDeg: 0, noise: 80, driftPerMin: 0 },
        { name: "t", model: "const", value: 2600, noise: 3, driftPerMin: 150 },
      ],
      faults: { dropPct: 5, stuckPct: 0, spikePct: 2, spikeAmp: 4000, spikeSignal: "az" },
      commands: [],
    },
  ];
}

/* ================= 模板自动配套 ================= */

function hexToBytes(s: string): number[] {
  const clean: string = s.replace(/\s+/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(Number.parseInt(clean.slice(i, i + 2), 16));
  return out;
}

/** 由 frame 规格构造 FrameTemplate（fixedLength + 同款校验），包成 {"group","templates"} 导入格式 */
export function buildTemplateImport(spec: VDevSpec): { group: string; templates: unknown[] } {
  const header = hexToBytes(spec.frame.header);
  const footer = hexToBytes(spec.frame.footer);
  const body = spec.frame.fields.reduce((a, f) => a + (FIELD_SIZE[f.type] ?? 0), 0);
  const ck = CK_LEN[spec.frame.checksum] ?? 0;
  const len = header.length + body + footer.length + ck;
  const palette = ["#39c5cf", "#db61a2", "#3fb950", "#d29922", "#4e9cef", "#e5534b"];
  let acc = header.length;
  const fields = spec.frame.fields.map((f, i) => {
    const field: Record<string, unknown> = {
      id: `vd${i}_${Date.now().toString(36)}`,
      name: f.signal,
      role: "data",
      offset: acc,
      type: f.type,
      endian: f.endian,
      color: palette[i % palette.length],
    };
    if (f.scale !== 1) field.scale = f.scale;
    acc += FIELD_SIZE[f.type] ?? 0;
    return field;
  });
  const template = {
    id: `vdev_${Date.now().toString(36)}`,
    name: `${spec.name} 数据帧`,
    color: "#4e9cef",
    enabled: true,
    boundary: { mode: "fixedLength", headerBytes: header, fixedLength: len, maxLength: len + 8 },
    checksum:
      spec.frame.checksum === "none"
        ? null
        : {
            algo: spec.frame.checksum,
            coverageStart: 0,
            coverageEnd: spec.frame.checksum === "crc16_modbus" ? -2 : -1,
            endian: "little",
          },
    fields,
  };
  return { group: `虚拟设备 · ${spec.name}`, templates: [template] };
}

/* ================= store ================= */

const LIST_KEY = "vs.vdev.list";

/** toast 动态导入：避免把 extRuntime→appActions 的重链拉进本模块图（测试/面板加载都更轻） */
async function notify(zh: string, en: string): Promise<void> {
  const { toast } = await import("../ai/extRuntime");
  toast(tx(zh, en));
}
const listeners = new Set<() => void>();

function loadList(): SavedSpec[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: SavedSpec[] = [];
    for (const x of arr) {
      try {
        const s = (x as Record<string, unknown>).spec;
        out.push({ id: str((x as Record<string, unknown>).id) || `vd_${out.length}`, spec: normalizeSpec(s) });
      } catch {
        /* 损坏条目跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function saveList(specs: SavedSpec[]) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(specs));
  } catch {
    /* 仅内存 */
  }
}

let state: VdevState = { running: false, device: null, specs: loadList(), editing: null, editingId: null, savedSnapshot: null, dirty: false, err: null, netStatus: null };

function emit() {
  state = {
    ...state,
    dirty: !!state.editing && JSON.stringify(state.editing) !== state.savedSnapshot,
  };
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): VdevState {
  return state;
}

export function useVdev(): VdevState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function newId(): string {
  return `vd_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

/** 保存到设备库（同名覆盖）；返回条目 id */
export function saveToLibrary(spec: VDevSpec): string {
  const specs = state.specs.slice();
  const found = specs.find((s) => s.spec.name === spec.name);
  if (found) {
    found.spec = spec;
    emit();
    saveList(specs);
    return found.id;
  }
  const id = newId();
  specs.unshift({ id, spec });
  state = { ...state, specs };
  saveList(specs);
  emit();
  return id;
}

export function removeFromLibrary(id: string) {
  const specs = state.specs.filter((s) => s.id !== id);
  const drop = state.editingId === id;
  state = { ...state, specs, ...(drop ? { editing: null, editingId: null, savedSnapshot: null } : {}) };
  saveList(specs);
  emit();
}

/** 面板打开时刷新一次运行态（多窗口/重启后兜底） */
export async function refreshRunning(): Promise<void> {
  try {
    const running = await invoke<boolean>("vdev_running");
    if (running !== state.running) {
      state = { ...state, running, device: running ? state.device : null };
      emit();
    }
  } catch {
    /* 非 Tauri 环境（纯浏览器）忽略 */
  }
}

/** 启动设备：normalize → 自动配套模板 → invoke vdev_start */
export async function startDevice(spec: VDevSpec): Promise<string | null> {
  let norm: VDevSpec;
  try {
    norm = normalizeSpec(spec);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state = { ...state, err: msg };
    emit();
    void notify(`无法启动：${msg}`, `Cannot start: ${msg}`);
    return null;
  }
  try {
    await invoke("vdev_start", { spec: JSON.stringify(norm) });
  } catch (e) {
    const msg = String(e).replace(/^"|"$/g, "");
    state = { ...state, err: msg };
    emit();
    void notify(`无法启动：${msg}`, `Cannot start: ${msg}`);
    return null;
  }
  if (!norm.skipAutoTpl) {
    const { writeTemplateFromAiJson } = await import("../ai/aiActions");
    const r = writeTemplateFromAiJson(JSON.stringify(buildTemplateImport(norm)));
    if (!r.ok) void notify(`协议模板自动导入失败：${r.msg}`, `Auto template import failed: ${r.msg}`);
  }
  const savedId = saveToLibrary(norm);
  state = { ...state, running: true, device: norm.name, err: null, netStatus: null };
  if (state.editing && state.editing.name === norm.name) {
    state = { ...state, editing: norm, editingId: savedId, savedSnapshot: JSON.stringify(norm) };
  }
  emit();
  void fetchStatus();
  return norm.name;
}

export async function stopDevice(): Promise<void> {
  try {
    await invoke("vdev_stop");
  } catch {
    /* 非 Tauri 环境 */
  }
  state = { ...state, running: false, device: null, netStatus: null };
  emit();
}

/** 编辑区内容变更（用户输入）：保留 editingId/快照，dirty 由 emit 重算 */
export function setEditing(spec: VDevSpec | null) {
  state = { ...state, editing: spec, err: null };
  emit();
}

/** 载入一份规格到编辑区：id 非空 = 对应库条目（快照即已保存态）；id 空 = 新建/副本/内置（未保存态） */
export function loadEditing(spec: VDevSpec, id: string | null) {
  state = {
    ...state,
    editing: spec,
    editingId: id,
    savedSnapshot: id !== null ? JSON.stringify(spec) : null,
    err: null,
  };
  emit();
}

/** 保存当前编辑到设备库：原位更新（含改名）优先，其次同名覆盖，最后新增；返回设备名或 null */
export function saveEditing(): string | null {
  const cur = state.editing;
  if (!cur) return null;
  let norm: VDevSpec;
  try {
    norm = normalizeSpec(cur);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state = { ...state, err: msg };
    emit();
    return null;
  }
  const specs = state.specs.slice();
  let id = state.editingId;
  let idx = id !== null ? specs.findIndex((x) => x.id === id) : -1;
  if (idx < 0) {
    idx = specs.findIndex((x) => x.spec.name === norm.name);
    if (idx >= 0) id = specs[idx].id;
  }
  if (idx >= 0) {
    specs[idx] = { id: specs[idx].id, spec: norm };
    id = specs[idx].id;
  } else {
    id = newId();
    specs.unshift({ id, spec: norm });
  }
  state = { ...state, specs, editing: norm, editingId: id, savedSnapshot: JSON.stringify(norm), err: null };
  saveList(specs);
  emit();
  return norm.name;
}

export function setErr(err: string | null) {
  state = { ...state, err };
  emit();
}

/** 面板轮询链路状态（1s；纯读锁开销可忽略）；非 Tauri 环境静默 */
export async function fetchStatus(): Promise<VdevStatus | null> {
  try {
    const st = await invoke<VdevStatus>("vdev_status");
    const next: Partial<VdevState> = { running: st.running, device: st.device };
    if (st.net) next.netStatus = st.net;
    else if (state.netStatus) next.netStatus = null;
    if (next.running !== state.running || next.device !== state.device || next.netStatus !== state.netStatus) {
      state = { ...state, ...next };
      emit();
    }
    return st;
  } catch {
    return null;
  }
}
