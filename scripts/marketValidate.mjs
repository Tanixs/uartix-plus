#!/usr/bin/env node
/**
 * P99b-N6 · 投稿校验：**离线、不连应用、与上架跑同一批校验器**（详设 §2E / R7）。
 *
 * 为什么需要它：`market/README.md` 那句"交两样东西，跑一条命令"此前对外部作者不成立——
 * 他手上既没有本仓库的 `market:gen`，也没有 `validateManifest`（那条链在 `src/` 里，要 node_modules
 * 与本目录结构才跑得动）。于是"本地绿、上架红"是常态。
 *
 * 一条硬规矩决定了这里的形状：**这个文件不写任何字段级校验规则**。
 * 它只做三件事——找到该验的东西、按顺序调用生产校验器、把它们的原话收上来。
 * 规则长在 `pluginManifest.validateManifest`（包体）、`gen-market-index` 的对账（元数据 ↔ 包体）
 * 与 `marketIndex.parseEntry`（索引契约）三处，本文件一份都不抄（抄了就等着和上架分叉，G8 钉着）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 静态导入（不是 await import）：命令行入口会被 esbuild 打成 **cjs**，顶层 await 在那儿不合法。
// 这三处都是"上架真会跑的那几道"，本文件一份规则都不抄（详设 R7 / 守卫 G8）。
import { validateManifest, PLUGIN_SCHEMA_VERSION } from "../src/features/plugins/pluginManifest.ts";
import { parseEntry, MARKET_ALLOW_HOSTS, MARKET_SCHEMA_VERSION } from "../src/features/market/marketIndex.ts";
import { loadPackage, buildEntry, checkEntryMeta, reconcileEntry } from "./gen-market-index.mjs";

/** 用到了哪几道校验——回执要能自证，别只说"通过" */
export const VALIDATOR_INFO = {
  pluginSchemaVersion: PLUGIN_SCHEMA_VERSION,
  marketSchemaVersion: MARKET_SCHEMA_VERSION,
  packageValidator: "src/features/plugins/pluginManifest.ts · validateManifest",
  entryValidator: "src/features/market/marketIndex.ts · parseEntry",
  reconciler: "scripts/gen-market-index.mjs · checkEntryMeta / reconcileEntry",
};

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 从目标路径反推"这是不是一份仓库形态的投稿"：
 * 命中 `<某根>/market/pkg/<包或目录>` ⇒ 根＝那个"某根"，`packageFile`＝`market/pkg` 后面那段。
 * 认不出来（作者只把一个 .uartix.json 丢在桌面）⇒ 根为 null，entries 对账这一道**照实说没跑**。
 */
export function locate(target) {
  const abs = path.resolve(target);
  const marker = `${path.sep}market${path.sep}pkg${path.sep}`;
  const at = abs.indexOf(marker);
  if (at < 0) return { abs, root: null, packageFile: "" };
  // 目录源直接指到 manifest.json 时，包名是它那个目录（loadPackage 与 entries 都按目录对）
  let packageFile = abs.slice(at + marker.length).replace(/[\\/]+$/, "");
  if (/manifest\.json$/.test(packageFile)) packageFile = packageFile.replace(/[\\/]manifest\.json$/, "");
  return { abs, root: abs.slice(0, at) || path.sep, packageFile };
}

/** entries 里指这份包的那一条（按 `packageFile` 对，不看文件名猜） */
export function findEntryMeta(root, packageFile) {
  const dir = path.join(root, "market", "entries");
  if (!isDir(dir)) return { meta: null, why: `没有 market/entries 目录，元数据对账这一道没跑` };
  const file = packageFile.replace(/\/+$/, "");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (String(meta.packageFile ?? "").replace(/\/+$/, "") === file) return { meta, file: f };
  }
  return { meta: null, why: `market/entries 里没有 packageFile 指向 ${packageFile} 的那一条` };
}

/**
 * 校验一份投稿。返回 `{ok, problems, warnings, ran, skipped, info}`：
 * `ran` 是**真的调用了**的那几道的名字，`skipped` 是这次没跑到的（附原因）。
 */
export function validateSubmission(target) {
  const problems = [];
  const warnings = [];
  const ran = [];
  const skipped = [];
  const where = locate(target);

  if (!fs.existsSync(where.abs)) {
    return { ok: false, problems: [`路径不存在：${target}`], warnings, ran, skipped, info: VALIDATOR_INFO, pkg: null };
  }
  // 目录源直接指到 manifest.json 时也按那个目录算（loadPackage 认目录名）
  const resolved = path.basename(where.abs) === "manifest.json" ? path.dirname(where.abs) : where.abs;
  const repoShape = where.root !== null;
  const scanPkgDir = repoShape ? path.join(where.root, "market", "pkg") : path.dirname(resolved);
  const packageFile = repoShape ? where.packageFile : path.basename(resolved);

  // ① 源包读取与旁挂内联（与生成器同一个 loadPackage：目录/平铺、重名、越界路径都在它那儿）
  let buf;
  try {
    buf = loadPackage(scanPkgDir, packageFile).buf;
    ran.push("源包读取与旁挂内联（loadPackage）");
  } catch (e) {
    return {
      ok: false,
      problems: [`包读不出来：${e instanceof Error ? e.message : String(e)}`],
      warnings, ran, skipped, info: VALIDATOR_INFO, pkg: null,
    };
  }

  // ② JSON 本身
  let pkg = null;
  try {
    pkg = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    problems.push(`包不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }

  // ③ 包体过**生产校验器**（与应用装包时那一道同一个函数）
  if (pkg) {
    const v = validateManifest(pkg);
    ran.push("包体生产校验器（validateManifest）");
    for (const m of v.errors) problems.push(m);
    for (const m of v.warnings) warnings.push(m);
  }

  // ④⑤ 有 entries 元数据才跑：元数据必填项 + 与包体对账 + 索引契约
  const found = where.root ? findEntryMeta(where.root, packageFile) : { meta: null, why: "这份包不在 <根>/market/pkg 之下，找不到对应的 entries 元数据" };
  if (!found.meta) {
    skipped.push(`元数据对账与索引契约：${found.why}`);
  } else {
    const catsPath = path.join(where.root, "market", "categories.json");
    const categories = fs.existsSync(catsPath) ? JSON.parse(fs.readFileSync(catsPath, "utf8")) : {};
    if (!fs.existsSync(catsPath)) skipped.push("分类表核对（没有 market/categories.json）");
    const metaErrs = checkEntryMeta(found.meta, categories);
    ran.push("entries 元数据必填项（checkEntryMeta）");
    problems.push(...metaErrs);
    if (pkg) {
      problems.push(...reconcileEntry(pkg, found.meta));
      ran.push("元数据 ↔ 包体对账（reconcileEntry）");
    }
    if (!metaErrs.length) {
      // dryRun：走生成器同一条编译路径（含 publicUrl 与实际产物名对上、截图文件存在），但**不往仓库里写**
      let built = null;
      try {
        built = buildEntry(found.meta, categories, { root: where.root, dryRun: true });
        ran.push("索引条目生成（buildEntry dryRun）");
      } catch (e) {
        problems.push(`上架时会在这儿失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (built) {
        const parsed = parseEntry(built, MARKET_ALLOW_HOSTS);
        ran.push("索引契约（parseEntry）");
        if (parsed.error) problems.push(`索引不收这一条：${parsed.error}`);
      }
    }
    warnings.push(`entries 元数据来自 market/entries/${found.file ?? "?"}`);
  }

  // 体积这条**不在这儿判**：包多大由索引契约的 bytes 上限管（parseEntry 已经算过一遍），
  // 在这里再比一次常量就是抄第二份规则（G8 不许）。
  return {
    ok: problems.length === 0,
    problems, warnings, ran, skipped,
    info: VALIDATOR_INFO,
    pkg: pkg ? { id: String(pkg.id ?? ""), name: String(pkg.name ?? ""), version: String(pkg.version ?? ""), bytes: buf.length } : null,
    root: where.root,
  };
}

/** 人读输出：跑了哪几道、跳了哪道、每条问题一行 */
export function renderValidate(r) {
  const head = [
    `校验器：包 schemaVersion ${r.info.pluginSchemaVersion} · 索引 schemaVersion ${r.info.marketSchemaVersion}`,
    `包体：${r.info.packageValidator}`,
    `契约：${r.info.entryValidator}`,
  ];
  const who = r.pkg ? `包：${r.pkg.name ?? "(无名)"}〈${r.pkg.id ?? "?"}〉 v${r.pkg.version ?? "?"} · ${r.pkg.bytes} 字节` : "包：没读出来";
  const ran = [`跑过：${r.ran.join(" / ") || "一道也没跑成"}`];
  const skip = r.skipped.length ? [`没跑：${r.skipped.join(" / ")}`] : [];
  const body = r.problems.length
    ? ["", `不通过（${r.problems.length} 条）：`, ...r.problems.map((p, i) => `  ${i + 1}. ${p}`)]
    : ["", "通过：上面列出的那几道都没意见。注意「通过」只覆盖列出来的这几道。"];
  const warn = r.warnings.length ? ["", ...r.warnings.map((w) => `提示：${w}`)] : [];
  return [...head, who, ...ran, ...skip, ...body, ...warn].join("\n");
}

// 单独跑它也给出结果（打成 cjs 后 import.meta 是空的，那种情况由命令行入口调 validateFlow）
const SELF = typeof import.meta?.url === "string" ? fileURLToPath(import.meta.url) : "";
if (SELF && process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const t = process.argv[2];
  const r = t ? validateSubmission(t) : null;
  console.log(r ? renderValidate(r) : "用法：node scripts/marketValidate.mjs <包.json | 目录源路径>");
  process.exitCode = r && r.ok ? 0 : 1;
}
