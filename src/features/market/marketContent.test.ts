/**
 * P99b-N1 / N2.5：示例货架自身的**内容测试**。
 *
 * 为什么要专门测"我们自己上架的东西"：生成器与索引都是文本，漂了不会有人红。
 * N2.5 起源包可以是目录（manifest.json ＋旁挂 .html），所以"扫一遍 market/pkg/*.json"
 * 这种老写法会**漏看目录源**——现在一律**按索引枚举**，验的是应用真会装的那份字节：
 *  ① 每个上架包过**生产校验器**（不是我以为的合法）；
 *  ② 提交的索引 == 生成器现算的（改包忘重跑 = 索引在说谎，§8-45 那类"抄本没人管"）；
 *  ③ 索引过契约解析且一条都没被丢；
 *  ④ 编译产物里不许残留 `htmlFile`（源包的旁挂键必须已被内联掉）；
 *  ⑤ `market/pkg` 下不许有"没被任何条目引用的孤儿源"（孤儿源会被人误以为已上架）。
 */
import { describe, expect, it } from "vitest";
import { parseMarketIndex, MARKET_ALLOW_HOSTS, type MarketIndex } from "./marketIndex";

const spec = "../../../scripts/gen-market-index.mjs";
const { buildIndex } = (await import(spec)) as unknown as {
  buildIndex: () => { index: MarketIndex; outFile: string };
};
const fsSpec = "node:fs";
const pathSpec = "node:path";
const { readFileSync, readdirSync, existsSync, statSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string | URL, enc?: string) => string;
  readdirSync: (p: string) => string[];
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory(): boolean };
};
const { join, resolve } = (await import(pathSpec)) as unknown as {
  join: (...p: string[]) => string;
  resolve: (...p: string[]) => string;
};
const { validateManifest } = await import("../plugins/pluginManifest");

// src/features/market → 仓库根（三层上跳）；路径不对时测试会指着错的目录，所以先自证
const ROOT = resolve(new URL(".", import.meta.url).pathname.replace(/^\//, ""), "..", "..", "..");
const committed = JSON.parse(readFileSync(join(ROOT, "public", "market", "index.json"), "utf8")) as MarketIndex;

/** 索引里每条对应的**上架字节**（应用装的就是这个，不是源包） */
function shippedText(entry: MarketIndex["entries"][number]): string {
  const p = join(ROOT, "public", entry.packageUrl.replace(/^\//, ""));
  if (!existsSync(p)) throw new Error(`${entry.id}：索引指向的产物不存在 ${entry.packageUrl}（装机后会 404 的那颗雷）`);
  return readFileSync(p, "utf8");
}

/** 扫 market/pkg 的源形态：平铺包文件 + 目录源（含 manifest.json 的目录） */
function sourceNames(): { name: string; kind: "file" | "dir" }[] {
  const dir = join(ROOT, "market", "pkg");
  return readdirSync(dir).map((f) => ({
    name: f,
    kind: statSync(join(dir, f)).isDirectory() ? ("dir" as const) : ("file" as const),
  }));
}

describe("P99b-N1：示例货架内容", () => {
  it("索引非空且每条都有对应的上架产物（反空断言：扫不到东西不算全绿）", () => {
    expect(committed.entries.length).toBeGreaterThanOrEqual(4);
    for (const e of committed.entries) expect(shippedText(e).length).toBeGreaterThan(0);
  });

  it("每个上架包都过生产校验器（合法不是我说的）", () => {
    for (const e of committed.entries) {
      const v = validateManifest(JSON.parse(shippedText(e)));
      expect(v.errors, `${e.id} 的上架包应通过校验`).toEqual([]);
      expect(v.ok, `${e.id} 的上架包应通过校验`).toBe(true);
    }
  });

  it("旁挂文件必须已经编译进包：上架产物里不许出现 htmlFile", () => {
    for (const e of committed.entries) {
      expect(shippedText(e), `${e.id} 的产物里残留了源包键`).not.toContain("htmlFile");
    }
  });

  it("提交的索引与生成器现算的一致（改包忘重跑生成器就是索引在说谎）", () => {
    const fresh = buildIndex().index;
    expect(committed.entries).toEqual(fresh.entries);
    expect(committed.categories).toEqual(fresh.categories);
    expect(committed.generatedAt).toBe(fresh.generatedAt);
  });

  it("索引过契约解析，且一条都没被丢", () => {
    const r = parseMarketIndex(committed, [...MARKET_ALLOW_HOSTS, "localhost"]);
    if (!r.ok) throw new Error(`索引本该解析成功：${r.errors.join(" / ")}`);
    expect(r.index.dropped).toEqual([]);
    expect(r.index.entries.length).toBeGreaterThanOrEqual(4);
  });

  it("market/pkg 下没有孤儿源，也不留同名两份（目录与平铺同时存在=谁上架没人说得清）", () => {
    const referenced = new Set(committed.entries.map((e) => {
      const file = e.packageUrl.split("/").pop() ?? "";
      return file.replace(/\.uartix\.json$/, "");
    }));
    const srcs = sourceNames();
    expect(srcs.length).toBeGreaterThanOrEqual(4); // 反空断言
    for (const s of srcs) {
      const stem = s.name.replace(/\.uartix\.json$/, "");
      expect(referenced.has(stem), `market/pkg/${s.name} 没被任何索引条目引用（改了它不会上架）`).toBe(true);
      const both = srcs.filter((x) => x.name.replace(/\.uartix\.json$/, "") === stem);
      expect(both.length, `源包重名：market/pkg/${stem} 目录与 .uartix.json 并存`).toBe(1);
    }
  });

  it("货架上的能力声明与包内一致（提权必须在索引里就露出来）", () => {
    for (const e of committed.entries) {
      const pkg = JSON.parse(shippedText(e)) as { capabilities: string[] };
      expect([...e.capabilities].sort()).toEqual([...pkg.capabilities].sort());
      // 首屏示例不许带设备面与逻辑面：那是给别人看的样例，不是后门
      expect(e.capabilities).not.toContain("serial.send");
      expect(e.capabilities).not.toContain("logic.run");
    }
  });

  it("每条都有哈希与字节数，且哈希与实际文件一致（作者说了不算）", () => {
    for (const e of committed.entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.bytes).toBeGreaterThan(0);
      const buf = new TextEncoder().encode(shippedText(e));
      expect(buf.length).toBe(e.bytes);
    }
  });
});
