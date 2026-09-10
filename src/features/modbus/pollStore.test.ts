import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 主站轮询表测试（M2-d）。
 * binbus / serialStore / variableStore 全部打桩：这里验的是**总线行为语义**
 * （谁在途、什么时候发下一条、响应怎么配、值进哪个变量），不是传输本身。
 */
const h = vi.hoisted(() => ({
  rx: [] as ((p: { bytes: Uint8Array }) => void)[],
  sent: [] as number[][],
  vars: new Map<string, number | string>(),
  slaveRunning: false,
  iface: "serial" as string,
}));

vi.mock("../../ipc/binbus", () => ({
  onRx: (fn: (p: { bytes: Uint8Array }) => void) => {
    h.rx.push(fn);
    return () => {
      const i = h.rx.indexOf(fn);
      if (i >= 0) h.rx.splice(i, 1);
    };
  },
}));

vi.mock("../serial/serialStore", () => ({
  sendData: (_mode: string, text: string) => {
    h.sent.push(text.trim().split(/\s+/).map((x) => Number.parseInt(x, 16)));
    return Promise.resolve();
  },
  getSnapshot: () => ({ iface: h.iface }),
}));

vi.mock("../controls/variableStore", () => ({
  setVar: (name: string, value: number | string) => {
    h.vars.set(name, value);
  },
}));

vi.mock("./slaveStore", () => ({
  isRunning: () => h.slaveRunning,
}));

import * as poll from "./pollStore";
import { buildRtuRequest, buildRtuResponse } from "./mb";

const sendMaster = (bytes: number[]) => h.rx.forEach((f) => f({ bytes: new Uint8Array(bytes) }));
const lastRequest = () => h.sent[h.sent.length - 1] ?? [];

beforeEach(() => {
  vi.useFakeTimers();
  h.rx.length = 0;
  h.sent.length = 0;
  h.vars.clear();
  h.slaveRunning = false;
  h.iface = "serial";
  if (poll.getSnapshot().running) poll.stop();
  for (const r of poll.getSnapshot().rows) poll.removeRow(r.id);
  poll.setTransport("rtu"); // 用例之间必须复位帧格式，否则后面全被启动闸门拦掉
  poll.resetStats();
});

afterEach(() => {
  if (poll.getSnapshot().running) poll.stop();
  vi.useRealTimers();
});

describe("启动闸门", () => {
  it("没有启用行 / 从站在跑 → 拒绝启动并给出原因", () => {
    expect(poll.start()).toMatch(/至少启用一个轮询项/);
    poll.addRow({ enabled: true });
    h.slaveRunning = true;
    expect(poll.start()).toMatch(/模拟从站正在运行/);
    h.slaveRunning = false;
    expect(poll.start()).toBeNull();
  });

  it("Modbus TCP 帧格式在串口接口上被拒绝（RTU over TCP 隧道才该选 TCP）", () => {
    poll.addRow({ enabled: true });
    poll.stop();
    poll.setTransport("tcp");
    expect(poll.start()).toMatch(/需要网络接口/);
    h.iface = "tcp-client";
    expect(poll.start()).toBeNull();
  });
});

describe("发请求", () => {
  it("到点发出 RTU 读请求，帧内容与内核一致", () => {
    poll.addRow({ enabled: true, slave: 3, fn: 3, addr: 1, qty: 2, periodMs: 100, varName: "V1" });
    poll.start();
    vi.advanceTimersByTime(10);
    expect(h.sent.length).toBe(1);
    expect(lastRequest()).toEqual(buildRtuRequest({ slave: 3, fn: 3, addr: 1, qty: 2 }));
  });

  it("半双工：有在途请求时不发下一条，超时后才放行", () => {
    poll.addRow({ enabled: true, slave: 1, fn: 3, addr: 0, qty: 1, periodMs: 20, varName: "A" });
    poll.addRow({ enabled: true, slave: 2, fn: 3, addr: 0, qty: 1, periodMs: 20, varName: "B" });
    poll.start();
    vi.advanceTimersByTime(50);
    expect(h.sent.length).toBe(1); // 只发了一条，另一条等在途
    vi.advanceTimersByTime(1200); // 等超时放行
    expect(poll.getSnapshot().timeouts).toBe(1);
    expect(h.sent.length).toBe(2);
  });
});

describe("收响应", () => {
  it("寄存器值写进变量，元素序号与倍率生效", () => {
    poll.addRow({ enabled: true, slave: 1, fn: 3, addr: 0, qty: 3, periodMs: 100, varName: "温度", elem: 1, scale: 0.1 });
    poll.start();
    vi.advanceTimersByTime(10);
    sendMaster(buildRtuResponse(1, [0x03, 6, 0x00, 0x0a, 0x01, 0xf4, 0x00, 0x1e]));
    expect(h.vars.get("温度")).toBeCloseTo(50, 6); // 第 1 个寄存器 500 × 倍率 0.1
    expect(poll.getSnapshot().rows[0].ok).toBe(1);
    expect(poll.getSnapshot().rows[0].last).toBeCloseTo(50, 6);
  });

  it("线圈响应按位取值（低位在前）", () => {
    poll.addRow({ enabled: true, slave: 2, fn: 1, addr: 0, qty: 8, periodMs: 100, varName: "运行", elem: 3 });
    poll.start();
    vi.advanceTimersByTime(10);
    sendMaster(buildRtuResponse(2, [0x01, 1, 0b00001000]));
    expect(h.vars.get("运行")).toBe(1);
  });

  it("自己发出的请求回显不会被当成响应", () => {
    poll.addRow({ enabled: true, slave: 1, fn: 3, addr: 0, qty: 1, periodMs: 100, varName: "E" });
    poll.start();
    vi.advanceTimersByTime(10);
    sendMaster(lastRequest()); // 半双工回显
    expect(h.vars.size).toBe(0);
    expect(poll.getSnapshot().rows[0].ok).toBe(0);
    expect(poll.getSnapshot().running).toBe(true);
  });

  it("响应前有噪声字节时按期望长度滑窗重找", () => {
    poll.addRow({ enabled: true, slave: 1, fn: 3, addr: 0, qty: 1, periodMs: 100, varName: "F" });
    poll.start();
    vi.advanceTimersByTime(10);
    sendMaster([0xdd, 0xee, ...buildRtuResponse(1, [0x03, 2, 0x12, 0x34])]);
    expect(h.vars.get("F")).toBe(0x1234);
  });

  it("异常响应记一次错误并给出可读原因", () => {
    poll.addRow({ enabled: true, slave: 1, fn: 3, addr: 900, qty: 1, periodMs: 100, varName: "G" });
    poll.start();
    vi.advanceTimersByTime(10);
    sendMaster(buildRtuResponse(1, [0x83, 0x02]));
    expect(poll.getSnapshot().errs).toBe(1);
    expect(poll.getSnapshot().lastError).toMatch(/非法数据地址/);
    expect(h.vars.size).toBe(0);
  });

  it("TCP 帧格式：MBAP 组帧、按事务号配对响应", () => {
    h.iface = "tcp-client";
    poll.setTransport("tcp");
    poll.addRow({ enabled: true, slave: 1, fn: 3, addr: 0, qty: 1, periodMs: 100, varName: "T" });
    poll.start();
    vi.advanceTimersByTime(10);
    const req = lastRequest();
    expect(req.slice(2, 4)).toEqual([0, 0]); // 协议标识
    expect(req.length).toBe(6 + 1 + 5); // MBAP(6) + 单元 + PDU(5)
    const txn = (req[0] << 8) | req[1];
    const pdu = [0x03, 2, 0x00, 0x2a];
    const len = pdu.length + 1;
    sendMaster([(txn >> 8) & 0xff, txn & 0xff, 0, 0, (len >> 8) & 0xff, len & 0xff, 1, ...pdu]);
    expect(h.vars.get("T")).toBe(42);
  });

  it("迟到的旧事务响应被忽略，不会配错行", () => {
    h.iface = "tcp-client";
    poll.setTransport("tcp");
    poll.addRow({ enabled: true, slave: 1, fn: 3, addr: 0, qty: 1, periodMs: 100, varName: "H" });
    poll.start();
    vi.advanceTimersByTime(10);
    const stale = [0x7f, 0x00, 0, 0, 0, 0x05, 1, 0x03, 2, 0x99, 0x99];
    sendMaster(stale);
    expect(h.vars.get("H")).toBeUndefined();
    expect(poll.getSnapshot().running).toBe(true);
  });
});

describe("表编辑", () => {
  it("新增/改参数/删除都反映在快照里，且数量上限按区类型收敛", () => {
    poll.addRow({ fn: 3, qty: 999 });
    const r = poll.getSnapshot().rows[0];
    expect(r.qty).toBe(125); // 寄存器读上限
    poll.updateRow(r.id, { fn: 1, qty: 9999 });
    expect(poll.getSnapshot().rows[0].qty).toBe(2000); // 位读上限
    poll.updateRow(r.id, { slave: 999 });
    expect(poll.getSnapshot().rows[0].slave).toBe(247);
    poll.removeRow(r.id);
    expect(poll.getSnapshot().rows.length).toBe(0);
  });

  it("变量名缺省按地址段自动生成（4x/0x 风格）", () => {
    poll.addRow({ fn: 3, addr: 12, slave: 1 });
    poll.addRow({ fn: 1, addr: 5, slave: 1 });
    const [a, b] = poll.getSnapshot().rows;
    expect(a.varName).toMatch(/^MB_/);
    expect(b.varName).toContain("0");
  });
});
