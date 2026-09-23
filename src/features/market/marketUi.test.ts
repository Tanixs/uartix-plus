/**
 * P99b-N2：市场界面的**反向钉**（源码文本层）。
 *
 * 界面这一层没法在 node 里渲染（项目里没有 RTL，§8-32 的口径），
 * 但市场页最怕的三件事都能在源码上钉死：
 *  1. **把货架数据抄进组件**——那会让"索引里没有的"也显示出来（用户当事实）；
 *  2. **组件自己算字段**（自己排版本、自己格式化字节）——派生层就白分了；
 *  3. **入口开成第二个面**——同一件事两处入口 = 两本抄本（§8-45 的教训）。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
  readdirSync: (p: string, opt?: { withFileTypes?: boolean }) => { name: string; isDirectory: () => boolean }[];
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** 整个 src 里出现某个字符串的文件名（找"第二个入口"用，不靠我记得去看哪几个文件） */
function filesMentioning(needle: string): string[] {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(ent.name) || /\.test\.(ts|tsx)$/.test(ent.name)) continue;
      if (readFileSync(p, "utf8").includes(needle)) out.push(p.slice(root.length + 1).replace(/\\/g, "/"));
    }
  };
  walk(root.replace(/\\/g, "/"));
  return out.sort();
}

const DIALOG = read("./MarketDialog.tsx");
const DETAIL = read("./MarketDetail.tsx");
const IMG = read("./MarketImage.tsx");
const CONFIRM = read("./InstallConfirm.tsx");
const SHELF = JSON.parse(read("../../../public/market/index.json")) as {
  entries: { id: string; name: string; author: string; packageUrl: string }[];
};

describe("P99b-N2 · 界面不抄货架数据", () => {
  it("组件源码里不出现任何一条货架的名字/作者/地址（数据只能从索引来）", () => {
    for (const e of SHELF.entries) {
      for (const [field, v] of [["名称", e.name], ["作者", e.author], ["包地址", e.packageUrl]] as const) {
        expect(DIALOG, `MarketDialog 里出现了条目${field}「${v}」`).not.toContain(v);
        expect(DETAIL, `MarketDetail 里出现了条目${field}「${v}」`).not.toContain(v);
      }
    }
  });

  it("界面不自己算派生字段：版本比较、字节格式化、空态话术都在 marketBrowse", () => {
    for (const [f, src] of [["MarketDialog.tsx", DIALOG], ["MarketDetail.tsx", DETAIL]] as const) {
      expect(src, `${f} 不该自己格式化字节`).not.toMatch(/\/ 1024|1024 \* 1024/);
      expect(src, `${f} 不该自己比版本号`).not.toMatch(/split\("\."\)/);
      expect(src, `${f} 该用派生层的卡片`).toContain("cardFacts");
    }
    expect(DIALOG).toContain("browseEntries");
    expect(DIALOG).toContain("emptyTalk");
  });

  it("「本机另有 N 个包不在这份索引里」是点得开的清单，不是三个名字加一个「等」（P99b-N6 / §5-Q3）", () => {
    expect(DIALOG).toContain("offShelfOf"); // 判定在派生层，组件不自己 filter 一遍
    expect(DIALOG).toContain("aria-expanded=");
    expect(DIALOG, "那句「等」就是答不上『那到底还有谁』的形状，不许回来").not.toMatch(/offShelf[^\n]*slice\(0, 3\)/);
    // 每条四样：名字 / id / 版本 / 状态——状态名来自插件库那份表，市场不另立一套中文
    expect(DIALOG).toContain("PLUGIN_STATE_LABEL");
    expect(DIALOG).toMatch(/mkt-offshelf-list[\s\S]{0,240}p\.version/);
    // 这条判定（本机多出来哪些包）只准有一份算法：界面与命令行都调同一个派生函数
    expect(filesMentioning("offShelfOf(").sort(), "「本机多出来哪些包」又长出第二处算法").toEqual([
      "features/market/MarketDialog.tsx", "features/market/marketBrowse.ts", "features/market/marketCli.ts",
    ]);
  });

  it("「列表不等于背书」这句只有一份，两处都引同一个常量", () => {
    expect(DIALOG).toContain("MARKET_NO_ENDORSE");
    expect(DETAIL).toContain("MARKET_NO_ENDORSE");
    expect(DIALOG).not.toMatch(/const NO_ENDORSE|列表不等于背书：/);
    expect(DETAIL).not.toMatch(/const NO_ENDORSE|列表不等于背书：/);
  });
});

describe("P99b-N2 · 弹层与安全口径", () => {
  it("两层弹层都 portal 到 body，且带 dialog/aria-modal（§8-20）", () => {
    expect(DIALOG).toContain("createPortal");
    expect(DIALOG).toContain("document.body");
    expect(DETAIL).toContain("createPortal");
    expect(DETAIL).toContain("document.body");
    expect(DIALOG).toContain('role="dialog"');
    expect(DETAIL).toContain('role="dialog"');
    expect(DIALOG).toContain('aria-modal="true"');
    expect(DETAIL).toContain('aria-modal="true"');
  });

  it("两层都要能退：Esc 先收详情再关窗，详情有返回按钮", () => {
    expect(DIALOG).toContain('"Escape"');
    expect(DETAIL).toContain("返回");
  });

  it("图标一律 SVG 或文字，不许 emoji / 私用区字符（§8-25）", () => {
    // 2039/203A 与 00AB/00BB 是「最省事的箭头」那四个字符（‹ › « »）——旧表里没有它们，
    // 于是把箭头退回成字符写法照样绿，这条钉等于没钉（实测过：‹ 变异 red=false）
    const bad = /[\u{1F300}-\u{1FAFF}\u{E000}-\u{F8FF}\u{2190}-\u{21FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{00AB}\u{00BB}\u{2039}\u{203A}]/u;
    expect(bad.test(DIALOG), "MarketDialog 里有字符图标").toBe(false);
    expect(bad.test(DETAIL), "MarketDetail 里有字符图标").toBe(false);
    expect(bad.test(IMG), "MarketImage 里有字符图标（占位要用骨架块）").toBe(false);
    expect(bad.test(CONFIRM), "InstallConfirm 里有字符图标").toBe(false);
  });

  it("货架页自己不落地：按钮只发请求，落地口仍是确认卡那一条", () => {
    expect(DIALOG).not.toContain("stagePackage");
    expect(DIALOG).not.toContain("installStaged");
    expect(DIALOG).not.toContain("importPackages");
    // 按钮存在，而且只走 marketPending 那一个入口（点了没反应的假按钮坏，第二条真路径更坏）
    expect(DIALOG, "卡片上没有那颗按钮").toContain("requestMarketInstall(");
    expect(DETAIL, "详情上没有那颗按钮").toContain("onInstall(");
    // 三段执行核一个都不许在界面里出现（出现了就是绕开那张表与那次确认）
    for (const [f, src] of [["MarketDialog", DIALOG], ["MarketDetail", DETAIL]] as const) {
      for (const call of ["planMarketInstall(", "stageMarketPlan(", "applyMarketStage(", "acceptMarketInstall(", "rejectMarketInstall("]) {
        expect(src, `${f} 里直接调了内核 ${call}，第二条落地口长出来了`).not.toContain(call);
      }
    }
  });

  it("落地口只有一个：绕过内核直接 installStaged/approveUpdate 的文件必须点名（G3）", () => {
    // 白名单里每一条都有自己的理由：内核＝唯一出口；pluginStore＝定义处；
    // localEntries/appearanceTools＝AI 自己生成的包那条直建链（不经市场，也不碰货架）；
    // PluginLibraryDialog＝库里既有的"批准候选"人工按钮。（`filesMentioning` 跳过 .test.*，夹具不算入口）
    const ALLOW = [
      "features/market/marketInstall.ts",
      "features/plugins/pluginStore.ts",
      "features/agent/localEntries.ts",
      "features/agent/appearanceTools.ts",
      "features/plugins/PluginLibraryDialog.tsx",
    ];
    for (const call of ["installStaged(", "approveUpdate("]) {
      const users = filesMentioning(call);
      expect(users.length, `反空断言：${call} 一个调用点都扫不到，说明扫描坏了`).toBeGreaterThan(0);
      for (const p of users) expect(ALLOW, `${p} 绕过内核自己落地（${call}）`).toContain(p);
    }
    // 市场那一侧必须干净
    for (const f of ["marketPending.ts", "marketCli.ts", "MarketDialog.tsx", "InstallConfirm.tsx", "marketStore.ts", "marketBrowse.ts"]) {
      const src = read(`./${f}`);
      for (const call of ["installStaged(", "approveUpdate(", "stagePackage(", "proposeUpdate("]) {
        expect(src, `${f} 里出现 ${call} 就是长出第二个落地口`).not.toContain(call);
      }
    }
    const kernel = read("./marketInstall.ts");
    for (const call of ["installStaged(", "approveUpdate(", "stagePackage(", "proposeUpdate("]) {
      expect(kernel, `内核里少了 ${call}：落地口又散了`).toContain(call);
    }
  });

  it("确认卡不写第二份文案：会碰到什么全来自 describePlan（G7）", () => {
    const card = read("./InstallConfirm.tsx");
    const pend = read("./marketPending.ts");
    expect(pend).toContain("describePlan");
    // 针的是"卡片自己算文案"，不是"卡片不许提到这件事"——所以盯调用/引用，不盯注释里的词
    expect(card, "卡片自己算文案就是第二真相").not.toMatch(/describePlan\s*\(/);
    expect(card, "卡片不该直接引内核").not.toContain('from "./marketInstall"');
    // 卡片与表里都不许出现货架上的具体名字（数据只能从索引/内核来）
    for (const name of ["墨夜", "uartix", "raw.githubusercontent.com"]) {
      expect(card, `InstallConfirm 里出现了 ${name}`).not.toContain(name);
      expect(pend, `marketPending 里出现了 ${name}`).not.toContain(name);
    }
  });

  it("图片策略一行都不许长在组件上（I5：格式/尺寸/上限都在 imageHeads 与 marketImages）", () => {
    const img = read("./MarketImage.tsx");
    for (const banned of ["image/png", "image/svg", "8192", "4 * 1024", "slice(0,", "CONCURRENCY"]) {
      expect(img, `MarketImage.tsx 里出现了策略字面 ${banned}`).not.toContain(banned);
    }
    // 组件只准问"这张图现在什么状态"，取回与判定都得走策略层
    expect(img).toContain("marketImageSlot");
    expect(img).toContain("loadImage");
    // 拒 SVG 这件事必须写在**放行那一层**里（大小写都算，注释里也得说清为什么）
    expect(read("./imageHeads.ts")).toMatch(/svg/i);
  });

  it("外链走系统浏览器，不在应用内加载第三方页面", () => {
    expect(DETAIL).toContain("plugin-opener");
    expect(DETAIL).toContain("openUrl");
    expect(DETAIL).not.toContain("<iframe");
    expect(DETAIL).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("P99b-N2 · 入口只有一个（Q8）", () => {
  it("市场弹窗渲染点只有一处，入口在插件库里（弹窗实例两份＝Esc/滚动/收藏各说一套）", () => {
    const users = filesMentioning("<MarketDialog");
    expect(users, "弹窗只在 App 渲染一份").toEqual(["App.tsx"]);
    // 按文件算的钉挡不住"同一个文件里挂两份"（实测绿），所以再钉一次出现次数
    expect((read("../../App.tsx").match(/<MarketDialog/g) ?? []).length, "App 里出现了两份市场弹窗").toBe(1);
    // 库里那颗只发信号；App 收信号才渲染（名字出现过不算接线——摘掉 onClick 曾照样绿，故钉调用形状）
    expect(read("../plugins/PluginLibraryDialog.tsx")).toContain("requestOpenMarket");
    expect(read("../../App.tsx")).toContain("msg.kind === \"openMarket\"");
    // 旧名字不许在源码里复活（改名批漏扫抄本的老账，§8-45）
    for (const f of ["../plugins/PluginLibraryDialog.tsx", "../../shell/TitleBar.tsx"]) {
      expect(read(f), `${f} 还写着旧名「浏览市场」`).not.toContain("浏览市场");
    }
  });

  it("标题栏那颗开的是「插件管理」，而且开的是**现成的设置页那一栏**（不再造第三个插件库窗口）", () => {
    const tb = read("../../shell/TitleBar.tsx");
    expect(/title="插件管理"/.test(tb), "标题栏那颗的名字不是「插件管理」").toBe(true);
    expect(/onClick=\{onOpenLibrary\}/.test(tb), "标题栏那颗没接 onOpenLibrary（点了没反应的老形状）").toBe(true);
    // 用户嫌"小、不居中"→ 尺寸与居中都钉住，别悄悄用回默认 14 的原点偏移路径
    expect(/IconPuzzle size=\{16\}/.test(tb), "标题栏那颗又用回默认 14").toBe(true);
    expect(
      /transform="translate\(12 12\) scale\(1\.3\) translate\(-12 -9\)"/.test(read("../../shared/icons.tsx")),
      "拼图那颗的定心/放大变换被拿掉了（浏览器实测：不写就是偏上 1px、看着比旁边小）",
    ).toBe(true);
    // P102：同一个 scale 把 strokeWidth="2" 也放大成 2.6，叠上 16px（邻居 14px）就是用户说的"边缘太粗"。
    // 钉的是那个具体的除法形状——写回 strokeWidth="2" 也算"写了个描边"，所以不能只钉属性存在。
    expect(
      /strokeWidth=\{2 \/ 1\.3\}/.test(read("../../shared/icons.tsx")),
      "拼图那颗的描边补偿没了：scale(1.3) 会把描边放大 30%，比旁边几颗粗出四成半",
    ).toBe(true);
    const app = read("../../App.tsx");
    // 两个动作必须**成对出现在同一个 handler 里**：只写"App 某处出现过 setSettingsOpen(true)"是子串钉——
    // 摘掉开窗那半句照样过（实测绿），而那正好是"点了没反应"那一格。
    const libHandler = /onOpenLibrary=\{\(\) => \{([\s\S]{0,320}?)\}\}/.exec(app);
    expect(libHandler, "App 里找不到标题栏那颗的 handler").not.toBeNull();
    expect(libHandler?.[1].includes("setSettingsTab(SETTINGS_TAB_PLUGINS)"), "那颗没切到「插件管理」那一栏").toBe(true);
    expect(libHandler?.[1].includes("setSettingsOpen(true)"), "那颗没把设置页打开（只切标签等于没开）").toBe(true);
    expect(filesMentioning("\"ext\""), "标签键又长出第二处").toEqual(["features/settings/settingsStore.ts"]);
  });

  it("市场页是只读的：AI 目录与 MCP 都不许在这里挂上装包能力（Q7）", () => {
    const host = read("../agent/hostCatalog.ts");
    /**
     * P99b-N6 改钉"调用"而不是"字样"：目录里新加了 `market.status` / `market.entries` 两支只读视图，
     * 它们本来就要说 `install`（absent/same/update 那个**状态字段**）。旧写法 `/market.*install/` 会把
     * "AI 能读货架"一起禁掉——那是把 Q7（不许它动手）说成了"不许它知道"。
     * 动手的符号只有这几个：请求装包、点确认卡、以及装链三段与取包体本身。
     */
    for (const call of [
      "requestMarketInstall(", "acceptMarketInstall(", "rejectMarketInstall(",
      "stageMarketPlan(", "applyMarketStage(", "planMarketInstall(", "fetchPackage(", "setEnabled(",
    ]) {
      expect(host, `自省目录里出现了 ${call} ⇒ 只读面开始动装机，越了 Q7 的界`).not.toContain(call);
    }
    // 正面半边：目录能挂上的市场模块就这三个（多一个＝读面或写面被扩大，必须同时改这里）
    const specs = [...host.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]).filter((s) => s.includes("/market/"));
    expect([...new Set(specs)].sort(), "目录里多了会动手的市场模块").toEqual([
      "../market/marketIndex", "../market/marketPending", "../market/marketStore",
    ]);
  });

  it("依赖方向单向：插件库不反过来依赖市场", () => {
    expect(read("../plugins/pluginStore.ts")).not.toContain("../market/");
  });
});

describe("P99b-N4 · 那颗按钮与那张卡：一处渲染、一份状态、半句谎都不留", () => {
  it("确认卡只有一个渲染点，而且是顶层的 App（挂在弹窗里＝关掉就看不见 CLI 发起的那条，10 分钟后静默作废）", () => {
    const users = filesMentioning("<InstallConfirm");
    expect(users, "确认卡出现了第二处渲染点").toEqual(["App.tsx"]);
    expect((read("../../App.tsx").match(/<InstallConfirm/g) ?? []).length, "App 里挂了两份确认卡").toBe(1);
    // 搬走之后，两处宿主都不许再留引用（留着就是"以为还在"）——钉 import 与 JSX，不钉注释
    expect(DIALOG, "市场弹窗里还留着那份确认卡（顶层已有一份）").not.toMatch(/import \{ InstallConfirm|<InstallConfirm/);
    expect(read("../plugins/PluginLibraryDialog.tsx"), "插件库里还留着那份确认卡").not.toMatch(/import \{ InstallConfirm|<InstallConfirm/);
  });

  it("相位的字面量只准活在派生层与表里，组件里判相位＝第二真相", () => {
    const BANNED = ['"awaiting_you"', '"working"', '"rejected"', '"not_awaiting"'];
    for (const f of ["./MarketDialog.tsx", "./MarketDetail.tsx", "./InstallConfirm.tsx"]) {
      const src = read(f);
      for (const lit of BANNED) {
        expect(src, `${f} 自己判相位 ${lit}`).not.toContain(lit);
      }
    }
    // 反向：表确实长在派生层（扫不到＝派生层没接住，组件早晚自己写一份）
    expect(read("./marketBrowse.ts")).toContain("awaiting_you");
  });

  it("「本页只浏览与收藏」那句必须整条消失，不是改词（C1c 注释里预告过：留着就是说谎）", () => {
    expect(filesMentioning("MARKET_BROWSE_ONLY"), "那个常量还在某处活着").toEqual([]);
    expect(filesMentioning("本页只浏览与收藏"), "旧话还在别处抄着").toEqual([]);
  });

  it("按钮的文案与可点性全部来自状态表，组件里不许出现第二份「安装/更新」字样", () => {
    // 两处宿主都只准用格子的结果（详情收 action 属性，卡片那侧才调 cardAction）
    expect(DIALOG, "货架页没走状态表").toContain("cardAction(");
    expect(DETAIL, "详情没走状态表").toContain("action.tone");
    for (const [f, src] of [["MarketDialog", DIALOG], ["MarketDetail", DETAIL]] as const) {
      expect(src, `${f} 里手写了按钮文案`).not.toMatch(/>安装</);
      expect(src, `${f} 里手写了按钮文案`).not.toMatch(/"更新到 v/);
      expect(src, `${f} 没读格子的可点性`).toContain("action.enabled");
    }
    expect(read("./marketBrowse.ts")).toContain("export function cardAction");
  });

  it("入口徽标只数「等你确认」，不把正在跑的算进去（催错人比不催更坏）", () => {
    const hook = read("./useMarketPending.ts");
    expect(hook, "徽标没引那个唯一的计数口").toContain("awaitingMarketInstalls(");
    expect(hook, "整表自己数＝第二份判定").not.toContain("listMarketPending(");
    // 钉到函数体：光看"文件里出现过 awaitingMarketInstalls"挡不住把徽标换成整表长度（实测形状）
    expect(/function awaitingCount\(\)[\s\S]{0,120}?awaitingMarketInstalls\(\)\.length/.test(hook), "awaitingCount 自己不算等你确认那几条了").toBe(true);
    expect(read("../../shell/TitleBar.tsx")).toContain("pendingBadge(");
  });

  it("点完「装入」那张回执得留在页面上，不能整张卡跟着一起消失", () => {
    // 真机取证抓到的形状：accept 之后 awaiting 立刻空 → 组件 return null → 回执没人看见＝"点了没反应"
    const guard = read("./InstallConfirm.tsx").match(/if \(([^\n]*)\) return null;/);
    expect(guard, "「什么时候不渲染」那一句判断找不到了").not.toBeNull();
    expect(guard?.[1], "那句判断没把回执算进去，回执会随卡片一起消失").toContain("note");
  });

  it("「全部更新」排不下时要报数，不静默截断（A7）", () => {
    expect(DIALOG).toContain("planQueueAllUpdates(");
    // 钉到那句判断本身：只写"出现过 overCap"挡不住把它挪去一个不显示的地方（文本钉的天花板到此为止，本批不为它引 RTL）
    expect(/updPlan\.overCap > 0/.test(DIALOG), "没排上几条这件事没往页面上写").toBe(true);
    // 上限只有一个来源：界面不许把 8 写死在调用里
    expect(DIALOG).not.toMatch(/planQueueAllUpdates\([^)]*\b8\b/);
  });
});

/* ============ P99c-R2：接了 npm 也不许长出执行第三方代码的路 ============ */
describe("P99c-R2 · npm 通路的表面纪律", () => {
  const marketDir = fileURLToPath(new URL("./", import.meta.url));
  const marketSrcs = readdirSync(marketDir, { withFileTypes: true })
    .filter((e) => /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name))
    .map((e) => [e.name, read(`./${e.name}`)] as const);

  it("市场目录里有解包器（不是空扫），且没有任何执行外部代码的入口", () => {
    expect(marketSrcs.map(([f]) => f)).toContain("npmUnpack.ts");
    expect(marketSrcs.length, "一个文件都没扫到：目录读法变了，这条守卫就空了").toBeGreaterThan(6);
    // gzip 走平台流、tar 手扫字节：全链路不建进程、不 eval、不 new Function，也不落盘
    for (const [f, src] of marketSrcs) {
      for (const bad of ["child_process", "spawn(", "execSync(", "eval(", "new Function", "writeFile"]) {
        expect(src, `${f} 里出现 ${bad}：npm 那条通路就有了执行外部代码的口子`).not.toContain(bad);
      }
    }
  });

  it("出处写在派生层与契约层：界面不许自己比 npm 字符串（G7 同族）", () => {
    expect(DETAIL).toContain("card.origin");
    expect(DETAIL, "组件里 `entry.npm ?` 就是第二套判定").not.toMatch(/entry\.npm\s*\?/);
    expect(DETAIL).toContain("packageOrigin(");
    // 域名字面量不许抄进界面：抄了就等着与契约层过期分叉
    expect(DETAIL).not.toContain("registry.npmjs.org");
    expect(DIALOG).not.toContain("registry.npmjs.org");
  });
});
