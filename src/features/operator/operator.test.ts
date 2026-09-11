import { describe, expect, it } from "vitest";
import {
  buildPkgFile,
  filterSettings,
  OPERATOR_KIND,
  OPERATOR_VERSION,
  validatePkg,
  type OperatorPkg,
} from "./operatorPkg";

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

  it("可选部分缺省即通过（空包允许）", () => {
    const p = validatePkg({ meta: { name: "空包" }, payload: {} });
    expect(p.payload.templates).toBeUndefined();
    expect(p.meta.createdAt).toBe(0);
  });
});
