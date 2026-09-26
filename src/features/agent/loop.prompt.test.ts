/**
 * P109-C：系统提示的两条守卫。
 *
 * 为什么专门测提示词：旧提示是一整块硬编码长字符串，里面点名的 `read_appearance`
 * **根本不是一支工具**（真名 `theme_read`）——弱模型第一轮就撞 `unknown_tool`，
 * 而"界面创造"档压根没发外观工具，提示还在教怎么用它们。这类漂移没有门禁就会一直长回来，
 * 所以钉成测试（手法与 `bootOverrides.test.ts` 读源码比对同一类：比的是"两处写法有没有漂"）。
 */
import { expect, it } from "vitest";
// 变量说明符：src 的 tsconfig 不挂 @types/node，写 `node:fs` 字面量会被 tsc 判"找不到模块"
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as unknown as { fileURLToPath: (u: string | URL) => string };

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const loopSrc = read("./loop.ts");

/** 宿主工具的真名：从各 entry 表里抠 `name: "…"` 字面量（注册表要求这个名字合法） */
function registryNames(): Set<string> {
  const files = ["./localEntries.ts", "./uiTools.ts", "./settingsTools.ts", "./appearanceTools.ts",
    "./generalTools.ts", "./marketTools.ts", "./pluginTools.ts"];
  const names = new Set<string>();
  for (const f of files) {
    for (const m of read(f).matchAll(/\bname:\s*"([a-z][a-z0-9_]{2,39})"/g)) names.add(m[1]);
  }
  return names;
}

/** 把 loop.ts 里 `["<tool>", " 文案"]` 形状的分片键抠出来 */
function fragmentKeys(): string[] {
  const block = loopSrc.slice(loopSrc.indexOf("const PROMPT_FRAGMENTS"), loopSrc.indexOf("export function buildSystemPrompt"));
  return [...block.matchAll(/^\s*\["([a-z][a-z0-9_]+)"/gm)].map((m) => m[1]);
}

it("提示里点名的工具必须真的存在于注册表（read_appearance 那类死引用不许长回来）", () => {
  const real = registryNames();
  expect(real.size, "一个工具名都没抠到 —— 表结构变了要同步改这条").toBeGreaterThan(20);
  const ghost = fragmentKeys().filter((k) => !real.has(k));
  expect(ghost, `提示分片点了不存在的工具：${ghost.join(", ")}`).toEqual([]);
});

it("基础提示里不许出现任何 `xxx_yyy` 形式的工具名（要提工具就走进分片段）", () => {
  const base = /const PROMPT_BASE = "([\s\S]*?)";\n/.exec(loopSrc)?.[1] ?? "";
  expect(base.length).toBeGreaterThan(200);
  const named = [...base.matchAll(/\b(?:read|save|theme|style|settings|app|ui|fs|list|enable|rollback|plot|image|web|shell|task|run|propose|layout|chrome|session)_[a-z0-9_]+\b/g)].map((m) => m[0]);
  expect(named, `基础段里点名了工具，可它不分档位：${named.join(", ")}`).toEqual([]);
});

it("死引用 read_appearance 不在发给模型的任何一段提示里（真名是 theme_read）", async () => {
  // 判据落在**渲染结果**上而不是源码上：源码里作为历史说明提一次它是允许的（注释里就在讲这件事），
  // 真正不能容忍的是模型照着它去调一支不存在的工具。
  const { buildSystemPrompt } = await import("./loop");
  const all = buildSystemPrompt(new Set(["theme_read", "save_plugin", "task_plan", "theme_patch", "theme_preset", "save_theme_extension", "image_swatch"]));
  expect(all.length).toBeGreaterThan(400);
  expect(all).not.toContain("read_appearance");
});

it("外观那段的可见性跟着工具走：没发 theme_read 就不教怎么用", async () => {
  const { buildSystemPrompt } = await import("./loop");
  const withTheme = buildSystemPrompt(new Set(["theme_read", "save_plugin"]));
  const bare = buildSystemPrompt(new Set(["app_read"]));
  expect(withTheme).toContain("call theme_read first");
  expect(withTheme).toContain("save_plugin with enable:true");
  expect(bare, "工具没发出去，提示里却还在教怎么用 ⇒ 模型会去撞 unknown_tool").not.toContain("Appearance edits");
  expect(bare).not.toContain("save_plugin");
  // 基础段与可见性无关，永远在
  expect(bare).toContain("No tool call means task termination");
});
