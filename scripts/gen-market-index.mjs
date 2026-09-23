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
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

/**
 * `import.meta.url` 在 esbuild 打成 cjs（`uartix-plugin` 那条命令行）之后是空的，
 * 直接 `fileURLToPath(import.meta.url)` 会在**模块求值期**炸掉整条命令行。
 * 所以这里留一条退回 cwd 的路：npm 脚本与命令行都在仓库根跑，两条路算出同一个根。
 */
const HERE = typeof import.meta?.url === "string" ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd();
const ROOT = path.resolve(HERE, import.meta?.url ? ".." : ".");
/** 与 `src/features/market/marketIndex.ts` 的 `MARKET_SCHEMA_VERSION` 同步（`marketContent.test` 有一条对账钉） */
const SCHEMA_VERSION = 2;
/** 与 `marketIndex.NPM_REGISTRY_HOST` 同步（同上那条钉） */
const NPM_REGISTRY_HOST = "registry.npmjs.org";

/**
 * registry 的 tarball 地址（scope 留在路径里、文件名里去掉——实测核过的形状）。
 * 这条规则在 TS 侧还有一份 `npmTarballUrl`：两份必须一模一样，由 `marketContent.test` 对账钉住。
 */
export function npmTarballUrl(name, version) {
  const scoped = name.startsWith("@") ? name.slice(1) : "";
  const bare = scoped ? scoped.slice(scoped.indexOf("/") + 1) : name;
  return `https://${NPM_REGISTRY_HOST}/${name}/-/${bare}-${version}.tgz`;
}

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
export function loadPackage(pkgDir, packageFile) {
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

/**
 * entries 元数据自己的必填项（**不碰磁盘**）。
 * 生成器与 `uartix-plugin validate` 共用这一份：投稿人本地绿的必须就是上架会跑的那几道（详设 R7）。
 */
export function checkEntryMeta(meta, categories) {
  const errs = [];
  const need = ["id", "name", "author", "category", "version", "minAppVersion", "updated", "packageFile", "publicUrl"];
  for (const k of need) if (typeof meta[k] !== "string" || !meta[k].trim()) errs.push(`${k} 缺失`);
  if (!meta.description || typeof meta.description.zh !== "string") errs.push("description.zh 必填");
  if (!Array.isArray(meta.capabilities)) errs.push("capabilities 必填数组");
  if (meta.category && !categories[meta.category]) errs.push(`分类 ${meta.category} 不在 market/categories.json 里`);
  // npm 那一节（P99c-R2）：形状与版本在这里判，磁盘上的 .tgz 与地址在 buildEntry 判
  if (meta.npm !== undefined) {
    const n = meta.npm;
    if (!n || typeof n !== "object" || Array.isArray(n)) errs.push("npm 必须是对象 {name,version,pack}");
    else {
      for (const k of ["name", "version", "pack"]) {
        if (typeof n[k] !== "string" || !n[k].trim()) errs.push(`npm.${k} 必填`);
      }
      if (typeof n.version === "string" && n.version !== meta.version) {
        errs.push(`npm.version（${n.version}）与条目 version（${meta.version}）不是一个数：装下去算哪个版本没人说得清`);
      }
      if (typeof n.pack === "string" && !n.pack.endsWith(".tgz")) errs.push(`npm.pack 必须是 npm pack 产出的 .tgz（现在写的是 ${n.pack}）`);
    }
  }
  return errs;
}

/** 元数据与包体必须说的是同一支插件：id / 版本 / 能力（N2.5 的编译期对账 = 投稿前离线对账 = 同一份规则） */
export function reconcileEntry(pkg, meta) {
  const errs = [];
  if (pkg.id !== meta.id) errs.push(`id 不一致：元数据 ${meta.id} / 包 ${pkg.id}`);
  if (pkg.version !== meta.version) errs.push(`version 不一致：元数据 ${meta.version} / 包 ${pkg.version}`);
  const declared = [...(meta.capabilities ?? [])].sort().join(",");
  const actual = [...(pkg.capabilities ?? [])].sort().join(",");
  if (declared !== actual) errs.push(`能力不一致：货架 ${declared || "∅"} / 包 ${actual || "∅"}`);
  return errs;
}

/** 生成一条：算哈希/字节、对账能力与版本、检查截图与地址一致。 */
export function buildEntry(meta, categories, opts = {}) {
  const root = opts.root ?? ROOT;
  const pkgDir = path.join(root, "market", "pkg");
  const publicPkgDir = path.join(root, "public", "market", "pkg");
  const errs = checkEntryMeta(meta, categories);
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
    // dryRun：投稿前的离线校验要跑同一套对账，但**不许往仓库里写东西**
    if (!opts.dryRun) {
      fs.mkdirSync(publicPkgDir, { recursive: true });
      fs.writeFileSync(path.join(publicPkgDir, name), buf);
    }
  }
  const pkg = JSON.parse(buf.toString("utf8"));
  const drift = reconcileEntry(pkg, meta);
  if (drift.length) throw new Error(`${meta.id}：${drift.join("；")}`);

  /**
   * npm 条目（P99c-R2）：**哈希与字节数算的是那枚 `.tgz`**，不是源清单——
   * 因为用户取回的是前者，索引声明的数字必须和"实际会到手的对象"是同一个东西。
   * 源清单仍要交（上面那条对账靠它），但它不上架。
   */
  let shipped = buf;
  if (meta.npm) {
    const want = npmTarballUrl(meta.npm.name, meta.npm.version);
    if (meta.publicUrl !== want) {
      throw new Error(`${meta.id}：npm 条目的 publicUrl 必须是 ${want}（registry 的地址形状不是手填的，填错等于让用户点安装才 404）`);
    }
    const tgzPath = path.join(pkgDir, meta.npm.pack);
    if (!fs.existsSync(tgzPath)) {
      throw new Error(`${meta.id}：npm.pack 不存在 market/pkg/${meta.npm.pack}（在包根跑 npm pack --ignore-scripts，把产出的 .tgz 放进来）`);
    }
    shipped = fs.readFileSync(tgzPath);
    // 那一枚清单在不在包里：扫**解压后的字节**找成员名。强度照实说——它只证明"这个 tar 里像是有这么个成员"，
    // 真正按头解析并取出正文的是运行时那一条链（`npmUnpack.ts`，那里有真夹具与坏档案两组测试）。
    if (!zlib.gunzipSync(shipped).includes(Buffer.from("package/uartix-plugin.json"))) {
      throw new Error(`${meta.id}：那枚 .tgz 里没有 package/uartix-plugin.json（清单文件得在 npm 包根，且 npm 会加 package/ 前缀）`);
    }
  }

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
    sha256: crypto.createHash("sha256").update(shipped).digest("hex"),
    bytes: shipped.length,
    capabilities: [...meta.capabilities],
    screenshots: shots,
    minAppVersion: meta.minAppVersion,
    updated: meta.updated,
    ...(meta.homepage ? { homepage: meta.homepage } : {}),
    ...(meta.discussion ? { discussion: meta.discussion } : {}),
    ...(meta.verified ? { verified: true } : {}),
    // 出处留在索引里：卡片、详情、AI 视图都按它说"这枚字节从哪儿来"，谁都不许猜
    ...(meta.npm ? { npm: { name: meta.npm.name, version: meta.npm.version } } : {}),
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

// "直接跑我"才写文件。打成 cjs 之后 import.meta 是空的，那一档就当"不是被直接跑的"（命令行自己会调 buildIndex）
const SELF = typeof import.meta?.url === "string" ? fileURLToPath(import.meta.url) : "";
if (SELF && process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const { index, outFile } = buildIndex();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`写出 ${path.relative(ROOT, outFile)}：${index.entries.length} 条 / 分类 ${Object.keys(index.categories).length} 个`);
}
