import type { FieldDef, FrameTemplate } from "../../ipc/types";
import { getGroupMeta, importTemplates } from "../protocol/templateStore";

export interface PresetDef {
  key: string;
  name: string;
  tag: string;
  desc: string;
  build: () => FrameTemplate[];
}

export function applyPreset(def: PresetDef): void {
  importTemplates(def.build(), def.key);
}

export function stripNameSuffix(n: string): string {
  return n.replace(/\s*\(\d+\)\s*$/, "");
}

const KNOWN_LEGACY: Record<string, string> = {
  "演示-环境帧": "demo",
  "演示-姿态帧": "demo",
  "逗号分隔数据帧": "csv-delim",
  "逗号分隔·ASCII数值": "csv-delim",
};

let knownBuilt: Map<string, string> | null = null;
function knownNames(): Map<string, string> {
  if (!knownBuilt) {
    knownBuilt = new Map(Object.entries(KNOWN_LEGACY));
    for (const p of PRESETS) {
      for (const t of p.build()) knownBuilt.set(t.name, p.key);
    }
  }
  return knownBuilt;
}

export function presetGroupKey(t: FrameTemplate): string | null {
  if (t.presetKey) return t.presetKey;
  if (t.groupKey) return t.groupKey;
  return knownNames().get(stripNameSuffix(t.name)) ?? null;
}

export function groupDisplayName(key: string, member: FrameTemplate): string {
  if (key === "demo") return "演示模板";
  const def = PRESETS.find((p) => p.key === key);
  if (def) return def.name;
  const meta = getGroupMeta(key);
  if (meta?.name) return meta.name;
  return stripNameSuffix(member.name);
}

let uid = 0;
function nid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(uid++).toString(36)}`;
}

function f(
  name: string,
  role: FieldDef["role"],
  offset: number,
  type: FieldDef["type"],
  color: string,
  extra?: Partial<FieldDef>,
): FieldDef {
  return {
    id: nid("f"),
    name,
    role,
    offset,
    type,
    endian: "little",
    color,
    ...extra,
  };
}

const C_ADDR = "#d29922";
const C_ID = "#f0883e";
const C_LEN = "#bc8cff";
const C_DATA = "#3fb950";

export const ANO_V7 = "ano-v7";
export const MODBUS_RTU = "modbus-rtu";
export const MODBUS_TCP = "modbus-tcp";
export const NMEA_0183 = "nmea-0183";
export const CSV_DELIM = "csv-delim";
export const WIT_IMU = "wit-imu";

function v7Tpl(
  fidVal: number,
  name: string,
  color: string,
  fields: FieldDef[],
): FrameTemplate {
  const fs = [...v7Head(), ...fields];
  fs[1] = { ...fs[1], disc: [fidVal] };
  return {
    id: nid("v7"),
    name: `V7·0x${fidVal.toString(16).toUpperCase().padStart(2, "0")}${name}`,
    color,
    enabled: true,
    boundary: {
      mode: "lengthField",
      headerBytes: [0xaa],
      lengthOffset: 3,
      lengthSize: 1,
      lengthEndian: "little",
      lengthAdjust: 6,
      maxLength: 64,
    },
    checksum: { algo: "sumadd", coverageStart: 0, coverageEnd: -2, endian: "little" },
    fields: fs,
  };
}

function v7Head(): FieldDef[] {
  return [
    f("目标地址", "addr", 1, "uint8", C_ADDR),
    f("功能码", "id", 2, "uint8", C_ID),
    f("数据长度", "length", 3, "uint8", C_LEN),
  ];
}

const C_GYRO = "#db61a2";
const C_MAG = "#c678dd";
const C_FG = "#f0883e";

/* ---------------- Modbus RTU 簇 ----------------
 * 帧头统一写成 [通配从站地址, 功能码]：headerMask 首字节 0x00 = 任意值，
 * 一条模板即可吃下总线上所有从站（含广播地址 0），不必逐台改帧头。
 * 注意：帧首被通配时引擎会关闭「帧中途重锚定」，改由长度域 + CRC 定帧。
 */
const MB_CRC = { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2, endian: "little" } as const;

function mbHead(): FieldDef[] {
  return [
    f("设备地址", "addr", 0, "uint8", C_ADDR),
    f("功能码", "id", 1, "uint8", C_ID),
  ];
}

/** 读寄存器响应（FC03/04）：长度域 = 字节数，寄存器区展开为 寄存器1..N（大端） */
function mbResp(fc: number, name: string, color: string, elem: "uint16"): FrameTemplate {
  return {
    id: nid("mb"),
    name: `Modbus·${name}`,
    color,
    enabled: true,
    boundary: {
      mode: "lengthField",
      headerBytes: [0x00, fc],
      headerMask: [0x00, 0xff],
      lengthOffset: 2,
      lengthSize: 1,
      lengthEndian: "big",
      lengthAdjust: 5,
      maxLength: 280,
    },
    checksum: { ...MB_CRC },
    fields: [
      ...mbHead(),
      f("字节数", "length", 2, "uint8", C_LEN),
      f("寄存器", "data", 3, elem, C_DATA, { endian: "big", spanTail: true, spanElem: elem }),
    ],
  };
}

/** 读线圈/离散输入响应（FC01/02）：长度域是「位数」→ 倍率 0.125 换算成字节 */
function mbCoil(fc: number, name: string, color: string): FrameTemplate {
  return {
    id: nid("mb"),
    name: `Modbus·${name}`,
    color,
    enabled: true,
    boundary: {
      mode: "lengthField",
      headerBytes: [0x00, fc],
      headerMask: [0x00, 0xff],
      lengthOffset: 2,
      lengthSize: 1,
      lengthEndian: "big",
      lengthAdjust: 5,
      lengthScale: 0.125,
      maxLength: 280,
    },
    checksum: { ...MB_CRC },
    fields: [
      ...mbHead(),
      f("位数", "length", 2, "uint8", C_LEN),
      f("线圈字节", "data", 3, "uint8", C_DATA, { spanTail: true, spanElem: "uint8" }),
    ],
  };
}

/** 定长 8 字节帧（读请求 / 写单点请求与回显）：地址 FC 量1(2) 量2(2) CRC(2) */
function mbReq8(
  fc: number,
  name: string,
  color: string,
  lbl1 = "起始地址",
  lbl2 = "数量",
): FrameTemplate {
  return {
    id: nid("mb"),
    name: `Modbus·${name}`,
    color,
    enabled: true,
    boundary: {
      mode: "fixedLength",
      headerBytes: [0x00, fc],
      headerMask: [0x00, 0xff],
      fixedLength: 8,
      maxLength: 64,
    },
    checksum: { ...MB_CRC },
    fields: [
      ...mbHead(),
      f(lbl1, "data", 2, "uint16", C_LEN, { endian: "big" }),
      f(lbl2, "data", 4, "uint16", C_LEN, { endian: "big" }),
    ],
  };
}

/** 写多点请求（FC15/16）：长度域 = 数据字节数 @6，总长 = 字节数 + 9 */
function mbWriteMulti(
  fc: number,
  name: string,
  color: string,
  elem: "uint8" | "uint16",
): FrameTemplate {
  return {
    id: nid("mb"),
    name: `Modbus·${name}`,
    color,
    enabled: true,
    boundary: {
      mode: "lengthField",
      headerBytes: [0x00, fc],
      headerMask: [0x00, 0xff],
      lengthOffset: 6,
      lengthSize: 1,
      lengthEndian: "big",
      lengthAdjust: 9,
      maxLength: 280,
    },
    checksum: { ...MB_CRC },
    fields: [
      ...mbHead(),
      f("起始地址", "data", 2, "uint16", C_LEN, { endian: "big" }),
      f("数量", "data", 4, "uint16", C_LEN, { endian: "big" }),
      f("字节数", "length", 6, "uint8", C_LEN),
      f("写入数据", "data", 7, elem, C_DATA, { endian: "big", spanTail: true, spanElem: elem }),
    ],
  };
}

/** 写多点回显（FC15/16 响应）：定长 8，只有起始与数量 */
function mbEcho(fc: number, name: string, color: string): FrameTemplate {
  return mbReq8(fc, name, color, "起始地址", "数量");
}

/** 异常响应：帧头次字节按位掩码要求 bit7=1 → 一条模板吃下任意功能码的异常 */
function mbException(): FrameTemplate {
  return {
    id: nid("mb"),
    name: "Modbus·异常响应",
    color: "#e5534b",
    enabled: true,
    boundary: {
      mode: "fixedLength",
      headerBytes: [0x00, 0x80],
      headerMask: [0x00, 0x80],
      fixedLength: 5,
      maxLength: 64,
    },
    checksum: { ...MB_CRC },
    fields: [
      f("设备地址", "addr", 0, "uint8", C_ADDR),
      f("异常功能码", "id", 1, "uint8", C_ID),
      f("异常码", "data", 2, "uint8", "#e5534b"),
    ],
  };
}

/* ---------------- Modbus TCP 簇 ----------------
 * ADU = MBAP(事务2 + 协议2 + 长度2 + 单元1) + PDU。协议标识恒 0x0000 → 用它当帧头锚点
 * （首两字节是事务号，必须通配）。TCP 没有 CRC，长度域就是唯一自检，因此主站请求与
 * 从站响应的区分靠 MBAP 长度的奇偶：
 *   读/写请求 FC01–06、写多回显 → 长度恒 6（偶）
 *   读响应、写多请求            → 长度 = 3 + 2N（奇）
 * 用识别位的掩码 0x01 判最低位即可精确分开，避免两条模板同时"有效"地解出错误字段。
 */
const MBTCP_LEN_DISC_EVEN = { offset: 5, value: [0x00], mask: [0x01] };
const MBTCP_LEN_DISC_ODD = { offset: 5, value: [0x01], mask: [0x01] };

function mbTcpHead(): FieldDef[] {
  return [
    f("事务标识", "data", 0, "uint16", C_ADDR, { endian: "big" }),
    f("协议标识", "data", 2, "uint16", C_ADDR, { endian: "big" }),
    f("报文长度", "length", 4, "uint16", C_LEN, { endian: "big" }),
    f("单元地址", "addr", 6, "uint8", C_ADDR),
    f("功能码", "id", 7, "uint8", C_ID),
  ];
}

/** TCP 通用帧：MBAP 长度定帧（总长 = 长度值 + 6），功能码用识别位区分 */
function mbTcp(
  fc: number,
  name: string,
  color: string,
  extraFields: FieldDef[],
  lenDisc: { offset: number; value: number[]; mask: number[] } | null,
): FrameTemplate {
  const discs = [
    // 功能码：0x80 是"bit7=1"的位掩码语义（任意功能码的异常响应），其余按精确值匹配
    fc === 0x80
      ? { offset: 7, value: [0x80], mask: [0x80] }
      : { offset: 7, value: [fc], mask: [0xff] },
  ];
  if (lenDisc) discs.push(lenDisc);
  return {
    id: nid("mbt"),
    name: `ModbusTCP·${name}`,
    color,
    enabled: true,
    boundary: {
      mode: "lengthField",
      headerBytes: [0x00, 0x00, 0x00, 0x00],
      headerMask: [0x00, 0x00, 0xff, 0xff],
      lengthOffset: 4,
      lengthSize: 2,
      lengthEndian: "big",
      lengthAdjust: 6,
      maxLength: 260,
      discs,
    },
    checksum: null,
    fields: [...mbTcpHead(), ...extraFields],
  };
}

function mbTcpCluster(): FrameTemplate[] {
  const startQty = (a: string, b: string): FieldDef[] => [
    f(a, "data", 8, "uint16", C_LEN, { endian: "big" }),
    f(b, "data", 10, "uint16", C_LEN, { endian: "big" }),
  ];
  const regs = (lbl: string, elem: "uint16" | "uint8", lenOff: number): FieldDef[] => [
    f(lbl, "length", lenOff, "uint8", C_LEN),
    f(elem === "uint16" ? "寄存器" : "线圈字节", "data", lenOff + 1, elem, C_DATA, {
      endian: "big",
      spanTail: true,
      spanElem: elem,
    }),
  ];
  return [
    // 读请求（长度恒 6）与读响应（长度奇）
    mbTcp(0x03, "读保持寄存器请求", "#d29922", startQty("起始地址", "数量"), MBTCP_LEN_DISC_EVEN),
    mbTcp(0x04, "读输入寄存器请求", "#e3b341", startQty("起始地址", "数量"), MBTCP_LEN_DISC_EVEN),
    mbTcp(0x03, "读保持寄存器响应", "#3fb950", regs("字节数", "uint16", 8), MBTCP_LEN_DISC_ODD),
    mbTcp(0x04, "读输入寄存器响应", "#39c5cf", regs("字节数", "uint16", 8), MBTCP_LEN_DISC_ODD),
    mbTcp(0x01, "读线圈请求", "#f0883e", startQty("起始地址", "数量"), MBTCP_LEN_DISC_EVEN),
    mbTcp(0x02, "读离散输入请求", "#a5d6ff", startQty("起始地址", "数量"), MBTCP_LEN_DISC_EVEN),
    mbTcp(0x01, "读线圈响应", "#db61a2", regs("位数", "uint8", 8), MBTCP_LEN_DISC_ODD),
    mbTcp(0x02, "读离散输入响应", "#7ee787", regs("位数", "uint8", 8), MBTCP_LEN_DISC_ODD),
    // 写单点：请求与响应完全同构（长度 6）
    mbTcp(0x05, "写单个线圈", "#ffa657", startQty("输出地址", "输出值"), MBTCP_LEN_DISC_EVEN),
    mbTcp(0x06, "写单个寄存器", "#ff7b72", startQty("寄存器地址", "设定值"), MBTCP_LEN_DISC_EVEN),
    // 写多点：请求带数据区（长度奇），回显只有起始+数量（长度 6）
    mbTcp(
      0x0f,
      "写多个线圈",
      "#bc8cff",
      [...startQty("起始地址", "数量"), ...regs("字节数", "uint8", 12)],
      MBTCP_LEN_DISC_ODD,
    ),
    mbTcp(
      0x10,
      "写多个寄存器",
      "#c678dd",
      [...startQty("起始地址", "数量"), ...regs("字节数", "uint16", 12)],
      MBTCP_LEN_DISC_ODD,
    ),
    mbTcp(0x0f, "写多个线圈回显", "#8957e5", startQty("起始地址", "数量"), MBTCP_LEN_DISC_EVEN),
    mbTcp(0x10, "写多个寄存器回显", "#6e40c9", startQty("起始地址", "数量"), MBTCP_LEN_DISC_EVEN),
    // 异常响应：功能码位掩码 bit7（长度 3，奇偶已被功能码约束覆盖）
    mbTcp(0x80, "异常响应", "#e5534b", [f("异常码", "data", 8, "uint8", "#e5534b")], null),
  ];
}

export const PRESETS: PresetDef[] = [
  {
    key: ANO_V7,
    name: "匿名 V7 飞控协议",
    tag: "飞控",
    desc:
      "ANO V7 主流帧型全集（0x01–0x0F / 0x21 / 0x30 / 0x32–0x34 / 0x40 / 0x41）：AA 帧头 + 目标地址 + 功能码 + LEN + DATA(小端) + SC + AC。" +
      "帧型由「功能码识别位」自动区分（同栈全部启用也不会重复解析）；双重校验 sumadd 内置。",
    build: () => [
      v7Tpl(0x01, "惯性传感", "#39c5cf", [
        f("ACC_X", "data", 4, "int16", C_DATA),
        f("ACC_Y", "data", 6, "int16", C_DATA),
        f("ACC_Z", "data", 8, "int16", C_DATA),
        f("GYR_X", "data", 10, "int16", C_GYRO),
        f("GYR_Y", "data", 12, "int16", C_GYRO),
        f("GYR_Z", "data", 14, "int16", C_GYRO),
        f("震动状态", "data", 16, "uint8", C_LEN),
      ]),
      v7Tpl(0x02, "罗盘气压温度", "#c678dd", [
        f("MAG_X", "data", 4, "int16", C_MAG),
        f("MAG_Y", "data", 6, "int16", C_MAG),
        f("MAG_Z", "data", 8, "int16", C_MAG),
        f("ALT_BAR", "data", 10, "int32", C_DATA, { unit: "cm" }),
        f("TMP", "data", 14, "int16", C_DATA, { scale: 0.1, unit: "°C" }),
        f("气压状态", "data", 16, "uint8", C_LEN),
        f("罗盘状态", "data", 17, "uint8", C_LEN),
      ]),
      v7Tpl(0x03, "欧拉姿态", "#3fb950", [
        f("横滚 ROL", "data", 4, "int16", C_DATA, { scale: 0.01, unit: "°" }),
        f("俯仰 PIT", "data", 6, "int16", C_DATA, { scale: 0.01, unit: "°" }),
        f("航向 YAW", "data", 8, "int16", C_DATA, { scale: 0.01, unit: "°" }),
        f("融合状态", "data", 10, "uint8", C_LEN),
      ]),
      v7Tpl(0x04, "四元数姿态", "#3fb950", [
        f("Q0", "data", 4, "int16", C_DATA, { scale: 0.0001 }),
        f("Q1", "data", 6, "int16", C_DATA, { scale: 0.0001 }),
        f("Q2", "data", 8, "int16", C_DATA, { scale: 0.0001 }),
        f("Q3", "data", 10, "int16", C_DATA, { scale: 0.001 }),
        f("融合状态", "data", 12, "uint8", C_LEN),
      ]),
      v7Tpl(0x05, "高度数据", "#39c5cf", [
        f("ALT_FU", "data", 4, "int32", C_DATA, { unit: "cm" }),
        f("ALT_ADD", "data", 8, "int32", C_DATA, { unit: "cm" }),
        f("测距状态", "data", 12, "uint8", C_LEN),
      ]),
      v7Tpl(0x06, "运行模式", "#d29922", [
        f("MODE", "data", 4, "uint8", C_LEN),
        f("LOCKED", "data", 5, "uint8", C_LEN),
        f("CID", "data", 6, "uint8", C_LEN),
        f("CMD0", "data", 7, "uint8", C_LEN),
        f("CMD1", "data", 8, "uint8", C_LEN),
      ]),
      v7Tpl(0x07, "飞行速度", "#3fb950", [
        f("SPEED_X", "data", 4, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Y", "data", 6, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Z", "data", 8, "int16", C_DATA, { unit: "cm/s" }),
      ]),
      v7Tpl(0x08, "位置偏移", "#39c5cf", [
        f("POS_X", "data", 4, "int32", C_DATA, { unit: "cm" }),
        f("POS_Y", "data", 8, "int32", C_DATA, { unit: "cm" }),
      ]),
      v7Tpl(0x09, "风速估计", "#39c5cf", [
        f("WIND_X", "data", 4, "int16", C_DATA, { unit: "cm/s" }),
        f("WIND_Y", "data", 6, "int16", C_DATA, { unit: "cm/s" }),
      ]),
      v7Tpl(0x0a, "目标姿态", "#f0883e", [
        f("TAR_ROL", "data", 4, "int16", C_FG, { scale: 0.01, unit: "°" }),
        f("TAR_PIT", "data", 6, "int16", C_FG, { scale: 0.01, unit: "°" }),
        f("TAR_YAW", "data", 8, "int16", C_FG, { scale: 0.01, unit: "°" }),
      ]),
      v7Tpl(0x0b, "目标速度", "#f0883e", [
        f("TAR_SPEED_X", "data", 4, "int16", C_FG, { unit: "cm/s" }),
        f("TAR_SPEED_Y", "data", 6, "int16", C_FG, { unit: "cm/s" }),
        f("TAR_SPEED_Z", "data", 8, "int16", C_FG, { unit: "cm/s" }),
      ]),
      v7Tpl(0x0c, "回航信息", "#d29922", [
        f("R_A", "data", 4, "int16", C_ADDR, { scale: 0.1, unit: "°" }),
        f("R_D", "data", 6, "uint16", C_DATA, { unit: "m" }),
      ]),
      v7Tpl(0x0d, "电压电流", "#e5534b", [
        f("VOTAGE", "data", 4, "uint16", C_DATA, { scale: 0.01, unit: "V" }),
        f("CURRENT", "data", 6, "uint16", C_DATA, { scale: 0.01, unit: "A" }),
      ]),
      v7Tpl(0x0e, "外接模块状态", "#bc8cff", [
        f("STA_G_VEL", "data", 4, "uint8", C_LEN),
        f("STA_G_POS", "data", 5, "uint8", C_LEN),
        f("STA_GPS", "data", 6, "uint8", C_LEN),
        f("STA_ALT_ADD", "data", 7, "uint8", C_LEN),
      ]),
      v7Tpl(0x0f, "RGB 亮度", "#db61a2", [
        f("BRI_R", "data", 4, "uint8", C_GYRO),
        f("BRI_G", "data", 5, "uint8", C_DATA),
        f("BRI_B", "data", 6, "uint8", C_DATA),
        f("BRI_A", "data", 7, "uint8", C_DATA),
      ]),
      v7Tpl(0x21, "飞控输出控制", "#f0883e", [
        f("CTRL_ROL", "data", 4, "int16", C_FG),
        f("CTRL_PIT", "data", 6, "int16", C_FG),
        f("CTRL_THR", "data", 8, "int16", C_FG),
        f("CTRL_YAW", "data", 10, "int16", C_FG),
      ]),
      v7Tpl(0x30, "GPS 定位", "#bc8cff", [
        f("FIX_STA", "data", 4, "uint8", C_LEN),
        f("S_NUM", "data", 5, "uint8", C_LEN),
        f("经度 LNG", "data", 6, "int32", C_DATA, { scale: 1e-7, unit: "°" }),
        f("纬度 LAT", "data", 10, "int32", C_DATA, { scale: 1e-7, unit: "°" }),
        f("ALT_GPS", "data", 14, "int32", C_DATA, { unit: "cm" }),
        f("N_SPE", "data", 18, "int16", C_DATA, { unit: "cm/s" }),
        f("E_SPE", "data", 20, "int16", C_DATA, { unit: "cm/s" }),
        f("D_SPE", "data", 22, "int16", C_DATA, { unit: "cm/s" }),
        f("PDOP", "data", 24, "uint8", C_LEN, { scale: 0.01 }),
        f("SACC", "data", 25, "uint8", C_LEN, { scale: 0.01, unit: "m" }),
        f("VACC", "data", 26, "uint8", C_LEN, { scale: 0.01, unit: "m" }),
      ]),
      v7Tpl(0x32, "通用位置", "#bc8cff", [
        f("POS_X", "data", 4, "int32", C_DATA, { unit: "cm" }),
        f("POS_Y", "data", 8, "int32", C_DATA, { unit: "cm" }),
        f("POS_Z", "data", 12, "int32", C_DATA, { unit: "cm" }),
      ]),
      v7Tpl(0x33, "通用速度", "#39c5cf", [
        f("SPEED_X", "data", 4, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Y", "data", 6, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Z", "data", 8, "int16", C_DATA, { unit: "cm/s" }),
      ]),
      v7Tpl(0x34, "通用测距", "#d29922", [
        f("DIRECTION", "data", 4, "uint8", C_LEN),
        f("ANGLE", "data", 5, "uint16", C_DATA, { unit: "°" }),
        f("DIST", "data", 7, "uint32", C_DATA, { unit: "cm" }),
      ]),
      v7Tpl(0x40, "遥控器数据", "#f0883e", [
        f("THR", "data", 4, "int16", C_FG),
        f("YAW", "data", 6, "int16", C_FG),
        f("ROL", "data", 8, "int16", C_FG),
        f("PIT", "data", 10, "int16", C_FG),
        f("AUX1", "data", 12, "int16", C_FG),
        f("AUX2", "data", 14, "int16", C_FG),
        f("AUX3", "data", 16, "int16", C_FG),
        f("AUX4", "data", 18, "int16", C_FG),
        f("AUX5", "data", 20, "int16", C_FG),
        f("AUX6", "data", 22, "int16", C_FG),
      ]),
      v7Tpl(0x41, "实时控制", "#f0883e", [
        f("CTRL_ROL", "data", 4, "int16", C_FG, { scale: 0.01, unit: "°" }),
        f("CTRL_PIT", "data", 6, "int16", C_FG, { scale: 0.01, unit: "°" }),
        f("CTRL_THR", "data", 8, "int16", C_FG, { scale: 0.1, unit: "%" }),
        f("CTRL_YAWDPS", "data", 10, "int16", C_FG, { unit: "°/s" }),
        f("CTRL_SPD_X", "data", 12, "int16", C_FG, { unit: "cm/s" }),
        f("CTRL_SPD_Y", "data", 14, "int16", C_FG, { unit: "cm/s" }),
        f("CTRL_SPD_Z", "data", 16, "int16", C_FG, { unit: "cm/s" }),
      ]),
    ],
  },
  {
    key: CSV_DELIM,
    name: "自适应文本帧(JustFloat)",
    tag: "通用",
    desc:
      "VOFA+ JustFloat 式文本帧：无帧头，按分隔符（默认逗号）自适应切分为 通道1…通道N，" +
      "每帧段数可变；行尾 \\n 结帧。字段属性中可改分隔符（如 \\ ; 空格）与元素类型（float/uint8…）。",
    build: () => [
      {
        id: nid("csv"),
        name: "逗号分隔·自适应数值",
        color: "#39c5cf",
        enabled: true,
        boundary: {
          mode: "footer",
          headerBytes: [],
          footerBytes: [0x0a],
          maxLength: 512,
        },
        checksum: null,
        fields: [
          f("通道", "data", 0, "csv", C_DATA, { csvDelim: ",", csvType: "float32" }),
        ],
      },
    ],
  },
  {
    key: MODBUS_RTU,
    name: "Modbus RTU",
    tag: "工业",
    desc:
      "Modbus RTU 全簇（FC01–06 / 15 / 16 的请求·响应·回显 + 任意功能码异常响应）：" +
      "帧头写 `?? FC` —— 首字节通配 = 总线上任意从站（含广播 0）都能解，不必逐台改地址。" +
      "读响应按 byteCount 定长并把寄存器区展开成 寄存器1..N（大端 uint16，可绘图/脚本引用）；" +
      "读线圈响应按「位数」换算字节数（倍率 0.125）。CRC16-Modbus 小端已内置，" +
      "主站请求与从站响应共用功能码，由引擎跨模板互相解释、不再产生噪声坏帧。",
    build: () => [
      // —— 读响应：长度域 = 字节数，总长 = 字节数 + 5（地址+FC+BC+CRC2）——
      mbResp(0x03, "读保持寄存器响应", "#3fb950", "uint16"),
      mbResp(0x04, "读输入寄存器响应", "#39c5cf", "uint16"),
      // —— 读响应：长度域是「位数」，总长 = ⌈位数/8⌉ + 5 ——
      mbCoil(0x01, "读线圈响应", "#db61a2"),
      mbCoil(0x02, "读离散输入响应", "#a5d6ff"),
      // —— 读请求（固定 8 字节：地址 FC 起始(2) 数量(2) CRC2）——
      mbReq8(0x03, "读保持寄存器请求", "#d29922"),
      mbReq8(0x04, "读输入寄存器请求", "#e3b341"),
      // —— 写单点：请求与响应同构（回显），一条模板双向通用 ——
      mbReq8(0x05, "写单个线圈", "#f0883e", "输出地址", "输出值"),
      mbReq8(0x06, "写单个寄存器", "#ffa657", "寄存器地址", "设定值"),
      // —— 写多点：请求带数据区（长度域在字节数 @6），响应只回显起始+数量 ——
      mbWriteMulti(0x0f, "写多个线圈", "#bc8cff", "uint8"),
      mbWriteMulti(0x10, "写多个寄存器", "#c678dd", "uint16"),
      mbEcho(0x0f, "写多个线圈回显", "#8957e5"),
      mbEcho(0x10, "写多个寄存器回显", "#6e40c9"),
      // —— 异常响应：帧头次字节按位掩码 bit7，一条吃下所有功能码的异常 ——
      mbException(),
    ],
  },
  {
    key: MODBUS_TCP,
    name: "Modbus TCP",
    tag: "工业",
    desc:
      "Modbus TCP（端口 502）全簇：MBAP 帧头用 `?? ?? 00 00` 锚定协议标识，" +
      "按 MBAP 长度定帧（总长 = 长度值 + 6），事务号/单元地址/功能码全部解出，" +
      "读响应把寄存器区展开为 寄存器1..N。TCP 没有 CRC，主站请求与从站响应靠" +
      "「MBAP 长度奇偶」精确区分（请求恒 6、响应为 3+2N），" +
      "因此嗅探网关、PLC 与上位机对话时不会互相误判；异常响应用功能码 bit7 掩码一条覆盖。",
    build: () => mbTcpCluster(),
  },
  {
    key: NMEA_0183,
    name: "NMEA 0183 (GPS)",
    tag: "导航",
    desc:
      "ASCII 语句：$ 开头、CRLF 结尾。校验和(XOR位于*后)暂不参与截帧判定，仅作字段参考。" +
      "语句类型如 GPGGA/GPRMC 可通过框选定义提取。",
    build: () => [
      {
        id: nid("nmea"),
        name: "NMEA·语句",
        color: "#39c5cf",
        enabled: true,
        boundary: {
          mode: "footer",
          headerBytes: [0x24],
          footerBytes: [0x0d, 0x0a],
          maxLength: 128,
        },
        checksum: null,
        fields: [
          f("语句标识", "id", 1, "ascii", C_ID, { size: 5 }),
        ],
      },
    ],
  },
  {
    key: WIT_IMU,
    name: "维特 WIT 陀螺仪",
    tag: "惯导",
    desc:
      "WIT 私有协议（JY901P/WITMotion 全系）：55+TYPE+8数据+SUM，11 字节定长，" +
      "TYPE 识别位自动区分帧型；SUM=帧头起累加和低8位。数据小端有符号，" +
      "换算系数已内置（角速度×2000°/s、角度×180°、四元数/32768 等）。",
    build: () => {
      const head = () => [
        f("TYPE", "id", 1, "uint8", C_ID),
      ];
      const wit = (ty: number, name: string, color: string, fields: FieldDef[]): FrameTemplate => ({
        id: nid("wit"),
        name: `WIT·0x${ty.toString(16).toUpperCase().padStart(2, "0")}${name}`,
        color,
        enabled: true,
        boundary: {
          mode: "fixedLength",
          headerBytes: [0x55],
          fixedLength: 11,
          maxLength: 16,
        },
        checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
        fields: fields.map((x) => (x.role === "id" ? { ...x, disc: [ty] } : x)),
      });
      return [
        wit(0x51, "加速度", "#39c5cf", [
          ...head(),
          f("AX", "data", 2, "int16", C_DATA, { scale: 16 / 32768, unit: "g" }),
          f("AY", "data", 4, "int16", C_DATA, { scale: 16 / 32768, unit: "g" }),
          f("AZ", "data", 6, "int16", C_DATA, { scale: 16 / 32768, unit: "g" }),
          f("温度", "data", 8, "int16", C_LEN, { scale: 0.01, unit: "°C" }),
        ]),
        wit(0x52, "角速度", "#db61a2", [
          ...head(),
          f("WX", "data", 2, "int16", C_GYRO, { scale: 2000 / 32768, unit: "°/s" }),
          f("WY", "data", 4, "int16", C_GYRO, { scale: 2000 / 32768, unit: "°/s" }),
          f("WZ", "data", 6, "int16", C_GYRO, { scale: 2000 / 32768, unit: "°/s" }),
          f("电压", "data", 8, "int16", C_LEN, { scale: 0.01, unit: "V" }),
        ]),
        wit(0x53, "角度", "#3fb950", [
          ...head(),
          f("横滚 Roll", "data", 2, "int16", C_DATA, { scale: 180 / 32768, unit: "°" }),
          f("俯仰 Pitch", "data", 4, "int16", C_DATA, { scale: 180 / 32768, unit: "°" }),
          f("航向 Yaw", "data", 6, "int16", C_DATA, { scale: 180 / 32768, unit: "°" }),
          f("版本", "data", 8, "uint16", C_LEN),
        ]),
        wit(0x54, "磁场", "#c678dd", [
          ...head(),
          f("HX", "data", 2, "int16", C_MAG),
          f("HY", "data", 4, "int16", C_MAG),
          f("HZ", "data", 6, "int16", C_MAG),
          f("温度", "data", 8, "int16", C_LEN, { scale: 0.01, unit: "°C" }),
        ]),
        wit(0x55, "端口状态", "#d29922", [
          ...head(),
          f("D0", "data", 2, "uint16", C_DATA),
          f("D1", "data", 4, "uint16", C_DATA),
          f("D2", "data", 6, "uint16", C_DATA),
          f("D3", "data", 8, "uint16", C_DATA),
        ]),
        wit(0x56, "气压高度", "#bc8cff", [
          ...head(),
          f("气压", "data", 2, "uint32", C_DATA, { unit: "Pa" }),
          f("高度", "data", 6, "int32", C_DATA, { unit: "cm" }),
        ]),
        wit(0x57, "经纬度", "#bc8cff", [
          ...head(),
          f("经度 LNG", "data", 2, "int32", C_DATA, { scale: 1e-7, unit: "°" }),
          f("纬度 LAT", "data", 6, "int32", C_DATA, { scale: 1e-7, unit: "°" }),
        ]),
        wit(0x58, "GPS速度", "#39c5cf", [
          ...head(),
          f("GPS海拔", "data", 2, "int16", C_DATA, { scale: 0.1, unit: "m" }),
          f("GPS航向", "data", 4, "int16", C_DATA, { scale: 0.01, unit: "°" }),
          f("GPS地速", "data", 6, "uint32", C_DATA, { scale: 0.001, unit: "km/h" }),
        ]),
        wit(0x59, "四元数", "#3fb950", [
          ...head(),
          f("q0", "data", 2, "int16", C_DATA, { scale: 1 / 32768 }),
          f("q1", "data", 4, "int16", C_DATA, { scale: 1 / 32768 }),
          f("q2", "data", 6, "int16", C_DATA, { scale: 1 / 32768 }),
          f("q3", "data", 8, "int16", C_DATA, { scale: 1 / 32768 }),
        ]),
        wit(0x5a, "定位精度", "#f0883e", [
          ...head(),
          f("卫星数", "data", 2, "uint16", C_DATA),
          f("PDOP", "data", 4, "uint16", C_DATA, { scale: 0.01 }),
          f("HDOP", "data", 6, "uint16", C_DATA, { scale: 0.01 }),
          f("VDOP", "data", 8, "uint16", C_DATA, { scale: 0.01 }),
        ]),
      ];
    },
  },
];
