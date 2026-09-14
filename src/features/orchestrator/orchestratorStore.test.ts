/**
 * P74-4a 编排器仓库单测：规范化红线 / 序列转换器 / 块树操作 / 自嵌套守卫。
 * Node 环境无 localStorage：store 的 load/persist 均有 try-catch 守卫。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  addBlock,
  addEvent,
  addGroup,
  addVar,
  atGroupCap,
  convertSuite,
  duplicateBlock,
  duplicateGroup,
  flush,
  getPersistVars,
  getSnapshot,
  importJSON,
  importSuite,
  locate,
  makeBlock,
  makeEvent,
  moveBlock,
  moveEventTo,
  moveGroup,
  normalizeDoc,
  removeBlock,
  removeEvent,
  removeGroup,
  removeVar,
  setMasterOn,
  setVarsProvider,
  updateBlock,
  updateGroup,
  updateVar,
} from "./orchestratorStore";
import { setOperatorLocked } from "../operator/lock";
import { ORCH_LIMITS, type FlowNode } from "./types";
import type { Suite } from "../sequencer/types";

describe("normalizeDoc", () => {
  it("脏数据钳位：未知块丢弃、数值钳位、变量去重", () => {
    const doc = normalizeDoc({
      version: 1,
      title: 123,
      vars: [
        { name: "a", type: "number", def: "x", persist: true },
        { name: "a", type: "number", def: 1 }, // 重名去重
        { name: "9bad", type: "number", def: 0 }, // 非法名丢弃
        { name: "b", type: "bool", def: 1 },
      ],
      groups: [
        {
          id: "g1",
          name: "组",
          enabled: "yes",
          cooldownMs: -5,
          queuePolicy: "bogus",
          events: [{ kind: "timer", intervalMs: 1 }, { kind: "aliens" }],
          children: [
            { kind: "wait", ms: 999999 },
            { kind: "nope" },
            { kind: "send", payload: { type: "hex", text: "AA BB" } },
          ],
        },
      ],
      settings: { masterOn: "on" },
    });
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("自动编排"); // 非字符串回默认
    expect(doc!.vars.map((v) => v.name)).toEqual(["a", "b"]);
    expect(doc!.vars[0].def).toBe(0); // number 类型非法 def 回 0
    expect(doc!.vars[1].def).toBe(true); // bool 1 → true
    const g = doc!.groups[0];
    expect(g.enabled).toBe(true);
    expect(g.cooldownMs).toBe(0);
    expect(g.queuePolicy).toBe("dropNew");
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ kind: "timer", intervalMs: 50 }); // 下限 50
    expect(g.children).toHaveLength(2);
    expect(g.children[0]).toMatchObject({ kind: "wait", ms: ORCH_LIMITS.waitMaxMs });
    const send = g.children[1] as { onFail: string };
    expect(send.onFail).toBe("abort"); // onFail 补全
    expect(doc!.settings.masterOn).toBe(false); // 总开关严格：非布尔回默认 false
  });

  it("缺 groups 数组 → null；嵌套深度超限丢弃", () => {
    expect(normalizeDoc({ foo: 1 })).toBeNull();
    const deep = (d: number): unknown =>
      d === 0 ? { kind: "wait", ms: 10 } : { kind: "loop", mode: "count", count: 1, intervalMs: 0, body: [deep(d - 1)] };
    const doc = normalizeDoc({ groups: [{ id: "g", children: [deep(8)] }] });
    expect(doc).not.toBeNull();
    // nodeDepthMax=4：第 4 层之后的容器被丢弃，最内 wait 不存在
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"ms":10');
  });
});

describe("块树操作", () => {
  it("addBlock 进容器子流 / updateBlock / removeBlock / locate 全树定位", () => {
    expect(importJSON(JSON.stringify({ groups: [{ id: "g1", children: [{ kind: "loop", mode: "count", count: 1, intervalMs: 0, body: [] }] }] }))).toBeNull();
    const loopId = (getSnapshot().doc.groups[0].children[0] as { id: string }).id;
    const w = makeBlock("wait");
    expect(addBlock("g1", null, 0, w)).toBe(w.id);
    expect(locate("g1", w.id)).toMatchObject({ parentId: null, index: 0 });
    // 移入 loop 体
    expect(moveBlock("g1", w.id, loopId, 0)).toBe(true);
    expect(locate("g1", w.id)).toMatchObject({ parentId: loopId, index: 0 });
    updateBlock("g1", w.id, { ms: 250 });
    const g2 = normalizeDoc(JSON.parse(JSON.stringify(getSnapshot().doc)))!;
    const inner = ((g2.groups[0].children[0] as { body: { ms: number }[] }).body)[0];
    expect(inner.ms).toBe(250);
    removeBlock("g1", w.id);
    expect(locate("g1", w.id)).toBeNull();
  });

  it("moveBlock 自嵌套守卫：容器不能移进自己的子树", () => {
    expect(importJSON(JSON.stringify({ groups: [{ id: "g1", children: [] }] }))).toBeNull();
    const outer = makeBlock("if");
    addBlock("g1", null, null, outer);
    const inner = makeBlock("loop");
    addBlock("g1", outer.id, null, inner); // 进 if.then
    const deep = makeBlock("wait");
    addBlock("g1", inner.id, null, deep);
    // loop → 自身子树非法；wait 移到组顶层合法
    expect(moveBlock("g1", inner.id, inner.id, 0)).toBe(false);
    expect(moveBlock("g1", deep.id, null, 0)).toBe(true);
    expect(locate("g1", deep.id)).toMatchObject({ parentId: null, index: 0 });
  });
});

describe("序列转换器 convertSuite", () => {
  it("send/wait/waitForFrame/assertVar/note/group/onFrame 触发映射", () => {
    const suite: Suite = {
      id: "s1",
      name: "巡检",
      steps: [
        { id: "s1", kind: "send", enabled: true, payload: { type: "hex", text: "AA" }, note: "查询" },
        { id: "s2", kind: "note", enabled: true, text: "等待响应" },
        { id: "s3", kind: "waitForFrame", enabled: true, match: { by: "tpl", tplId: "t1" }, timeoutMs: 2000 },
        { id: "s4", kind: "assertVar", enabled: true, varName: "v", op: "gt", expected: 5 },
        { id: "s5", kind: "assertVar", enabled: true, varName: "v", op: "changed" },
        {
          id: "s6",
          kind: "group",
          enabled: true,
          name: "子流程",
          repeats: 3,
          onFailure: "continue",
          children: [{ id: "s7", kind: "wait", enabled: true, ms: 100 }],
        },
      ],
      trigger: { mode: "onFrame", match: { by: "raw", hex: "55" }, cooldownMs: 800 },
      failFast: true,
    };
    const g = convertSuite(suite);
    expect(g.enabled).toBe(false); // 导入后未启用（红线）
    expect(g.name).toBe("巡检");
    expect(g.cooldownMs).toBe(800);
    expect(g.events).toEqual([{ id: expect.any(String), kind: "frame", match: { by: "raw", hex: "55" }, stride: 1 }]);

    const [send, waitFrame, ifBlock, nested] = g.children;
    expect(send).toMatchObject({ kind: "send", note: "查询", onFail: "abort" }); // failFast → abort
    expect(waitFrame).toMatchObject({ kind: "waitFrame", note: "等待响应", timeoutMs: 2000 }); // note 顺延
    expect((ifBlock as { kind: string; conds: unknown[]; els: unknown[] }).kind).toBe("if");
    expect((ifBlock as { conds: unknown[] }).conds[0]).toMatchObject({ k: "var", name: "v", op: "gt", value: 5 });
    expect(((ifBlock as { els: { kind: string }[] }).els)[0].kind).toBe("abort");
    // changed 断言无对应块 → 降级为备注；尾注无后续块则丢弃（转换器语义）
    expect((ifBlock as { note?: string }).note).toBeUndefined();
    expect(nested).toMatchObject({ kind: "group", name: "子流程" });
    const loop = (nested as { children: FlowNode[] }).children[0];
    expect(loop).toMatchObject({ kind: "loop", mode: "count", count: 3 });
    expect(((loop as { body: { onFail: string }[] }).body)[0].onFail).toBe("continue"); // onFailure 承接
  });

  it("assertVar 引用变量期望 → 表达式条件", () => {
    const g = convertSuite({
      id: "s2",
      name: "x",
      steps: [{ id: "a", kind: "assertVar", enabled: true, varName: "v", op: "eq", expected: { var: "ref" } }],
      trigger: { mode: "manual" },
      failFast: true,
    });
    expect((g.children[0] as { conds: { k: string; src: string }[] }).conds[0]).toEqual({
      k: "expr",
      src: "v == ref",
    });
  });
});

describe("P74c：持久值区 / 组设置 / 容量红线", () => {
  it("持久变量值区：落盘快照跟随 provider，删项后自净（A1 写半边）", () => {
    expect(importJSON(JSON.stringify({ groups: [] }))).toBeNull();
    setVarsProvider(() => ({ p: 42, s: "abc" }));
    flush();
    expect(getPersistVars()).toEqual({ p: 42, s: "abc" });

    // 变量被删 / 取消「持久」→ provider 不再返回 → 落盘区自净
    setVarsProvider(() => ({ p: 42 }));
    flush();
    expect(getPersistVars()).toEqual({ p: 42 });

    setVarsProvider(() => ({}));
    flush();
    expect(getPersistVars()).toEqual({});

    setVarsProvider(null); // 复位，避免污染其它用例
  });

  it("updateGroup 支持备注与静默期钳位（A3）", () => {
    expect(importJSON(JSON.stringify({ groups: [{ id: "g1", children: [] }] }))).toBeNull();
    updateGroup("g1", { cooldownMs: 2000, queuePolicy: "dropOld", note: "上电自检" });
    const g = getSnapshot().doc.groups[0];
    expect(g.cooldownMs).toBe(2000);
    expect(g.queuePolicy).toBe("dropOld");
    expect(g.note).toBe("上电自检");
    updateGroup("g1", { cooldownMs: 99999999 }); // 超上限钳位
    expect(getSnapshot().doc.groups[0].cooldownMs).toBe(600000);
    updateGroup("g1", { note: "" }); // 空备注 → undefined（不进 JSON）
    expect(getSnapshot().doc.groups[0].note).toBeUndefined();
  });

  it("组数红线写入侧拦截：达 groupCap 后 addGroup/duplicateGroup 返回 null（A4）", () => {
    expect(importJSON(JSON.stringify({ groups: [] }))).toBeNull();
    for (let i = 0; i < ORCH_LIMITS.groupCap; i++) expect(addGroup()).toBeTruthy();
    expect(atGroupCap()).toBe(true);
    expect(addGroup()).toBeNull();
    expect(duplicateGroup(getSnapshot().doc.groups[0].id)).toBeNull();
    expect(getSnapshot().doc.groups).toHaveLength(ORCH_LIMITS.groupCap);
  });
});

describe("P74c C1：Operator 只读边界", () => {
  const seed = () =>
    expect(
      importJSON(
        JSON.stringify({
          vars: [{ name: "v", type: "number", def: 0 }],
          groups: [{ id: "g1", children: [{ id: "b1", kind: "wait", ms: 100 }] }],
        }),
      ),
    ).toBeNull();

  afterEach(() => setOperatorLocked(false));

  it("锁定时：配置类改动全部被拒（组/事件/块/变量/导入）", () => {
    seed();
    const before = JSON.stringify(getSnapshot().doc);
    setOperatorLocked(true);

    expect(addGroup()).toBeNull();
    expect(atGroupCap()).toBe(false); // 与容量无关，纯粹是锁
    removeGroup("g1");
    updateGroup("g1", { name: "改名" });
    moveGroup("g1", 1);
    expect(duplicateGroup("g1")).toBeNull();
    addEvent("g1", makeEvent("timer"));
    removeEvent("g1", "nope");
    expect(moveEventTo("g1", "nope", 0)).toBe(false);
    expect(addBlock("g1", null, null, makeBlock("wait"))).toBeNull();
    updateBlock("g1", "b1", { ms: 999 });
    removeBlock("g1", "b1");
    expect(duplicateBlock("g1", "b1")).toBeNull();
    expect(moveBlock("g1", "b1", null, 0)).toBe(false);
    expect(addVar({ name: "n", type: "number", def: 1, persist: false })).toBe(false);
    updateVar("v", { def: 9 });
    removeVar("v");
    expect(importSuite({ id: "s1", name: "x", steps: [{ id: "a", kind: "wait", enabled: true, ms: 1 }], trigger: { mode: "manual" }, failFast: true })).toBeNull();
    expect(importJSON(JSON.stringify({ groups: [] }))).toBeNull();

    expect(JSON.stringify(getSnapshot().doc)).toBe(before); // 文档零变化
  });

  it("锁定时：运行类与视图类放行（总开关 / 折叠）", () => {
    seed();
    setOperatorLocked(true);
    setMasterOn(true);
    expect(getSnapshot().doc.settings.masterOn).toBe(true);
    updateGroup("g1", { collapsed: true });
    expect(getSnapshot().doc.groups[0].collapsed).toBe(true);
  });

  it("解锁后改动恢复生效（只读是状态，不是永久降级）", () => {
    seed();
    setOperatorLocked(true);
    expect(addGroup()).toBeNull();
    setOperatorLocked(false);
    expect(addGroup()).toBeTruthy();
  });
});
