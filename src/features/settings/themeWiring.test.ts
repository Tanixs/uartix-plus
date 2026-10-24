/**
 * P99b-N5 · "谁在画这一枚主题"这件事只剩一处的接线钉（详设 §7 G1/G6/G9）。
 *
 * 手法说明（为什么是源文本钉而不是行为测试）：没有 RTL，组件里"渲染出来长什么样"测不到；
 * 但**"这句话是谁算的、有没有人又自己算一遍"是能钉的**——它就是一个赋值/调用形状。
 *
 * P174-A18：旧的插件库弹窗与市场整目录已删除，本文件同步去掉那几处对已删文件的引用；
 * 留下的每条仍然钉着**今天还在跑**的那条链（extRuntime / themePicker / artifact store）。
 */
import { describe, expect, it } from "vitest";
// 本仓 tsc 没有 @types/node：读盘走变量说明符（同其它源码钉的写法）
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readdirSync, readFileSync } = (await import(fsSpec)) as {
  readdirSync: (p: string, o?: unknown) => { name: string; isDirectory(): boolean }[];
  readFileSync: (p: string, e?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 扫 src 下所有 ts/tsx（跳过测试与快照）：钉"某个形状只出现在哪几个文件里"用 */
function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(`${ROOT}${dir}`, { withFileTypes: true })) {
    if (e.isDirectory()) sourcesUnder(`${dir}/${e.name}`, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(`${dir}/${e.name}`);
  }
  return out;
}

const ALL = [
  ...sourcesUnder("features"),
  ...sourcesUnder("styles"),
  ...sourcesUnder("shared"),
  ...sourcesUnder("panels"),
  "App.tsx",
  "main.tsx",
];
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");
/** 注释里提到某个形状不算"这里也写了一份"：赋值形状要排除比较运算（=== 的首个 =） */
const filesWith = (re: RegExp) => ALL.filter((f) => re.test(read(f)));

describe("P99b-N5 · 写 data-theme / data-scheme 的地方只有一处（R7/G6）", () => {
  it("主文档的 dataset.theme 赋值只在 extRuntime；三份复制（App/SettingsModal/appActions）不许回来", () => {
    const writers = filesWith(/dataset\.theme\s*=(?!=)/);
    expect(
      writers.filter((f) => f !== "features/ai/widgetBridge.ts" && f !== "features/sentinel/SentinelWidget.tsx"),
      "widgetBridge 那处写的是 iframe 自己的 document、SentinelWidget 写的是挂件窗口的 document（两个独立文档，不是宿主）",
    ).toEqual(["features/ai/extRuntime.ts"]);
    expect((read("features/ai/extRuntime.ts").match(/dataset\.theme\s*=/g) ?? []).length, "同一个文件里写两份也算复制").toBe(1);
  });

  it("明暗归属同样只有一个出口：宿主里 dataset.scheme 只在 extRuntime 赋值", () => {
    expect(filesWith(/dataset\.scheme\s*=/)).toEqual(["features/ai/extRuntime.ts", "features/ai/widgetBridge.ts"]);
  });

  it("三处触发点都只叫 applyStyleExts／selectTheme，不各自落地", () => {
    expect(read("App.tsx")).toMatch(/const apply = \(\) => applyStyleExts\(\)/);
    expect(read("features/settings/SettingsModal.tsx")).toMatch(/=\s*await selectTheme\(/);
    expect(read("features/ai/appActions.ts")).toMatch(/=\s*await selectTheme\(/);
    // 复制过的那段"system 解析成 light/dark"不许在组件里复活
    for (const f of ["App.tsx", "features/settings/SettingsModal.tsx", "features/ai/appActions.ts"]) {
      expect(read(f), `${f} 又开始自己判 system 解析`).not.toMatch(/system\s*\?[^;]*"dark"/);
    }
  });
});

describe("P99b-N5 · 判定源与枚举各只有一处（R1/G1）", () => {
  it("resolveActiveTheme 只在 extRuntime 被叫；没有第二处 filter+sort 主题记录", () => {
    expect(filesWith(/resolveActiveTheme\(/)).toEqual(["features/ai/extRuntime.ts", "styles/themeCore.ts"]);
    for (const f of ["features/settings/SettingsModal.tsx", "features/ai/appActions.ts"]) {
      expect(read(f), `${f} 自己 filter+sort 主题记录，就是第二处判定`).not.toMatch(/createdAt[\s\S]{0,40}sort|sort\([\s\S]{0,40}createdAt/);
      expect(read(f)).not.toMatch(/enabledThemePlugins\s*:/);
    }
  });

  it("「带 theme 产物的包」只有一处枚举（pluginStore.themeArtsOf）", () => {
    expect(filesWith(/function themeArtsOf/)).toEqual(["features/plugins/pluginStore.ts"]);
    expect(read("features/settings/themePicker.ts")).toContain("themeArtsOf(");
  });

  it("内置那几枚的 id 清单只有一份（builtinThemes），设置页的列表由测试对齐它", () => {
    expect(filesWith(/BUILTIN_THEME_IDS:\s*readonly/)).toEqual(["styles/builtinThemes.ts"]);
    expect(read("features/settings/themePicker.ts")).toContain("BUILTIN_THEMES");
    expect(read("features/settings/SettingsModal.tsx"), "选择器不再自己枚举内置主题").not.toContain("THEME_LIST.map");
  });
});

describe("P99b-N5 · 色板抄本不许回来（§1-8）", () => {
  it("SettingsModal 里没有手抄的主题色字面量，预览一律来自 token 表", () => {
    const modal = read("features/settings/SettingsModal.tsx");
    expect(modal, "手抄色板又回来了").not.toMatch(/const THEME_SWATCH/);
    expect(modal).not.toMatch(/linear-gradient\(135deg/);
    expect(modal).not.toMatch(/bg:\s*"#[0-9a-fA-F]{6}"/);
    expect(modal).toMatch(/themeCards\(\{/);
    expect(modal).toMatch(/c\.swatch\.bg/);
  });

  it("theme.css 里核心色键一处声明都没有（值只活在主题文件与兜底层）", () => {
    const css = read("styles/theme.css");
    for (const k of ["--bg:", "--bg-panel:", "--accent:", "--text:"]) {
      expect(css.includes(`\n  ${k}`), `theme.css 又自己给 ${k} 上色了`).toBe(false);
    }
  });
});

describe("P99b-N5 · 小部件 iframe 那条通道真的接上了", () => {
  const bridge = read("features/ai/widgetBridge.ts");

  it("applyTheme 有调用者：aiw:init 与 aiw:theme 两条都要走它", () => {
    expect(bridge, "aiw:theme 分支又没了 ⇒ 小部件停在出厂配色").toMatch(
      /else if\(d\.type==="aiw:theme"\)\{applyTheme\(d\.vars,d\.theme,d\.scheme\)\}/,
    );
    expect(bridge, "首帧 aiw:init 也要立刻贴主题，不能等下一次广播").toMatch(
      /applyTheme\(d\.vars,d\.theme,d\.scheme\)\}/,
    );
  });

  it("明暗从宿主下发的 scheme 来，桥里不许再按主题名猜", () => {
    expect(bridge, "又回到按名字判明暗：同级之后 id 可能是 plg:…:main，那样暗色产物会被当亮色")
      .not.toMatch(/theme==="dark"\|\|theme==="navy"/);
    expect(bridge).toMatch(/dataset\.scheme=scheme/);
  });

  it("宿主侧：aiw:init 的载荷里必须带 scheme（桥拿不到就得猜）", () => {
    expect(read("features/ai/WidgetFrame.tsx")).toMatch(/scheme: th\?\.scheme \?\? null,/);
    expect(read("features/ai/widgetHub.ts")).toMatch(/broadcast\(\{ type: "aiw:theme", vars, theme, scheme \}\)/);
  });
});

describe("P102 · 卡面减负之后，判断仍然只在派生层", () => {
  it("横线插在哪由 themePicker 算；视图里不许再数一遍「哪些算插件主题」", () => {
    const modal = read("features/settings/SettingsModal.tsx");
    expect(modal, "选择器又开始自己找分隔位置了 ⇒ 与 themePicker 的口径会漂").toContain("pluginSectionStart(");
    expect(modal, "视图里自己判 builtin 分段，就是第二处「哪些算插件主题」").not.toMatch(/cards\.(findIndex|filter)\(/);
    for (const badge of ["theme-flag", "theme-kind", '"waiting"']) {
      expect(modal, `角标 ${badge} 又挂回卡面了`).not.toContain(badge);
    }
  });
});

describe("P99b-N5 · 启停文案同源（§4③）", () => {
  it("互斥话术只长在 themePicker 里，其它界面只准引它", () => {
    expect(filesWith(/function themeButtonTalk/)).toEqual(["features/settings/themePicker.ts"]);
    for (const f of ["features/settings/SettingsModal.tsx"]) {
      expect(read(f), `${f} 自己拼了一句互斥话术`).not.toMatch(/挤掉[^"']*「\$\{[a-z]/);
    }
  });
});
