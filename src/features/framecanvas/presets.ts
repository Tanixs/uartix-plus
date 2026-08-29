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
        ...v7Head(),
        f("ACC_X", "data", 4, "int16", C_DATA),
        f("ACC_Y", "data", 6, "int16", C_DATA),
        f("ACC_Z", "data", 8, "int16", C_DATA),
        f("GYR_X", "data", 10, "int16", C_GYRO),
        f("GYR_Y", "data", 12, "int16", C_GYRO),
        f("GYR_Z", "data", 14, "int16", C_GYRO),
        f("震动状态", "data", 16, "uint8", C_LEN),
      ]),
      v7Tpl(0x02, "罗盘气压温度", "#c678dd", [
        ...v7Head(),
        f("MAG_X", "data", 4, "int16", C_MAG),
        f("MAG_Y", "data", 6, "int16", C_MAG),
        f("MAG_Z", "data", 8, "int16", C_MAG),
        f("ALT_BAR", "data", 10, "int32", C_DATA, { unit: "cm" }),
        f("TMP", "data", 14, "int16", C_DATA, { scale: 0.1, unit: "°C" }),
        f("气压状态", "data", 16, "uint8", C_LEN),
        f("罗盘状态", "data", 17, "uint8", C_LEN),
      ]),
      v7Tpl(0x03, "欧拉姿态", "#3fb950", [
        ...v7Head(),
        f("横滚 ROL", "data", 4, "int16", C_DATA, { scale: 0.01, unit: "°" }),
        f("俯仰 PIT", "data", 6, "int16", C_DATA, { scale: 0.01, unit: "°" }),
        f("航向 YAW", "data", 8, "int16", C_DATA, { scale: 0.01, unit: "°" }),
        f("融合状态", "data", 10, "uint8", C_LEN),
      ]),
      v7Tpl(0x04, "四元数姿态", "#3fb950", [
        ...v7Head(),
        f("Q0", "data", 4, "int16", C_DATA, { scale: 0.0001 }),
        f("Q1", "data", 6, "int16", C_DATA, { scale: 0.0001 }),
        f("Q2", "data", 8, "int16", C_DATA, { scale: 0.0001 }),
        f("Q3", "data", 10, "int16", C_DATA, { scale: 0.001 }),
        f("融合状态", "data", 12, "uint8", C_LEN),
      ]),
      v7Tpl(0x05, "高度数据", "#39c5cf", [
        ...v7Head(),
        f("ALT_FU", "data", 4, "int32", C_DATA, { unit: "cm" }),
        f("ALT_ADD", "data", 8, "int32", C_DATA, { unit: "cm" }),
        f("测距状态", "data", 12, "uint8", C_LEN),
      ]),
      v7Tpl(0x06, "运行模式", "#d29922", [
        ...v7Head(),
        f("MODE", "data", 4, "uint8", C_LEN),
        f("LOCKED", "data", 5, "uint8", C_LEN),
        f("CID", "data", 6, "uint8", C_LEN),
        f("CMD0", "data", 7, "uint8", C_LEN),
        f("CMD1", "data", 8, "uint8", C_LEN),
      ]),
      v7Tpl(0x07, "飞行速度", "#3fb950", [
        ...v7Head(),
        f("SPEED_X", "data", 4, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Y", "data", 6, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Z", "data", 8, "int16", C_DATA, { unit: "cm/s" }),
      ]),
      v7Tpl(0x08, "位置偏移", "#39c5cf", [
        ...v7Head(),
        f("POS_X", "data", 4, "int32", C_DATA, { unit: "cm" }),
        f("POS_Y", "data", 8, "int32", C_DATA, { unit: "cm" }),
      ]),
      v7Tpl(0x09, "风速估计", "#39c5cf", [
        ...v7Head(),
        f("WIND_X", "data", 4, "int16", C_DATA, { unit: "cm/s" }),
        f("WIND_Y", "data", 6, "int16", C_DATA, { unit: "cm/s" }),
      ]),
      v7Tpl(0x0a, "目标姿态", "#f0883e", [
        ...v7Head(),
        f("TAR_ROL", "data", 4, "int16", C_FG, { scale: 0.01, unit: "°" }),
        f("TAR_PIT", "data", 6, "int16", C_FG, { scale: 0.01, unit: "°" }),
        f("TAR_YAW", "data", 8, "int16", C_FG, { scale: 0.01, unit: "°" }),
      ]),
      v7Tpl(0x0b, "目标速度", "#f0883e", [
        ...v7Head(),
        f("TAR_SPEED_X", "data", 4, "int16", C_FG, { unit: "cm/s" }),
        f("TAR_SPEED_Y", "data", 6, "int16", C_FG, { unit: "cm/s" }),
        f("TAR_SPEED_Z", "data", 8, "int16", C_FG, { unit: "cm/s" }),
      ]),
      v7Tpl(0x0c, "回航信息", "#d29922", [
        ...v7Head(),
        f("R_A", "data", 4, "int16", C_ADDR, { scale: 0.1, unit: "°" }),
        f("R_D", "data", 6, "uint16", C_DATA, { unit: "m" }),
      ]),
      v7Tpl(0x0d, "电压电流", "#e5534b", [
        ...v7Head(),
        f("VOTAGE", "data", 4, "uint16", C_DATA, { scale: 0.01, unit: "V" }),
        f("CURRENT", "data", 6, "uint16", C_DATA, { scale: 0.01, unit: "A" }),
      ]),
      v7Tpl(0x0e, "外接模块状态", "#bc8cff", [
        ...v7Head(),
        f("STA_G_VEL", "data", 4, "uint8", C_LEN),
        f("STA_G_POS", "data", 5, "uint8", C_LEN),
        f("STA_GPS", "data", 6, "uint8", C_LEN),
        f("STA_ALT_ADD", "data", 7, "uint8", C_LEN),
      ]),
      v7Tpl(0x0f, "RGB 亮度", "#db61a2", [
        ...v7Head(),
        f("BRI_R", "data", 4, "uint8", C_GYRO),
        f("BRI_G", "data", 5, "uint8", C_DATA),
        f("BRI_B", "data", 6, "uint8", C_DATA),
        f("BRI_A", "data", 7, "uint8", C_DATA),
      ]),
      v7Tpl(0x21, "飞控输出控制", "#f0883e", [
        ...v7Head(),
        f("CTRL_ROL", "data", 4, "int16", C_FG),
        f("CTRL_PIT", "data", 6, "int16", C_FG),
        f("CTRL_THR", "data", 8, "int16", C_FG),
        f("CTRL_YAW", "data", 10, "int16", C_FG),
      ]),
      v7Tpl(0x30, "GPS 定位", "#bc8cff", [
        ...v7Head(),
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
        ...v7Head(),
        f("POS_X", "data", 4, "int32", C_DATA, { unit: "cm" }),
        f("POS_Y", "data", 8, "int32", C_DATA, { unit: "cm" }),
        f("POS_Z", "data", 12, "int32", C_DATA, { unit: "cm" }),
      ]),
      v7Tpl(0x33, "通用速度", "#39c5cf", [
        ...v7Head(),
        f("SPEED_X", "data", 4, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Y", "data", 6, "int16", C_DATA, { unit: "cm/s" }),
        f("SPEED_Z", "data", 8, "int16", C_DATA, { unit: "cm/s" }),
      ]),
      v7Tpl(0x34, "通用测距", "#d29922", [
        ...v7Head(),
        f("DIRECTION", "data", 4, "uint8", C_LEN),
        f("ANGLE", "data", 5, "uint16", C_DATA, { unit: "°" }),
        f("DIST", "data", 7, "uint32", C_DATA, { unit: "cm" }),
      ]),
      v7Tpl(0x40, "遥控器数据", "#f0883e", [
        ...v7Head(),
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
        ...v7Head(),
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
      "地址 + 功能码 + 数据 + CRC16(小端)。读响应帧由 byteCount 定长截帧；" +
      "请求帧固定 8 字节。设备地址默认 0x01，可在属性面板修改帧头字节。",
    build: () => [
      {
        id: nid("mb"),
        name: "Modbus·读寄存器响应",
        color: "#bc8cff",
        enabled: true,
        boundary: {
          mode: "lengthField",
          headerBytes: [0x01],
          lengthOffset: 2,
          lengthSize: 1,
          lengthEndian: "little",
          lengthAdjust: 5,
          maxLength: 280,
        },
        checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2, endian: "little" },
        fields: [
          f("设备地址", "id", 0, "uint8", C_ADDR),
          f("功能码", "id", 1, "uint8", C_ID),
          f("字节数", "length", 2, "uint8", C_LEN),
        ],
      },
      {
        id: nid("mb"),
        name: "Modbus·标准请求帧",
        color: "#d29922",
        enabled: false,
        boundary: {
          mode: "fixedLength",
          headerBytes: [0x01],
          fixedLength: 8,
          maxLength: 64,
        },
        checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2, endian: "little" },
        fields: [
          f("设备地址", "id", 0, "uint8", C_ADDR),
          f("功能码", "id", 1, "uint8", C_ID),
          f("起始地址", "data", 2, "uint16", C_LEN),
          f("数量/值", "data", 4, "uint16", C_LEN),
        ],
      },
    ],
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
