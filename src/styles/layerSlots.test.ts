/**
 * P131-B2：层槽表的三条钉。
 *
 * 这张表存在的意义是"z 轴只有一个出处"，所以最该测的不是表里的数（那没人会算错），
 * 而是**它和 theme.css 是不是同一份**：数值只有 CSS 会真的画出来，
 * 而净化器/审计读的是 TS 那份。两边漂一个数，界面上"槽"和"实际层级"就悄悄错开——
 * 表现是主题写了 `var(--z-menu)` 却盖住了对话框，或反过来抬不起来。
 */
import { describe, expect, it } from "vitest";

// src 的 tsconfig 不带 node 类型，所以按本仓既有写法动态取（与 shared/toast.test.ts 同法）
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string | URL, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as unknown as { fileURLToPath: (u: string | URL) => string };
import {
  ALL_LAYERS,
  isUnknownSlot,
  MAX_NAMEABLE_Z,
  NAMEABLE_SLOTS,
  PROTECTED_LAYERS,
  slotCatalogText,
  slotFromZValue,
} from "./layerSlots";

const CSS = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");

describe("层槽表与 theme.css 必须同源", () => {
  it("每一个槽（含保护区）都在 :root 里声明，且数值与表一致", () => {
    for (const [name, value] of Object.entries(ALL_LAYERS)) {
      const re = new RegExp(`--${name}:\\s*${value}\\s*;`);
      expect(re.test(CSS), `theme.css 里 --z-${name} 不是 ${value}（或压根没声明）`).toBe(true);
    }
  });

  it("CSS 里不许冒出表上没有的 --z-*（加档要同时改表，否则净化器不认它）", () => {
    // 表里的键就带 `z-` 前缀（`z-menu`），所以从 `--z-menu` 切掉的是两个连字符
    const declared = [...CSS.matchAll(/(--z-[\w-]+):/g)].map((m) => m[1].slice(2));
    const unknown = declared.filter((n) => !(n in ALL_LAYERS));
    expect(unknown, `表外档位：${unknown.join(", ")}`).toEqual([]);
  });

  /**
   * 保护区只能由槽引用抵达。留一条字面量在高处，等于给"下一个写浮层的人"
   * 留了一个不用查表的抄本——那正是这张表要消灭的东西。
   */
  it("高于可引用档的字面 z-index 一个都不许留在样式表里", () => {
    const bad: string[] = [];
    for (const m of CSS.matchAll(/z-index:\s*(-?\d+)\s*;/g)) {
      const n = Number.parseInt(m[1], 10);
      if (n > MAX_NAMEABLE_Z) {
        const line = CSS.slice(0, m.index).split("\n").length;
        bad.push(`theme.css:${line} z-index:${n}`);
      }
    }
    expect(bad, `这些档必须改写成 var(--z-…)：${bad.join(", ")}`).toEqual([]);
  });
});

describe("槽引用解析", () => {
  it("认得干净槽引用，认不出数字与 calc（它们走另一条判定）", () => {
    expect(slotFromZValue("var(--z-menu)")).toBe("z-menu");
    expect(slotFromZValue(" var( --z-float ) ")).toBe("z-float");
    expect(slotFromZValue("2000")).toBeNull();
    expect(slotFromZValue("calc(var(--z-menu) + 1)")).toBeNull();
    expect(slotFromZValue("var(--z-nope)")).toBeNull();
  });

  it("保护区不算未知（它存在，只是不出槽）；表外才算未知", () => {
    expect(isUnknownSlot("var(--z-toast)")).toBe(false);
    expect(isUnknownSlot("var(--z-nope)")).toBe(true);
    expect(isUnknownSlot("var(--accent)")).toBe(false);
  });

  it("可引用档严格低于保护区，且最高档就是 MAX_NAMEABLE_Z", () => {
    const nameable = Object.values(NAMEABLE_SLOTS);
    const protectedVals = Object.values(PROTECTED_LAYERS);
    expect(Math.max(...nameable)).toBe(MAX_NAMEABLE_Z);
    for (const low of nameable) for (const high of protectedVals) expect(low).toBeLessThan(high);
  });

  it("给模型看的清单从表里派生，不另写一份", () => {
    expect(slotCatalogText()).toBe("--z-raised=100 --z-float=500 --z-popup=999 --z-menu=2000");
  });
});
