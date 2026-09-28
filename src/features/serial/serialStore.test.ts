/**
 * P115-F12/F13 的守卫：串口参数落盘 + 控制线记忆按端口分档。
 *
 * F13 事故：serialStore 是纯模块内存，改好 921600/8N1 重启就回 115200/8N1；
 * F12 事故：控制线电平记忆整表一份，给 COM3 设过的 DTR 会在打开 COM4 时被复施加。
 * 手法：先桩 localStorage / @tauri-apps/api/core（node 没有，ESM import 又跑在桩之前
 * ——同 thinkingParams.test 的载入次序），纯函数（sanitize）与 store 行为（setConfig/
 * setControlLines）直接驱动；"重启"用 vi.resetModules + 二次 await import 真模拟。
 */
import { describe, expect, it, vi } from "vitest";

const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const { sanitizeSerialConfig, setConfig, setControlLines, getSnapshot, BAUD_RATES } =
  await import("./serialStore");

describe("P115-F13 · sanitizeSerialConfig：坏值一律落回默认", () => {
  it("垃圾输入整表回默认，不抛错", () => {
    expect(sanitizeSerialConfig(null)).toEqual({
      port: "", baud: 115200, dataBits: 8, parity: "none", stopBits: 1, flow: "none",
    });
    expect(sanitizeSerialConfig("junk")).toEqual(sanitizeSerialConfig(null));
    expect(sanitizeSerialConfig({ baud: "115200", dataBits: 9, parity: "mark", stopBits: 3, flow: "rts" }))
      .toEqual(sanitizeSerialConfig(null));
  });

  it("认识的值原样收下；枚举外的单项只掉那一项", () => {
    const good = { port: "COM7", baud: 921600, dataBits: 7, parity: "even", stopBits: 2, flow: "hardware" };
    expect(sanitizeSerialConfig(good)).toEqual(good);
    const half = sanitizeSerialConfig({ ...good, parity: "space", stopBits: 0 });
    expect(half.parity).toBe("none");
    expect(half.stopBits).toBe(1);
    expect(half.baud).toBe(921600);
  });

  it("波特率不在档位表里落回 115200（清洗与菜单共用 BAUD_RATES 一张表）", () => {
    expect(sanitizeSerialConfig({ baud: 9601 }).baud).toBe(115200);
    expect(BAUD_RATES).toContain(921600);
  });
});

describe("P115-F13 · 落盘与重启恢复", () => {
  it("setConfig 即写 localStorage；读回来清洗后与内存一致（roundtrip）", () => {
    setConfig({ port: "COM5", baud: 230400, parity: "odd" });
    const raw = backing.get("vs.serialConfig");
    expect(raw, "setConfig 没有落盘").toBeTruthy();
    expect(sanitizeSerialConfig(JSON.parse(raw!))).toEqual(getSnapshot().config);
  });

  it("重启（重载模块）后参数还在；ctrl/modem 不落盘", async () => {
    vi.resetModules();
    const fresh = await import("./serialStore");
    expect(fresh.getSnapshot().config.port).toBe("COM5");
    expect(fresh.getSnapshot().config.baud).toBe(230400);
    expect(fresh.getSnapshot().ctrl).toEqual({ dtr: null, rts: null });
  });
});

describe("P115-F12 · 控制线记忆按端口分档", () => {
  it("给 COM5 记的电平，切到 COM6 后 ctrl 归零；切回 COM5 记忆还在", async () => {
    await setControlLines({ dtr: true });
    expect(getSnapshot().ctrl).toEqual({ dtr: true, rts: null });
    setConfig({ port: "COM6" });
    expect(getSnapshot().ctrl, "换口后还显示上一口的电平：注释行要开始撒谎了").toEqual({ dtr: null, rts: null });
    setConfig({ port: "COM5" });
    expect(getSnapshot().ctrl).toEqual({ dtr: true, rts: null });
  });
});
