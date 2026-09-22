/**
 * P99a-F1：`appActionSurface` 是 Agent 的 `run_app_action` 与 MCP 的 `run_action` **共用的执行核**。
 *
 * 这批的存在理由就是"别再有两份判定"，所以这里的重点不是重测 `appActions`，而是钉四件事：
 * ① 判定与 `HIGH_ONLY` / `APP_ACTION_KINDS` 两张表**同源**（逐项比对两个集合，不手抄名单——§8-43 的教训）；
 * ② 失败码的**先后顺序**（后台不可代为启动优先于高权限；以前这两条在 `mcpServer` 的 if 链里，顺序是隐式的）；
 * ③ 未知 kind **一次都不下沉**到动作层；
 * ④ 两个前端里不许再长出手写第二份（源码钉）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({
  calls: [] as { kind: string; args: Record<string, unknown>; highPriv: boolean }[],
  result: { ok: true, data: "D" } as { ok: boolean; data?: unknown; err?: string },
}));

vi.mock("../ai/appActions", () => ({
  runAppAction: async (kind: string, args: Record<string, unknown>, o: { highPriv: boolean }) => {
    st.calls.push({ kind, args, highPriv: o.highPriv });
    return st.result;
  },
}));

/** 读源码用（④ 那两条钉要看的是文件文本，不是行为） */
async function readSource(rel: string): Promise<string> {
  const fsSpec = "node:fs";
  const { readFileSync } = (await import(fsSpec)) as unknown as {
    readFileSync: (p: string | URL, enc?: string) => string;
  };
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const surface = () => import("./appActionSurface");

beforeEach(() => {
  st.calls.length = 0;
  st.result = { ok: true, data: "D" };
});

describe("P99a-F1：高权限判定与名单同源", () => {
  it("needsHighPriv 的真值集合恰好等于 HIGH_ONLY；granted 后恒 false", async () => {
    const { APP_ACTION_KINDS, HIGH_ONLY } = await import("../ai/appActionKinds");
    const { needsHighPriv } = await surface();
    const gated = APP_ACTION_KINDS.filter((k) => needsHighPriv(k, false));
    expect([...gated].sort()).toEqual([...HIGH_ONLY].sort());
    expect(APP_ACTION_KINDS.every((k) => !needsHighPriv(k, true))).toBe(true);
    // 表里没登记的动作也走同一条规则（不额外放行也不额外拦）
    expect(needsHighPriv("no_such_action", false)).toBe(false);
  });

  it("isKnownActionKind 与 APP_ACTION_KINDS 逐项一致（不是第二份清单）", async () => {
    const { APP_ACTION_KINDS } = await import("../ai/appActionKinds");
    const { isKnownActionKind } = await surface();
    expect(APP_ACTION_KINDS.every(isKnownActionKind)).toBe(true);
    expect(isKnownActionKind("")).toBe(false);
    expect(isKnownActionKind("Run_App_Action")).toBe(false); // 大小写不放过
    expect(isKnownActionKind("openPanels")).toBe(false); // 前缀命中不算命中
  });
});

describe("P99a-F1：后台不可代为启动的那张表", () => {
  it("编排器 run/enable 与虚拟设备 start 拦；关闭类与别的 kind 不牵连", async () => {
    const { backgroundBlockedOf } = await surface();
    expect(backgroundBlockedOf("orchestrator", { op: "run" })).toBe(true);
    expect(backgroundBlockedOf("orchestrator", { op: "enable" })).toBe(true);
    expect(backgroundBlockedOf("orchestrator", { op: "enable", on: true })).toBe(true);
    expect(backgroundBlockedOf("orchestrator", { op: "enable", on: false })).toBe(false);
    expect(backgroundBlockedOf("orchestrator", { op: "disable" })).toBe(false);
    expect(backgroundBlockedOf("orchestrator", {})).toBe(false);
    expect(backgroundBlockedOf("vdev", { op: "start" })).toBe(true);
    expect(backgroundBlockedOf("vdev", { op: "stop" })).toBe(false);
    // 不相关的 kind 带同样的 op 也不该被误拦（否则等于把闸扩大到全表）
    expect(backgroundBlockedOf("plot3d", { op: "run" })).toBe(false);
    expect(backgroundBlockedOf("toast", { op: "start" })).toBe(false);
  });
});

describe("P99a-F1：执行核的失败码与顺序", () => {
  it("未知 / 空 kind 就地拒，一次都不下沉到动作层", async () => {
    const { runAppActionSurface } = await surface();
    expect(await runAppActionSurface("", {}, { highPriv: true })).toEqual({
      ok: false,
      code: "unknown_action",
      msg: "",
    });
    expect(await runAppActionSurface("nope", {}, { highPriv: true, background: true })).toEqual({
      ok: false,
      code: "unknown_action",
      msg: "nope",
    });
    expect(st.calls).toHaveLength(0);
  });

  it("后台起势优先于高权限判定（顺序以前隐式写在 mcpServer 的 if 链里）", async () => {
    const { runAppActionSurface } = await surface();
    // orchestrator 属 HIGH_ONLY，且 op:run 属"后台不可代为启动"——两条同时命中时报前者
    const r = await runAppActionSurface("orchestrator", { op: "run" }, { highPriv: false, background: true });
    expect(r).toEqual({ ok: false, code: "needs_manual", msg: "" });
    expect(st.calls).toHaveLength(0);
  });

  it("本地面（background 不为 true）不受那条限制：高权限判定照常生效", async () => {
    const { runAppActionSurface } = await surface();
    const r = await runAppActionSurface("orchestrator", { op: "run" }, { highPriv: false });
    expect(r).toEqual({ ok: false, code: "needs_high_priv", msg: "orchestrator" });
    expect(st.calls).toHaveLength(0);
  });

  it("过了判定才下沉，且 highPriv 原样带下去", async () => {
    const { runAppActionSurface } = await surface();
    const r = await runAppActionSurface("openPanel", { id: "plot2d" }, { highPriv: true, background: true });
    expect(r).toEqual({ ok: true, readOnly: false, data: "D" });
    expect(st.calls).toEqual([{ kind: "openPanel", args: { id: "plot2d" }, highPriv: true }]);
  });

  it("readOnly 由动作策略表决定：读取类是 read，写类不是", async () => {
    const { runAppActionSurface } = await surface();
    expect(await runAppActionSurface("orchestratorRead", {}, { highPriv: true })).toMatchObject({
      ok: true,
      readOnly: true,
    });
    expect(await runAppActionSurface("openPanel", {}, { highPriv: true })).toMatchObject({
      ok: true,
      readOnly: false,
    });
  });

  it("动作层失败时错误文本原样透出，data 缺省补 null", async () => {
    st.result = { ok: false, err: "串口没开" };
    const { runAppActionSurface } = await surface();
    expect(await runAppActionSurface("openPort", {}, { highPriv: true })).toEqual({
      ok: false,
      code: "action_failed",
      msg: "串口没开",
    });
    st.result = { ok: true };
    expect(await runAppActionSurface("orchestratorRead", {}, { highPriv: true })).toEqual({
      ok: true,
      readOnly: true,
      data: null,
    });
  });
});

describe("P99a-F1：两个前端不许再长回第二份", () => {
  it("mcpServer 不再自己判 HIGH_ONLY、也不再自己写后台起势那条 if", async () => {
    const src = await readSource("../mcp/mcpServer.ts");
    expect(src).toContain("runAppActionSurface");
    expect(src).not.toMatch(/HIGH_ONLY\.has\(/);
    expect(src).not.toMatch(/aargs\.op === "run"/);
    expect(src).not.toMatch(/\brunAppAction\(/); // 只有核里那一次调用
  });

  it("localEntries 的 run_app_action 走同一个核，不再直连 appActions", async () => {
    const src = await readSource("./localEntries.ts");
    expect(src).toContain('from "./appActionSurface"');
    expect(src).not.toMatch(/from "\.\.\/ai\/appActions"/);
    expect(src).not.toMatch(/\brunAppAction\(/);
  });
});
