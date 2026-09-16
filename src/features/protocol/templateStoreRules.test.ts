import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/framesBus", () => ({ onFrames: () => () => undefined }));

vi.mock("../settings/settingsStore", () => ({
  getSnapshot: () => ({
    theme: "dark",
    locale: "zh",
    zoom: 100,
    palette: "okabe",
    channels: [],
  }),
  subscribe: () => () => {},
  patch: () => undefined,
}));

vi.mock("../../panels/panelActivity", () => ({
  isOpen: () => false,
  markOpen: () => undefined,
  markClose: () => undefined,
  subscribe: () => () => {},
}));

import * as templateStore from "./templateStore";
import type { FieldDef, FrameTemplate } from "../../ipc/types";

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
  });
  vi.useFakeTimers();
  templateStore.replaceRules([]);
});

const fld = (p: Partial<FieldDef>): FieldDef => ({
  id: "f1",
  name: "字段",
  role: "data",
  offset: 0,
  type: "uint16",
  endian: "little",
  color: "#3fb950",
  ...p,
});

function makeTpl(p: Partial<FrameTemplate>): string {
  const id = p.id ?? "t1";
  templateStore.replaceRules([
    {
      id,
      name: "T",
      color: "#fff",
      enabled: true,
      boundary: { mode: "fixedLength", headerBytes: [], maxLength: 16, fixedLength: 8 },
      checksum: null,
      fields: [],
      ...p,
    } as FrameTemplate,
  ]);
  return id;
}

const getTpl = (id: string) =>
  templateStore.getSnapshot().rules.templates.find((t) => t.id === id)!;

describe("fieldConflictInfo（P85a 有效区间冲突）", () => {
  it("负偏移字段参与正偏移候选的重叠检测（旧缺陷：静默覆盖）", () => {
    makeTpl({
      boundary: { mode: "lengthField", headerBytes: [], maxLength: 20 },
      fields: [fld({ id: "tail", name: "尾", offset: -4, type: "uint32" })],
    });
    const c = templateStore.fieldConflictInfo("t1", "new", 12, 2, { frameLen: 16 });
    expect(c.overlapName).toBe("尾");
    expect(c.overlapBytes).toBe(2);
  });

  it("帧尾校验域为保护区：checksum 类 overTail", () => {
    makeTpl({
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
      fields: [fld({ id: "a", offset: 1, type: "uint8" })],
    });
    const c = templateStore.fieldConflictInfo("t1", "new", 7, 1, { frameLen: 8 });
    expect(c.overTail).toMatchObject({ kind: "checksum", bytes: 1 });
  });

  it("编辑校验字段自身不触发 overTail（selfRole/existing 豁免）", () => {
    makeTpl({
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
      fields: [fld({ id: "ck", name: "ck", offset: 7, role: "checksum", type: "uint8" })],
    });
    const c = templateStore.fieldConflictInfo("t1", "ck", 7, 1, {
      frameLen: 8,
      selfRole: "checksum",
    });
    expect(c.overTail).toBeUndefined();
    expect(c.overlapName).toBeUndefined();
  });

  it("帧尾定界字节为保护区：footer 类 overTail", () => {
    makeTpl({
      boundary: {
        mode: "footer",
        headerBytes: [],
        footerBytes: [0x0d, 0x0a],
        maxLength: 20,
      },
    });
    const c = templateStore.fieldConflictInfo("t1", "new", 7, 1, { frameLen: 8 });
    expect(c.overTail).toMatchObject({ kind: "footer", bytes: 1 });
  });

  it("同字节 bits×bits 位段分解免确认；bits×uint8 仍需", () => {
    makeTpl({ fields: [fld({ id: "b1", name: "位1", offset: 2, type: "bits" })] });
    const both = templateStore.fieldConflictInfo("t1", "new", 2, 1, { selfType: "bits" });
    expect(both.overlapName).toBeUndefined();
    const mixed = templateStore.fieldConflictInfo("t1", "new", 2, 1, { selfType: "uint8" });
    expect(mixed.overlapName).toBe("位1");
  });

  it("帧头区新建字段：overHeader；存量重叠字段原样编辑豁免（P85a 补洞）", () => {
    makeTpl({
      boundary: { mode: "fixedLength", headerBytes: [0xaa, 0xbb], maxLength: 16, fixedLength: 12 },
      fields: [fld({ id: "h0", name: "掩码位", offset: 1, type: "uint8" })],
    });
    const c = templateStore.fieldConflictInfo("t1", "new", 0, 2, { frameLen: 12 });
    expect(c.overHeader).toBe(2);
    const edit = templateStore.fieldConflictInfo("t1", "h0", 1, 1, { frameLen: 12 });
    expect(edit.overHeader).toBeUndefined();
  });

  it("overFrame 用总帧长（定长）", () => {
    makeTpl({});
    const c = templateStore.fieldConflictInfo("t1", "new", 6, 4, { frameLen: 8 });
    expect(c.overFrame).toContain("超出帧长");
  });
});

describe("insertFrameCell / deleteFrameCell（P85a 联动修正）", () => {
  it("帧尾允许追加格（g==帧长，旧缺陷被拒）", () => {
    makeTpl({ fields: [fld({ id: "a", offset: 2, type: "uint16" })] });
    expect(templateStore.insertFrameCell("t1", 8)).toBeNull();
    expect(getTpl("t1").boundary.fixedLength).toBe(9);
    expect(getTpl("t1").fields.find((f) => f.id === "a")!.offset).toBe(2);
  });

  it("插格平移其后字段（含负偏移不动）", () => {
    makeTpl({
      boundary: { mode: "fixedLength", headerBytes: [0x55], maxLength: 16, fixedLength: 8 },
      fields: [
        fld({ id: "a", offset: 4, type: "uint16" }),
        fld({ id: "t", offset: -3, type: "uint8" }),
      ],
    });
    expect(templateStore.insertFrameCell("t1", 4)).toBeNull();
    const t = getTpl("t1");
    expect(t.fields.find((f) => f.id === "a")!.offset).toBe(5);
    expect(t.fields.find((f) => f.id === "t")!.offset).toBe(-3);
    expect(t.boundary.fixedLength).toBe(9);
  });

  it("字段占用中禁止插入/删除；删除字段首字节也被拦（旧缺陷④）", () => {
    makeTpl({ fields: [fld({ id: "a", offset: 4, type: "float32" })] });
    expect(templateStore.insertFrameCell("t1", 5)).toContain("占用");
    expect(templateStore.deleteFrameCell("t1", 4)).toContain("占用");
    expect(templateStore.deleteFrameCell("t1", 6)).toContain("占用");
  });

  it("校验尾区不可删格；锁定字段被位移时拦截", () => {
    makeTpl({
      checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2, endian: "little" },
    });
    expect(templateStore.deleteFrameCell("t1", 6)).toContain("校验");
    makeTpl({ fields: [fld({ id: "lk", offset: 4, type: "uint8", locked: true })] });
    expect(templateStore.insertFrameCell("t1", 2)).toContain("锁定");
    expect(templateStore.deleteFrameCell("t1", 2)).toContain("锁定");
  });

  it("变长模式给出引导文案而非沉默", () => {
    makeTpl({ boundary: { mode: "lengthField", headerBytes: [], maxLength: 30 } });
    expect(templateStore.insertFrameCell("t1", 2)).toContain("截帧配置");
    expect(templateStore.deleteFrameCell("t1", 2)).toContain("截帧配置");
  });
});

describe("upsertFieldLinked（P86a 校验锚尾归一化 + 模式联动单事务）", () => {
  it("定长帧中间建 CK1 → 自动贴尾（offset=帧长−宽度，coverageEnd 负距尾）", () => {
    makeTpl({
      boundary: { mode: "fixedLength", headerBytes: [0xaa], maxLength: 16, fixedLength: 12 },
    });
    templateStore.upsertFieldLinked(
      "t1",
      fld({ id: "ck", role: "checksum", offset: 5, type: "uint16" }),
      null,
      "crc16_modbus",
    );
    const t = getTpl("t1");
    expect(t.fields.find((f) => f.id === "ck")!.offset).toBe(10);
    expect(t.checksum).toMatchObject({ algo: "crc16_modbus", coverageEnd: -2 });
  });

  it("keepMiddle 高级路径：字段留原位，coverageEnd 同步为绝对偏移（引擎一致）", () => {
    makeTpl({ boundary: { mode: "fixedLength", headerBytes: [], maxLength: 16, fixedLength: 12 } });
    templateStore.upsertFieldLinked(
      "t1",
      fld({ id: "ck", role: "checksum", offset: 5, type: "uint16" }),
      null,
      "crc16_modbus",
      { keepMiddle: true },
    );
    const t = getTpl("t1");
    expect(t.fields.find((f) => f.id === "ck")!.offset).toBe(5);
    expect(t.checksum!.coverageEnd).toBe(5);
  });

  it("变长帧建 CK1 → 存负偏移；footer 模式含帧尾字距离", () => {
    makeTpl({ boundary: { mode: "lengthField", headerBytes: [0x55], lengthOffset: 1, lengthSize: 1, maxLength: 30 } });
    templateStore.upsertFieldLinked(
      "t1",
      fld({ id: "ck", role: "checksum", offset: 3, type: "uint8" }),
      null,
      "sum8",
    );
    expect(getTpl("t1").fields.find((f) => f.id === "ck")!.offset).toBe(-1);
    const t2 = makeTpl({
      id: "t2",
      boundary: { mode: "footer", headerBytes: [], footerBytes: [0x0d, 0x0a], maxLength: 30 },
    });
    templateStore.upsertFieldLinked(
      t2,
      fld({ id: "ck", role: "checksum", offset: 3, type: "uint8" }),
      null,
      "sum8",
    );
    const v = getTpl("t2");
    expect(v.fields.find((f) => f.id === "ck")!.offset).toBe(-3);
    expect(v.checksum!.coverageEnd).toBe(-3);
  });

  it("切算法：贴尾字段跟随新宽度贴尾（一步撤销整体还原）", () => {
    makeTpl({
      boundary: { mode: "fixedLength", headerBytes: [], maxLength: 16, fixedLength: 12 },
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
      fields: [fld({ id: "ck", role: "checksum", offset: 11, type: "uint8" })],
    });
    templateStore.setChecksumAlgo("t1", "crc16_modbus");
    const t = getTpl("t1");
    expect(t.fields.find((f) => f.id === "ck")!.offset).toBe(10);
    expect(t.checksum).toMatchObject({ algo: "crc16_modbus", coverageEnd: -2 });
    templateStore.undo();
    expect(getTpl("t1").fields.find((f) => f.id === "ck")!.offset).toBe(11);
  });

  it("footer 字段单事务：切模式 + footerBytes + 字段负偏移，一步撤销", () => {
    makeTpl({ boundary: { mode: "fixedLength", headerBytes: [], maxLength: 16, fixedLength: 12 } });
    templateStore.upsertFieldLinked(
      "t1",
      fld({ id: "ft", role: "footer", offset: 10, type: "uint16" }),
      null,
      null,
      { switchMode: "footer", footerBytes: [0x0d, 0x0a] },
    );
    const t = getTpl("t1");
    expect(t.boundary.mode).toBe("footer");
    expect(t.boundary.footerBytes).toEqual([0x0d, 0x0a]);
    expect(t.fields.find((f) => f.id === "ft")!.offset).toBe(-2);
    templateStore.undo();
    const u = getTpl("t1");
    expect(u.boundary.mode).toBe("fixedLength");
    expect(u.fields).toHaveLength(0);
  });

  it("LEN 字段单事务：切 lengthField 并同步长度域", () => {
    makeTpl({ boundary: { mode: "fixedLength", headerBytes: [0xaa], maxLength: 16, fixedLength: 12 } });
    templateStore.upsertFieldLinked(
      "t1",
      fld({ id: "ln", role: "length", offset: 3, type: "uint8" }),
      null,
      null,
      { switchMode: "lengthField" },
    );
    const t = getTpl("t1");
    expect(t.boundary.mode).toBe("lengthField");
    expect(t.boundary.lengthOffset).toBe(3);
    expect(t.boundary.lengthSize).toBe(1);
  });
});

describe("setHeaderBytes / removeChecksumField / revealField", () => {
  it("帧头增长：字段/长度域/识别位自动平移；负偏移不动", () => {
    makeTpl({
      boundary: {
        mode: "lengthField",
        headerBytes: [0xaa],
        lengthOffset: 2,
        lengthSize: 1,
        maxLength: 30,
      },
      fields: [
        fld({ id: "a", offset: 2, role: "length", type: "uint8" }),
        fld({ id: "d", offset: 5, type: "uint8" }),
        fld({ id: "t", offset: -2, type: "uint16" }),
      ],
    });
    expect(templateStore.setHeaderBytes("t1", [0xaa, 0xbb])).toBeNull();
    const t = getTpl("t1");
    expect(t.boundary.lengthOffset).toBe(3);
    expect(t.fields.find((f) => f.id === "a")!.offset).toBe(3);
    expect(t.fields.find((f) => f.id === "d")!.offset).toBe(6);
    expect(t.fields.find((f) => f.id === "t")!.offset).toBe(-2);
  });

  it("帧头缩减反向平移；超长帧头/超界拒绝", () => {
    makeTpl({
      boundary: { mode: "fixedLength", headerBytes: [0xaa, 0xbb], maxLength: 16, fixedLength: 4 },
      fields: [fld({ id: "a", offset: 2, type: "uint16" })],
    });
    expect(templateStore.setHeaderBytes("t1", [0xaa])).toBeNull();
    expect(getTpl("t1").fields.find((f) => f.id === "a")!.offset).toBe(1);
    expect(templateStore.setHeaderBytes("t1", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toContain("8 字节");
    expect(templateStore.setHeaderBytes("t1", [1, 2, 3, 4])).toContain("总帧长");
  });

  it("removeChecksumField：删字段同时停用校验，一步可撤销", () => {
    makeTpl({
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
      fields: [fld({ id: "ck", role: "checksum", offset: 7, type: "uint8" })],
    });
    templateStore.removeChecksumField("t1", "ck");
    const t = getTpl("t1");
    expect(t.fields).toHaveLength(0);
    expect(t.checksum!.algo).toBe("none");
    templateStore.undo();
    const u = getTpl("t1");
    expect(u.fields).toHaveLength(1);
    expect(u.checksum!.algo).toBe("sum8");
  });

  it("revealField 单调 nonce", () => {
    templateStore.revealField("t1", "f1");
    const a = templateStore.getSnapshot().revealReq;
    templateStore.revealField("t1", "f2");
    const b = templateStore.getSnapshot().revealReq;
    expect(a!.nonce).toBeLessThan(b!.nonce);
    expect(b).toMatchObject({ tplId: "t1", fieldId: "f2" });
  });
});
