/**
 * S4 · 预检接线：`runCommand` 必须在求值之前问预检，被拦时一个字节都不发。
 * 预检本身的规则在 `preflight.test.ts` 里钉；这里只钉"接上了、且没改正常路径"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendData: vi.fn<(mode: string, text: string) => Promise<void>>(),
  preflight: vi.fn(),
  onFrames: vi.fn(),
  subscribe: vi.fn(),
  getSnapshot: vi.fn(() => ({ rules: { templates: [] } })),
}));

vi.mock("../serial/serialStore", () => ({ sendData: mocks.sendData }));
vi.mock("./preflight", () => ({ preflightTemplate: mocks.preflight }));
vi.mock("../../ipc/framesBus", () => ({ onFrames: mocks.onFrames }));
vi.mock("../protocol/templateStore", () => ({
  subscribe: mocks.subscribe,
  getSnapshot: mocks.getSnapshot,
}));

const memStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memStorage.set(k, v),
  removeItem: (k: string) => void memStorage.delete(k),
  clear: () => memStorage.clear(),
});

let variableStore: typeof import("./variableStore");
let cmdExec: typeof import("./cmdExec");

beforeEach(async () => {
  vi.resetModules();
  mocks.sendData.mockReset().mockResolvedValue(undefined);
  mocks.preflight.mockReset();
  variableStore = await import("./variableStore");
  cmdExec = await import("./cmdExec");
});

const cmd = (template: string, sendMode: "ascii" | "hex" = "ascii") => ({
  sendMode,
  template,
  script: "",
  scriptEnabled: false,
  name: "速度命令",
});

describe("S4 · runCommand 接线", () => {
  it("ASCII 被拦：不发一个字节，错误点名缺失变量", async () => {
    mocks.preflight.mockResolvedValue({ ok: false, reason: "timeout", missing: ["速度"] });
    variableStore.setVar("速度", 12.7);

    await expect(cmdExec.runCommand(cmd("SPD:{速度:d}!"))).rejects.toThrow(/速度/);
    expect(mocks.sendData).not.toHaveBeenCalled();
    expect(mocks.preflight).toHaveBeenCalledWith("SPD:{速度:d}!", "ascii", { source: "速度命令" });
  });

  it("HEX 被拦：不发一个字节", async () => {
    mocks.preflight.mockResolvedValue({ ok: false, reason: "hex", missing: ["缺失"] });

    await expect(cmdExec.runCommand(cmd("AA {缺失} BB", "hex"))).rejects.toThrow(/缺失/);
    expect(mocks.sendData).not.toHaveBeenCalled();
  });

  it("预检放行：仍按 resolveVars 的字节发送（正常路径不变）", async () => {
    mocks.preflight.mockResolvedValue({ ok: true });
    variableStore.setVar("速度", 12.7);

    await cmdExec.runCommand(cmd("SPD:{速度:d}!"));
    expect(mocks.sendData).toHaveBeenCalledWith("ascii", "SPD:13!");
  });
});
