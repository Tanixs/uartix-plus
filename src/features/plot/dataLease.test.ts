/** P88b-2 §6.1 租约：上限/FIFO/幂等/排队超时/取消（不触达 plotStore 渲染链）。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DATA_LEASE_CAP,
  acquireDataLease,
  hasDataLease,
  leaseCount,
  releaseDataLease,
} from "./dataLease";

describe("dataLease", () => {
  beforeEach(() => {
    // 模块级状态归零，保证用例独立（覆盖用例中出现过的所有 owner 名）
    for (const o of [...Array(32).keys()].map((i) => `o${i}`).concat(["w1", "w2", "t1", "t2"])) {
      releaseDataLease(o);
    }
  });

  it("上限内直接授予，重复 acquire 幂等", async () => {
    for (let i = 0; i < DATA_LEASE_CAP; i++) {
      await expect(acquireDataLease(`o${i}`)).resolves.toBe(true);
    }
    expect(leaseCount()).toBe(DATA_LEASE_CAP);
    await expect(acquireDataLease("o0")).resolves.toBe(true);
    expect(leaseCount()).toBe(DATA_LEASE_CAP);
  });

  it("占满后新申请排队，释放后按 FIFO 唤醒", async () => {
    for (let i = 0; i < DATA_LEASE_CAP; i++) await acquireDataLease(`o${i}`);
    const w1 = acquireDataLease("w1");
    const w2 = acquireDataLease("w2");
    expect(leaseCount()).toBe(DATA_LEASE_CAP);
    releaseDataLease("o0"); // 只腾一个坑 → w1 上位，w2 仍排队
    await expect(w1).resolves.toBe(true);
    expect(hasDataLease("w1")).toBe(true);
    expect(hasDataLease("w2")).toBe(false);
    releaseDataLease("o1");
    await expect(w2).resolves.toBe(true);
    expect(hasDataLease("w2")).toBe(true);
  });

  it("排队超时返回 false，不占坑", async () => {
    for (let i = 0; i < DATA_LEASE_CAP; i++) await acquireDataLease(`o${i}`);
    vi.useFakeTimers();
    const r = vi.fn();
    void acquireDataLease("t1").then(r);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(r).toHaveBeenCalledWith(false);
    vi.useRealTimers();
    releaseDataLease("o0");
    expect(hasDataLease("t1")).toBe(false);
  });

  it("排队中被 AbortSignal 取消立即返回 false", async () => {
    for (let i = 0; i < DATA_LEASE_CAP; i++) await acquireDataLease(`o${i}`);
    const ac = new AbortController();
    const p = acquireDataLease("t2", ac.signal);
    ac.abort();
    await expect(p).resolves.toBe(false);
  });

  it("release 幂等；全部释放归零", async () => {
    releaseDataLease("ghost");
    for (let i = 0; i < DATA_LEASE_CAP; i++) await acquireDataLease(`o${i}`);
    for (let i = 0; i < DATA_LEASE_CAP + 2; i++) releaseDataLease(`o${i}`);
    expect(leaseCount()).toBe(0);
    expect(hasDataLease("o0")).toBe(false);
  });
});
