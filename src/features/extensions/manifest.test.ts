/**
 * P174-A：s3 清单校验器与宿主命令行的判据钉。
 *
 * 这些用例不是"覆盖率凑数"，每一条都对应详设里一个会被代码反驳的断言：
 * - §5.7 旧格式拒装且**说得出原因**（不是"校验失败"）；
 * - §5.4 `--allow-fs-write` 只吃目录、`--allow-fs-read` 只能是 `*`；
 * - §5.8 L3 不许隐藏用户自救入口；
 * - §5.1 没有 `main` 就不该声明需要代码的权限。
 */
import { describe, expect, it } from "vitest";
import {
  EXT_FORMAT,
  EXT_SCHEMA_VERSION,
  NEVER_HIDEABLE_PANELS,
  PANEL_SLOTS,
  buildHostNodeArgs,
  expandPathSpec,
  isLegacyPackage,
  usesWorkspace,
  validateExtension,
  type ExtensionManifest,
  type PathVarBinding,
} from "./manifest";
import { flattenPermissions } from "./repo";

/** 一份最小可用的 s3 清单。各用例只改自己关心的那几格。 */
function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: EXT_FORMAT,
    schemaVersion: EXT_SCHEMA_VERSION,
    id: "user.yolo.workbench",
    version: "1.0.0",
    name: "YOLO 训练工作台",
    main: "main.mjs",
    activation: ["onPanel:workbench"],
    permissions: { fs: { read: ["$WS/**"], write: ["$WS"] }, ui: { panel: true } },
    contributes: { panels: [{ id: "workbench", title: "YOLO", entry: "panel/index.html" }] },
    ...over,
  };
}

function okManifest(over: Record<string, unknown> = {}): ExtensionManifest {
  const r = validateExtension(base(over));
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  return r.manifest!;
}

const BIND: PathVarBinding = {
  workspace: "D:\\YOLO-Workspace",
  appDir: "C:\\Users\\x\\AppData\\Roaming\\uartix",
  extra: { deploy: "D:\\OneDrive\\deploy" },
};

describe("P174-A · 旧格式拒装", () => {
  it("uartix-plugin / s2 被识别为旧格式，且错误里说的是「不再支持」而不是「校验失败」", () => {
    const legacy = {
      format: "uartix-plugin",
      schemaVersion: 2,
      id: "user.theme.x",
      version: "1.0.0",
      name: "旧主题",
      capabilities: ["theme.tokens"],
      artifacts: {},
    };
    expect(isLegacyPackage(legacy)).toBe(true);
    const r = validateExtension(legacy);
    expect(r.ok).toBe(false);
    expect(r.legacy).toBe(true);
    expect(r.errors[0]).toContain("不再支持");
    // 不许退化成一句冷冰冰的字段错误
    expect(r.errors.join("")).not.toMatch(/schemaVersion 必须是 3/);
  });

  it("旧格式判定优先于一切：哪怕它同时缺 main、缺 id，也只说「旧格式」这一句", () => {
    const r = validateExtension({ format: "uartix-plugin", schemaVersion: 2 });
    expect(r.errors).toHaveLength(1);
    expect(r.legacy).toBe(true);
  });

  it("新格式不会被误判成旧格式", () => {
    expect(isLegacyPackage(base())).toBe(false);
  });
});

describe("P174-A · 标识与入口", () => {
  it("id 必须点分小写；version 必须 semver", () => {
    expect(validateExtension(base({ id: "Yolo" })).errors.join("")).toContain("小写点分");
    expect(validateExtension(base({ version: "1.0" })).errors.join("")).toContain("semver");
  });

  it("main 只认 .mjs/.js/.cjs 且必须是包内相对路径", () => {
    expect(validateExtension(base({ main: "main.ts" })).errors.join("")).toContain(".mjs");
    expect(validateExtension(base({ main: "../evil.mjs" })).errors.join("")).toContain("相对路径");
    expect(validateExtension(base({ main: "C:/x/main.mjs" })).errors.join("")).toContain("相对路径");
  });

  it("没有 main 却声明 activation：装的时候就拒（否则启用才知道跑不起来）", () => {
    const r = validateExtension(base({ main: undefined, activation: ["onPanel:workbench"] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain("没有可执行的入口");
  });

  it("有 main 但没 activation 只给警告，不拦", () => {
    const r = validateExtension(base({ activation: undefined }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join("")).toContain("不会自动激活");
  });
});

describe("P174-A · 权限的形状：写是目录，读是告知", () => {
  it("fs.write 带通配会被拒——它要直接当 --allow-fs-write 的参数", () => {
    for (const bad of ["$WS/**", "$WS/*", "$WS/runs/*"]) {
      const r = validateExtension(base({ permissions: { fs: { write: [bad] }, ui: { panel: true } } }));
      expect(r.ok, bad).toBe(false);
      expect(r.errors.join("")).toContain("必须是目录");
    }
  });

  it("路径必须用变量开头，不许写死绝对路径（换机器就废）", () => {
    const r = validateExtension(base({ permissions: { fs: { write: ["D:/YOLO"] }, ui: { panel: true } } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain("$WS");
  });

  it(".. 一律拒", () => {
    const r = validateExtension(base({ permissions: { fs: { read: ["$WS/../Windows"] }, ui: { panel: true } } }));
    expect(r.errors.join("")).toContain("..");
  });

  it("spawn 只收裸程序名，不收路径（避免有人以为这能锁可执行文件）", () => {
    const r = validateExtension(
      base({ permissions: { ui: { panel: true }, process: { spawn: ["C:/Python/python.exe"] } } }),
    );
    expect(r.errors.join("")).toContain("裸程序名");
  });

  it("纯声明式插件（无 main）不许声明需要代码的权限", () => {
    const r = validateExtension(
      base({
        main: undefined,
        activation: [],
        permissions: { ui: { panel: true }, process: { spawn: ["python"] } },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain("纯声明式插件");
  });
});

describe("P174-A · L2/L3 的接入口是固定的", () => {
  it("插槽名不在登记表里就拒，并列出可选项", () => {
    const r = validateExtension(
      base({
        inject: { sections: [{ slot: "whatever.side", id: "x", title: "X", entry: "a.html" }] },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain(PANEL_SLOTS[0]);
  });

  it("合法插槽能过，且 entry 必须是包内相对路径", () => {
    const m = okManifest({
      inject: { sections: [{ slot: "serial.side", id: "yolo-result", title: "识别", entry: "panel/r.html" }] },
    });
    expect(m.inject.sections?.[0].slot).toBe("serial.side");
    const bad = validateExtension(
      base({ inject: { sections: [{ slot: "serial.side", id: "sec", title: "A", entry: "../x.html" }] } }),
    );
    expect(bad.errors.join("")).toContain("相对路径");
  });

  it("**用户自救入口不许隐藏**：每一条都单独验，防止以后漏配", () => {
    for (const target of NEVER_HIDEABLE_PANELS) {
      const r = validateExtension(base({ inject: { mutations: [{ target, op: "hide" }] } }));
      expect(r.ok, target).toBe(false);
      expect(r.errors.join("")).toContain("自救入口");
    }
  });

  it("非白名单面板可以 hide；retitle/move 对白名单面板也放行（只禁 hide）", () => {
    expect(okManifest({ inject: { mutations: [{ target: "hex", op: "hide" }] } }).inject.mutations).toHaveLength(1);
    const r = validateExtension(
      base({ inject: { mutations: [{ target: "settings", op: "retitle", title: "设置" }] } }),
    );
    expect(r.ok).toBe(true);
  });

  it("要贡献面板却没说 ui.panel：拒（能力与贡献对不上）", () => {
    const r = validateExtension(base({ permissions: { fs: { read: ["$WS/**"] } } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain("permissions.ui.panel");
  });
});

describe("P174-A · 变量展开", () => {
  it("$WS / $APP / $EXT 按绑定展开；未绑定返回 null（宁可不给，不给错的）", () => {
    expect(expandPathSpec("$WS", BIND)).toBe("D:/YOLO-Workspace");
    expect(expandPathSpec("$WS/runs/", BIND)).toBe("D:/YOLO-Workspace/runs");
    expect(expandPathSpec("$APP/ext", BIND)).toBe("C:/Users/x/AppData/Roaming/uartix/ext");
    expect(expandPathSpec("$EXT:deploy", BIND)).toBe("D:/OneDrive/deploy");
    expect(expandPathSpec("$EXT:nope", BIND)).toBeNull();
    expect(expandPathSpec("$WS", { ...BIND, workspace: "" })).toBeNull();
  });
});

describe("P174-A10 · 插件贡献主题", () => {
  const withTheme = (extra: Record<string, unknown> = {}, perm: Record<string, unknown> = { ui: { theme: true } }) =>
    validateExtension({
      format: "uartix-plugin",
      schemaVersion: 3,
      id: "a.b",
      version: "1.0.0",
      name: "x",
      main: "main.mjs",
      activation: ["onPanel:p"],
      permissions: perm,
      contributes: { panels: [], themes: [{ id: "seaglass", title: "海玻璃", entry: "theme.css" }] },
      ...extra,
    });

  it("要贡献主题就必须声明 permissions.ui.theme（改了界面就得在批准卡上说出来）", () => {
    const ok = withTheme();
    expect(ok.ok, ok.errors.join("；")).toBe(true);
    expect(ok.manifest?.contributes.themes?.[0]).toEqual({ id: "seaglass", title: "海玻璃", entry: "theme.css" });

    const bad = withTheme({}, {});
    expect(bad.ok).toBe(false);
    expect(bad.errors.join("")).toContain("permissions.ui.theme");
  });

  it("条目字段：id 必须合法且不重复、entry 必须是包内相对路径、scheme 只认 dark/light", () => {
    const cases: [string, unknown[]][] = [
      ["id 非法", [{ id: "Bad Id", title: "x", entry: "a.css" }]],
      ["entry 越界", [{ id: "a", title: "x", entry: "../a.css" }]],
      ["scheme 乱写", [{ id: "a", title: "x", entry: "a.css", scheme: "auto" }]],
      ["重复 id", [{ id: "a", title: "x", entry: "a.css" }, { id: "a", title: "y", entry: "b.css" }]],
    ];
    for (const [what, themes] of cases) {
      const r = validateExtension({
        format: "uartix-plugin",
        schemaVersion: 3,
        id: "a.b",
        version: "1.0.0",
        name: "x",
        main: "main.mjs",
        activation: ["onPanel:p"],
        permissions: { ui: { theme: true } },
        contributes: { panels: [], themes },
      });
      expect(r.ok, `${what} 应当被拒`).toBe(false);
    }
  });

  it("标题缺省时用 id（不给空的标题去渲染选择器）", () => {
    const r = withTheme({ contributes: { panels: [], themes: [{ id: "only-id", entry: "a.css" }] } });
    expect(r.ok, r.errors.join("；")).toBe(true);
    expect(r.manifest?.contributes.themes?.[0].title).toBe("only-id");
  });

  it("批准卡上要把「改界面主题」单列出来（装完发现配色自己变了最说不清）", () => {
    const r = withTheme();
    expect(flattenPermissions(r.manifest!)).toContain("改界面主题（海玻璃）");
  });
});

describe("P174-A8 · 谁需要工作区根", () => {
  const m = (permissions: Record<string, unknown>) =>
    validateExtension({
      format: "uartix-plugin",
      schemaVersion: 3,
      id: "a.b",
      version: "1.0.0",
      name: "x",
      main: "main.mjs",
      activation: ["onPanel:p"],
      permissions,
      contributes: { panels: [] },
    });

  it("写 $WS 或读 $WS 都算需要（只读的扩展没工作区同样跑不了）", () => {
    expect(usesWorkspace(m({ fs: { write: ["$WS/runs"] } }).manifest!)).toBe(true);
    expect(usesWorkspace(m({ fs: { read: ["$WS"] } }).manifest!)).toBe(true);
  });

  it("只写 $APP/自己包内 ⇒ 不需要（别让无关扩展也去要工作区）", () => {
    expect(usesWorkspace(m({ fs: { write: ["$APP/logs"] } }).manifest!)).toBe(false);
    expect(usesWorkspace(m({}).manifest!)).toBe(false);
  });

  it("$WSX 这种前缀相似的不算（必须整段相等或以 $WS/ 开头）", () => {
    // 校验器本来就会拒这种写法，这里直接构造一个已通过校验的清单再改字段来钉判据
    const base = m({ fs: { write: ["$APP/x"] } }).manifest!;
    expect(usesWorkspace({ ...base, permissions: { fs: { write: ["$WSX/y"] } } })).toBe(false);
  });
});

describe("P174-A · 宿主命令行（牢笼落地处）", () => {
  it("必须给 --allow-fs-read=*（Windows 上精确读白名单不生效，详设 §5.4 有实测）", () => {
    const args = buildHostNodeArgs(okManifest(), BIND);
    expect(args).toContain("--permission");
    expect(args).toContain("--allow-fs-read=*");
    expect(args.some((a) => a.startsWith("--allow-fs-read=") && a !== "--allow-fs-read=*")).toBe(false);
  });

  it("--allow-child-process 无条件给（不按名单拦，就别留声明坑）", () => {
    expect(buildHostNodeArgs(okManifest(), BIND)).toContain("--allow-child-process");
  });

  it("写目录一条一条展开，去重；没有写声明时**干脆不给这个参数**", () => {
    const m = okManifest({
      permissions: { fs: { write: ["$WS", "$WS/runs", "$WS"] }, ui: { panel: true } },
    });
    const writeArgs = buildHostNodeArgs(m, BIND).filter((a) => a.startsWith("--allow-fs-write="));
    expect(writeArgs).toEqual(["--allow-fs-write=D:/YOLO-Workspace", "--allow-fs-write=D:/YOLO-Workspace/runs"]);

    const noWrite = okManifest({ permissions: { fs: { read: ["$WS/**"] }, ui: { panel: true } } });
    expect(buildHostNodeArgs(noWrite, BIND).some((a) => a.startsWith("--allow-fs-write="))).toBe(false);
  });

  it("变量没登记时跳过该条，不生成空路径或错路径", () => {
    const m = okManifest({
      permissions: { fs: { write: ["$EXT:deploy"] }, ui: { panel: true } },
    });
    const args = buildHostNodeArgs(m, { ...BIND, extra: {} });
    expect(args.some((a) => a.startsWith("--allow-fs-write="))).toBe(false);
  });
});
