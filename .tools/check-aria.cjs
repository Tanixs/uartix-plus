#!/usr/bin/env node
/**
 * 无障碍锚点门：图标钮必须能被读出名字（title 或 aria-label）。
 *
 * P103 批 0 把它修成**真门**。改之前它是一条永远绿的装饰：
 *   - 脚本没有 process.exit ⇒ 无论 missing 是几，`check:all` 的 `&&` 链都过（假门）；
 *   - 被扫的文件是**手写的 16 个路径**，路径改名/写错就 `continue` 静默跳过 ⇒
 *     覆盖面会自己缩水，而报告里看不出少了谁（§8-43：抽不到就判红）。
 *
 * 现在的三条判据（每条都能被反驳）：
 *   1. 扫全 `src/**\/*.tsx`（不再手写清单）；图标钮（开标签里含 icon）必须带 title 或 aria-label；
 *   2. 一个图标钮都没抽到 ⇒ 红（守卫自己瞎了比没守卫更坏）；
 *   3. 扫到的 tsx 文件数低于下限 ⇒ 红（走盘中断 / 目录改名 / cwd 不对）。
 *
 * 实测（P103 批 0，改前用同一套扫描跑过一遍）：列表内 0 违规、列表外 0 违规 ⇒
 * 修成真门不会把历史债一下子爆出来；证伪：摘掉任意一个图标钮的 title 必红。
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
/** 下限取实测 tsx 数的六成：只用来拦"走盘断了"，不是用来卡文件数 */
const MIN_TSX = 40;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** 取 `<button …>` 开标签原文（花括号深度感知：属性里带对象/表达式也不会被截断） */
function findButtons(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf("<button", i)) !== -1) {
    let depth = 0;
    let j = i + 7;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ idx: i, tag: src.slice(i, j + 1) });
    i = j + 1;
  }
  return out;
}

const files = walk(SRC);
let iconButtons = 0;
let missing = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const { idx, tag } of findButtons(src)) {
    if (!/icon/.test(tag)) continue;
    iconButtons++;
    if (/title=|aria-label=/.test(tag)) continue;
    const lineNo = src.slice(0, idx).split("\n").length;
    console.log(`${path.relative(process.cwd(), f)}:${lineNo}  ${tag.replace(/\s+/g, " ").slice(0, 120)}`);
    missing++;
  }
}

console.log(`[check:aria] 扫到 ${files.length} 个 tsx / ${iconButtons} 个图标钮，缺名字 ${missing} 个`);

let fails = 0;
if (iconButtons === 0) {
  console.error("FAIL: 一个图标钮都没抽到——守卫自己瞎了（判据/正则/走盘三处必有一处坏了）");
  fails++;
}
if (files.length < MIN_TSX) {
  console.error(`FAIL: 只扫到 ${files.length} 个 tsx（下限 ${MIN_TSX}）——走盘断了或 cwd 不对，覆盖面已缩水`);
  fails++;
}
if (missing > 0) {
  console.error(`FAIL: ${missing} 个图标钮没有 title / aria-label（屏幕阅读器读不出它是干什么的）`);
  fails++;
}
console.log(fails === 0 ? "OK: 图标钮都有可读名字" : `FAIL: ${fails} 类问题`);
process.exit(fails === 0 ? 0 : 1);
