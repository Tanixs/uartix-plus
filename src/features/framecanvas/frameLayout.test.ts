import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FieldDef, FrameTemplate } from "../../ipc/types";
import { buildBlocks, layoutBlocks, reservedTail, skeletonLen } from "./frameLayout";

beforeAll(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
});

const fld = (p: Partial<FieldDef>): FieldDef => ({
  id: "f1",
  name: "n",
  role: "data",
  offset: 0,
  type: "uint16",
  endian: "little",
  color: "#fff",
  ...p,
});

const tpl = (p: Partial<FrameTemplate> & { boundary: FrameTemplate["boundary"] }): FrameTemplate => ({
  id: "t",
  name: "t",
  color: "#fff",
  enabled: true,
  checksum: null,
  fields: [],
  ...p,
});

const fixed = (len: number, extra: Partial<FrameTemplate> = {}) =>
  tpl({
    boundary: { mode: "fixedLength", headerBytes: [], maxLength: len, fixedLength: len },
    ...extra,
  });

describe("skeletonLen", () => {
  it("定长帧直接取帧长", () => {
    expect(skeletonLen(fixed(12))).toBe(12);
  });
  it("变长帧按字段尾+保留区，钳制 [8,64]", () => {
    const t = tpl({
      boundary: { mode: "lengthField", headerBytes: [0x55], lengthOffset: 1, lengthSize: 1, maxLength: 64 },
      fields: [fld({ offset: 2, type: "float32" })],
      checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2, endian: "little" },
    });
    expect(skeletonLen(t)).toBe(2 + 4 + 2 + 4);
    const tiny = tpl({ boundary: { mode: "lengthField", headerBytes: [], maxLength: 64 }, fields: [] });
    expect(skeletonLen(tiny)).toBe(8);
  });
  it("负偏移字段按距帧尾距离参与骨架伸展", () => {
    const t = tpl({
      boundary: { mode: "lengthField", headerBytes: [], maxLength: 64 },
      fields: [fld({ offset: -6, type: "uint16" })],
    });
    expect(skeletonLen(t)).toBe(6 + 4);
  });
});

describe("reservedTail", () => {
  it("校验+帧尾合计", () => {
    const t = tpl({
      boundary: { mode: "footer", headerBytes: [], footerBytes: [0x0d, 0x0a], maxLength: 32 },
      checksum: { algo: "crc32", coverageStart: 0, coverageEnd: -4, endian: "big" },
    });
    expect(reservedTail(t)).toBe(4 + 2);
  });
});

describe("buildBlocks", () => {
  it("空模板 → 单一 gap 铺满", () => {
    const bs = buildBlocks(null, 10);
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ kind: "gap", start: 0, len: 10 });
  });

  it("帧头范围内的字段块被跳过（双55回归）", () => {
    const t = tpl({
      boundary: { mode: "fixedLength", headerBytes: [0x55, 0x55], maxLength: 8, fixedLength: 8 },
      fields: [fld({ id: "hd", offset: 0, type: "uint16" })],
    });
    const bs = buildBlocks(t, 8);
    expect(bs.find((b) => b.kind === "hdr")).toMatchObject({ start: 0, len: 2 });
    expect(bs.find((b) => b.fid === "hd")).toBeUndefined();
  });

  it("负偏移字段尾锚定（P38）", () => {
    const t = tpl({
      boundary: { mode: "lengthField", headerBytes: [], maxLength: 20 },
      fields: [fld({ id: "tail", name: "尾", offset: -4, type: "uint32" })],
    });
    const bs = buildBlocks(t, 16);
    const blk = bs.find((b) => b.fid === "tail")!;
    expect(blk).toMatchObject({ start: 12, len: 4, kind: "fld" });
  });

  it("spanTail 遇后继字段裁剪，不越界（P38 红线）", () => {
    const t = tpl({
      boundary: { mode: "lengthField", headerBytes: [], maxLength: 30 },
      fields: [
        fld({ id: "pl", name: "载荷", offset: 2, role: "payload", type: "ascii", spanTail: true }),
        fld({ id: "ck", name: "ck", offset: 12, role: "checksum", type: "uint16" }),
      ],
    });
    const bs = buildBlocks(t, 20);
    const pl = bs.find((b) => b.fid === "pl")!;
    expect(pl.start).toBe(2);
    expect(pl.start + pl.len).toBeLessThanOrEqual(12);
  });

  it("变长帧校验字段锚定帧尾（CK 负偏移语义）", () => {
    const t = tpl({
      boundary: { mode: "lengthField", headerBytes: [], maxLength: 30 },
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
      fields: [fld({ id: "ck", name: "ck", offset: 0, role: "checksum", type: "uint8" })],
    });
    const bs = buildBlocks(t, 18);
    const ck = bs.find((b) => b.fid === "ck")!;
    expect(ck.start + ck.len).toBe(18);
    expect(bs.find((b) => b.kind === "ftr")).toBeUndefined();
  });

  it("无显式校验字段时帧尾画保留区块", () => {
    const t = tpl({
      boundary: { mode: "lengthField", headerBytes: [], maxLength: 30 },
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
    });
    const bs = buildBlocks(t, 18);
    const ftr = bs.find((b) => b.kind === "ftr")!;
    expect(ftr).toMatchObject({ start: 17, len: 1 });
  });

  it("块按有效位置排序输出（乱序字段输入）", () => {
    const t = tpl({
      boundary: { mode: "lengthField", headerBytes: [], maxLength: 20 },
      fields: [
        fld({ id: "b", offset: 8, type: "uint16" }),
        fld({ id: "a", offset: 2, type: "uint16" }),
      ],
    });
    const bs = buildBlocks(t, 16);
    const flds = bs.filter((b) => b.kind === "fld");
    expect(flds.map((f) => f.fid)).toEqual(["a", "b"]);
    for (let i = 1; i < flds.length; i++) expect(flds[i].start).toBeGreaterThanOrEqual(flds[i - 1].start + flds[i - 1].len);
  });

  it("gap 合并且全块不重叠、铺满帧长", () => {
    const t = tpl({
      boundary: { mode: "fixedLength", headerBytes: [0x51], maxLength: 10, fixedLength: 10 },
      fields: [fld({ id: "x", offset: 4, type: "float32" })],
    });
    const bs = buildBlocks(t, 10);
    let pos = 0;
    for (const b of bs) {
      expect(b.start).toBe(pos);
      pos = b.start + b.len;
    }
    expect(pos).toBe(10);
    expect(bs.filter((b) => b.kind === "gap").length).toBeLessThanOrEqual(3);
  });
});

describe("layoutBlocks", () => {
  const totalCells = (rows: { items: { g0: number; g1: number }[] }[]) =>
    rows.reduce((n, r) => n + r.items.reduce((m, i) => m + (i.g1 - i.g0 + 1), 0), 0);

  it("跨行块带续接标记 p0/p1，总格数守恒", () => {
    const bs = [{ start: 0, len: 40, key: "g0", kind: "gap" as const, fid: null, color: "", label: null, role: null, locked: false }];
    const { rows } = layoutBlocks(bs, 24, 24 * 8 + 24);
    expect(totalCells(rows)).toBe(40);
    const continued = rows.flatMap((r) => r.items).filter((i) => i.p0);
    expect(continued.length).toBeGreaterThan(0);
  });

  it("行首剩余不足一格时强制换行（两格 bug 回归）", () => {
    const bs = [
      { start: 0, len: 3, key: "a", kind: "fld" as const, fid: "a", color: "#f00", label: "a", role: null, locked: false },
      { start: 3, len: 3, key: "b", kind: "fld" as const, fid: "b", color: "#0f0", label: "b", role: null, locked: false },
    ];
    const s = 40;
    const width = 40 + 10 + 14 + 4;
    const { rows } = layoutBlocks(bs, s, width);
    for (const r of rows) {
      for (const it of r.items) {
        expect(it.x1 - it.x0 + 40).toBeGreaterThanOrEqual(40);
        expect(it.x0).toBeLessThanOrEqual(width - 14 - 40 + 1);
      }
    }
    expect(totalCells(rows)).toBe(6);
  });

  it("每格 g 序号连续覆盖块范围", () => {
    const bs = [
      { start: 0, len: 2, key: "h", kind: "hdr" as const, fid: null, color: "", label: null, role: null, locked: false },
      { start: 2, len: 14, key: "f", kind: "fld" as const, fid: "f", color: "", label: null, role: null, locked: false },
    ];
    const { rows } = layoutBlocks(bs, 20, 200);
    const items = rows.flatMap((r) => r.items);
    let expect_g = 0;
    for (const i of items) {
      expect(i.g0).toBe(expect_g);
      expect_g = i.g1 + 1;
    }
    expect(expect_g).toBe(16);
  });
});
