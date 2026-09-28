#!/usr/bin/env node
/**
 * P119 · 第十二道门：`file:` URL 只能由 `fileURLToPath` 解码。
 *
 * 为什么补这道门：P118 那条 workflow 第一次跑 vitest 就红了 6 条，而**一条都不是断言问题**——
 * 是 4 个测试文件把源码路径拼错了：
 *   new URL("./pluginStore.ts", import.meta.url).pathname.slice(1)
 *   new URL(".", import.meta.url).pathname.replace(/^\//, "")
 * 这类"剥掉前导斜杠"的写法只在 Windows 上成立（`/D:/x` → `D:/x`）；Linux 上它把
 * `/home/runner/…` 削成**相对路径**，于是读文件 ENOENT。同一段代码在两台机器上是两种真相：
 * 本地 1855 条全绿，远端 6 条全红，而且红的理由跟被测契约毫无关系。
 *
 * 规矩本身其实早就在（仓库里 40+ 处都走 fileURLToPath），但没有门守着，所以新写的测试
 * 照抄了那几处老写法。这与 §8-60、P117 是同一课：**写在注释里的规矩，只要没有门，
 * 就等于没有规矩。**
 *
 * 判据（三条，全是可判的）：
 *  ① `.pathname` 后面接字符串剥法（slice/replace/substring/substr/split/match）判红；
 *     浏览器那个 `location.pathname` 不是文件路径，跳过；
 *  ② `new URL(…).pathname` 直接当路径用也判红（不剥也一样只在一台机器上对）；
 *  ③ 自证：检测式先咬一口内置夹具，咬不到就说明这道门自己瞎了，当场 FAIL（§8-43②）。
 *
 * 已知局限（明写）：按行判，注释行不判（本文件上面那段引例就该被跳过）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** 扫描范围：会读磁盘的那几层——源码里的测试、脚本、门禁自己 */
const SCAN_ROOTS = ["src", "scripts", ".tools"];
const FILE_RE = /\.(?:ts|tsx|mjs|cjs)$/;

const STRIP_RE = /\.pathname\s*\.\s*(?:slice|substring|substr|replace|split|match)\s*\(/;
const URL_PATHNAME_RE = /new\s+URL\([^)]*\)\s*\.pathname/;
const BROWSER_RE = /(?:^|[^\w.])location\s*\.\s*pathname/;
const COMMENT_RE = /^\s*(?:\/\/|\*|\/\*)/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (FILE_RE.test(e.name)) out.push(p);
  }
  return out;
}

const files = SCAN_ROOTS.map((r) => path.join(ROOT, r)).filter((p) => fs.existsSync(p)).flatMap((p) => walk(p));

const offenders = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (COMMENT_RE.test(line) || BROWSER_RE.test(line)) return;
    if (STRIP_RE.test(line) || URL_PATHNAME_RE.test(line)) {
      offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
}

// 自证：夹具必须被咬住。检测式瞎了会让这道门永远绿（和它想防的事故同一形状）。
// 夹具是拼出来的，不是为了让本文件那两行**不被自己判红**——直接写全样会让这道门长红在自己身上。
const FIXTURES = [
  '.pathname' + '.slice(1)',
  '.pathname' + '.replace(/^\\//, "")',
  'new URL(x, import.meta.url)' + '.pathname',
];
const blind = FIXTURES.filter((f) => !STRIP_RE.test(f) && !URL_PATHNAME_RE.test(f));

let fails = 0;

if (offenders.length) {
  console.log(`FAIL: ${offenders.length} 处在手动解码 file: URL —— 前导斜杠的剥法只在 Windows 上成立，Linux（CI）会把绝对路径削成相对路径`);
  offenders.slice(0, 20).forEach((o) => console.log("  - " + o));
  if (offenders.length > 20) console.log(`  …另有 ${offenders.length - 20} 处`);
  console.log("  改法：`fileURLToPath(new URL(…, import.meta.url))`（Windows/Linux 都给对的路径）");
  fails++;
} else {
  console.log(`OK: 没有一处手动解码 file: URL（扫描 ${files.length} 个文件）`);
}

if (blind.length) {
  console.log(`FAIL: 检测式咬不住自己的夹具（${blind.length}/${FIXTURES.length} 漏）—— 这道门是哑门`);
  fails++;
} else {
  console.log(`OK: 检测式对 ${FIXTURES.length} 条夹具全部命中（门自己不是瞎的）`);
}

const idiom = files.some((f) => fs.readFileSync(f, "utf8").includes("fileURLToPath"));
if (!idiom) {
  console.log("FAIL: 整个扫描范围里一处 fileURLToPath 都没有 —— 要么正解被删光了，要么扫错了目录");
  fails++;
} else {
  console.log("OK: 正解 fileURLToPath 仍在被使用");
}

console.log(fails === 0 ? "OK: path-portability check passed" : `FAIL: ${fails} problem(s)`);
process.exit(fails === 0 ? 0 : 1);
