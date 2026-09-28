/**
 * P110-E 的守卫：共享 Listbox 的三条硬约定钉成门禁。
 *
 * 为什么断言源码而不是 computed style：测试环境是 node，没有 CSS 引擎，`color-mix`/`var()`
 * 链读回来是垃圾值，拿它当证据等于对着假数据点头（`surfacePaint.test.ts` 同一口径）。
 * 真机那一遍靠 `tauri dev`：这里能钉住的是"约定没被改回去"，钉不住"点开长得对不对"。
 *
 * 三条里最容易被无声破坏的是第二条：谁新写一份带 `border:` 的菜单样式都能过编译，
 * 但 G 门数的是全仓边框条数（只降不升），基元一旦各自画描边就是把门往上抬。
 */
import { expect, it } from "vitest";

// 相对的是**本测试文件**（src/shared/），所以样式表在 ../styles 下
const cssSpec = "../styles/theme.css";
const fsSpec = "node:fs";
const urlSpec = "node:url";

async function read(rel: string): Promise<string> {
  const { readFileSync } = (await import(fsSpec)) as unknown as {
    readFileSync: (p: string, enc?: string) => string;
  };
  const { fileURLToPath } = (await import(urlSpec)) as unknown as {
    fileURLToPath: (u: string | URL) => string;
  };
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

it("Listbox 走 portal 到 document.body（弹层留在祖先的 overflow/z-index 里就会被裁）", async () => {
  const s = await read("./Listbox.tsx");
  expect(s).toMatch(/createPortal\(/);
  expect(s, "必须是挂到 body 上，不是挂到某个容器").toMatch(/,\s*document\.body\s*,?\s*\)/);
});

it("行样式不带自己的 border：菜单那张脸由 .ctx-menu 提供，全仓边框条数只降不升", async () => {
  const css = await read(cssSpec);
  const at = css.indexOf(".lbx-row {");
  expect(at, ".lbx-row 不见了——基元的行样式被删了就是没人在用它").toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf("}", at));
  expect(body, ".lbx-row 里出现了 border —— 基元开始各画一份描边了").not.toMatch(/border\s*:/);
  expect(css).toContain(".ctx-menu {");
});

it("波特率那张本地菜单已经收编（不许留第二份实现）", async () => {
  const css = await read(cssSpec);
  const params = await read("../features/serial/SerialParams.tsx");
  expect(css, ".baud-menu 的规则还留在样式里 = 两张菜单各自演进").not.toMatch(/^\.baud-menu/m);
  expect(params, "波特率框里又自己写了一份菜单").not.toContain("baud-menu");
  expect(params, "没换成共享 Listbox").toContain("<Listbox");
});

it("键盘语义齐全：上下 / Home / End / Enter / Escape 一个都不能少", async () => {
  const s = await read("./Listbox.tsx");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]) {
    expect(s, `少了 ${key}：菜单必须能纯键盘用`).toContain(`"${key}"`);
  }
  expect(s).toContain('role="listbox"');
  expect(s).toContain("aria-selected");
});

/**
 * P115-F3 加严：上一版只钉键名字符串，而键盘其实是死的——容器没有 tabIndex，
 * 焦点从不进入弹层，onKeyDown 一场空。这里钉"焦点真的会动"的三段接线形状：
 * 容器可编程聚焦 / 打开后有 focus() 调用 / 选中与 Esc 都把焦点还给锚点。
 */
it("焦点真的进得来、回得去：容器 tabIndex + 打开即聚焦 + 关闭归还锚点", async () => {
  const s = await read("./Listbox.tsx");
  // §8-41④：先剥注释再断言——注释里复述 `tabIndex={-1}` 不算接线
  const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/([^:])\/\/[^\n]*/g, "$1");
  expect(code, "容器必须 tabIndex={-1}（不进 Tab 序，但可编程聚焦）").toMatch(/tabIndex=\{-1\}/);
  expect(code, "open 后必须有 focus() 调用（否则 onKeyDown 全是死键）").toMatch(/boxRef\.current\?\.focus\(/);
  // 归还锚点的形状只此一处（closeAndRefocus），选中与 Esc 都走它：
  // 出现两个各自 focus anchor 的形状 = 关闭路径又开始各写各的
  expect(code.match(/anchorRef\.current\?\.focus\(\)/g)?.length, "归还锚点必须收口在 closeAndRefocus 一处").toBe(1);
  const helperAt = code.indexOf("const closeAndRefocus");
  expect(helperAt, "closeAndRefocus 不见了：Esc/选中又各写各的关闭").toBeGreaterThan(-1);
  const onKeyAt = code.indexOf("const onKey");
  expect(onKeyAt, "onKey 不见了").toBeGreaterThan(-1);
  const clickAt = code.indexOf("onClick={() => {");
  for (const user of [code.slice(helperAt, onKeyAt), code.slice(onKeyAt), code.slice(clickAt)]) {
    expect(user, "每条关闭路径都必须经 closeAndRefocus 归还锚点").toContain("closeAndRefocus");
  }
  // 上下键必须真的把焦点挪进行（focusRow = setActive + querySelector().focus()）
  const focusRowAt = code.indexOf("const focusRow");
  expect(focusRowAt, "focusRow（挪焦点的那只手）不见了").toBeGreaterThan(-1);
  const focusRowBody = code.slice(focusRowAt, code.indexOf("};", focusRowAt));
  expect(focusRowBody, "focusRow 必须真的调用行上的 focus()").toMatch(/querySelector[\s\S]*?\.focus\(\)/);
  const stepAt = code.indexOf("const step");
  expect(stepAt, "step 不见了").toBeGreaterThan(-1);
  const stepBody = code.slice(stepAt, code.indexOf("};", stepAt));
  expect(stepBody, "上下键不再挪焦点：step 里必须有 focusRow").toContain("focusRow(");
});

/** P115-F2：rect 里带着 zoom，写进 fixed style 必须 ÷zoom（Dropdown 同式，zoom.ts 已证） */
it("定位除以 zoom 且带视口钳制与向上翻", async () => {
  const s = await read("./Listbox.tsx");
  const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/([^:])\/\/[^\n]*/g, "$1");
  // left/top/minWidth 三处写坐标，每处都得除——少一处那一维就会飞
  expect(code.match(/\/ zf\}px`/g)?.length, "三处坐标（left/top/minWidth）必须全部 ÷zoom").toBe(3);
  expect(code, "没有读 zoom 因子").toContain('getComputedStyle(document.documentElement).zoom');
  expect(code, "缺视口钳制（贴近右/下屏沿时会被裁）").toContain("window.innerWidth");
  expect(code, "缺向上翻（放不下时该翻到锚点上方）").toMatch(/ar\.top - r\.height/);
  expect(code, "定位必须直接写 DOM style，不在 layout effect 里 setState（P88c 白屏教训）")
    .toMatch(/el\.style\.left = /);
  const css = await read(cssSpec);
  expect(css, ".ctx-menu 的 70vh 上限还在：vh 在 zoom 下双重缩放（§19）").not.toMatch(/max-height:\s*70vh/);
});
