/**
 * P155-X · 滑条卡不再硬塞进 1 行（用户 2026-10-17 图 3 那张重叠卡的真因）。
 *
 * 卡片高 = 格数 × STEP（1 行 = 60px），滑条卡内容自然高 ~85px（值 + 滑杆 + 脚注）。
 * 旧默认 2×1 让新卡一出生就「上骑下裁」；已存的 2×1 卡由 `.ctl-card` 的 container
 * 条件在矮档收掉脚注（值 + 滑杆保留）。两条各自钉住；尺寸表只许 `defaultCardSize` 一处。
 */
import { describe, expect, it, vi } from "vitest";
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

// controlsStore 求值期会碰 localStorage（同 controlsStore.test.ts 的理由）
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const SRC = fileURLToPath(new URL("../../", import.meta.url)); // → src/
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");
const CSS = read("styles/theme.css");
const STORE = read("features/controls/controlsStore.ts");

const { defaultCardSize } = await import("./controlsStore");

describe("P155-X · 滑条卡尺寸与矮档", () => {
  it("滑条默认 2×2：1 行(60px)装不下 ~85px 的内容，新卡一出生就得够高", () => {
    expect(defaultCardSize("slider"), "滑条卡默认又回到 2×1 了（内容会被裁）").toEqual({ w: 2, h: 2 });
    // 顺手钉住邻居：只改滑条，别把按钮/键盘的尺寸一起动了
    expect(defaultCardSize("button")).toEqual({ w: 1, h: 1 });
    expect(defaultCardSize("keypad")).toEqual({ w: 3, h: 3 });
  });

  it("尺寸表只有一处出处：defaultCard 不再抄第二份三元表", () => {
    expect(STORE, "defaultCard 又抄了一份尺寸表").toContain("const size = defaultCardSize(type);");
    expect(/const size\s*=\s*type === "joystick"/.test(STORE), "旧的三元表回来了").toBe(false);
  });

  it("已存的 2×1 卡：矮档 container 条件收脚注（值+滑杆保留）", () => {
    expect(CSS, "卡片没建 container（条件查询无从判高）").toContain("container-type: size");
    expect(CSS).toMatch(/@container \(max-height: 78px\) \{[\s\S]*?\.ctl-card:has\(\.ctl-slider\) \.ctl-foot \{ display: none; \}/);
  });
});
