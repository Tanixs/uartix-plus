/**
 * P114-B · 设置页外壳的两条形状钉（详设 §2）。
 *
 * 用户的判据是两句原话：
 *  ① "只有明显的左右分栏，大的设置页签在右边分栏上面，但是现在我的软件这个设置页签在单独的标题栏下面"
 *  ② "Zcode 的标题栏是隐藏了几个组件，只有左边的图标和右边的关闭、置顶、最小化等，你也这样设计"
 *
 * ①的真凶不是"页签的位置"而是那条通栏页头自己：它挂着 `--bg-panel` + `--shadow-pop`，
 * 读起来就是第二条标题栏，于是左右分栏被它截断。②是同一件事的另一面：整页开着的时候，
 * 标题栏那四颗应用级入口点了只会从这个全屏页跳到另一个全屏页。
 *
 * 手法同 P99b-N5/P114-A：没有 RTL，钉的是**接线形状**（谁包住谁、有没有渲染），
 * "看上去对不对"归验收截图。
 */
import { describe, expect, it } from "vitest";
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as {
  readFileSync: (p: string, e?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url)); // → src/
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

const PAGE = "features/settings/SettingsModal.tsx";
const MODAL = "shell/TopBars.tsx";
const APP = "App.tsx";
const CSS = read("styles/theme.css");

/** 取一条 CSS 规则的花括号内容（只按第一个选择器出现处切，够用且不含嵌套块） */
function ruleBody(sel: string): string {
  const at = CSS.indexOf(sel);
  expect(at, `theme.css 里找不到 ${sel}`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}

describe("P114-B · 页头住在右栏里，不是一条通栏", () => {
  it("`.set-content` 包住 `.set-page-head`（顺序反了就是又变回通栏横幅）", () => {
    const src = read(PAGE);
    const content = src.indexOf('className="set-content"');
    const head = src.indexOf('className="set-page-head"');
    expect(content).toBeGreaterThan(-1);
    expect(head).toBeGreaterThan(-1);
    expect(head > content, "页头又跑到 `.set-content` 外面去了：左右分栏会被它截断").toBe(true);
    // 它必须在 `.set-body` 之内（左导航与右内容的那一层）
    expect(head > src.indexOf('className="set-body"'), "页头不再于 set-body 之内").toBe(true);
  });

  it("页头不再有底色与投影：那两样是「第二条标题栏」的构成要素", () => {
    const body = ruleBody(".set-page-head");
    expect(body.includes("background"), "页头又自带底色了").toBe(false);
    expect(body.includes("box-shadow"), "页头又浮起来了").toBe(false);
    // 权重只剩字号，这与 `.set-page-title` 用 --fs-xl 是同一个决定的两半
    // 权重只剩字号：P156-Z 起 `.set-page-title` 引用 --fs-2xl（ZCode 的页头档）
    expect(ruleBody(".set-page-title").includes("var(--fs-2xl)")).toBe(true);
  });
});

describe("P114-B · 整页开着时标题栏收起应用级入口", () => {
  const tb = read(MODAL);

  it("四颗入口与那道小竖线一起被 `!fullPage` 包住（隐藏而不是不渲染=Tab 键还会经过）", () => {
    const guard = tb.indexOf("{!fullPage && (");
    expect(guard, "整页判断不再是条件渲染").toBeGreaterThan(-1);
    const sep = tb.indexOf('<span className="tb-sep"');
    const guardEnd = tb.indexOf(")}", sep);
    expect(sep, "那道小竖线不在了").toBeGreaterThan(guard);
    for (const anchor of ['data-tour="ai"', 'data-tour="plugins"', 'title={t("title.settings")}', 'title={t("title.help")}']) {
      const at = tb.indexOf(anchor);
      expect(at, `入口锚点不在 TopBars 里：${anchor}`).toBeGreaterThan(-1);
      expect(at > guard && at < guardEnd, `${anchor} 没被 !fullPage 包住`).toBe(true);
    }
    // 置顶与窗口三件在守卫之外：用户点名的"右边留着关闭、置顶、最小化"。
    // P157-F 起窗口三件搬进 WindowControls（设置页全窗脸共用同一组），置顶仍住 SystemButtons。
    expect(tb.indexOf("aria-pressed={pinned}")).toBeGreaterThan(guardEnd);
    expect(tb, "身份栏没引用窗键组").toContain("<WinKeys />");
    const wctl = read("shell/WindowControls.tsx");
    expect(wctl, "窗口三件不在 WindowControls 里").toContain('<div className="tb-win">');
    for (const anchor of ['t("title.minimize")', 't("title.maximize")', 't("title.close")']) {
      expect(wctl, `窗口键不在窗键组里：${anchor}`).toContain(anchor);
    }
  });

  it("App 把 settingsOpen 交给身份栏（这条线断了，收起就是永不发生）", () => {
    expect(/<IdentityBar\s+fullPage=\{settingsOpen\}/.test(read(APP)), "App.tsx 没再把 settingsOpen 传下去").toBe(true);
  });
});

describe("P157-F · 设置页全窗二栏（ZCode 脸）", () => {
  it("遮罩吃满全窗：inset: 0（P111-B 的旧裁决已由用户显式改判，身份栏职能搬进页里）", () => {
    const body = bodyOfRule(".modal-mask.set-page-mask");
    expect(body, "不再吃满全窗").toContain("inset: 0");
    expect(body, "还从身份栏下沿开始（38px 露头 = 旧三分布局）").not.toContain("--h-ibar");
  });

  it("页内有拖拽条、左栏品牌、右栏窗键组，且三样都有样式", () => {
    const src = read(PAGE);
    expect(src, "拖拽条不见了（窗口没法拖了）").toContain('className="set-drag"');
    expect(src, "左栏品牌不见了").toContain('className="set-nav-brand"');
    expect(src, "右栏窗键组不见了").toContain("<WinKeys withPin />");
    expect(CSS, "拖拽条没有样式").toContain(".set-drag {");
    expect(CSS, "窗键组没有定位样式").toContain(".set-winctl {");
    expect(CSS, "左栏品牌没有样式").toContain(".set-nav-brand {");
  });

  it("置顶单一出处：身份栏与窗键组同读 windowCtl；身份栏 fullPage 时 inert", () => {
    const tb = read(MODAL);
    expect(tb, "身份栏没接共享 store").toContain("useWindowPin");
    expect(read("shell/WindowControls.tsx"), "窗键组没接共享 store").toContain("useWindowPin");
    expect(tb, "身份栏没 inert（Tab 会走进被盖住那排看不见的按钮）").toContain("inert={fullPage ? true : undefined}");
  });
});

/** P155-S：设置页列宽与顶线的形状钉。上面那个 `ruleBody` 用 indexOf 找第一个出现处，
 *  会被注释里提到的选择器名骗到（`.set-card` 在页头注释里出现过）——这一节改用
 *  "选择器 + 空格 + {" 定位，只认真的规则头。 */
function bodyOfRule(sel: string): string {
  const at = CSS.indexOf(`${sel} {`);
  expect(at, `theme.css 里找不到规则 ${sel} {`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}

describe("P155-S · 设置页列宽与顶线", () => {
  it("列宽上限只有一枚出处：--set-col-w，页头/卡片/模型页/插件页四处引用", () => {
    expect(bodyOfRule(".set-modal"), "变量没在 .set-modal 上声明").toContain("--set-col-w: 1080px");
    for (const sel of [".set-page-head", ".set-card"]) {
      expect(bodyOfRule(sel), `${sel} 没引用 --set-col-w（改一处漏一处就是 P155 前那种错位）`).toContain("var(--set-col-w)");
    }
    expect(bodyOfRule(".msp"), "模型页没引用").toContain("var(--set-col-w)");
    expect(bodyOfRule(".set-plugins-page"), "插件页没引用").toContain("var(--set-col-w)");
  });

  it("全页打开时身份栏不画分级线：ib-fullpage 只由 fullPage 一个来源驱动", () => {
    const tb = read(MODAL);
    expect(tb, "ibar 的类不再是 fullPage 条件式").toContain('`ibar${fullPage ? " ib-fullpage" : ""}`');
    expect(bodyOfRule(".ibar.ib-fullpage"), "规则不在：线色没转透明").toContain("border-bottom-color: transparent");
    // 工作区那条线必须还在（只改全页态，不做全局删除）
    expect(bodyOfRule(".ibar"), "身份栏的基础下边框被整条删了").toContain("border-bottom: 1px solid var(--elevation-line)");
  });
});

describe("P156-Z · 设置页 ZCode 化（两栏行 + 页头档）", () => {
  it("--fs-2xl 在 :root 声明，页头只引用它（不是就地写 28px）", () => {
    expect(bodyOfRule(":root"), "--fs-2xl 没立档").toContain("--fs-2xl: 28px");
    expect(bodyOfRule(".set-page-title"), "页头没引 --fs-2xl").toContain("var(--fs-2xl)");
  });

  it("导航列 240px，与分栏后的 ZCode 侧栏同宽", () => {
    expect(bodyOfRule(".set-page .set-nav")).toContain("flex: 0 0 240px");
  });

  it("设置行是两栏网格：说明在标签正下方（desc 区），控件占 ctl 区", () => {
    const row = bodyOfRule(".set-row");
    expect(row, "行不再是网格").toContain("display: grid");
    expect(row, "没有两行模板（label/desc 同列、ctl 跨两行）").toContain('"label ctl" "desc ctl"');
    expect(bodyOfRule(".set-row:not(.has-desc)"), "无说明的单行收形不见了").toContain('grid-template-areas: "label ctl"');
    expect(bodyOfRule(".set-desc"), "说明行没有网格位").toContain("grid-area: desc");
    expect(CSS, "控件列没落 ctl 区").toContain(".set-ctl { grid-area: ctl;");
  });

  it("SettingsModal 的 row() 把短说明转可见 desc，长注记仍保底走悬停", () => {
    const src = read(PAGE);
    expect(src, "row() 不再产出 desc").toContain("desc={short ? tip : undefined}");
    expect(src, "长注记没保底留在悬停里").toContain("tip={short ? undefined : tip}");
    expect(src, "说明长度阈值不见了").toContain("DESC_CJK_MAX");
  });
});

describe("P157-R · 卡组行自动堆叠（不再被压进 auto 列）", () => {
  it("含卡组的行是单列堆叠：theme-grid / preset-grid / set-apr 三家同一形状", () => {
    // 三家的规则头同行并列，从第一个选择器切到 `}` 拿到整块
    const at = CSS.indexOf(".set-row:has(> .set-ctl .theme-grid)");
    expect(at, "卡组堆叠规则不见了（P156-Z 的 auto 列挤压会回来）").toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf("}", at));
    for (const sel of [".set-row:has(> .set-ctl .preset-grid)", ".set-row:has(> .set-ctl .set-apr)"]) {
      expect(block, `${sel} 不在同一规则组里（漏一家就是漏一片消费面）`).toContain(sel);
    }
    expect(block, "卡组行没落单列").toContain("grid-template-columns: minmax(0, 1fr)");
    expect(block, "卡组行不是堆叠区（label/desc/ctl 三行）").toContain('grid-template-areas: "label" "desc" "ctl"');
    expect(block, "卡组行还是两栏（label ctl 并存）").not.toContain('"label ctl"');

    // 无说明时收成两行（:not(.has-desc) 与通用收形同一条思路）
    const at2 = CSS.indexOf(".set-row:has(> .set-ctl .theme-grid):not(.has-desc)");
    expect(at2, "无说明卡组行的收形不见了").toBeGreaterThan(-1);
    const block2 = CSS.slice(at2, CSS.indexOf("}", at2));
    expect(block2, "无说明卡组行没收成 label/ctl 两行").toContain('grid-template-areas: "label" "ctl"');
  });
});
