/**
 * P99a-D1b：`applyLayoutJson`（三处布局应用的唯一落点）+ `appBus` 的回执契约。
 *
 * 为什么值得单独一份测试：布局是**整屏覆盖**，失败态最难看（界面被 clear() 清空却只报
 * "应用失败"）。这里钉三件事：① 失败也要给得出恢复路径；② `before`（自动备份）必须在
 * `clear()` 之前发生，否则备份到的是空屏；③ 总线的回执**必须有且只有一次**——
 * 没人接的时候也要响，不然就是"点了按钮什么都不发生"。
 */
import { describe, expect, it, vi } from "vitest";
import { applyLayoutJson, looksLikeLayoutJson } from "./applyLayout";
import { requestApplyLayout, subscribeAppBus } from "../ai/appBus";

const okApi = (order: string[], fail = false) => ({
  clear: () => {
    order.push("clear");
    if (fail) throw new Error("布局不兼容");
  },
  fromJSON: (j: unknown) => {
    order.push(`fromJSON:${JSON.stringify(j)}`);
    if (fail) throw new Error("布局不兼容");
  },
});

describe("applyLayoutJson", () => {
  it("没就绪 / 内容不是对象：回话要能看懂，且不碰界面", () => {
    const order: string[] = [];
    expect(applyLayoutJson(null, { panels: [] })).toContain("尚未就绪");
    expect(applyLayoutJson(okApi(order), "不是对象" as unknown)).toContain("不是对象");
    expect(order).toEqual([]);
  });

  it("成功路径：before 先于 clear，after 收尾恰一次", () => {
    const order: string[] = [];
    const after = vi.fn();
    const err = applyLayoutJson(okApi(order), { panels: ["a"] }, { before: () => order.push("before"), after });
    expect(err).toBeNull();
    expect(order).toEqual(["before", "clear", 'fromJSON:{"panels":["a"]}']);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("失败：报出异常原因 + 给出恢复路径，收尾照做（此刻界面已经空了）", () => {
    const order: string[] = [];
    const after = vi.fn();
    const err = applyLayoutJson(okApi(order, true), { panels: [] }, { after });
    expect(err).toContain("布局不兼容");
    expect(err).toContain("设置 → 工作区"); // 不许只留一句"失败"让用户对着空屏猜（D2 校正：布局槽在「工作区」页，不是「布局」）
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("looksLikeLayoutJson", () => {
  it("只挡明显不是布局的东西；深校验留给 fromJSON（不抄 dockview 私有格式）", () => {
    expect(looksLikeLayoutJson(null)).toBe(false);
    expect(looksLikeLayoutJson("{}".length ? "字符串" : "")).toBe(false);
    expect(looksLikeLayoutJson([])).toBe(false);
    expect(looksLikeLayoutJson({ panels: {} })).toBe(true);
    expect(looksLikeLayoutJson({ grid: { cells: [] } })).toBe(true);
    expect(looksLikeLayoutJson({ whatever: 1 })).toBe(false);
  });
});

describe("appBus 的 applyLayout 回执契约", () => {
  it("没人接（App 未挂载）也要回执，不能点了没反应", () => {
    const done = vi.fn();
    requestApplyLayout({ panels: [] }, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toContain("尚未就绪");
  });

  it("有人接：转发布局并回传它的结果，且只回执一次", () => {
    const un = subscribeAppBus((msg) => {
      if (msg.kind === "applyLayout") msg.done(msg.layout ? null : "空布局");
    });
    const done = vi.fn();
    requestApplyLayout({ panels: ["a"] }, done);
    expect(done).toHaveBeenCalledWith(null);
    requestApplyLayout(null, done);
    expect(done).toHaveBeenCalledTimes(2);
    expect(done.mock.calls[1][0]).toContain("空布局");
    un();
  });

  it("App 侧确实在消费这条请求（接线不只在总线声明里）", async () => {
    const fsSpec = "node:fs";
    const urlSpec = "node:url";
    const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, enc?: string) => string };
    const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
    const app = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
    expect(app).toMatch(/msg\.kind === "applyLayout"[\s\S]{0,420}applyLayoutJson\(/);
    // 插件布局与命名槽同食一个函数：不许有人又在这里手搓 clear+fromJSON（§8-36①）
    const handRolled = (app.match(/api\.clear\(\)/g) ?? []).length;
    expect(handRolled, "App.tsx 里 api.clear() 的手搓处数超过预期").toBeLessThanOrEqual(2);
  });
});
