/**
 * P96-M6 / 实为 P98-M6：帮助文档的防腐门禁。
 *
 * 为什么必须有：`HelpModal.tsx` 曾在 2026-09-19（P88 批）后连续六轮 AI 助手改动
 * （布局重排、档位体系、上下文用量、界面自省、组件样式、版本链）**一行都没回写**，
 * 而 3D 页反而较新 —— 说明"哪批回了文档"完全取决于当批作者记不记得，没有机制保证。
 * 用户这次直接要求"全面优化帮助文档"，那更该做的是让它**不能再烂一次**：
 * 加了工具/档位/授权域却没写文档 ⇒ 测试红。
 *
 * 手法沿用本项目已有的"源码级对齐钉"（`messageClip.test.ts` 断言 CSS 的 max-height
 * 必须等于 JS 的 SCROLL_MAX_PX）：直接读组件源文本，不依赖渲染。
 */
import { describe, expect, it, vi } from "vitest";
// hostEntries 会把工具组（含 settingsStore/插件引擎）拉进依赖图，这些 store 在模块
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
 * P99a-D2：扫描面从"帮助"一份扩到两份。`prompts.ts` 是**发给模型的话**，它同样在对用户做承诺
 * ——实例：它写着"引导用户打开 AI 助手工具栏的『Agent 任务』"，而那个按钮 P90-C1 就删了
 * （`AiChat.tsx:1129`），于是模型照着教用户，用户找不到按钮。§8-41：对模型的承诺文案也要守卫。
 */
const promptsSrc = readFileSync(here.replace(/[/\\]features[/\\]help[/\\].*$/, "/features/ai/prompts.ts"), "utf8");

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
  run_action: "MCP 侧的动作入口（对应本机 run_app_action），不是本机工具名",
  plugin_draft_promote_pending: "草稿转正的回执状态，不是工具名",
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
    // 三处措辞在 P105-F 改过名（「当前外观被谁改了」→「外观覆盖层」等）：
    // 这条守卫的价值恰恰是**逼你两边一起改**——设置页改了而帮助没改，它就会红。
    for (const phrase of [
      "外观覆盖层", // M1 面板
      "清除 AI 临时覆盖", // M1 主按钮
      "恢复默认外观", // M1 次级按钮（与「恢复出厂」刻意区分）
      "上下文用量与手动压缩", // M4
      "让 AI 改界面", // M6 新增节
      "外观是怎么叠起来的", // M6 新增节
    ]) {
      expect(helpSrc, `帮助里找不到「${phrase}」的说明`).toContain(phrase);
    }
  });

  it("P174：v3 主题模型说清楚（同级 / 互斥 / 必须选中 / 启用门 / 新装停用）", () => {
    for (const phrase of [
      "同时只有一枚在画",
      "内置与插件主题同级",
      "兜底层（暗/亮两张）",
      "新装落地为停用态",
      "启用且已批准",
      "选中才会上屏",
      "退回内置",
    ]) {
      expect(helpSrc, `帮助里找不到「${phrase}」的说明`).toContain(phrase);
    }
    expect(promptsSrc, "发给模型的话术又在替用户保证装完自动生效").not.toContain("装完自动启用");
  });

  it("已删除的设置项/入口/API 不得再被帮助或提示词教用户去找（反向钉，扫两份源）", () => {
    const hits: string[] = [];
    for (const gone of [
      "小部件可发送数据", // P98-M2 改名并搬家
      "允许行为脚本", // P98-M2 删除（它原本什么都不拦）
      "需脚本高权限", // 同上，真实语义是"高权限动作需逐次批准"
      "创造模式", // P98-M2 删除：prompts 从不读它
      "顶部工具条", // P90-C 起场景收进「场景 ▾」下拉
      // —— 以下为 P99a-D2 新增 ——
      "工具栏的『Agent 任务』", // 按钮 P90-C1 已删，唯一入口是输入区下方的 pill
      "api.app", // 主世界脚本通道已删除；今天只有 uartix-action 代码块与 MCP run_action 两个入口
      "reportView", // P99a-D1b 下架（与 panel 同构）
      "motionPreset", // 同上：并入主题层
      "motion.preset",
      "report.view",
      "脚本扩展", // 同上：能带 JS 的形态只剩插件的「逻辑模块」
    ]) {
      // 先把命中项收成一行清单再断言：直接把整份源文本喂给 not.toContain，
      // 失败信息会把 100KB 的组件源码整段喷出来，等于没有信息。
      if (helpSrc.includes(gone)) hits.push(`帮助→${gone}`);
      if (promptsSrc.includes(gone)) hits.push(`提示词→${gone}`);
    }
    expect(hits, `这些开关/入口/API 已经不存在，却还在教用户去找：${hits.join("、")}`).toEqual([]);
  });

  it("v3 插件模型：面板 / 主题 / 小部件与三道门都写进了帮助", () => {
    for (const must of ["contributes.panels", "contributes.themes", "contributes.widgets", "contributes.commands"]) {
      expect(helpSrc, `帮助没写插件贡献 ${must}`).toContain(must);
    }
    for (const must of ["批准", "启用", "草稿", "plugin_draft_save", "plugin_draft_promote"]) {
      expect(helpSrc, `帮助没写 v3 的关键概念「${must}」`).toContain(must);
    }
  });

  it("帮助里那句「目录不含哪些面」必须与真实目录一致（补完一面，这句就得把它划掉）", async () => {
    // P99a-C1b：这条钉子专还 D2 留下的账——帮助把"当前不含七面"写成了一句公开欠款，
    // 补完却忘了改口的话，用户会以为 AI 读不到 3D 轨迹，而它其实读得到。
    const { CATALOG_VIEWS, CATALOG_GROUP_ZH } = await import("../agent/hostCatalog");
    const implemented = new Set(CATALOG_VIEWS.map((v) => CATALOG_GROUP_ZH[v.group]));
    // 宽松一点：「目录当前不含」「这张目录还不含」都得被抓到；抓不到就当作"这句已经划掉"
    const m = /目录[^<]{0,16}不含[\s\S]{0,60}?：([^。<]+)。/.exec(helpSrc);
    if (!m) {
      // 没有这句了——但也不能靠"删句子"糊弄过去：如果帮助在别处把已实现的面写成读不到，这里也要炸
      const stray = [...implemented].filter((n) => new RegExp(`${n}[^。]{0,24}(读不到|没接|不含|不支持)`).test(helpSrc));
      expect(stray, `这些面已进目录，帮助仍在说它读不到：${stray.join("、")}`).toEqual([]);
      return;
    }
    const claimed = m[1].split(/[、·]/).map((s) => s.trim()).filter(Boolean);
    expect(claimed.length, "抓到了「不含」句式却没抽出清单——正则自己得修").toBeGreaterThan(0);
    const wrong = claimed.filter((n) => implemented.has(n));
    expect(wrong, `这些面已经进目录了，帮助还写着「不含」：${wrong.join("、")}`).toEqual([]);
  });

  it("档位语义的边界写清楚了，不是只报喜", () => {
    // 「全权执行」最容易被读成"什么都不再问"——帮助必须明说四类例外仍然逐次批准
    expect(helpSrc).toContain("仍然逐条弹批准卡");
    // 高危档不跨重启恢复这件事，不说清楚就是埋雷
    expect(helpSrc).toContain("不跨重启恢复");
  });

  /* ================= P99b-N6 · 帮助第 12 页「插件市场」 =================
   * 这一组钉子专治两种病：① 加了页签忘了写内容（点了是空白）；
   * ② 页签写了内容、内容却说的不是实现做的事（用户照着做发现对不上）。
   */
  it("P99b-N6：每个页签都有对应的内容块（加了 tab 忘了写＝当场红）", () => {
    const labels = [...helpSrc.matchAll(/\{ key: "([a-z0-9]+)", label: /g)].map((m) => m[1]);
    const bodies = [...helpSrc.matchAll(/\{tab === "([a-z0-9]+)" && \(/g)].map((m) => m[1]);
    expect(labels.length, "页签清单没抓到：HelpModal 的 tabs 写法变了，这条守卫要跟着改").toBeGreaterThanOrEqual(12);
    const empty = labels.filter((k) => !bodies.includes(k));
    expect(empty, `这些页签只有名字没有内容：${empty.join("、")}`).toEqual([]);
    const orphan = bodies.filter((k) => !labels.includes(k));
    expect(orphan, `这些内容块没有对应页签（写了没人看得见）：${orphan.join("、")}`).toEqual([]);
  });

  it("v3 市场页：四节齐，联网与安装承诺都写清楚", () => {
    const at = helpSrc.indexOf('{tab === "market"');
    expect(at, "没有市场那一页").toBeGreaterThan(-1);
    const page = helpSrc.slice(at, helpSrc.indexOf("{tab === ", at + 30) < 0 ? helpSrc.length : helpSrc.indexOf("{tab === ", at + 30));
    for (const t of ["市场从哪来、什么时候联网", "装进来归谁管", "AI 不替你装", "怎么把你做的东西上架"]) {
      expect(page, `市场那一页缺节「${t}」`).toContain(t);
    }
    expect(page).toContain("搜索 GitHub");
    expect(page).toContain("topic:uartix-plugin");
    expect(page).toContain("MARKET_ALLOW_HOSTS");
    expect(page).toContain("批准卡");
    expect(page).toContain("停用态");
  });

  /**
   * P128-A → P129-A · 命令级覆盖：话和格子必须一起在场。
   *
   * 这一族的经过值得留全：三处文本（帮助手册 TX组帧台 那一行、属性页参数组的问号、AI 知识库）
   * 原本写着"要临时改一版，在命令或卡片上覆盖它"，而命令那半没有界面 ——
   * `Command.overrides` 编码器认，`patchCommand(…{overrides:undefined})` 却只出现在"清除引用"两处。
   * P128 先把话改口，P129 把格子补上，于是这句话现在又反过来过期了。
   *
   * 所以这条钉钉的是**双向**：
   *  - 三处话术都得提到"覆盖参数"那一节（说了 → 代码里得真有一节）；
   *  - 命令库里真得有那一节，而且"空着 = 不覆盖"要写成删键、不是存空串
   *    （存空串就成"这条命令把参数改成了没有值"，编码器照实报错，而那人只是按了一下退格）；
   *  - 那句不带出处的原话「在命令或卡片上覆盖」不许再回来 —— 它错在没说什么情况下才成立。
   *
   * 对用户和模型说过的话就是承诺（§8-41：同族先例是提示词让用户去按一颗早已删掉的按钮）。
   */
  it("P129-A：命令级覆盖——话与格子一起在场，缺一边就红", () => {
    const inspSrc = readFileSync(here.replace(/[/\\]features[/\\]help[/\\].*$/, "/features/inspector/SendFieldInspector.tsx"), "utf8");
    const clSrc = readFileSync(here.replace(/[/\\]features[/\\]help[/\\].*$/, "/features/controls/CommandLibrary.tsx"), "utf8");
    expect(clSrc, "命令设置弹窗里没有「覆盖参数」那一节了 ⇒ 三处话术又成假话").toContain("覆盖参数");
    expect(clSrc, "覆盖值不许存空串：空着 = 从 overrides 里删键").toMatch(
      /overrides:\s*Object\.keys\(next\)\.length\s*\?\s*next\s*:\s*undefined/,
    );
    for (const [name, src] of [
      ["HelpModal", helpSrc],
      ["prompts", promptsSrc],
      ["属性页", inspSrc],
    ] as const) {
      expect(src, `${name} 没跟上：命令设置里已经有「覆盖参数」那一节`).toContain("覆盖参数");
      expect(src, `${name} 还挂着"命令库里没有格子"那句过期的话`).not.toContain("填它的格子");
    }
    const all = `${helpSrc}${promptsSrc}${inspSrc}${clSrc}`;
    expect(all, "「在命令或卡片上覆盖」这句没出处的话回来了").not.toContain("在命令或卡片上覆盖");
  });
});
