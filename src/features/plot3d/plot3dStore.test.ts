/**
 * P69 plot3dStore 数据泵测试 · P87a 三组升级。
 *
 * 覆盖核心红线逻辑：
 * - v1→v2 设置迁移等价（单轨迹 → 组1；style→mode/showDots 映射；旧 Operator 包兼容）
 * - 逐组独立：一组签名变化只重灌该组；水位续传逐组互不干扰
 * - 时间水位 lastT 续传：源重建/裁剪后不重复消费、不漏段
 * - 绑定/通道/密度/配对/模式/平滑签名变化 → 该组 reloaded 全量重灌
 * - 密度 stride 抽稀（高 1:1 / 中 1:2 / 低 1:4）
 * - 三轴时间戳配对（P75 B2）：同帧同 ts → 每帧 1 点（阶梯根因回归）；
 *   插值/最近邻/union 前向填充；容差外跳过计入 pairSnapshot(组)
 * - 着色通道 valCarry 前向填充；绑定通道被删除 → 逐组自动解绑（悬空纠正语义）
 * - 三轴未绑齐不消费；从未消费的组不发噪声重灌批次；setSink(null) 停泵
 * - P87a A7 撤销/重做栈：配置入栈一步还原；重复值不压栈；清空不入栈；上限 50
 * - P70 时间游标：显式 scrub（含共享预览）> 回放跟随 > null；seek 向后空批次回退、向前水位跳重；
 *   回放结束恢复 null；lowerBoundLe 二分边界
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const chans = [
    { id: "ax", tplId: "t", fieldId: "f1", name: "加计X", color: "#ff0000", visible: true },
    { id: "ay", tplId: "t", fieldId: "f2", name: "加计Y", color: "#00ff00", visible: true },
    { id: "az", tplId: "t", fieldId: "f3", name: "加计Z", color: "#0000ff", visible: true },
    { id: "mag", tplId: "t", fieldId: "f4", name: "磁场", color: "#ffff00", visible: true },
  ];
  // P75 B2：泵消费「每通道原始序列」（各通道自己的时间戳），不再走联合对齐源
  type Series = { t: number[]; v: number[] };
  let series: Record<string, Series> = {};
  return {
    chans,
    getChanData: (id: string): Series => series[id] ?? { t: [], v: [] },
    setSeries: (s: Record<string, Series>) => {
      series = s;
    },
  };
});

vi.mock("../plot/plotStore", () => ({
  getChanData: (id: string) => h.getChanData(id),
  timeOrigin: () => 0,
  getSnapshot: () => ({ channels: h.chans }),
}));

// sessionStore 会拖进 serialStore/settingsStore（模块顶层读 localStorage）——桩掉即可；
// 回放态测试经 _setSessionForTest 注入，不依赖此桩的返回值
vi.mock("../session/sessionStore", () => ({
  getSnapshot: () => ({ state: "idle", firstTs: 0, posMs: 0 }),
}));

import * as panelActivity from "../../panels/panelActivity";
import * as store from "./plot3dStore";
import { setOperatorLocked } from "../operator/lock";
import { lowerBoundLe } from "./scene";
import type { FitOk } from "./ellipsoidFit";

/** 推 120ms 泵时钟 */
function pump(steps = 1) {
  for (let i = 0; i < steps; i++) vi.advanceTimersByTime(125);
}

/** 基准源：6 帧同 ts（0,10,...,50ms）的原始序列；mag 从 t=10 起才有样本（对应旧首行 null） */
function makeSeries(): Record<string, { t: number[]; v: number[] }> {
  return {
    ax: { t: [0, 10, 20, 30, 40, 50], v: [1, 2, 3, 4, 5, 6] },
    ay: { t: [0, 10, 20, 30, 40, 50], v: [11, 12, 13, 14, 15, 16] },
    az: { t: [0, 10, 20, 30, 40, 50], v: [21, 22, 23, 24, 25, 26] },
    mag: { t: [10, 20, 30, 40, 50], v: [100, 101, 102, 103, 104] },
  };
}

/** 测试数据直译器：旧「联合列 + null」写法 → 原始序列（null = 该时刻该通道无样本） */
function ser(
  ts: number[],
  ...cols: (number | null)[][]
): Record<string, { t: number[]; v: number[] }> {
  const ids = ["ax", "ay", "az", "mag"];
  const out: Record<string, { t: number[]; v: number[] }> = {};
  cols.forEach((c, i) => {
    const t: number[] = [];
    const v: number[] = [];
    for (let k = 0; k < ts.length; k++) {
      if (c[k] != null) {
        t.push(ts[k]);
        v.push(c[k] as number);
      }
    }
    out[ids[i]] = { t, v };
  });
  return out;
}

type Batch = { t: number[]; x: number[]; y: number[]; z: number[]; val: number[] };
type Call = { entries: store.GroupBatch[]; cursor: number | null };

function collect(): Call[] {
  const calls: Call[] = [];
  store.setSink((entries, cursor) => calls.push({ entries, cursor }));
  return calls;
}

/** 组批次序列（过滤出某组的 {b, reloaded}） */
function gseq(calls: Call[], gid: store.GroupId) {
  const out: { b: Batch; reloaded: boolean }[] = [];
  for (const c of calls)
    for (const e of c.entries) if (e.gid === gid) out.push({ b: e.b, reloaded: e.reloaded });
  return out;
}

/** 组1 绑基准三轴：走 import 路径（normalize 全量替换，不压撤销栈——
 *  撤销栈测试需要「起点栈空」的可控前置） */
function bindG1() {
  store.importSettingsFromPkg({
    v: 2,
    groups: [{ id: "g1", chX: "ax", chY: "ay", chZ: "az" }],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // node 环境无 localStorage：装一个最小桩（持久化逻辑真实验证）
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
  panelActivity.syncPanels([{ id: "plot3d", visible: true }]);
  store._resetForTest();
  store.setSink(null);
  h.setSeries({});
});

afterEach(() => {
  store.setSink(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("P87a v1→v2 迁移等价", () => {
  it("旧单轨迹设置 → 组1 完整还原；G2/G3 空；视图字段原位保留", () => {
    const v1 = {
      axisX: "ax",
      axisY: "ay",
      axisZ: "az",
      colorBy: "ch" as const,
      colorCh: "mag",
      fade: 300 as const,
      style: "line+points" as const,
      density: "mid" as const,
      autoRotate: true,
      follow: false,
      showGrid: false,
      gridDensity: "fine" as const,
      keyFlight: true,
      zoomToCursor: true,
      pairMode: "nearest" as const,
      pairTolMs: 25,
      axisScale: "perAxis" as const,
    };
    expect(store.importSettingsFromPkg(v1)).toBe(true);
    const s = store.getSnapshot().settings;
    expect(s.groups[0]).toMatchObject({
      chX: "ax",
      chY: "ay",
      chZ: "az",
      colorBy: "ch",
      colorCh: "mag",
      fade: 300,
      density: "mid",
      mode: "line", // style line+points → line + 叠画点
      showDots: true,
      pairMode: "nearest",
      pairTolMs: 25,
    });
    expect(s.groups[1].chX).toBe("");
    expect(s.groups[2].chX).toBe("");
    expect(s).toMatchObject({
      autoRotate: true,
      showGrid: false,
      gridDensity: "fine",
      keyFlight: true,
      zoomToCursor: true,
      axisScale: "perAxis",
      calibMode: false,
    });
  });

  it("style 枚举映射：points→点集；line→不叠画点；缺省→line+叠画", () => {
    store.importSettingsFromPkg({ axisX: "ax", style: "points" });
    expect(store.getGroup("g1")).toMatchObject({ mode: "points" });
    store.importSettingsFromPkg({ axisX: "ax", style: "line" });
    expect(store.getGroup("g1")).toMatchObject({ mode: "line", showDots: false });
    store.importSettingsFromPkg({ axisX: "ax" });
    expect(store.getGroup("g1")).toMatchObject({ mode: "line", showDots: true });
  });

  it("v2 对象非法字段逐项回退默认；groups 缺失视为 v1", () => {
    store.importSettingsFromPkg({
      v: 2,
      groups: [
        { name: "  ", color: "red", pointSize: 999, opacity: 3, smoothWin: 4, mode: "bogus", density: "high" },
      ],
      fade: 7,
    });
    const g = store.getGroup("g1")!;
    expect(g.name).toBe("G1"); // 空白名 → 默认
    expect(g.color).toBe("#4e9cef"); // 非 hex → 默认组色
    expect(g.pointSize).toBe(32); // 越界钳位
    expect(g.opacity).toBe(1);
    expect(g.smoothWin % 2).toBe(1); // 强制奇数窗
    expect(g.mode).toBe("line");
    expect(store.getSnapshot().settings.groups[2].id).toBe("g3"); // 缺补齐
  });
});

describe("P87a 三组独立泵", () => {
  it("两组绑不同通道各自消费；改组2 密度只重灌组2", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az" });
    store.updateGroup("g2", { chX: "ay", chY: "az", chZ: "mag" });
    const calls = collect();
    pump(1);
    const q1 = gseq(calls, "g1");
    const q2 = gseq(calls, "g2");
    expect(q1).toHaveLength(1);
    expect(q1[0].b.x).toEqual([1, 2, 3, 4, 5, 6]);
    expect(q2).toHaveLength(1);
    // 组2 X=ay、Y=az、Z=mag：mag 从 10ms 才有样本 → t=0 锚点头部无数据被跳过（不编造）
    expect(q2[0].b.x).toEqual([12, 13, 14, 15, 16]);
    expect(q2[0].b.t).toEqual([0.01, 0.02, 0.03, 0.04, 0.05]);

    store.updateGroup("g2", { density: "low" });
    pump(1);
    const q1b = gseq(calls, "g1");
    const q2b = gseq(calls, "g2");
    expect(q1b).toHaveLength(1); // 组1 无签名变化且无新数据 → 不再下发
    expect(q2b).toHaveLength(2);
    expect(q2b[1].reloaded).toBe(true);
    expect(q2b[1].b.x).toEqual([12, 16]); // 组2 全量重灌 1:4（5 点 → 序号 0,4）
  });

  it("X/Y 未绑齐 → 不消费；从未消费的组挂载首拍无批次噪声（P87b：Z 可空=平面）", () => {
    h.setSeries(makeSeries());
    const calls = collect();
    pump(2);
    expect(calls).toHaveLength(0); // 三组全空绑定 → 不发空 reloaded 噪声
    store.updateGroup("g1", { chX: "ax" });
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(0); // 缺 Y → 不消费
    store.updateGroup("g1", { chY: "ay" });
    pump(1);
    const q = gseq(calls, "g1");
    expect(q).toHaveLength(1); // P87b：X/Y 绑齐即消费（平面）
    expect(q[0].reloaded).toBe(true);
    expect(q[0].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    expect(q[0].b.z).toEqual([0, 0, 0, 0, 0, 0]);
    store.updateGroup("g1", { chZ: "az" });
    pump(1);
    const q2 = gseq(calls, "g1");
    expect(q2[q2.length - 1].b.z).toEqual([21, 22, 23, 24, 25, 26]); // 补 Z 重灌立体
  });

  it("mode 入签名：切 point 触发重灌；曾有数据的组解绑 → 下发空重灌批次清场景", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(1);
    store.updateGroup("g1", { mode: "point" });
    pump(1);
    const q = gseq(calls, "g1");
    expect(q[1].reloaded).toBe(true); // 模式变化重灌
    store.updateGroup("g1", { chX: "" }); // 解绑 X
    pump(1);
    const q2 = gseq(calls, "g1");
    const last = q2[q2.length - 1];
    expect(last.reloaded).toBe(true);
    expect(last.b.t).toEqual([]); // 空批次通知场景清零
  });

  it("bindGroupFirstFree：按 X→Y→Z 填空槽；三槽已满返回 null 不动绑定", () => {
    expect(store.bindGroupFirstFree("g1", "ax")).toBe("x");
    expect(store.bindGroupFirstFree("g1", "ay")).toBe("y");
    expect(store.bindGroupFirstFree("g1", "az")).toBe("z");
    expect(store.bindGroupFirstFree("g1", "mag")).toBeNull();
    expect(store.getGroup("g1")).toMatchObject({ chX: "ax", chY: "ay", chZ: "az" });
  });
});

describe("P87a 撤销/重做栈", () => {
  it("配置变更一步撤销/重做；绑定/模式/备注均入栈", () => {
    bindG1();
    expect(store.getSnapshot().canUndo).toBe(false); // 栈空起步
    store.updateGroup("g1", { name: "惯导" });
    expect(store.getSnapshot().canUndo).toBe(true);
    expect(store.getSnapshot().settings.groups[0].name).toBe("惯导");
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot().settings.groups[0].name).toBe("G1");
    expect(store.getSnapshot().canRedo).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.getSnapshot().settings.groups[0].name).toBe("惯导");
  });

  it("重复值不压栈；绑定通道撤销还原（重灌由签名驱动）", () => {
    bindG1();
    const canBefore = store.getSnapshot().canUndo;
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az" }); // 与当前完全相同
    expect(store.getSnapshot().canUndo).toBe(canBefore);
    store.updateGroup("g1", { chX: "mag" });
    store.undo();
    expect(store.getGroup("g1")!.chX).toBe("ax");
  });

  it("clearData 不入栈（不可撤销语义）；requestClearData 下一拍驱动场景清组", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    pump(1);
    store.clearData("g1");
    expect(store.getSnapshot().canUndo).toBe(false);
    store.requestClearData("g1");
    pump(1);
    const q = gseq(calls, "g1");
    const last = q[q.length - 1];
    expect(last.reloaded).toBe(true); // 场景清空信号
    expect(last.b).toEqual({ t: [], x: [], y: [], z: [], val: [] });
    // 清空后新数据从零画（水位已推到末端，历史不回放）
    h.setSeries(
      ser(
        [0, 10, 20, 30, 40, 50, 60, 70],
        [1, 2, 3, 4, 5, 6, 7, 8],
        [11, 12, 13, 14, 15, 16, 17, 18],
        [21, 22, 23, 24, 25, 26, 27, 28],
        [null, 100, 101, 102, 103, 104, 105, 106],
      ),
    );
    pump(1);
    const q2 = gseq(calls, "g1");
    expect(q2[q2.length - 1].b.t).toEqual([0.06, 0.07]);
    expect(q2[q2.length - 1].reloaded).toBe(false);
  });

  it("栈上限 50：60 次变更只保最近 50 层", () => {
    for (let i = 0; i < 60; i++) store.updateGroup("g1", { pointSize: (i % 30) + 1 });
    let n = 0;
    while (store.undo()) n++;
    expect(n).toBe(50);
  });

  it("resetSettings 可撤销（误点恢复）；恢复默认后组绑定清空", () => {
    bindG1();
    store.resetSettings();
    expect(store.getGroup("g1")!.chX).toBe("");
    store.undo();
    expect(store.getGroup("g1")!.chX).toBe("ax");
  });
});

describe("plot3dStore 泵（P69/P75 回归组化）", () => {
  it("时间水位续传：源追加只推新增段；源重建不重灌不重复", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(1);

    h.setSeries(
      ser(
        [0, 10, 20, 30, 40, 50, 60, 70],
        [1, 2, 3, 4, 5, 6, 7, 8],
        [11, 12, 13, 14, 15, 16, 17, 18],
        [21, 22, 23, 24, 25, 26, 27, 28],
        [null, 100, 101, 102, 103, 104, 105, 106],
      ),
    );
    pump(1);
    const q = gseq(calls, "g1");
    expect(q).toHaveLength(2);
    expect(q[1].reloaded).toBe(false);
    expect(q[1].b.t).toEqual([0.06, 0.07]);

    h.setSeries(
      ser([70, 80, 90], [8, 9, 10], [18, 19, 20], [28, 29, 30], [106, 107, 108]),
    );
    pump(1);
    const q2 = gseq(calls, "g1");
    expect(q2[2].b.t).toEqual([0.08, 0.09]);
    expect(q2[2].b.x).toEqual([9, 10]);
  });

  it("density 抽稀：mid=1:2 / low=1:4（对消费序号取模）", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", density: "mid" });
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")[0].b.x).toEqual([1, 3, 5]);

    store._resetForTest();
    store.setSink(null);
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", density: "low" });
    const c2 = collect();
    pump(1);
    expect(gseq(c2, "g1")[0].b.x).toEqual([1, 5]);
  });

  it("着色通道：valCarry 前向填充首 null；colorBy=time/fixed 时 val 恒 0", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", colorBy: "ch", colorCh: "mag" });
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")[0].b.val).toEqual([0, 100, 101, 102, 103, 104]);

    store._resetForTest();
    store.setSink(null);
    bindG1(); // colorBy=time
    const c2 = collect();
    pump(1);
    expect(gseq(c2, "g1")[0].b.val).toEqual([0, 0, 0, 0, 0, 0]);

    store._resetForTest();
    store.setSink(null);
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", colorBy: "fixed" });
    const c3 = collect();
    pump(1);
    expect(gseq(c3, "g1")[0].b.val).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("着色通道被删 → 回退按时间着色（逐组自动纠正，不阻塞消费）", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", colorBy: "ch", colorCh: "mag" });
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(1);

    h.chans.splice(3, 1); // 删除 mag 通道
    pump(1);
    const q = gseq(calls, "g1");
    expect(q.length).toBeGreaterThanOrEqual(2);
    expect(q[1].reloaded).toBe(true);
    expect(q[1].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    expect(store.getGroup("g1")!.colorBy).toBe("time");
    h.chans.push({ id: "mag", tplId: "t", fieldId: "f4", name: "磁场", color: "#ffff00", visible: true });
  });

  it("轴绑定通道被删 → 逐组自动解绑并停消费（只影响受影响组）", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.updateGroup("g2", { chX: "mag", chY: "az", chZ: "ax" });
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(1);
    expect(gseq(calls, "g2")).toHaveLength(1);

    h.chans.splice(0, 1); // 删除 ax（两组都引用）
    pump(1);
    expect(store.getGroup("g1")!.chX).toBe("");
    expect(store.getGroup("g2")!.chZ).toBe("");
    expect(store.getGroup("g2")!.chX).toBe("mag"); // 其余绑定不动
    h.chans.unshift({ id: "ax", tplId: "t", fieldId: "f1", name: "加计X", color: "#ff0000", visible: true });
  });

  it("面板关闭（panelActivity 不含 plot3d）→ 泵空转不喂数", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    panelActivity.syncPanels([]);
    pump(2);
    expect(calls).toHaveLength(0);
    panelActivity.syncPanels([{ id: "plot3d", visible: true }]);
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(1);
  });

  it("设置持久化：updateGroup 写 v3 localStorage；绑定/模式/渐隐落盘", () => {
    store.updateGroup("g1", { chX: "ax", fade: 300, mode: "points" });
    const raw = localStorage.getItem("vs.plot3d.settings");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { v: number; groups: { id: string; chX: string; fade: number; mode: string }[] };
    expect(parsed.v).toBe(3);
    expect(parsed.groups[0]).toMatchObject({ id: "g1", chX: "ax", fade: 300, mode: "points" });
  });

  it("组可见性 = 视图类：落盘、不过锁、不压撤销栈", () => {
    bindG1();
    store.setGroupVisible("g1", false);
    expect(store.getGroup("g1")!.visible).toBe(false);
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(JSON.parse(localStorage.getItem("vs.plot3d.settings")!).groups[0]).toMatchObject({
      visible: false,
    });
    setOperatorLocked(true);
    store.setGroupVisible("g1", true); // 锁定仍放行
    setOperatorLocked(false);
    expect(store.getGroup("g1")!.visible).toBe(true);
  });
});

describe("P74c C1：Operator 只读边界（P87a 组化）", () => {
  afterEach(() => setOperatorLocked(false));

  it("锁定时：组配置/全局配置写入全拒（含默认值恢复与包导入）", () => {
    setOperatorLocked(true);
    store.bindGroup("g1", "x", "ax");
    store.updateGroup("g1", { colorBy: "ch", colorCh: "mag" });
    store.updateGroup("g2", { mode: "point", density: "low" });
    store.setSetting({ showGrid: false, gridDensity: "coarse" });
    store.setSetting({ keyFlight: true, zoomToCursor: true, axisScale: "perAxis" });
    const s = store.getSnapshot().settings;
    expect(store.getGroup("g1")!.chX).toBe("");
    expect(store.getGroup("g2")!.mode).toBe("line");
    expect(s.showGrid).toBe(true);
    expect(s.gridDensity).toBe("std");
    expect(s.keyFlight).toBe(false);
    expect(s.axisScale).toBe("uniform");
    expect(store.importSettingsFromPkg({ axisX: "ax", style: "points" })).toBe(false);
    store.resetSettings();
    expect(store.getGroup("g1")!.chX).toBe("");
    expect(s.groups[0].notes).toBe("");
  });

  it("锁定时：视图/操作态放行（跟随 / 自动旋转 / 校准）+ 互斥联动仍生效", () => {
    setOperatorLocked(true);
    store.setSetting({ follow: true });
    expect(store.getSnapshot().settings.follow).toBe(true);
    expect(store.getSnapshot().settings.autoRotate).toBe(false);
    store.setSetting({ autoRotate: true }); // 反向互斥
    expect(store.getSnapshot().settings.autoRotate).toBe(true);
    expect(store.getSnapshot().settings.follow).toBe(false);
    store.setSetting({ calibMode: true }); // 进校准：锁定视角并关掉两个视图开关
    expect(store.getSnapshot().settings.calibMode).toBe(true);
    expect(store.getSnapshot().settings.autoRotate).toBe(false);
  });

  it("锁定前后的持久化口径一致：视图态照常落盘、混合补丁整包拒绝", () => {
    setOperatorLocked(true);
    store.setSetting({ follow: true, showGrid: false }); // 混合补丁
    expect(store.getSnapshot().settings).toMatchObject({ follow: false, showGrid: true });
    expect(localStorage.getItem("vs.plot3d.settings")).toBeNull();

    store.setSetting({ follow: true }); // 纯视图态 → 放行并落盘
    const saved = JSON.parse(localStorage.getItem("vs.plot3d.settings")!);
    expect(saved).toMatchObject({ follow: true });
    expect(saved.groups[0]).toMatchObject({ chX: "" });
  });
});

/** P70 游标批次收集器（游标随每次下发记录） */
function collectCur(): Call[] {
  return collect();
}

describe("plot3dStore 时间游标（P70，全局共享一条时间轴）", () => {
  it("回放态：泵下发 cursor=回放相对秒（clamp 到源范围·跨组）", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collectCur();
    store._setSessionForTest(() => ({ playing: true, replayTsMs: 25 }));
    pump(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].cursor).toBeCloseTo(0.025);
    store._setSessionForTest(() => ({ playing: true, replayTsMs: 9999 }));
    pump(1);
    expect(calls[1].cursor).toBeCloseTo(0.05);
  });

  it("seek 向后：空批次仍下发、cursor 回退、不重灌不重复", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collectCur();
    let ts = 45;
    store._setSessionForTest(() => ({ playing: true, replayTsMs: ts }));
    pump(1);
    expect(gseq(calls, "g1")[0].reloaded).toBe(true);
    expect(gseq(calls, "g1")[0].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    expect(calls[0].cursor).toBeCloseTo(0.045);

    ts = 15;
    pump(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].entries).toHaveLength(0);
    expect(calls[1].cursor).toBeCloseTo(0.015);

    pump(1); // 游标未变 + 无新数据 → 不重复下发
    expect(calls).toHaveLength(2);
  });

  it("seek 向前越段：水位跳过重复重灌段、只推新增", () => {
    h.setSeries(ser([0, 10, 20], [1, 2, 3], [11, 12, 13], [21, 22, 23], [null, 100, 101]));
    bindG1();
    const calls = collectCur();
    let ts = 20;
    store._setSessionForTest(() => ({ playing: true, replayTsMs: ts }));
    pump(1);
    expect(gseq(calls, "g1")[0].b.t).toEqual([0, 0.01, 0.02]);
    expect(calls[0].cursor).toBeCloseTo(0.02);

    h.setSeries(makeSeries());
    ts = 50;
    pump(1);
    expect(gseq(calls, "g1")[1].b.t).toEqual([0.03, 0.04, 0.05]);
    expect(calls[1].cursor).toBeCloseTo(0.05);
  });

  it("回放结束：cursor=null 恢复跟随最新", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collectCur();
    const probe = { playing: true, replayTsMs: 30 };
    store._setSessionForTest(() => probe);
    pump(1);
    expect(calls[0].cursor).toBeCloseTo(0.03);

    probe.playing = false;
    pump(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].entries).toHaveLength(0);
    expect(calls[1].cursor).toBeNull();
  });

  it("scrub 态：cursor=scrub 值（clamp）；setScrub(null) 恢复；回放优先于 scrub；跨组源末端合并", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.updateGroup("g2", { chX: "ay", chY: "az", chZ: "mag" }); // g2 数据延伸到相同 50ms
    const calls = collectCur();
    store._setSessionForTest(null);
    pump(1);
    expect(calls[0].cursor).toBeNull();

    store.setScrub(0.032);
    pump(1);
    expect(calls[1].cursor).toBeCloseTo(0.032);

    store.setScrub(999);
    pump(1);
    expect(calls[2].cursor).toBeCloseTo(0.05);

    store.setScrub(null);
    pump(1);
    expect(calls[3].cursor).toBeNull();

    const probe2 = { playing: true, replayTsMs: 40 };
    store._setSessionForTest(() => probe2);
    store.setScrub(0.01);
    pump(1);
    expect(calls[4].cursor).toBeCloseTo(0.01); // 显式 scrub 保持优先于回放时钟
  });

  it("P91 C2：外部来源游标越界即忽略并保持跟随最新；3D 内 local 拖拽仍按 clamp 尊重", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collectCur();
    store._setSessionForTest(null);
    pump(1);
    expect(calls[0].cursor).toBeNull();

    // 范围内的外部游标照常生效（联动是用户开着的特性，不能一刀切）
    store.setScrub(0.03, "session");
    expect(store.scrubSource()).toBe("session");
    pump(1);
    expect(calls[1].cursor).toBeCloseTo(0.03);

    // 联动来的越界游标：忽略并回到跟随最新（旧实现钳到起点 = 每 120ms 重下一次"画 0 点"）
    store.setScrub(999, "linked");
    pump(1);
    expect(calls[2].cursor).toBeNull();
    expect(store.scrubSource()).toBe("local"); // 放弃后复位来源，不残留外部接管态

    // 用户在 3D 时间条上拖出界 → 钳到末端；这是明确意图，不擅自回到最新
    store.setScrub(999, "local");
    pump(1);
    expect(calls[3].cursor).toBeCloseTo(0.05);
  });

  it("lowerBoundLe：空/首/尾/重复 ts 边界（= drawRange 截断数）", () => {
    const arr = new Float64Array([1, 2, 2, 3, 5]);
    expect(lowerBoundLe(arr, 0, 10)).toBe(0);
    expect(lowerBoundLe(arr, arr.length, 0)).toBe(0);
    expect(lowerBoundLe(arr, arr.length, 1)).toBe(1);
    expect(lowerBoundLe(arr, arr.length, 2)).toBe(3);
    expect(lowerBoundLe(arr, arr.length, 4)).toBe(4);
    expect(lowerBoundLe(arr, arr.length, 5)).toBe(5);
    expect(lowerBoundLe(arr, arr.length, 99)).toBe(5);
    expect(lowerBoundLe(arr, 3, 99)).toBe(3);
  });
});

describe("plot3dStore 椭球校准采样（P71 → P87a：采样源=组1）", () => {
  it("calibMode + 采样中：组1 泵 stride=1 追加原始点；组2 数据不进校准缓冲", () => {
    h.setSeries(
      ser(
        [0, 10, 20, 30],
        [1, 2, null, 4],
        [11, 12, 13, 14],
        [21, 22, 23, 24],
        [null, 100, 101, 102],
      ),
    );
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", density: "low" });
    store.updateGroup("g2", { chX: "az", chY: "ay", chZ: "ax" }); // 干扰组
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    store.startCalibCapture();
    pump(1);
    const pts = store.calibPoints();
    expect(pts.x).toEqual([1, 2, 4]); // 组1 源；null 轴跳过；密度不影响校准采样
    expect(pts.y).toEqual([11, 12, 14]);
    expect(store.calibSnapshot()).toMatchObject({ capturing: true, count: 3 });
    expect(store.calibSnapshot().coverage).toBeGreaterThan(0);
  });

  it("未开采样 → 不追加；开启后只采水位新增", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    pump(1);
    expect(store.calibPoints().x).toHaveLength(0);
    store.startCalibCapture();
    h.setSeries(
      ser(
        [0, 10, 20, 30, 40, 50, 60, 70],
        [1, 2, 3, 4, 5, 6, 7, 8],
        [11, 12, 13, 14, 15, 16, 17, 18],
        [21, 22, 23, 24, 25, 26, 27, 28],
        [null, 100, 101, 102, 103, 104, 105, 106],
      ),
    );
    pump(1);
    expect(store.calibPoints().x).toEqual([7, 8]);
  });

  it("组1 重灌（换绑定）清空校准缓冲；组2 变化不波及校准；setSink(null) 清空", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    store.startCalibCapture();
    pump(1);
    expect(store.calibPoints().x).toHaveLength(6);
    store.updateGroup("g2", { chX: "ax", chY: "ay", chZ: "az" }); // 只动组2
    pump(1);
    expect(store.calibPoints().x).toHaveLength(6);
    store.updateGroup("g1", { chX: "az", chY: "ay", chZ: "ax" }); // 组1 换绑 → 清
    pump(1);
    expect(store.calibPoints().x).toHaveLength(0);
    store.startCalibCapture();
    h.setSeries(ser([60, 70, 80, 90], [1, 2, 3, 4], [11, 12, 13, 14], [21, 22, 23, 24], [null, 100, 101, 102]));
    pump(1);
    expect(store.calibPoints().x.length).toBeGreaterThan(0);
    store.setSink(null);
    expect(store.calibPoints().x).toHaveLength(0);
    expect(store.calibSnapshot().capturing).toBe(false);
  });

  it("包导入导出：export 剥离 calibMode（含组数据深拷贝隔离）；import 归一化非法字段", () => {
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", fade: 10 });
    store.setSetting({ calibMode: true });
    const exported = store.exportSettingsForPkg();
    expect(exported.calibMode).toBe(false);
    expect(exported.groups[0].chX).toBe("ax");
    expect(exported.groups[0].fade).toBe(10);
    exported.groups[0].name = "改过了"; // 深拷贝：改导出不影响内存态
    expect(store.getGroup("g1")!.name).toBe("G1");
    // 导入：非法字段回退默认（归一化）
    expect(store.importSettingsFromPkg({ axisX: "p", fade: 999, style: "bogus" })).toBe(true);
    const g = store.getGroup("g1")!;
    expect(g.chX).toBe("p");
    expect(g.fade).toBe(60);
    expect(g.mode).toBe("line");
    expect(g.colorBy).toBe("time");
    expect(store.getSnapshot().settings.calibMode).toBe(false);
    expect(store.importSettingsFromPkg(null)).toBe(false);
    expect(store.importSettingsFromPkg("x")).toBe(false);
  });

  it("P74c B4：calibMode 是会话级操作态——包导入不恢复、endCalibSession 关闭即退出", () => {
    bindG1();
    store.setSetting({ calibMode: true });
    expect(store.getSnapshot().settings.calibMode).toBe(true);
    expect(store.importSettingsFromPkg(store.getSnapshot().settings)).toBe(true);
    expect(store.getSnapshot().settings.calibMode).toBe(false);
    store.setSetting({ calibMode: true });
    store.resetSettings();
    expect(store.getSnapshot().settings.calibMode).toBe(false);
    store.setSetting({ calibMode: true });
    store.endCalibSession();
    expect(store.getSnapshot().settings.calibMode).toBe(false);
    store.endCalibSession();
    expect(store.getSnapshot().settings.calibMode).toBe(false);
  });

  it("P74c A5：invalidateCursor 强制下一拍重发游标（场景重建后游标不消失）", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collectCur();
    store.setScrub(0.03);
    pump(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].cursor).toBeCloseTo(0.03);

    const n = calls.length;
    pump(1);
    expect(calls.length).toBe(n);

    store.invalidateCursor();
    pump(1);
    expect(calls.length).toBe(n + 1);
    expect(calls[calls.length - 1].cursor).toBeCloseTo(0.03);
  });
});

/** 合成 FitOk：恒等 W、offset=0、meanR=100（r=|x| 便于断言） */
function makeFit(): FitOk {
  return {
    ok: true,
    offset: [0, 0, 0],
    gains: [1, 1, 1],
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    axes: [100, 100, 100],
    rot: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    cv: 0.01,
    rms: 0.01,
    meanR: 100,
    n: 600,
  };
}

describe("plot3dStore 在线补偿预览（P73）", () => {
  it("有 fit 即缓冲（无需采样中）：r=‖W(x−offset)‖、meanR 透传；无 fit 不缓冲", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    pump(1);
    expect(store.previewSnapshot()).toBeNull();
    store.setCalibFit(makeFit());
    h.setSeries(
      ser(
        [0, 10, 20, 30, 40, 50, 60, 70],
        [1, 2, 3, 4, 5, 6, 7, 8],
        [11, 12, 13, 14, 15, 16, 17, 18],
        [21, 22, 23, 24, 25, 26, 27, 28],
        [null, 100, 101, 102, 103, 104, 105, 106],
      ),
    );
    pump(1);
    const pv = store.previewSnapshot();
    if (!pv) throw new Error("previewSnapshot 应非 null");
    expect(pv.len).toBe(2);
    expect(pv.head).toBe(2);
    expect(pv.meanR).toBe(100);
    expect(pv.r[0]).toBeCloseTo(Math.hypot(7, 17, 27));
    expect(pv.t[0]).toBeCloseTo(0.06);
    expect(pv.t[1]).toBeCloseTo(0.07);
  });

  it("setCalibFit 重置缓冲；clearCalib 清 fit；组1 重灌清 fit+六面", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    store.setCalibFit(makeFit());
    store.updateGroup("g1", { chX: "az", chY: "ay", chZ: "ax" }); // 换绑定 → 重灌
    pump(1);
    expect(store.getCalibFit()).toBeNull();
    expect(store.previewSnapshot()).toBeNull();
    store.setCalibFit(makeFit());
    store.clearCalib();
    expect(store.getCalibFit()).toBeNull();
    expect(store.previewSnapshot()).toBeNull();
  });
});

describe("plot3dStore 加计六面（P73）", () => {
  let base = 0;
  function capFace(idx: number, v: [number, number, number], n = 2100) {
    const ts = Array.from({ length: n }, (_, i) => base + i);
    h.setSeries({
      ax: { t: ts, v: Array(n).fill(v[0]) },
      ay: { t: ts, v: Array(n).fill(v[1]) },
      az: { t: ts, v: Array(n).fill(v[2]) },
      mag: { t: ts, v: Array(n).fill(0) },
    });
    store.accel6StartFace(idx);
    pump(1);
    base += n;
  }

  beforeEach(() => {
    base = 0;
  });

  it("2s 窗自动结算：mean/std 正确、collecting 复位、窗锚定源时间（不依赖系统时钟）", () => {
    bindG1();
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    capFace(0, [100, 0, 0]);
    const snap = store.accel6Snapshot();
    expect(snap.collecting).toBe(false);
    expect(snap.idx).toBe(-1);
    const f = snap.faces[0];
    if (!f) throw new Error("face 0 应已结算");
    expect(f.n).toBe(2001);
    expect(f.mean[0]).toBeCloseTo(100);
    expect(f.mean[1]).toBeCloseTo(0);
    expect(f.std[0]).toBeCloseTo(0);
  });

  it("互斥：六面采集停椭球采样；椭球采样停六面", () => {
    bindG1();
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    store.startCalibCapture();
    expect(store.calibSnapshot().capturing).toBe(true);
    store.accel6StartFace(2);
    expect(store.calibSnapshot().capturing).toBe(false);
    expect(store.accel6Snapshot().collecting).toBe(true);
    store.startCalibCapture();
    expect(store.accel6Snapshot().collecting).toBe(false);
    expect(store.calibSnapshot().capturing).toBe(true);
  });

  it("六面齐 → accel6Solve 解算 offset/scale（合成真值回收）；缺面拒绝", () => {
    bindG1();
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    capFace(0, [110, -20, 5]);
    capFace(1, [-90, -20, 5]);
    capFace(2, [10, 82, 5]);
    capFace(3, [10, -122, 5]);
    capFace(4, [10, -20, 103]);
    const miss = store.accel6Solve();
    expect(miss.ok).toBe(false);
    capFace(5, [10, -20, -93]);
    const r = store.accel6Solve();
    if (!r.ok) throw new Error(`解算失败: ${r.reason}`);
    expect(r.offset[0]).toBeCloseTo(10, 4);
    expect(r.offset[1]).toBeCloseTo(-20, 4);
    expect(r.offset[2]).toBeCloseTo(5, 4);
    expect(r.scales[0]).toBeCloseTo(100, 4);
    expect(r.scales[1]).toBeCloseTo(102, 4);
    expect(r.scales[2]).toBeCloseTo(98, 4);
    expect(r.grade).toBe("优");
  });
});

describe("plot3dStore 三轴时间戳配对（P75 B2，P87a 逐组统计）", () => {
  it("回归：同帧三轴（相同时间戳）→ 每帧恰 1 点；pairSnapshot 逐组", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")[0].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    expect(gseq(calls, "g1")[0].b.x).toEqual([1, 2, 3, 4, 5, 6]);
    const ps = store.pairSnapshot("g1");
    expect(ps.paired).toBe(6);
    expect(ps.skipped).toBe(0);
    expect(ps.min).toEqual([1, 11, 21]);
    expect(ps.max).toEqual([6, 16, 26]);
    expect(ps.tolMs).toBeGreaterThan(0);
    expect(store.pairSnapshot("g2").paired).toBe(0); // 未绑组统计独立
  });

  it("Y 半频：插值模式平滑（中间锚点线性、尾沿保持）", () => {
    h.setSeries({
      ax: { t: [0, 10, 20, 30], v: [0, 1, 2, 3] },
      ay: { t: [0, 20], v: [0, 2] },
      az: { t: [0, 10, 20, 30], v: [0, 1, 2, 3] },
    });
    bindG1();
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")[0].b.y).toEqual([0, 1, 2, 2]);
    expect(gseq(calls, "g1")[0].b.x).toEqual([0, 1, 2, 3]);
    expect(store.pairSnapshot("g1").skipped).toBe(0);
  });

  it("nearest + 手动小容差：稀疏 Y 容差外全部跳过并计入统计", () => {
    h.setSeries({
      ax: { t: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], v: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
      ay: { t: [0, 100], v: [0, 1] },
      az: { t: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], v: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    });
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", pairMode: "nearest", pairTolMs: 5 });
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")[0].b.t).toEqual([0]);
    const ps = store.pairSnapshot("g1");
    expect(ps.paired).toBe(1);
    expect(ps.skipped).toBe(9);
    expect(ps.tolMs).toBe(5);
  });

  it("union 模式 = 旧版联合前向填充逃生舱（阶梯口径回归）", () => {
    h.setSeries({
      ax: { t: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], v: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
      ay: { t: [0, 100], v: [0, 1] },
      az: { t: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], v: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    });
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", pairMode: "union" });
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")[0].b.t).toHaveLength(11);
    expect(gseq(calls, "g1")[0].b.y).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(store.pairSnapshot("g1").tolMs).toBe(0);
  });

  it("配对方式/容差变更 → 该组签名变化 → 全量重灌", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(1);
    store.updateGroup("g1", { pairTolMs: 25 });
    pump(1);
    const q = gseq(calls, "g1");
    expect(q.length).toBeGreaterThanOrEqual(2);
    expect(q[q.length - 1].reloaded).toBe(true);
    expect(q[q.length - 1].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
  });
});

describe("P87b 组变换 / 平面轨迹 / 朝向采样 / 导出同源", () => {
  it("平面轨迹：只绑 X/Y（Z 空）→ z 恒 0 照常消费", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g1", { chX: "ax", chY: "ay" }); // 不绑 Z
    const calls = collect();
    pump(1);
    const q = gseq(calls, "g1");
    expect(q).toHaveLength(1);
    expect(q[0].b.x).toEqual([1, 2, 3, 4, 5, 6]);
    expect(q[0].b.y).toEqual([11, 12, 13, 14, 15, 16]);
    expect(q[0].b.z).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("组变换泵内应用：旋转 90°Z + scale2 + 平移（显示与统计同源）", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g1", {
      chX: "ax", chY: "ay", chZ: "az",
      transform: { rotX: 0, rotY: 0, rotZ: 90, offX: 10, offY: 0, offZ: 0, scale: 2 },
    });
    const calls = collect();
    pump(1);
    const b = gseq(calls, "g1")[0].b;
    // (x,y)→Rz90·2·(x,y)+off → x' = -2y+10, y' = 2x
    expect(b.x[0]).toBeCloseTo(10 - 2 * 11, 9);
    expect(b.y[0]).toBeCloseTo(2 * 1, 9);
    expect(b.z[0]).toBeCloseTo(2 * 21, 9);
  });

  it("变换入组签名：改变换只重灌该组；exportTriples 与泵输出逐点同值（显示=导出）", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g1")).toHaveLength(1);
    store.updateGroup("g1", { transform: { rotX: 0, rotY: 0, rotZ: 0, offX: 1, offY: 2, offZ: 3, scale: 1 } });
    pump(1);
    const q = gseq(calls, "g1");
    expect(q[q.length - 1].reloaded).toBe(true);
    const exp = store.exportTriples("g1")!;
    expect(exp.t.length).toBe(q[q.length - 1].b.t.length);
    for (let i = 0; i < exp.t.length; i++) {
      // 泵与导出同一变换 → 逐点同值（显示=导出）
      expect(exp.x[i]).toBeCloseTo(q[q.length - 1].b.x[i], 6);
      expect(exp.y[i]).toBeCloseTo(q[q.length - 1].b.y[i], 6);
    }
  });

  it("校准缓冲旁路组变换（恒原始传感器值）", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", transform: { rotX: 0, rotY: 0, rotZ: 0, offX: 100, offY: 0, offZ: 0, scale: 1 } });
    store.setSetting({ calibMode: true });
    store.setSink(vi.fn());
    store.startCalibCapture();
    pump(1);
    expect(store.calibPoints().x[0]).toBe(1); // +100 平移不进校准云
  });

  it("point 模式 latest 携带 hd（航向角通道，含容差外回退）与 pv", () => {
    h.setSeries({
      ax: { t: [0, 10, 20], v: [1, 2, 3] },
      ay: { t: [0, 10, 20], v: [4, 5, 6] },
      az: { t: [0, 10, 20], v: [7, 8, 9] },
      mag: { t: [0, 10, 20], v: [90, 180, 270] },
    });
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", mode: "point", heading: { src: "ch", chYaw: "mag", qX: "", qY: "", qZ: "", qW: "", yawOff: 0, pitchOff: 0, rollOff: 0, yawSign: 1 } });
    const calls: { e: store.GroupBatch[]; cursor: number | null }[] = [];
    store.setSink((entries, cursor) => calls.push({ e: entries, cursor }));
    pump(1);
    const b = calls[0].e.find((x) => x.gid === "g1")!.b;
    expect(b.latest?.hd).toBe(270);
    expect(b.latest?.x).toBe(3);
    expect(b.latest?.pv).toEqual([2, 5, 8]);
    expect(b.t).toEqual([0, 0.01, 0.02]);
  });

  it("quat 源四通道采样；缺任一通道 → 无 q（不编造）", () => {
    h.setSeries({
      ax: { t: [0, 10], v: [1, 2] },
      ay: { t: [0, 10], v: [3, 4] },
      az: { t: [0, 10], v: [5, 6] },
      mag: { t: [0, 10], v: [0, 0.1] },
    });
    store.updateGroup("g1", { chX: "ax", chY: "ay", chZ: "az", mode: "point", heading: { src: "quat", chYaw: "", qX: "ax", qY: "ay", qZ: "az", qW: "mag", yawOff: 0, pitchOff: 0, rollOff: 0, yawSign: 1 } });
    const calls: { e: store.GroupBatch[]; cursor: number | null }[] = [];
    store.setSink((entries, cursor) => calls.push({ e: entries, cursor }));
    pump(1);
    const b = calls[0].e.find((x) => x.gid === "g1")!.b;
    expect(b.latest?.q).toEqual([2, 4, 6, 0.1]);
  });

  it("alignToOrigin：各绑齐组首点平移落原点；一步撤销还原", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.updateGroup("g2", { chX: "ay", chY: "az" });
    expect(store.alignToOrigin()).toBe(true);
    const g1 = store.getGroup("g1")!;
    const g2 = store.getGroup("g2")!;
    expect(g1.transform.offX).toBeCloseTo(-1, 9);
    expect(g1.transform.offY).toBeCloseTo(-11, 9);
    expect(g1.transform.offZ).toBeCloseTo(-21, 9);
    expect(g2.transform.offX).toBeCloseTo(-11, 9);
    expect(store.getSnapshot().canUndo).toBe(true);
    store.undo();
    expect(store.getGroup("g1")!.transform.offX).toBe(0);
  });

  it("heading/model/transform 非法值归一化（updateGroup 深清洗）", () => {
    store.updateGroup(
      "g1",
      {
        heading: { src: "bogus", yawSign: 3 },
        model: { kind: "wat", scale: 1e12 },
        transform: { rotZ: 45, scale: -1 },
      } as unknown as Parameters<typeof store.updateGroup>[1],
    );
    const g = store.getGroup("g1")!;
    expect(g.heading.src).toBe("xAxis");
    expect(g.heading.yawSign).toBe(1);
    expect(g.model.kind).toBe("point");
    expect(g.model.scale).toBe(100);
    expect(g.transform.rotZ).toBe(45);
    expect(g.transform.scale).toBe(1e-6); // 负→钳下限
  });
});

describe("P87e 弹性组数", () => {
  it("v3 数字开头 UUID 第四组往返保持身份和绑定，非法 ID 不降级", () => {
    const id = "12345678-1234-4234-8234-123456789abc";
    const groups = [...store.getSnapshot().settings.groups, { id, chX: "ax", chY: "ay" }];
    expect(store.importSettingsFromPkg({ v: 3, groups, calibSrc: null })).toBe(true);
    const saved = JSON.parse(localStorage.getItem("vs.plot3d.settings")!);
    expect(saved.groups).toHaveLength(4);
    expect(store.importSettingsFromPkg(saved)).toBe(true);
    expect(store.getGroup(id)).toMatchObject({ id, chX: "ax", chY: "ay" });
    const before = store.getSnapshot();
    for (const invalid of [[{ id: "bad id" }], [{ id }, { id }], [{}]]) {
      expect(() => store.importSettingsFromPkg({ v: 3, groups: invalid })).toThrow();
      expect(store.getSnapshot()).toBe(before);
    }
  });

  it("v3 校准源显式 null 保持未选择，不回退 g1", () => {
    store.importSettingsFromPkg({ v: 3, groups: [{ id: "g1" }], calibSrc: null });
    expect(store.getSnapshot().settings.calibSrc).toBeNull();
  });

  it("v3 校准源 g1 不在组列表中时清除悬空引用", () => {
    store.importSettingsFromPkg({ v: 3, groups: [{ id: "g2" }], calibSrc: "g1" });
    expect(store.getSnapshot().settings.calibSrc).toBeNull();
  });

  it("删除 g2 后新增：恰好三组、新组 ID 不復用旧 g2、两步撤销完整还原", () => {
    store.updateGroup("g2", { chX: "ax", chY: "ay" }); // 让 g2 有可辨识状态
    expect(store.getSnapshot().settings.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);

    expect(store.removeGroup("g2")).toBe(true);
    expect(store.getSnapshot().settings.groups.map((g) => g.id)).toEqual(["g1", "g3"]); // 无幻影组

    const added = store.addGroup();
    expect(added).toBeTruthy();
    expect(store.getSnapshot().settings.groups.map((g) => g.id)).toEqual(["g1", "g3", added]);
    expect(added).not.toBe("g2"); // 新组不复用已删除 ID（防旧引用指错组）

    store.undo(); // 撤销「新增」→ 回到删除后
    expect(store.getSnapshot().settings.groups.map((g) => g.id)).toEqual(["g1", "g3"]);
    store.undo(); // 撤销「删除」→ 三组原样（g2 原 ID 恢复）
    expect(store.getSnapshot().settings.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(store.getGroup("g2")?.chX).toBe("ax");
  });

  it("删除组的泵状态与统计一并移除；新增组独立消费不继承水位（无幻影批次）", () => {
    h.setSeries(makeSeries());
    store.updateGroup("g2", { chX: "ax", chY: "ay", chZ: "az" });
    const calls = collect();
    pump(1);
    expect(gseq(calls, "g2")).toHaveLength(1);
    expect(store.removeGroup("g2")).toBe(true);
    pump(1); // 删除后泵不再为 g2 产批次
    const nBefore = gseq(calls, "g2").length;

    const added = store.addGroup();
    store.updateGroup(added, { chX: "ay", chY: "az" });
    pump(1);
    // 新组从头消费（ay 全 6 点），不继承 g2 的水位/统计
    const q = gseq(calls, added);
    expect(q).toHaveLength(1);
    expect(q[0].b.x).toEqual([11, 12, 13, 14, 15, 16]);
    expect(gseq(calls, "g2").length).toBe(nBefore); // 无幻影组批次
  });
});


describe("P87e lifecycle closure", () => {
  afterEach(() => setOperatorLocked(false));

  it.each([0, 32])("v3 explicit %i groups survives disk reload", async (count) => {
    store.importSettingsFromPkg({ v: 3, groups: Array.from({ length: count }, (_, i) => ({ id: `9-group-${i}`, chX: "ax", chY: "ay" })), calibSrc: null });
    const saved = localStorage.getItem("vs.plot3d.settings");
    vi.resetModules();
    const reloaded = await import("./plot3dStore");
    expect(reloaded.getSnapshot().settings.groups).toHaveLength(count);
    expect(reloaded.getSnapshot().settings.calibSrc).toBeNull();
    expect(reloaded.getSnapshot().settings.groups.map((g) => g.id)).toEqual(store.getSnapshot().settings.groups.map((g) => g.id));
    expect(localStorage.getItem("vs.plot3d.settings")).toBe(saved);
  });

  it("backs up exact legacy disk payload before load migration and later persist", async () => {
    const old = '{"v":2,"groups":[{"chX":"ax"}]}';
    localStorage.setItem("vs.plot3d.settings", old);
    vi.resetModules();
    const reloaded = await import("./plot3dStore");
    expect(localStorage.getItem("vs.plot3d.settings.pre-v3")).toBe(old);
    reloaded.updateGroup("g1", { name: "migrated" });
    expect(JSON.parse(localStorage.getItem("vs.plot3d.settings")!).v).toBe(3);
    expect(localStorage.getItem("vs.plot3d.settings.pre-v3")).toBe(old);
  });

  it("fresh sink reconstructs static retained history without calibration duplication", () => {
    h.setSeries(makeSeries());
    bindG1();
    store.setSetting({ calibMode: true });
    collect();
    store.startCalibCapture();
    pump();
    store.setCalibFit(makeFit());
    const pts = [...store.calibPoints().x];
    store.setSink(null, { keepCalib: true });
    const next = collect();
    store.setScrub(0.03);
    pump();
    const q = gseq(next, "g1");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ reloaded: true, b: { x: [1, 2, 3, 4, 5, 6] } });
    expect(next[0].cursor).toBeCloseTo(0.03);
    expect(store.calibPoints().x).toEqual(pts);
    expect(store.calibSnapshot().capturing).toBe(true);
    expect(store.getCalibFit()).not.toBeNull();
    expect(store.previewSnapshot()!.len).toBe(0);
    expect(store.pairSnapshot("g1").paired).toBe(6);
    store.updateGroup("g1", { density: "low", smooth: "movingAvg" });
    pump();
    expect(store.calibPoints().x).toEqual(pts);
    expect(store.getCalibFit()).not.toBeNull();
  });

  it("clear before/after first pump then rebuild never resurrects history", () => {
    for (const first of [false, true]) {
      store._resetForTest();
      h.setSeries(makeSeries());
      bindG1();
      collect();
      if (first) pump();
      store.requestClearData("g1");
      const rebuilt = collect();
      pump();
      expect(gseq(rebuilt, "g1")[0].b.t).toEqual([]);
      h.setSeries(ser([60, 70], [7, 8], [17, 18], [27, 28]));
      pump();
      const q = gseq(rebuilt, "g1");
      expect(q[q.length - 1].b.x).toEqual([7, 8]);
      store.updateGroup("g1", { smooth: "spline" });
      const rebuiltAgain = collect();
      pump();
      expect(gseq(rebuiltAgain, "g1")[0].b.x).toEqual([7, 8]);
    }
  });

  it("source change undo/redo/reset/import clears temporary calibration immediately, never restores old captures", () => {
    bindG1();
    h.setSeries(makeSeries());
    store.setSetting({ calibMode: true });
    collect();
    store.startCalibCapture();
    pump();
    store.setCalibFit(makeFit());
    store.setSetting({ calibSrc: "g2", axisScale: "perAxis" });
    expect(store.calibSnapshot()).toMatchObject({ count: 0, capturing: false });
    expect(store.getCalibFit()).toBeNull();
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot().settings).toMatchObject({ calibSrc: "g1", axisScale: "uniform" });
    expect(store.calibSnapshot()).toMatchObject({ count: 0, capturing: false });
    store.accel6StartFace(0);
    expect(store.redo()).toBe(true);
    expect(store.accel6Snapshot()).toMatchObject({ collecting: false, n: 0 });
    store.undo();
    store.setCalibFit(makeFit());
    store.resetSettings();
    expect(store.getCalibFit()).toBeNull();
    store.undo();
    store.setCalibFit(makeFit());
    store.importSettingsFromPkg(store.exportSettingsForPkg());
    expect(store.getCalibFit()).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("membership reconciliation removes stats and pending clears through delete, undo, redo, and import", () => {
    h.setSeries(makeSeries());
    bindG1();
    const calls = collect();
    pump();
    store.requestClearData("g1");
    store.removeGroup("g1");
    expect(store.pairSnapshot("g1").paired).toBe(0);
    store.undo();
    pump();
    const q1 = gseq(calls, "g1");
    expect(q1[q1.length - 1]!.b.x).toHaveLength(6);
    store.redo();
    expect(store.pairSnapshot("g1").paired).toBe(0);
    store.undo();
    store.requestClearData("g1");
    store.importSettingsFromPkg({ v: 3, groups: [] });
    expect(store.pairSnapshot("g1").paired).toBe(0);
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
    pump();
    expect(store.getSnapshot().settings.groups).toEqual([]);
  });

  it("unknown operations are inert and Operator locks cover lifecycle and history", () => {
    const before = store.getSnapshot();
    const disk = localStorage.getItem("vs.plot3d.settings");
    expect(store.getGroup("missing")).toBeUndefined();
    expect(store.exportTriples("missing")).toBeNull();
    expect(store.bindGroupFirstFree("missing", "ax")).toBeNull();
    store.bindGroup("missing", "x", "ax");
    store.setGroupVisible("missing", false);
    store.clearData("");
    store.requestClearData("missing");
    store.setSetting({ calibSrc: "missing", axisScale: "perAxis" });
    expect(store.removeGroup("missing")).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(localStorage.getItem("vs.plot3d.settings")).toBe(disk);
    store.addGroup();
    store.undo();
    const locked = store.getSnapshot();
    setOperatorLocked(true);
    expect(store.addGroup()).toBe("");
    expect(store.removeGroup("g1")).toBe(false);
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
    expect(store.setCalibSrc(null)).toBe(false);
    expect(store.bindGroupFirstFree("g1", "ax")).toBeNull();
    store.setSetting({ calibSrc: null });
    store.resetSettings();
    expect(store.importSettingsFromPkg({ v: 3, groups: [] })).toBe(false);
    expect(store.getSnapshot()).toBe(locked);
  });

  it("generated UUID never reuses deleted or undone identity", () => {
    const id = "12345678-1234-4234-8234-123456789abc";
    const next = "22345678-1234-4234-8234-123456789abc";
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce(id).mockReturnValueOnce(id).mockReturnValue(next) });
    expect(store.addGroup()).toBe(id);
    store.removeGroup(id);
    expect(store.addGroup()).toBe(next);
    expect(store.getGroup(id)).toBeUndefined();
  });

  it("delayed Y preserves existing X-anchor/tolerance contract; explicit rebuild uses current raw history", () => {
    bindG1();
    const data = makeSeries();
    h.setSeries({ ...data, ay: { t: [], v: [] } });
    const calls = collect();
    pump();
    expect(gseq(calls, "g1")[0].b.t).toEqual([]);
    h.setSeries(data);
    pump();
    expect(gseq(calls, "g1")).toHaveLength(1); // Existing contract: consumed X anchors are not retried.
    const rebuilt = collect();
    pump();
    expect(gseq(rebuilt, "g1")[0].b.x).toEqual(store.exportTriples("g1")!.x);
  });
});

describe("P90 D3 游标裁决（陈旧 scrub 不再把画面截成空白）", () => {
  it("无数据时绝不应用 scrub：cursor 保持 null（跟随最新）", () => {
    h.setSeries({ ax: { t: [], v: [] }, ay: { t: [], v: [] }, az: { t: [], v: [] }, mag: { t: [], v: [] } });
    bindG1();
    const calls = collect();
    store.setScrub(5);
    pump(1);
    expect(calls.every((c) => c.cursor === null)).toBe(true);
  });

  it("scrub 下界钳到数据真起点，不再用 0 截没全部点", () => {
    h.setSeries(
      ser([20, 30, 40, 50], [1, 2, 3, 4], [11, 12, 13, 14], [21, 22, 23, 24], [100, 101, 102, 103]),
    );
    bindG1();
    const calls = collect();
    pump(1);
    store.setScrub(0.005); // 早于数据起点 0.02s
    pump(1);
    const last = calls[calls.length - 1];
    expect(last.cursor).toBeCloseTo(0.02, 6);
    store.setScrub(9); // 晚于末端 → 仍钳到末端
    pump(1);
    expect(calls[calls.length - 1].cursor).toBeCloseTo(0.05, 6);
  });
});
