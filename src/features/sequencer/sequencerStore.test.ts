import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 序列仓库测试（T1）：CRUD、持久化 round-trip、导入规范化。
 * node 环境没有 localStorage，用内存 stub；load 路径用 resetModules + 动态导入验证。
 */

const mem = new Map<string, string>();
const lsStub = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

beforeEach(() => {
  mem.clear();
  vi.stubGlobal("localStorage", lsStub);
});

async function fresh() {
  vi.resetModules();
  return await import("./sequencerStore");
}

describe("CRUD", () => {
  it("新增/重命名/删除/查询", async () => {
    const st = await fresh();
    const s = st.addSuite("冒烟测试");
    expect(st.getSnapshot().suites).toHaveLength(1);
    st.renameSuite(s.id, "  改名  ");
    expect(st.getSuite(s.id)?.name).toBe("改名");
    st.setFailFast(s.id, false);
    expect(st.getSuite(s.id)?.failFast).toBe(false);
    st.removeSuite(s.id);
    expect(st.getSnapshot().suites).toHaveLength(0);
  });

  it("setSteps / setTrigger 替换", async () => {
    const st = await fresh();
    const s = st.addSuite("t");
    st.setSteps(s.id, [{ id: "x", kind: "wait", enabled: true, ms: 50 }]);
    st.setTrigger(s.id, { mode: "onFrame", match: { by: "raw", hex: "aa" }, cooldownMs: 700 });
    const got = st.getSuite(s.id);
    expect(got?.steps[0].kind).toBe("wait");
    expect(got?.trigger).toEqual({ mode: "onFrame", match: { by: "raw", hex: "aa" }, cooldownMs: 700 });
  });
});

describe("持久化", () => {
  it("flush 落盘 + 动态导入时恢复", async () => {
    const st = await fresh();
    const s = st.addSuite("要恢复的");
    st.setSteps(s.id, [{ id: "w", kind: "wait", enabled: true, ms: 123 }]);
    st.flush();
    expect(mem.get("vs.sequencer")).toBeTruthy();

    const st2 = await fresh();
    expect(st2.getSnapshot().suites).toHaveLength(1);
    expect(st2.getSnapshot().suites[0].name).toBe("要恢复的");
    expect(st2.getSnapshot().suites[0].steps[0]).toMatchObject({ kind: "wait", ms: 123 });
  });

  it("损坏 JSON 静默清空", async () => {
    mem.set("vs.sequencer", "{oops");
    const st = await fresh();
    expect(st.getSnapshot().suites).toHaveLength(0);
    expect(mem.has("vs.sequencer")).toBe(false);
  });
});

describe("导入规范化", () => {
  it("合法导入 + id 冲突重新生成", async () => {
    const st = await fresh();
    const src = {
      id: "same",
      name: "导入件",
      failFast: false,
      steps: [{ id: "a", kind: "send", enabled: true, payload: { type: "hex", text: "aa" } }],
    };
    expect(st.importSuites(JSON.stringify(src))).toBe(1);
    expect(st.importSuites(JSON.stringify(src))).toBe(1); // 第二次 id 冲突重新生成
    const suites = st.getSnapshot().suites;
    expect(suites).toHaveLength(2);
    expect(suites[0].id).not.toBe(suites[1].id);
    expect(suites[0].failFast).toBe(false);
  });

  it("未知 kind / 损坏结构丢弃，合法部分保留", async () => {
    const st = await fresh();
    const src = [
      { name: "好件", steps: [{ kind: "wait", ms: 5 }] },
      { name: "坏步骤件", steps: [{ kind: "alien" }, null, { kind: "send", payload: null }] },
      { noName: true },
      "not-an-object",
    ];
    expect(st.importSuites(JSON.stringify(src))).toBe(2);
    const bad = st.getSnapshot().suites.find((s) => s.name === "坏步骤件");
    expect(bad?.steps).toHaveLength(0);
  });

  it("wait 数值越界收敛；group 超深度丢弃；factory 载荷保留", async () => {
    const st = await fresh();
    const src = {
      name: "规范",
      steps: [
        { kind: "wait", ms: 999999 },
        {
          kind: "group",
          name: "g",
          repeats: 0,
          children: [
            { kind: "group", children: [{ kind: "group", children: [{ kind: "group", children: [{ kind: "group", children: [] }] }] }] },
          ],
        },
        { kind: "send", payload: { type: "factory", spec: { fc: 3 } } },
      ],
    };
    expect(st.importSuites(JSON.stringify(src))).toBe(1);
    const steps = st.getSnapshot().suites[0].steps;
    expect(steps[0]).toMatchObject({ kind: "wait", ms: 60000 });
    expect(steps[1]).toMatchObject({ kind: "group", repeats: 1 });
    // 深度 4 层组：最内层（第 5 层）被丢
    const g1 = steps[1] as { children: unknown[] };
    const g2 = g1.children[0] as { children: unknown[] };
    const g3 = g2.children[0] as { children: unknown[] };
    const g4 = g3.children[0] as { children: unknown[] };
    expect(g4.children).toHaveLength(0);
    expect(steps[2]).toMatchObject({ kind: "send", payload: { type: "factory" } });
  });

  it("ascii 载荷导入规范化：与 hex 同语义（空文本保留，运行时判 fail）", async () => {
    const st = await fresh();
    const src = {
      name: "ascii 件",
      steps: [
        { kind: "send", payload: { type: "ascii", text: "hello\r\n" } },
        { kind: "send", payload: { type: "ascii", text: "" } },
      ],
    };
    expect(st.importSuites(JSON.stringify(src))).toBe(1);
    const steps = st.getSnapshot().suites[0].steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ kind: "send", payload: { type: "ascii", text: "hello\r\n" } });
    expect(steps[1]).toMatchObject({ kind: "send", payload: { type: "ascii", text: "" } });
  });

  it("exportSuite 输出可再导入", async () => {
    const st = await fresh();
    const s = st.addSuite("往返");
    st.setSteps(s.id, [{ id: "n", kind: "note", enabled: true, text: "你好" }]);
    const json = st.exportSuite(s.id);
    expect(json).toBeTruthy();
    st.removeSuite(s.id);
    expect(st.importSuites(json as string)).toBe(1);
    expect(st.getSnapshot().suites[0].steps[0]).toMatchObject({ kind: "note", text: "你好" });
  });
});

describe("步骤树操作", () => {
  async function setup() {
    const st = await fresh();
    return { st, s: st.addSuite("树操作") };
  }
  const idsOf = (st: Awaited<ReturnType<typeof setup>>["st"], sid: string) =>
    (st.getSuite(sid) as { steps: { id: string; kind: string }[] }).steps.map((x) => x.id);

  it("addStep：根/组内追加，非组父拒绝", async () => {
    const { st, s } = await setup();
    st.addStep(s.id, null, "wait");
    const grp = st.addStep(s.id, null, "group");
    expect(grp?.kind).toBe("group");
    expect(st.addStep(s.id, grp!.id, "send")).toBeTruthy();
    expect(st.addStep(s.id, "ghost", "wait")).toBeNull();
    const suite = st.getSuite(s.id)!;
    expect(suite.steps).toHaveLength(2);
    expect((suite.steps[1] as { children: unknown[] }).children).toHaveLength(1);
  });

  it("updateStep 深层修改；removeStep 摘除", async () => {
    const { st, s } = await setup();
    const grp = st.addStep(s.id, null, "group")!;
    const child = st.addStep(s.id, grp.id, "wait")!;
    st.updateStep(s.id, child.id, (x) => (x.kind === "wait" ? { ...x, ms: 777 } : x));
    st.updateStep(s.id, grp.id, (x) => (x.kind === "group" ? { ...x, repeats: 5 } : x));
    const suite = st.getSuite(s.id)!;
    expect((suite.steps[0] as { repeats: number }).repeats).toBe(5);
    expect((suite.steps[0] as { children: { ms: number }[] }).children[0].ms).toBe(777);
    st.removeStep(s.id, child.id);
    expect((st.getSuite(s.id)!.steps[0] as { children: unknown[] }).children).toHaveLength(0);
  });

  it("moveStep：同列表下移要补偿摘除偏移，上移直接插", async () => {
    const { st, s } = await setup();
    st.addStep(s.id, null, "wait");
    st.addStep(s.id, null, "wait");
    st.addStep(s.id, null, "wait");
    const [a, b, c] = idsOf(st, s.id);
    expect(st.moveStep(s.id, a, null, 3)).toBe(true); // [a,b,c] → [b,c,a]
    expect(idsOf(st, s.id)).toEqual([b, c, a]);
    expect(st.moveStep(s.id, a, null, 0)).toBe(true); // 移回头部
    expect(idsOf(st, s.id)).toEqual([a, b, c]);
    expect(st.moveStep(s.id, b, null, 1)).toBe(true); // 原地不动
    expect(idsOf(st, s.id)).toEqual([a, b, c]);
  });

  it("moveStep：移入组内；移进自己/自己的子树拒绝；超 4 层深度拒绝", async () => {
    const { st, s } = await setup();
    const grp = st.addStep(s.id, null, "group")!;
    st.addStep(s.id, null, "wait");
    const outerWait = st.getSuite(s.id)!.steps[1];
    expect(st.moveStep(s.id, outerWait.id, grp.id, 0)).toBe(true);
    expect((st.getSuite(s.id)!.steps[0] as { children: unknown[] }).children).toHaveLength(1);
    // 移进自己
    expect(st.moveStep(s.id, grp.id, grp.id, 0)).toBe(false);
    // 造 4 层链 grp>g2>g3>g4；把 grp（自身 4 层）移到 g4 内（插入点组深度 4）→ 8 > 4 拒绝
    let cur = grp;
    for (let i = 0; i < 3; i++) cur = st.addStep(s.id, cur.id, "group")!;
    expect(st.moveStep(s.id, grp.id, cur.id, 0)).toBe(false);
    // 第 5 步不成立：往深度 4 的组里再放一个普通 wait 也是组深度 4 + 0 层 ≤ 4 → 允许
    const w5 = st.addStep(s.id, cur.id, "wait");
    expect(w5).toBeTruthy();
  });

  it("duplicateStep：副本紧随其后，id 全部重新生成", async () => {
    const { st, s } = await setup();
    const grp = st.addStep(s.id, null, "group")!;
    const child = st.addStep(s.id, grp.id, "wait")!;
    expect(st.duplicateStep(s.id, grp.id)).toBe(true);
    const steps = st.getSuite(s.id)!.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0].id).not.toBe(steps[1].id);
    const dup = steps[1] as { children: { id: string }[] };
    expect(dup.children).toHaveLength(1);
    expect(dup.children[0].id).not.toBe(child.id);
  });
});
