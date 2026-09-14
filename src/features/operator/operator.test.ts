import { describe, expect, it } from "vitest";
import {
  buildPkgFile,
  filterSettings,
  OPERATOR_KIND,
  OPERATOR_VERSION,
  validatePkg,
  type OperatorPkg,
} from "./operatorPkg";
import type { Plot3DSettings } from "../plot3d/plot3dStore";

const meta = { name: " 电机调试台 ", description: "产线用", createdAt: 123, appVersion: "0.3.8" };

describe("filterSettings", () => {
  it("只保留白名单键，AI/MCP/缩放等本机私有项不进包", () => {
    const full = {
      theme: "light",
      locale: "zh",
      zoom: 1.25,
      decimals: 3,
      perfHud: true,
      workspace: "proto",
      cellSize: 18,
      aiPreset: "openai",
      aiApiKey: "sk-secret",
      aiModel: "gpt",
      mcpToken: "tok",
      mcpPort: 1346,
      autoReconnect: true,
      reduceMotion: false,
    } as never;
    const out = filterSettings(full);
    expect(Object.keys(out).sort()).toEqual(
      ["autoReconnect", "cellSize", "chartPalette", "conWrap", "decimals", "locale", "reduceMotion", "theme", "workspace"].sort(),
    );
    expect((out as { zoom?: number }).zoom).toBeUndefined();
    expect((out as { aiApiKey?: string }).aiApiKey).toBeUndefined();
    expect((out as { mcpToken?: string }).mcpToken).toBeUndefined();
  });
});

describe("buildPkgFile / validatePkg", () => {
  it("build → 文件外壳；validate 规整（trim 包名）并往返一致", () => {
    const pkg: OperatorPkg = {
      meta,
      payload: { commands: [{ id: "g1", name: "启停", items: [] }] },
    };
    const file = buildPkgFile(pkg);
    expect(file.kind).toBe(OPERATOR_KIND);
    expect(file.version).toBe(OPERATOR_VERSION);
    const round = validatePkg(JSON.parse(JSON.stringify(file.data)));
    expect(round.meta.name).toBe("电机调试台");
    expect(round.payload.commands?.[0]?.name).toBe("启停");
  });

  it("拒绝：非对象 / 缺包名 / 缺载荷 / 数据形状不对", () => {
    expect(() => validatePkg(null)).toThrow(/缺少内容/);
    expect(() => validatePkg({})).toThrow(/包名/);
    expect(() => validatePkg({ meta })).toThrow(/载荷/);
    expect(() =>
      validatePkg({ meta, payload: { templates: { templates: "no" } } }),
    ).toThrow(/协议模板/);
    expect(() => validatePkg({ meta, payload: { controls: "no" } })).toThrow(/控制页/);
    expect(() => validatePkg({ meta, payload: { commands: {} } })).toThrow(/命令库/);
  });

  it("空载荷拒绝（导入空包 = 什么都没换却全局只读的死局）", () => {
    expect(() => validatePkg({ meta: { name: "空包" }, payload: {} })).toThrow(/没有任何内容/);
    // 任一部分存在即通过
    const p = validatePkg({
      meta: { name: "仅协议" },
      payload: { templates: { templates: [], groups: {} } },
    });
    expect(p.payload.controls).toBeUndefined();
    expect(p.meta.createdAt).toBe(0);
  });
});

describe("Operator 包 3D 面板设置（P71）", () => {
  const plot3d: Plot3DSettings = {
    axisX: "ax",
    axisY: "ay",
    axisZ: "az",
    colorBy: "time",
    colorCh: "",
    fade: 60,
    style: "line+points",
    density: "high",
    autoRotate: false,
    follow: false,
    showGrid: true,
    gridDensity: "std",
    keyFlight: false,
    zoomToCursor: false,
    calibMode: false, // 校准操作态在导出侧（exportSettingsForPkg）已剥离
    pairMode: "interp", // P75 B2
    pairTolMs: 0,
    axisScale: "uniform",
  };

  it("plot3d 段校验：对象通过并往返一致；非对象拒绝", () => {
    const p = validatePkg({ meta: { name: "x" }, payload: { plot3d } });
    expect(p.payload.plot3d).toEqual(plot3d);
    expect(() => validatePkg({ meta: { name: "x" }, payload: { plot3d: "no" } })).toThrow(/3D 面板/);
    // 缺省跳过（旧包兼容）
    expect(
      validatePkg({ meta: { name: "x" }, payload: { commands: [] } }).payload.plot3d,
    ).toBeUndefined();
  });

  it("buildPkgFile 深拷贝隔离 plot3d 段", () => {
    const file = buildPkgFile({
      meta: { name: "x", description: "", createdAt: 0, appVersion: "" },
      payload: { plot3d },
    });
    file.data.payload.plot3d!.axisX = "changed";
    expect(plot3d.axisX).toBe("ax");
  });
});
