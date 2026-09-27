import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P104-B1：默认拓扑的算术守卫。
 *
 * 这个文件本身是一次自我纠正。第一版在这里断言"主区的 initialWidth 必须等于 midW"，
 * 11 条全绿，我还做了"改回旧表达式就会红"的证伪，于是当成真守卫交了出去。
 * **那是错的**：假 api 只是把 addPanel 记下来，没有模拟 dockview 的切分语义，
 * 于是我一个凭想象编的不变量也能顺利变绿——证伪也只证明了"测试能察觉偏离我的模型"。
 * 真机实测反证：主区给 midW 时 templates 拿到 649/1319；给 midW + rightW 时才恰剩 leftW。
 *
 * 所以现在假 api **模拟切分**：`direction:"right"` 表示新面板从参考面板切走 initialWidth，
 * 其余归参考。断言的是**最终宽度**，不是源码里的表达式——只有这种断言能同时拦住两种错。
 */

// settingsStore 求值期就读 localStorage，而静态 import 会提升到所有语句之前
// ⇒ 先 stub 再动态导入（项目同法见 settingsTools.test.ts）
const LS = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => LS.get(k) ?? null,
  setItem: (k: string, v: string) => LS.set(k, v),
  removeItem: (k: string) => LS.delete(k),
});
const DOC = { documentElement: { style: { zoom: "100%" } } };
vi.stubGlobal("document", DOC);
vi.stubGlobal("window", {
  innerWidth: 1319,
  innerHeight: 950,
  dispatchEvent: () => {},
  // railState 在求值期挂一个 resize 监听（P105-D：拖宽之后缩窗要重新夹上限），
  // 这个替身不给 addEventListener 就会在 import 时炸。
  addEventListener: () => {},
  removeEventListener: () => {},
});
const { WORKSPACE_PRESETS } = await import("../features/settings/settingsStore");
const { applyDefaultLayout, SHELL_CHROME } = await import("./defaultLayout");

const VIEWPORT = { w: 1319, h: 950 };

/**
 * 壳的三个尺寸在 TS 与 CSS 各写了一份（CSS 拿不到 TS 常量，JS 也读不到 flex basis 的运行时值）。
 * 与其写一句"改这里要改那里"的注释，不如让测试去 CSS 里把那个数抠出来对一遍——
 * 漂了就红。B13 把尺寸收进 CSS 变量之后，这条守卫改成对变量本身。
 */
// tsconfig 的 include 只有 src、没挂 node types ⇒ 沿用 tourSteps.test.ts 的动态导入法
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as {
  fileURLToPath: (u: string | URL) => string;
};
const css = readFileSync(
  fileURLToPath(new URL("../styles/theme.css", import.meta.url)),
  "utf8",
) as string;
/** 抠 `.sel { … flex: 0 0 <N>px … }` 里的那个 N。
 *  两种写法都认：定值（`.rail2{flex:0 0 48px}`）与带 CSS 变量的回退值
 *  （P105-D 之后 `.rail-panel{flex:0 0 var(--rail-w, 300px)}`）。
 *  取**最后一个** px：`var(--rail-w, 300px)` 里的 300 才是回退值，前面的 `--rail-w` 没有 px。
 *  这条断言没有放松 —— 它从"抄本 == 抄本"变成"TS 默认值 == CSS 回退值"，
 *  仍然钉着同一个数，只是钉的是真正会被用到的那一个。 */
const flexBasis = (sel: string): number => {
  const m = new RegExp(`^\\.${sel} \\{[^}]*?flex: 0 0 ([^;]+);`, "m").exec(css);
  expect(m, `theme.css 里 .${sel} 的 flex: 0 0 … 写法变了，抠不出数值`).not.toBeNull();
  let raw = m![1].trim();
  // P111-B：身份栏高度改挂在 `--h-ibar` 上（全窗口设置页的遮罩要用同一个数，
  // 抄两份就会有一天遮罩压住窗口控件）。这里**跟着 var() 解析到真值**再比 ——
  // 这条守卫的活是"CSS 与 TS 不许漂"，不是"CSS 里必须写字面量"，
  // 所以能解析间接引用才算它还在干活；解析不出来仍然判红，不放松。
  const varRef = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  if (varRef) {
    const t = new RegExp(`\\${varRef[1]}:\\s*([0-9.]+)px`, "m").exec(css);
    expect(t, `.${sel} 的 flex-basis 写了 ${varRef[1]}，但 theme.css 里找不到它的 px 定义`).not.toBeNull();
    raw = `${t![1]}px`;
  }
  const nums = [...raw.matchAll(/([0-9.]+)px/g)];
  expect(nums.length, `.${sel} 的 flex-basis 里找不到 px 数值`).toBeGreaterThan(0);
  return Number(nums[nums.length - 1][1]);
};

describe("SHELL_CHROME 与 theme.css 不许漂", () => {
  it("导轨宽 / 身份栏高 / 工具栏高 / 信息栏高 / 二级面板宽 五处数值 CSS 与 TS 一致", () => {
    expect(SHELL_CHROME.railW).toBe(flexBasis("rail2"));
    expect(SHELL_CHROME.barH).toBe(flexBasis("ibar"));
    expect(SHELL_CHROME.toolH).toBe(flexBasis("tbar"));
    expect(SHELL_CHROME.infoH).toBe(flexBasis("statusbar"));
    expect(SHELL_CHROME.railPanelW).toBe(flexBasis("rail-panel"));
  });
});

/**
 * P105-D：二级面板可以拖宽了，于是"上限"不再是常数。
 * 这条钉的是它**为什么不能是常数**：拖到把画布挤没，就又是 P3 那批
 * "面板工具条放不下、控件点不到"的形状。
 */
describe("P105-D 二级面板的宽度上限跟着视口走", () => {
  // 主区下限 + 右栏下限，与 applyDefaultLayout 里那两个 Math.max 同源
  const GRID_FLOOR = 480 + 260;

  it("railPanelMaxAvailable = 视口 − 导轨 48 − 画布下限", async () => {
    const { railPanelMaxAvailable } = await import("./defaultLayout");
    const w = globalThis.window as unknown as { innerWidth: number };
    const orig = w.innerWidth;
    try {
      w.innerWidth = 1319;
      expect(railPanelMaxAvailable()).toBe(1319 - SHELL_CHROME.railW - GRID_FLOOR);
      w.innerWidth = 1100; // min_inner_size
      expect(railPanelMaxAvailable()).toBe(1100 - SHELL_CHROME.railW - GRID_FLOOR);
    } finally {
      w.innerWidth = orig;
    }
  });

  it("窄窗下 setRailPanelW 自己收紧，不会把画布挤破下限", async () => {
    const rail = await import("./railState");
    const w = globalThis.window as unknown as { innerWidth: number };
    const orig = w.innerWidth;
    try {
      w.innerWidth = 1100;
      rail.setRailPanelW(500);
      const got = rail.railPanelW();
      expect(got).toBeLessThanOrEqual(1100 - SHELL_CHROME.railW - GRID_FLOOR);
      expect(got).toBeGreaterThanOrEqual(rail.RAIL_PANEL_MIN);
      // 布局分母与 CSS 用的是同一个数：拖完之后的网格宽度必须还放得下画布下限
      expect(1100 - SHELL_CHROME.railW - got).toBeGreaterThanOrEqual(GRID_FLOOR);
    } finally {
      w.innerWidth = orig;
      rail.resetRailPanelW();
    }
  });

  it("再窄也不许低于下限（宁可画布挤，也不给出一条 0 宽的面板）", async () => {
    const rail = await import("./railState");
    const w = globalThis.window as unknown as { innerWidth: number };
    const orig = w.innerWidth;
    try {
      w.innerWidth = 700; // 比 min_inner_size 还窄，真机进不去，但钳制不能失效
      rail.setRailPanelW(240);
      expect(rail.railPanelW()).toBe(rail.RAIL_PANEL_MIN);
    } finally {
      w.innerWidth = orig;
      rail.resetRailPanelW();
    }
  });
});

interface AddArg {
  id: string;
  position?: { direction?: string; referencePanel?: string };
  initialWidth?: number;
  initialHeight?: number;
  minimumWidth?: number;
}

/** 模拟 dockview 的行列切分，返回每个面板最终占有的宽度（逻辑 CSS px） */
function simulate(adds: AddArg[], w: number): Map<string, number> {
  const width = new Map<string, number>();
  for (const a of adds) {
    const dir = a.position?.direction;
    const ref = a.position?.referencePanel;
    if (!ref) {
      width.set(a.id, w);
      continue;
    }
    const refW = width.get(ref) ?? 0;
    if (dir === "within") {
      width.set(a.id, refW); // 同组 tab，不改宽
      continue;
    }
    if (dir === "below") {
      width.set(a.id, refW); // 换行，继承所在列宽
      continue;
    }
    const take = a.initialWidth ?? 0;
    width.set(a.id, take);
    width.set(ref, Math.max(0, refW - take));
  }
  return width;
}

/** 每个预设的**根面板**（第一个无 position 的 add）。R5 起它不再叫 templates。 */
const ROOT_OF: Record<string, string> = {
  console: "hexview",
  video: "video",
  calib: "plot3d",
  modbus: "modbus",
  vdev: "vdev",
  auto: "sequencer",
  analyze: "plot2d",
  proto: "framecanvas",
  attitude: "framecanvas",
};

function run(preset: string, zoomPct = 100, railRightW = 0) {
  const adds: AddArg[] = [];
  const api = {
    addPanel: (o: AddArg) => adds.push(o),
    getPanel: () => ({ api: { setActive: () => {}, setVisible: () => {} } }),
  };
  document.documentElement.style.zoom = `${zoomPct}%`;
  applyDefaultLayout(api as never, preset as never, (id) => id, railRightW);
  const zf = zoomPct / 100;
  // 与实现逐字对齐：w 不取整（1319/1.25 = 1055.2），否则这里会因舍入差 0.2px 假红。
  // 两个宽度都取 SHELL_CHROME —— 它们防的是"实现算错"，防不了"常量本身与 CSS 漂开"，
  // 后者由上面那条 CSS↔TS 守卫负责。两条各管一段，合起来才闭合。
  const w = VIEWPORT.w / zf - SHELL_CHROME.railW - railRightW;
  const leftW = Math.max(240, Math.round(w * 0.25));
  const rightW = Math.max(260, Math.round(w * 0.25));
  return { widths: simulate(adds, w), w, leftW, rightW, midW: Math.max(480, w - rightW) };
}

beforeEach(() => {
  document.documentElement.style.zoom = "100%";
});

describe("R5 两列拓扑的真实落位", () => {
  it("主区得 midW、右栏得 rightW；templates 一份都不许出现", () => {
    for (const preset of ["proto", "video", "calib", "modbus", "attitude"]) {
      const r = run(preset);
      expect(r.widths.has("templates"), `${preset} 还在排 templates`).toBe(false);
      expect(r.widths.get(ROOT_OF[preset]), `${preset} 主区`).toBe(r.midW);
    }
    // analyze 是唯一"主区还被底行再切一刀"的预设：频谱与 2D 同排，切走的是主区那一列，
    // 所以它拿的是 midW - bottomColW 而不是 midW。这是既有形状，R5 没动它。
    const a = run("analyze");
    expect(a.widths.has("templates")).toBe(false);
    expect(a.widths.get("plot2d")).toBe(a.midW - Math.max(280, Math.round(a.midW / 2)));
  });

  it("主区 + 右栏 = 网格宽（视口减导轨），不多配也不少配", () => {
    for (const preset of WORKSPACE_PRESETS) {
      const r = run(preset);
      // auto 是唯一保留三列的预设：序列器 / 编排器 / 哨兵是三个并列工作台，
      // 不是"库 + 画布"那种从属关系，所以它按 leftW + midW + rightW 算。
      const sum =
        preset === "auto"
          ? r.widths.get("sequencer")! + r.widths.get("orchestrator")! + r.widths.get("sentinel")!
          : r.midW + r.rightW;
      expect(sum, preset).toBeLessThanOrEqual(r.w);
    }
  });

  it("B5：分配的分母是网格宽，不是整窗宽（导轨 48px 必须扣掉）", () => {
    const r = run("proto");
    // 不扣导轨的话 rightW 会是 round(1319*0.25)=330；扣了才是 318
    expect(r.w, "网格宽应比整窗窄一整个导轨").toBe(VIEWPORT.w - SHELL_CHROME.railW);
    expect(r.midW + r.rightW).toBe(r.w);
    expect(r.widths.get("framecanvas")).toBe(r.midW);
    expect(r.rightW).toBeLessThan(Math.round(VIEWPORT.w * 0.25));
  });

  it("R：二级面板展开时再扣 300px；切分恒等式在两态都成立", () => {
    const closed = run("proto", 100, 0);
    const open = run("proto", 100, SHELL_CHROME.railPanelW);
    expect(open.w).toBe(closed.w - SHELL_CHROME.railPanelW);
    // 971 的 25% 是 243，低于 260 的下限，所以这里落到的是**下限**而不是比例——
    // 正是 R5 想要的形状：窄到挤不动时收缩的是主区（它没有绝对下限压着），
    // 而不是像旧的三列那样把某一列压破自己的下限。
    expect(open.rightW).toBe(260);
    expect(Math.round(open.w * 0.25)).toBeLessThan(open.rightW);
    // dockview 的切分语义：主区拿的是"剩下的"，不是 midW 本身。
    // 恒等式在两种面板状态下都必须成立——这才是这条守卫真正钉的东西。
    for (const r of [closed, open]) {
      expect(r.widths.get("framecanvas")).toBe(Math.max(0, r.w - r.rightW));
    }
  });

  /* R 实测发现的既有缺陷，R5 修掉：三列的绝对下限之和 = 240 + 480 + 260 = 980，
     而 1319 窗口开 300px 二级面板后网格只有 971，左列会被压到 231（低于它自己的 240 下限），
     125% 缩放下差得更多。R5 把 templates 从拓扑里摘掉后只剩两列，
     下限之和降到 480 + 260 = 740 —— 同一份网格从此有余量。
     这条从"记录现状"翻成"钉住修复"：谁再把左列加回来，这里就红。 */
  it("R5：两列下限之和必须容得下最窄网格（不再压破任何一列）", () => {
    const open = run("proto", 100, SHELL_CHROME.railPanelW);
    const FLOORS = 480 + 260;
    expect(open.w).toBeGreaterThan(FLOORS); // 971 > 740
    expect(open.widths.get("framecanvas")!).toBeGreaterThanOrEqual(480);
    expect(open.rightW).toBeGreaterThanOrEqual(260);
    expect(open.widths.has("templates")).toBe(false);
  });
});

describe("分母必须是逻辑 CSS px", () => {
  it("zoom=125% 时按 innerWidth/1.25 预算：主区变窄而不是不变", () => {
    const at100 = run("proto", 100);
    const at125 = run("proto", 125);
    expect(at125.w).toBe(VIEWPORT.w / 1.25 - SHELL_CHROME.railW);
    expect(at125.rightW).toBeLessThan(at100.rightW);
    expect(at125.widths.get("framecanvas")).toBe(at125.midW);
    expect(at100.widths.get("framecanvas")).toBe(at100.midW);
  });
});
