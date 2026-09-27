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

it("键盘语义齐全：上下 / Home / Enter / Escape 一个都不能少", async () => {
  const s = await read("./Listbox.tsx");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "Enter", "Escape"]) {
    expect(s, `少了 ${key}：菜单必须能纯键盘用`).toContain(`"${key}"`);
  }
  expect(s).toContain('role="listbox"');
  expect(s).toContain("aria-selected");
});
