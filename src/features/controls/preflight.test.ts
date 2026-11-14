/**
 * S4 · 模板变量预检。
 *
 * 钉四件事：
 *  ① 提取与判定：同一变量只报一次、多个缺失按出现顺序全列、空/NaN 算未就绪；
 *  ② 模式差异：HEX 一律拦（无放行），ASCII 5 秒内点「仍要发送」才放行；
 *  ③ 批量：短窗口内多条被拦只汇总一次，不逐条弹窗；
 *  ④ 不误伤：JSON 字面量与能取到值的正常模板原样放行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  onFrames: vi.fn(),
  subscribe: vi.fn(),
  getSnapshot: vi.fn(() => ({ rules: { templates: [] } })),
}));

vi.mock("../protocol/templateStore", () => ({
  subscribe: mocks.subscribe,
  getSnapshot: mocks.getSnapshot,
}));
vi.mock("../../ipc/framesBus", () => ({ onFrames: mocks.onFrames }));
vi.mock("../../shared/toast", () => ({ toast: mocks.toast }));

const memStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memStorage.set(k, v),
  removeItem: (k: string) => void memStorage.delete(k),
  clear: () => memStorage.clear(),
});

let variableStore: typeof import("./variableStore");
let preflight: typeof import("./preflight");
let noteBus: typeof import("../console/noteBus");

/** 测试用提示：只记录弹出次数与最近文案，由用例决定"点仍要发送"还是等超时 */
function installPrompt() {
  const seen: string[] = [];
  let accept: (() => void) | null = null;
  preflight.setPreflightPrompt((message, onAccept) => {
    seen.push(message);
    accept = onAccept;
    return { close: () => {} };
  });
  return {
    seen,
    accept: () => accept?.(),
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.toast.mockReset();
  memStorage.clear();
  variableStore = await import("./variableStore");
  preflight = await import("./preflight");
  noteBus = await import("../console/noteBus");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("S4 · 提取与缺失判定", () => {
  it("同一变量只报一次，多个变量按出现顺序", () => {
    expect(
      preflight.templateVarNames("SPD:{速度:d}! {速度} RPM:{rpm:.2f} T:{温度}"),
    ).toEqual(["速度", "rpm", "温度"]);
  });

  it("空串与 NaN 视为未就绪", () => {
    variableStore.setVar("空", "");
    variableStore.setVar("坏", Number.NaN);
    expect(preflight.missingTemplateVars("{空} {坏} {没定义}")).toEqual(["空", "坏", "没定义"]);
  });

  it("JSON 字面量不当变量（故意发 {} 的场景不受影响）", async () => {
    expect(preflight.templateVarNames('{"cmd":1}')).toEqual([]);
    await expect(preflight.preflightTemplate('{"cmd":1}', "hex")).resolves.toEqual({ ok: true });
  });

  it("能取到值时直接放行，不弹提示、不写日志", async () => {
    variableStore.setVar("速度", 12.7);
    const prompt = installPrompt();
    const notes: string[] = [];
    noteBus.onNote((t) => notes.push(t));

    await expect(preflight.preflightTemplate("SPD:{速度:d}!", "ascii")).resolves.toEqual({ ok: true });
    expect(prompt.seen).toEqual([]);
    expect(notes).toEqual([]);
    expect(preflight.getBlockedLog()).toEqual([]);
  });
});

describe("S4 · 模式差异", () => {
  it("HEX 缺变量一律拦截，不给放行按钮", async () => {
    const prompt = installPrompt();
    const r = await preflight.preflightTemplate("AA {缺失} BB", "hex", { source: "复位(c1)" });

    expect(r).toEqual({ ok: false, reason: "hex", missing: ["缺失"] });
    expect(prompt.seen).toEqual([]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [entry] = preflight.getBlockedLog();
    expect(entry).toMatchObject({
      source: "复位(c1)",
      template: "AA {缺失} BB",
      mode: "hex",
      missing: ["缺失"],
      reason: "hex",
    });
    expect(typeof entry.at).toBe("number");
  });

  it("ASCII 5 秒内点「仍要发送」才放行", async () => {
    const prompt = installPrompt();
    const notes: string[] = [];
    noteBus.onNote((t) => notes.push(t));

    const p = preflight.preflightTemplate("SPD:{缺失:d}!", "ascii", { source: "命令A" });
    expect(prompt.seen).toHaveLength(1);
    expect(prompt.seen[0]).toContain("缺失");

    prompt.accept();
    await expect(p).resolves.toEqual({ ok: true });
    expect(notes).toEqual([]);
    expect(preflight.getBlockedLog()).toEqual([]);
  });

  it("ASCII 超时不点 = 放弃本次发送，并记一条日志", async () => {
    installPrompt();
    const notes: string[] = [];
    noteBus.onNote((t) => notes.push(t));

    const p = preflight.preflightTemplate("SPD:{速度}!", "ascii", { source: "命令B" });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ ok: false, reason: "timeout", missing: ["速度"] });

    expect(preflight.getBlockedLog()).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("命令B");
    expect(notes[0]).toContain("SPD:{速度}!");
    expect(notes[0]).toContain("缺失=速度");
  });

  it("同一条模板的并发请求共享同一个决策", async () => {
    const prompt = installPrompt();
    const a = preflight.preflightTemplate("SPD:{速度}!", "ascii");
    const b = preflight.preflightTemplate("SPD:{速度}!", "ascii");
    expect(prompt.seen).toHaveLength(1);
    prompt.accept();
    await expect(Promise.all([a, b])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });
});

describe("S4 · 批量汇总", () => {
  it("短窗口内三条不同模板：只弹一条汇总，三条都被跳过", async () => {
    installPrompt();
    const a = preflight.preflightTemplate("A:{速度}!", "ascii", { source: "卡1" });
    const b = preflight.preflightTemplate("B:{rpm}!", "ascii", { source: "卡2" });
    const c = preflight.preflightTemplate("C:{温度}!", "ascii", { source: "卡3" });

    await vi.advanceTimersByTimeAsync(400);
    const rs = await Promise.all([a, b, c]);
    expect(rs.every((r) => !r.ok && r.reason === "batch")).toBe(true);

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("已跳过 3 条：变量缺失（速度、rpm、温度）");
    expect(preflight.getBlockedLog()).toHaveLength(3);
  });
});
