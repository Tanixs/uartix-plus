const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "src", "styles", "themes");
const baseCss = path.join(__dirname, "..", "src", "styles", "theme.css");

/** 语义色令牌（P74c C4）：暗色系默认值写在 theme.css 的 :root，亮色主题在各自文件覆写 */
const K_TOKENS = [
  "--k-send",
  "--k-wait",
  "--k-frame",
  "--k-assert",
  "--k-note",
  "--k-logic",
  "--k-group",
  "--k-warn-line",
];

function lum(hex) {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const v = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const [r, g, b] = v.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const l1 = Math.max(lum(a), lum(b));
  const l2 = Math.min(lum(a), lum(b));
  return (l1 + 0.05) / (l2 + 0.05);
}
/** CIE L*（0~100，感知均匀）。表面档差用它，文字对比度仍用上面的 ratio()。 */
function lstar(hex) {
  const y = lum(hex);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** 抓取源码里所有 `--name: #hex;` 声明（只认十六进制，便于对比度计算） */
function hexVars(src) {
  const out = {};
  for (const m of src.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const val = m[2].trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(val)) out[m[1]] = val;
  }
  return out;
}

/** theme.css 里 :root 块是「全主题基线」（字体 + 语义色默认值） */
function baseRootVars() {
  const src = fs.readFileSync(baseCss, "utf8");
  const out = {};
  for (const m of src.matchAll(/:root\s*\{([\s\S]*?)\}/g)) Object.assign(out, hexVars(m[1]));
  return out;
}
const baseVars = baseRootVars();

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".css"));
let fails = 0;
const rows = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  // 主题文件覆盖基线：语义色只写一次，主题各自给值
  const vars = { ...baseVars, ...hexVars(src) };
  const need = [
    "--bg",
    "--bg-panel",
    "--bg-inset",
    "--bg-titlebar",
    "--text",
    "--text-dim",
    "--accent",
    "--on-accent",
    "--warn-fg",
    "--danger",
    ...K_TOKENS,
  ];
  const missing = need.filter((k) => !vars[k]);
  if (missing.length) {
    console.log(`FAIL ${f}: missing color vars: ${missing.join(", ")}`);
    fails++;
    continue;
  }
  const checks = [
    ["text/bg", vars["--text"], vars["--bg"], 4.5],
    ["text/panel", vars["--text"], vars["--bg-panel"], 4.5],
    ["text/inset", vars["--text"], vars["--bg-inset"], 4.5],
    ["text/titlebar", vars["--text"], vars["--bg-titlebar"], 4.5],
    ["dim/bg", vars["--text-dim"], vars["--bg"], 3.0],
    ["dim/panel", vars["--text-dim"], vars["--bg-panel"], 3.0],
    // P75：主按钮文字/底 —— 曾因 --on-accent 缺失静默回退 #fff，亮色主题逼近阈值，收紧到 4.5
    ["on-accent/accent(btn)", vars["--on-accent"], vars["--accent"], 4.5],
    // P75：负向校验——灰字压主题色底（.plot-bar .btn.sm 事故形态）必须不合格，
    // 防止将来又出现「覆盖了 primary 文字色却没覆盖背景」的回归
    ["dim-on-accent(must<4.5)", vars["--text-dim"], vars["--accent"], -4.5],
    ["danger/panel", vars["--danger"], vars["--bg-panel"], 3.0],
    ["accent/panel(text)", vars["--accent"], vars["--bg-panel"], 3.0],
    // P75：只读/受限横幅文字色（--warn-fg 此前未定义静默回退 accent）
    ["warn-fg/panel", vars["--warn-fg"], vars["--bg-panel"], 4.5],
    // 块类型语义色：作为小字胶囊文字与 3px 色条使用 → 面板底上 4.5 起
    ...K_TOKENS.map((k) => [`${k}/panel`, vars[k], vars["--bg-panel"], 4.5]),
  ];
  const line = [f.replace(".css", "")];
  const worst = [];
  for (const [name, fg, bg, min] of checks) {
    const r = ratio(fg, bg);
    // min < 0 表示「必须低于 |min|」的负向校验（如灰字压主题色底必须不可读）
    const ok = min < 0 ? r < -min : r >= min;
    if (!ok) {
      fails++;
      worst.push(`${name}=${r.toFixed(2)}!!`);
    }
  }
  // 只打印失败项，避免 8×17 列把终端刷满；全绿时给一行汇总
  line.push(worst.length ? worst.join("  ") : `ok (${checks.length} checks)`);

  /* ---- P104-B2 I 门：表面档序与档差（用 CIE L*，不用 WCAG 比） ----
     P104 的外壳（标题行 / 活动导轨 / 信息栏）统一压在「壳档」上，靠档差读出一条外骨骼。
     此前没有任何地方算过这件事，于是 dark/glaze/navy 三套的壳比画布**还亮** 0.8~2.0 L*——
     外壳向前浮而不是向后退，B5 做出来就是三条没有边界的灰带。

     为什么是 L* 而不是对比度比：对比度比为文字可读性设计，在近黑区饱和。
     第一版我拿 1.05/1.06 的比当地板，解算器把 dark 的凹档直接算成了 #000000 纯黑——
     指标错了会逼出错误的修法。表面档差要用感知均匀的 L*。
     地板只卡 P104 真正依赖的两条：壳要退得下画布、面板要浮得起。 */
  const tiers = {
    inset: vars["--bg-inset"],
    shell: vars["--bg-titlebar"],
    canvas: vars["--bg"],
    panel: vars["--bg-panel"],
  };
  const sorted = Object.entries(tiers)
    .sort((a, b) => lstar(a[1]) - lstar(b[1]))
    .map(([k]) => k)
    .join("<");
  const seqOk = sorted === "inset<shell<canvas<panel";
  const surf = [
    ["壳→画布", lstar(tiers.canvas) - lstar(tiers.shell), 1.0],
    ["画布→面板", lstar(tiers.panel) - lstar(tiers.canvas), 1.5],
  ];
  const surfBad = surf.filter(([, v, min]) => v < min).map(([n, v, min]) => `${n}=${v.toFixed(1)}<${min}`);
  if (!seqOk || surfBad.length) {
    fails++;
    line.push(`SURFACE ${seqOk ? "" : `序错(${sorted}) `}${surfBad.join(" ")}`);
  } else {
    line.push(`surface ${surf.map(([n, v]) => `${n}=${v.toFixed(1)}`).join(" ")}`);
  }
  rows.push(line.join("  "));
}
console.log(rows.join("\n"));

/* ---- P75 静态扫描：主题色背景必配文字色 ----
   事故形态（.plot-bar .btn.sm）：规则覆盖了背景（--accent 底）却没同时给 color，
   文字色落到继承的灰字上 → 主题色底 + 灰字（实测 1.11:1）。
   这里扫描全部样式源码：任何规则体里出现 --accent 实底背景但整条规则无 color 声明 → FAIL。
   豁免（无文字承载，纯装饰/几何指示）：
   - ::before/::after 伪元素、fill/caret/dot/knob/knob/line/cursor/bar 类指示元素
   - 注释含 `contrast-exempt` 的规则（人工豁免口子） */
const DECOR_RE =
  /(::before|::after|-dot|-knob|-line-|-line$|-cursor|-fill|-caret|-bar$|-trigger$|-ghost$|-grow|-splitter|\.on\b.*-sw-knob)/;
function scanAccentBgNoColor() {
  const roots = [
    path.join(__dirname, "..", "src", "styles"),
    path.join(__dirname, "..", "src", "features"),
    path.join(__dirname, "..", "src", "shell"),
  ];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|tsx|ts)$/.test(e.name)) files.push(p);
    }
  };
  roots.forEach(walk);
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/[^{}]+\{[^{}]*\}/g)) {
      const rule = m[0];
      if (rule.includes("contrast-exempt")) continue;
      // 只盯「不透明 accent 实底」：color-mix 的 3%~24% 软底与面板底亮度接近，
      // 继承文字色可读，不属于事故形态；纯 var(--accent) 实底才必须显式配 color。
      const hasAccentBg = /background(?:-color)?\s*:\s*var\(\s*--accent\s*\)/.test(rule);
      if (!hasAccentBg) continue;
      // 纯装饰元素（点/线/填充条/旋钮/光标等）不承载文字 → 豁免
      const sel = rule.split("{")[0].trim();
      if (DECOR_RE.test(sel)) continue;
      const hasColor = /(^|[^-])color\s*:/.test(rule);
      if (!hasColor) {
        problems.push(`${path.relative(process.cwd(), f)} :: ${sel.slice(0, 90)}`);
      }
    }
  }
  return problems;
}

const accentProblems = scanAccentBgNoColor();
if (accentProblems.length) {
  console.log(`\nFAIL: ${accentProblems.length} rule(s) set an accent background without an explicit color:`);
  for (const p of accentProblems) console.log(`  - ${p}`);
  fails += accentProblems.length;
} else {
  console.log("OK: accent backgrounds all pair with a color declaration");
}

/* ---- P88b-4：外观覆盖层白名单 token 齐全性 ----
   Agent 外观工具只能覆盖白名单 token（P99b-N5 起住在 `src/styles/themeCore.ts` 的 APPEARANCE_TOKENS，
   因为它现在同时管着 AI 覆盖层、插件主题产物与样式表引用三件事）；
   每个白名单 token 必须在「theme.css :root 基线 ∪ 8 主题文件」中有定义，
   否则覆盖后有键无值（覆盖层不做完整性校验，依赖内置值兜底——缺失即破功）。 */
function cssVarKeys(src) {
  const out = new Set();
  for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]);
  return out;
}
function appearanceOverlayTokens() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "styles", "themeCore.ts"), "utf8");
  const m = /APPEARANCE_TOKENS = \[([\s\S]*?)\] as const/.exec(src);
  return m ? [...m[1].matchAll(/"(--[\w-]+)"/g)].map((x) => x[1]) : [];
}
const overlayTokens = appearanceOverlayTokens();
if (!overlayTokens.length) {
  console.log("FAIL: cannot parse APPEARANCE_TOKENS from appearanceStore.ts");
  fails++;
} else {
  const defined = cssVarKeys(fs.readFileSync(baseCss, "utf8"));
  for (const f of files) cssVarKeys(fs.readFileSync(path.join(dir, f), "utf8")).forEach((k) => defined.add(k));
  const missOverlay = overlayTokens.filter((k) => !defined.has(k));
  if (missOverlay.length) {
    console.log(`FAIL: appearance overlay tokens missing from themes: ${missOverlay.join(", ")}`);
    fails++;
  } else {
    console.log(`OK: ${overlayTokens.length} appearance overlay tokens all defined across themes`);
  }
  /* iframe 主题桥一致性：广播采集键（extRuntime.THEME_VAR_KEYS）必须是覆盖白名单子集，
     否则 Agent 改了某个广播键、iframe 收到的却是旧值（跨主界面/iframe 不一致）。 */
  const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "features", "ai", "extRuntime.ts"), "utf8");
  const tvk = /THEME_VAR_KEYS = \[([\s\S]*?)\];/.exec(extSrc);
  const themeVarKeys = tvk ? [...tvk[1].matchAll(/"(--[\w-]+)"/g)].map((x) => x[1]) : [];
  if (!themeVarKeys.length) {
    console.log("FAIL: cannot parse THEME_VAR_KEYS from extRuntime.ts");
    fails++;
  } else {
    const notCovered = themeVarKeys.filter((k) => !overlayTokens.includes(k));
    if (notCovered.length) {
      console.log(`FAIL: iframe broadcast keys not coverable by appearance overlay: ${notCovered.join(", ")}`);
      fails++;
    } else {
      console.log(`OK: all ${themeVarKeys.length} iframe theme-bridge keys are overlay-coverable`);
    }
  }
}

console.log(fails === 0 ? "OK: all theme contrast checks passed" : `FAIL: ${fails} problem(s)`);
process.exit(fails === 0 ? 0 : 1);
