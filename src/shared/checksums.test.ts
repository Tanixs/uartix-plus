/**
 * P121-A · 校验原语的契约钉。
 *
 * 为什么要单独钉：同一批算法有**两份实现**——`shared/checksums.ts`（发送侧组帧、指令工厂、
 * Modbus 内核用）与 `src-tauri/src/parser.rs` 的 `checksum_compute`（接收侧解析热路径用）。
 * 两份一直"看起来一样"，但没有任何东西钉着：改一边忘一边时，症状是"能发出去、自己解不回来"，
 * 而那正是 P121 详设 §10 里 JCom 对照表点出的同一族病。
 *
 * 三层判据，从最硬到最软：
 *  ① **公开已知答案**（"123456789" 的 CRC-16/MODBUS = 0x4B37、CRC-16/CCITT-FALSE = 0x29B1、
 *     CRC-32 = 0xCBF43926，最后一个与 Node `zlib.crc32` 对过）——它独立于我们两份实现；
 *  ② 同一张向量表在 TS 侧逐算法成立；
 *  ③ 那张表的每个期望值**也出现在 Rust 源文里**（两边必须同时改，改一边当场红）。
 *
 * 缺口这条变了（不假装）：`x25` 与 `sum16` 以前只有 TS 侧算得出，接收侧解不了它们，是"能发不能解"——
 * 现在 Rust `checksum_compute` 有这两支，向量表两边一起长（① 里 0x906E 就是 CRC-16/X-25 的公开 check 值）。
 * 还剩的两条明写：虚拟设备 `vdev.rs` 只认 5 支算法（模拟帧发不出 x25/sum16），
 * 以及 CRC 只能从预制算法里选、还不能自己填参数（#100）。宽度表在 #94a 收成一份（④~⑧ 钉它）。
 */
import { describe, expect, it } from "vitest";
import {
  CHECKSUM_WIDTHS,
  anoCheck,
  checksumWidth,
  crc16,
  crc32,
  sum16,
  sum8,
  sumadd16,
  xor8,
} from "./checksums";
import { checksumLen } from "../features/framecanvas/frameLayout";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};

/** 与 `parser.rs` 测试里的 `VECTORS` 同一张表：改这里必须同时改那里 */
const VECTORS: {
  name: string;
  bytes: number[];
  sum8: number;
  xor8: number;
  sumadd16: number;
  sum16: number;
  modbus: number;
  ccitt: number;
  x25: number;
  crc32: number;
}[] = [
  {
    name: "123456789",
    bytes: [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39],
    sum8: 0xdd,
    xor8: 0x31,
    sumadd16: 0x15dd,
    sum16: 0x01dd,
    modbus: 0x4b37,
    ccitt: 0x29b1,
    x25: 0x906e,
    crc32: 0xcbf43926,
  },
  {
    name: "AA 55 01 02 0F",
    bytes: [0xaa, 0x55, 0x01, 0x02, 0x0f],
    sum8: 0x11,
    xor8: 0xf3,
    sumadd16: 0xbc11,
    sum16: 0x0111,
    modbus: 0x703d,
    ccitt: 0x1405,
    x25: 0x43c1,
    crc32: 0xa32d9a9e,
  },
  {
    name: "AA",
    bytes: [0xaa],
    sum8: 0xaa,
    xor8: 0xaa,
    sumadd16: 0xaaaa,
    sum16: 0x00aa,
    modbus: 0x3f3f,
    ccitt: 0xf550,
    x25: 0xfa28,
    crc32: 0xe401a57b,
  },
];

describe("P121-A · 校验原语", () => {
  it("① 公开已知答案（独立于本仓库两份实现）", () => {
    const v = VECTORS[0].bytes;
    expect(crc16("modbus", v), "CRC-16/MODBUS 的 check 值是公开的 0x4B37").toBe(0x4b37);
    expect(crc16("ccitt-false", v), "CRC-16/CCITT-FALSE 的 check 值是公开的 0x29B1").toBe(0x29b1);
    expect(crc16("x25", v), "CRC-16/X-25（= BUETE）的 check 值是公开的 0x906E").toBe(0x906e);
    expect(crc32(v) >>> 0, "CRC-32 的 check 值是公开的 0xCBF43926（与 zlib 一致）").toBe(0xcbf43926);
  });

  it("② 向量表在 TS 侧逐算法成立", () => {
    for (const t of VECTORS) {
      expect(sum8(t.bytes), `${t.name} sum8`).toBe(t.sum8);
      expect(xor8(t.bytes), `${t.name} xor8`).toBe(t.xor8);
      expect(sumadd16(t.bytes), `${t.name} sumadd16`).toBe(t.sumadd16);
      expect(sum16(t.bytes), `${t.name} sum16`).toBe(t.sum16);
      expect(crc16("modbus", t.bytes), `${t.name} crc16-modbus`).toBe(t.modbus);
      expect(crc16("ccitt-false", t.bytes), `${t.name} crc16-ccitt`).toBe(t.ccitt);
      expect(crc16("x25", t.bytes), `${t.name} crc16-x25`).toBe(t.x25);
      expect(crc32(t.bytes) >>> 0, `${t.name} crc32`).toBe(t.crc32);
    }
    // sumadd16 与匿名 V7 的 SC/AC 是同一件事的两种写法，这里钉住它们别各漂各的
    for (const t of VECTORS) {
      const { sc, ac } = anoCheck(t.bytes);
      expect(sumadd16(t.bytes), `${t.name}：sumadd16 必须等于 SC | AC<<8`).toBe((sc | (ac << 8)) & 0xffff);
    }
  });

  it("③ 同一张表的期望值也写在 Rust 侧（改一边忘一边当场红）", () => {
    const rust = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/parser.rs", import.meta.url)),
      "utf8",
    );
    const missing: string[] = [];
    for (const t of VECTORS) {
      for (const [algo, v] of [
        ["sum8", t.sum8],
        ["xor8", t.xor8],
        ["sumadd", t.sumadd16],
        ["sum16", t.sum16],
        ["crc16_modbus", t.modbus],
        ["crc16_ccitt", t.ccitt],
        ["crc16_x25", t.x25],
        ["crc32", t.crc32],
      ] as [string, number][]) {
        // Rust 侧写 0x 大写或小写都算命中；按 4/8 位补齐再找
        const hex = v.toString(16);
        const wide = v > 0xffff ? hex.padStart(8, "0") : hex.padStart(4, "0");
        if (!new RegExp(`0x(${hex}|${wide})`, "i").test(rust)) missing.push(`${t.name} ${algo} = 0x${wide}`);
      }
    }
    expect(missing, `这些向量只在 TS 侧，Rust 的 checksum_compute 测试没跟上：${missing.join("、")}`).toEqual([]);
  });
});

/**
 * ④~⑧ · "校验字段占几字节"这张表。
 *
 * 数字原先抄在四份里（`shared/checksums`、`protocol/templateStore.CHECKSUM_SIZES`、
 * `framecanvas/frameLayout.checksumLen`、Rust `parser.rs::checksum_size`），#94a 把它们收进
 * `CHECKSUM_WIDTHS`。这里钉的是**收表之后不许再漂**：三方取同一个数、Rust 两支函数跟着走、
 * 面板与类型能选到的算法都必须有宽度。
 *
 * 更要钉的是**没统一的那几条兜底**——它们是行为差异，不是笔误：
 *  发送侧 `checksumWidth` 认不出 ⇒ 0（编码时点名报错，不凑数）；
 *  帧画布布局 `checksumLen`：空串/null/`none` ⇒ 0，表里没有的算法名 ⇒ 2（字段已在带上了，先占两位）；
 *  `CHECKSUM_SIZES` 的六处读方 ⇒ 1（另两处按 `fieldSize(f)`）；
 *  引擎 `parser.rs::checksum_size` ⇒ 1，只吃未知算法（八支已知算法现在都有自己的臂，见 ⑥）。
 * 一把统一会改到帧画布与引擎的行为 —— 已拍板**不收**，把这三条写成有名分工：发送侧宁可不发、
 * 布局宁可先占位、引擎按算法读。这里按当前值钉住：谁悄悄改了兜底，当场红，并且知道要连带改注释。
 */

/** 取 `sig` 起、到该函数收尾那个顶格的 `}` 为止的源文 */
function fnBody(src: string, sig: string, where: string): string {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error(`${where} 里找不到 ${sig}`);
  const end = src.indexOf("\n}", at);
  if (end < 0) throw new Error(`${where} 的 ${sig} 没找到收尾`);
  return src.slice(at, end);
}

/** Rust `match` 的 `"a" | "b" => N` 臂与 `_ => N` 兜底；`=> return Err(..)` 那种臂不是数字，自然跳过 */
function rustWidthArms(body: string): { arms: Record<string, number>; fallback: number | null } {
  const arms: Record<string, number> = {};
  let fallback: number | null = null;
  for (const line of body.split("\n")) {
    const m = /^\s*(.+?)\s*=>\s*(\d+)\s*,?\s*$/.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    const names = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (!names.length) {
      if (m[1].trim() === "_") fallback = n;
      continue;
    }
    for (const nm of names) arms[nm] = n;
  }
  return { arms, fallback };
}

const ALGOS = Object.keys(CHECKSUM_WIDTHS);
const COMPUTED = ALGOS.filter((a) => a !== "none");

describe("P121-B2 · 校验字段宽度：数字一份、兜底三条", () => {
  it("④ TS 三方对八支已知算法同数，且各自的兜底停在今天这条线上", () => {
    for (const a of COMPUTED) {
      expect(checksumWidth(a), `发送侧 ${a}`).toBe(CHECKSUM_WIDTHS[a]);
      expect(checksumLen(a), `帧画布布局的 ${a} 和表漂了`).toBe(CHECKSUM_WIDTHS[a]);
    }
    expect(checksumWidth("none"), "没有校验段就是 0 字节").toBe(0);
    expect(checksumLen("none")).toBe(0);
    expect(checksumLen(""), "算法还没选：布局不占位（占位的是下面那条）").toBe(0);
    expect(checksumLen(null), "同上，null 走同一条路").toBe(0);
    expect(checksumWidth("not-an-algo"), "发送侧兜底 0：认不出就别凑数").toBe(0);
    expect(
      checksumLen("not-an-algo"),
      "布局对表里没有的算法名按 2 留位；统一它属于 #94b，要连注释一起改",
    ).toBe(2);
  });

  it("⑤ templateStore 的 CHECKSUM_SIZES 只是这份表的一个视图，不再是第二份数字", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../features/protocol/templateStore.ts", import.meta.url)),
      "utf8",
    );
    const at = src.indexOf("export const CHECKSUM_SIZES");
    expect(at, "CHECKSUM_SIZES 消失了或改名——那六处 `?? 1` 的口径要重新对").toBeGreaterThan(-1);
    const decl = src.slice(at, src.indexOf("\n);", at) + 3);
    expect(decl, "CHECKSUM_SIZES 不再从 CHECKSUM_WIDTHS 派生").toContain("CHECKSUM_WIDTHS");
    const literals = [...decl.matchAll(/["'][a-z0-9_]+["']\s*:\s*\d+/g)].map((m) => m[0]);
    expect(literals, `这里又自己写数字了：${literals.join("、")}`).toEqual([]);
    // 故意不含 none：那几处 `CHECKSUM_SIZES[algo] ?? 1` 靠"认不出来留 1 字节"过活
    expect(decl).toContain('"none"');
  });

  it("⑥ 引擎 parser.rs::checksum_size 的已知算法宽度与表一致", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/parser.rs", import.meta.url)),
      "utf8",
    );
    const { arms, fallback } = rustWidthArms(
      fnBody(src, "fn checksum_size(algo: &str) -> usize", "parser.rs"),
    );
    // 八支已知算法在引擎里**都必须有自己的臂**。以前 sum8/xor8 是从 `_ => 1` 那条兜底拿到宽度的，
    // 于是"改兜底"实际上等于"改这两支的接收宽度"——把臂写开之后，`_` 只代表真不认识的算法，
    // 这条断言也就能收紧成"不许靠兜底凑"。
    const drift: string[] = [];
    for (const a of COMPUTED) {
      if (arms[a] !== CHECKSUM_WIDTHS[a]) {
        drift.push(`${a}：Rust ${arms[a] ?? "没有自己的臂（在吃兜底）"} vs 表 ${CHECKSUM_WIDTHS[a]}`);
      }
    }
    expect(drift, `两边宽度漂了：${drift.join("；")}`).toEqual([]);
    expect(fallback, "引擎兜底此刻是 1，且只吃未知算法").toBe(1);
    expect("none" in arms, "none 不该出现在引擎的宽度臂里：三个调用点都先短路了它").toBe(false);
  });

  it("⑦ 虚拟设备 vdev.rs::checksum_len 严格表：认得的算法宽度一致，认不出的必须报错", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/vdev.rs", import.meta.url)),
      "utf8",
    );
    const { arms, fallback } = rustWidthArms(fnBody(src, "fn checksum_len(kind: &str) -> Result<usize, String>", "vdev.rs"));
    const drift: string[] = [];
    for (const [algo, n] of Object.entries(arms)) {
      // "" 是 vdev 里"没有校验"的另一种写法，表里没这个键（表用 `none`）
      const want = algo === "" ? 0 : CHECKSUM_WIDTHS[algo];
      if (want !== n) drift.push(`${algo}：vdev ${n} vs 表 ${want}`);
    }
    expect(drift, `vdev 的严格表和表冲突：${drift.join("；")}`).toEqual([]);
    // 它只认这五支：比表的覆盖面窄（发不了 crc32/sumadd/ccitt 的模拟帧），是缺口不是冲突
    expect(Object.keys(arms).sort(), "vdev 支持的校验算法集合变了——它窄于表，宽了更要过一遍宽度").toEqual(
      ["", "crc16_modbus", "none", "sum8", "xor8"].sort(),
    );
    expect(fallback, "vdev 走 other => return Err(...)，没有数字兜底").toBe(null);
  });

  it("⑧ 类型、表、面板选项三者同一支算法集：能选到就必须算得出宽度", () => {
    const types = readFileSync(
      fileURLToPath(new URL("../ipc/types.ts", import.meta.url)),
      "utf8",
    );
    const uni = /export type ChecksumAlgo =([^;]*);/.exec(types);
    if (!uni) throw new Error("ChecksumAlgo 这个联合类型不见了——表和类型从此没关系了，得重新对");
    const inType = [...uni[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect([...inType].sort(), "ChecksumAlgo 与 CHECKSUM_WIDTHS 的键不再是同一支算法集").toEqual(
      [...ALGOS].sort(),
    );

    const panel = readFileSync(
      fileURLToPath(new URL("../features/send/SendBuildPanel.tsx", import.meta.url)),
      "utf8",
    );
    const opts = /const CK_ALGOS: ChecksumAlgo\[\] = \[([^\]]*)\]/.exec(panel);
    if (!opts) throw new Error("TX组帧台的校验算法下拉消失了——面板与类型脱钩了");
    const inPanel = [...opts[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect([...inPanel].sort(), "面板能选的算法与表不一致（选了算不出宽度的那一支会当场报错）").toEqual(
      [...ALGOS].sort(),
    );
  });
});
