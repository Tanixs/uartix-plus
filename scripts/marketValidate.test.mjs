/**
 * P99b-N6 · 投稿校验测试（详设 G8 / 验收 3-20）。
 *
 * 这条链的存在意义就一句话：**投稿人本地跑的必须就是上架会跑的那几道**。
 * 所以这里不测"我写了什么规则"，而是测三件能被外部证伪的事：
 *  ① 仓库里已上架的那几条，拿离线校验器过一遍必须全绿（不绿就是两套实现在分叉）；
 *  ② 一份故意写坏的包必须非零结论，而且**报错里带相近键名建议**（这是给投稿人的，不是给我看的）；
 *  ③ `validate` 一个字节都不许写进仓库（它不是 `market:gen`）。
 * 另有一条源文本钉：CLI 侧不许长出第二套字段级校验规则。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const mod = await import("./marketValidate.mjs");
const { locate, validateSubmission, renderValidate, VALIDATOR_INFO } = mod;
// 校验器报的版本要与契约层当场对一次（引常量，不抄数字）
const { MARKET_SCHEMA_VERSION } = await import("../src/features/market/marketIndex");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** 建一份"仓库形状"的临时投稿根：market/pkg + market/entries + market/categories.json */
function tempShelf(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uartix-validate-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof text === "string" ? text : JSON.stringify(text, null, 2), "utf8");
  }
  return root;
}

/** 拿仓库里真上架的那份包当基座：只改要改的那个字段，别的都保持"生产校验器认得过" */
const BASE_PKG = readJson(path.join(ROOT, "market", "pkg", "theme-begonia.uartix.json"));

function pkgFor(over = {}) {
  return { ...BASE_PKG, id: "uartix.demo.theme", name: "演示主题", version: "1.0.0", ...over };
}

function metaFor(over = {}) {
  return {
    id: "uartix.demo.theme",
    name: "演示主题",
    author: "作者乙",
    category: "theme",
    version: "1.0.0",
    minAppVersion: "0.4.0",
    updated: "2026-09-20",
    description: { zh: "一条演示说明" },
    capabilities: ["theme.tokens"],
    packageFile: "demo.uartix.json",
    publicUrl: "https://raw.githubusercontent.com/tanixs/market/main/pkg/demo.uartix.json",
    ...over,
  };
}

describe("P99b-N6 · validate：仓库里已上架的投稿必须自己绿", () => {
  const metas = fs
    .readdirSync(path.join(ROOT, "market", "entries"))
    .filter((f) => f.endsWith(".json"))
    .sort();

  it("entries 一条都没测到＝这条守卫等于没钉（§8-54）", () => {
    expect(metas.length).toBeGreaterThan(0);
  });

  for (const f of metas) {
    it(`${f} 离线过一遍`, () => {
      const meta = readJson(path.join(ROOT, "market", "entries", f));
      const target = path.join(ROOT, "market", "pkg", meta.packageFile.replace(/\/+$/, ""));
      const r = validateSubmission(target);
      expect(r.problems, `${f}：${r.problems.join("；")}`).toEqual([]);
      // 六道全跑到（少一道就是哪一步静默跳过了，那正是"本地绿上架红"的形状）
      expect(r.ran.length, `${f} 只跑了 ${r.ran.length} 道：${r.ran.join(" / ")}`).toBe(6);
      expect(r.skipped).toEqual([]);
    });
  }

  it("回执自证用了哪一版校验器（别只说通过）", () => {
    const r = validateSubmission(path.join(ROOT, "market", "pkg", readJson(path.join(ROOT, "market", "entries", metas[0])).packageFile.replace(/\/+$/, "")));
    expect(r.info.pluginSchemaVersion).toBe(VALIDATOR_INFO.pluginSchemaVersion);
    // 不写字面量：上一版这里就是 `toBe(1)`，契约抬到 2 时红了一条却没人知道是数字过期了（P99c-R2 现场）
    expect(r.info.marketSchemaVersion).toBe(MARKET_SCHEMA_VERSION);
    expect(MARKET_SCHEMA_VERSION, "契约层自己报了个 0/1 以下的数，上面那条就成了空断言").toBeGreaterThanOrEqual(2);
    expect(renderValidate(r)).toContain("校验器：包 schemaVersion");
  });
});

describe("P99b-N6 · validate：坏投稿必须非零，而且话说得能让人改", () => {
  it("主题变量键名写错 ⇒ 拒，并且给出相近的真名", () => {
    const root = tempShelf({
      "market/categories.json": { theme: "主题" },
      "market/pkg/bad.uartix.json": pkgFor({ artifacts: { "main.json": { kind: "theme", vars: { "--panel": "#101418" } } } }),
      "market/entries/bad.json": metaFor({ packageFile: "bad.uartix.json" }),
    });
    try {
      const r = validateSubmission(path.join(root, "market", "pkg", "bad.uartix.json"));
      expect(r.ok).toBe(false);
      expect(r.problems.join("；")).toMatch(/未知的主题变量/);
      expect(r.problems.join("；"), "没给相近键名建议，投稿人还得翻源码才知道写哪个").toMatch(/你要写的可能是/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("货架元数据与包体各说一套 ⇒ 对账那一道必须出声", () => {
    const root = tempShelf({
      "market/categories.json": { theme: "主题" },
      "market/pkg/demo.uartix.json": pkgFor(),
      "market/entries/demo.json": metaFor({ version: "9.9.9", capabilities: ["theme.tokens", "serial.send"] }),
    });
    try {
      const r = validateSubmission(path.join(root, "market", "pkg", "demo.uartix.json"));
      expect(r.ok).toBe(false);
      const all = r.problems.join("；");
      expect(all).toContain("version 不一致");
      expect(all).toContain("能力不一致");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("索引契约也不放过：分类没登记 / 未知能力，各自的原话都在", () => {
    const root = tempShelf({
      "market/categories.json": { theme: "主题" },
      "market/pkg/demo.uartix.json": pkgFor({ capabilities: ["theme.tokens", "not.a.cap"] }),
      "market/entries/demo.json": metaFor({ category: "nope", capabilities: ["theme.tokens", "not.a.cap"] }),
    });
    try {
      const r = validateSubmission(path.join(root, "market", "pkg", "demo.uartix.json"));
      expect(r.ok).toBe(false);
      const all = r.problems.join("；");
      expect(all).toContain("不在 market/categories.json 里");
      // 未知能力出自**生产校验器**的原话（脚本自己不写这条规则）
      expect(all).toMatch(/能力|capabilit/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("桌面上一份孤包：只验包体，并**照实说**元数据对账没跑", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uartix-lonely-"));
    const p = path.join(dir, "lonely.uartix.json");
    fs.writeFileSync(p, JSON.stringify(pkgFor(), null, 2), "utf8");
    try {
      const r = validateSubmission(p);
      expect(r.ok).toBe(true);
      expect(r.root).toBe(null);
      expect(r.skipped.join(" ")).toContain("元数据对账");
      expect(r.ran).toContain("包体生产校验器（validateManifest）");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("路径不存在就是一句人话，不抛栈", () => {
    const r = validateSubmission(path.join(ROOT, "market", "pkg", "no-such-thing.uartix.json"));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("路径不存在");
  });
});

describe("P99b-N6 · validate 一个字节都不许写进仓库", () => {
  /**
   * P102 换了测法。原来钉的是「public/market 下产物的 mtime 与字节数不变」，两个毛病：
   * ① 测不到真命题——真命题是"校验器不往仓库里落盘"，那是**它调没调写函数**，不是产物时间戳；
   * ② 会假红：`marketContent.test.ts` 会调生成器把同一批产物按**同样的字节**重写一遍，
   *    两个测试文件并行时 mtime 就动了（本批实测红过一次，字节数没变）。
   * 所以：静态钉它没有写函数 + 内容哈希兜住"跑完确实没变"。
   */
  const hashTree = (dir) =>
    fs.readdirSync(dir)
      .map((f) => `${f}:${createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex").slice(0, 16)}`)
      .sort()
      .join("|");

  it("校验器自己：一个写函数都不许出现（它不是 market:gen）", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "marketValidate.mjs"), "utf8");
    const writers = ["writeFileSync", "appendFileSync", "copyFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "openSync"];
    const hit = writers.filter((w) => src.includes(w));
    expect(hit, `校验器里出现了写调用，"只读"这句话就是假的：${hit.join("、")}`).toEqual([]);
  });

  it("跑完一遍，public/market 下所有产物的内容一个字节都没变", () => {
    const dirs = [path.join(ROOT, "public", "market", "pkg"), path.join(ROOT, "public", "market", "img")];
    const before = dirs.map((d) => `${d}::${hashTree(d)}`).join("\n");
    const indexBefore = fs.readFileSync(path.join(ROOT, "public", "market", "index.json"), "utf8");
    expect(hashTree(dirs[0]), "public/market/pkg 是空的：这条测不到东西").not.toBe("");
    for (const f of fs.readdirSync(path.join(ROOT, "market", "entries")).filter((x) => x.endsWith(".json"))) {
      const meta = readJson(path.join(ROOT, "market", "entries", f));
      validateSubmission(path.join(ROOT, "market", "pkg", meta.packageFile.replace(/\/+$/, "")));
    }
    expect(dirs.map((d) => `${d}::${hashTree(d)}`).join("\n"), "跑一遍校验就把货架产物改了").toBe(before);
    expect(fs.readFileSync(path.join(ROOT, "public", "market", "index.json"), "utf8"), "索引也被改了").toBe(indexBefore);
  });
});

describe("P99b-N6 · 路径推断与「不许抄第二套规则」", () => {
  it("locate：仓库形状给出根与包名，目录源的 manifest.json 归到目录", () => {
    const flat = locate(path.join(ROOT, "market", "pkg", "a.uartix.json"));
    expect(flat.root).toBe(ROOT);
    expect(flat.packageFile).toBe("a.uartix.json");
    const nested = locate(path.join(ROOT, "market", "pkg", "dir", "manifest.json"));
    expect(nested.packageFile).toBe("dir");
    expect(locate(path.join(os.tmpdir(), "x.uartix.json")).root).toBe(null);
  });

  it("CLI 与脚本侧不许长出第二套字段校验规则（G8：抄一份就是等它与上架分叉）", () => {
    const texts = {
      marketValidate: fs.readFileSync(path.join(HERE, "marketValidate.mjs"), "utf8"),
      "plugin-cli": fs.readFileSync(path.join(HERE, "plugin-cli.ts"), "utf8"),
      "plugin-cli-core": fs.readFileSync(path.join(HERE, "plugin-cli-core.ts"), "utf8"),
    };
    // 这几句原话住在生产校验器里；它们出现在 CLI 侧任何一处，就说明有人在那边抄了一遍规则
    const copied = [
      "schemaVersion 必须是", "capabilities 不能为空", "未知的主题变量",
      "必须是 https 地址", "需为 64 位十六进制", "含未知项", "不在白名单",
    ];
    for (const [name, text] of Object.entries(texts)) {
      for (const phrase of copied) {
        expect(text, `${name} 里出现了生产校验器的原话「${phrase}」⇒ 那是第二套规则`).not.toContain(phrase);
      }
    }
    // 体积上限也不许在 CLI 侧再比一次（`parseEntry` 里已经按契约比过了）
    for (const text of Object.values(texts)) expect(text).not.toContain("MARKET_PKG_MAX_BYTES");
    // 正面半边：它确实是把生产校验器叫起来的，不是自己判完就算
    expect(texts.marketValidate).toContain("validateManifest");
    expect(texts.marketValidate).toContain("parseEntry");
    expect(texts.marketValidate).toContain("reconcileEntry");
  });
});
