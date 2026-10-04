/**
 * P150 · 面表的闭合判据。
 *
 * 这张表的价值不在"列得全"，在**列了就要能核对**：探针必须是运行时真的渲染过的类名
 * （`.tools/class-census.json` 的第四方，与死规则门共用同一本账）。
 * 本仓 CSS 里有规则却没人渲染的类名不少（`.tb-menu`、`.seg` 就是两枚），拿它们当探针，
 * 这条判据会永远绿——那正是 P147 §1 那个 98.57% 假绿的形状。
 */
import { describe, expect, it } from "vitest";
import { ABSENT_FACES, THEME_FACES } from "./themeFaces";

const fsSpec = "node:fs";
const { readFileSync, existsSync } = (await import(fsSpec)) as {
  readFileSync: (p: string | URL, e?: string) => string;
  existsSync: (p: string | URL) => boolean;
};
const censusPath = new URL("../../.tools/class-census.json", import.meta.url);
const rendered = new Set<string>(
  existsSync(censusPath) ? (JSON.parse(readFileSync(censusPath, "utf8")).rendered as string[]) : [],
);

describe("P150 主题面表", () => {
  it("反空断言：普查账本在且非空（不然『探针渲染过』这条判据就是永真）", () => {
    expect(existsSync(censusPath), ".tools/class-census.json 不在——先跑 node .tools/class-census.mjs").toBe(true);
    expect(rendered.size, "普查里一个渲染过的类名都没有，判据失去对象").toBeGreaterThan(100);
  });

  it("每一行都有 id/zh/via/states，且 id 不重复", () => {
    const ids = new Set<string>();
    for (const f of THEME_FACES) {
      expect(f.id, "有行没 id").toBeTruthy();
      expect(f.zh.length, `${f.id} 没有中文名（这张表是给人对的）`).toBeGreaterThan(0);
      expect(f.via.length, `${f.id} 没说主题怎么够得着它`).toBeGreaterThan(0);
      expect(Array.isArray(f.states), `${f.id} 的状态栏不是一档一档列出来的`).toBe(true);
      expect(ids.has(f.id), `id 重复：${f.id}`).toBe(false);
      ids.add(f.id);
    }
  });

  it("用户列的 19 区 + 15 控件全部在册（少一行就是漏了一面没登记）", () => {
    expect(THEME_FACES.length, `当前 ${THEME_FACES.length} 行`).toBeGreaterThanOrEqual(34);
    const areas = THEME_FACES.filter((f) => !["button", "iconButton", "switch", "input", "select", "picker", "checkbox",
      "radio", "slider", "progress", "segmented", "pagination", "tag", "badge", "layers"].includes(f.id));
    expect(areas.length, "区那一组不足 19 行").toBeGreaterThanOrEqual(19);
  });

  it("不存在的那几面必须写清代替（留空等于把缺口蒙过去）", () => {
    const absent = THEME_FACES.filter((f) => !f.exists);
    expect(absent.map((f) => f.id).sort()).toEqual([...ABSENT_FACES].sort());
    for (const f of absent) {
      expect(f.instead, `${f.id} 说不存在却没说代替是什么`).toBeTruthy();
      expect(f.instead!.length, `${f.id} 的代替栏太短，等于没写`).toBeGreaterThan(4);
    }
  });

  it("存在的每一面都有探针，且探针是运行时真渲染过的类名（除非明确标了未核）", () => {
    const unverified: string[] = [];
    for (const f of THEME_FACES.filter((x) => x.exists)) {
      expect(f.probe, `${f.id} 存在却没有探针`).toBeTruthy();
      if (f.probeUnverified) { unverified.push(f.id); continue; }
      expect(rendered.has(f.probe!), `${f.id} 的探针 .${f.probe} 在普查 14 面里没渲染过——它是不是又是 .tb-menu 那种死钩子？`).toBe(true);
    }
    // 未核的那几面必须少而有名有姓（多了说明普查面表该扩了，而不是判据可以松）
    expect(unverified.length, `标了未核的面太多：${unverified.join("/")}`).toBeLessThanOrEqual(8);
    for (const id of unverified) {
      const f = THEME_FACES.find((x) => x.id === id)!;
      expect(f.note, `${id} 标了未核却没写为什么（瞬态？面表没跑过？）`).toBeTruthy();
    }
  });

  it("只能点名的那些面被数出来（规矩 M1：每一条点名都是未来主题的债）", () => {
    const nameOnly = THEME_FACES.filter((f) => f.exists && f.via.length === 1 && f.via[0] === "name");
    // 今天诚实的读数：开关 / 复选 / 单选 / 滑块 / 进度条代替 / 分页代替 / 标签
    expect(nameOnly.length, `只剩 ${nameOnly.length} 面只能点名——比上次少了就把台账数字改小`).toBeLessThanOrEqual(8);
    const slotted = THEME_FACES.filter((f) => f.via.includes("slot"));
    expect(slotted.length, "走槽的面太少，说明槽没接上真实控件").toBeGreaterThanOrEqual(6);
  });
});
