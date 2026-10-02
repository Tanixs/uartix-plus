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
 *  H. 图标单一出处 + 基准清晰底线（P104-P2 加，见文件末尾那条的注释）。
 *
 * 用法：node .tools/check-style.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STYLE_DIR = path.join(ROOT, "src", "styles");
const THEME_DIR = path.join(STYLE_DIR, "themes");
const BUILTIN_STYLE_DIR = path.join(STYLE_DIR, "builtinStyles");
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
  console.error(`FAIL: 语义色集合只派生出 ${RGB.size} 个值（内置各枚 + 基线合起来不该这么少）——门自己失效了`);
  fails++;
}

const offenders = [];
const cssFiles = [BASE_CSS];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // `builtinStyles/` 与 `themes/` 一样是**数据包**，不参与宿主预算（B 的 !important 数、
    // G 的边框数、E/F 的字号圆角都是"宿主 chrome 欠多少"的账，主题多写一条边框不该记在这儿）。
    // 它不是没人管：门 K 判前缀与登记，`builtinStyles.test.ts` 让它过与第三方 CSS 同一台净化器。
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".css") && p !== BASE_CSS && !p.startsWith(THEME_DIR) && !p.startsWith(BUILTIN_STYLE_DIR)) cssFiles.push(p);
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

/* ---- P104-B2 E 门：字号必须走刻度 ----
 * 病根：全站曾有 14 档字号（含 9.5/10.5/11.5/12.5/13.5 五档半像素）、673 处字面量，
 * 而 token 只有 33 处。**在连续谱里挪值等于没挪**——人眼读不出层级，只觉得"差不多"。
 * 现在刻度只有 5 档文字 + 2 档展示，字面量一律禁止。
 * 豁免：规则块内含 `glyph-exempt` 注释的（如数字框 ▲▼，那是字形尺寸不是文字尺寸），
 * 与 check-contrast 的 `contrast-exempt` 同一套惯例——豁免必须就地写明理由，且清单只能变短。
 */
const FS_ALLOWED = new Set(["var(--fs-xs)", "var(--fs-body)", "var(--fs-sm)", "var(--fs-md)", "var(--fs-lg)", "var(--fs-xl)", "var(--fs-2xl)"]);
function scanTypeScale() {
  const bad = [];
  let exempt = 0;
  for (const f of cssFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/font-size:\s*([^;]+);/g)) {
      const val = m[1].trim();
      if (FS_ALLOWED.has(val)) continue;
      if (/^var\(--fs-/.test(val)) continue; // 主题自定义档位（如挂件内）留给 token 前缀判定
      // 找本条规则的块，看有没有就地豁免注释
      const open = src.lastIndexOf("{", m.index);
      const close = src.indexOf("}", m.index);
      const block = open >= 0 && close > open ? src.slice(open, close) : "";
      if (/glyph-exempt/.test(block)) {
        exempt++;
        continue;
      }
      if (/^calc\(/.test(val)) continue; // 由 token 派生的计算值（缩放不变命中区用）
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      bad.push(`${rel}:${line} font-size: ${val}`);
    }
  }
  if (bad.length) {
    console.error(`FAIL(E): ${bad.length} 处 font-size 不在刻度上（只许 var(--fs-*)）：`);
    for (const b of bad.slice(0, 12)) console.error("  - " + b);
    if (bad.length > 12) console.error(`  … 另有 ${bad.length - 12} 处`);
    fails++;
  } else {
    console.log(`OK(E): font-size 全部走刻度（就地豁免 ${exempt} 处，均为字形尺寸；豁免清单只许变短）`);
  }
}
scanTypeScale();

/* ---- P104-B2 F 门：圆角必须走刻度 ----
 * 同样本批先警告跑一轮：圆角还有 217 处字面量、13 档，归并动作在下一步做。
 * 转红条件：等归并完成后把下面这行的 warn 改成 fails++。
 */
const RADIUS_ALLOWED = new Set(["var(--radius-s)", "var(--radius-m)", "var(--radius-l)", "var(--radius-xl)", "var(--radius-pill)", "0", "50%", "inherit"]);
function scanRadiusScale() {
  const bad = [];
  for (const f of cssFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/border-radius:\s*([^;]+);/g)) {
      const val = m[1].trim();
      if (RADIUS_ALLOWED.has(val)) continue;
      // 不对称圆角（0 var(--radius-m) var(--radius-m) 0 这类）：逐分量判，
      // 每个分量都必须是 token 或字面 0，否则算违规。
      const parts = val.split(/\s+/);
      if (parts.length > 1 && parts.every((x) => /^var\(--radius-/.test(x) || x === "0")) continue;
      if (/^var\(--radius-/.test(val)) continue;
      if (!/\d/.test(val)) continue;
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      bad.push(`${rel}:${line} border-radius: ${val}`);
    }
  }
  if (bad.length) {
    console.error(`FAIL(F): ${bad.length} 处 border-radius 不在刻度上（只许 var(--radius-*) 或 0）：`);
    for (const b of bad.slice(0, 8)) console.error("  - " + b);
    fails++;
  } else {
    console.log("OK(F): border-radius 全部走刻度");
  }
}
scanRadiusScale();

/* ---- P104-B2 G 门：边框声明总量只降不升 ----
 * Linear 那条"层级靠字重和透明度、不靠分割线"要能证伪，就得先有基线。
 * B2 实测基线 = 398 条带宽度边框声明（其中 100 条 --border-soft），
 * 口径 = cssFiles 全部 3 份（theme.css / metrics.css / analysis.css）。
 * 第一版我拿"两份文件"的 396 当基线，门禁扫 3 份，于是自己把自己判红了——
 * 基线必须与判据同一口径，否则门的第一个发现就是它自己的错。
 * 本批**不承诺下降**——削减来自 B4（48 条面板工具栏规则不再铺色也不再画框）与 B5/B6（外壳靠档差）。
 * 这条门的作用是把天花板钉住：后面每批要么持平要么更少，不许用新边框解决新层级问题。
 */
const BORDER_CEILING = 398;
{
  let borders = 0;
  let soft = 0;
  for (const f of cssFiles) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    borders += (src.match(/border(?:-(?:top|bottom|left|right))?:\s*[0-9.]+px/g) || []).length;
    soft += (src.match(/border(?:-(?:top|bottom|left|right))?:\s*[^;]*--border-soft/g) || []).length;
  }
  if (borders > BORDER_CEILING) {
    console.error(`FAIL(G): 带宽度边框声明 ${borders} 条 > 基线 ${BORDER_CEILING}——层级请用字重/透明度/间距，不要再加线`);
    fails++;
  } else {
    console.log(`OK(G): 边框 ${borders} 条 ≤ 基线 ${BORDER_CEILING}（其中 --border-soft ${soft} 条；天花板只许降）`);
  }
}

/* ---- P104-P2 H 门：图标只许一处出处、基准不许跌破清晰底线 ----
 * 这条是被实拍逼出来的：`shared/icons.tsx` 里定了基准，屏幕上也**确实**只有一半图标
 * 听它的——另一半散在 15 个文件里，各自抄了一份 `<svg viewBox="0 0 24 24"
 * width="13|14|15" strokeWidth="2|2.2|2.4">`。于是"把基准调到 16/2.0"改不动用户
 * 看到的那几颗，改完还是糊的。抄一份 = 多一处出处，基准就少管一处。
 *
 * 判据两条：
 *  ① 24 viewBox 的描边图标必须走 `Glyph`（`shared/icons.tsx` 自己是唯一豁免）。
 *     只卡"描边图标"这个形态：数据可视化（InfoBar 折线、FieldLegend 色块、
 *     EmptyState 大插画、卡片里的 buzzer/LED）不是图标，本该有自己的尺寸。
 *  ② 基准本身留在清晰底线之上。糊不糊看设备像素：
 *        strokeDev = strokeWidth × (size / 24) × dpr × zoom
 *     所以尺寸与描边是**乘积**关系，动任何一边都要重算另一边——P103 就是只动了
 *     描边（2.0→1.75）没动尺寸，结果名义变轻、实际变虚。
 *     底线取 dpr=1 时 ≥1.0 设备像素：2.0 × 16/24 = 1.333 ⇒ 乘积 ≥ 32。
 */
const ICON_STROKE_AREA_FLOOR = 32; // size × strokeWidth
{
  const ICON_BASE = path.join(ROOT, "src", "shared", "icons.tsx");
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.tsx$/.test(e.name) ? [p] : [];
    });
  const inline = [];
  const linesOf = (f) => fs.readFileSync(f, "utf8").split(/\r?\n/);
  for (const f of walk(path.join(ROOT, "src"))) {
    if (path.resolve(f) === path.resolve(ICON_BASE)) continue;
    const lines = linesOf(f);
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    lines.forEach((line, i) => {
      if (!/^\s*<svg[\s>]/.test(line)) return;
      // 起始标签可能跨行：取到第一个 `>` 为止
      const block = lines.slice(i, i + 14).join(" ");
      const tagEnd = block.indexOf(">");
      const tag = tagEnd < 0 ? block : block.slice(0, tagEnd + 1);
      if (!/viewBox="0 0 24 24"/.test(tag)) return;
      if (!/\b(width|strokeWidth)=/.test(tag)) return;
      inline.push(`${rel}:${i + 1}`);
    });
  }
  if (inline.length) {
    console.error(`FAIL(H): ${inline.length} 处私抄的 24 viewBox 描边图标——请改走 shared/icons.tsx 的 <Glyph>：`);
    for (const b of inline.slice(0, 12)) console.error("  - " + b);
    fails++;
  } else {
    console.log("OK(H): 24 viewBox 描边图标全部走 Glyph，尺寸/描边只有一处出处");
  }

  const baseSrc = fs.readFileSync(ICON_BASE, "utf8");
  const num = (name) => {
    const m = baseSrc.match(new RegExp(`export const ${name} = ([0-9.]+)`));
    return m ? parseFloat(m[1]) : NaN;
  };
  const size = num("ICON_SIZE");
  const stroke = num("ICON_STROKE");
  if (!(size > 0 && stroke > 0)) {
    console.error("FAIL(H): 读不到 ICON_SIZE / ICON_STROKE —— 基准换了写法，门要一起换");
    fails++;
  } else if (size * stroke < ICON_STROKE_AREA_FLOOR) {
    console.error(
      `FAIL(H): 基准 ${size}px × 描边 ${stroke} = ${(size * stroke).toFixed(1)} < ${ICON_STROKE_AREA_FLOOR}` +
        ` —— dpr 1 下描边只剩 ${((size * stroke) / 24).toFixed(2)} 设备像素，会被抗锯齿摊到两行（"变小就糊"）`,
    );
    fails++;
  } else {
    console.log(`OK(H): 图标基准 ${size}px / 描边 ${stroke} ⇒ dpr 1 下 ${((size * stroke) / 24).toFixed(2)} 设备像素，站得住底线`);
  }
}

/* ---- P104-P3 I 门：条不许用 overflow:hidden 裁控件 ----
 * `.fc-toolbar` 当年写 `overflow:hidden` 是为了"条比面板宽时别漏出去"。
 * 代价有两层，都是 P3 实测撞上的：窄面板里 3 颗控件被裁到盒外**点不到**；
 * 而条内 `.fc-anno-wrap`（relative）挂的弹层在 `top:30px`，正好落在 28px 高的条盒
 * 外面，于是时间轴标注那个弹层**根本展不开**。
 * 一个创可贴按住两个 bug，所以这条门只钉一件事：别再用裁切去掩盖溢出。
 *
 * 这里曾经还有第二条（`defaultLayout.ts` 不许手抄 `minimumWidth:`），配套的是
 * "面板最小宽 = 工具条固有宽"那套派生机制。用户 2026-09-25 判定撤掉，理由是
 * 抬最小宽**本质上是拿邻居换自己的空间**——实测代价：modbus 预设里工作台从 712
 * 掉到 580、2D 曲线被挤到页签点不到。代价比它修掉的缺陷大，机制已回退，判据随之删。
 */
{
  /* 判据要认"工具条"而不是"名字里带 bar"：第一版就是没分清，
     把 `.ai-ctx-bar` / `.xfer-bar` 两条**进度条**判红了 —— 它们的 overflow:hidden
     是用来裁圆角里的 fill 的，完全正确。工具条的形态特征是 `display:flex` 的一行控件，
     进度条是带 `*-fill` 子块的轨道，所以按"是 flex 且裁横向"来认。 */
  const isToolbarClip = (block) => {
    const sel = (block.split("{")[0] || "").trim();
    if (!/\.[a-z0-9-]*(?:bar|toolbar)\b/i.test(sel)) return false;
    if (!/display:\s*(?:inline-)?flex/.test(block)) return false;
    return /overflow(?:-x)?:\s*hidden/.test(block);
  };
  const clipped = [];
  for (const f of cssFiles) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const block of src.match(/[^{}]+\{[^{}]*\}/g) || []) {
      if (isToolbarClip(block)) clipped.push((block.split("{")[0] || "").trim().slice(0, 46));
    }
  }
  if (clipped.length) {
    console.error(`FAIL(I): ${clipped.length} 处工具条用 overflow:hidden 裁控件 —— 窄面板里控件会点不到，条内弹层会被裁掉：`);
    for (const c of clipped.slice(0, 8)) console.error("  - " + c);
    fails++;
  } else {
    console.log("OK(I): 没有一条 flex 工具栏用 overflow:hidden 裁控件");
  }
}

/**
 * 项目 CSS 里出现过的类名全集（J 与 J2 共用的"有没有人写样式"口径）。
 * 主题目录不在 `cssFiles` 里（那批文件是 token-only 的数据，一条选择器规则都不该有）。
 */
const CSS_CLASS_TOKENS = new Set();
for (const f of cssFiles) {
  for (const m of fs.readFileSync(f, "utf8").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) CSS_CLASS_TOKENS.add(m[1]);
}
/**
 * 宿主**会渲染出来**但自己没写样式的类名（J 的豁免族 + J2 的命令式族）。
 * 下面的 J3 要用它：主题包给一条宿主故意留空的类名写样式，不算死选择器。
 * 由 J / J2 各自在扫的时候填，不另抄一份清单。
 */
const HOST_CLASS_EXTRA = new Set();

/* ---- P111-J 门：用了的类名必须有定义（写了没人看的那一半） ----
 * 事故形态（P110-B3/B4 交付，用户判不合格后实测定位）：`AiModelRows.tsx` 与
 * `AiModelPicker.tsx` 里用了 `.set-hint` / `.set-json` / `.ai-model-picker*` 共 5 个类名，
 * 而**全项目 CSS 里根本没有这些规则**。后果不是"没样式"这么轻：
 * 没有规则 ⇒ 继承 body 的 16px，而同页真正的标签是 12px ⇒ **说明文字比它要说明的东西大 1.33 倍**，
 * 还不降色、没有行高。用户看到的是"字体又大又丑"，根因是一行没写出来的 CSS。
 *
 * 为什么现有门禁拦不住：`check-undeclared-vars` 管的是"用了没定义的**变量**"，
 * 这条是它的镜像——"用了没定义的**类名**"。边框数、翻译数都数得对，唯独没人问过
 * "这个类名有没有人写样式"。这条门若在，P110-B3 当场红，我根本交不出去。
 *
 * 判据三条：
 *  ① TSX 里 `className=` 位置的**静态**类名 token，必须在 `cssFiles` 并集里出现过；
 *  ② 豁免逐条写理由，且**必须仍被真引用**——文件删了名单还留着就是给下一次偷懒开门
 *     （与 `settingsSchema.test` 的 DELEGATED_WRITERS 同一纪律）；
 *  ③ 豁免总数只降不升（基线见 J_CEILING）。
 *
 * 认不到的形态（明写在这是为了不让下一个人以为它全能管）：
 *  - 模板串里 `${}` 拼出来的动态类名：剥掉插值后剩下的字面量段照查，整段动态的查不了；
 *  - 不带连字符的裸词（`btn`、`input`、`on`）：与属性值/英文词撞车率太高，不在判据内；
 *  - 第三方 CSS 里的类（dockview 的 `dv-*`）：实测 src 里没有手写 `dv-*` 的 className，
 *    真出现时把它加进 `cssFiles` 的并集，而不是给它开豁免。
 *  命令式赋值（`el.className = …` / `classList.add`）与 HTML 字符串里的 `class="…"`
 *  **不在这一条里**了：那是 J 最初的盲区（`.ai-toast` 就是从这里漏出去的），由下面的 J2 管。
 */
/**
 * 基线 16：P111-A 上线当天实测的**存量**欠账。
 * 我自己在 P110-B3/B4 新写的那 7 个（`set-hint`/`set-json`/`ai-model-picker`×3/`pm-hint`/`sq-hint`）
 * **不进这张表**——一条会拦这个错的门，如果开局第一件事是把这个错豁免掉，它就白造了。
 * 那 7 个当场补了 CSS（theme.css 的「一行次要说明」族）。
 *
 * 每条豁免只有两种合法写法：① 说清它为什么不需要规则（身份/锚点钩子）；
 * ② 明说是欠账、什么时候还（P111-E）。写不出这两句话的，就该补 CSS 或删类名。
 */
const J_CEILING = 13;
/** token → 为什么允许它没有 CSS（说不出人话的理由等于没有理由） */
const J_EXEMPT = {
  // —— 身份 / 锚点钩子：同元素的另一个类或父级已有样式，这个 token 只用来定位 ——
  "ctlg-switch": "与 .ctlg-row 同元素，样式在 .ctlg-row；这三枚是控件卡类型的身份钩子（插件与 AI 覆写按它定位）",
  "ctlg-monitor": "同上（控件卡类型身份钩子）",
  "ctlg-led": "同上（控件卡类型身份钩子）",
  "mkt-offshelf-toggle": "与 .plg-fchip 同元素，样式在 plg-fchip；这枚是「下架态开关」的身份钩子",
  "ai-streaming-only": "可见性钩子（流式期间才显示），布局由父级 .ai-msgs 管",
  "ai-edit-input": "与 .input 同元素，样式在 .input",
  "ext-panel-host": "扩展面板的宿主容器钩子，内部内容自带样式",
  "orch-chip-wrap": "浮层锚点（relative 由 Dropdown 侧给），无自有视觉",
  // —— 明说的欠账：症状比 .set-hint 轻（父级是 flex/grid，被带着走），逐条还 ——
  "plot-measure-col": "欠账：测量列容器没写规则，靠父级 flex 撑着 ⇒ 间距不受控",
  "ai-anom-item": "欠账：异常项行没写规则。",
  "ai-ext-head": "欠账：扩展面板标题行没写规则。",
  "ai-edit-wrap": "欠账：消息编辑态容器没写规则。",
  "ext-panel-miss": "欠账：「面板未找到」提示态没写规则。",
};
{
  // "有没有人写样式"的口径只有一份：J（JSX 的 className=）与 J2（命令式与 HTML 串）共用
  const defined = CSS_CLASS_TOKENS;
  const tsxFiles = [];
  (function walkTsx(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkTsx(p);
      else if (e.name.endsWith(".tsx")) tsxFiles.push(p);
    }
  })(path.join(ROOT, "src"));

  const used = new Map(); // token → 出处（rel:line）
  for (const f of tsxFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    fs
      .readFileSync(f, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        // className= 后面跟的字符串字面量：`"a b"` / `'a b'` / `` {`a b`} `` / `{"a"}`
        for (const m of line.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/g)) {
          const raw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").replace(/\$\{[^}]*\}/g, " ");
          for (const tok of raw.split(/\s+/)) {
            if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tok)) continue;
            if (defined.has(tok)) continue;
            if (!used.has(tok)) used.set(tok, []);
            used.get(tok).push(`${rel}:${i + 1}`);
          }
        }
      });
  }

  const unexempted = [...used.keys()].filter((t) => !J_EXEMPT[t]);
  for (const t of used.keys()) HOST_CLASS_EXTRA.add(t);
  if (unexempted.length) {
    console.error(`FAIL(J): ${unexempted.length} 个类名被 TSX 用了却在项目 CSS 里没有定义 —— 它会继承 body 字号（16px），`);
    console.error("       把「说明」顶到比标签还大。补一条规则，或者删掉这个类名：");
    for (const t of unexempted.slice(0, 30)) console.error(`  - .${t}  ← ${used.get(t).slice(0, 3).join(", ")}${used.get(t).length > 3 ? ` …共 ${used.get(t).length} 处` : ""}`);
    fails++;
  } else if (used.size > J_CEILING) {
    console.error(`FAIL(J): 未定义类名 ${used.size} 个 > 基线 ${J_CEILING} —— 豁免名单只降不升`);
    fails++;
  } else {
    const stale = Object.keys(J_EXEMPT).filter((t) => !used.has(t));
    if (stale.length) {
      console.error(`FAIL(J): 豁免名单里这 ${stale.length} 条已经没人引用了，是个空门，删掉：${stale.join(", ")}`);
      fails++;
    } else {
      console.log(`OK(J): TSX 用到的静态类名全部有定义（豁免 ${Object.keys(J_EXEMPT).length} 条 ≤ 基线 ${J_CEILING}，且条条仍被引用）`);
    }
  }
}

/* ---- P131-A2 门 J2：类名不只从 JSX 挂出去（J 的盲区） ----
 * 事故形态（P131 详设 §4 的第一手样本）：`shared/toast.ts` 之前那两份手搓实现
 * 用 `document.createElement(...)` + `el.className = "ai-toast-host"` 挂类名，
 * 而这对类名**在全部 CSS 里一条规则都没有** ——「Operator 模式：配置只读」这句必须被
 * 用户看见的话，一直是以裸 div 贴在页面末尾。J 门看不见这条通道，因为它只认
 * JSX 属性位上的 `className=`。
 *
 * J2 补的就是这一族：命令式赋值（`.className =` / `classList.*` / `setAttribute("class",…)` /
 * `class:`）与 HTML 字符串里的 `class="…"`（宿主自己生成的 tooltip、测试序列报告、声明式面板）。
 *
 * 两条必要的豁免口径，都是从误报里学来的（首跑把声明式面板 13 个 `ux-*` 全报了，实为自带样式）：
 *  - **自带样式的文件不算欠账**：自包含 HTML（报告 / iframe 面板）的样式表就在同一个文件的
 *    另一个 const 里，所以本文件任何一处 `.token` 选择器写法都当作它有定义；
 *  - 剩下的确实没有规则的，按 J 的纪律逐条写清"为什么不需要"，且必须仍被真引用，总数只降不升。
 */
const J2_CEILING = 4;
const J2_EXEMPT = {
  // 这四枚都在 `declarativePanel.ts`：`.ux-block` 才是带视觉的那条规则，这几个是同元素的身份钩子
  // （运行时脚本按 `classList.contains("ux-metric")` 分流，`.ux-text` / `.ux-html` 供覆写定位）
  "ux-metric": "与 .ux-block 同元素，卡片视觉在 .ux-block；这枚是运行时脚本分流用的身份钩子",
  "ux-spark": "同上（趋势卡的身份钩子）",
  "ux-text": "同上（文本卡的身份钩子，间距由 .ux-text-body 承担）",
  "ux-html": "同上（自定义 HTML 块的身份钩子，容器视觉由 .ux-block 承担）",
};
{
  /** 一行的类名 token 抽取：返回 [{tok, form}]；`own` 是本文件自带样式的豁免集 */
  const ASSIGN = [
    ["className=", /\.className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g],
    ["classList", /\.classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g],
    ["setAttribute", /\.setAttribute\(\s*["']class["']\s*,\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g],
    ["class:", /\bclass:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g],
    ['class="', /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g],
  ];
  function tokensOfLine(line) {
    const out = [];
    for (const [form, re] of ASSIGN) {
      for (const m of line.matchAll(re)) {
        let raw = m[1] ?? m[2] ?? m[3] ?? "";
        // classList 那一支抓的是整个参数表：引号要去掉，变量名留着也匹配不上 token 式
        if (form === "classList") raw = raw.replace(/["'`]/g, " ");
        raw = raw.replace(/\$\{[^}]*\}/g, " ");
        for (const tok of raw.split(/[\s,]+/)) if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tok)) out.push({ tok, form });
      }
    }
    return out;
  }

  const tsFiles = [];
  (function walkJs(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkJs(p);
      // 单测里造的是一次性 DOM，不是界面；这条门只管产品代码
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) tsFiles.push(p);
    }
  })(path.join(ROOT, "src"));

  const used2 = new Map(); // token → 出处
  for (const f of tsFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const text = fs.readFileSync(f, "utf8");
    // 本文件自带的选择器（自包含 HTML 的样式表常是另一个 const，所以不按 <style> 块划界）。
    // 前瞻写法是必要的：`.ux-metric-val .ux-unit{` 里两个类都要认出来。
    const own = new Set();
    for (const m of text.matchAll(/\.([_a-zA-Z][\w-]*)(?=\s*[,{:.])/g)) own.add(m[1]);
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return; // 注释里的例子不算引用
      for (const { tok, form } of tokensOfLine(line)) {
        if (CSS_CLASS_TOKENS.has(tok) || own.has(tok)) continue;
        if (!used2.has(tok)) used2.set(tok, []);
        used2.get(tok).push(`${rel}:${i + 1} ←${form}`);
      }
    });
  }

  const unexempted2 = [...used2.keys()].filter((t) => !J2_EXEMPT[t]);
  for (const t of used2.keys()) HOST_CLASS_EXTRA.add(t);
  if (unexempted2.length) {
    console.error(`FAIL(J2): ${unexempted2.length} 个类名由 JS/HTML 串挂出去却在 CSS 里没有定义 —— 它继承 body 的 16px、`);
    console.error("       没有底色没有定位（`.ai-toast` 就是这么把「配置只读」藏了不知多久）。补一条规则，或删掉这个类名：");
    for (const t of unexempted2.slice(0, 30)) {
      const w = used2.get(t);
      console.error(`  - .${t}  ← ${w.slice(0, 3).join(", ")}${w.length > 3 ? ` …共 ${w.length} 处` : ""}`);
    }
    fails++;
  } else if (used2.size > J2_CEILING) {
    console.error(`FAIL(J2): 命令式挂出的未定义类名 ${used2.size} 个 > 基线 ${J2_CEILING} —— 豁免名单只降不升`);
    fails++;
  } else {
    const stale2 = Object.keys(J2_EXEMPT).filter((t) => !used2.has(t));
    if (stale2.length) {
      console.error(`FAIL(J2): 豁免名单里这 ${stale2.length} 条已经没人引用了，是个空门，删掉：${stale2.join(", ")}`);
      fails++;
    } else {
      console.log(`OK(J2): 命令式与 HTML 串挂出的类名全部有定义（自带样式的文件已按文件豁免；豁免 ${Object.keys(J2_EXEMPT).length} 条 ≤ 基线 ${J2_CEILING}，且条条仍被引用）`);
    }
  }

  /* 门自己不是瞎的：三种形态各造一条夹具，抽不出来就是门失效（P119 那条教训：检测式要先被证明能命中） */
  const fixture = [
    'x.className = "zz-decoy-a other";',
    'x.classList.add("zz-decoy-b");',
    'const html = `<div class="zz-decoy-c">x</div>`;',
    'x.setAttribute("class", "zz-decoy-d");',
  ].join("\n");
  const caught = new Set(tokensOfLine(fixture).map((r) => r.tok));
  const missed = ["zz-decoy-a", "zz-decoy-b", "zz-decoy-c", "zz-decoy-d"].filter((t) => !caught.has(t));
  if (missed.length) {
    console.error(`FAIL(J2): 检测式对夹具漏检 ${missed.join(", ")} —— 门是瞎的，报出去的"干净"不算数`);
    fails++;
  }
}

/* ---- P132-A2 门 J3：主题包组件 CSS 挂的宿主类名必须真存在 ----
 * 这一层原本是 12 道门的**完全盲区**：静态门只扫 `src/**`，而插件主题除了 token 还带一段
 * 组件 CSS，运行时注进 `<style data-ai-ext>`。首跑就抓到三条：fluent-blue 包里的
 * `.sb-item` / `.aiw-item` / `.cmdk-row` 宿主根本没有（真名 `.ib-count` / `.aiw-menu-item` /
 * `.cmdk-item`），那三条规则从上架起一直在画空气——净化器只管"能不能进宿主"，管不了"进来了绑不上"。
 *
 * 判据：扫**上架产物**（`public/market/pkg/*.uartix.json`，用户装的就是这份字节）里 kind=theme
 * 的 `css`，取每条规则的选择器段，抽 `.类名`，必须落在
 *   `CSS_CLASS_TOKENS`（宿主写过样式的类名）∪ `HOST_CLASS_EXTRA`（宿主渲染但故意留空的）里。
 * 只查主题包：widget / panel 包自带 HTML，那些类名是它自己的，不归这条管。
 *
 * 认不到的形态（明写在这，免得下一个人以为它全能管）：
 *  - 运行时拼出来的类名（宿主自己 `className={\`x-${k}\`}` 那一族）：真出现时按 J 的纪律
 *    逐条写理由进 `J3_EXEMPT`，且必须仍被真引用；
 *  - 选择器里的字符串与注释：先剥掉，`content: ".zz"` 不算引用。
 */
const J3_CEILING = 0;
/** token → 为什么宿主确实会渲染它（说不出人话等于没有豁免） */
const J3_EXEMPT = {};
{
  /** 取 CSS 里所有"选择器段"：`{` 之前那一段；`}` 与 `;` 之后重新起算（声明不会被当成选择器） */
  function selectorsOf(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const out = [];
    let buf = "";
    for (const ch of src) {
      if (ch === "{") {
        const s = buf.trim();
        if (s && !s.startsWith("@")) out.push(s);
        buf = "";
        continue;
      }
      if (ch === "}" || ch === ";") {
        buf = "";
        continue;
      }
      buf += ch;
    }
    return out;
  }
  const classTokens = (sel) => [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

  const pkgDir = path.join(ROOT, "public", "market", "pkg");
  const dead = [];
  const seenTok = new Set();
  let themePkgs = 0;
  let ruleSels = 0;
  /** 两处来源一起查：上架的插件主题包 + 内置 style 包（同一层表达，判据不该两条通路两套） */
  const sources = [];
  if (fs.existsSync(pkgDir)) {
    for (const f of fs.readdirSync(pkgDir).filter((x) => x.endsWith(".uartix.json")).sort()) {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, f), "utf8"));
      for (const [artName, art] of Object.entries(manifest.artifacts ?? {})) {
        if (!art || art.kind !== "theme" || typeof art.css !== "string" || !art.css.trim()) continue;
        sources.push([`${f} · ${artName}`, art.css]);
      }
    }
  }
  if (fs.existsSync(BUILTIN_STYLE_DIR)) {
    for (const f of fs.readdirSync(BUILTIN_STYLE_DIR).filter((x) => x.endsWith(".css")).sort()) {
      sources.push([`builtinStyles/${f}`, fs.readFileSync(path.join(BUILTIN_STYLE_DIR, f), "utf8")]);
    }
  }
  themePkgs = sources.length;
  if (fs.existsSync(pkgDir)) {
    for (const [where, css] of sources) {
      const seen = new Set();
      for (const sel of selectorsOf(css)) {
        ruleSels++;
        for (const tok of classTokens(sel)) {
          seenTok.add(tok);
          if (CSS_CLASS_TOKENS.has(tok) || HOST_CLASS_EXTRA.has(tok) || seen.has(tok)) continue;
          seen.add(tok);
          if (J3_EXEMPT[tok]) continue;
          dead.push(`${where}: .${tok}  ← ${sel.replace(/\s+/g, " ").slice(0, 52)}`);
        }
      }
    }
  }
  /** 豁免也要"仍被真引用"（与 J / J2 同一条纪律）：包里没这个类名了，条目就得删 */
  const staleExempt = Object.keys(J3_EXEMPT).filter((t) => !seenTok.has(t));
  if (dead.length) {
    console.error(`FAIL(J3): 主题包组件 CSS 里 ${new Set(dead.map((d) => d.split(": .")[1].split(" ")[0])).size} 个类名宿主根本不渲染 —— 那些规则一条都画不出来。`);
    console.error("       改成真名，或说明为什么宿主会动态长出它（进 J3_EXEMPT 要写清出处）：");
    for (const d of dead.slice(0, 20)) console.error("  - " + d);
    fails++;
  } else if (staleExempt.length) {
    console.error(`FAIL(J3): 豁免名单里这 ${staleExempt.length} 条已经没人引用了，是个空门，删掉：${staleExempt.join(", ")}`);
    fails++;
  } else if (Object.keys(J3_EXEMPT).length > J3_CEILING) {
    console.error(`FAIL(J3): 主题包死选择器豁免 ${Object.keys(J3_EXEMPT).length} 条 > 基线 ${J3_CEILING} —— 名单只降不升`);
    fails++;
  } else {
    console.log(`OK(J3): ${themePkgs} 份主题组件 CSS（包 + 内置 style；${ruleSels} 条选择器段 / ${seenTok.size} 个类名）宿主全都渲染（豁免 ${Object.keys(J3_EXEMPT).length} 条 ≤ 基线 ${J3_CEILING}）`);
  }

  /* 门自己不是瞎的：夹具三种形态——假类名要抓到、真类名不许误报、@media 里套的选择器也要看见 */
  const fx = [
    ".zz-decoy-f { color: red; }",
    ".btn { color: blue; }",
    "@media (max-width: 10px) { .zz-decoy-g { color: red; } }",
    ".ok-hook { content: \".zz-decoy-h\"; }",
  ].join("\n");
  const fxTokens = new Set(selectorsOf(fx).flatMap(classTokens));
  const fxMissed = ["zz-decoy-f", "zz-decoy-g"].filter((t) => !fxTokens.has(t));
  const fxFalse = ["zz-decoy-h"].filter((t) => fxTokens.has(t));
  // 四段：顶层两条 + @media 里那条（@media 自己的名字段以 @ 开头，不算选择器）
  if (fxMissed.length || selectorsOf(fx).length !== 4) {
    console.error(`FAIL(J3): 选择器抽取对夹具漏检 ${fxMissed.join(", ") || ""}（段数 ${selectorsOf(fx).length}/4）—— 门是瞎的，上面那句"干净"不算数`);
    fails++;
  } else if (fxFalse.length) {
    console.error(`FAIL(J3): 把字符串里的 .${fxFalse.join(", ")} 当成选择器了 —— 会误报`);
    fails++;
  } else if (!fxTokens.has("btn")) {
    console.error("FAIL(J3): 夹具里 .btn 没被抽出来，抽取式坏了");
    fails++;
  }
}

/* ---- P131-D 门 K：内置 style 包必须锁在自己的主题上，且文件与装载表一一对上 ----
 *
 * 这条门管的是"内置主题的组件层"那条新通道（`src/styles/builtinStyles/<id>.css`）。
 * 三件事各自都会安静地坏掉，所以三件都判：
 *  ① **每条选择器必须以 `[data-theme="<本文件的 id>"]` 开头**——漏了这一条，
 *     "选流利蓝才有的那套控件样子"就会涂到别的主题上，而那是最难查的一类脏（只在特定组合下出现）；
 *  ② 磁盘上有的文件必须登记在装载表里：没装载 = 这文件安静地不生效，改它的人以为改了；
 *  ③ 装载表里登记的 id 必须有文件：否则运行时 `builtinStyleCss` 永远查不到东西。
 * 顺带：id 必须是真存在的主题（`themes/<id>.css`），别给一个不存在的主题写组件层。
 *
 * 与 `theme.css` 里那条"样式表不许出现 `[data-theme=` "的禁令不冲突：那条管的是**宿主样式表**
 * （宿主规则不该按主题分支写，否则主题一多就长成 if-else 山），这条管的是**数据包**
 * ——数据包的全部意义就是"只在某一枚主题下生效"。两句话都对，因为对象不同。
 */
{
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ");
  /** 取深度 0 的选择器段（`{` 之前那段）；@ 规则的名字段跳过 */
  function selectorsAtTopLevel(css) {
    const src = stripComments(css);
    const out = [];
    let buf = "";
    let depth = 0;
    for (const ch of src) {
      if (ch === "{") {
        if (depth === 0) {
          const s = buf.trim();
          if (s && !s.startsWith("@")) out.push(s);
        }
        depth++;
        buf = "";
        continue;
      }
      if (ch === "}") { depth = Math.max(0, depth - 1); buf = ""; continue; }
      if (ch === ";" && depth === 0) { buf = ""; continue; }
      buf += ch;
    }
    return out;
  }

  const themeIds = fs.readdirSync(THEME_DIR).filter((f) => f.endsWith(".css")).map((f) => f.replace(/\.css$/, ""));
  const loaderSrc = fs.readFileSync(path.join(STYLE_DIR, "builtinStyles.ts"), "utf8");
  const listed = [...(loaderSrc.match(/BUILTIN_STYLE_IDS[^=]*=\s*\[([^\]]*)\]/) || [, ""])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const styleFiles = fs.existsSync(BUILTIN_STYLE_DIR)
    ? fs.readdirSync(BUILTIN_STYLE_DIR).filter((f) => f.endsWith(".css")).map((f) => f.replace(/\.css$/, ""))
    : [];

  const errs = [];
  for (const id of styleFiles) {
    if (!themeIds.includes(id)) errs.push(`builtinStyles/${id}.css：没有这么一枚内置主题（themes/${id}.css 不存在）`);
    if (!listed.includes(id)) errs.push(`builtinStyles/${id}.css 没登记在 builtinStyles.ts 的 BUILTIN_STYLE_IDS 里 ⇒ 它永远不会被装载`);
    const css = fs.readFileSync(path.join(BUILTIN_STYLE_DIR, `${id}.css`), "utf8");
    const sels = selectorsAtTopLevel(css);
    if (!sels.length) errs.push(`builtinStyles/${id}.css：一条选择器都没有`);
    for (const sel of sels) {
      for (const part of sel.split(",").map((x) => x.trim())) {
        const want = `[data-theme="${id}"]`;
        if (!part.startsWith(want) && !part.startsWith(`:root${want}`)) {
          errs.push(`builtinStyles/${id}.css：选择器没锁在本主题上 → ${part.slice(0, 56)}`);
        }
      }
    }
  }
  for (const id of listed) {
    if (!styleFiles.includes(id)) errs.push(`装载表登记了 ${id}，但 builtinStyles/${id}.css 不存在`);
  }
  /** 反向钉"包不是空门"：漏前缀的写法必须被抓到，同时合法写法不许误报 */
  const fx = selectorsAtTopLevel(':root[data-theme="zz"] { --a: 1; }\n[data-theme="zz"] .btn { color: red; }\n.btn { color: blue; }\n@media (min-width: 1px) { .x { color: red; } }\n');
  const fxWouldFlag = fx.filter((s) => !s.startsWith('[data-theme="zz"]') && !s.startsWith(':root[data-theme="zz"]'));
  if (!fxWouldFlag.includes(".btn")) {
    console.error("FAIL(K): 抽取式对夹具漏了没加前缀的选择器 —— 这条门是瞎的，下面的 OK 不算数");
    fails++;
  } else if (fx.length !== 3) {
    console.error(`FAIL(K): 夹具应当抽出 3 段（@media 的名字段跳过），实得 ${fx.length} —— 抽取式与格式脱钩了`);
    fails++;
  } else if (errs.length) {
    for (const e of errs) console.error(`FAIL(K): ${e}`);
    fails++;
  } else {
    console.log(`OK(K): ${styleFiles.length} 份内置 style 包（${listed.length} 条登记）锁在自己的 [data-theme] 上，文件与装载表一一对上`);
  }
}

console.log(fails === 0 ? "OK: 样式契约通过" : `FAIL: ${fails} 类问题`);
process.exit(fails === 0 ? 0 : 1);
