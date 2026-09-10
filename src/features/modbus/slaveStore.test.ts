import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M2-c 模拟从站状态机测试。
 * binbus / serialStore 都要 Tauri IPC，故整体打桩：
 * 这里验证的是从站行为语义（应答/忽略/回显抑制/故障注入/计数），不是传输。
 */
const h = vi.hoisted(() => ({
  rx: [] as ((p: { bytes: Uint8Array }) => void)[],
  sent: [] as string[],
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
    h.sent.push(text);
    return Promise.resolve();
  },
}));

const unhex = (s: string) => s.trim().split(/\s+/).map((x) => Number.parseInt(x, 16));

import * as slave from "./slaveStore";
import { bitGet, buildRtuRequest, rtuCrcOk, takeRtuFrame } from "./mb";

/** 主站发一条请求（走被打桩的 rx 通道进从站） */
function master(frame: number[]) {
  h.rx.forEach((fn) => fn({ bytes: new Uint8Array(frame) }));
}

/** 取从站最近一帧应答（从"已发"列表消费掉），返回解好的帧 */
function takeSentFrame() {
  const raw = h.sent.shift();
  expect(raw).toBeTruthy();
  const buf = unhex(raw!);
  expect(rtuCrcOk(buf)).toBe(true);
  const f = takeRtuFrame(buf, "master");
  expect(f).toBeTruthy();
  return f!;
}

beforeEach(() => {
  h.rx.length = 0;
  h.sent.length = 0;
  if (slave.getSnapshot().running) slave.stop();
  slave.patch({ address: 1, anyAddress: false, delayMs: 0, fault: "none", faultCode: 2 });
  slave.resetCounters();
  slave.clearEvents();
  slave.resize(64, 128);
  slave.fill("holding", 0, 127, "same", 0, 0);
  slave.fill("coil", 0, 63, "same", 0, 0);
});

describe("模拟从站启停", () => {
  it("start 订阅 rx、stop 退订；未启动时到达的字节不应答", () => {
    master(buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 }));
    expect(h.sent.length).toBe(0);
    expect(slave.getSnapshot().running).toBe(false);

    slave.start();
    expect(slave.getSnapshot().running).toBe(true);
    expect(h.rx.length).toBe(1);

    slave.stop();
    expect(h.rx.length).toBe(0);
    master(buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 }));
    expect(h.sent.length).toBe(0);
  });
});

describe("模拟从站应答", () => {
  it("读保持寄存器返回配置进去的值", () => {
    slave.setWord("holding", 3, 1234);
    slave.start();
    master(buildRtuRequest({ slave: 1, fn: 0x03, addr: 2, qty: 3 }));
    const f = takeSentFrame();
    expect(f.slave).toBe(1);
    // 地址 2/3/4 → 0, 1234(0x04D2), 0，大端逐字
    expect(f.pdu).toEqual([0x03, 6, 0x00, 0x00, 0x04, 0xd2, 0x00, 0x00]);
    expect(slave.getSnapshot().counters.replies).toBe(1);
    expect(slave.getSnapshot().counters.exceptions).toBe(0);
  });

  it("写命令真实改数据区并回显", () => {
    slave.start();
    master(buildRtuRequest({ slave: 1, fn: 0x06, addr: 5, value: 0x1234 }));
    expect(takeSentFrame().pdu).toEqual([0x06, 0x00, 0x05, 0x12, 0x34]);
    expect(slave.banks.holding[5]).toBe(0x1234);

    master(buildRtuRequest({ slave: 1, fn: 0x05, addr: 9, value: 1 }));
    expect(takeSentFrame().pdu).toEqual([0x05, 0x00, 0x09, 0xff, 0x00]);
    expect(bitGet(slave.banks.coils, 9)).toBe(1);

    master(buildRtuRequest({ slave: 1, fn: 0x10, addr: 10, values: [7, 8, 9] }));
    expect(takeSentFrame().pdu).toEqual([0x10, 0x00, 0x0a, 0x00, 0x03]);
    expect([slave.banks.holding[10], slave.banks.holding[12]]).toEqual([7, 9]);
  });

  it("非本机地址的请求忽略不应答；anyAddress 打开后全收", () => {
    slave.start();
    master(buildRtuRequest({ slave: 8, fn: 0x03, addr: 0, qty: 1 }));
    expect(h.sent.length).toBe(0);
    expect(slave.getSnapshot().counters.ignored).toBe(1);

    slave.patch({ anyAddress: true });
    master(buildRtuRequest({ slave: 8, fn: 0x03, addr: 0, qty: 1 }));
    expect(h.sent.length).toBe(1);
    h.sent.length = 0;
  });

  it("广播写：执行但不回应答（协议规定）", () => {
    slave.start();
    master(buildRtuRequest({ slave: 0, fn: 0x06, addr: 6, value: 99 }));
    expect(h.sent.length).toBe(0);
    expect(slave.banks.holding[6]).toBe(99);
    expect(slave.getSnapshot().counters.silents).toBe(1);
  });

  it("请求分块到达也能拼出完整帧再应答", () => {
    slave.start();
    slave.setWord("holding", 0, 42);
    const frame = buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 2 });
    master(frame.slice(0, 3));
    expect(h.sent.length).toBe(0);
    master(frame.slice(3));
    expect(h.sent.length).toBe(1);
  });

  it("半双工回显：本机应答原样回到 rx 时不再自我应答", () => {
    slave.start();
    master(buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 }));
    const mine = h.sent.shift()!;
    master(unhex(mine));
    expect(h.sent.length).toBe(0);
  });

  it("坏 CRC 只计入噪声丢弃，不产生应答", () => {
    slave.start();
    const bad = buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 });
    bad[bad.length - 1] ^= 0xff;
    master(bad);
    expect(h.sent.length).toBe(0);
    expect(slave.getSnapshot().counters.noise).toBeGreaterThan(0);
  });
});

describe("故障注入", () => {
  it("noReply：计数静默且不发送", () => {
    slave.patch({ fault: "noReply" });
    slave.start();
    master(buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 }));
    expect(h.sent.length).toBe(0);
    expect(slave.getSnapshot().counters.silents).toBe(1);
  });

  it("exception：一律回指定异常码", () => {
    slave.patch({ fault: "exception", faultCode: 4 });
    slave.start();
    master(buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 }));
    const raw = unhex(h.sent.shift()!);
    expect(raw[1]).toBe(0x83);
    expect(raw[2]).toBe(4);
    expect(slave.getSnapshot().counters.exceptions).toBe(1);
  });

  it("everyOther：一次正常一次异常，用于测主站的重试逻辑", () => {
    slave.patch({ fault: "everyOther" });
    slave.start();
    const req = buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 });
    master(req);
    master(req);
    const a = unhex(h.sent.shift()!);
    const b = unhex(h.sent.shift()!);
    expect(a[1] & 0x80).toBe(0);
    expect(b[1]).toBe(0x83);
  });

  it("delayMs：应答延后到定时到达之后再发出", () => {
    vi.useFakeTimers();
    slave.patch({ delayMs: 120 });
    slave.start();
    master(buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 }));
    expect(h.sent.length).toBe(0);
    vi.advanceTimersByTime(130);
    expect(h.sent.length).toBe(1);
    vi.useRealTimers();
  });
});
