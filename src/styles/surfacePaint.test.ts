/**
 * P110-A：三条"自己画底"的表面规则钉成门禁。
 *
 * 钉的是什么：用户 2026-09-27 报的"控制台越滚越白"与同族漏底，成因是这些区域**自己不声明背景**、
 * 只靠祖先兜着 —— 而 `--bg-panel` 是可以被主题/玻璃配方写成带 alpha 的值（`appearanceTools.glassVars`
 * 就是故意这么写的），于是"透明滚动层 + 半透明背板"在反复重绘时会一层层叠上来。
 * 修法不是挑某枚主题的错，是把这几层的底**显式化**：同一枚 token，视觉零变化，
 * 变的是不再借背板。所以这里要断言的是"这条规则里有没有 background"，不是"它是不是某个色值"。
 *
 * 为什么断言源码而不是 computed style：测试环境是 node，`color-mix` / `var()` 链根本不求值，
 * `getComputedStyle` 拿回来的是黑值 —— 拿它当证据等于对着假数据点头（P103 那条"指标错了会逼出
 * 错误的修法"同理）。真机那一遍在 tauri dev 里验。
 *
 * 用 `./theme.css` 的变量式 specifier：与 `selectPopup.test.ts` 同一手法，
 * 让静态扫描器认得出这是读文件而不是引依赖。
 */
import { expect, it } from "vitest";

const cssSpec = "./theme.css";
const fsSpec = "node:fs";
const urlSpec = "node:url";

async function css(): Promise<string> {
  const { readFileSync } = (await import(fsSpec)) as unknown as {
    readFileSync: (p: string, enc?: string) => string;
  };
  const { fileURLToPath } = (await import(urlSpec)) as unknown as {
    fileURLToPath: (u: string | URL) => string;
  };
  return readFileSync(fileURLToPath(new URL(cssSpec, import.meta.url)), "utf8");
}

/** 取某条规则的花括号体（只取第一条同名规则，够用且不会因为"别处又写了一份"而假绿） */
function ruleBody(src: string, selector: string): string {
  const at = src.indexOf(`\n${selector} {`);
  expect(at, `找不到规则 ${selector} —— 它被改名或删掉了，本守卫的断言对象就消失了`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  const close = src.indexOf("}", open);
  return src.slice(open + 1, close);
}

/** 这些层都是"会滚动 / 会横挤"的条带，漏底的代价由它们先付 */
const PAINTED = [".console-view", ".ai-toolbar", ".plg-toolbar"] as const;

it("三处滚动/条带层必须自己声明 background（只靠祖先兜着 = 主题一写半透明就漏底）", async () => {
  const s = await css();
  for (const sel of PAINTED) {
    const body = ruleBody(s, sel);
    expect(body, `${sel} 又回到"不画背景、靠祖先"的写法`).toMatch(/background(-color)?\s*:/);
  }
});

it("画的是表面档 token，不是硬编码色（写死一个 hex 就等于把主题通道焊死）", async () => {
  const s = await css();
  for (const sel of PAINTED) {
    const decl = ruleBody(s, sel).match(/background(?:-color)?\s*:\s*([^;]+);/);
    expect(decl, `${sel} 的 background 声明解析不出来`).not.toBeNull();
    expect(decl![1]).toMatch(/^var\(--(bg|bg-panel|bg-inset|bg-titlebar)\)$/);
  }
});

it("`.console-view` 与它的滚动容器画同一枚 token（两档不一致 = 滚动时能看到接缝）", async () => {
  const s = await css();
  const view = ruleBody(s, ".console-view").match(/background:\s*([^;]+);/);
  const host = ruleBody(s, ".console").match(/background:\s*([^;]+);/);
  expect(view?.[1].trim()).toBe(host?.[1].trim());
});
