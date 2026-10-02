/**
 * P131-B3：预览那一格状态的叶子测试。
 *
 * 合成器怎么用它，在 `themeApply.test.ts` 里对着真 store 测；这里只测这一格自己的口径：
 * 时长归一、剩余秒数、以及"计时器只是叫醒，判过期不靠它"。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampPreviewSeconds,
  clearThemePreview,
  DEFAULT_PREVIEW_MS,
  getThemePreview,
  PREVIEW_MAX_MS,
  previewSecondsLeft,
  setThemePreview,
} from "./themePreview";

afterEach(() => {
  clearThemePreview();
  vi.useRealTimers();
});

describe("时长归一", () => {
  it("缺省与坏值都落到默认档，不给「没预览但剩 0 秒」这种话", () => {
    expect(clampPreviewSeconds(undefined)).toBe(DEFAULT_PREVIEW_MS / 1000);
    expect(clampPreviewSeconds(NaN)).toBe(DEFAULT_PREVIEW_MS / 1000);
    expect(clampPreviewSeconds("abc")).toBe(DEFAULT_PREVIEW_MS / 1000);
    expect(clampPreviewSeconds(0)).toBe(DEFAULT_PREVIEW_MS / 1000);
    expect(clampPreviewSeconds(-5)).toBe(DEFAULT_PREVIEW_MS / 1000);
  });

  it("上下都夹：太短看不清，太长等于替用户做决定", () => {
    expect(clampPreviewSeconds(1)).toBe(2);
    expect(clampPreviewSeconds(9999)).toBe(PREVIEW_MAX_MS / 1000);
    expect(clampPreviewSeconds(7.6)).toBe(8);
  });
});

describe("那一格状态", () => {
  it("没设过预览时读 null，剩余秒数也读 null（不是 0）", () => {
    expect(getThemePreview()).toBeNull();
    expect(previewSecondsLeft()).toBeNull();
    expect(clearThemePreview(), "没有预览时说「清掉了」是假话").toBe(false);
  });

  it("过期的记录一律读作没有——判据与计时器无关", () => {
    setThemePreview({ id: "dark", expiresAt: Date.now() - 1 }, () => undefined);
    expect(getThemePreview()).toBeNull();
    expect(previewSecondsLeft()).toBeNull();
  });

  it("到点自己收：叫醒回调跑一次，之后读不到预览", () => {
    vi.useFakeTimers();
    let resynced = 0;
    setThemePreview({ id: "dark", expiresAt: Date.now() + 5_000 }, () => { resynced += 1; });
    expect(previewSecondsLeft()).toBe(5);
    vi.advanceTimersByTime(5_100);
    expect(resynced).toBe(1);
    expect(getThemePreview()).toBeNull();
  });

  it("改期不会留下两个计时器：后一次设过之后，前一次的到点时刻不该把新预览收掉", () => {
    vi.useFakeTimers();
    let resynced = 0;
    const resync = () => { resynced += 1; };
    setThemePreview({ id: "dark", expiresAt: Date.now() + 2_000 }, resync);
    setThemePreview({ id: "ocean", expiresAt: Date.now() + 9_000 }, resync);
    vi.advanceTimersByTime(3_000);
    expect(resynced, "旧计时器还在＝新预览被提前收掉").toBe(0);
    expect(getThemePreview()?.id).toBe("ocean");
    vi.advanceTimersByTime(6_100);
    expect(resynced).toBe(1);
  });

  it("clear 说真话：有预览时返回 true，之后立刻读不到", () => {
    setThemePreview({ id: "dark", expiresAt: Date.now() + 4_000 }, () => undefined);
    expect(clearThemePreview()).toBe(true);
    expect(getThemePreview()).toBeNull();
    expect(clearThemePreview()).toBe(false);
  });
});
