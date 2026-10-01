/**
 * P123-C · 属性页焦点总线的契约。
 *
 * 它只干一件事：记住"最后被点的是哪一侧的哪一块"。所以这里钉的全是**会不会多说一遍**：
 * 联动高亮、滚动、闪一下都挂在这条总线上，重复通知就是屏幕上的抖动（P122-C 那条
 * "同值不 emit"的判据同一个来源）。第二件事是别把真值搬进来 —— 它只放注意力。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getInspectorFocus, setInspectorFocus, subscribeInspector } from "./focus";

beforeEach(() => {
  setInspectorFocus(null);
});

describe("inspector/focus", () => {
  it("初始没有焦点", () => {
    expect(getInspectorFocus()).toBeNull();
  });

  it("同值再写一次不通知（写一次闪一次，抖动就是这么来的）", () => {
    const cb = vi.fn();
    subscribeInspector(cb);
    setInspectorFocus({ side: "tx", id: "s1", fieldId: "f1" });
    expect(cb).toHaveBeenCalledTimes(1);
    setInspectorFocus({ side: "tx", id: "s1", fieldId: "f1" });
    expect(cb, "内容一样的第二次写不该再吵一遍").toHaveBeenCalledTimes(1);
  });

  it("side / id / fieldId 任一变了都要通知", () => {
    const cb = vi.fn();
    subscribeInspector(cb);
    setInspectorFocus({ side: "rx", id: "s1", fieldId: "" });
    setInspectorFocus({ side: "tx", id: "s1", fieldId: "" });
    setInspectorFocus({ side: "tx", id: "s2", fieldId: "" });
    setInspectorFocus({ side: "tx", id: "s2", fieldId: "f9" });
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("清空焦点也算一次变化（属性页要能回到空态）", () => {
    const cb = vi.fn();
    subscribeInspector(cb);
    setInspectorFocus({ side: "tx", id: "s1", fieldId: "f1" });
    setInspectorFocus(null);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getInspectorFocus()).toBeNull();
    setInspectorFocus(null);
    expect(cb, "已经是 null 还再通知一次就是多嘴").toHaveBeenCalledTimes(2);
  });

  it("退订之后不再收到通知（面板关掉还留着订阅就是内存里的小抄）", () => {
    const cb = vi.fn();
    const off = subscribeInspector(cb);
    setInspectorFocus({ side: "rx", id: "a", fieldId: "" });
    off();
    setInspectorFocus({ side: "rx", id: "b", fieldId: "" });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
