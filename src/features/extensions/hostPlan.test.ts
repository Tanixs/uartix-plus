/**
 * P174-A3：起宿主前的参数装配判据。
 *
 * 这些用例针对的不是"能不能拼出字符串"，而是三种**启动前就该拦住**的情形：
 * 没 main、没 node、要工作区却没登记。它们如果漏过去，表现分别是
 * "白占内存"、"在别人的旧 node 上跑出怪行为"、"插件一写文件就 EACCES"——
 * 三种都极难从现象反推原因。
 */
import { describe, expect, it } from "vitest";
import { validateExtension, type ExtensionManifest } from "./manifest";
import { HostPlanError, planHostStart } from "./hostPlan";

const APP = "C:/Users/x/AppData/Roaming/uartix";

function manifest(over: Record<string, unknown> = {}): ExtensionManifest {
  const r = validateExtension({
    format: "uartix-extension",
    schemaVersion: 3,
    id: "user.yolo.workbench",
    version: "1.0.0",
    name: "YOLO 训练工作台",
    main: "main.mjs",
    activation: ["onPanel:workbench"],
    permissions: { fs: { read: ["$WS/**"], write: ["$WS"] }, ui: { panel: true } },
    contributes: { panels: [{ id: "workbench", title: "YOLO", entry: "panel/index.html" }] },
    ...over,
  });
  expect(r.errors).toEqual([]);
  return r.manifest!;
}

const BASE = {
  appDir: APP,
  scriptPath: `${APP}/ext-host/bootstrap.mjs`,
  nodePath: "C:/Program Files/nodejs/node.exe",
  token: "tok-1",
};

describe("P174-A3 · 装配", () => {
  it("正常装配：handle 是插件 id、args 来自 manifest、cwd 落在工作区", () => {
    const plan = planHostStart({
      ...BASE,
      manifest: manifest(),
      bind: { workspace: "D:/YOLO-Workspace", appDir: APP, extra: {} },
    });
    expect(plan.handle).toBe("user.yolo.workbench");
    expect(plan.pluginDir).toBe(`${APP}/extensions/user.yolo.workbench`);
    expect(plan.cwd).toBe("D:/YOLO-Workspace");
    expect(plan.args).toContain("--permission");
    expect(plan.args).toContain("--allow-fs-read=*");
    expect(plan.args).toContain("--allow-fs-write=D:/YOLO-Workspace");
    expect(plan.args).toContain("--allow-child-process");
    // 引导脚本与插件目录由 Rust 侧拼在 args 之后，这里不能混进 args
    expect(plan.args.some((a) => a.includes("bootstrap.mjs"))).toBe(false);
  });

  it("没有 main 直接拒（纯声明式插件不该起进程）", () => {
    const m = manifest({ main: undefined, activation: [], permissions: { ui: { panel: true } } });
    expect(() => planHostStart({ ...BASE, manifest: m, bind: { workspace: "", appDir: APP, extra: {} } })).toThrow(
      HostPlanError,
    );
    try {
      planHostStart({ ...BASE, manifest: m, bind: { workspace: "", appDir: APP, extra: {} } });
    } catch (e) {
      expect((e as HostPlanError).code).toBe("no_main");
    }
  });

  it("没配 node 时拒，并把「去哪儿配」写进错误里", () => {
    try {
      planHostStart({
        ...BASE,
        nodePath: "   ",
        manifest: manifest(),
        bind: { workspace: "D:/W", appDir: APP, extra: {} },
      });
      throw new Error("应该抛");
    } catch (e) {
      expect((e as HostPlanError).code).toBe("no_node");
      expect((e as Error).message).toContain("设置");
    }
  });

  it("要工作区却没登记 ⇒ 启动前拒（否则插件一写就 EACCES，现象指错方向）", () => {
    try {
      planHostStart({ ...BASE, manifest: manifest(), bind: { workspace: "", appDir: APP, extra: {} } });
      throw new Error("应该抛");
    } catch (e) {
      expect((e as HostPlanError).code).toBe("no_workspace");
      expect((e as Error).message).toContain("工作区");
    }
  });

  it("不碰工作区的插件可以在没选工作区时启动，cwd 退回插件目录", () => {
    const m = manifest({ permissions: { ui: { panel: true } } });
    const plan = planHostStart({ ...BASE, manifest: m, bind: { workspace: "", appDir: APP, extra: {} } });
    expect(plan.cwd).toBe(`${APP}/extensions/user.yolo.workbench`);
    expect(plan.args.some((a) => a.startsWith("--allow-fs-write="))).toBe(false);
  });
});
