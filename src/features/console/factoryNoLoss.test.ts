/**
 * P121 · 指令工厂的「不能改丢」清单。
 *
 * 用户裁决原话：新建面板可以，**但指令工厂原有功能不能改丢了**。
 * 这句话不能靠当值会话记得——所以写成测试：详设 §11.3 那 12 条，每条一个可反驳的断言。
 * D/E 两期搬入口、换存储的时候，任何一条红了就说明搬丢了。
 *
 * 两类判据：**存在性**（内置编解码器、领域表、下游链路还在——搬走 UI 不该搬走数据）
 * 与**行为**（动态字段、输入宽容度、校验语义、帧间延时这些语义不变）。
 */
import { describe, expect, it } from "vitest";
import {
  ANO_COMMANDS,
  CODECS,
  WIT_REGS,
  WIT_SAVE,
  WIT_UNLOCK,
  buildUserFrame,
  crc16,
  parseIntInput,
  parseHexBytes,
  userCodecToCodec,
  validateUserCodec,
  type FactoryField,
  type UserCodecDef,
} from "./commandFactory";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};
/** 读源文本而不是 import 被测模块：测试文件不该被当组件拉进依赖图 */
const readSrc = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const BUILTIN_IDS = ["wit", "ano-cmd", "ano-param-read", "ano-param-write", "modbus", "modbus-tcp", "checksum"];

describe("P121 · 指令工厂不丢清单", () => {
  it("1｜7 枚内置编解码器一枚不少，且每枚都有落组", () => {
    const ids = CODECS.map((c) => c.id);
    expect(ids.slice().sort()).toEqual([...BUILTIN_IDS].sort());
    for (const c of CODECS) expect(c.group, `${c.id} 没有分组 ⇒ 存为指令时无处可落`).toBeTruthy();
    expect(new Set(ids).size, "id 撞了").toBe(ids.length);
  });

  it("2｜动态字段还在：匿名 V7 的参数表是一个函数，不是写死的一张表单", () => {
    const ano = CODECS.find((c) => c.id === "ano-cmd")!;
    expect(typeof ano.fields, "fields 被拍平成静态数组了：动态参数表搬丢了").toBe("function");
    const fn = ano.fields as unknown as (v: Record<string, string>) => FactoryField[];
    const base = fn({});
    const picked = fn({ cmd: "9" });
    expect(base.length, "一张空表单：这个 codec 已经什么都不填了").toBeGreaterThan(0);
    expect(picked.every((f) => "key" in f)).toBe(true);
    expect(new Set(base.map((f) => f.key)).size).toBe(base.length);
  });

  it("3｜领域表是资产不是常量：WIT 寄存器 / 匿名 V7 命令表非空且带档位提示", () => {
    expect(WIT_REGS.length, "WIT 寄存器表缩了").toBeGreaterThan(10);
    expect(WIT_REGS.filter((r) => r.hints?.length).length, "带档位提示的寄存器全没了").toBeGreaterThan(3);
    expect(ANO_COMMANDS.length, "匿名 V7 命令表缩了").toBeGreaterThan(5);
    expect(WIT_UNLOCK).toBe("FF AA 69 88 B5");
    expect(WIT_SAVE).toBe("FF AA 00 00 00");
  });

  it("4｜「校验工具」那枚是计算器用途，不属于组包也必须留", () => {
    const ck = CODECS.find((c) => c.id === "checksum")!;
    expect(ck.group).toBe("校验工具");
    const r = ck.build({ data: "31 32 33 34 35 36 37 38 39", algo: "1" });
    expect(r.frames.length, "算不出结果：这枚被搬空了").toBeGreaterThan(0);
  });

  it("5｜用户自定义协议升成同一个 Codec 形状（一套渲染，不长第二套 UI）", () => {
    const def: UserCodecDef = {
      id: "d1", name: "我的帧", note: "", createdAt: 0,
      segs: [
        { kind: "fixed", label: "HDR", bytes: "AA" },
        { kind: "var", name: "值", type: "u16", le: false, def: "1" },
        { kind: "check", algo: "crc16-modbus", be: false },
      ],
    };
    const codec = userCodecToCodec(def);
    expect(codec.id).toBe("user:d1");
    expect(codec.group).toBe("我的协议");
    // crc16-modbus 低字节在前（`be:false`）；期望值按同一张 checksums 表算，不是抄输出
    const crc = crc16("modbus", [0xaa, 0x00, 0x01]);
    const lo = (crc & 0xff).toString(16).padStart(2, "0").toUpperCase();
    const hi = ((crc >> 8) & 0xff).toString(16).padStart(2, "0").toUpperCase();
    expect(codec.build({ f_值: "1" }).frames[0]).toBe(`AA 00 01 ${lo} ${hi}`);
  });

  it("6｜buildUserFrame 的报错点名到字段，不抛裸数字", () => {
    const def: UserCodecDef = {
      id: "d2", name: "范围", note: "", createdAt: 0,
      segs: [
        { kind: "fixed", label: "HDR", bytes: "AA" },
        { kind: "var", name: "温度", type: "u8", le: false, def: "0" },
      ],
    };
    expect(() => buildUserFrame(def, { f_温度: "999" })).toThrow(/温度/);
    expect(() => buildUserFrame(def, { f_温度: "abc" })).toThrow(/温度/);
  });

  it("7｜validateUserCodec 的四条错误语义都还在", () => {
    expect(validateUserCodec({ name: " ", segs: [] })).toContain("名称");
    expect(validateUserCodec({ name: "x", segs: [{ kind: "fixed", label: "a", bytes: "AA" }] })).toContain("2 个段");
    expect(
      validateUserCodec({
        name: "x",
        segs: [
          { kind: "var", name: "a", type: "u8", le: false },
          { kind: "var", name: "a", type: "u8", le: false },
        ],
      }),
    ).toContain("重复");
    expect(
      validateUserCodec({
        name: "x",
        segs: [
          { kind: "check", algo: "sum8", be: false },
          { kind: "fixed", label: "a", bytes: "AA" },
        ],
      }),
    ).toContain("不能放在第一个");
  });

  it("8｜输入宽容度：0x 十六进制、空格/逗号分隔、越界点名", () => {
    expect(parseIntInput("0xff", "x")).toBe(255);
    expect(parseIntInput("-12", "x")).toBe(-12);
    expect(() => parseIntInput("not-a-number", "速度")).toThrow(/速度/);
    expect(parseHexBytes("AA,55 0x01", "x")).toEqual([0xaa, 0x55, 0x01]);
    expect(() => parseHexBytes("ff00", "x")).toThrow(/ff00/);
  });

  it("9｜Modbus 两枚的既有契约测试还在跑（搬东西时最容易顺手删旧测试）", () => {
    const src = readSrc("./commandFactory.test.ts");
    expect(src, "commandFactory.test.ts 不再提 Modbus 了").toMatch(/modbus/i);
    for (const id of ["modbus", "modbus-tcp"]) {
      expect(CODECS.some((c) => c.id === id), `${id} 不见了`).toBe(true);
    }
  });

  it("10｜序列器仍引用工厂载荷（桥不断）", () => {
    const src = readSrc("../sequencer/sequencerBind.ts");
    expect(src, "序列器不再 import 工厂：载荷引用这条链断了").toContain("userCodecToCodec");
  });

  it("11｜AI 仍能生成自定义协议", () => {
    const src = readSrc("../ai/aiActions.ts");
    expect(src, "AI 生成协议这条链被摘了").toMatch(/validateUserCodec|buildUserFrame/);
  });

  it("12｜控制台快捷栏保留「触发」：chips 一键发 + 工厂就地发送与预览", () => {
    const src = readSrc("./QuickCommandBar.tsx");
    expect(src, "快捷栏把工厂发送撤了：D 期只该搬走编辑入口，不该搬走发送").toContain("sendFactory");
    expect(src, "就地预览没了").toContain("codec.build");
    expect(src, "多帧之间的帧间延时没了").toMatch(/delay\(60\)/);
  });
});
