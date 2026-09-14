import { describe, expect, it } from "vitest";
import { AI_BLOCK_KINDS, AI_EVENT_KINDS, buildAiBlock, buildAiEvent, pendingHints } from "./orchAiBuild";

describe("orchAiBuild 类型面", () => {
  it("块/事件类型清单与工厂对齐（23 块 / 12 事件，B4c +10 / B4d +5）", () => {
    expect(AI_BLOCK_KINDS).toHaveLength(23);
    expect(AI_EVENT_KINDS).toHaveLength(12);
    expect(new Set(AI_BLOCK_KINDS).size).toBe(23);
    expect(new Set(AI_EVENT_KINDS).size).toBe(12);
  });
  it("未知类型抛错且列出可选值", () => {
    expect(() => buildAiBlock("nope", {})).toThrow(/未知块类型/);
    expect(() => buildAiEvent("nope", {})).toThrow(/未知事件类型/);
    expect(() => buildAiBlock("nope", {})).toThrow(/send/);
  });
});

describe("buildAiBlock", () => {
  it("send：默认 hex，mode=ascii 切文本模式", () => {
    const hex = buildAiBlock("send", { text: "AA 55" });
    expect(hex.node).toMatchObject({ kind: "send", payload: { type: "hex", text: "AA 55" } });
    expect(hex.applied).toContain("text");
    const asc = buildAiBlock("send", { sendMode: "ascii", text: "hello\r\n" });
    expect(asc.node).toMatchObject({ kind: "send", payload: { type: "ascii", text: "hello\r\n" } });
  });
  it("send：mode 非法时按 hex 兜底（不静默丢弃 text）", () => {
    const r = buildAiBlock("send", { sendMode: "rtu", text: "01 03" });
    expect(r.node).toMatchObject({ payload: { type: "hex", text: "01 03" } });
  });
  it("wait：ms 钳到 10~60000；未给则保留工厂默认 1000", () => {
    expect(buildAiBlock("wait", { ms: 1 }).node).toMatchObject({ ms: 10 });
    expect(buildAiBlock("wait", { ms: 9e9 }).node).toMatchObject({ ms: 60_000 });
    expect(buildAiBlock("wait", {}).node).toMatchObject({ ms: 1000 });
    // 非有限数被忽略
    expect(buildAiBlock("wait", { ms: Number.NaN }).node).toMatchObject({ ms: 1000 });
  });
  it("setVar：只收标量常量，对象/数组拒绝", () => {
    const ok = buildAiBlock("setVar", { name: "target", value: 42 });
    expect(ok.node).toMatchObject({ kind: "setVar", name: "target", from: { k: "const", value: 42 } });
    const bad = buildAiBlock("setVar", { name: "target", value: { a: 1 } });
    expect(bad.node).toMatchObject({ from: { k: "const", value: 0 } }); // 工厂默认
    expect(bad.applied).not.toContain("value");
  });
  it("waitFrame：raw 帧头 + 超时 + ignoreFail", () => {
    const r = buildAiBlock("waitFrame", { hex: "55 59", timeoutMs: 500, ignoreFail: true });
    expect(r.node).toMatchObject({
      kind: "waitFrame",
      match: { by: "raw", hex: "55 59" },
      timeoutMs: 500,
      ignoreFail: true,
    });
  });
  it("waitFrame/事件：tplId+fieldName 走近字段匹配，expectedVar 走变量比", () => {
    const r = buildAiBlock("waitFrame", {
      tplId: "t1",
      fieldName: "roll",
      op: "gt",
      expectedVar: "limit",
    });
    expect(r.node).toMatchObject({
      match: { by: "field", tplId: "t1", fieldName: "roll", op: "gt", expected: { var: "limit" } },
    });
    const lit = buildAiBlock("waitFrame", { tplId: "t1", fieldName: "roll", expected: 20 });
    expect(lit.node).toMatchObject({ match: { expected: 20 } });
  });
  it("loop：只收 count/intervalMs 标量，while 条件留给 UI", () => {
    const r = buildAiBlock("loop", { loopMode: "count", count: 9999, intervalMs: -5 });
    expect(r.node).toMatchObject({ kind: "loop", mode: "count", count: 1000, intervalMs: 0 });
  });
  it("onFail 只落在执行块上（group 无此字段不报错）", () => {
    const exec = buildAiBlock("toast", { level: "warn", text: "x", onFail: "continue" });
    expect(exec.node).toMatchObject({ level: "warn", onFail: "continue" });
    const grp = buildAiBlock("group", { groupName: "子流程", onFail: "continue" });
    expect(grp.node).toMatchObject({ kind: "group", name: "子流程" });
    expect(grp.applied).not.toContain("onFail");
  });
  it("块 id 唯一（连造两次不同 id）", () => {
    expect(buildAiBlock("wait", {}).node.id).not.toBe(buildAiBlock("wait", {}).node.id);
  });
});

describe("buildAiEvent", () => {
  it("timer：intervalMs 钳到 50~3600000", () => {
    expect(buildAiEvent("timer", { intervalMs: 1 }).node).toMatchObject({ intervalMs: 50 });
    expect(buildAiEvent("timer", { intervalMs: 1e9 }).node).toMatchObject({ intervalMs: 3_600_000 });
    expect(buildAiEvent("timer", {}).node).toMatchObject({ intervalMs: 5000 });
  });
  it("threshold：通道/方向/边沿/阈值/去抖全收", () => {
    const r = buildAiEvent("threshold", {
      chId: "c1",
      op: "below",
      edge: "exit",
      value: -3.5,
      debounceMs: 9e5,
    });
    expect(r.node).toMatchObject({
      kind: "threshold",
      chId: "c1",
      op: "below",
      edge: "exit",
      value: -3.5,
      debounceMs: 60_000,
    });
  });
  it("frame：hex + stride 钳位", () => {
    const r = buildAiEvent("frame", { hex: "AA 55", stride: 0 });
    expect(r.node).toMatchObject({ kind: "frame", match: { by: "raw", hex: "AA 55" }, stride: 1 });
    expect(buildAiEvent("frame", { stride: 999999 }).node).toMatchObject({ stride: 1000 });
  });
  it("session/sentinel/varChanged/manual 各取本类参数", () => {
    expect(buildAiEvent("session", { phase: "stop" }).node).toMatchObject({ phase: "stop" });
    expect(buildAiEvent("sentinel", { level: "crit" }).node).toMatchObject({ level: "crit" });
    expect(buildAiEvent("varChanged", { varName: "v1" }).node).toMatchObject({ varName: "v1" });
    expect(buildAiEvent("manual", {}).node).toMatchObject({ kind: "manual" });
    // 非法 level 被忽略，保留默认
    expect(buildAiEvent("sentinel", { level: "fatal" }).node).toMatchObject({ level: "warn" });
  });
});

describe("pendingHints 半成品提醒", () => {
  it("空发送内容 / 空帧头 / 未选套件与变量 都提示", () => {
    expect(pendingHints(buildAiBlock("send", {}).node)).toContain("发送内容为空");
    expect(pendingHints(buildAiBlock("waitFrame", {}).node)).toContain("等帧未设帧头");
    expect(pendingHints(buildAiBlock("runSuite", {}).node)).toContain("未选序列套件");
    expect(pendingHints(buildAiBlock("runGroup", {}).node)).toContain("未选被调用组");
    expect(pendingHints(buildAiBlock("setVar", {}).node)).toContain("未选目标变量");
    expect(pendingHints(buildAiEvent("threshold", {}).node)).toContain("阈值事件未选通道");
    expect(pendingHints(buildAiEvent("varChanged", {}).node)).toContain("变量事件未选变量");
    expect(pendingHints(buildAiEvent("frame", {}).node)).toContain(
      "帧命中事件无匹配条件（会命中所有帧）",
    );
  });
  it("参数齐全时无提示", () => {
    expect(pendingHints(buildAiBlock("send", { text: "AA" }).node)).toEqual([]);
    expect(pendingHints(buildAiEvent("frame", { hex: "AA 55" }).node)).toEqual([]);
    expect(pendingHints(buildAiBlock("wait", { ms: 100 }).node)).toEqual([]);
  });
});
