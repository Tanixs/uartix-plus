/**
 * P99b-N2：市场界面的**反向钉**（源码文本层）。
 *
 * 界面这一层没法在 node 里渲染（项目里没有 RTL，§8-32 的口径），
 * 但市场页最怕的三件事都能在源码上钉死：
 *  1. **把货架数据抄进组件**——那会让"索引里没有的"也显示出来（用户当事实）；
 *  2. **组件自己算字段**（自己排版本、自己格式化字节）——派生层就白分了；
 *  3. **入口开成第二个面**——同一件事两处入口 = 两本抄本（§8-45 的教训）。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
  readdirSync: (p: string, opt?: { withFileTypes?: boolean }) => { name: string; isDirectory: () => boolean }[];
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** 整个 src 里出现某个字符串的文件名（找"第二个入口"用，不靠我记得去看哪几个文件） */
function filesMentioning(needle: string): string[] {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(ent.name) || /\.test\.(ts|tsx)$/.test(ent.name)) continue;
      if (readFileSync(p, "utf8").includes(needle)) out.push(p.slice(root.length + 1).replace(/\\/g, "/"));
    }
  };
  walk(root.replace(/\\/g, "/"));
  return out.sort();
}

const DIALOG = read("./MarketDialog.tsx");
const DETAIL = read("./MarketDetail.tsx");
const SHELF = JSON.parse(read("../../../public/market/index.json")) as {
  entries: { id: string; name: string; author: string; packageUrl: string }[];
};

describe("P99b-N2 · 界面不抄货架数据", () => {
  it("组件源码里不出现任何一条货架的名字/作者/地址（数据只能从索引来）", () => {
    for (const e of SHELF.entries) {
      for (const [field, v] of [["名称", e.name], ["作者", e.author], ["包地址", e.packageUrl]] as const) {
        expect(DIALOG, `MarketDialog 里出现了条目${field}「${v}」`).not.toContain(v);
        expect(DETAIL, `MarketDetail 里出现了条目${field}「${v}」`).not.toContain(v);
      }
    }
  });

  it("界面不自己算派生字段：版本比较、字节格式化、空态话术都在 marketBrowse", () => {
    for (const [f, src] of [["MarketDialog.tsx", DIALOG], ["MarketDetail.tsx", DETAIL]] as const) {
      expect(src, `${f} 不该自己格式化字节`).not.toMatch(/\/ 1024|1024 \* 1024/);
      expect(src, `${f} 不该自己比版本号`).not.toMatch(/split\("\."\)/);
      expect(src, `${f} 该用派生层的卡片`).toContain("cardFacts");
    }
    expect(DIALOG).toContain("browseEntries");
    expect(DIALOG).toContain("emptyTalk");
  });

  it("「列表不等于背书」这句只有一份，两处都引同一个常量", () => {
    expect(DIALOG).toContain("MARKET_NO_ENDORSE");
    expect(DETAIL).toContain("MARKET_NO_ENDORSE");
    expect(DIALOG).not.toMatch(/const NO_ENDORSE|列表不等于背书：/);
    expect(DETAIL).not.toMatch(/const NO_ENDORSE|列表不等于背书：/);
  });
});

describe("P99b-N2 · 弹层与安全口径", () => {
  it("两层弹层都 portal 到 body，且带 dialog/aria-modal（§8-20）", () => {
    expect(DIALOG).toContain("createPortal");
    expect(DIALOG).toContain("document.body");
    expect(DETAIL).toContain("createPortal");
    expect(DETAIL).toContain("document.body");
    expect(DIALOG).toContain('role="dialog"');
    expect(DETAIL).toContain('role="dialog"');
    expect(DIALOG).toContain('aria-modal="true"');
    expect(DETAIL).toContain('aria-modal="true"');
  });

  it("两层都要能退：Esc 先收详情再关窗，详情有返回按钮", () => {
    expect(DIALOG).toContain('"Escape"');
    expect(DETAIL).toContain("返回");
  });

  it("图标一律 SVG 或文字，不许 emoji / 私用区字符（§8-25）", () => {
    const bad = /[\u{1F300}-\u{1FAFF}\u{E000}-\u{F8FF}\u{2190}-\u{21FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
    expect(bad.test(DIALOG), "MarketDialog 里有字符图标").toBe(false);
    expect(bad.test(DETAIL), "MarketDetail 里有字符图标").toBe(false);
  });

  it("本页只浏览：不碰安装链（假按钮比没按钮坏）", () => {
    expect(DIALOG).not.toContain("stagePackage");
    expect(DIALOG).not.toContain("importPackages");
    expect(DIALOG).toContain("MARKET_BROWSE_ONLY");
  });

  it("外链走系统浏览器，不在应用内加载第三方页面", () => {
    expect(DETAIL).toContain("plugin-opener");
    expect(DETAIL).toContain("openUrl");
    expect(DETAIL).not.toContain("<iframe");
    expect(DETAIL).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("P99b-N2 · 入口只有一个（Q8）", () => {
  it("MarketDialog 只被插件库引用，AI 侧不另开口子", () => {
    const users = filesMentioning("<MarketDialog");
    expect(users).toEqual(["features/plugins/PluginLibraryDialog.tsx"]);
  });

  it("市场页是只读的：AI 目录与 MCP 都不许在这里挂上装包能力（Q7）", () => {
    const host = read("../agent/hostCatalog.ts");
    expect(host, "自省目录里出现装包动作就是越了 Q7 的界").not.toMatch(/market.*(install|fetchPackage)/i);
  });

  it("依赖方向单向：插件库不反过来依赖市场", () => {
    expect(read("../plugins/pluginStore.ts")).not.toContain("../market/");
  });
});
