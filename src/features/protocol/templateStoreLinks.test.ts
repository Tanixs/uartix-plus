import { beforeEach, describe, expect, it, vi } from "vitest";

type FrameHandler = (p: unknown) => void;
const h = vi.hoisted(() => ({ handlers: [] as FrameHandler[] }));

vi.mock("../../ipc/framesBus", () => ({
  onFrames: (fn: FrameHandler) => {
    h.handlers.push(fn);
    return () => {
      h.handlers = h.handlers.filter((x) => x !== fn);
    };
  },
}));

vi.mock("../settings/settingsStore", () => ({
  getSnapshot: () => ({
    theme: "dark",
    locale: "zh",
    zoom: 100,
    palette: "okabe",
    channels: [],
  }),
  subscribe: () => () => {},
  patch: () => undefined,
}));

vi.mock("../../panels/panelActivity", () => ({
  isOpen: () => false,
  markOpen: () => undefined,
  markClose: () => undefined,
  subscribe: () => () => {},
}));

import * as templateStore from "./templateStore";
import * as telemetryStore from "./telemetryStore";
import * as plotStore from "../plot/plotStore";
import type { FieldDef } from "../../ipc/types";

const fld = (p: Partial<FieldDef>): FieldDef => ({
  id: "f1",
  name: "温度",
  role: "data",
  offset: 4,
  type: "uint16",
  endian: "little",
  color: "#3fb950",
  ...p,
});

type RenameCall = [string, string | null, string, string];

function withBridge() {
  const calls: RenameCall[] = [];
  const win = {
    uartixPlot: {
      removeByTpl: () => undefined,
      renameChannels: (a: string, b: string | null, c: string, d: string) => {
        calls.push([a, b, c, d]);
        return 1;
      },
    },
  };
  vi.stubGlobal("window", win);
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  templateStore.replaceRules([]);
});

describe("改名传播 → 2D 通道重挂标签", () => {
  it("模板改名走「旧名·」前缀替换", () => {
    const calls = withBridge();
    const id = templateStore.addTemplate([0xaa]);
    templateStore.patchTemplate(id, { name: "新名字" });
    expect(calls.some((c) => c[1] === null && c[2] === "模板1·" && c[3] === "新名字·")).toBe(true);
  });

  it("字段改名走 tpl·字段 全标签替换（patchField）", () => {
    const calls = withBridge();
    const id = templateStore.addTemplate([0xaa]);
    templateStore.patchTemplate(id, { name: "T" });
    templateStore.addField(id, fld({ id: "f9" }));
    templateStore.patchField(id, "f9", { name: "炉温" });
    expect(calls).toContainEqual([id, "f9", "T·温度", "T·炉温"]);
  });

  it("画布编辑弹窗改名（upsertFieldLinked）也同步", () => {
    const calls = withBridge();
    const id = templateStore.addTemplate([0xaa]);
    templateStore.patchTemplate(id, { name: "T2" });
    templateStore.addField(id, fld({ id: "fa" }));
    templateStore.upsertFieldLinked(id, fld({ id: "fa", name: "湿度" }), "fa");
    expect(calls).toContainEqual([id, "fa", "T2·温度", "T2·湿度"]);
  });

  it("改颜色等化妆属性不触发改名", () => {
    const calls = withBridge();
    const id = templateStore.addTemplate([0xaa]);
    templateStore.addField(id, fld({ id: "fb" }));
    templateStore.patchField(id, "fb", { color: "#ffffff", scale: 0.1 });
    expect(calls.length).toBe(0);
  });
});

describe("删除字段/模板 → 遥测僵尸值清理", () => {
  const frame = (tplId: string, fields: { id: string; value: number }[]) => ({
    rows: [
      {
        tplId,
        tplName: "T",
        color: "#fff",
        tsMs: 1,
        seq: 1,
        len: 12,
        valid: true,
        error: null,
        bytes: new Uint8Array(12),
        fields: fields.map((f) => ({ ...f, text: null })),
      },
    ],
    total: 1,
    errors: 0,
  });

  it("removeField 清掉该字段及其数组子变量", () => {
    void telemetryStore.init();
    const id = templateStore.addTemplate([0xaa]);
    templateStore.addField(id, fld({ id: "fc" }));
    h.handlers[0]?.(frame(id, [{ id: "fc", value: 5 }, { id: "fc#2", value: 6 }]));
    expect(telemetryStore.getSnapshot().latest["fc"]).toBeTruthy();
    expect(telemetryStore.getSnapshot().latest["fc#2"]).toBeTruthy();
    templateStore.removeField(id, "fc");
    expect(telemetryStore.getSnapshot().latest["fc"]).toBeUndefined();
    expect(telemetryStore.getSnapshot().latest["fc#2"]).toBeUndefined();
  });

  it("removeTemplate 清掉该模板统计与全部字段值", () => {
    void telemetryStore.init();
    const id = templateStore.addTemplate([0xaa]);
    templateStore.addField(id, fld({ id: "fd" }));
    h.handlers[0]?.(frame(id, [{ id: "fd", value: 5 }]));
    expect(telemetryStore.getSnapshot().tplStats[id]).toBeTruthy();
    templateStore.removeTemplate(id);
    expect(telemetryStore.getSnapshot().latest["fd"]).toBeUndefined();
    expect(telemetryStore.getSnapshot().tplStats[id]).toBeUndefined();
  });
});

describe("plotStore.renameChannels 前缀替换语义", () => {
  it("精确前缀 + 纯数字后缀才替换，其余原样", () => {
    const A = "tplA";
    const B = "tplB";
    expect(plotStore.addChannel({ tplId: A, fieldId: "f1", name: "T·温度", color: "#fff" })).toBe(true);
    expect(
      plotStore.addChannel({ tplId: A, fieldId: "f1#2", name: "T·温度2", color: "#fff" }),
    ).toBe(true);
    expect(
      plotStore.addChannel({ tplId: A, fieldId: "f1#10", name: "T·温度10", color: "#fff" }),
    ).toBe(true);
    expect(
      plotStore.addChannel({ tplId: A, fieldId: "f2", name: "T·温度计", color: "#fff" }),
    ).toBe(true);
    expect(
      plotStore.addChannel({ tplId: B, fieldId: "f1", name: "T·温度", color: "#fff" }),
    ).toBe(true);
    const n = plotStore.renameChannels(A, "f1", "T·温度", "T·炉温");
    expect(n).toBe(3);
    const nameOf = (tplId: string, fieldId: string) =>
      plotStore.getSnapshot().channels.find((c) => c.tplId === tplId && c.fieldId === fieldId)?.name;
    expect(nameOf(A, "f1")).toBe("T·炉温");
    expect(nameOf(A, "f1#2")).toBe("T·炉温2");
    expect(nameOf(A, "f1#10")).toBe("T·炉温10");
    expect(nameOf(A, "f2")).toBe("T·温度计");
    expect(nameOf(B, "f1")).toBe("T·温度");
    plotStore.clearChannels();
  });
});
