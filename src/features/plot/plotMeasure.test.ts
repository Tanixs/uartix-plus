import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildMeasure,
  fmtVal,
  hexA,
  interpAt,
  readPanelPos,
  stackSlotOf,
  writePanelPos,
  yRangeOf,
} from "./plotMeasure";

const store: Record<string, string> = {};
beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
});

describe("fmtVal", () => {
  it("空值/非有限 → —", () => {
    expect(fmtVal(null)).toBe("—");
    expect(fmtVal(undefined)).toBe("—");
    expect(fmtVal(NaN)).toBe("—");
    expect(fmtVal(Infinity)).toBe("—");
  });
  it("整数原样，小数三位", () => {
    expect(fmtVal(42)).toBe("42");
    expect(fmtVal(1.23456)).toBe("1.235");
  });
});

describe("hexA", () => {
  it("转 rgba", () => {
    expect(hexA("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
  });
});

describe("interpAt", () => {
  const d = { t: [0, 10, 20, 30], v: [0, 10, 20, 30] };
  it("空数据 null", () => {
    expect(interpAt({ t: [], v: [] }, 5)).toBeNull();
  });
  it("两端钳制", () => {
    expect(interpAt(d, -5)).toBe(0);
    expect(interpAt(d, 99)).toBe(30);
  });
  it("中点线性插值", () => {
    expect(interpAt(d, 5)).toBe(5);
    expect(interpAt({ t: [0, 10], v: [0, 20] }, 5)).toBe(10);
  });
  it("重复时间戳不除零", () => {
    expect(interpAt({ t: [5, 5, 5], v: [7, 8, 9] }, 5)).toBe(7);
  });
});

describe("yRangeOf", () => {
  const data = [[0, 1, 2, 3], [1, 2, null, 4], [100, null, null, -100]] as const;
  it("只统计视野内点（历史极值不拉爆，P21）", () => {
    const r = yRangeOf(data as unknown as never[], [{ visible: true }, { visible: true }], 0, 1, "auto");
    expect(r).not.toBeNull();
    const [mn, mx] = r!;
    expect(mn).toBeLessThanOrEqual(1);
    expect(mx).toBeGreaterThanOrEqual(100);
    expect(mx).toBeLessThan(150);
    const r2 = yRangeOf(data as unknown as never[], [{ visible: true }, { visible: true }], 2, 3, "auto");
    expect(r2![1]).toBeLessThan(15);
    expect(r2![0]).toBeLessThan(0);
  });
  it("隐藏通道不参与", () => {
    const r = yRangeOf(data as unknown as never[], [{ visible: true }, { visible: false }], null, null, "auto");
    expect(r).toEqual([0.7, 4.3]);
  });
  it("zero 模式对称于 0", () => {
    const r = yRangeOf([[0, 1], [3, -1]] as unknown as never[], [{ visible: true }], null, null, "zero");
    expect(r).toEqual([-3 * 1.15, 3 * 1.15]);
  });
  it("全隐藏/无有效值 → null", () => {
    expect(yRangeOf(data as unknown as never[], [{ visible: false }, { visible: false }], null, null, "auto")).toBeNull();
  });
});

describe("stackSlotOf", () => {
  it("归一化位置钳制到槽位范围", () => {
    expect(stackSlotOf(-0.5, 3)).toBe(0);
    expect(stackSlotOf(0.5, 3)).toBe(1);
    expect(stackSlotOf(1.5, 3)).toBe(2);
    expect(stackSlotOf(0.999, 3)).toBe(2);
  });
});

describe("buildMeasure", () => {
  const xs = [0, 10, 20];
  const ch = [
    { id: "a", name: "A", color: "#f00", visible: true },
    { id: "b", name: "B", color: "#0f0", visible: true },
  ];
  const data = [xs, [0, 10, 20], [100, 200, 300]] as unknown as never[];

  it("无 A 游标 → null", () => {
    expect(buildMeasure({ a: null, b: null }, "x", false, xs, ch, data as never, [], [])).toBeNull();
  });

  it("x 模式：插值取值 + Δ", () => {
    const m = buildMeasure({ a: 5, b: 15 }, "x", false, xs, ch, data as never, [], [])!;
    expect(m.rows[0]).toMatchObject({ name: "A", v1: 5, v2: 15, dv: 10 });
    expect(m.rows[1].v1).toBe(150);
    expect(m.d).toBe(10);
  });

  it("x 模式：缺 B 时 d/v2 为 null", () => {
    const m = buildMeasure({ a: 5, b: null }, "x", false, xs, ch, data as never, [], [])!;
    expect(m.d).toBeNull();
    expect(m.rows[0].v2).toBeNull();
  });

  it("y 模式非堆叠：单可见通道带 focus", () => {
    const m = buildMeasure({ a: 7.5, b: null }, "y", false, xs, [ch[0]], data as never, [], [])!;
    expect(m.a).toBe(7.5);
    expect(m.focus).toEqual({ name: "A", color: "#f00" });
  });

  it("y 模式堆叠：反仿射换算原始值 + 聚焦通道（P24）", () => {
    const slots = [
      { ci: 0, name: "A", color: "#f00" },
      { ci: 1, name: "B", color: "#0f0" },
    ];
    const affine = [{ a: 2, b: 1 }, { a: 2, b: 1 }];
    const m = buildMeasure({ a: 0.75, b: null }, "y", true, xs, ch, data as never, affine, slots)!;
    expect(m.focus).toEqual({ name: "B", color: "#0f0" });
    expect(m.a).toBeCloseTo((0.75 - 1) / 2);
  });
});

describe("panelPos 持久化", () => {
  it("未保存 → null", () => {
    expect(readPanelPos("x")).toBeNull();
  });
  it("写后读回", () => {
    writePanelPos("x", { l: 12, b: 34 });
    expect(readPanelPos("x")).toEqual({ l: 12, b: 34 });
    expect(readPanelPos("y")).toBeNull();
  });
  it("负值钳制 0", () => {
    writePanelPos("y", { l: -5, b: -9 });
    expect(readPanelPos("y")).toEqual({ l: 0, b: 0 });
  });
  it("损坏 JSON 容错回 null", () => {
    store["vs.plotPanelPos"] = "{broken";
    expect(readPanelPos("x")).toBeNull();
  });
});
