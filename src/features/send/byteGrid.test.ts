/**
 * P122-A · 字节网格的模型规则。
 *
 * 这批的立身之本是一句话：**网格画出的第 i 格，就是将要发出的第 i 字节**。
 * 所以这里第一条用例不是测"格子好不好看"，而是测宽度到底从哪来 ——
 * 如果谁改成按 `sendFieldWidth` 累加，ascii（字节数跟着值走，编码器不 padding）
 * 立刻会把 5 字节的 "HELLO" 画成 4 格，下面第二条就红。
 *
 * 落点与降级也各钉一条：这台机器上进不去真实鼠标（P121-C2 的教训），
 * "边界→插到第几块前面"这条纯规则必须由断言管住，不能只在人眼里过一遍。
 */
import { describe, expect, it } from "vitest";
import { encodeSend } from "./encodeSend";
import type { SendField, SendTemplate } from "./sendTypes";
import {
  CELL_GAP,
  CELL_W,
  MAX_BLOCK_W,
  PITCH,
  RULER_W,
  pitchOf,
  rulerW,
  canResize,
  resizedField,
  resizeWidthBy,
  segEndsBlock,
  caretAt,
  coverageRange,
  guessBadFieldId,
  gridModel,
  insertIndexAtBoundary,
  predictedBlocks,
  rowsOf,
  segBox,
  type GridSeg,
  type EncodedSpans,
} from "./byteGrid";

const f = (over: Partial<SendField>): SendField => ({
  id: "x",
  name: "x",
  type: "uint8",
  endian: "big",
  role: "data",
  source: { kind: "const", bytes: [0x01] },
  ...over,
});

const spec = (fields: SendField[], over: Partial<SendTemplate> = {}): SendTemplate =>
  ({
    id: "t",
    name: "T",
    note: "",
    fields,
    params: [],
    checksum: null,
    nextSeq: 0,
    createdAt: 0,
    ...over,
  }) as SendTemplate;

const encOf = (tpl: SendTemplate): EncodedSpans => {
  const r = encodeSend(tpl, { seq: tpl.nextSeq ?? 0 });
  return { bytes: r.bytes, spans: r.spans };
};

describe("gridModel · 宽度只认编码器那一份", () => {
  it("ascii 的格数跟着值走：HELLO 是 5 格，不是声明的 size 4", () => {
    const tpl = spec([
      f({ id: "h", name: "hdr", source: { kind: "const", bytes: [0xaa] } }),
      f({
        id: "s",
        name: "txt",
        type: "ascii",
        size: 4,
        role: "payload",
        source: { kind: "param", paramId: "P" },
      }),
    ], { params: [{ id: "P", name: "P", type: "text", def: "HELLO" }] });

    const g = gridModel(tpl, encOf(tpl));
    const txt = g.blocks.find((b) => b.fieldId === "s")!;
    expect(txt.len, "编码器铺了 5 个字节，网格就该给 5 格").toBe(5);
    expect(g.total).toBe(6);
  });

  it("每一格都有归属，且各块格数之和 === 帧长", () => {
    const tpl = spec([
      f({ id: "a", name: "帧头", source: { kind: "const", bytes: [0xaa, 0xbb] } }),
      f({ id: "b", name: "len", type: "uint16", role: "length", source: { kind: "len", covers: "after" } }),
      f({ id: "c", name: "v", type: "float64", source: { kind: "const", bytes: [1, 2, 3, 4, 5, 6, 7, 8] } }),
      f({ id: "d", name: "ck", role: "checksum", type: "uint16", source: { kind: "const", bytes: [] } }),
    ], { checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2 } });

    const g = gridModel(tpl, encOf(tpl));
    expect(g.blocks.reduce((s, b) => s + b.len, 0)).toBe(g.total);
    expect(g.owner.every((o) => o !== null), "spans 没盖住的格会是 null —— 那就是画了一格却不属于任何块").toBe(true);
    expect(g.blocks.map((b) => b.fieldId)).toEqual(["a", "b", "c", "d"]);
    expect(g.blocks.map((b) => b.start)).toEqual([0, 2, 4, 12]);
  });

  it("校验段虽然来自 const，值却是算出来的 ⇒ 逐格不可写", () => {
    const tpl = spec([
      f({ id: "d", name: "v", source: { kind: "const", bytes: [7] } }),
      f({ id: "ck", name: "ck", role: "checksum", source: { kind: "const", bytes: [0, 0] } }),
    ], { checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1 } });
    const g = gridModel(tpl, encOf(tpl));
    expect(g.blocks.find((b) => b.fieldId === "d")!.editable).toBe(true);
    expect(g.blocks.find((b) => b.fieldId === "ck")!.editable, "改了也会被第三趟重算盖掉，那是骗人").toBe(false);
  });

  it("参数与变量的格子不可写：字节是类型 + 值 + 字节序的结果", () => {
    const tpl = spec([
      f({ id: "p", name: "p", type: "uint16", source: { kind: "param", paramId: "P" } }),
      f({ id: "q", name: "q", source: { kind: "seq" } }),
    ], { params: [{ id: "P", name: "P", type: "uint", def: "1" }] });
    const g = gridModel(tpl, encOf(tpl));
    expect(g.blocks.map((b) => b.editable)).toEqual([false, false]);
  });

  it("编码没过（enc=null）就没有字节可画：total 0、没有格", () => {
    const tpl = spec([f({ id: "p", name: "p", source: { kind: "param", paramId: "nope" } })]);
    const g = gridModel(tpl, null);
    expect(g.total).toBe(0);
    expect(g.blocks).toEqual([]);
    expect(rowsOf(g, 8)).toEqual([]);
  });
});

describe("coverageRange · 覆盖带与编码器同式", () => {
  it("负终点按距帧尾算", () => {
    expect(coverageRange(0, -2, 10)).toEqual({ start: 0, len: 8 });
    expect(coverageRange(2, 5, 10)).toEqual({ start: 2, len: 4 });
  });
  it("正终点**含**它自己那一格 —— 与 `coverageSlice(bytes,0,1)` 真算到的那两字节一致", () => {
    const tpl = spec([
      f({ id: "d", name: "v", source: { kind: "const", bytes: [1, 2, 3, 4] } }),
      f({ id: "ck", name: "ck", role: "checksum", source: { kind: "const", bytes: [] } }),
    ], { checksum: { algo: "sum8", coverageStart: 0, coverageEnd: 1 } });
    expect(coverageRange(0, 1, 5)).toEqual({ start: 0, len: 2 });
    expect(gridModel(tpl, encOf(tpl)).cov).toEqual({ start: 0, len: 2 });
    // 编码器只把 01 02 加进 sum8 ⇒ 校验字节是 03。网格要是多画一格，这里就对不上
    expect(encOf(tpl).bytes[4]).toBe(0x03);
  });
  it("空范围不画，不硬凑成一格", () => {
    expect(coverageRange(6, 5, 10)).toBeNull();
    expect(coverageRange(0, -20, 10)).toBeNull();
    expect(coverageRange(0, -1, 0)).toBeNull();
  });
  it("网格上的覆盖带：帧长 6、终点 -2 ⇒ 前 4 格", () => {
    const tpl = spec([
      f({ id: "d", name: "v", type: "uint32", source: { kind: "const", bytes: [1, 2, 3, 4] } }),
      f({ id: "ck", name: "ck", role: "checksum", type: "uint16", source: { kind: "const", bytes: [] } }),
    ], { checksum: { algo: "sum16", coverageStart: 0, coverageEnd: -2 } });
    expect(gridModel(tpl, encOf(tpl)).cov).toEqual({ start: 0, len: 4 });
  });
});

describe("rowsOf · 跨行断块", () => {
  const FIELDS = [
    f({ id: "a", name: "AAAA", source: { kind: "const", bytes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }),
    f({ id: "b", name: "BB", source: { kind: "const", bytes: [11, 12] } }),
  ];
  const ten = gridModel(spec(FIELDS), encOf(spec(FIELDS)));

  it("一块跨两行时切成两段，第二段标 cont（不再重复写块名）", () => {
    expect(ten.total).toBe(12);
    const rows = rowsOf(ten, 5);
    expect(rows.map((r) => r.cells)).toEqual([5, 5, 2]);
    expect(rows[0].segs.map((s) => [s.start, s.len, s.cont, s.block.fieldId])).toEqual([[0, 5, false, "a"]]);
    expect(rows[1].segs.map((s) => [s.start, s.len, s.cont, s.block.fieldId])).toEqual([[0, 5, true, "a"]]);
    expect(rows[2].segs.map((s) => [s.start, s.len, s.cont, s.block.fieldId])).toEqual([[0, 2, false, "b"]]);
  });

  it("列数被夹在 4~24：窄面板不许长出一行 40 格撑出滚动条", () => {
    expect(rowsOf(ten, 1)[0].cells).toBe(4);
    const wide = rowsOf(ten, 999);
    expect(wide.length).toBe(1);
    expect(wide[0].cells, "夹到 24 列，但总共只有 12 格").toBe(12);
  });

  it("0 字节的块画成边界上的一个点，且只画一次", () => {
    const g = gridModel(
      spec([
        f({ id: "a", name: "A", source: { kind: "const", bytes: [1, 2] } }),
        f({ id: "z", name: "空", source: { kind: "const", bytes: [] } }),
        f({ id: "b", name: "B", source: { kind: "const", bytes: [3, 4] } }),
      ]),
      { bytes: [1, 2, 3, 4], spans: [
        { fieldId: "a", at: 0, len: 2 },
        { fieldId: "z", at: 2, len: 0 },
        { fieldId: "b", at: 2, len: 2 },
      ] },
    );
    const segs = rowsOf(g, 4)[0].segs;
    expect(segs.filter((s) => s.point).map((s) => s.block.fieldId)).toEqual(["z"]);
    expect(segs.filter((s) => !s.point).map((s) => s.len)).toEqual([2, 2]);
  });

  it("覆盖带跟着行切片：落在本行的那几格才画，出了带的区间一行都不画", () => {
    const tpl = spec([
      f({ id: "d", name: "v", type: "uint32", source: { kind: "const", bytes: [1, 2, 3, 4] } }),
      f({ id: "e", name: "w", type: "uint32", source: { kind: "const", bytes: [5, 6, 7, 8] } }),
      f({ id: "ck", name: "ck", role: "checksum", type: "uint16", source: { kind: "const", bytes: [] } }),
    ], { checksum: { algo: "crc16_ccitt", coverageStart: 0, coverageEnd: -2 } });
    const g = gridModel(tpl, encOf(tpl));
    expect(g.total).toBe(10);
    // 列数最低 4（窄面板不许排 3 格一行），所以 10 字节切 4/4/2
    const rows = rowsOf(g, 3);
    expect(g.cov).toEqual({ start: 0, len: 8 });
    expect(rows.map((r) => r.cov)).toEqual([
      [{ start: 0, len: 4 }],
      [{ start: 0, len: 4 }],
      [],
    ]);
  });
});

describe("insertIndexAtBoundary · 字节边界→插到第几块前面", () => {
  const blocks = gridModel(
    spec([
      f({ id: "a", name: "A", source: { kind: "const", bytes: [1, 2] } }),
      f({ id: "b", name: "B", type: "uint32", source: { kind: "const", bytes: [3, 4, 5, 6] } }),
      f({ id: "c", name: "C", source: { kind: "const", bytes: [7] } }),
    ]),
    { bytes: [1, 2, 3, 4, 5, 6, 7], spans: [
      { fieldId: "a", at: 0, len: 2 },
      { fieldId: "b", at: 2, len: 4 },
      { fieldId: "c", at: 6, len: 1 },
    ] },
  ).blocks;

  it("帧首之前 = 0，帧尾之后 = 块数（追加）", () => {
    expect(insertIndexAtBoundary(blocks, 0)).toBe(0);
    expect(insertIndexAtBoundary(blocks, 7)).toBe(3);
  });
  it("整块之内任一边界都算这块之后：A 结束后（边界 2）插到 B 前 = 1", () => {
    expect(insertIndexAtBoundary(blocks, 1)).toBe(0);
    expect(insertIndexAtBoundary(blocks, 2)).toBe(1);
    expect(insertIndexAtBoundary(blocks, 5)).toBe(1);
    expect(insertIndexAtBoundary(blocks, 6)).toBe(2);
  });
  it("0 字节的点贴在边界右侧 ⇒ 同一边界上的插入排在它前面，否则永远插不进去", () => {
    const withPoint = gridModel(
      spec([
        f({ id: "a", name: "A", source: { kind: "const", bytes: [1, 2] } }),
        f({ id: "z", name: "空", source: { kind: "const", bytes: [] } }),
      ]),
      { bytes: [1, 2], spans: [
        { fieldId: "a", at: 0, len: 2 },
        { fieldId: "z", at: 2, len: 0 },
      ] },
    ).blocks;
    expect(insertIndexAtBoundary(withPoint, 2), "边界 2 上的点不该算\"已经过去了\"").toBe(1);
    expect(insertIndexAtBoundary(withPoint, 3)).toBe(2);
  });
});

describe("caretAt / segBox · 插入指示与像素对齐", () => {
  const g = gridModel(
    spec([
      f({ id: "a", name: "A", source: { kind: "const", bytes: [1, 2] } }),
      f({ id: "b", name: "B", source: { kind: "const", bytes: [3, 4] } }),
    ]),
    { bytes: [1, 2, 3, 4], spans: [{ fieldId: "a", at: 0, len: 2 }, { fieldId: "b", at: 2, len: 2 }] },
  );

  it("块前 = 那一格左边；末尾 = 最后一格右边", () => {
    expect(caretAt(g, 0)).toEqual({ cell: 0, side: "left" });
    expect(caretAt(g, 1)).toEqual({ cell: 2, side: "left" });
    expect(caretAt(g, 2)).toEqual({ cell: 3, side: "right" });
    expect(caretAt(gridModel(spec([]), { bytes: [], spans: [] }), 0)).toBeNull();
  });

  it("段宽 = 格数 × 24 − 2：与格子严丝合缝，又不吃掉那条缝", () => {
    const row = rowsOf(g, 4)[0];
    expect(row.segs.map((s) => segBox(s))).toEqual([
      { left: 0, width: 2 * PITCH - CELL_GAP },
      { left: 2 * PITCH, width: 2 * PITCH - CELL_GAP },
    ]);
  });

  it("点落在边界中央，行首那个夹回 0 不许伸出带外", () => {
    const gp = gridModel(
      spec([f({ id: "z", name: "空", source: { kind: "const", bytes: [] } })]),
      { bytes: [], spans: [{ fieldId: "z", at: 0, len: 0 }] },
    );
    expect(segBox({ block: gp.blocks[0], start: 0, len: 0, cont: false, point: true }).left).toBe(0);
  });
});

describe("predictedBlocks · 编码没过时的降级条带", () => {
  it("校验段按算法给宽，不拿用户填的类型", () => {
    const tpl = spec([
      f({ id: "d", name: "v", source: { kind: "const", bytes: [1] } }),
      f({ id: "ck", name: "ck", type: "uint8", role: "checksum", source: { kind: "const", bytes: [] } }),
    ], { checksum: { algo: "crc32", coverageStart: 0, coverageEnd: -4 } });
    const b = predictedBlocks(tpl);
    expect(b.map((x) => [x.fieldId, x.len])).toEqual([["d", 1], ["ck", 4]]);
  });

  it("crc_custom 的宽在参数里：8 位 ⇒ 1 格", () => {
    const tpl = spec(
      [f({ id: "ck", name: "ck", type: "uint8", role: "checksum", source: { kind: "const", bytes: [] } })],
      {
        checksum: {
          algo: "crc_custom",
          coverageStart: 0,
          coverageEnd: -1,
          crc: { width: 8, poly: 0x07, init: 0x00, refin: false, refout: false, xorout: 0x00 },
        },
      },
    );
    expect(predictedBlocks(tpl)[0].len).toBe(1);
  });

  it("const 块按它自己的字节数摆（4 字节的帧头不许画成 1 格），ascii 按声明 size", () => {
    const tpl = spec([
      f({ id: "a", name: "A", source: { kind: "const", bytes: [1, 2] } }),
      f({ id: "t", name: "T", type: "ascii", size: 6, source: { kind: "param", paramId: "P" } }),
      f({ id: "b", name: "B", source: { kind: "const", bytes: [3] } }),
    ]);
    expect(predictedBlocks(tpl).map((x) => [x.start, x.len])).toEqual([
      [0, 2],
      [2, 6],
      [8, 1],
    ]);
  });
});

describe("guessBadFieldId · 把错误指到块上", () => {
  const tpl = spec([f({ id: "a", name: "帧头", source: { kind: "const", bytes: [1] } }), f({ id: "s", name: "speed", type: "uint8", source: { kind: "param", paramId: "P" } })]);

  it("编码器点名字段，就认得出是哪一块", () => {
    expect(guessBadFieldId("字段「speed」：参数「P」没有值", tpl)).toBe("s");
  });
  it("认不出返回空 —— 宁可不标，也不猜一个看着像的", () => {
    expect(guessBadFieldId("发送谱「T」一个字段都没有", tpl)).toBe("");
  });
  it("名字为空就不参与认领（免得 `「」` 撞上任何话术）", () => {
    expect(guessBadFieldId("字段「」有问题", spec([f({ id: "n", name: "" })]))).toBe("");
  });
});

describe("拖边界改宽度（D1）", () => {
  const f = (over: Partial<SendField>): SendField => ({
    id: "x", name: "x", type: "uint8", endian: "big", role: "data",
    source: { kind: "const", bytes: [1] }, ...over,
  }) as SendField;

  it("一格一字节、四舍五入到整格，夹在 1~64", () => {
    expect(resizeWidthBy(2, 0)).toBe(2);
    expect(resizeWidthBy(2, PITCH - 3)).toBe(3);
    expect(resizeWidthBy(2, PITCH / 2 - 1)).toBe(2); // 半格以内不算改
    expect(resizeWidthBy(2, PITCH / 2)).toBe(3); // 正好半格：按"进到下一格"处理
    expect(resizeWidthBy(3, -999)).toBe(1);
    expect(resizeWidthBy(3, 99999)).toBe(MAX_BLOCK_W);
  });

  it("const 拖宽补 00、拖窄砍尾，动的是它自己的字节数组", () => {
    const c = f({ id: "c", source: { kind: "const", bytes: [0xaa, 0xbb] } });
    expect(resizedField(c, 4)).toEqual({ source: { kind: "const", bytes: [0xaa, 0xbb, 0, 0] } });
    expect(resizedField(c, 1)).toEqual({ source: { kind: "const", bytes: [0xaa] } });
    expect(resizedField(c, 2)).toEqual({ source: { kind: "const", bytes: [0xaa, 0xbb] } });
  });

  it("bcd 动的是声明的 size（它真的决定编出几个字节）", () => {
    const b = f({ id: "b", type: "bcd", size: 2, source: { kind: "param", paramId: "P" } });
    expect(resizedField(b, 4)).toEqual({ size: 4 });
  });

  it("ascii 与定长数值、校验段都不给把手 —— 拖了什么都不改的那颗键是假开关", () => {
    expect(resizedField(f({ type: "ascii", size: 2, source: { kind: "param", paramId: "P" } }), 5)).toBeNull();
    expect(resizedField(f({ type: "uint16", source: { kind: "param", paramId: "P" } }), 4)).toBeNull();
    expect(
      resizedField(f({ role: "checksum", source: { kind: "const", bytes: [0, 0] } }), 4),
    ).toBeNull();
  });

  it("把手问的是「这块的宽度是谁说了算」：写死字节的文本块有，灌值的没有", () => {
    // const 来源 = 这些字节就是字面量，宽度真是它自己定的；param 来源 = 宽度跟着值走，不给把手
    expect(canResize(f({ type: "ascii", source: { kind: "const", bytes: [1] } }))).toBe(true);
    expect(canResize(f({ type: "ascii", size: 2, source: { kind: "param", paramId: "P" } }))).toBe(false);
    expect(resizedField(f({ type: "ascii", source: { kind: "const", bytes: [1] } }), 3)).toEqual({
      source: { kind: "const", bytes: [1, 0, 0] },
    });
    expect(canResize(f({ type: "bcd" }))).toBe(true);
    expect(canResize(f({ role: "header", source: { kind: "const", bytes: [1] } }))).toBe(true);
  });
});

describe("segEndsBlock · 把手只许画在块的右端", () => {
  // 6 + 2 字节、每行 5 格：a 跨两行且在第二行只剩 1 格，b 在那一行的**行内偏移 1** 上收尾
  const rows = rowsOf(
    gridModel(
      spec([
        f({ id: "a", name: "A", source: { kind: "const", bytes: [1, 2, 3, 4, 5, 6] } }),
        f({ id: "b", name: "B", source: { kind: "const", bytes: [7, 8] } }),
      ]),
      {
        bytes: [1, 2, 3, 4, 5, 6, 7, 8],
        spans: [
          { fieldId: "a", at: 0, len: 6 },
          { fieldId: "b", at: 6, len: 2 },
        ],
      },
    ),
    5,
  );

  it("跨行的块：中间那截不算收尾，最后一截才算", () => {
    expect(rows.map((r) => r.cells)).toEqual([5, 3]);
    expect(rows[0].segs.map((s) => [s.block.fieldId, s.start, s.len, s.cont])).toEqual([["a", 0, 5, false]]);
    expect(rows[1].segs.map((s) => [s.block.fieldId, s.start, s.len, s.cont])).toEqual([
      ["a", 0, 1, true],
      ["b", 1, 2, false],
    ]);
    expect(segEndsBlock(rows[0].idx0, rows[0].segs[0])).toBe(false);
    expect(segEndsBlock(rows[1].idx0, rows[1].segs[0])).toBe(true);
  });

  it("块不从头开始的行也算得对 —— 第一版把行内偏移当块内偏移，这类块根本没有把手", () => {
    expect(segEndsBlock(rows[1].idx0, rows[1].segs[1]), "b 行内起点 1、长 2，块起点 6").toBe(true);
  });
});

/* ================= P123-B · 缩放只有一份间距 =================
 * 格宽从设置项 `sbCellSize` 来（20~96），像素一律由 `pitchOf(cellW)` 算。钉两件事：
 *  ① 默认档必须逐字节等于缩放上线前的样子 —— 加一枚设置项不该让任何人的界面动一下；
 *  ② 段宽与拖宽换算跟着 pitch 线性走。别处再写一个字面 24，放大之后就错位。
 */
describe("P123-B 缩放：几何只认 pitchOf(cellW)", () => {
  it("默认档 = 缩放上线前的原样（22 的格、30 的尺、24 的间距）", () => {
    expect(pitchOf(CELL_W)).toBe(PITCH);
    expect(rulerW(CELL_W)).toBe(RULER_W);
  });

  const seg = (start: number, len: number): GridSeg =>
    ({
      block: { fieldId: "a", name: "a", role: "data", start, len, type: "uint8", color: "" },
      start,
      len,
      cont: false,
      point: false,
    }) as GridSeg;

  it("段宽随格宽线性走：44 档下第 2 块起、占 3 格的段落在 92px、宽 136px", () => {
    expect(segBox(seg(2, 3), pitchOf(44))).toEqual({ left: 2 * 46, width: 3 * 46 - CELL_GAP });
    expect(segBox(seg(2, 3)).left, "不传间距就是默认档").toBe(2 * PITCH);
  });

  it("拖宽按当前档算：拖 46px 在 44 档是一格，拖 24px 在 22 档也是一格", () => {
    expect(resizeWidthBy(2, 46, pitchOf(44))).toBe(3);
    expect(resizeWidthBy(2, 24, pitchOf(22))).toBe(3);
    expect(resizeWidthBy(2, 25, pitchOf(44)), "44 档下过半格(23)就进到下一格").toBe(3);
    expect(resizeWidthBy(2, 22, pitchOf(44)), "不到半格不算改").toBe(2);
  });
});
