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
    expect(ruleBody(".set-page-title").includes("var(--fs-xl)")).toBe(true);
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
    // 置顶与窗口三件在守卫之外：用户点名的"右边留着关闭、置顶、最小化"
    expect(tb.indexOf("aria-pressed={pinned}")).toBeGreaterThan(guardEnd);
    expect(tb.indexOf('<div className="tb-win">')).toBeGreaterThan(guardEnd);
  });

  it("App 把 settingsOpen 交给身份栏（这条线断了，收起就是永不发生）", () => {
    expect(/<IdentityBar\s+fullPage=\{settingsOpen\}/.test(read(APP)), "App.tsx 没再把 settingsOpen 传下去").toBe(true);
  });
});
