#!/usr/bin/env node
/**
 * P103 批 1：样式契约门（check:style）。
 *
 * 三类判据，全部**派生**而不是手抄清单（§8-36：抄本就是一份等着过期的东西）：
 *
 *  A. 语义色字面量：不许把"主题该管的颜色"写成字面量。
 *     事故形态（本批实测）：theme.css 里 207 处颜色字面量，其中 `#e5534b`×47、`#3fb950`×33、
 *     `#d29922`×31 —— 正是 --danger/--ok/--warn 的**暗色值**被抄成字面量，于是亮色/海棠主题下
 *     连接点、Modbus 徽标、关闭钮 hover、帧画布保存态全是"暗色系的绿红"。§8-26 只把 --k-* 关进
 *     了门禁，这一族没关。这里的判据不看写法看**值**：任何与语义键当前值等价的 hex/rgba 都命中，
 *     所以"换个写法的副本"也躲不过。
 *     豁免：`--*: <色>;` 这类**声明行**（那本来就是定义处），以及行内注释含 `color-exempt` 的行。
 *
 *  B. `!important` 天花板：只许降不许升。它是"AI 注入的组件级样式永远压不过宿主"的直接原因
 *     （§8-37② 那族：模型写了规则却没生效，用户看到"改不动"）。现状 24 是上限。
 *
 *  C. 基元层规范：`P103-BASE` 标记区内的规则必须单/双类、零 `!important` —— 这是给 AI 留的
 *     **覆写台阶**：模型写一条单类规则就该能压过基元，而不是要靠 `!important` 军备竞赛。
 *
 * 用法：node .tools/check-style.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STYLE_DIR = path.join(ROOT, "src", "styles");
const THEME_DIR = path.join(STYLE_DIR, "themes");
const BASE_CSS = path.join(STYLE_DIR, "theme.css");
const IMPORTANT_CEILING = 24;

let fails = 0;

/* ---------------- 语义键（名字固定，值从主题文件派生） ---------------- */
/**
 * 为什么不带 `--on-accent`：它的值就是 `#ffffff`（亮色主题）/`#0f1115`（暗色主题）——
 * 与"半透明白高光"、"近黑遮罩"这类通用字面量**值相同**。按值等价去映射会把
 * `rgba(255,255,255,.06)` 这种高光写成"暗底主题下的近黑"，是修一个 bug 造一个 bug。
 * 白色文字压在主题色实底上（`.tb-close:hover{color:#fff}`）本来就是对的，不该动。
 */
const SEMANTIC_KEYS = [
  "--accent",
  "--danger",
  "--warn",
  "--ok",
  "--warn-fg",
  "--k-send",
  "--k-wait",
  "--k-frame",
  "--k-assert",
  "--k-note",
  "--k-logic",
  "--k-group",
  "--k-warn-line",
];

function normHex(v) {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(v.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6); // 带 alpha 的 hex 只为比对 RGB
  return h.length === 6 ? h.toLowerCase() : null;
}

/** 主题文件 + theme.css 的 :root 块里，这 14 个键出现过哪些颜色（RGB 集合） */
function semanticRgbSet() {
  const set = new Set();
  const files = fs.readdirSync(THEME_DIR).filter((f) => f.endsWith(".css"));
  const sources = [...files.map((f) => fs.readFileSync(path.join(THEME_DIR, f), "utf8")), fs.readFileSync(BASE_CSS, "utf8")];
  for (const src of sources) {
    for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (!SEMANTIC_KEYS.includes(m[1])) continue;
      const hex = normHex(m[2]);
      if (hex) set.add(hex);
    }
  }
  return set;
}

/* ---------------- 扫描：只扫"规则体里的使用处"，跳过声明行与注释 ---------------- */
function ruleBodies(src) {
  const out = [];
  // 先剥注释：注释里引用一个色值不是缺陷（本仓的注释经常在解释"以前这里写死过 #xxx"）。
  // 剥的时候保留换行，行号才可信（§8-42②：行号骗人等于没有守卫）。
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length - (m.split("\n").length - 1)) + "\n".repeat(m.split("\n").length - 1));
  const lines = stripped.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*--[\w-]+\s*:/.test(line)) return; // 令牌声明行：那本来就是定义处
    if (/color-exempt/.test(line)) return; // 人工豁免口子（要写理由）
    out.push({ no: i + 1, text: line });
  });
  return out;
}

const RGB = semanticRgbSet();
if (RGB.size < 8) {
  console.error(`FAIL: 语义色集合只派生出 ${RGB.size} 个值（八枚主题 + 基线合起来不该这么少）——门自己失效了`);
  fails++;
}

const offenders = [];
const cssFiles = [BASE_CSS];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".css") && p !== BASE_CSS && !p.startsWith(THEME_DIR)) cssFiles.push(p);
  }
})(STYLE_DIR);
(function walkFeatures(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFeatures(p);
    else if (e.name.endsWith(".css")) cssFiles.push(p);
  }
})(path.join(ROOT, "src", "features"));

for (const f of cssFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  for (const { no, text } of ruleBodies(fs.readFileSync(f, "utf8"))) {
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = normHex(m[0]);
      if (hex && RGB.has(hex)) offenders.push(`${rel}:${no}  ${m[0]}  ← 等于某个语义键的值，应写 var(--x)`);
    }
    for (const m of text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      if (RGB.has(hex)) offenders.push(`${rel}:${no}  ${m[0]}…)  ← 同一个语义色的 rgba 副本`);
    }
  }
}
if (offenders.length) {
  console.error(`FAIL(A): ${offenders.length} 处语义色字面量（主题换了它们不会跟着换）：`);
  for (const o of offenders.slice(0, 20)) console.error(`  - ${o}`);
  if (offenders.length > 20) console.error(`  …共 ${offenders.length} 处`);
  fails++;
} else {
  console.log(`OK(A): 语义色无字面量副本（派生集合 ${RGB.size} 个色值 / 扫了 ${cssFiles.length} 份样式）`);
}

/* ---------------- B：!important 天花板 ---------------- */
const baseSrc = fs.readFileSync(BASE_CSS, "utf8");
// 注释里出现 "!important" 这个词不算（本仓注释经常在解释"这里为什么必须 !important"）——
// 第一版没剥注释，结果是"我在注释里写下「零 !important」这句话"把门禁自己顶红了。
const baseNoComments = baseSrc.replace(/\/\*[\s\S]*?\*\//g, "");
const importantCount = (baseNoComments.match(/!important/g) || []).length;
if (importantCount > IMPORTANT_CEILING) {
  console.error(`FAIL(B): theme.css 的 !important 从 ${IMPORTANT_CEILING} 涨到 ${importantCount}——它会压死 AI 注入的组件级样式`);
  fails++;
} else {
  console.log(`OK(B): !important ${importantCount} 处（天花板 ${IMPORTANT_CEILING}，只许降）`);
}

/* ---------------- C：基元层规范（P103-BASE 标记区） ---------------- */
const baseStart = baseSrc.indexOf("/* P103-BASE-START */");
const baseEnd = baseSrc.indexOf("/* P103-BASE-END */");
if (baseStart < 0 || baseEnd < 0 || baseEnd < baseStart) {
  console.error("FAIL(C): theme.css 里找不到 P103-BASE-START/END 标记区——这条判据没有覆盖面，等于没做");
  fails++;
} else {
  const region = baseSrc.slice(baseStart, baseEnd);
  const bad = [];
  for (const m of region.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (/!important/.test(m[2])) bad.push(`!important: ${sel.slice(0, 80)}`);
    /**
     * 特异度只看"类/属性/伪类"三样里的**类与属性**，伪类（:hover/:active/:focus-visible/
     * :not()/:disabled）不算——状态选择器是基元自己的必要写法，判断台阶要看**基础选择器**：
     * 模型写一条 `.btn{...}` 应当能压过 `.btn`，但不打算压过 `.btn.primary`。
     */
    const bare = sel.replace(/::?[a-z-]+(\([^()]*\))?/gi, "");
    const units = (bare.match(/[.#\[]/g) || []).length;
    if (units > 2) bad.push(`特异度过高(${units}): ${sel.slice(0, 80)}`);
  }
  if (bad.length) {
    console.error(`FAIL(C): 基元层有 ${bad.length} 处不给 AI 留台阶：`);
    for (const b of bad.slice(0, 10)) console.error(`  - ${b}`);
    fails++;
  } else {
    console.log("OK(C): 基元层零 !important、特异性留台阶");
  }
}

/* ---------------- D：大括号配平（语法健全性） ----------------
 * 为什么要有这一条：批 1 收尾时 vite build 报 `theme.css:66: Unexpected }`——一个孤儿闭括号，
 * A/B/C 三条按值/按区域查，都不查"文件还像不像 CSS"；这类错要等 build 才炸（离编辑现场几十秒），
 * 而且孤儿 } 会**静默吞掉**其后的整段规则。这里用最朴素的栈：剥掉注释与字符串后数深度，
 * 出现负深度（孤儿 }）或收尾不归零（没关上的 {）都算红。证伪：删掉任意一个 } 必红。
 */
let dChecked = 0;
for (const f of cssFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const src = fs
    .readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let depth = 0;
  let firstBadLine = 0;
  src.split(/\r?\n/).forEach((line, i) => {
    for (const c of line) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth < 0 && !firstBadLine) firstBadLine = i + 1;
      }
    }
  });
  dChecked++;
  if (firstBadLine) {
    console.error(`FAIL(D): ${rel}:${firstBadLine} 出现孤儿 }——文件已不是合法 CSS，其后的规则会被静默吞掉`);
    fails++;
  } else if (depth !== 0) {
    console.error(`FAIL(D): ${rel} 有 ${depth} 个 { 没关上——其后的规则全部并进了上一个块`);
    fails++;
  }
}
if (dChecked === 0) {
  console.error("FAIL(D): 一份样式文件都没扫到——走盘断了，这条判据没有覆盖面");
  fails++;
} else {
  console.log(`OK(D): ${dChecked} 份样式大括号配平`);
}

console.log(fails === 0 ? "OK: 样式契约通过" : `FAIL: ${fails} 类问题`);
process.exit(fails === 0 ? 0 : 1);
