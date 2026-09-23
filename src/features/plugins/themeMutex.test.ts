/**
 * P99b-N5 · 主题互斥的**入口收敛**（详设 §7 G2/G5）。
 *
 * 为什么单独一个文件、而且用真 store：`enabled` 这个事实只有一个写入者（`pluginStore`），
 * 拿 mock 测它等于什么都没测——P99a-D1c 那次清退"看着像门、其实没人查"的控件，立的同一条规矩。
 * 这里断言的是**副作用真的发生了**：另一枚的状态落到 disabled、它的投影被摘掉、回执点名了它。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const stubStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));

const store = await import("./pluginStore");
const extStore = await import("../ai/extensionStore");

const themePkg = (id: string, name = "主题") => ({
  format: "uartix-plugin",
  schemaVersion: 2,
  id,
  version: "0.1.0",
  name,
  hostApi: "^1.0",
  capabilities: ["theme.tokens"],
  contributions: { themes: [{ id: "main", entry: "main.json" }] },
  artifacts: { "main.json": { kind: "theme", vars: { "--accent": "#123456" } } },
  provenance: { createdBy: "user", reviewed: false },
});

const widgetPkg = (id: string) => ({
  format: "uartix-plugin",
  schemaVersion: 2,
  id,
  version: "0.1.0",
  name: "小部件",
  hostApi: "^1.0",
  capabilities: ["ui.widget", "telemetry.read"],
  contributions: { widgets: [{ id: "w", entry: "w.json" }] },
  artifacts: { "w.json": { kind: "widget", format: "html", html: "<b>hi</b>" } },
  provenance: { createdBy: "user", reviewed: false },
});

function install(manifest: Record<string, unknown>) {
  const s = store.stagePackage(manifest);
  expect(s.ok, JSON.stringify(s.errors)).toBe(true);
  const inst = store.installStaged(s.stagingId!);
  expect(inst.ok).toBe(true);
  return inst.id!;
}

beforeEach(() => {
  for (const r of store.getSnapshot().plugins) void store.uninstall(r.pkg.id);
  for (const e of extStore.getSnapshot().exts) extStore.removeProjection(e.id);
});

describe("P99b-N5 · 启用第二枚主题 ⇒ 第一枚当场落地停用（G2）", () => {
  it("库里不会同时有两枚亮着的主题开关；回执点名被挤掉的那枚", () => {
    const a = install(themePkg("user.theme.a", "甲主题"));
    const b = install(themePkg("user.theme.b", "乙主题"));
    expect(store.setEnabled(a, true).ok).toBe(true);
    const r = store.setEnabled(b, true);
    expect(r.ok).toBe(true);
    expect(store.getPlugin(a)?.state, "入口不收敛，就留给渲染层去\"挑一枚\"，那是第二真相").toBe("disabled");
    expect(store.getPlugin(b)?.state).toBe("enabled");
    expect(r.msg).toContain("甲主题");
    expect(r.msg).toContain("互斥");
  });

  it("被挤掉那一枚的投影真的摘干净了（不是只改状态、扩展还挂在运行时里）", () => {
    const a = install(themePkg("user.theme.c"));
    const b = install(themePkg("user.theme.d"));
    store.setEnabled(a, true);
    const sidA = store.shadowExtId(a, "main");
    expect(extStore.getExt(sidA)).toBeTruthy();
    store.setEnabled(b, true);
    expect(extStore.getExt(sidA), "状态说停用了、扩展还在画，就是界面与台账各说一套").toBeUndefined();
  });

  it("不带主题产物的包不参与互斥（停小部件不该连带干掉主题）", () => {
    const t = install(themePkg("user.theme.e"));
    const w = install(widgetPkg("user.widget.f"));
    store.setEnabled(t, true);
    store.setEnabled(w, true);
    expect(store.getPlugin(t)?.state).toBe("enabled");
    expect(store.getPlugin(w)?.state).toBe("enabled");
  });

  it("停用那枚在画的主题 ⇒ 回到设置里选中的内置（互斥不许把用户留在\"谁都没画\"的状态）", () => {
    const a = install(themePkg("user.theme.g"));
    store.setEnabled(a, true);
    const r = store.setEnabled(a, false);
    expect(r.ok).toBe(true);
    expect(extStore.getSnapshot().exts.filter((e) => e.type === "theme" && e.enabled)).toEqual([]);
  });
});

describe("P99b-N5 · 内置那八枚不在这套生命周期里（R3）", () => {
  it("内置 id 拿去启用/停用/卸载一律拒绝——它们不是插件记录，没有可摘的投影", () => {
    for (const id of ["begonia", "dark", "light", "system"]) {
      expect(store.setEnabled(id, true).ok, `${id} 不该是个插件`).toBe(false);
      expect(store.setEnabled(id, false).ok).toBe(false);
      expect(store.uninstall(id).ok, `卸载逻辑碰到了内置 ${id}`).toBe(false);
    }
  });

  it("卸载路径的源码里不许出现内置 id（防止以后有人为\"重置外观\"顺手删内置）", async () => {
    const fsSpec = "node:fs";
    const urlSpec = "node:url";
    const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
    const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
    const src = readFileSync(fileURLToPath(new URL("./pluginStore.ts", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("export function uninstall"));
    for (const id of ["begonia", "glaze", "matcha", "\"dark\"", "\"light\""]) {
      expect(body, `卸载函数里出现了内置 id：${id}`).not.toContain(id);
    }
  });
});

describe("P99b-N5 · 主题产物枚举只有一处（§8-48）", () => {
  it("themeArtsOf 认得带 theme 的包，且不认别的产物", () => {
    const arts = store.themeArtsOf(themePkg("user.theme.h") as never);
    expect(arts.map((a) => a.entryId)).toEqual(["main"]);
    expect(arts[0].extId).toBe(store.shadowExtId("user.theme.h", "main"));
    expect(store.themeArtsOf(widgetPkg("user.widget.i") as never)).toEqual([]);
    expect(store.themeBearingPackages().map((r) => r.pkg.id)).toEqual([]);
    const id = install(themePkg("user.theme.j"));
    store.setEnabled(id, true);
    expect(store.themeBearingPackages().map((r) => r.pkg.id)).toEqual([id]);
  });
});
