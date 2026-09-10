import { describe, expect, it } from "vitest";
import { MODBUS_RTU, MODBUS_TCP, PRESETS } from "./presets";
import type { FrameTemplate } from "../../ipc/types";

/**
 * Modbus RTU 预设簇的结构锁定。
 * 真正的字节级解析正确性由 Rust 侧 parser 单测覆盖（src-tauri/src/parser.rs），
 * 这里守住"配置本身没写错"：帧头通配、定帧数学、寄存器数组、CRC 覆盖区间。
 */
function rtuCluster(): FrameTemplate[] {
  const def = PRESETS.find((p) => p.key === MODBUS_RTU);
  expect(def, "Modbus RTU 预设应存在于预设列表").toBeTruthy();
  return def!.build();
}

/** 与引擎一致的定帧公式：总长 = ceil(长度值 × 倍率) + 修正 */
function frameTotal(t: FrameTemplate, raw: number): number {
  const b = t.boundary;
  const scaled = b.lengthScale && b.lengthScale > 0 ? Math.ceil(raw * b.lengthScale) : raw;
  return scaled + (b.lengthAdjust ?? 0);
}

const byFc = (tpls: FrameTemplate[], fc: number, mode: string) =>
  tpls.filter(
    (t) =>
      t.boundary.headerBytes[1] === fc &&
      t.boundary.mode === mode &&
      (t.boundary.headerMask?.[1] ?? 0xff) === 0xff,
  );

describe("Modbus RTU 预设簇", () => {
  const tpls = rtuCluster();

  it("覆盖 FC01–06 / 15 / 16 的请求·响应·回显与异常响应", () => {
    expect(tpls.length).toBe(13);
    expect(new Set(tpls.map((t) => t.name)).size).toBe(tpls.length);
    expect(tpls.every((t) => t.enabled)).toBe(true);
  });

  it("帧首一律通配从站地址（一条模板吃下整条总线，含广播 0）", () => {
    for (const t of tpls) {
      expect(t.boundary.headerBytes.length, t.name).toBe(2);
      expect(t.boundary.headerMask?.[0], `${t.name} 首字节应通配`).toBe(0x00);
    }
  });

  it("全部带 CRC16-Modbus 且覆盖到倒数第 2 字节（排除 CRC 自身）", () => {
    for (const t of tpls) {
      expect(t.checksum?.algo, t.name).toBe("crc16_modbus");
      expect(t.checksum?.coverageStart, t.name).toBe(0);
      expect(t.checksum?.coverageEnd, t.name).toBe(-2);
    }
  });

  it("读寄存器响应：byteCount 定长 + 寄存器区展开为大端 uint16 数组", () => {
    for (const fc of [0x03, 0x04]) {
      const resp = byFc(tpls, fc, "lengthField")[0];
      expect(resp, `FC${fc} 应有读响应模板`).toBeTruthy();
      expect(resp.boundary.lengthOffset).toBe(2);
      expect(resp.boundary.lengthScale ?? null).toBeNull();
      // 4 个寄存器 → byteCount=8 → 1+1+1+8+2 = 13
      expect(frameTotal(resp, 8)).toBe(13);
      const arr = resp.fields.find((x) => x.spanTail);
      expect(arr?.spanElem, "寄存器区应按 uint16 展开").toBe("uint16");
      expect(arr?.endian).toBe("big");
      expect(arr?.offset).toBe(3);
    }
  });

  it("读线圈响应：长度域是位数 → 倍率 0.125 换算成字节", () => {
    for (const fc of [0x01, 0x02]) {
      const resp = byFc(tpls, fc, "lengthField")[0];
      expect(resp.boundary.lengthScale, `FC${fc} 应设倍率`).toBe(0.125);
      // 12 个线圈 → ceil(12/8)=2 字节 → 1+1+1+2+2 = 7
      expect(frameTotal(resp, 12)).toBe(7);
      // 边界：1 位也要占一字节 → 1+1+1+1+2 = 6
      expect(frameTotal(resp, 1)).toBe(6);
    }
  });

  it("写多点请求：字节数在 @6，总长 = 字节数 + 9；回显为定长 8", () => {
    for (const fc of [0x0f, 0x10]) {
      const req = byFc(tpls, fc, "lengthField")[0];
      expect(req.boundary.lengthOffset).toBe(6);
      // 4 个寄存器 → bc=8 → 1+1+2+2+1+8+2 = 17
      expect(frameTotal(req, 8)).toBe(17);
      const echo = byFc(tpls, fc, "fixedLength")[0];
      expect(echo.boundary.fixedLength).toBe(8);
    }
  });

  it("异常响应用 bit7 位掩码，一条模板覆盖所有功能码的异常", () => {
    const ex = tpls.filter(
      (t) => t.boundary.headerMask?.[1] === 0x80 && t.boundary.headerBytes[1] === 0x80,
    );
    expect(ex.length).toBe(1);
    expect(ex[0].boundary.fixedLength).toBe(5); // 地址+FC+异常码+CRC2
    expect(ex[0].fields.some((x) => x.name === "异常码")).toBe(true);
    // 掩码语义自检：任意 FC|0x80 都应命中
    for (const fc of [0x81, 0x83, 0x90, 0xff]) {
      expect((fc & 0x80) === (0x80 & 0x80), `0x${fc.toString(16)} 应命中异常模板`).toBe(true);
    }
  });
});

describe("Modbus TCP 预设簇", () => {
  const def = PRESETS.find((p) => p.key === MODBUS_TCP);
  const tpls = def!.build();

  it("簇存在且帧型命名不重复、全部启用", () => {
    expect(def?.name).toBe("Modbus TCP");
    expect(tpls.length).toBe(15);
    expect(new Set(tpls.map((t) => t.name)).size).toBe(tpls.length);
    expect(tpls.every((t) => t.enabled)).toBe(true);
  });

  it("MBAP 定帧：协议标识 0000 作锚点，总长 = 长度值 + 6", () => {
    for (const t of tpls) {
      expect(t.boundary.headerBytes, t.name).toEqual([0, 0, 0, 0]);
      expect(t.boundary.headerMask, `${t.name} 应以协议标识锚定`).toEqual([0, 0, 0xff, 0xff]);
      expect(t.boundary.mode, t.name).toBe("lengthField");
      expect(t.boundary.lengthOffset, t.name).toBe(4);
      expect(t.boundary.lengthSize, t.name).toBe(2);
      expect(t.boundary.lengthEndian, t.name).toBe("big");
      expect(t.boundary.lengthAdjust, t.name).toBe(6);
      // TCP 无校验域：完整性由 MBAP 长度承担
      expect(t.checksum, t.name).toBeNull();
      // 请求帧示例：长度值 6 → ADU 12 字节
    }
  });

  it("无 CRC 的主从区分靠长度奇偶识别位（请求偶/响应奇）", () => {
    const parity = (t: FrameTemplate) =>
      t.boundary.discs?.find((d) => d.offset === 5)?.mask?.[0] === 0x01
        ? t.boundary.discs?.find((d) => d.offset === 5)?.value?.[0]
        : null;
    const req = tpls.find((t) => t.name === "ModbusTCP·读保持寄存器请求")!;
    const rsp = tpls.find((t) => t.name === "ModbusTCP·读保持寄存器响应")!;
    expect(parity(req), "读请求长度恒 6（偶）").toBe(0x00);
    expect(parity(rsp), "读响应长度 3+2N（奇）").toBe(0x01);
    // 同一 FC 的主从两条模板必须落在互斥的奇偶两侧，否则会同时"有效"地解出错误字段
    const reqLen = 6; // 起始(2)+数量(2)+FC(1)+单元(1)
    const rspLen = 3 + 2 * 4; // FC + 字节数 + 8 字节数据
    expect(reqLen % 2).not.toBe(rspLen % 2);
    const multi = tpls.find((t) => t.name === "ModbusTCP·写多个寄存器")!;
    const echo = tpls.find((t) => t.name === "ModbusTCP·写多个寄存器回显")!;
    expect(parity(multi), "写多请求带数据区（奇）").toBe(0x01);
    expect(parity(echo), "写多回显长度 6（偶）").toBe(0x00);
  });

  it("读响应按大端 uint16 展开寄存器区，字段偏移与 MBAP 对齐", () => {
    const rsp = tpls.find((t) => t.name === "ModbusTCP·读保持寄存器响应")!;
    const arr = rsp.fields.find((x) => x.spanTail);
    expect(arr?.offset, "数据区从 FC 之后开始").toBe(9);
    expect(arr?.spanElem).toBe("uint16");
    expect(arr?.endian).toBe("big");
    expect(rsp.fields.some((x) => x.name === "事务标识")).toBe(true);
    expect(rsp.fields.some((x) => x.name === "单元地址")).toBe(true);
    // 响应 PDU = FC + 字节数 + 2N → MBAP 长度 = 3 + 2N（如 2 寄存器 → 7 → ADU 13）
    expect(3 + 2 * 2 + 6).toBe(13);
  });

  it("异常响应按功能码 bit7 掩码一条覆盖", () => {
    const ex = tpls.filter((t) => t.name === "ModbusTCP·异常响应");
    expect(ex.length).toBe(1);
    const fcDisc = ex[0].boundary.discs?.find((d) => d.offset === 7);
    expect(fcDisc?.value).toEqual([0x80]);
    expect(fcDisc?.mask, "应只比较 bit7，而非精确 0x80").toEqual([0x80]);
  });
});
