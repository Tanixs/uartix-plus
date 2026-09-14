/**
 * P69 plot3dStore 数据泵测试。
 *
 * 覆盖核心红线逻辑：
 * - 时间水位 lastT 续传：源重建/裁剪后不重复消费、不漏段
 * - 绑定/通道/密度/配对签名变化 → reloaded 全量重灌
 * - 密度 stride 抽稀（高 1:1 / 中 1:2 / 低 1:4）
 * - 三轴时间戳配对（P75 B2）：同帧同 ts → 每帧 1 点（阶梯根因回归）；
 *   插值/最近邻/union 前向填充；容差外跳过计入 pairSnapshot
 * - 着色通道 valCarry 前向填充；绑定通道被删除 → 自动解绑（悬空纠正语义）
 * - 三轴未绑齐不消费；setSink(null) 停泵（面板关闭零开销）
 * - P70 时间游标：回放跟随 > 手动 scrub > null；seek 向后空批次回退、向前水位跳重；
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

function collect() {
  const batches: { b: Batch; reloaded: boolean }[] = [];
  store.setSink((b, reloaded) => batches.push({ b, reloaded }));
  return batches;
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

describe("plot3dStore 泵", () => {
  it("三轴未绑齐 → 不消费；绑齐后首个 batch reloaded=true", () => {
    h.setSeries(makeSeries());
    const batches = collect();
    pump(2);
    expect(batches).toHaveLength(0);

    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    pump(1);
    expect(batches).toHaveLength(1);
    expect(batches[0].reloaded).toBe(true);
    expect(batches[0].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    expect(batches[0].b.x).toEqual([1, 2, 3, 4, 5, 6]);
    expect(batches[0].b.y).toEqual([11, 12, 13, 14, 15, 16]);
    expect(batches[0].b.z).toEqual([21, 22, 23, 24, 25, 26]);
  });

  it("时间水位续传：源追加只推新增段；源重建不重灌不重复", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collect();
    pump(1);
    expect(batches).toHaveLength(1);

    // 追加 2 点（60/70ms）
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
    expect(batches).toHaveLength(2);
    expect(batches[1].reloaded).toBe(false);
    expect(batches[1].b.t).toEqual([0.06, 0.07]);
    expect(batches[1].b.x).toEqual([7, 8]);

    // 源裁剪重建（时间水位之前的点全部丢掉）→ 仍不重复、不补旧点
    h.setSeries(
      ser(
        [70, 80, 90],
        [8, 9, 10],
        [18, 19, 20],
        [28, 29, 30],
        [106, 107, 108],
      ),
    );
    pump(1);
    expect(batches).toHaveLength(3);
    expect(batches[2].b.t).toEqual([0.08, 0.09]);
    expect(batches[2].b.x).toEqual([9, 10]);
  });

  it("density 抽稀：mid=1:2 / low=1:4（对消费序号取模）", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", density: "mid" });
    const batches = collect();
    pump(1);
    expect(batches[0].b.x).toEqual([1, 3, 5]); // 序号 0,2,4

    store._resetForTest();
    store.setSink(null);
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", density: "low" });
    const b2 = collect();
    pump(1);
    expect(b2[0].b.x).toEqual([1, 5]); // 序号 0,4
  });

  it("着色通道：valCarry 前向填充首 null；colorBy=time 时 val 恒 0", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", colorBy: "ch", colorCh: "mag" });
    const batches = collect();
    pump(1);
    expect(batches[0].b.val).toEqual([0, 100, 101, 102, 103, 104]);

    store._resetForTest();
    store.setSink(null);
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" }); // colorBy=time
    const b2 = collect();
    pump(1);
    expect(b2[0].b.val).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("着色通道被删 → 回退按时间着色（自动纠正，不阻塞消费）", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", colorBy: "ch", colorCh: "mag" });
    const batches = collect();
    pump(1);
    expect(batches).toHaveLength(1);

    h.chans.splice(3, 1); // 删除 mag 通道
    pump(1);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[1].reloaded).toBe(true);
    expect(batches[1].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]); // 重灌
    expect(store.getSnapshot().settings.colorBy).toBe("time");
    h.chans.push({ id: "mag", tplId: "t", fieldId: "f4", name: "磁场", color: "#ffff00", visible: true });
  });

  it("轴绑定通道被删 → 自动解绑并停消费", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collect();
    pump(1);
    expect(batches).toHaveLength(1);

    h.chans.splice(0, 1); // 删除 ax
    pump(1);
    expect(store.getSnapshot().settings.axisX).toBe("");
    h.chans.unshift({ id: "ax", tplId: "t", fieldId: "f1", name: "加计X", color: "#ff0000", visible: true });
  });

  it("面板关闭（panelActivity 不含 plot3d）→ 泵空转不喂数", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collect();
    panelActivity.syncPanels([]);
    pump(2);
    expect(batches).toHaveLength(0);
    panelActivity.syncPanels([{ id: "plot3d", visible: true }]);
    pump(1);
    expect(batches).toHaveLength(1);
  });

  it("设置持久化：setSetting 写 localStorage，_resetForTest 后重读生效", () => {
    store.setSetting({ axisX: "ax", fade: 300, style: "points" });
    const raw = localStorage.getItem("vs.plot3d.settings");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { axisX: string; fade: number; style: string };
    expect(parsed).toMatchObject({ axisX: "ax", fade: 300, style: "points" });
  });
});

describe("P74c C1：Operator 只读边界", () => {
  afterEach(() => setOperatorLocked(false));

  it("锁定时：配置类设置被拒（绑定/着色/密度/网格/默认值）", () => {
    setOperatorLocked(true);
    store.setSetting({ axisX: "ax" });
    store.setSetting({ colorBy: "ch", colorCh: "mag" });
    store.setSetting({ style: "points", density: "low", showGrid: false, gridDensity: "coarse" });
    store.setSetting({ fade: 300, keyFlight: true, zoomToCursor: true });
    const s = store.getSnapshot().settings;
    expect(s).toMatchObject({
      axisX: "",
      colorBy: "time",
      style: "line+points",
      density: "high",
      showGrid: true,
      gridDensity: "std",
      fade: 60,
      keyFlight: false,
      zoomToCursor: false,
    });
    // 配置类整体写入也拒（含默认值恢复）
    expect(store.importSettingsFromPkg({ axisX: "ax", style: "points" })).toBe(false);
    store.resetSettings();
    expect(store.getSnapshot().settings.axisX).toBe("");
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
    // 混合补丁（含配置字段）→ 整包拒绝，连视图字段也不生效、不落盘
    store.setSetting({ follow: true, axisX: "ax" });
    expect(store.getSnapshot().settings).toMatchObject({ follow: false, axisX: "" });
    expect(localStorage.getItem("vs.plot3d.settings")).toBeNull();

    store.setSetting({ follow: true }); // 纯视图态 → 放行并落盘
    expect(JSON.parse(localStorage.getItem("vs.plot3d.settings")!)).toMatchObject({
      follow: true,
      axisX: "",
    });
  });
});

/** P70 游标批次收集器（带第三参 cursorSec） */
function collectCur() {
  const batches: { b: Batch; reloaded: boolean; cursor: number | null }[] = [];
  store.setSink((b, reloaded, cursor) => batches.push({ b, reloaded, cursor }));
  return batches;
}

describe("plot3dStore 时间游标（P70）", () => {
  it("回放态：泵下发 cursor=回放相对秒（clamp 到源范围）", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collectCur();
    store._setSessionForTest(() => ({ playing: true, replayTsMs: 25 }));
    pump(1);
    expect(batches).toHaveLength(1);
    expect(batches[0].cursor).toBeCloseTo(0.025);
    // 超出源末端 → clamp 到末端 0.05
    store._setSessionForTest(() => ({ playing: true, replayTsMs: 9999 }));
    pump(1);
    expect(batches[1].cursor).toBeCloseTo(0.05);
  });

  it("seek 向后：空批次仍下发、cursor 回退、不重灌不重复", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collectCur();
    let ts = 45;
    store._setSessionForTest(() => ({ playing: true, replayTsMs: ts }));
    pump(1);
    expect(batches[0].reloaded).toBe(true);
    expect(batches[0].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]); // 泵消费整个源
    expect(batches[0].cursor).toBeCloseTo(0.045); // 游标=回放位置，与水位无关

    ts = 15; // seek 向后：重灌点全 ≤ 水位 → 批次空，仅游标回退
    pump(1);
    expect(batches).toHaveLength(2);
    expect(batches[1].b.t).toEqual([]);
    expect(batches[1].reloaded).toBe(false);
    expect(batches[1].cursor).toBeCloseTo(0.015);

    pump(1); // 游标未变 + 无新数据 → 不重复下发
    expect(batches).toHaveLength(2);
  });

  it("seek 向前越段：水位跳过重复重灌段、只推新增", () => {
    // 回放推进到 20ms：plotStore 仅含已重灌段 [0..20]
    h.setSeries(
      ser(
        [0, 10, 20],
        [1, 2, 3],
        [11, 12, 13],
        [21, 22, 23],
        [null, 100, 101],
      ),
    );
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collectCur();
    let ts = 20;
    store._setSessionForTest(() => ({ playing: true, replayTsMs: ts }));
    pump(1);
    expect(batches[0].b.t).toEqual([0, 0.01, 0.02]);
    expect(batches[0].cursor).toBeCloseTo(0.02);

    // seek 到 50ms：重灌段 [0..50]，其中 [0..20] 为重复（ts ≤ 水位自动跳过），仅新增 [30..50]
    h.setSeries(makeSeries());
    ts = 50;
    pump(1);
    expect(batches[1].b.t).toEqual([0.03, 0.04, 0.05]);
    expect(batches[1].cursor).toBeCloseTo(0.05);
  });

  it("回放结束：cursor=null 恢复跟随最新", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collectCur();
    const probe = { playing: true, replayTsMs: 30 };
    store._setSessionForTest(() => probe);
    pump(1);
    expect(batches[0].cursor).toBeCloseTo(0.03);

    probe.playing = false; // 回放结束
    pump(1);
    expect(batches).toHaveLength(2);
    expect(batches[1].b.t).toEqual([]);
    expect(batches[1].cursor).toBeNull();
  });

  it("scrub 态：批次第三参=scrub 值（clamp 到源范围）；setScrub(null) 恢复；回放优先于 scrub", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collectCur();
    store._setSessionForTest(null); // 恢复默认探针（sessionStore 未回放 → playing=false）
    pump(1);
    expect(batches[0].cursor).toBeNull();

    store.setScrub(0.032);
    pump(1);
    expect(batches[1].cursor).toBeCloseTo(0.032);

    store.setScrub(999); // 超末端 → clamp
    pump(1);
    expect(batches[2].cursor).toBeCloseTo(0.05);

    store.setScrub(null);
    pump(1);
    expect(batches[3].cursor).toBeNull();

    // 回放优先：scrub 残留也不覆盖回放游标
    const probe2 = { playing: true, replayTsMs: 40 };
    store._setSessionForTest(() => probe2);
    store.setScrub(0.01);
    pump(1);
    expect(batches[4].cursor).toBeCloseTo(0.04);
  });

  it("lowerBoundLe：空/首/尾/重复 ts 边界（= drawRange 截断数）", () => {
    const arr = new Float64Array([1, 2, 2, 3, 5]);
    expect(lowerBoundLe(arr, 0, 10)).toBe(0); // 空
    expect(lowerBoundLe(arr, arr.length, 0)).toBe(0); // 小于全部
    expect(lowerBoundLe(arr, arr.length, 1)).toBe(1); // 首
    expect(lowerBoundLe(arr, arr.length, 2)).toBe(3); // 重复 ts：取末个 ≤
    expect(lowerBoundLe(arr, arr.length, 4)).toBe(4); // 间隙
    expect(lowerBoundLe(arr, arr.length, 5)).toBe(5); // 尾
    expect(lowerBoundLe(arr, arr.length, 99)).toBe(5); // 超尾 clamp
    expect(lowerBoundLe(arr, 3, 99)).toBe(3); // n 截断
  });
});

describe("plot3dStore 椭球校准采样（P71）", () => {
  it("calibMode + 采样中：泵 stride=1 追加原始点（与密度抽稀无关）；null 轴跳过", () => {
    h.setSeries(
      ser(
        [0, 10, 20, 30],
        [1, 2, null, 4],
        [11, 12, 13, 14],
        [21, 22, 23, 24],
        [null, 100, 101, 102],
      ),
    );
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true, density: "low" });
    const sink = vi.fn();
    store.setSink(sink);
    store.startCalibCapture();
    pump(1);
    const pts = store.calibPoints();
    expect(pts.x).toEqual([1, 2, 4]); // null 轴跳过；density=low 不影响校准采样
    expect(pts.y).toEqual([11, 12, 14]);
    expect(store.calibSnapshot()).toMatchObject({ capturing: true, count: 3 });
    expect(store.calibSnapshot().coverage).toBeGreaterThan(0);
  });

  it("未开采样 → 不追加；开启后只采水位新增；满 CAP 自动停止", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    pump(1);
    expect(store.calibPoints().x).toHaveLength(0); // capturing=false，且消费水位已到末端
    store.startCalibCapture();
    // 源追加 2 点（水位续传，只采新增）
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
    // 关闭校准模式（仍 capturing=true）→ 停止追加
    store.setSetting({ calibMode: false });
    h.setSeries(
      ser(
        [0, 10, 20, 30, 40, 50, 60, 70, 80],
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
        [11, 12, 13, 14, 15, 16, 17, 18, 19],
        [21, 22, 23, 24, 25, 26, 27, 28, 29],
        [null, 100, 101, 102, 103, 104, 105, 106, 107],
      ),
    );
    pump(1);
    expect(store.calibPoints().x).toEqual([7, 8]);
    // 超量自动停止：清空后重采，源 20050 点 → 采满 20000 停
    store.clearCalib();
    store.setSetting({ calibMode: true });
    store.startCalibCapture();
    const bigTs = Array.from({ length: 20050 }, (_, i) => i * 10);
    h.setSeries({
      ax: { t: bigTs, v: Array.from({ length: 20050 }, (_, i) => i) },
      ay: { t: bigTs, v: Array.from({ length: 20050 }, (_, i) => i + 1) },
      az: { t: bigTs, v: Array.from({ length: 20050 }, (_, i) => i + 2) },
      mag: { t: bigTs, v: Array.from({ length: 20050 }, () => 0) },
    });
    pump(1);
    const snap = store.calibSnapshot();
    expect(snap.count).toBe(store.CALIB_CAP);
    expect(snap.capturing).toBe(false); // 自动停止
  });

  it("重灌（绑定变化）清空校准缓冲；setSink(null)（面板关闭）清空", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    store.startCalibCapture(); // 先开采样再首次泵 → 全量入缓冲
    pump(1);
    expect(store.calibPoints().x).toHaveLength(6);
    // 换绑定 → sig 变化 → 重灌 → 缓冲清空
    store.setSetting({ axisX: "az", axisY: "ay", axisZ: "ax" });
    pump(1);
    expect(store.calibPoints().x).toHaveLength(0);
    // 重新采样后关闭面板 → 清空
    store.startCalibCapture();
    h.setSeries(
      ser(
        [60, 70, 80, 90], // ts 须 > 水位 50ms，否则视为 seek 回退不采
        [1, 2, 3, 4],
        [11, 12, 13, 14],
        [21, 22, 23, 24],
        [null, 100, 101, 102],
      ),
    );
    pump(1);
    expect(store.calibPoints().x.length).toBeGreaterThan(0);
    store.setSink(null);
    expect(store.calibPoints().x).toHaveLength(0);
    expect(store.calibSnapshot().capturing).toBe(false);
  });

  it("包导入导出：export 剥离 calibMode；import 归一化非法字段", () => {
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true, fade: 10 });
    const exported = store.exportSettingsForPkg();
    expect(exported.calibMode).toBe(false); // 操作态剥离
    expect(exported.axisX).toBe("ax");
    expect(exported.fade).toBe(10);
    // 导入：非法字段回退默认（归一化）
    expect(store.importSettingsFromPkg({ axisX: "p", fade: 999, style: "bogus" })).toBe(true);
    const snap = store.getSnapshot().settings;
    expect(snap.axisX).toBe("p");
    expect(snap.fade).toBe(60);
    expect(snap.style).toBe("line+points");
    expect(snap.calibMode).toBe(false);
    expect(store.importSettingsFromPkg(null)).toBe(false);
    expect(store.importSettingsFromPkg("x")).toBe(false);
  });

  it("P74c B4：calibMode 是会话级操作态——包导入不恢复、endCalibSession 关闭即退出", () => {
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    expect(store.getSnapshot().settings.calibMode).toBe(true);
    // 导入包（即使原样回灌当前设置快照，calibMode 也被归一化为 false）
    expect(store.importSettingsFromPkg(store.getSnapshot().settings)).toBe(true);
    expect(store.getSnapshot().settings.calibMode).toBe(false);
    // resetSettings 同样不复活
    store.setSetting({ calibMode: true });
    store.resetSettings();
    expect(store.getSnapshot().settings.calibMode).toBe(false);
    // 面板关闭语义
    store.setSetting({ calibMode: true });
    store.endCalibSession();
    expect(store.getSnapshot().settings.calibMode).toBe(false);
    store.endCalibSession(); // 幂等：已退出时不再 emit
    expect(store.getSnapshot().settings.calibMode).toBe(false);
  });

  it("P74c A5：invalidateCursor 强制下一拍重发游标（场景重建后游标不消失）", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const calls: { cursorSec: number | null }[] = [];
    store.setSink((_b, _r, cursorSec) => calls.push({ cursorSec }));
    store.setScrub(0.03);
    pump(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].cursorSec).toBeCloseTo(0.03);

    // 无新批次且游标未变 → 不重发（原行为：静态时零下发）
    const n = calls.length;
    pump(1);
    expect(calls.length).toBe(n);

    // 场景重建 → 强制重发同一游标，否则新场景的时间游标线凭空消失
    store.invalidateCursor();
    pump(1);
    expect(calls.length).toBe(n + 1);
    expect(calls[calls.length - 1].cursorSec).toBeCloseTo(0.03);
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
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    pump(1);
    expect(store.previewSnapshot()).toBeNull(); // 无 fit 不缓冲
    store.setCalibFit(makeFit());
    // 源追加 2 点（水位续传只算新增）
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
    expect(pv.head).toBe(2); // 写入 2 点后推进
    expect(pv.meanR).toBe(100);
    expect(pv.r[0]).toBeCloseTo(Math.hypot(7, 17, 27)); // identity W + offset 0
    expect(pv.t[0]).toBeCloseTo(0.06);
    expect(pv.t[1]).toBeCloseTo(0.07);
  });

  it("环形覆写：一次灌入超 CAP → len 恒 1200、head 循环推进、无异常", () => {
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    pump(1); // 空源先建立签名（运行时语义：先挂面板后拟合）
    store.setCalibFit(makeFit());
    const n = 2500;
    const ts = Array.from({ length: n }, (_, i) => i);
    h.setSeries({
      ax: { t: ts, v: Array.from({ length: n }, (_, i) => 3 * i) },
      ay: { t: ts, v: Array.from({ length: n }, (_, i) => 4 * i) },
      az: { t: ts, v: Array.from({ length: n }, (_, i) => 5 * i) },
      mag: { t: ts, v: Array.from({ length: n }, () => 0) },
    });
    pump(1);
    const pv = store.previewSnapshot();
    if (!pv) throw new Error("previewSnapshot 应非 null");
    expect(pv.len).toBe(store.PREVIEW_CAP);
    expect(pv.head).toBe(n % store.PREVIEW_CAP); // 2500 % 1200 = 100
    // 最老被覆写：head-1 位置 = 最后一点 r=hypot(3·2499,4·2499,5·2499)
    const last = pv.r[(pv.head + store.PREVIEW_CAP - 1) % store.PREVIEW_CAP];
    expect(last).toBeCloseTo(Math.hypot(3 * 2499, 4 * 2499, 5 * 2499), 1); // f32 精度 1 位小数
  });

  it("setCalibFit 重置缓冲；clearCalib 清 fit；重灌（换绑定）清 fit+六面", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    store.setCalibFit(makeFit());
    // 换绑定 → 重灌 → fit 清空
    store.setSetting({ axisX: "az", axisY: "ay", axisZ: "ax" });
    pump(1);
    expect(store.getCalibFit()).toBeNull();
    expect(store.previewSnapshot()).toBeNull();
    // 重新拟合后 clearCalib → fit/预览清
    store.setCalibFit(makeFit());
    store.clearCalib();
    expect(store.getCalibFit()).toBeNull();
    expect(store.previewSnapshot()).toBeNull();
  });
});

describe("plot3dStore 加计六面（P73）", () => {
  /** 追加一段恒值源并采集面 idx（窗锚定源时间，2s 自动结算） */
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
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    capFace(0, [100, 0, 0]);
    const snap = store.accel6Snapshot();
    expect(snap.collecting).toBe(false);
    expect(snap.idx).toBe(-1);
    const f = snap.faces[0];
    if (!f) throw new Error("face 0 应已结算");
    expect(f.n).toBe(2001); // t0..t0+2000ms 含首尾
    expect(f.mean[0]).toBeCloseTo(100);
    expect(f.mean[1]).toBeCloseTo(0);
    expect(f.std[0]).toBeCloseTo(0);
  });

  it("互斥：六面采集停椭球采样；椭球采样停六面", () => {
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    store.startCalibCapture();
    expect(store.calibSnapshot().capturing).toBe(true);
    store.accel6StartFace(2);
    expect(store.calibSnapshot().capturing).toBe(false); // 六面让椭球停
    expect(store.accel6Snapshot().collecting).toBe(true);
    store.startCalibCapture();
    expect(store.accel6Snapshot().collecting).toBe(false); // 椭球让六面停
    expect(store.calibSnapshot().capturing).toBe(true);
  });

  it("六面齐 → accel6Solve 解算 offset/scale（合成真值回收）；缺面拒绝", () => {
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", calibMode: true });
    store.setSink(vi.fn());
    // 真值：offset=[10,-20,5]，scale=[100,102,98]（原始单位/g，gRef=1）
    capFace(0, [110, -20, 5]); // +X
    capFace(1, [-90, -20, 5]); // −X
    capFace(2, [10, 82, 5]); // +Y
    capFace(3, [10, -122, 5]); // −Y
    capFace(4, [10, -20, 103]); // +Z
    // 缺 −Z → 拒绝
    const miss = store.accel6Solve();
    expect(miss.ok).toBe(false);
    capFace(5, [10, -20, -93]); // −Z
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

describe("plot3dStore 三轴时间戳配对（P75 B2）", () => {
  it("回归：同帧三轴（相同时间戳）→ 每帧恰 1 点（旧联合轴拆 3 行的阶梯根因）", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collect();
    pump(1);
    expect(batches[0].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]); // 6 帧 6 点
    expect(batches[0].b.x).toEqual([1, 2, 3, 4, 5, 6]);
    const ps = store.pairSnapshot();
    expect(ps.paired).toBe(6);
    expect(ps.skipped).toBe(0);
    expect(ps.min).toEqual([1, 11, 21]);
    expect(ps.max).toEqual([6, 16, 26]);
    expect(ps.tolMs).toBeGreaterThan(0); // 自动容差已解析
  });

  it("Y 半频：插值模式平滑（中间锚点线性、尾沿保持）", () => {
    h.setSeries({
      ax: { t: [0, 10, 20, 30], v: [0, 1, 2, 3] },
      ay: { t: [0, 20], v: [0, 2] },
      az: { t: [0, 10, 20, 30], v: [0, 1, 2, 3] },
    });
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collect();
    pump(1);
    expect(batches[0].b.y).toEqual([0, 1, 2, 2]);
    expect(batches[0].b.x).toEqual([0, 1, 2, 3]);
    expect(store.pairSnapshot().skipped).toBe(0);
  });

  it("nearest + 手动小容差：稀疏 Y 容差外全部跳过并计入统计", () => {
    h.setSeries({
      ax: { t: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], v: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
      ay: { t: [0, 100], v: [0, 1] },
      az: { t: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], v: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    });
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", pairMode: "nearest", pairTolMs: 5 });
    const batches = collect();
    pump(1);
    expect(batches[0].b.t).toEqual([0]); // 仅 t=0 精确命中；无尾沿（锚点未及 100）
    const ps = store.pairSnapshot();
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
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az", pairMode: "union" });
    const batches = collect();
    pump(1);
    expect(batches[0].b.t).toHaveLength(11); // 并集 [0,10..90,100]
    expect(batches[0].b.y).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]); // Y 前向填充 = 阶梯来源
    expect(store.pairSnapshot().tolMs).toBe(0); // union 无容差概念
  });

  it("配对方式/容差变更 → 签名变化 → 全量重灌", () => {
    h.setSeries(makeSeries());
    store.setSetting({ axisX: "ax", axisY: "ay", axisZ: "az" });
    const batches = collect();
    pump(1);
    expect(batches).toHaveLength(1);
    store.setSetting({ pairTolMs: 25 });
    pump(1);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[batches.length - 1].reloaded).toBe(true);
    expect(batches[batches.length - 1].b.t).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
  });
});
