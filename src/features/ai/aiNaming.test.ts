/**
 * P120 · B9b：AI 叫法收敛的契约钉。
 *
 * 为什么单独钉这件事：P90 C1 把顶栏那排并排按钮收进「场景 ▾」下拉，功能一个没少，
 * 但 AiChat 空态那句"用**上方快捷按钮**解读数据…"一直留到今天——它指的控件已经不存在了。
 * 这类事故没有类型会红、没有门会红：文案指向界面，而界面改了。上一轮在人肉抓帮助文档里
 * 同族的二十条失真（P115-B），空态这一句当时没扫到。
 *
 * 于是这里钉三条，都是能被源码反驳的：
 *  ① 空态标题必须与面板注册表里那一行的中文名**同词**（一处改名另一处红）；
 *  ② 空态文案里用「」点名的每个控件，全仓库必须真有一句 `tx("<那名>"…` 在用这个名字；
 *  ③ 扩展面板缺名时的兜底叫「AI 扩展面板」，与两处分组标题同词，旧名「AI 面板」不再出现。
 * 另加自证：②的抓取式必须真抓到东西，否则这是一条哑测试（§8-43②）。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
  readdirSync: (p: string, o?: { withFileTypes?: boolean }) => { name: string; isDirectory(): boolean }[];
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const AICHAT = read("./AiChat.tsx");
const PANELS = read("../../panels/panels.tsx");
const APP = read("../../App.tsx");

/** 空态那一块：标题与描述各取 `tx(` 的第一个参数 */
const welcomeTitle = AICHAT.match(/ai-welcome-title"[\s\S]{0,160}?tx\("([^"]+)"/)?.[1] ?? "";
const welcomeDesc = AICHAT.match(/ai-welcome-desc"[\s\S]{0,160}?tx\(\s*"([\s\S]*?)",/)?.[1] ?? "";

/** 界面话术池：src 下所有 `tx("<中文>"` 的第一个参数（面板标题、按钮、tooltip 都在这） */
function speechPool(): Set<string> {
  const out = new Set<string>();
  // 走盘用字符串拼路径而不是 `new URL(name, dir)`：文件名里一个 `#` 就会被当成分片段
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      // 测试文本里的字符串不是界面话术（否则"只在断言里出现的名字"也能骗过②）
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.(ts|tsx)$/.test(e.name)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/\btx\(\s*"([^"]{1,40})"/g)) out.add(m[1]);
    }
  };
  walk(fileURLToPath(new URL("../../", import.meta.url)).replace(/[/\\]$/, "")); // → src/
  return out;
}

describe("P120 · AI 叫法与空态指向", () => {
  it("① 空态标题与面板注册表同一枚名字（AI 助手）", () => {
    const registry = PANELS.match(/\bai:\s*pick\("([^"]+)"/)?.[1] ?? "";
    expect(registry, "panels.tsx 里 ai 那一行没抓到，这条比较没有意义").not.toBe("");
    expect(welcomeTitle, "AiChat 空态标题没抓到").not.toBe("");
    expect(welcomeTitle, "面板叫一个名字、空态叫另一个名字 ⇒ 用户以为那是两处东西").toBe(registry);
  });

  it("② 空态文案里「」点名的控件，界面上必须真以那个名字存在", () => {
    expect(welcomeDesc.length, "空态描述没抓到，这条测的是空集").toBeGreaterThan(40);
    const named = [...welcomeDesc.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
    // 自证：抓取式瞎了会让这条永远绿
    expect(named.length, "一句空态里一个控件名都没点到？那是抓取式自己瞎了").toBeGreaterThanOrEqual(3);
    const pool = speechPool();
    expect(pool.size, "话术池是空的 ⇒ 走盘断了，②的判据没有意义").toBeGreaterThan(200);
    const missing = named.filter((n) => !pool.has(n));
    expect(missing, `文案点名了这些控件却没有一颗控件叫这个名字（改了界面忘改文案）：${missing.join("、")}`).toEqual([]);
  });

  it("③ 扩展面板缺名兜底叫「AI 扩展面板」，旧名「AI 面板」不再作为话术出现", () => {
    expect(PANELS, "页签标题的兜底名漂回「AI 面板」了").toContain('tx("AI 扩展面板"');
    expect(APP, "加面板那处的兜底名漂回「AI 面板」了").toContain('tx("AI 扩展面板"');
    expect(PANELS + APP, "「AI 面板」这个旧名不该再出现在界面话术里").not.toContain('tx("AI 面板"');
    // 两处分组标题（工具栏「+ 面板」的 optgroup、导轨「视图」的段标题）也得是同一个词
    expect(APP).toContain('tx("AI 扩展面板", "AI extension panels")');
    expect(read("../../shell/RailPanel.tsx")).toContain('tx("AI 扩展面板", "AI extension panels")');
  });
});
