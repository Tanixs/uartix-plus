#!/usr/bin/env node
/**
 * P104-B10 chrome 登记门：把"面板往页签条登记动作"这件事里**能被机器发现的那两类错**钉住。
 *
 *   1. 面板 id 写错 —— `usePanelChrome("plot2d")` 打成 `"plot2d "` 或 `"plot-2d"`，
 *      编译期没人管（参数是 string），症状是"动作永远不出现"，
 *      而且面板自己那份工具条已经删了，于是两头都没有。这类"静默失效"是本轮一直在拆的账。
 *   2. 同一面板里动作 id 重复 —— 登记按 id 去重不做，React 会直接报 duplicate key，
 *      但报错点在页签组件里，离写错的地方隔了三个文件。
 *
 * **这条门刻意不管"搬完有没有把面板自己那条工具条删掉"**：那是 JSX 结构判断，
 * 静态扫出来的只会是近似值，误报多了人就学会忽略整条报告。
 * 它由 `MERGED` 这份清单代管 —— 铺开一个面板就加一行，人眼对着看。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

/** 已把动作搬上页签条的面板：登记即代表"它自己那条工具条不该再有这些按钮" */
const MERGED = ["plot2d"];

/** 合法面板名取自 `PanelId` 联合（唯一的真值来源，不在这里手抄第二份） */
function panelIdsFromSource() {
  const t = fs.readFileSync(path.join(SRC, "ipc/types.ts"), "utf8");
  const i = t.indexOf("PanelId");
  if (i < 0) return null;
  const seg = t.slice(i, t.indexOf(";", i) > 0 ? t.indexOf("\n}", i) + 2 : i + 4000);
  const ids = [...seg.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  return ids.length >= 15 ? new Set(ids) : null;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

const ids = panelIdsFromSource();
if (!ids) {
  console.error("FAIL: 没能从 src/ipc/types.ts 抽出 PanelId 联合 —— 这条门瞎了，比没有更坏");
  process.exit(1);
}

const files = walk(SRC);
const registered = [];
let bad = false;

for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(/usePanelChrome\(\s*"([^"]+)"/g)) {
    const panel = m[1];
    registered.push(panel);
    if (!ids.has(panel)) {
      bad = true;
      console.error(`FAIL: ${rel} 登记到不存在的面板 "${panel}"（页签上永远不会出现这些动作，而面板自己那条已删＝两头都没有）`);
    }
  }
  // 同一文件里重复登记同一个面板 = 后一份把前一份覆盖掉，症状同样是"少一半动作"
  const perFile = [...t.matchAll(/usePanelChrome\(\s*"([^"]+)"/g)].map((x) => x[1]);
  const dupPanel = perFile.find((p, i) => perFile.indexOf(p) !== i);
  if (dupPanel) {
    bad = true;
    console.error(`FAIL: ${rel} 对 "${dupPanel}" 登记了多次 —— 只该有一处 chromeItems`);
  }
}

if (!registered.length) {
  console.error("FAIL: 一个 usePanelChrome 登记都没扫到 —— B10 还没接上，或扫描路径坏了");
  process.exit(1);
}

for (const p of MERGED) {
  if (!registered.includes(p)) {
    bad = true;
    console.error(`FAIL: MERGED 清单里的 ${p} 其实没有登记 —— 把这一行删掉或去补登记，守卫不许留尸`);
  }
}

const uniq = [...new Set(registered)].sort();
console.log(`页签动作已登记：${uniq.length} 个面板 → ${uniq.join(" ")}`);
console.log(`MERGED 清单（自己那条工具条应已交出去）：${MERGED.join(" ")}`);
if (bad) process.exit(1);
console.log("OK: chrome 登记通过");
