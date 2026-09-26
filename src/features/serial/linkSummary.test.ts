/**
 * P107：数据流控的**两条纯判据**。
 *
 * 为什么要给一行代码写单测：这台机器上一个串口都没有（`list_ports` 返回空 ⇒ 端口下拉整行都不渲染
 * ⇒ 永远连不上），于是"选了硬件流控之后那颗手动 RTS 钮让路"这条**整批唯一的安全属性**
 * 在浏览器里根本走不到，connected 分支拍不到。留在 JSX 里就等于没测 —— 见详设 §6-5/§6-7。
 * 能拍的部分（三档文案、禁用态、tip 换话）已经在浏览器实测，记在详设 §8。
 */
import { describe, expect, it, vi } from "vitest";

// 与 agentAdapter / mcpServer 等测试同一手法：不 mock 就会把 Tauri 的 invoke/事件拖进来，
// 而这里只用到 `linkSummary` 的纯函数体，运行时一行都不碰 serialStore。
vi.mock("./serialStore", () => ({ getSnapshot: () => ({}) }));

import { linkSummary, rtsHeldByDriver } from "./linkSummary";

type Snap = Parameters<typeof linkSummary>[0];
const snap = (over: Partial<Snap>): Snap =>
  ({
    iface: "serial",
    status: "connected",
    config: { port: "COM3", baud: 115200, dataBits: 8, parity: "none", stopBits: 1, flow: "none" },
    net: { remoteHost: "", remotePort: 0, localPort: 0, localHost: "" },
    portName: null,
    bleDevices: [],
    bleDeviceId: "",
    ...over,
  }) as Snap;
const withFlow = (flow: "none" | "software" | "hardware") =>
  snap({ config: { ...snap({}).config, flow } });

describe("rtsHeldByDriver（手动 RTS 钮要不要让路）", () => {
  it("只有 hardware 让路：software 抢的是数据字节，不碰 RTS 线", () => {
    expect(rtsHeldByDriver("hardware")).toBe(true);
    expect(rtsHeldByDriver("software")).toBe(false);
    expect(rtsHeldByDriver("none")).toBe(false);
  });
});

describe("linkSummary 的流控尾巴", () => {
  it("none 不加尾巴：默认值天天印在状态行上只是挤宽度", () => {
    expect(linkSummary(snap({}))).toBe("串口 · COM3 · 115200 · 8N1");
  });

  it("software / hardware 各挂自己那个标准名（XON/XOFF 与 RTS/CTS 和 8N1 同类，不翻）", () => {
    expect(linkSummary(withFlow("software"))).toBe("串口 · COM3 · 115200 · 8N1 · XON/XOFF");
    expect(linkSummary(withFlow("hardware"))).toBe("串口 · COM3 · 115200 · 8N1 · RTS/CTS");
  });

  it("尾巴只跟串口配置走：换到网络接口就没有串口那一段", () => {
    const s = snap({ iface: "tcp-client" });
    expect(linkSummary(s)).not.toContain("XON");
    expect(linkSummary(s)).not.toContain("RTS");
  });
});
