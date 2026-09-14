/**
 * 内置模板库测试。
 * 结构合法性（每次 build 全新 id、默认未启用）+ 经 store normalize 往返不失真。
 * P78b：PID 模板为多组 + 变量声明，导入处理器逐组 importPresetGroup + 逐变量 addVar，
 * 这里按同一顺序模拟。
 */
import { describe, expect, it } from "vitest";
import { ORCH_PRESETS } from "./orchestratorPresets";
import * as store from "./orchestratorStore";

describe("ORCH_PRESETS 内置模板（B4e / P78b）", () => {
  it("6 套模板：build 生成合法组数组，组默认未启用，事件/子块非空；vars 均为合法变量名", () => {
    expect(ORCH_PRESETS).toHaveLength(6);
    for (const p of ORCH_PRESETS) {
      const bundle = p.build();
      expect(bundle.groups.length).toBeGreaterThan(0);
      for (const g of bundle.groups) {
        expect(g.kind).toBe("group");
        expect(g.id).toMatch(/^g_/);
        expect(g.enabled).toBe(false); // 红线：导入后未启用，用户检查后手动打开
        expect(g.events.length).toBeGreaterThan(0);
        expect(g.children.length).toBeGreaterThan(0);
        // 全部块带 id
        const walk = (nodes: typeof g.children): void => {
          for (const n of nodes) {
            expect(n.id).toBeTruthy();
            if (n.kind === "group") walk(n.children);
          }
        };
        walk(g.children);
      }
      for (const v of bundle.vars ?? []) {
        expect(v.name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
        expect(["number", "string", "bool"]).toContain(v.type);
      }
    }
  });

  it("每次 build 全新 id（可重复导入）", () => {
    const p = ORCH_PRESETS[0];
    const a = p.build();
    const b = p.build();
    expect(a.groups[0].id).not.toBe(b.groups[0].id);
    expect(a.groups[0].events[0].id).not.toBe(b.groups[0].events[0].id);
  });

  it("模板经 store 导入 → 文档含该组（未启用）", () => {
    const p = ORCH_PRESETS.find((x) => x.id === "alarm-notify")!;
    const id = store.importPresetGroup(p.build().groups[0]);
    expect(id).toBeTruthy();
    const g = store.getSnapshot().doc.groups.find((x) => x.id === id);
    expect(g?.name).toBe("报警通知");
    expect(g?.enabled).toBe(false);
    // 清理：移除测试组
    store.removeGroup(id!);
  });

  it("4 套基础模板逐个 normalize 往返（importJSON 路径）不丢块", () => {
    const base = ORCH_PRESETS.filter((p) => !p.id.startsWith("pid"));
    const groups = base.flatMap((p) => p.build().groups);
    const json = JSON.stringify({ version: 1, title: "t", vars: [], groups, settings: { masterOn: false } });
    expect(store.importJSON(json)).toBeNull();
    const doc = store.getSnapshot().doc;
    expect(doc.groups).toHaveLength(base.length);
    for (const p of base) {
      const g = doc.groups.find((x) => x.name === p.name.zh);
      expect(g).toBeTruthy();
      expect(g!.children.length).toBeGreaterThan(0);
    }
    // 清理
    for (const g of [...doc.groups]) store.removeGroup(g.id);
  });

  it("PID 继电整定：变量齐全 + 表达式只引用已声明变量/now；导入路径组+变量都能落库", () => {
    const p = ORCH_PRESETS.find((x) => x.id === "pid-relay")!;
    const bundle = p.build();
    const declared = new Set((bundle.vars ?? []).map((v) => v.name));
    for (const need of ["SP", "hys", "d", "amp", "tUp", "Tu", "n", "Ku", "Kp", "Ti", "Td", "done"]) {
      expect(declared.has(need)).toBe(true);
    }
    // 收集全部表达式 setVar/from 源，校验只引用声明变量或 now（数字字面量与函数由沙箱管）
    const exprs: string[] = [];
    const walk = (nodes: typeof bundle.groups[number]["children"]): void => {
      for (const n of nodes) {
        if (n.kind === "setVar" && n.from.k === "expr") exprs.push(n.from.src);
        if (n.kind === "if") {
          for (const c of n.conds) if (c.k === "expr") exprs.push(c.src);
          walk(n.then);
          walk(n.els);
        } else if (n.kind === "loop") {
          walk(n.body);
        } else if (n.kind === "group") {
          walk(n.children);
        }
      }
    };
    for (const g of bundle.groups) walk(g.children);
    expect(exprs.length).toBeGreaterThan(5);
    for (const src of exprs) {
      const idents = src.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      for (const id of idents) {
        if (["now"].includes(id)) continue;
        if (["round", "abs", "min", "max", "clamp", "floor", "ceil", "len", "fmt", "if"].includes(id)) continue;
        expect(declared.has(id)).toBe(true);
      }
    }
    // 经真实导入路径：组逐个 importPresetGroup，变量逐个 addVar（重名跳过）
    for (const g of bundle.groups) store.importPresetGroup(g);
    for (const v of bundle.vars ?? []) {
      if (!store.getSnapshot().doc.vars.some((x) => x.name === v.name)) store.addVar(v);
    }
    const doc = store.getSnapshot().doc;
    expect(doc.vars.map((v) => v.name)).toEqual(expect.arrayContaining(["SP", "hys", "tUp", "done"]));
    expect(doc.groups.filter((g) => g.name.includes("整定")).length).toBe(2);
    // 清理
    for (const g of [...doc.groups]) store.removeGroup(g.id);
    for (const v of bundle.vars ?? []) store.removeVar(v.name);
  });

  it("阶跃验证模板依赖整定的 done 变量（单独导入时会自动补声明）", () => {
    const p = ORCH_PRESETS.find((x) => x.id === "pid-verify")!;
    const bundle = p.build();
    expect(bundle.groups).toHaveLength(1);
    expect(bundle.vars?.map((v) => v.name)).toEqual(["stepped"]);
  });
});
