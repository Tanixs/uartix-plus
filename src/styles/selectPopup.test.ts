/**
 * P110-D 守卫：下拉弹层的主题化**必须挂在裸 `select` 上**。
 *
 * 病根不是"缺组件"，是选择器覆盖不全：弹层换皮规则当年写成 `select.input`，
 * 于是全仓 169 支 `<select>` 里那 10 支没带 `input` 类的（帧画布模板选择器、新建模板对话框、
 * 页签条那颗…）照旧弹原生灰底方角菜单。用户看到的"好多地方还是灰白底"就是这个。
 * 顺带一句前提纠正：`color-scheme` 早就设了（`extRuntime.ts:161`），而仓库在 P103 就实测过
 * 根 color-scheme **染不黑**原生 select 弹层（`docs/handover/HANDOVER_P103_2026-09-23.md:404-409`），
 * 所以才引入 base-select。加 color-scheme 不解决问题，别再往那条路上走。
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

it("base-select 那一组挂在裸 select 上，不是 select.input（收窄回去就红）", async () => {
  const s = await css();
  expect(s).toMatch(/^select \{\n {2}appearance: base-select;/m);
  expect(s).toMatch(/^select::picker\(select\) \{/m);
  expect(s).toMatch(/^select::picker-icon \{/m);
  expect(s).toMatch(/^select option \{/m);
  // 反向钉：`select.input {` 这种窄写法一出现，未带类的 select 就又掉回原生弹层了
  expect(s, "又出现窄选择器 select.input { —— 弹层会漏掉没带 input 类的 select")
    .not.toMatch(/^select\.input\s*\{/m);
});

it("`all: unset` 的 select 必须自己写回 appearance（unset 会连 appearance 一起打回 auto）", async () => {
  const s = await css();
  const i = s.indexOf(".pca-sel {");
  expect(i, ".pca-sel 规则不见了 —— 这条守卫的靶子变了要同步改").toBeGreaterThan(-1);
  const rule = s.slice(i, s.indexOf("}", i));
  expect(rule).toContain("all: unset");
  expect(rule, "all: unset 之后没写回 appearance ⇒ 这一支仍是原生灰底弹层").toContain("appearance: base-select");
});

it("当年给原生弹层打的 option 补丁不许复活（弹层现在由 select option 一组统一画）", async () => {
  const s = await css();
  expect(s, ".pca-sel option{background} 是原生弹层时代的补丁，留着就是第二真相")
    .not.toMatch(/\.pca-sel option\s*\{/);
});
