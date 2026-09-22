#!/usr/bin/env node
/**
 * P99b-N1 / N2.5：由 `market/entries/*.json` + `market/pkg/*` 生成 `public/market/index.json`。
 *
 * 这一步等价于参照物那边的 CI：**作者只交"元数据 + 包"，哈希与字节数由生成器算**，
 * 所以投稿人不可能"声明 1 KB 实际给 1 MB"，也不可能声明 `ui.widget` 结果包里带 `serial.send`
 * ——那种漂移在这里就是构建失败（详设 §6-2）。
 *
 * N2.5 起包有两种源形态，编译完是同一个东西：
 *  - `market/pkg/<name>.uartix.json` —— 成品包，字节原样上架；
 *  - `market/pkg/<name>/manifest.json` ＋旁挂真实文件（`"htmlFile": "rig.html"`）——
 *    生成器把文件内容内联成 `html` 再序列化上架。**作者从此不用手敲 `\n` 与 `\"`**。
 * 代价是新长出一条越界面（`htmlFile: "../../etc/passwd"`），所以路径守卫先于读文件；
 * 并且 `publicUrl` 必须等于实际写出的产物名——N1 那版不一致也照发，坏在用户点安装时才 404。
 *
 * 提交前请跑 `npm run market:gen`；漏跑由 `marketContent.test.ts` 判红（索引与包不一致）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCHEMA_VERSION = 1;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** 上架产物名由源名推出：平铺包用文件名，目录源用 `<目录名>.uartix.json`（两处共用一个函数） */
export function pkgFileNameOf(packageFile) {
  const f = String(packageFile ?? "").replace(/\/+$/, "");
  return f.endsWith(".json") ? path.basename(f) : `${path.basename(f)}.uartix.json`;
}

/** 只许包目录**内**的相对路径：绝对路径、盘符、`..` 开头或中间冒出 `..` 一律拒。 */
function assertInsideRel(rel) {
  if (path.isAbsolute(rel) || rel.startsWith("/") || rel.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new Error(`旁挂文件必须是包内相对路径，收到绝对路径 ${rel}`);
  }
  const norm = path.posix.normalize(rel.split(path.sep).join("/"));
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    throw new Error(`旁挂文件越界（不许用 .. 走出包目录）：${rel}`);
  }
  return norm;
}

/**
 * 把源包对象编译成上架包：递归找 `*File` 键，换成同名内容（字符串）。
 * @param node 源对象
 * @param read 读包内文件的函数（生产＝读磁盘，测试＝内存表）
 * @param where 位置名，只为报错能指到地方
 */
export function resolveFileRefs(node, read, where = "包根") {
  if (Array.isArray(node)) return node.map((x, i) => resolveFileRefs(x, read, `${where}[${i}]`));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!k.endsWith("File")) {
      out[k] = resolveFileRefs(v, read, `${where}.${k}`);
      continue;
    }
    const base = k.slice(0, -"File".length);
    if (base in node) throw new Error(`${where} 既写了 ${base} 又写了 ${k}：旁挂文件与内联值只能留一个`);
    if (typeof v !== "string" || !v.trim()) throw new Error(`${where}.${k} 必须是包内相对路径（字符串）`);
    const rel = assertInsideRel(v);
    let text;
    try {
      text = read(rel);
    } catch (e) {
      throw new Error(`${where}.${k} 指向的旁挂文件不存在或读不到：${rel}（${e instanceof Error ? e.message : String(e)}）`, { cause: e });
    }
    if (typeof text !== "string") throw new Error(`${where}.${k} 读到的不是文本：${rel}`);
    out[base] = text;
  }
  return out;
}

/** 读源包：目录形态 ⇒ manifest ＋旁挂文件内联；平铺形态 ⇒ 字节原样。两者都产出上架用的 Buffer。 */
function loadPackage(pkgDir, packageFile) {
  const base = packageFile.replace(/\/+$/, "");
  const srcPath = path.join(pkgDir, base);
  const name = pkgFileNameOf(packageFile);
  if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
    // 目录与同名平铺包同时存在时，上架的到底是谁？不猜——让用户先删掉一份
    if (fs.existsSync(path.join(pkgDir, `${base}.uartix.json`))) {
      throw new Error(`源包重名：market/${base}（目录）与 market/${base}.uartix.json 都在，删掉一份再跑`);
    }
    const manifestPath = path.join(srcPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`目录源缺 manifest.json：market/pkg/${base}/manifest.json`);
    }
    const read = (rel) => fs.readFileSync(path.resolve(srcPath, rel), "utf8");
    const assembled = resolveFileRefs(readJson(manifestPath), read, `${base}/manifest.json`);
    return { buf: Buffer.from(JSON.stringify(assembled, null, 2) + "\n", "utf8"), name };
  }
  return { buf: fs.readFileSync(srcPath), name };
}

/** 生成一条：算哈希/字节、对账能力与版本、检查截图与地址一致。 */
export function buildEntry(meta, categories, opts = {}) {
  const root = opts.root ?? ROOT;
  const pkgDir = path.join(root, "market", "pkg");
  const publicPkgDir = path.join(root, "public", "market", "pkg");
  const errs = [];
  const need = ["id", "name", "author", "category", "version", "minAppVersion", "updated", "packageFile", "publicUrl"];
  for (const k of need) if (typeof meta[k] !== "string" || !meta[k].trim()) errs.push(`${k} 缺失`);
  if (!meta.description || typeof meta.description.zh !== "string") errs.push("description.zh 必填");
  if (!Array.isArray(meta.capabilities)) errs.push("capabilities 必填数组");
  if (meta.category && !categories[meta.category]) errs.push(`分类 ${meta.category} 不在 market/categories.json 里`);
  if (meta.packageFile && !fs.existsSync(path.join(pkgDir, meta.packageFile.replace(/\/+$/, "")))) {
    errs.push(`包不存在：market/pkg/${meta.packageFile}（平铺包或 <目录>/manifest.json 二选一）`);
  }
  if (errs.length) throw new Error(`${meta.id ?? "(缺 id)"}：${errs.join("；")}`);

  const { buf, name } = loadPackage(pkgDir, meta.packageFile);
  // 地址与实际写出的产物名当场对上：不一致的话索引照发，用户点安装才 404（N1 的洞）
  if (meta.publicUrl.startsWith("/") && !meta.publicUrl.startsWith("//")) {
    const want = `/market/pkg/${name}`;
    if (meta.publicUrl !== want) {
      throw new Error(`${meta.id}：publicUrl 写的是 ${meta.publicUrl}，但上架产物叫 ${want}——改其一，别把这颗雷留到安装时`);
    }
    fs.mkdirSync(publicPkgDir, { recursive: true });
    fs.writeFileSync(path.join(publicPkgDir, name), buf);
  }
  const pkg = JSON.parse(buf.toString("utf8"));
  // 元数据与包体必须说的是同一支插件（id/版本/能力三样对不上就是有人在两份文件里各说一套）
  if (pkg.id !== meta.id) errs.push(`id 不一致：元数据 ${meta.id} / 包 ${pkg.id}`);
  if (pkg.version !== meta.version) errs.push(`version 不一致：元数据 ${meta.version} / 包 ${pkg.version}`);
  const declared = [...(meta.capabilities ?? [])].sort().join(",");
  const actual = [...(pkg.capabilities ?? [])].sort().join(",");
  if (declared !== actual) errs.push(`能力不一致：货架 ${declared || "∅"} / 包 ${actual || "∅"}`);
  if (errs.length) throw new Error(`${meta.id}：${errs.join("；")}`);

  const shots = (meta.screenshots ?? []).map((u) => {
    if (!u.startsWith("/") || u.startsWith("//")) return u; // 外链原样交给索引校验去判
    if (!fs.existsSync(path.join(root, "public", u))) {
      throw new Error(`${meta.id}：截图文件不存在 ${u}（宁可构建失败，也不上架一个坏图）`);
    }
    return u;
  });

  return {
    id: meta.id,
    name: meta.name,
    author: meta.author,
    category: meta.category,
    description: meta.description,
    version: meta.version,
    packageUrl: meta.publicUrl,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
    capabilities: [...meta.capabilities],
    screenshots: shots,
    minAppVersion: meta.minAppVersion,
    updated: meta.updated,
    ...(meta.homepage ? { homepage: meta.homepage } : {}),
    ...(meta.discussion ? { discussion: meta.discussion } : {}),
    ...(meta.verified ? { verified: true } : {}),
  };
}

export function buildIndex(opts = {}) {
  const root = opts.root ?? ROOT;
  const entryDir = path.join(root, "market", "entries");
  const outFile = path.join(root, "public", "market", "index.json");
  const imgDir = path.join(root, "public", "market", "img");
  const categories = readJson(path.join(root, "market", "categories.json"));
  if (fs.existsSync(imgDir) === false) fs.mkdirSync(imgDir, { recursive: true });
  const files = fs.readdirSync(entryDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error("market/entries 是空的：宁可构建失败，也不发布一支都没有的货架");
  const entries = files.map((f) => buildEntry(readJson(path.join(entryDir, f)), categories, { root }));
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const dup = entries.filter((e, i) => i && e.id === entries[i - 1].id);
  if (dup.length) throw new Error(`id 重复：${dup.map((d) => d.id).join("、")}`);
  // generatedAt 取"内容截至哪天"而不是"这次几点跑的"：跑一次生成器不该让索引内容变更
  const asOf = entries.map((e) => e.updated).sort().at(-1);
  return {
    index: {
      schemaVersion: SCHEMA_VERSION,
      name: "Uartix+ 社区插件库（示例）",
      generatedAt: `${asOf}T00:00:00Z`,
      source: "https://github.com/Tanixs/uartix-plus/tree/main/market",
      docsUrl: "https://github.com/Tanixs/uartix-plus/tree/main/market#readme",
      categories,
      entries,
    },
    outFile,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { index, outFile } = buildIndex();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`写出 ${path.relative(ROOT, outFile)}：${index.entries.length} 条 / 分类 ${Object.keys(index.categories).length} 个`);
}
