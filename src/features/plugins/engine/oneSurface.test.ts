/**
 * P174-R7：这一轮定下来的**形状**，做成会红的门。
 *
 * 为什么要有这个文件：R7 的全部价值就是"一件事只有一个地方能做"。而这类形状
 * 恰好是最容易悄悄退回去的——下一个人加面板时不知道历史上为什么只有一面，
 * 复制一份列表就又是一个管理面；把日志塞回设置页详情也只是加一个 fold；
 * 给 `bindRoot` 多开一处"顺便写一下绑定"就废了那条确认。
 * 这些回退都不会让任何功能变坏，只会让用户重新面对"到底去哪儿看、谁真的批了"。
 * 所以钉形状，而不是钉功能。
 */

import { describe, expect, it } from "vitest";

// 读源码而不是 import：这些文件一被 import 就要拉 Tauri 的 invoke，测试环境里没有那层。
const fsSpec = "node:fs";
const pathSpec = "node:path";
const urlSpec = "node:url";
const { existsSync, readFileSync, readdirSync } = (await import(fsSpec)) as unknown as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc?: string) => string;
  readdirSync: (p: string) => string[];
};
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function engineFile(name: string): string {
  return readFileSync(join(here, name), "utf8");
}

/** `engine/` 下所有**真的调用了**某个符号的源文件（测试文件跳过）。 */
function filesCalling(call: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(here)) {
    if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
    if (engineFile(name).includes(call)) out.push(name);
  }
  return out.sort();
}

/**
 * 只数**界面**（.tsx）。
 *
 * 为什么这条门要按"面"数而不是按"文件"数：写路径本身当然可以有多个调用方
 * （`pluginEngine.ts` 是定义处，`marketClient.ts` / `profiles.ts` 是非 UI 的编排层），
 * 这一轮要钉的是**第二张管理面不许出现**——那才会让用户重新去猜"到底在哪儿点"。
 */
function uiCalling(call: string): string[] {
  return filesCalling(call).filter((n) => n.endsWith(".tsx"));
}

describe("R7① 一套插件管理面，长在设置页", () => {
  it("dock 里那面整块删掉了（不是留着当第二个入口）", () => {
    expect(existsSync(join(here, "PluginEnginePanel.tsx"))).toBe(false);
  });

  it("extruntime 退役，注册表里只说「并走了」", () => {
    const menu = read("src/panels/panelMenu.ts");
    expect(menu).toMatch(/RETIRED_PANELS[^;]*extruntime/);
    const panels = read("src/panels/panels.tsx");
    expect(panels).toContain("<RetiredPanel");
    expect(panels).not.toContain("PluginEnginePanel");
  });

  it("安装与批准这条写路只有一个组件引用者", () => {
    // 判据是**真的调用了安装**（`commitInstall(`），不是提到过这个名字：
    // `PluginVersions` 的注释里就有它，那只是「回滚也走同一张批准卡」的说明。
    expect(uiCalling("commitInstall(")).toEqual(["PluginEngineSection.tsx"]);
    expect(engineFile("PluginEngineSection.tsx")).toContain("approve,");
  });

  it("目录绑定（判据的落点）在设置页里，不在任何运行面里", () => {
    expect(engineFile("PluginEngineSection.tsx")).toContain("<WorkspaceRootRow");
    expect(engineFile("PluginEngineSection.tsx")).toContain("<PluginRootsFold");
    // 只列清单声明过的键：凭空让用户绑一个用不上的键是噪音
    expect(engineFile("PluginRootsSection.tsx")).toContain("declaredRootKeys");
  });

  it("指路的两句用户文案指向 设置 → 插件管理，不再指向已退役的那一面", () => {
    const plan = read("src/features/plugins/engine/hostPlan.ts");
    expect(plan).toContain("在 设置 → 插件管理 顶部选一个工作区根");
    expect(plan).toContain("在 设置 → 插件管理 里这个插件的「目录绑定」");
    expect(plan).not.toContain("「插件」面板顶部");
  });
});

describe("R7② 诊断自成一面，且不并进串口数据面", () => {
  it("output 面板：id、注册表、菜单分组三处齐", () => {
    expect(read("src/ipc/types.ts")).toContain('| "output"');
    const panels = read("src/panels/panels.tsx");
    expect(panels).toContain("MOutput");
    expect(panels).toMatch(/output: \(\) =>/);
    expect(read("src/panels/panelMenu.ts")).toMatch(/ids: \[[^\]]*"output"/);
  });

  it("两个通道而不是一个总线：宿主输出 + 操作账本", () => {
    const model = engineFile("outputModel.ts");
    expect(model).toContain('id: "host"');
    expect(model).toContain('id: "ledger"');
  });

  it("账本每一类事件都在这一面有话说（漏一类就是这一面少一段历史）", () => {
    const model = engineFile("outputModel.ts");
    // 种类从 `journal.ts` 现取，不在这份测试里再抄一份清单——抄的那份迟早和真的那份分家
    const journal = read("src/features/plugins/engine/journal.ts");
    const kinds = [...new Set([...journal.matchAll(/^ {4}case "([a-z]+)":/gm)].map((m) => m[1]))];
    expect(kinds.length).toBeGreaterThanOrEqual(9);
    for (const k of kinds) expect(model, k).toContain(`case "${k}"`);
  });

  it("宿主日志真的落盘（`logs` 目录不再是空声明）", () => {
    const sink = engineFile("hostLogsSink.ts");
    expect(sink).toContain("plugin_fs_append");
    expect(sink).toContain("logs/host.log");
    expect(read("src-tauri/src/plugin_fs.rs")).toContain("pub fn plugin_fs_append");
    expect(read("src-tauri/src/lib.rs")).toContain("plugin_fs::plugin_fs_append");
  });

  it("轮转保尾不保头（这条是整个函数存在的理由）", () => {
    expect(read("src-tauri/src/plugin_fs.rs")).toContain("fs::write(p, &bytes[cut..])");
  });

  it("插件面板调用前先等宿主就绪（不是「没跑就报错」）", () => {
    const panel = engineFile("PluginViewPanel.tsx");
    expect(panel.indexOf("await ensureRunning(pluginId)")).toBeLessThan(panel.indexOf("callExt(pluginId,"));
  });
});

describe("R7④ 场景降级成一节，名字不再一个词三个意思", () => {
  it("profiles 也退役了：编辑在设置页，切换走命令面板", () => {
    expect(read("src/panels/panelMenu.ts")).toMatch(/RETIRED_PANELS[^;]*profiles/);
    const panels = read("src/panels/panels.tsx");
    expect(panels).not.toContain("MProfiles");
    // R14：工作场景搬进了设置页自己的一个整页（不再塞在插件页底部）
    const settings = read("src/features/settings/SettingsModal.tsx");
    expect(settings).toContain("<ProfilesPanel");
    expect(settings).toContain('key: "profiles"');
    expect(engineFile("PluginEngineSection.tsx")).not.toContain("<ProfilesPanel");
  });

  it("场景的英文名不再抢「Workspaces」这个词（它指的是工作区根）", () => {
    for (const f of ["src/panels/panels.tsx", "src/shell/commandRegistry.ts", "src/features/plugins/engine/ProfilesPanel.tsx"]) {
      expect(read(f), f).not.toContain('"工作场景", "Workspaces"');
    }
    expect(read("src/App.tsx")).not.toContain("Apply workspace:");
  });
});

describe("R12 草稿先看再给：预览不装不跑，主进程缺失不再死循环", () => {
  it("面板挂载时：没有 main 不起进程，且同一版本只自动拉一次", () => {
    const panel = engineFile("PluginViewPanel.tsx");
    expect(panel).toContain("if (!entry.manifest.main) return;");
    expect(panel).toContain("startTried.current === key");
  });

  it("ensureRunning 对无 main 的插件直接说清楚，不去撞 hostPlan", () => {
    const engine = engineFile("pluginEngine.ts");
    expect(engine).toContain("这个插件只有界面、没有主进程");
  });

  it("草稿行有「预览」，且预览不启动主进程（同一套沙箱、只读）", () => {
    const section = engineFile("PluginEngineSection.tsx");
    expect(section).toContain("<DraftPreviewDialog");
    const dlg = engineFile("DraftPreviewDialog.tsx");
    expect(dlg).toContain("预览里不启动主进程");
    expect(dlg).toContain("buildSrcdoc");
    expect(dlg).toContain("readDraftFile");
    // 越界读与写都必须被拒
    expect(dlg).toContain("预览是只读的");
  });
});

describe("R8 AI 能力面：造出来的东西要能被它自己用上", () => {
  it("openPanel 认插件面板（同一道门），不是只认内置 id", () => {
    const acts = read("src/features/ai/appActions.ts");
    expect(acts).toContain("PLUGIN_VIEW_PREFIX");
    expect(acts).toContain("pluginPanelTarget(");
    const bridge = engineFile("panelBridge.ts");
    expect(bridge).toContain("export function pluginPanelTarget");
    // 三道"打不开"要分得清：没装 / 没启用 / 没这块
    expect(bridge).toContain("没有这个插件");
    expect(bridge).toContain("还没启用或权限没批准");
    expect(bridge).toContain("没有这个面板");
  });

  it("AI 能把用户带到该点的那一页（openSettings），且 tab 有白名单", () => {
    expect(read("src/features/ai/appActionKinds.ts")).toContain('"openSettings"');
    expect(read("src/features/ai/appActions.ts")).toContain("case \"openSettings\"");
    expect(read("src/features/ai/appBus.ts")).toContain("requestOpenSettings");
    expect(read("src/App.tsx")).toContain('new Set(["general", "appearance", "workspace", "plugins"');
    expect(read("src/features/agent/toolCatalog.ts")).toContain("openSettings:");
  });

  it("ui_inventory 的面板清单认得插件面板（否则模型不知道它造的东西存在）", () => {
    const surface = read("src/features/agent/uiSurface.ts");
    expect(surface).toContain("collectPluginPanels");
    expect(surface).toContain("插件面板");
  });

  it("提示词写明了三件事：插件面板 id、交接动作、发布边界", () => {
    const prompts = read("src/features/ai/prompts.ts");
    expect(prompts).toContain("plugin-view-<插件id>:<面板id>");
    expect(prompts).toContain("openSettings");
    expect(prompts).toContain("发布到插件市场（GitHub 话题）是**用户的动作**");
    expect(prompts).toContain("theme_patch/style_patch 只是本次会话的临时层");
  });
});

describe("R7③ 目录绑定只有一个落笔处，确认只有一条", () => {
  it("写绑定只有一处界面：那一栏；场景走的是同一对 setter，不是另一张面", () => {
    // 插件面板里的 bindRoot 只登记一条**待确认**，它自己不写任何登记
    expect(uiCalling("setWorkspaceRoot(")).toEqual(["PluginRootsSection.tsx"]);
    expect(uiCalling("setExternalRoot(")).toEqual(["PluginRootsSection.tsx"]);
    // 非界面那一侧也只有两处真写者：引擎定义处自己 + 场景编排（都从同一对导出走）
    expect(filesCalling("setWorkspaceRoot(")).toEqual(["PluginRootsSection.tsx", "pluginEngine.ts", "profiles.ts"]);
    const panel = engineFile("PluginViewPanel.tsx");
    expect(panel).toContain("requestRootBind(");
    expect(panel).not.toContain("setWorkspaceRoot(");
    expect(panel).not.toContain("setExternalRoot(");
  });

  it("宿主侧三道闸都在：清单声明、可用状态、用户确认", () => {
    const panel = engineFile("PluginViewPanel.tsx");
    expect(panel).toContain("rootSpecDeclared(cur.manifest, spec)");
    expect(panel).toContain("panelEnabled(cur)");
    const fold = engineFile("PluginRootsSection.tsx");
    expect(fold).toContain("takeRootBind(");
    expect(fold).toContain('role="alert"');
    // 确认条只有一处：它不该再长在插件面板里（被授权的一方不能自己弹"您同意授权吗"）
    expect(panel).not.toContain("批准绑定");
  });

  it("桥只收清单那种整形，且这个形状与账本同源", () => {
    expect(engineFile("panelBridge.ts")).toContain("ROOT_SPEC_RE");
    expect(engineFile("journal.ts")).toContain("ROOT_SPEC_RE");
    expect(read("src/features/plugins/engine/manifest.ts")).toContain("export const ROOT_SPEC_RE");
  });

  it("AI 能造出用这条桥的插件：提示词与帮助都写明了 bindRoot", () => {
    expect(read("src/features/ai/prompts.ts")).toContain("bindRoot(");
    expect(read("src/features/help/HelpModal.tsx")).toContain("uartix.bindRoot");
  });

  it("换页面遗留的宿主会被收一次，正在跑的不会被误杀", () => {
    const engine = engineFile("pluginEngine.ts");
    // 只收"这张页面没有 token"的那些，且一个前端生命周期只收一次
    expect(engine).toContain('invoke<{ hosts: { handle: string; pid: number }[] }>("plugin_host_status")');
    expect(engine).toContain("if (tokens.has(h.handle)) continue;");
    expect(engine).toContain("if (!reclaimedOrphanHosts) {");
    // 收回要留一行日志：用户看见的是"进程没了"，得知道是谁停的
    expect(engine).toContain("收回上一张页面遗留的宿主");
  });
});
