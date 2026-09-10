/**
 * 指令工厂：多协议指令编解码器
 * 每个编解码器负责：动态表单字段定义 → 组帧（含校验自动计算）→ 分段着色帧预览
 * 参考：JY901P-WIT私有协议.md、匿名通信协议V7-20200813.md、Modbus RTU/TCP 标准
 */

import {
  FC_LABEL,
  MB_FNS as MB_KERNEL_FNS,
  areaOfFn,
  buildRtuRequest,
  buildTcpRequest,
  legacyToAddr,
  mbCrc,
  type MbRequest,
} from "../modbus/mb";

export interface FactoryField {
  key: string;
  label: string;
  kind: "int" | "select" | "hex" | "text";
  /** select 的选项 / int 的常用值提示 */
  options?: { v: number; label: string }[];
  def?: string;
  hint?: string;
}

export interface FramePart {
  text: string;
  label: string;
  cls: "head" | "addr" | "id" | "len" | "data" | "check";
}

export interface FactoryResult {
  /** 要发送的一帧或多帧（HEX 大写字符串） */
  frames: string[];
  /** 主帧的分段着色预览 */
  parts: FramePart[];
  note?: string;
}

export interface Codec {
  id: string;
  name: string;
  /** 顶部的人话流程提示，如「①选寄存器 → ②填值 → ③发送」 */
  guide?: string;
  /** 表单字段；可依赖当前值动态生成（如 ANO 命令参数随命令变化） */
  fields: FactoryField[] | ((v: Record<string, string>) => FactoryField[]);
  build: (v: Record<string, string>) => FactoryResult;
  /** 存为指令时的命名摘要 */
  summary?: (v: Record<string, string>) => string;
  /** 存入命令库的分组名 */
  group: string;
}

// ---------------- 校验算法（实现在 shared/checksums.ts，与 Modbus 内核同源） ----------------

export { sum8, xor8, anoCheck, crc16, type Crc16Algo } from "../../shared/checksums";
import { sum8, xor8, anoCheck, crc16 } from "../../shared/checksums";

// ---------------- 数值解析 ----------------

/** 解析整数输入：支持十进制与 0x 十六进制 */
export function parseIntInput(text: string, label: string): number {
  const t = text.trim();
  const v = /^-?0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
  if (!Number.isFinite(v)) throw new Error(`「${label}」不是有效数字（支持十进制或 0x 十六进制）`);
  return v;
}

export function parseHexBytes(text: string, label: string): number[] {
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) throw new Error(`「${label}」内容为空`);
  const out: number[] = [];
  for (const t of tokens) {
    const v = /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xff) {
      throw new Error(`「${label}」含无效字节：${t}`);
    }
    out.push(v);
  }
  return out;
}

const b2 = (v: number) => (v & 0xff).toString(16).padStart(2, "0").toUpperCase();
const hexBytes = (arr: number[]) => arr.map(b2).join(" ");

function pushLe(arr: number[], v: number, n: number) {
  for (let i = 0; i < n; i++) arr.push((v >>> (8 * i)) & 0xff);
}

function pushLeSigned(arr: number[], v: number, n: number) {
  pushLe(arr, v < 0 ? v + 0x100000000 * Math.ceil(-v / 0x100000000) : v, n);
}

// ---------------- WIT（JY901P）写寄存器 ----------------

export interface WitReg {
  addr: number;
  name: string;
  desc: string;
  hints?: { v: number; label: string }[];
}

export const WIT_REGS: WitReg[] = [
  {
    addr: 0x00, name: "SAVE", desc: "保存/重启/恢复出厂",
    hints: [
      { v: 0x0000, label: "保存配置" },
      { v: 0x00ff, label: "重启模块" },
      { v: 0x0001, label: "恢复出厂" },
    ],
  },
  {
    addr: 0x01, name: "CALSW", desc: "校准模式",
    hints: [
      { v: 0x01, label: "自动加计校准" },
      { v: 0x03, label: "高度清零" },
      { v: 0x04, label: "航向角置零" },
      { v: 0x07, label: "磁场校准（球型拟合）" },
      { v: 0x08, label: "设置角度参考" },
      { v: 0x09, label: "磁场校准（双平面）" },
    ],
  },
  {
    addr: 0x02, name: "RSW", desc: "输出内容（Bit0~Bit10 对应 0x50~0x5A 帧）",
    hints: [
      { v: 0x001e, label: "默认：时间/加计/角速度/角度/磁场" },
      { v: 0x003e, label: "+端口状态" },
      { v: 0x007e, label: "+气压高度" },
      { v: 0x00ff, label: "全部基础帧" },
      { v: 0x03ff, label: "+地速/四元数" },
    ],
  },
  {
    addr: 0x03, name: "RRATE", desc: "输出速率",
    hints: [
      { v: 0x06, label: "10Hz" },
      { v: 0x07, label: "20Hz" },
      { v: 0x08, label: "50Hz" },
      { v: 0x09, label: "100Hz" },
      { v: 0x0b, label: "200Hz" },
      { v: 0x0c, label: "单次回传" },
      { v: 0x0d, label: "不回传" },
    ],
  },
  {
    addr: 0x04, name: "BAUD", desc: "串口波特率（改后需用新波特率重连）",
    hints: [
      { v: 0x02, label: "9600" },
      { v: 0x03, label: "19200" },
      { v: 0x05, label: "57600" },
      { v: 0x06, label: "115200" },
      { v: 0x07, label: "230400" },
    ],
  },
  { addr: 0x05, name: "AXOFFSET", desc: "加速度X零偏" },
  { addr: 0x06, name: "AYOFFSET", desc: "加速度Y零偏" },
  { addr: 0x07, name: "AZOFFSET", desc: "加速度Z零偏" },
  { addr: 0x08, name: "GXOFFSET", desc: "角速度X零偏" },
  { addr: 0x09, name: "GYOFFSET", desc: "角速度Y零偏" },
  { addr: 0x0a, name: "GZOFFSET", desc: "角速度Z零偏" },
  { addr: 0x0b, name: "HXOFFSET", desc: "磁场X零偏" },
  { addr: 0x0c, name: "HYOFFSET", desc: "磁场Y零偏" },
  { addr: 0x0d, name: "HZOFFSET", desc: "磁场Z零偏" },
  { addr: 0x0e, name: "D0MODE", desc: "D0引脚模式" },
  { addr: 0x0f, name: "D1MODE", desc: "D1引脚模式" },
  { addr: 0x10, name: "D2MODE", desc: "D2引脚模式" },
  { addr: 0x11, name: "D3MODE", desc: "D3引脚模式" },
  { addr: 0x1a, name: "IICADDR", desc: "设备地址" },
  { addr: 0x1b, name: "LEDOFF", desc: "关闭LED灯", hints: [{ v: 0x01, label: "关闭" }, { v: 0x00, label: "打开" }] },
  { addr: 0x1f, name: "BANDWIDTH", desc: "带宽" },
  { addr: 0x20, name: "GYRORANGE", desc: "陀螺仪量程" },
  { addr: 0x21, name: "ACCRANGE", desc: "加速度量程" },
  { addr: 0x22, name: "SLEEP", desc: "休眠", hints: [{ v: 0x01, label: "休眠" }, { v: 0x00, label: "唤醒" }] },
  { addr: 0x23, name: "ORIENT", desc: "安装方向" },
  { addr: 0x24, name: "AXIS6", desc: "算法", hints: [{ v: 0x00, label: "九轴" }, { v: 0x01, label: "六轴" }] },
  { addr: 0x25, name: "FILTK", desc: "动态滤波" },
  { addr: 0x26, name: "GPSBAUD", desc: "GPS波特率" },
  { addr: 0x27, name: "READADDR", desc: "读取寄存器（值=目标寄存器地址，返回帧 0x5F）", hints: [{ v: 0x00, label: "读 SAVE" }, { v: 0x03, label: "读 RRATE" }, { v: 0x04, label: "读 BAUD" }] },
  { addr: 0x2a, name: "ACCFILT", desc: "加速度滤波" },
  { addr: 0x2d, name: "POWONSEND", desc: "指令启动" },
  { addr: 0x69, name: "KEY", desc: "解锁（0xB588）" },
  { addr: 0x6b, name: "TIMEZONE", desc: "GPS时区" },
];

export const WIT_UNLOCK = "FF AA 69 88 B5";
export const WIT_SAVE = "FF AA 00 00 00";

function witWriteFrame(addr: number, v: number): FramePart[] {
  const parts: FramePart[] = [
    { text: "FF AA", label: "帧头", cls: "head" },
    { text: b2(addr), label: "寄存器", cls: "id" },
    { text: `${b2(v)} ${b2(v >> 8)}`, label: "值(LE)", cls: "data" },
  ];
  return parts;
}

// ---------------- 匿名 V7 ----------------

export interface AnoParam {
  label: string;
  type: "u8" | "u16" | "s32";
  min?: number;
  max?: number;
  def?: number;
  unit?: string;
  hint?: string;
}

export interface AnoCmd {
  cid: number;
  cmd: [number, number];
  name: string;
  note?: string;
  params?: AnoParam[];
}

/** 匿名 V7 功能触发帧（0xE0）命令表（摘自协议文档第三节） */
export const ANO_COMMANDS: AnoCmd[] = [
  { cid: 0x00, cmd: [0x00, 0x01], name: "ACC 加计校准" },
  { cid: 0x00, cmd: [0x00, 0x02], name: "GYRO 陀螺校准" },
  { cid: 0x00, cmd: [0x00, 0x03], name: "快速水平校准" },
  { cid: 0x00, cmd: [0x00, 0x04], name: "MAG 磁场校准" },
  { cid: 0x00, cmd: [0x00, 0x05], name: "加速度六面校准" },
  { cid: 0x00, cmd: [0x00, 0x10], name: "姿态融合复位对准" },
  { cid: 0x00, cmd: [0x00, 0xaa], name: "恢复默认 PID 参数" },
  { cid: 0x00, cmd: [0x00, 0xab], name: "恢复默认参数" },
  {
    cid: 0x00, cmd: [0x01, 0x01], name: "飞行模式选择",
    params: [
      { label: "模式", type: "u8", min: 0, max: 3, def: 0, hint: "0 姿态 / 1 姿态+定高 / 2 定点 / 3 程控" },
    ],
  },
  { cid: 0x00, cmd: [0x00, 0x01], name: "解锁（控制）", note: "A 类：任意模式可用" },
  { cid: 0x00, cmd: [0x00, 0x02], name: "锁定 / 紧急停机", note: "A 类" },
  { cid: 0x00, cmd: [0x00, 0x04], name: "一键悬停" },
  {
    cid: 0x00, cmd: [0x00, 0x05], name: "一键起飞", note: "B 类：姿态模式外可用",
    params: [{ label: "起飞高度", type: "u16", min: 0, max: 500, def: 0, unit: "cm", hint: "0=使用默认高度" }],
  },
  { cid: 0x00, cmd: [0x00, 0x06], name: "一键降落" },
  { cid: 0x00, cmd: [0x00, 0x07], name: "一键返航" },
  {
    cid: 0x00, cmd: [0x00, 0x0a], name: "无头模式",
    params: [{ label: "模式", type: "u8", min: 0, max: 1, def: 0, hint: "0 有头 / 1 无头" }],
  },
  { cid: 0x00, cmd: [0x00, 0x60], name: "开始航点飞行" },
  { cid: 0x00, cmd: [0x00, 0x61], name: "暂停航点飞行" },
  { cid: 0x00, cmd: [0x00, 0x62], name: "取消航点飞行" },
  {
    cid: 0x00, cmd: [0x01, 0x02], name: "目标对地高度", note: "C 类：定点+程控可用",
    params: [{ label: "目标高度", type: "s32", min: -100000, max: 100000, def: 0, unit: "cm" }],
  },
  {
    cid: 0x00, cmd: [0x02, 0x01], name: "上升高度",
    params: [
      { label: "上升高度", type: "u16", min: 0, max: 10000, def: 100, unit: "cm" },
      { label: "上升速度", type: "u16", min: 10, max: 300, def: 100, unit: "cm/s" },
    ],
  },
  {
    cid: 0x00, cmd: [0x02, 0x02], name: "下降高度",
    params: [
      { label: "下降高度", type: "u16", min: 0, max: 10000, def: 100, unit: "cm" },
      { label: "下降速度", type: "u16", min: 10, max: 300, def: 100, unit: "cm/s" },
    ],
  },
  {
    cid: 0x00, cmd: [0x02, 0x07], name: "左旋角度",
    params: [
      { label: "角度", type: "u16", min: 0, max: 359, def: 90, unit: "deg" },
      { label: "角速度", type: "u16", min: 5, max: 90, def: 30, unit: "deg/s" },
    ],
  },
  {
    cid: 0x00, cmd: [0x02, 0x08], name: "右旋角度",
    params: [
      { label: "角度", type: "u16", min: 0, max: 359, def: 90, unit: "deg" },
      { label: "角速度", type: "u16", min: 5, max: 90, def: 30, unit: "deg/s" },
    ],
  },
];

/** 组匿名 V7 帧（0xAA D_ADDR ID LEN DATA... SC AC），返回帧字节与分段 */
function buildAnoFrame(
  dAddr: number,
  id: number,
  data: number[],
): { bytes: number[]; parts: FramePart[] } {
  const head = [0xaa, dAddr & 0xff, id & 0xff, data.length & 0xff];
  const { sc, ac } = anoCheck([...head, ...data]);
  const bytes = [...head, ...data, sc, ac];
  const parts: FramePart[] = [
    { text: "AA", label: "帧头", cls: "head" },
    { text: b2(dAddr), label: "目标地址", cls: "addr" },
    { text: b2(id), label: "功能码", cls: "id" },
    { text: b2(data.length), label: "长度", cls: "len" },
    { text: hexBytes(data), label: "数据", cls: "data" },
    { text: `${b2(sc)} ${b2(ac)}`, label: "SC+AC", cls: "check" },
  ];
  return { bytes, parts };
}

// ---------------- Modbus（组帧逻辑统一在 features/modbus/mb.ts） ----------------

const MB_FNS = MB_KERNEL_FNS.map((fn) => ({ v: fn, label: FC_LABEL[fn] }));

/** 多个值：空格或逗号分隔，支持 0x；FC15 用 0/1、FC16 用字值 */
function parseNumList(text: string, label: string): number[] {
  const t = text.trim();
  if (!t) throw new Error(`「${label}」不能为空（多个值用空格或逗号分隔）`);
  return t.split(/[\s,，]+/).filter(Boolean).map((s) => parseIntInput(s, label));
}

/** 表单第三项：读=数量、写单点=值、写多点=值列表 */
function mbValueField(fn: number): FactoryField {
  if (fn === 0x05)
    return { key: "val", label: "线圈值", kind: "int", def: "1", hint: "0=断开，非 0=闭合（上线自动转 FF00/0000）" };
  if (fn === 0x06)
    return { key: "val", label: "写入值", kind: "int", def: "1", hint: "0~65535，可写 0x" };
  if (fn === 0x0f)
    return { key: "vals", label: "线圈序列", kind: "text", def: "1 0 1 1", hint: "按位写：0/1 用空格分隔，长度即数量" };
  if (fn === 0x10)
    return { key: "vals", label: "寄存器序列", kind: "text", def: "1 2 3", hint: "多个字值用空格分隔，可写 0x" };
  return { key: "val", label: "数量", kind: "int", def: "1", hint: fn >= 0x05 ? "" : "读取数量（寄存器 1~125、位 1~2000）" };
}

/** 请求帧 → 分段着色预览（TCP 无 CRC，RTU 尾部两字节是 CRC） */
function mbParts(bytes: number[], tcp: boolean): FramePart[] {
  const parts: FramePart[] = [];
  if (tcp) {
    parts.push(
      { text: `${b2(bytes[0])} ${b2(bytes[1])}`, label: "事务号", cls: "addr" },
      { text: "00 00", label: "协议标识", cls: "head" },
      { text: `${b2(bytes[4])} ${b2(bytes[5])}`, label: "长度", cls: "len" },
      { text: b2(bytes[6]), label: "单元", cls: "addr" },
    );
  } else {
    parts.push({ text: b2(bytes[0]), label: "从站", cls: "addr" });
  }
  const p = tcp ? bytes.slice(7) : bytes.slice(1, bytes.length - 2);
  const fn = p[0];
  parts.push({ text: b2(fn), label: "功能码", cls: "id" });
  if (fn === 0x0f || fn === 0x10) {
    const bc = p[5];
    parts.push(
      { text: `${b2(p[1])} ${b2(p[2])}`, label: "起始地址", cls: "data" },
      { text: `${b2(p[3])} ${b2(p[4])}`, label: "数量", cls: "len" },
      { text: b2(bc), label: "字节数", cls: "len" },
      { text: hexBytes(p.slice(6, 6 + bc)), label: "写入值", cls: "data" },
    );
  } else {
    const label = fn === 0x05 ? "FF00/0000" : fn === 0x06 ? "写入值" : "数量";
    parts.push(
      { text: `${b2(p[1])} ${b2(p[2])}`, label: "起始地址", cls: "data" },
      { text: `${b2(p[3])} ${b2(p[4])}`, label, cls: "data" },
    );
  }
  if (!tcp) {
    const crc = mbCrc(bytes.slice(0, bytes.length - 2));
    parts.push({ text: `${b2(crc & 0xff)} ${b2(crc >> 8)}`, label: "CRC16", cls: "check" });
  }
  return parts;
}

/** 表单值 → MbRequest（RTU 与 TCP 共用同一份参数） */
function mbRequestFrom(v: Record<string, string>): MbRequest {
  const slave = parseIntInput(v.addr || "01", "从站地址");
  const fn = parseIntInput(v.fn || "3", "功能码");
  const addr = legacyToAddr(parseIntInput(v.reg || "0", "起始地址"), areaOfFn(fn));
  const req: MbRequest = { slave, fn, addr };
  if (fn === 0x0f || fn === 0x10) req.values = parseNumList(v.vals ?? "", fn === 0x0f ? "线圈序列" : "寄存器序列");
  else if (fn === 0x05 || fn === 0x06) req.value = parseIntInput(v.val || "1", "写入值");
  else req.qty = parseIntInput(v.val || "1", "数量");
  return req;
}

/** 手册编号段提示（让用户直接抄 PLC 手册里的地址） */
function mbAddrHint(fn: number): string {
  const area = areaOfFn(fn);
  const base = area === "holding" ? "40001" : area === "input" ? "30001" : area === "disc" ? "10001" : "00001";
  return `线上 0 基址；也可直接写手册编号（${base} 起，自动换算）`;
}

// ---------------- 编解码器注册表 ----------------

export const CODECS: Codec[] = [
  {
    id: "wit",
    name: "WIT 写寄存器",
    group: "WIT",
    guide: "① 选寄存器 → ② 填值 → ③ 发送（自动先解锁、后保存，符合协议 10 秒上锁约束）",
    fields: [
      {
        key: "reg", label: "寄存器", kind: "select",
        options: WIT_REGS.map((r) => ({ v: r.addr, label: `${r.name}（0x${b2(r.addr)}）${r.desc}` })),
        def: "3",
        hint: "写指令必须先解锁，10s 内完成",
      },
      {
        key: "val", label: "写入值", kind: "int", def: "06",
        hint: "十进制或 0x 十六进制，0~65535",
      },
      {
        key: "seq", label: "指令序列", kind: "select", def: "1",
        options: [
          { v: 1, label: "解锁→写入→保存（推荐）" },
          { v: 0, label: "仅写入（需已解锁）" },
        ],
      },
    ],
    build: (v) => {
      const reg = WIT_REGS.find((r) => r.addr === parseIntInput(v.reg, "寄存器"));
      const addr = reg ? reg.addr : parseIntInput(v.reg, "寄存器");
      const val = parseIntInput(v.val, "写入值");
      if (val < 0 || val > 0xffff) throw new Error("「写入值」超出 0~65535");
      const seq = parseIntInput(v.seq || "1", "指令序列") === 1;
      const frames: string[] = [];
      if (seq) {
        frames.push(WIT_UNLOCK, hexBytes([0xff, 0xaa, addr, val & 0xff, (val >> 8) & 0xff]), WIT_SAVE);
      } else {
        frames.push(hexBytes([0xff, 0xaa, addr, val & 0xff, (val >> 8) & 0xff]));
      }
      const hint = reg?.hints?.find((h) => h.v === val);
      return {
        frames,
        parts: witWriteFrame(addr, val),
        note: `${reg ? reg.name : "0x" + b2(addr)}：${reg ? reg.desc : ""}${hint ? ` → ${hint.label}` : ""}${seq ? "（含解锁+保存）" : ""}`,
      };
    },
    summary: (v) => `写 ${v.reg}=${v.val}`,
  },
  {
    id: "ano-cmd",
    name: "匿名V7 功能触发",
    group: "匿名V7",
    guide: "① 选命令（附说明）→ ② 按提示填参数 → ③ 发送（SC+AC 校验自动计算）",
    fields: (v) => {
      const cmdIdx = parseIntInput(v.cmd || "0", "命令");
      const cmd = ANO_COMMANDS[cmdIdx] ?? ANO_COMMANDS[0];
      const paramFields: FactoryField[] = (cmd.params ?? []).map((p, i) => ({
        key: `p${i}`, label: p.label, kind: "int",
        def: String(p.def ?? 0),
        hint: `${p.type.toUpperCase()}${p.unit ? `，${p.unit}` : ""}${p.min !== undefined ? `，${p.min}~${p.max}` : ""}${p.hint ? `；${p.hint}` : ""}`,
      }));
      return [
        { key: "addr", label: "目标地址", kind: "int", def: "FF", hint: "发往哪个设备，广播 0xFF，飞控 0x05" },
        {
          key: "cmd", label: "命令", kind: "select",
          options: ANO_COMMANDS.map((c, i) => ({
            v: i,
            label: `${c.name}（CID ${b2(c.cid)} CMD ${b2(c.cmd[0])} ${b2(c.cmd[1])}）${c.note ? `〔${c.note}〕` : ""}`,
          })),
          def: "0",
        },
        ...paramFields,
      ];
    },
    build: (v) => {
      const addr = parseIntInput(v.addr || "FF", "目标地址");
      if (addr < 0 || addr > 0xff) throw new Error("「目标地址」超出 0~255");
      const cmd = ANO_COMMANDS[parseIntInput(v.cmd || "0", "命令")] ?? ANO_COMMANDS[0];
      // DATA = CID + CMD0..CMD9（共 11 字节），参数按类型小端填入 CMD2 起
      const data = new Array(11).fill(0);
      data[0] = cmd.cid;
      data[1] = cmd.cmd[0];
      data[2] = cmd.cmd[1];
      let off = 3;
      for (let i = 0; i < (cmd.params?.length ?? 0); i++) {
        const p = cmd.params![i];
        const raw = parseIntInput(v[`p${i}`] ?? String(p.def ?? 0), p.label);
        const size = p.type === "u8" ? 1 : p.type === "u16" ? 2 : 4;
        if (p.min !== undefined && raw < p.min) throw new Error(`「${p.label}」不能小于 ${p.min}`);
        if (p.max !== undefined && raw > p.max) throw new Error(`「${p.label}」不能大于 ${p.max}`);
        if (off + size > 11) throw new Error(`命令「${cmd.name}」参数超出帧容量`);
        // 补码填入（负数转无符号后小端写入）
        const u = raw < 0 ? raw + 0x100000000 : raw;
        for (let k = 0; k < size; k++) data[off + k] = (u >>> (8 * k)) & 0xff;
        off += size;
      }
      const { bytes, parts } = buildAnoFrame(addr, 0xe0, data);
      return {
        frames: [hexBytes(bytes)],
        parts,
        note: `${cmd.name}${cmd.note ? `（${cmd.note}）` : ""}；飞控收到后返回 ID=0x00 校验帧`,
      };
    },
    summary: (v) => ANO_COMMANDS[parseIntInput(v.cmd || "0", "命令")]?.name ?? "",
  },
  {
    id: "ano-param-read",
    name: "匿名V7 参数读取",
    group: "匿名V7",
    guide: "① 填目标地址（飞控 0x05）→ ② 填参数 ID → ③ 发送，等待设备返回 0xE2 参数帧",
    fields: [
      { key: "addr", label: "目标地址", kind: "int", def: "05", hint: "读哪个设备的参数，飞控 0x05" },
      { key: "pid", label: "参数 ID", kind: "int", def: "10", hint: "PAR_ID 序号（U16，小端）" },
    ],
    build: (v) => {
      const addr = parseIntInput(v.addr || "05", "目标地址");
      const pid = parseIntInput(v.pid, "参数 ID");
      if (addr < 0 || addr > 0xff) throw new Error("「目标地址」超出 0~255");
      if (pid < 0 || pid > 0xffff) throw new Error("「参数 ID」超出 0~65535");
      const data: number[] = [];
      pushLe(data, pid, 2);
      const { bytes, parts } = buildAnoFrame(addr, 0xe1, data);
      return {
        frames: [hexBytes(bytes)],
        parts,
        note: "读取后设备返回 0xE2 帧（PAR_ID + PAR_VAL）；未使用的参数返回 0x80000000",
      };
    },
    summary: (v) => `读参数 ${v.pid}`,
  },
  {
    id: "ano-param-write",
    name: "匿名V7 参数写入",
    group: "匿名V7",
    guide: "① 填目标地址 → ② 参数 ID → ③ 参数值（支持负数）→ ④ 发送，设备返回校验帧即写入成功",
    fields: [
      { key: "addr", label: "目标地址", kind: "int", def: "05", hint: "写哪个设备，飞控 0x05" },
      { key: "pid", label: "参数 ID", kind: "int", def: "10", hint: "PAR_ID 序号（U16，小端）" },
      { key: "pval", label: "参数值", kind: "int", def: "0", hint: "固定 Int32（S32，小端），支持负数" },
    ],
    build: (v) => {
      const addr = parseIntInput(v.addr || "05", "目标地址");
      const pid = parseIntInput(v.pid, "参数 ID");
      const pval = parseIntInput(v.pval, "参数值");
      if (addr < 0 || addr > 0xff) throw new Error("「目标地址」超出 0~255");
      if (pid < 0 || pid > 0xffff) throw new Error("「参数 ID」超出 0~65535");
      if (pval < -2147483648 || pval > 0xffffffff) throw new Error("「参数值」超出 Int32 范围");
      const data: number[] = [];
      pushLe(data, pid, 2);
      pushLeSigned(data, pval, 4);
      const { bytes, parts } = buildAnoFrame(addr, 0xe2, data);
      return {
        frames: [hexBytes(bytes)],
        parts,
        note: "写入后设备需返回 ID=0x00 校验帧确认",
      };
    },
    summary: (v) => `写参数 ${v.pid}=${v.pval}`,
  },
  {
    id: "modbus",
    name: "Modbus RTU",
    group: "Modbus",
    guide: "① 从站地址 → ② 功能码 → ③ 起始地址与数量/值 → ④ 发送（CRC16-Modbus 自动附加）",
    fields: (v) => {
      const fn = parseIntInput(v.fn || "3", "功能码");
      return [
        { key: "addr", label: "从站地址", kind: "int", def: "01", hint: "0~247（0 = 广播，写命令全员执行不回应答）" },
        { key: "fn", label: "功能码", kind: "select", options: MB_FNS, def: "3" },
        {
          key: "reg",
          label: "起始地址",
          kind: "int",
          def: "0",
          hint: mbAddrHint(fn),
        },
        mbValueField(fn),
      ];
    },
    build: (v) => {
      const bytes = buildRtuRequest(mbRequestFrom(v));
      return {
        frames: [hexBytes(bytes)],
        parts: mbParts(bytes, false),
        note: "CRC16-Modbus（低字节在前）已附加",
      };
    },
    summary: (v) => `${FC_LABEL[parseIntInput(v.fn || "3", "功能码")] ?? "Modbus"} ${v.reg ?? ""}`.trim(),
  },
  {
    id: "modbus-tcp",
    name: "Modbus TCP",
    group: "Modbus",
    guide: "① 单元地址 → ② 功能码 → ③ 起始地址与数量/值 → ④ 发送（MBAP 头自动组，无 CRC）",
    fields: (v) => {
      const fn = parseIntInput(v.fn || "3", "功能码");
      return [
        { key: "addr", label: "单元地址", kind: "int", def: "01", hint: "MBAP 的 Unit ID，即串口网关后端的从站号" },
        { key: "fn", label: "功能码", kind: "select", options: MB_FNS, def: "3" },
        { key: "reg", label: "起始地址", kind: "int", def: "0", hint: mbAddrHint(fn) },
        mbValueField(fn),
        { key: "txn", label: "事务号", kind: "int", def: "0", hint: "0 = 自动递增；响应按事务号配对请求" },
      ];
    },
    build: (v) => {
      const req = mbRequestFrom(v);
      const bytes = buildTcpRequest(req, parseIntInput(v.txn || "0", "事务号"));
      return {
        frames: [hexBytes(bytes)],
        parts: mbParts(bytes, true),
        note: "TCP 无 CRC：MBAP 长度域（含单元地址）即完整性来源；网关按事务号配对",
      };
    },
    summary: (v) => `ModbusTCP ${FC_LABEL[parseIntInput(v.fn || "3", "功能码")] ?? ""} ${v.reg ?? ""}`.trim(),
  },
  {
    id: "checksum",
    name: "校验工具",
    group: "校验工具",
    guide: "① 粘贴帧 HEX → ② 选校验算法 → ③ 选择是否追加校验再发送",
    fields: [
      { key: "data", label: "帧内容", kind: "hex", def: "AA FF E0 0B", hint: "HEX 字节，空格分隔" },
      {
        key: "algo", label: "校验算法", kind: "select", def: "0",
        options: [
          { v: 0, label: "SUM8 累加和" },
          { v: 1, label: "XOR8 异或" },
          { v: 2, label: "CRC16-Modbus" },
          { v: 3, label: "CRC16-CCITT-FALSE" },
          { v: 4, label: "CRC16-X25" },
          { v: 5, label: "匿名V7 SC+AC" },
        ],
      },
      {
        key: "append", label: "发送方式", kind: "select", def: "1",
        options: [
          { v: 1, label: "追加校验后发送" },
          { v: 0, label: "只发送原帧" },
        ],
      },
    ],
    build: (v) => {
      const bytes = parseHexBytes(v.data, "帧内容");
      const algo = parseIntInput(v.algo || "0", "校验算法");
      let check: number[];
      let note: string;
      if (algo === 0) {
        check = [sum8(bytes)];
        note = "SUM8";
      } else if (algo === 1) {
        check = [xor8(bytes)];
        note = "XOR8";
      } else if (algo === 2) {
        const c = crc16("modbus", bytes);
        check = [c & 0xff, (c >> 8) & 0xff];
        note = "CRC16-Modbus（低在前）";
      } else if (algo === 3) {
        const c = crc16("ccitt-false", bytes);
        check = [(c >> 8) & 0xff, c & 0xff];
        note = "CRC16-CCITT-FALSE（高在前）";
      } else if (algo === 4) {
        const c = crc16("x25", bytes);
        check = [c & 0xff, (c >> 8) & 0xff];
        note = "CRC16-X25（低在前）";
      } else {
        const { sc, ac } = anoCheck(bytes);
        check = [sc, ac];
        note = "匿名V7 SC+AC";
      }
      const append = parseIntInput(v.append || "1", "发送方式") === 1;
      const frames = [hexBytes(append ? [...bytes, ...check] : bytes)];
      const parts: FramePart[] = [
        { text: hexBytes(bytes), label: "原帧", cls: "data" },
        { text: hexBytes(check), label: note, cls: "check" },
      ];
      return {
        frames: append ? frames : [hexBytes(bytes)],
        parts,
        note: `${note} = ${hexBytes(check)}${append ? "，已追加发送" : "（仅计算，未追加）"}`,
      };
    },
    summary: (v) => v.data.slice(0, 20),
  },
];

// ---------------- 用户自定义协议（帧模板） ----------------

export type UserSeg =
  | { kind: "fixed"; label: string; bytes: string }
  | {
      kind: "var";
      name: string;
      type: "u8" | "u16" | "u32" | "s16" | "s32" | "f32" | "ascii";
      le: boolean;
      def?: string;
    }
  | { kind: "len" }
  | { kind: "check"; algo: "sum8" | "xor8" | "sum16" | "crc16-modbus" | "crc16-ccitt" | "crc16-x25" | "ano-scac"; be: boolean };

export interface UserCodecDef {
  id: string;
  name: string;
  note: string;
  segs: UserSeg[];
  createdAt: number;
}

/** 编辑器校验：返回第一条错误信息，null 表示合法 */
export function validateUserCodec(def: { name: string; segs: UserSeg[] }): string | null {
  if (!def.name.trim()) return "请填写协议名称";
  if (def.segs.length < 2) return "至少需要 2 个段（例如帧头 + 校验）";
  const names = new Set<string>();
  let checkCount = 0;
  for (const s of def.segs) {
    if (s.kind === "fixed") {
      try {
        parseHexBytes(s.bytes, s.label || "固定字节");
      } catch (e) {
        return `${s.label || "固定字节"}：${String(e).replace(/^Error:\s*/, "")}`;
      }
    } else if (s.kind === "var") {
      if (!s.name.trim()) return "变量字段的名称不能为空";
      if (names.has(s.name)) return `变量名「${s.name}」重复`;
      names.add(s.name);
    } else if (s.kind === "check") {
      checkCount++;
      if (checkCount > 1) return "校验段只能有一个";
    }
  }
  if (def.segs[0]?.kind === "check") return "校验段不能放在第一个（前面至少要有一个字节段）";
  return null;
}

const VAR_RANGE: Record<string, [number, number]> = {
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  s16: [-32768, 32767],
  s32: [-2147483648, 2147483647],
  f32: [-Infinity, Infinity],
  ascii: [0, 0],
};

/** 按类型/字节序编码数值段 */
function encodeVar(type: string, le: boolean, n: number): number[] {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  switch (type) {
    case "u8": return [n & 0xff];
    case "u16": dv.setUint16(0, n, le); return Array.from(new Uint8Array(buf, 0, 2));
    case "u32": dv.setUint32(0, n, le); return Array.from(new Uint8Array(buf, 0, 4));
    case "s16": dv.setInt16(0, n, le); return Array.from(new Uint8Array(buf, 0, 2));
    case "s32": dv.setInt32(0, n, le); return Array.from(new Uint8Array(buf, 0, 4));
    case "f32": dv.setFloat32(0, n, le); return Array.from(new Uint8Array(buf, 0, 4));
    default: return [n & 0xff];
  }
}

/** 组用户模板帧 */
export function buildUserFrame(def: UserCodecDef, v: Record<string, string>): FactoryResult {
  const segs = def.segs;
  const checkIdx = segs.findIndex((s) => s.kind === "check");
  // 先解析全部变量值（任何一个非法都在发送前报错）
  const varBytes = new Map<string, number[]>();
  for (const s of segs) {
    if (s.kind !== "var") continue;
    const raw = (v[`f_${s.name}`] ?? s.def ?? "").trim();
    if (s.type === "ascii") {
      if (!raw) throw new Error(`请填写「${s.name}」`);
      varBytes.set(s.name, Array.from(new TextEncoder().encode(raw)));
    } else {
      const n = parseIntInput(raw || s.def || "0", s.name);
      const [min, max] = VAR_RANGE[s.type];
      if (n < min || n > max) throw new Error(`「${s.name}」超出范围 ${min}~${max === Infinity ? "∞" : max}`);
      varBytes.set(s.name, encodeVar(s.type, s.le, n));
    }
  }
  // 逐段生成字节块（跳过校验段，最后统一计算）
  type Chunk = { bytes: number[]; label: string; cls: FramePart["cls"] };
  const chunks: Chunk[] = [];
  const lenPos: number[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i === checkIdx) continue;
    if (s.kind === "fixed") {
      const bytes = parseHexBytes(s.bytes, s.label || "固定字节");
      chunks.push({ bytes, label: s.label || "固定", cls: "head" });
    } else if (s.kind === "var") {
      chunks.push({ bytes: varBytes.get(s.name)!, label: s.name, cls: "data" });
    } else if (s.kind === "len") {
      lenPos.push(chunks.length);
      chunks.push({ bytes: [0], label: "长度", cls: "len" });
    }
  }
  // 长度段 = 该段之后到帧尾（校验段不计入）的字节数
  for (const idx of lenPos) {
    const count = chunks.slice(idx + 1).reduce((a, c) => a + c.bytes.length, 0);
    if (count > 255) throw new Error("长度段溢出：长度段之后的数据超过 255 字节");
    chunks[idx].bytes = [count];
  }
  // 组装 + 校验
  const all: number[] = [];
  const parts: FramePart[] = [];
  let ci = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i === checkIdx) {
      const cs = s as Extract<UserSeg, { kind: "check" }>;
      const algo = cs.algo;
      let check: number[];
      if (algo === "ano-scac") {
        const { sc, ac } = anoCheck(all);
        check = [sc, ac];
      } else if (algo === "crc16-modbus" || algo === "crc16-ccitt" || algo === "crc16-x25") {
        const c = crc16(algo === "crc16-modbus" ? "modbus" : algo === "crc16-ccitt" ? "ccitt-false" : "x25", all);
        check = cs.be ? [(c >> 8) & 0xff, c & 0xff] : [c & 0xff, (c >> 8) & 0xff];
      } else if (algo === "sum16") {
        const s16 = all.reduce((a, b) => a + b, 0) & 0xffff;
        check = cs.be ? [(s16 >> 8) & 0xff, s16 & 0xff] : [s16 & 0xff, (s16 >> 8) & 0xff];
      } else if (algo === "xor8") {
        check = [xor8(all)];
      } else {
        check = [sum8(all)];
      }
      parts.push({ text: hexBytes(check), label: `校验·${algo}`, cls: "check" });
      all.push(...check);
      continue;
    }
    const chunk = chunks[ci++];
    parts.push({ text: hexBytes(chunk.bytes), label: chunk.label, cls: chunk.cls });
    all.push(...chunk.bytes);
  }
  if (!all.length) throw new Error("帧内容为空，请先添加段");
  return { frames: [hexBytes(all)], parts };
}

/** 用户模板 → 通用编解码器（id 前缀 user:） */
export function userCodecToCodec(def: UserCodecDef): Codec {
  const varSegs = def.segs.filter((s): s is Extract<UserSeg, { kind: "var" }> => s.kind === "var");
  return {
    id: `user:${def.id}`,
    name: def.name,
    group: "我的协议",
    guide: def.note || "按模板逐字段填值 → 发送",
    fields: varSegs.map((s) => ({
      key: `f_${s.name}`,
      label: s.name,
      kind: s.type === "ascii" ? "text" : "int",
      def: s.def ?? "",
      hint:
        s.type === "ascii"
          ? "文本，按 UTF-8 编码发送"
          : `${s.type.toUpperCase()}·${s.le ? "小端" : "大端"}，支持十进制或 0x 十六进制`,
    })),
    build: (v) => buildUserFrame(def, v),
    summary: (v) =>
      varSegs.map((s) => `${s.name}=${v[`f_${s.name}`] ?? s.def ?? ""}`).join(" ").slice(0, 40),
  };
}
