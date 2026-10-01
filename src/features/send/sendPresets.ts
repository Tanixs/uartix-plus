/**
 * P121-E · 出厂发送谱预设（三张 pack，一键载入示例谱）。
 *
 * 形状照 `framecanvas/presets.ts`：`build()` 是 pure 的，不碰锁、不落库；落库走
 * `sendStore.importTemplates` 那一个出口 —— 于是"重名加序号、永不覆盖用户的东西、id 每次新生成"
 * 这三条与导入文件是同一套语义，不用在这里再写一遍。
 *
 * 中文名/描述属于**数据层**（谱的名字会被写进存档、还会被引用式命令与卡片按名字找回），
 * 与 `QuickCommandBar` 的出厂指令、`vdevStore.builtinSpecs()` 同一个待拍口径（#47），
 * 所以这里不套 tx()；界面上那颗按钮的话术才走 tx()。
 *
 * 每张 pack 都过两道闸：`encodeSend` 编得出帧、`toReceiveTpl` 派生得出协议
 * —— 由 `sendPresets.test.ts` 逐条钉着。编不出东西的预设不配当示例。
 */
import { checksumWidth } from "../../shared/checksums";
import type { SendField, SendTemplate } from "./sendTypes";

export interface SendPresetDef {
  key: string;
  name: string;
  tag: string;
  desc: string;
  build: () => SendTemplate[];
}

let seq = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

type SendParam = SendTemplate["params"][number];

const f = (over: Partial<SendField> & { name: string; role: SendField["role"] }): SendField => ({
  id: nid("sf"),
  type: "uint8",
  endian: "big",
  source: { kind: "const", bytes: [0] },
  ...over,
}) as SendField;

const p = (id: string, name: string, type: SendParam["type"], def: string, min?: number, max?: number): SendParam => ({
  id,
  name,
  type,
  def,
  ...(min === undefined ? {} : { min }),
  ...(max === undefined ? {} : { max }),
});

const tpl = (
  name: string,
  note: string,
  fields: SendField[],
  params: SendParam[],
  checksum: SendTemplate["checksum"] = null,
): SendTemplate => ({
  id: nid("st"),
  name,
  note,
  fields,
  params,
  checksum,
  nextSeq: 0,
  createdAt: Date.now(),
  groupKey: "",
});

/** Modbus RTU 主站：读保持寄存器 / 写单个寄存器。从站地址与寄存器都是参数，一张谱发遍一条总线 */
function modbusPack(): SendTemplate[] {
  const addr = nid("sp");
  const reg = nid("sp");
  const cnt = nid("sp");
  const val = nid("sp");
  return [
    tpl(
      "Modbus 读保持寄存器",
      "FC03：从站地址、起始寄存器、数量都是参数；crc16_modbus 自己算。要读别的从站改参数即可，不必另起一张谱。",
      [
        f({ name: "从站地址", role: "addr", source: { kind: "param", paramId: addr } }),
        f({ name: "功能码", role: "id", source: { kind: "const", bytes: [0x03] } }),
        f({ name: "起始寄存器", role: "data", type: "uint16", source: { kind: "param", paramId: reg } }),
        f({ name: "数量", role: "data", type: "uint16", source: { kind: "param", paramId: cnt } }),
        f({ name: "校验", role: "checksum", type: "uint16", source: { kind: "const", bytes: [] } }),
      ],
      [p(addr, "从站地址", "uint", "1", 1, 247), p(reg, "起始寄存器", "uint", "0", 0, 65535), p(cnt, "数量", "uint", "2", 1, 125)],
      { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -checksumWidth("crc16_modbus") },
    ),
    tpl(
      "Modbus 写单个寄存器",
      "FC06：寄存器与写入值是参数。校验段的两个字节由算法给出，低字节在前（Modbus 是反射算法）。",
      [
        f({ name: "从站地址", role: "addr", source: { kind: "param", paramId: addr } }),
        f({ name: "功能码", role: "id", source: { kind: "const", bytes: [0x06] } }),
        f({ name: "寄存器", role: "data", type: "uint16", source: { kind: "param", paramId: reg } }),
        f({ name: "写入值", role: "data", type: "uint16", source: { kind: "param", paramId: val } }),
        f({ name: "校验", role: "checksum", type: "uint16", source: { kind: "const", bytes: [] } }),
      ],
      [p(addr, "从站地址", "uint", "1", 1, 247), p(reg, "寄存器", "uint", "0", 0, 65535), p(val, "写入值", "uint", "0", 0, 65535)],
      { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -checksumWidth("crc16_modbus") },
    ),
  ];
}

/** AT 指令：一行文本 + CRLF。文本块的长度跟着你填的值走，所以没有"定长"一说 */
function atPack(): SendTemplate[] {
  const cmd = nid("sp");
  return [
    tpl(
      "AT 指令（行尾 CRLF）",
      "整条指令是一个文本参数，后面钉两个字节 0D 0A。文本块发几个字节跟着值走 —— 编码器不补长也不截断。",
      [
        f({ name: "指令", role: "payload", type: "ascii", size: 8, source: { kind: "param", paramId: cmd } }),
        f({ name: "行尾", role: "footer", source: { kind: "const", bytes: [0x0d, 0x0a] } }),
      ],
      [p(cmd, "指令", "text", "AT+RST")],
    ),
  ];
}

/** 长度域 + 自增序号 + 和校验：把发送谱三种"算出来的字节"一次给全 */
function framedPack(): SendTemplate[] {
  const body = nid("sp");
  return [
    tpl(
      "带长度域与自增序号的帧",
      "5A 开头，长度域数它之后的字节（含校验），序号每发一帧自己 +1，sum8 在最后一趟算 —— 三处都不用你手填。",
      [
        f({ name: "帧头", role: "header", source: { kind: "const", bytes: [0x5a] } }),
        f({ name: "长度", role: "length", source: { kind: "len", covers: "after" } }),
        f({ name: "序号", role: "seq", type: "uint8", source: { kind: "seq" } }),
        f({ name: "数据", role: "data", type: "uint16", source: { kind: "param", paramId: body } }),
        f({ name: "校验", role: "checksum", type: "uint8", source: { kind: "const", bytes: [] } }),
      ],
      [p(body, "数据", "uint", "1", 0, 65535)],
      { algo: "sum8", coverageStart: 0, coverageEnd: -checksumWidth("sum8") },
    ),
  ];
}

export const SEND_PRESETS: SendPresetDef[] = [
  {
    key: "preset-modbus",
    name: "Modbus RTU 主站",
    tag: "MB",
    desc: "读保持寄存器（FC03）与写单个寄存器（FC06），CRC16 Modbus 自动算",
    build: modbusPack,
  },
  {
    key: "preset-at",
    name: "AT 指令",
    tag: "AT",
    desc: "一行文本 + 0D 0A 结尾，指令本身是参数",
    build: atPack,
  },
  {
    key: "preset-framed",
    name: "长度域 + 自增序号",
    tag: "DEMO",
    desc: "演示三种算出来的字节：长度回填、帧序号自增、和校验",
    build: framedPack,
  },
];

/**
 * 载入一份预设 pack：只追加，重名由 store 加序号，`groupKey` 打上 pack 的 key 作溯源
 * （"这张谱是从哪个预设来的"以后要说得出来，与 framecanvas 的 `presetKey` 同一用途）。
 * 返回真正载入的条数：0 有两种意思 —— 只读锁开着，或一张都没建成，由调用方问 store 之前先判锁。
 */
export function applySendPreset(def: SendPresetDef): SendTemplate[] {
  return def.build().map((t) => ({ ...t, groupKey: def.key }));
}
