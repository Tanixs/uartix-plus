import { describe, expect, it } from "vitest";
import { createScope } from "./effects";

/**
 * P174-A18①：可逆 Effect 的判据。
 *
 * 这些用例守的不是"能登记能撤销"（那部分坏了会立刻看出来），而是**撤销得对不对**：
 * 顺序、失败隔离、重入、以及"销毁之后还能不能再往里塞东西"。
 * 这四种错都不会当场报错——它们表现为"卸载后还有一个定时器在转"。
 */
describe("EffectScope", () => {
  it("逆序撤销：后建的先撤（先解绑事件，再销毁窗口）", async () => {
    const order: string[] = [];
    const s = createScope("t");
    s.add("窗口", () => void order.push("window"));
    s.add("事件绑定", () => void order.push("listener"));
    s.add("动画循环", () => void order.push("raf"));
    const r = await s.disposeAll();
    expect(r.failed).toBe(0);
    expect(order).toEqual(["raf", "listener", "window"]);
  });

  it("一条抛错不中断其余（且**报告失败条数**）", async () => {
    const done: string[] = [];
    const s = createScope("t");
    s.add("a", () => void done.push("a"));
    s.add("b", () => {
      throw new Error("坏掉的清理");
    });
    s.add("c", () => void done.push("c"));
    const r = await s.disposeAll();
    expect(done).toEqual(["c", "a"]); // c 先（逆序），b 抛了但 a 照样跑
    expect(r.failed).toBe(1);
  });

  it("异步 disposer 会被等完（不是发出去就算）", async () => {
    let closed = false;
    const s = createScope("t");
    s.add("关闭连接", async () => {
      await new Promise((r) => setTimeout(r, 5));
      closed = true;
    });
    await s.disposeAll();
    expect(closed).toBe(true);
  });

  it("重复撤销安全：disposeAll 两次、提前释放后再 disposeAll 都不会跑第二遍", async () => {
    let n = 0;
    const s = createScope("t");
    const release = s.add("x", () => void n++);
    release();
    release();
    await s.disposeAll();
    await s.disposeAll();
    expect(n).toBe(1);
  });

  it("销毁之后 add 必须抛错（否则那条副作用再没人能撤销）", async () => {
    const s = createScope("t");
    await s.disposeAll();
    expect(s.disposed).toBe(true);
    expect(() => s.add("迟到者", () => undefined)).toThrow(/已经销毁/);
  });

  it("size 只数还活着的；提前释放会减一", () => {
    const s = createScope("t");
    const a = s.add("a", () => undefined);
    s.add("b", () => undefined);
    expect(s.size).toBe(2);
    a();
    expect(s.size).toBe(1);
  });
});
