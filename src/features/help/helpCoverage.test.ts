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
// P99a-D2：帮助要覆盖的两张新清单一律从代码取——产物种类元表与能力白名单。
// （`artifact.ts:26` 的注释早就写着"中文名……帮助文本共用这一份"，这一批让那句话真的成立。）
import { ARTIFACT_KINDS, artifactKindMeta } from "../plugins/artifact";
import { PLUGIN_CAPS, CAP_LABEL, autoEnableBlockedCaps } from "../plugins/pluginManifest";
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
  update_needs_user: "save_plugin 的回执码：用户导入过的包不许 AI 静默覆盖",
  // P99b-N6：市场那一页提到的两个"像工具名"的名字
  setEnabled: "插件库的启停动作（三处入口共用它），不是发给模型的工具",
  version_mismatch: "装包的拒绝码之一：货架声明的版本与包内不一致，不是工具名",
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

  it("P99b-N5：主题同级与两条落地路径都要说清（旧那句「主题会自动启用」是错话）", () => {
    for (const phrase of [
      "同时只有一枚在画", // 互斥这条规则本身
      "内置与插件主题同级", // 改判后的模型
      "兜底层（暗/亮两张）", // 层表里那一行：差量主题缺的键从哪来
      "从插件市场装的是一枚停用态的包", // 市场路径
      "AI 保存/固化出来的主题", // 另一条路径（当场已启用）
    ]) {
      expect(helpSrc, `帮助里找不到「${phrase}」的说明`).toContain(phrase);
    }
    // 反向钉：那句一刀切的"会自动启用"正是本批要清的错账，不许以原样回来
    expect(helpSrc).not.toMatch(/一套外观变量[^<]{0,20}<b>会<\/b>自动启用/);
    // 提示词也不能承诺"装完就生效"
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
      "api.app", // 主世界脚本通道随 P99a-D1c 删除；今天能调它的是小部件 uartix.app / 动作块 / MCP
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

  it("P99a-D2：六种产物种类的中文名都在帮助里（元表派生，加一类不写文档就红）", () => {
    const missing = ARTIFACT_KINDS.filter((k) => !helpSrc.includes(artifactKindMeta(k).label));
    expect(missing, `这些产物种类没写进帮助：${missing.join(", ")}`).toEqual([]);
  });

  it("P99a-D2：12 项插件能力的短名都在帮助里（能力名册不许只活在插件库 tooltip 里）", () => {
    const missing = PLUGIN_CAPS.filter((c) => !helpSrc.includes(CAP_LABEL[c].name));
    expect(missing, `这些能力没写进帮助：${missing.map((c) => CAP_LABEL[c].name).join("、")}`).toEqual([]);
  });

  it("P99a-D2：「哪些包不会自动启用」这句安全话术逐个点名补集（漏一个就是假安全感）", () => {
    // 按 Section 切：整篇帮助里出现过名字不算数——那可能是别处的顺带一提。
    const sections = helpSrc.split("<Section");
    const withNote = sections.filter((s) => s.includes("不会自动启用"));
    expect(withNote.length, "帮助里没有「不会自动启用」这句安全说明").toBeGreaterThan(0);
    const missing = autoEnableBlockedCaps().filter(
      (c) => !withNote.some((s) => s.includes(CAP_LABEL[c].name)),
    );
    expect(missing, `这些能力不会自动启用，帮助却没说：${missing.map((c) => CAP_LABEL[c].name).join("、")}`).toEqual([]);
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

  it("P99b-N6：市场那一页四节齐，而且三句承诺各自钉住", () => {
    const at = helpSrc.indexOf('{tab === "market"');
    expect(at, "没有市场那一页").toBeGreaterThan(-1);
    const page = helpSrc.slice(at, helpSrc.indexOf("{tab === ", at + 30) < 0 ? helpSrc.length : helpSrc.indexOf("{tab === ", at + 30));
    for (const t of ["市场从哪来、什么时候联网", "装进来归谁管", "它替你做了什么、没做什么", "怎么把你做的东西上架"]) {
      expect(page, `市场那一页缺节「${t}」`).toContain(t);
    }
    // 联网时机 / 装前比版本：这两句是最容易被"顺手优化"掉的承诺
    expect(page).toContain("才会去取");
    expect(page).toContain("不缓存当现状");
    expect(page).toContain("version_mismatch");
    // 放行域与两句原话都从代码取，帮助里不许长出抄本（R4）
    expect(page).toContain("MARKET_ALLOW_HOSTS.join");
    expect(page).toContain("MARKET_NO_ENDORSE");
    expect(page).toContain("MARKET_INSTALL_NOTE");
    expect(page, "帮助里抄了一份域名清单＝等着过期").not.toContain("raw.githubusercontent.com");
  });

  it("P99b-N6：帮助里那条「离线一条命令」真存在（写进帮助就得跑得动）", () => {
    expect(helpSrc).toContain("validate market/pkg/");
    const cliSrc = readFileSync(here.replace(/[/\\]features[/\\]help[/\\].*$/, "/../scripts/plugin-cli-core.ts"), "utf8");
    // 它得是**本地**命令：一旦哪天改成"要开着应用才能自检"，帮助那句"离线"就成了假话
    expect(cliSrc, "validate 不再是本地命令了 ⇒ 帮助里那句「离线一条命令」要改口").toMatch(/LOCAL_COMMANDS\s*=\s*\[[^\]]*"validate"/);
    expect(cliSrc).toContain("除 validate 外的前提");
  });
});
