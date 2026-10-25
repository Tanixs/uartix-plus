/**
 * P174-R5：工作区预设 / 任务模板的**接线钉**（钉的是"点了真会发生什么"，不是样式）。
 *
 * 与 pluginWidgets.test 同一手法：读源文本，确保
 *  - manifest 认这两类贡献、且预设要 ui.layout；
 *  - 宿主出口存在且只走既有通道（applyLayout / pushDraft），不新造第二条；
 *  - 详情里真的渲染了这两排按钮，且要"启用+批准"才可点；
 *  - 帮助/给 AI 的话都提到这两类，且没有把"桌宠"这个旧名字带回来。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, ...p), "utf8");

const manifest = read("manifest.ts");
const actions = read("pluginHostActions.ts");
const contrib = read("pluginContrib.ts");
const section = read("PluginEngineSection.tsx");
const buttons = read("PluginContribActions.tsx");
const help = read("..", "..", "help", "HelpModal.tsx");
const draft = read("..", "..", "agent", "draftTools.ts");

describe("manifest 认这两类贡献", () => {
  it("contributes.presets / tasks 有声明，且预设必须 permissions.ui.layout", () => {
    expect(manifest).toContain("PluginPresetDecl");
    expect(manifest).toContain("PluginTaskDecl");
    expect(manifest).toContain("contributes.presets");
    expect(manifest).toContain("contributes.tasks");
    expect(manifest).toContain("permissions.ui.layout");
  });
});

describe("宿主出口只走既有通道", () => {
  it("预设用 requestApplyLayout（换前备份在 App 侧），任务用 pushDraft（只填不发送）", () => {
    expect(actions).toContain("requestApplyLayout");
    expect(actions).toContain("pushDraft");
    expect(actions).toContain("requestOpenPanel");
    // 不新造第二条换布局/发送的路：这里不许出现 fromJSON / chatStore.sendText
    expect(actions).not.toMatch(/fromJSON|sendText/);
    // 动态 import 重模块，不静态挂（§8-33）
    expect(actions).toMatch(/await import\("\.\.\/\.\.\/ai\/appBus"\)/);
  });
  it("解析判据是纯函数（不碰 IO），且明确不深校验 dockview 布局", () => {
    expect(contrib).toContain("looksLikeLayoutJson");
    expect(contrib).toContain("export function parsePresetDoc");
    expect(contrib).toContain("export function composeTaskPrompt");
  });
});

describe("详情里真的渲染，并且要启用+批准才可点", () => {
  it("PluginEngineSection 渲染了 PresetActions 组件", () => {
    expect(section).toContain("PluginContribActions");
    expect(section).toContain('usable={on && p.verdict === "trusted"}');
  });
  it("按钮：工作区预设 / 任务模板，且 disabled 由 usable 决定", () => {
    expect(buttons).toContain("工作区预设");
    expect(buttons).toContain("任务模板");
    expect(buttons).toContain("disabled={!usable");
    expect(buttons).toContain("applyPluginPreset");
    expect(buttons).toContain("loadPluginTask");
  });
});

describe("文档跟实现一致，且不把旧名字带回来", () => {
  it("帮助（对用户）说中文两类；给 AI 的话（draftTools，英文）说 workspace preset / task template", () => {
    expect(help).toContain("工作区预设");
    expect(help).toContain("任务模板");
    expect(draft).toMatch(/workspace preset/i);
    expect(draft).toMatch(/task template/i);
    for (const src of [help, draft]) {
      expect(src).not.toMatch(/桌宠|contributes\.pet|ui\.pet|onPet:/);
    }
  });
});
