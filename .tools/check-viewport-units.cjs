#!/usr/bin/env node
/**
 * P117 · 第十一道门：视口单位必须按 `--zoom` 折算（§19 的闸门化）。
 *
 * 为什么现在才做成门：这条规则从 P104-B1 就写在注释里（"不用 100vh：CSS zoom 下视口单位
 * 会被双重缩放，非 100% 缩放时底部出现黑边/白边"），但**没有任何一道门在数它**。
 * 结果就是它一路靠人记得住：P115-F2 修了 `.ctx-menu`，同一族的 `.ui-dropdown` 被记成明账没动，
 * 我 P116 修完浮层，这次一盘 —— theme.css 里还有 **23 处** 视口单位没折算，
 * 其中 `.modal` 的 `max-height: 86vh` 在 125% 档等于 107.5% 屏高（任何弹窗都可能顶出屏幕）。
 * **写在注释里的规矩，只要没有门，就等于没有规矩。**
 *
 * 判据（三条，全是可判的）：
 *  ① 样式与内联样式里出现的 `Nvh/Nvw/Ndvh/Ndvw/Nsvh/Nlvh`，同一行必须除以 `var(--zoom)`；
 *  ② 例外要走 EXEMPT 清单并写明功能理由，条目数**只降不升**；
 *  ③ `--zoom` 的默认值必须还在（theme.css 里 `--zoom: 1;`）——它一丢，
 *     所有 `calc(… / var(--zoom))` 会整体失效（除以空值 = 该声明作废），而界面看着"正常"。
 *
 * 已知局限（明写，不假装全能）：
 *  - 按行判：把单位写在 A 行、把 `/ var(--zoom)` 写在 B 行的多行表达式会被误报，
 *    目前 CSS 里没有这种写法；真要加，就把它写成一行。
 *  - 不判"该不该用视口单位"，只判"用了有没有折算"。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const UNIT_RE = /\b\d+(?:\.\d+)?(?:dvh|dvw|svh|svw|lvh|lvw|dmin|vmin|dmax|vmax|vh|vw)\b/;

/** 需要扫描的源码根：样式全扫，脚本只扫可能写内联样式的那几层 */
const ROOTS = ["src/styles", "src/features", "src/shell", "src/shared", "src/panels"];

/** 例外清单：每条都要写"为什么这里可以按视口原样算"。条目数只降不升。 */
const EXEMPT = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 注释整体抹掉（多行块按原长度留空行，保证行号不漂） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

let fails = 0;
const offenders = [];
const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)));

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  const lines = stripComments(fs.readFileSync(abs, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (!UNIT_RE.test(line)) return;
    if (line.includes("var(--zoom)")) return;
    if (EXEMPT.some((e) => e.file === rel && e.line === i + 1)) return;
    offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 96)}`);
  });
}

/** 例外清单里已经不再命中的条目也要报（留着 = 假装还有债），与 i18n 预算同一套双向棘轮 */
for (const e of EXEMPT) {
  const abs = path.join(ROOT, e.file);
  const src = fs.existsSync(abs) ? stripComments(fs.readFileSync(abs, "utf8")).split("\n") : [];
  const line = src[e.line - 1] || "";
  if (!UNIT_RE.test(line) || line.includes("var(--zoom)")) {
    console.log(`FAIL: 豁免清单里的 ${e.file}:${e.line} 已经不再需要豁免（删掉这条，别留空位）`);
    fails++;
  }
}

if (offenders.length) {
  console.log(`FAIL: ${offenders.length} 处视口单位没有按 --zoom 折算（CSS zoom 下会双重缩放，§19）`);
  offenders.slice(0, 20).forEach((o) => console.log("  - " + o));
  if (offenders.length > 20) console.log(`  …另有 ${offenders.length - 20} 处`);
  console.log("  改法：`calc(86vh / var(--zoom))`；确实要按视口原样算的，进 EXEMPT 并写理由。");
  fails++;
} else {
  console.log(`OK: 视口单位全部按 --zoom 折算（扫描 ${files.length} 个文件，豁免 ${EXEMPT.length} 条）`);
}

const theme = fs.readFileSync(path.join(ROOT, "src/styles/theme.css"), "utf8");
if (!/--zoom:\s*1\s*;/.test(theme)) {
  console.log("FAIL: theme.css 里 `--zoom: 1;` 默认值不见了 —— 所有 `calc(… / var(--zoom))` 会一起作废");
  fails++;
} else {
  console.log("OK: --zoom 有默认值 1（100% 档下折算恒等）");
}

const zoomTs = fs.readFileSync(path.join(ROOT, "src/shared/zoom.ts"), "utf8");
if (!/--zoom/.test(zoomTs)) {
  console.log("FAIL: shared/zoom.ts 不再写 --zoom —— CSS 侧那批除法读的就没人写了");
  fails++;
} else {
  console.log("OK: --zoom 的唯一写者还在（shared/zoom.ts 与 style.zoom 同处写）");
}

console.log(fails === 0 ? "OK: viewport-unit check passed" : `FAIL: ${fails} problem(s)`);
process.exit(fails === 0 ? 0 : 1);
