import { describe, expect, it, vi } from "vitest";
import {
  attachViewWheelGuard,
  makeLadder,
  type QualityTiers,
} from "./viewQuality";

const TIERS: QualityTiers = {
  0: { dprCap: 2, targetFps: 30, downFps: 24, dwellMs: 2000 },
  1: { dprCap: 1.5, targetFps: 30, downFps: 20, dwellMs: 2000 },
  2: { dprCap: 1, targetFps: 20, downFps: 0, dwellMs: Infinity },
};

describe("viewQuality · 通用降级阶梯", () => {
  const ladder = makeLadder(TIERS);

  it("只有掉到阈值且待满 dwell 才降一级", () => {
    expect(ladder.nextQuality(0, { fps: 23, msInLevel: 2000 })).toBe(1);
    expect(ladder.nextQuality(0, { fps: 23, msInLevel: 1999 })).toBe(0);
    expect(ladder.nextQuality(0, { fps: 24, msInLevel: 9999 })).toBe(0);
    expect(ladder.nextQuality(1, { fps: 19, msInLevel: 2000 })).toBe(2);
    // 0fps 是"还没采到样本"，不能当成卡死
    expect(ladder.nextQuality(0, { fps: 0, msInLevel: 9999 })).toBe(0);
  });

  it("只降不升：L2 是终点", () => {
    expect(ladder.nextQuality(2, { fps: 1, msInLevel: 99999 })).toBe(2);
  });

  it("像素比 = dpr × zf，夹在 [1, min(档位上限, 2)]", () => {
    expect(ladder.pixelRatioFor(2, 1, 0)).toBeCloseTo(2);
    expect(ladder.pixelRatioFor(2, 1, 1)).toBeCloseTo(1.5);
    expect(ladder.pixelRatioFor(2, 1, 2)).toBeCloseTo(1);
    expect(ladder.pixelRatioFor(3, 1, 0)).toBe(2);
    expect(ladder.pixelRatioFor(1, 0.5, 0)).toBe(1);
    expect(ladder.pixelRatioFor(Number.NaN, 1, 0)).toBe(1);
  });

  it("档位表原样透出（各视图自己配数，不在这里再抄一份）", () => {
    expect(ladder.dprCapOf(0)).toBe(2);
    expect(ladder.targetFpsOf(2)).toBe(20);
  });
});

type WheelCb = (e: WheelEvent) => void;

function fakeHost() {
  const cbs: WheelCb[] = [];
  const added: string[] = [];
  const host = {
    addEventListener(type: string, cb: WheelCb, opts?: AddEventListenerOptions) {
      added.push(`${type}${opts?.passive === false ? ":nonpassive" : ""}`);
      cbs.push(cb);
    },
    removeEventListener(_type: string, cb: WheelCb) {
      const i = cbs.indexOf(cb);
      if (i >= 0) cbs.splice(i, 1);
    },
  } as unknown as HTMLElement;
  return { host, cbs, added };
}

const wheel = () =>
  ({ stopPropagation: vi.fn(), preventDefault: vi.fn() }) as unknown as WheelEvent;

describe("viewQuality · 卡片内滚轮分流", () => {
  it("必须非被动注册，否则 preventDefault 会被浏览器忽略", () => {
    const { host, added } = fakeHost();
    const detach = attachViewWheelGuard(host, () => false);
    expect(added).toEqual(["wheel:nonpassive"]);
    detach();
  });

  it("未锁定：截停冒泡与默认滚动，只让 OrbitControls 缩放", () => {
    const { host, cbs } = fakeHost();
    attachViewWheelGuard(host, () => false);
    const e = wheel();
    cbs[0]!(e);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("锁定：完全放行，滚轮交还控制画布", () => {
    const { host, cbs } = fakeHost();
    attachViewWheelGuard(host, () => true);
    const e = wheel();
    cbs[0]!(e);
    expect(e.stopPropagation).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("卸载摘掉监听，不叠第二份", () => {
    const { host, cbs } = fakeHost();
    const detach = attachViewWheelGuard(host, () => false);
    expect(cbs).toHaveLength(1);
    detach();
    expect(cbs).toHaveLength(0);
  });
});
