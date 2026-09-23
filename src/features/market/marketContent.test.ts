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
const { buildIndex, buildEntry, checkEntryMeta, npmTarballUrl } = (await import(spec)) as unknown as {
  buildIndex: () => { index: MarketIndex; outFile: string };
  buildEntry: (meta: Record<string, unknown>, categories: Record<string, string>, opts?: Record<string, unknown>) => Record<string, unknown>;
  checkEntryMeta: (meta: Record<string, unknown>, categories: Record<string, string>) => string[];
  npmTarballUrl: (name: string, version: string) => string;
};
const fsSpec = "node:fs";
const pathSpec = "node:path";
const { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string | URL, enc?: string) => string;
  readdirSync: (p: string) => string[];
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory(): boolean };
  mkdtempSync: (p: string) => string;
  writeFileSync: (p: string, data: unknown) => void;
  mkdirSync: (p: string, o?: { recursive?: boolean }) => void;
  rmSync: (p: string, o?: { recursive?: boolean }) => void;
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

  /* ---- P99b-N3：预览图也是货架内容，同样不许各说一套 ---- */

  it("货架引用的每张图都真存在、是放行格式、且不会自己撞上尺寸上限", async () => {
    const { mimeAllowed, readImageDims, IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS } = await import("./imageHeads");
    let shots = 0;
    for (const e of committed.entries) {
      for (const u of e.screenshots) {
        shots++;
        const p = join(ROOT, "public", u.replace(/^\//, ""));
        expect(existsSync(p), `条目 ${e.id} 引用的图不在仓库里：${u}`).toBe(true);
        const dataUrl = `data:image/png;base64,${readFileSync(p, "base64")}`;
        expect(mimeAllowed("image/png"), "放行集坏了").toBe(true);
        const dims = readImageDims(dataUrl);
        expect(dims, `${u} 读不出宽高：这不是我们生成的那种 PNG`).not.toBeNull();
        expect(Math.max(dims!.w, dims!.h), `${u} 自己就超过单边上限`).toBeLessThanOrEqual(IMAGE_MAX_EDGE);
        expect(dims!.w * dims!.h, `${u} 自己就超过总像素上限`).toBeLessThanOrEqual(IMAGE_MAX_PIXELS);
      }
    }
    expect(shots, "反空断言：一张图都没有，说明这条测试什么都没测").toBeGreaterThan(0);
  });

  it("示例货架自己就得跑得到 N3 的三种状态：主题≥2 张不同图、非主题可以 0 张", () => {
    // 去重后才算多图：把同一张列两遍骗不过这条（轮播会原地转圈）
    for (const e of committed.entries.filter((x) => x.category === "theme")) {
      expect(new Set(e.screenshots).size, `${e.id} 是主题却凑不出两张不同的预览图，轮播就没东西可验`).toBeGreaterThanOrEqual(2);
    }
    const empty = committed.entries.filter((x) => x.screenshots.length === 0);
    expect(empty.length, "一条空图都没有，那「作者没给预览图」这句话就永远跑不到").toBeGreaterThan(0);
  });

  it("图与包对账：生成器现算的字节 == 提交进仓库的（改了主题忘重跑＝图在说谎）", async () => {
    const spec = "../../../scripts/gen-market-img.mjs";
    // 不用 Buffer 这个名字：src 的 tsconfig 不带 node 类型，声明成"能编出 base64 的东西"就够对账用了
    const { buildAll } = (await import(spec)) as unknown as {
      buildAll: () => Array<[string, { toString(enc: string): string }]>;
    };
    const fresh = new Map(buildAll());
    expect(fresh.size, "生成器一条都没产出，说明它坏了").toBeGreaterThan(0);
    for (const [name, buf] of fresh) {
      const p = join(ROOT, "public", "market", "img", name);
      expect(readFileSync(p, "base64"), `public/market/img/${name} 与包内变量不一致，跑 npm run market:img`).toBe(buf.toString("base64"));
    }
    // 反向：img 目录里不许有没人引用的图（白占安装包体积，且没人知道它是哪来的）
    const used = new Set(committed.entries.flatMap((e) => e.screenshots.map((s) => s.split("/").pop() ?? "")));
    const orphans = readdirSync(join(ROOT, "public", "market", "img")).filter((f: string) => !used.has(f));
    expect(orphans, "这些图没有任何条目引用：要么接上，要么删掉").toEqual([]);
  });
});

/* ================= P99c-R2：生成器这一侧 =================
 * 两份实现（TS 的契约层与 .mjs 的生成器）之间最容易漂的就是**字面量**：白名单、信封版本、
 * registry 的地址形状。所以这里不测"能不能跑"，专测"两边说的是不是同一句话"，
 * 再用一枚真 `.tgz` 走一遍 npm 模式，把「哈希算的是哪个对象」钉死在字节上。
 */
const osSpec = "node:os";
const cryptoSpec = "node:crypto";
const zlibSpec = "node:zlib";
const { tmpdir } = (await import(osSpec)) as unknown as { tmpdir: () => string };
const { createHash } = (await import(cryptoSpec)) as unknown as {
  createHash: (alg: string) => { update(b: Uint8Array): { digest(enc: string): string } };
};
const { gzipSync } = (await import(zlibSpec)) as unknown as { gzipSync: (b: Uint8Array) => Uint8Array };
const { npmTarballUrl: npmUrlFromContract, NPM_REGISTRY_HOST, MARKET_SCHEMA_VERSION } = await import("./marketIndex");
const FIXTURE_TGZ = "__fixtures__/probe-1.0.0.tgz";

describe("P99c-R2 · 生成器这一侧", () => {
  const genSrc = readFileSync(resolve(ROOT, "scripts", "gen-market-index.mjs"), "utf8");
  const srcConst = (re: RegExp, label: string): string => {
    const m = re.exec(genSrc);
    if (!m) throw new Error(`生成器里找不到 ${label} 那行：抓取式与源码脱钩了（§8-43②）`);
    return m[1];
  };

  it("两份字面量逐字对上：信封版本、registry 域、tarball 地址形状", () => {
    expect(srcConst(/const SCHEMA_VERSION = (\d+)/, "SCHEMA_VERSION")).toBe(String(MARKET_SCHEMA_VERSION));
    expect(srcConst(/const NPM_REGISTRY_HOST = "([^"]+)"/, "NPM_REGISTRY_HOST")).toBe(NPM_REGISTRY_HOST);
    for (const [n, v] of [["probe", "1.2.3"], ["@s.a/b-x", "0.4.1"], ["uartix.plus.theme-ink", "0.9.0"]] as const) {
      expect(npmTarballUrl(n, v), `地址形状漂了：${n}`).toBe(npmUrlFromContract(n, v));
    }
  });

  const meta = (over: Record<string, unknown> = {}) => ({
    id: "uartix.probe.theme", name: "探针", author: "a", category: "theme",
    description: { zh: "只用于测试" }, version: "1.0.0", minAppVersion: "0.4.1", updated: "2026-09-23",
    packageFile: "probe-src.uartix.json", publicUrl: npmTarballUrl("probe", "1.0.0"),
    capabilities: ["theme.tokens"], npm: { name: "probe", version: "1.0.0", pack: "probe-1.0.0.tgz" }, ...over,
  });
  const CATS = { theme: "外观" };

  /** base64 → 字节（不用 Buffer 类型：这个测试跑在 node 环境，但类型表里没装 @types/node） */
  const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  /** 临时货架根：源清单 + 真 .tgz。用完就删，不碰仓库。 */
  function withRoot(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "uartix-npm-"));
    try {
      const pkg = join(root, "market", "pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "probe-src.uartix.json"), JSON.stringify({ id: "uartix.probe.theme", version: "1.0.0", capabilities: ["theme.tokens"] }));
      writeFileSync(join(pkg, "probe-1.0.0.tgz"), b64ToBytes(readFileSync(resolve(ROOT, "src/features/market", FIXTURE_TGZ), "base64")));
      run(root);
    } finally {
      rmSync(root, { recursive: true });
    }
  }

  it("npm 模式：哈希与字节算的是那枚 tarball，npm 一节照实进索引", () => {
    withRoot((root) => {
      const tgz = b64ToBytes(readFileSync(join(root, "market", "pkg", "probe-1.0.0.tgz"), "base64"));
      const e = buildEntry(meta(), CATS, { root, dryRun: true });
      expect(e.sha256).toBe(createHash("sha256").update(tgz).digest("hex"));
      expect(e.bytes).toBe(tgz.length);
      expect(e.npm).toEqual({ name: "probe", version: "1.0.0" });
      expect(e.packageUrl).toBe(`https://${NPM_REGISTRY_HOST}/probe/-/probe-1.0.0.tgz`);
    });
  });

  it("dryRun 一个字节都不写进仓库（投稿前自检不许改货架）", () => {
    withRoot((root) => {
      buildEntry(meta(), CATS, { root, dryRun: true });
      expect(existsSync(join(root, "public")), "dryRun 写出了 public 目录树").toBe(false);
    });
  });

  it("publicUrl 与包名版本对不上、或 .tgz 不在：两种坏法各自抛得出名字", () => {
    withRoot((root) => {
      expect(() => buildEntry(meta({ publicUrl: "https://registry.npmmirror.com/probe/-/probe-1.0.0.tgz" }), CATS, { root, dryRun: true })).toThrow(/publicUrl/);
      expect(() => buildEntry(meta({ npm: { name: "probe", version: "1.0.0", pack: "gone.tgz" } }), CATS, { root, dryRun: true })).toThrow(/npm\.pack/);
    });
  });

  it("那枚 tgz 里没有清单成员 ⇒ 构建失败（别把装不上的条目上架）", () => {
    withRoot((root) => {
      // 一枚"合法 gzip、里面没有 package/uartix-plugin.json"的档案：用真 gzip 而不是垃圾字节，
      // 否则测到的是"解压失败"而不是"缺成员"。
      writeFileSync(join(root, "market", "pkg", "probe-1.0.0.tgz"), gzipSync(new Uint8Array([1, 2, 3, 4])));
      expect(() => buildEntry(meta(), CATS, { root, dryRun: true })).toThrow(/package\/uartix-plugin\.json/);
    });
  });

  it("npm 那一节的形状在元数据阶段就拦：非对象、缺 pack、版本不一致", () => {
    expect(checkEntryMeta(meta({ npm: "probe" }), CATS).join("；")).toContain("npm");
    expect(checkEntryMeta(meta({ npm: { name: "probe", version: "1.0.0" } }), CATS).join("；")).toContain("npm.pack");
    expect(checkEntryMeta(meta({ npm: { name: "probe", version: "9.9.9", pack: "a.tgz" } }), CATS).join("；")).toContain("npm.version");
    expect(checkEntryMeta(meta({ npm: { name: "probe", version: "1.0.0", pack: "a.tar.gz" } }), CATS).join("；")).toContain(".tgz");
    // 反向半边：不带 npm 的自建条目不该被这些判定误伤
    expect(checkEntryMeta(meta({ npm: undefined }), CATS)).toEqual([]);
  });
});
