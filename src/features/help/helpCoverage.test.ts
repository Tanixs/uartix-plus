/**
 * P96-M6 / 实为 P98-M6：帮助文档的防腐门禁。
 *
 * 为什么必须有：`HelpModal.tsx` 最后一次更新是 2026-09-19（P88 批），此后 P90~P97 连改六轮
 * AI 助手（布局重排、档位体系、上下文用量、界面自省、组件样式、版本链）**一行都没回写**，
 * 而 3D 页反而较新 —— 说明"哪批回了文档"完全取决于当批作者记不记得，没有机制保证。
 * 用户这次直接要求"全面优化帮助文档"，那更该做的是让它**不能再烂一次**：
 * 加了工具/档位/授权域却没写文档 ⇒ 测试红。
 *
 * 手法沿用本项目已有的"源码级对齐钉"（`messageClip.test.ts` 断言 CSS 的 max-height
 * 必须等于 JS 的 SCROLL_MAX_PX）：直接读组件源文本，不依赖渲染。
 */
import { describe, expect, it, vi } from "vitest";
// hostEntries 会把工具组（含 settingsStore/pluginStore）拉进依赖图，这些 store 在模块
// 初始化时就摸 localStorage；静态 import 会提升到 stub 之前，故用"先 stub 再 await import"。
const stubStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});
// hostEntries → uiTools → uiSurface → panels（Plot2D 在求值期就读 sessionStore，§8-33 在册）
// 与 uiTools.test / toolDisplay.test 同一手法只挡这一层。
vi.mock("../../panels/panels", () => ({ panelTitleOf: (id: string) => `标题:${id}` }));
import { DOMAINS, DOMAIN_PRESETS, DOMAIN_ZH, PRIMARY_TIERS } from "../agent/scopeTiers";
// P99a-A5：工具名清单从注册表取（`TOOL_LABEL` 那张手抄表已删）——
// 帮助覆盖检查因此跟着真实工具面走，不再跟着"有人记得抄的那份"走
const { hostEntryByName, hostEntryNames } = await import("../agent/hostEntries");

/** vitest 的 node 环境里 `import("node:fs")` 会被 vite 拦，走项目既有的一段式动态导入 */
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, enc: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string) => string };
// fileURLToPath 直接给平台路径（win 下带盘符），不需要再剥 URL 的前导斜杠
const here = fileURLToPath(import.meta.url);
const helpSrc = readFileSync(here.replace(/[/\\]features[/\\]help[/\\].*$/, "/features/help/HelpModal.tsx"), "utf8");

/**
 * 有意**不**写进帮助的工具，以及理由。
 * 这是一份例外登记表，不是第二份清单：新增工具默认必须在帮助里出现，
 * 想豁免就得在这里写清为什么——评审时看得见，不会悄悄漏。
 */
const UNDOCUMENTED_OK: Record<string, string> = {
  settings_preview_patch: "与 settings_apply 同一能力的预览态，帮助以「仅预览档」的用户语言表达，不列工具名",
  settings_describe: "模型侧的设置项目录查询，用户不需要知道这个名字",
};

/**
 * 帮助里以 `<code>snake_case</code>` 出现、但**不是 Agent 工具**的名字：MCP 侧的任务工具
 * （反向防漂移用例的豁免表；每条都要写清它为什么合法）。
 */
const DOCUMENTED_OK_NON_TOOL: Record<string, string> = {
  create_job: "MCP 任务工具，见帮助「MCP / 外部调用」节",
  get_job: "MCP 任务工具",
  wait_event: "MCP 任务工具",
  cancel_job: "MCP 任务工具",
  async_required: "MCP 长任务的回执要求，不是工具名",
  needs_manual_confirmation: "MCP 回执状态，不是工具名",
};

describe("帮助文档不得落后于实现", () => {
  it("每个授权档位的名字都出现在帮助里（改档名不收文案就是骗用户）", () => {
    for (const t of [...PRIMARY_TIERS, ...DOMAIN_PRESETS]) {
      expect(helpSrc, `帮助里没有提到档位「${t.label}」`).toContain(t.label);
    }
  });

  it("每个授权域的中文名都出现在帮助里", () => {
    for (const d of DOMAINS) {
      expect(helpSrc, `帮助里没有提到授权域「${DOMAIN_ZH[d]}」`).toContain(DOMAIN_ZH[d]);
    }
  });

  it("每个已登记的 Agent 工具名都要在帮助里出现，豁免必须写明理由", () => {
    const missing = hostEntryNames().filter(
      (name) => !helpSrc.includes(name) && !(name in UNDOCUMENTED_OK),
    );
    expect(missing, `这些工具没写进帮助：${missing.join(", ")}`).toEqual([]);
    // 豁免表也不能变成垃圾场：登记的豁免必须真的对应一个不再出现的名字
    const stale = Object.keys(UNDOCUMENTED_OK).filter((name) => helpSrc.includes(name));
    expect(stale, `豁免登记已过时（帮助里其实写了）：${stale.join(", ")}`).toEqual([]);
  });

  it("帮助里出现的「工具名式」代码片段必须真有其名（反向防漂移）", () => {
    // 正反向都钉：上一方向管"有工具没文档"，这一方向管"文档写了不存在的工具"。
    // 实例：帮助长期列着 template_write / command_write / card_write / template_list
    // 四支早已不存在的工具名，只因为门禁历来只查单向。
    const snakeInHelp = [...helpSrc.matchAll(/<code>([a-z][a-z0-9]*(?:_[a-z0-9]+)+)<\/code>/g)].map((m) => m[1]);
    const notATool = snakeInHelp.filter(
      (n) => !hostEntryByName(n) && !(n in DOCUMENTED_OK_NON_TOOL),
    );
    expect(notATool, `帮助里写了并不存在的工具名：${notATool.join(", ")}`).toEqual([]);
  });

  it("P98 新增的用户可见入口有说明", () => {
    for (const phrase of [
      "当前外观被谁改了", // M1 面板
      "清除 AI 的全部临时改动", // M1 主按钮
      "恢复外观默认", // M1 次级按钮（与「恢复出厂」刻意区分）
      "上下文用量与手动压缩", // M4
      "让 AI 改界面", // M6 新增节
      "外观是怎么叠起来的", // M6 新增节
    ]) {
      expect(helpSrc, `帮助里找不到「${phrase}」的说明`).toContain(phrase);
    }
  });

  it("已删除的设置项不得再被帮助教用户去找（反向钉）", () => {
    for (const gone of [
      "小部件可发送数据", // P98-M2 改名并搬家
      "允许行为脚本", // P98-M2 删除（它原本什么都不拦）
      "需脚本高权限", // 同上，真实语义是"高权限动作需逐次批准"
      "创造模式", // P98-M2 删除：prompts 从不读它
      "顶部工具条", // P90-C 起场景收进「场景 ▾」下拉
    ]) {
      expect(helpSrc, `帮助仍在提一个已不存在的开关/入口：${gone}`).not.toContain(gone);
    }
  });

  it("档位语义的边界写清楚了，不是只报喜", () => {
    // 「全面放手」最容易被读成"什么都不再问"——帮助必须明说四类例外仍然逐次批准
    expect(helpSrc).toContain("仍然逐条弹批准卡");
    // 高危档不跨重启恢复这件事，不说清楚就是埋雷
    expect(helpSrc).toContain("不跨重启恢复");
  });
});
