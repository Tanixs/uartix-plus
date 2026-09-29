/**
 * P121-A · 命令执行只有一份。
 *
 * 病灶（详设 §1.5 b/c/d）：一条命令的"怎么发"曾有三份实现——命令库点、控制台快捷栏点、
 * 脚本里的 `send`。其中快捷栏那份**漏了 `resolveVars`**，于是同一条 `SPD:{速度:d}!`
 * 在导轨点出 `SPD:13!`、在快捷栏点出字面量；而悬浮提示数的是原文的字节数。
 * 三份里没有一份是错的，它们只是不是同一份。
 *
 * 这里钉两层：
 *  ① 行为：`runCommand` 对模板命令先求值再发、对脚本命令走脚本、空内容**在发出前**报错；
 *  ② 接线：两个入口文件都必须走 `cmdExec`，不许再各自留一份 `runScript` / 裸 `sendData`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendData: vi.fn<(mode: string, text: string) => Promise<void>>(),
  onFrames: vi.fn(),
  subscribe: vi.fn(),
  getSnapshot: vi.fn(() => ({ rules: { templates: [] } })),
}));

vi.mock("../serial/serialStore", () => ({ sendData: mocks.sendData }));
vi.mock("../../ipc/framesBus", () => ({ onFrames: mocks.onFrames }));
vi.mock("../protocol/templateStore", () => ({
  subscribe: mocks.subscribe,
  getSnapshot: mocks.getSnapshot,
}));

// scriptRunner → controlsStore 在模块求值期就摸 localStorage（§8-33 在册的历史包袱），
// 与 toolDisplay.test / uiTools.test 同一手法：只补这一层桩，不改变被测逻辑
const memStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memStorage.set(k, v),
  removeItem: (k: string) => void memStorage.delete(k),
  clear: () => memStorage.clear(),
});

const spec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(spec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

let variableStore: typeof import("./variableStore");
let cmdExec: typeof import("./cmdExec");

beforeEach(async () => {
  vi.resetModules();
  mocks.sendData.mockReset().mockResolvedValue(undefined);
  variableStore = await import("./variableStore");
  cmdExec = await import("./cmdExec");
});

const cmd = (over: Partial<import("./cmdExec").RunnableCommand>) => ({
  sendMode: "ascii" as const,
  template: "",
  script: "",
  scriptEnabled: false,
  ...over,
});

describe("P121-A · runCommand", () => {
  it("模板命令：先 resolveVars 再发（快捷栏当年漏的就是这一步）", async () => {
    variableStore.setVar("速度", 12.7);
    await cmdExec.runCommand(cmd({ template: "SPD:{速度:d}!" }));
    expect(mocks.sendData).toHaveBeenCalledTimes(1);
    expect(mocks.sendData.mock.calls[0][1]).toBe("SPD:13!");
  });

  it("hex 模式：求值后的串按 HEX 发，模式不被求值吞掉", async () => {
    variableStore.setVar("地址", 3);
    await cmdExec.runCommand(cmd({ sendMode: "hex", template: "01 06 {地址:d} 00 01" }));
    expect(mocks.sendData.mock.calls[0][0]).toBe("hex");
    expect(mocks.sendData.mock.calls[0][1]).toBe("01 06 3 00 01");
  });

  it("空内容在发出前就报错，而不是让设备收一串空", async () => {
    await expect(cmdExec.runCommand(cmd({ template: "   " }))).rejects.toThrow(/内容为空|no content/i);
    expect(mocks.sendData).not.toHaveBeenCalled();
  });

  it("脚本命令走脚本那条路，且脚本里的 send 也经同一个出口", async () => {
    await cmdExec.runCommand(
      cmd({ script: 'await send("A1 A2", "hex");', scriptEnabled: true }),
    );
    expect(mocks.sendData).toHaveBeenCalledTimes(1);
    expect(mocks.sendData.mock.calls[0][0]).toBe("hex");
    expect(mocks.sendData.mock.calls[0][1]).toBe("A1 A2");
  });

  it("只有空白脚本时不跑脚本，退回模板那条路（旧命令库判的是真值，会去跑空脚本）", async () => {
    await cmdExec.runCommand(
      cmd({ template: "PING", script: "   ", scriptEnabled: true }),
    );
    expect(mocks.sendData).toHaveBeenCalledTimes(1);
    expect(mocks.sendData.mock.calls[0][1]).toBe("PING");
  });

  it("接线：两个入口都走 cmdExec，不再各留一份发送实现", () => {
    const rail = readSrc("./CommandLibrary.tsx");
    const bar = readSrc("../console/QuickCommandBar.tsx");
    expect(rail, "命令库应经 runCommand 发命令").toContain("runCommand(");
    expect(bar, "快捷栏应经 runCommand 发命令").toContain("runCommand(");
    // 快捷栏仍可以直接 sendData —— 但只许留给"指令工厂就地发送"那一条（它不是 CommandItem）
    const barRawSends = [...bar.matchAll(/serialStore\.sendData\(/g)].length;
    expect(barRawSends, "快捷栏里裸 sendData 只该剩指令工厂那一处").toBe(1);
    expect(bar, "快捷栏不该再自己 import runScript 组一份脚本环境").not.toMatch(
      /import\s*\{[^}]*\brunScript\b[^}]*\}\s*from/,
    );
    expect(rail, "命令库不该再自己拼一份求值+发送").not.toMatch(/sendCmd\([^)]*resolveVars/);
  });
});
