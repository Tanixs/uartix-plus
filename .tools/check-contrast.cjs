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

/** 必查的色键（内置与包共用这一张表） */
const NEED_KEYS = [
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
  // P115-F22：危险钮按压态文字色（.tb-close:hover），从 #fff 字面量提为令牌
  "--on-danger",
  "--k-keypad",
  "--k-keypad-ink",
  ...K_TOKENS,
];

/**
 * 一张判据表，两处用（P132-A2）：内置主题文件与**上架主题包的 token 表**。
 *
 * 为什么不另写一份：判据有两份就会漂，而漂了的那份照样打印 OK。包这一层此前是 12 道门的
 * 盲区——「`--accent` 当文字压灰底跌破 AA」那一类问题（P130-A 是靠 1421 渲染层抽样才抓到的），
 * 换成一支插件包带进来时没有任何一处会红。
 *
 * @param {Record<string, string>} vars 已叠好基线的色键表（只认 #hex，认不出的不参与）
 */
function judgePalette(vars) {
  const missing = NEED_KEYS.filter((k) => !vars[k]);
  if (missing.length) return { missing, worst: [], checks: 0, surface: "", surfaceBad: true };
  const checks = [
    ["text/bg", vars["--text"], vars["--bg"], 4.5],
    ["text/panel", vars["--text"], vars["--bg-panel"], 4.5],
    ["text/inset", vars["--text"], vars["--bg-inset"], 4.5],
    ["text/titlebar", vars["--text"], vars["--bg-titlebar"], 4.5],
    // P132-D：`--text-dim` 从 3.0 提到 4.5，并补上凹档与壳档两处。
    // 原来这里只按 3.0 管 bg/panel 两档，而运行期判据（`renderAudit.needFor`）对 13px 正文一律要 4.5
    // ——**两把尺打架**，于是审计在真浏览器里量出 3.95~4.11 一片（`.empty-hint`、页签标题、状态胶囊、
    // 信息栏计数…全是 `--text-dim`），静态门却一路绿灯。提到同一把尺之后这一族不用浏览器也能守住。
    // 代价说清楚：四枚主题的 `--text-dim` 往 `--text` 方向压了 5~15%（amber/begonia 15%，matcha/ocean 5%），
    // 灰字与正字的层级差变小——这是可读性与层次感的取舍，本批选了可读性。
    ["dim/bg", vars["--text-dim"], vars["--bg"], 4.5],
    ["dim/panel", vars["--text-dim"], vars["--bg-panel"], 4.5],
    ["dim/inset", vars["--text-dim"], vars["--bg-inset"], 4.5],
    ["dim/titlebar", vars["--text-dim"], vars["--bg-titlebar"], 4.5],
    // P75：主按钮文字/底 —— 曾因 --on-accent 缺失静默回退 #fff，亮色主题逼近阈值，收紧到 4.5
    ["on-accent/accent(btn)", vars["--on-accent"], vars["--accent"], 4.5],
    // P75：负向校验——灰字压主题色底（.plot-bar .btn.sm 事故形态）必须不合格，
    // 防止将来又出现「覆盖了 primary 文字色却没覆盖背景」的回归
    ["dim-on-accent(must<4.5)", vars["--text-dim"], vars["--accent"], -4.5],
    ["danger/panel", vars["--danger"], vars["--bg-panel"], 3.0],
    ["accent/panel(text)", vars["--accent"], vars["--bg-panel"], 3.0],
    // P75：只读/受限横幅文字色（--warn-fg 此前未定义静默回退 accent）
    ["warn-fg/panel", vars["--warn-fg"], vars["--bg-panel"], 4.5],
    // P115-F22：危险钮按压态文字压 danger 底（原 #fff 字面量无人验过）
    ["on-danger/danger", vars["--on-danger"], vars["--danger"], 3.0],
    // P115-F22：键盘遥控按键的墨色压键底（固定值令牌，见 theme.css :root）
    ["keypad-ink/keypad", vars["--k-keypad-ink"], vars["--k-keypad"], 4.5],
    // 块类型语义色：作为小字胶囊文字与 3px 色条使用 → 面板底上 4.5 起
    ...K_TOKENS.map((k) => [`${k}/panel`, vars[k], vars["--bg-panel"], 4.5]),
  ];
  const worst = [];
  for (const [name, fg, bg, min] of checks) {
    const r = ratio(fg, bg);
    // min < 0 表示「必须低于 |min|」的负向校验（如灰字压主题色底必须不可读）
    const ok = min < 0 ? r < -min : r >= min;
    if (!ok) worst.push(`${name}=${r.toFixed(2)}!!`);
  }

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
  const surface = seqOk && !surfBad.length
    ? `surface ${surf.map(([n, v]) => `${n}=${v.toFixed(1)}`).join(" ")}`
    : `SURFACE ${seqOk ? "" : `序错(${sorted}) `}${surfBad.join(" ")}`;
  return { missing, worst, checks: checks.length, surface, surfaceBad: !seqOk || surfBad.length > 0 };
}

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  // 主题文件覆盖基线：语义色只写一次，主题各自给值
  const j = judgePalette({ ...baseVars, ...hexVars(src) });
  if (j.missing.length) {
    console.log(`FAIL ${f}: missing color vars: ${j.missing.join(", ")}`);
    fails++;
    continue;
  }
  fails += j.worst.length + (j.surfaceBad ? 1 : 0);
  // 只打印失败项，避免 8×17 列把终端刷满；全绿时给一行汇总
  rows.push([f.replace(".css", ""), j.worst.length ? j.worst.join("  ") : `ok (${j.checks} checks)`, j.surface].join("  "));
}
console.log(rows.join("\n"));

/* ---- P132-A2：同一张判据也过一遍**上架主题包**的 token 表 ----
   包里的 vars 是抄本（`market/pkg/<名>/manifest.json` 内联进上架产物），运行时它就是"在画的那一枚"，
   所以它和内置主题文件是**同一个角色**，没有理由只查一边。
   差量包（只写几个键）判的不是"它自己写了什么"，而是**用户实际拿到的那一套**：运行时缺的键按明暗
   归属从内置垫一张表（`builtinThemes.BASELINE_VARS` 就是 dark.css / light.css），所以这里叠同一张表——
   查的对象必须与合成的结果是同一个东西，否则查的是一个不存在的配色。
   只认 #hex 那部分键（color-mix(...) 那类派生值交给下面 P110-A 那条阶梯去算）。 */
{
  const hexOf = (name) => hexVars(fs.readFileSync(path.join(dir, name), "utf8"));
  const SCHEME_BASE = { dark: { ...baseVars, ...hexOf("dark.css") }, light: { ...baseVars, ...hexOf("light.css") } };
  /** 明暗归属：包自己声明优先；没声明就按 --bg 的亮度算（与运行时的推导同一条） */
  const schemeOf = (art, hexOnly) =>
    art.scheme === "dark" || art.scheme === "light" ? art.scheme : lstar(hexOnly["--bg"] ?? SCHEME_BASE.dark["--bg"]) >= 50 ? "light" : "dark";
  const pkgDir = path.join(__dirname, "..", "public", "market", "pkg");
  const lines = [];
  let pkgChecked = 0;
  let pkgBad = 0;
  if (fs.existsSync(pkgDir)) {
    for (const f of fs.readdirSync(pkgDir).filter((x) => x.endsWith(".uartix.json")).sort()) {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, f), "utf8"));
      for (const [artName, art] of Object.entries(manifest.artifacts ?? {})) {
        if (!art || art.kind !== "theme" || !art.vars) continue;
        pkgChecked++;
        const hexOnly = {};
        for (const [k, v] of Object.entries(art.vars)) if (/^#[0-9a-fA-F]{3,8}$/.test(String(v))) hexOnly[k] = String(v);
        const j = judgePalette({ ...SCHEME_BASE[schemeOf(art, hexOnly)], ...hexOnly });
        const name = `${f.replace(".uartix.json", "")} · ${artName}(${schemeOf(art, hexOnly)})`;
        const problems = [
          ...(j.missing.length ? [`缺色键 ${j.missing.join("、")}`] : []),
          ...j.worst,
          ...(j.surfaceBad ? [j.surface] : []),
        ];
        if (problems.length) {
          pkgBad++;
          fails += problems.length;
          lines.push(`FAIL ${name}: ${problems.join("  ")}`);
        } else {
          lines.push(`ok   ${name}: ${j.checks} checks · ${j.surface.replace("surface ", "")} · 包内 ${Object.keys(art.vars).length} 键（其中 ${Object.keys(hexOnly).length} 键是 #hex，其余是派生表达式）`);
        }
      }
    }
  }
  console.log("\n-- P132-A2 上架主题包的 token 表（与内置同一张判据，不是第二份） --");
  console.log(lines.length ? lines.join("\n") : "（货架上一枚主题包都没有：这一条什么都没查）");
  if (!pkgChecked) {
    console.log("note: 没有主题包可查 —— 别把这条当成通过");
  } else if (!pkgBad) {
    console.log(`OK: ${pkgChecked} 枚上架主题包的 token 表过同一张对比度与档序判据`);
  } else {
    console.log(`FAIL: ${pkgBad} 枚上架主题包的 token 表不合格（包里的配色与内置是同一个角色，同一张表）`);
  }
}

/* ---- P110-A：表面阶梯（把这份门禁从"只认 #hex"扩到能算 rgb()/rgba()/color-mix(in srgb)） ----
   判据的**真相**在 `src/styles/themeCore.ts` 的 `judgeSurfaceLadder()`——运行时撤回坏值用的就是它。
   `.cjs` 引不了 TS，所以这里按**同一组数字**复刻，数字是从 themeCore.ts 里抠出来的（:42 那种
   从源码里解析 APPEARANCE_TOKENS 的既有做法），这份文件里不写第二份常量。
   改判据时两处一起改，下面打印的内置实测阶梯会跟着动，那就是它的回归证据。

   为什么门禁还要再判一遍（运行时不是已经守住了吗）：运行时守卫只管 **AI 覆盖层**那一条写入路径；
   仓库里这批内置主题文件是编译期资产，走的是 `?raw` 解析 → 合成器，谁都能手改一行
   `--raise-1: #fff` 把它弄坏而没有任何一处会响。 */
const coreSrc = fs.readFileSync(path.join(__dirname, "..", "src", "styles", "themeCore.ts"), "utf8");
function constFromCore(name) {
  const m = new RegExp(`export const ${name} = ([0-9.]+);`).exec(coreSrc);
  if (!m) {
    console.log(`FAIL: cannot parse ${name} from themeCore.ts（阶梯判据的数字必须只有一个来源）`);
    return NaN;
  }
  return Number(m[1]);
}
const RAISE_MAX_DELTA_L = constFromCore("RAISE_MAX_DELTA_L");
const RAISE_MIN_DELTA_L = constFromCore("RAISE_MIN_DELTA_L");

/** CSS 源码里的**原始值**表（不再只挑 #hex）：按选择器收集 `--x: value;` */
function rawVarBlocks(src, selector) {
  const out = {};
  const needle = selector + " {";
  let at = -1;
  while ((at = src.indexOf(needle, at + 1)) >= 0) {
    const open = src.indexOf("{", at);
    const close = src.indexOf("}", open);
    if (close < 0) continue;
    for (const m of src.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[m[1]] = m[2].trim();
    }
  }
  return out;
}
const themeCssSrc = fs.readFileSync(baseCss, "utf8");
const rootDarkVars = rawVarBlocks(themeCssSrc, ":root");
const rootLightVars = rawVarBlocks(themeCssSrc, ':root[data-scheme="light"]');

/** 颜色 → {r,g,b,a}（a 取 0~1）。认不出返回 null：**不猜颜色** */
function toRgba(v, env, depth = 0) {
  if (depth > 8 || !v) return null;
  const s = String(v).trim();
  if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) {
    const h = m[1].split("").map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)(%?)[,\s]+([\d.]+)(%?)[,\s]+([\d.]+)(%?)(?:[,/]\s*([\d.]+)(%?)?)?\s*\)$/i.exec(s);
  if (m) {
    const chan = (v, pct) => (pct === "%" ? (Number(v) * 255) / 100 : Number(v));
    let a = 1;
    if (m[7] !== undefined) a = m[8] === "%" ? Number(m[7]) / 100 : Number(m[7]);
    return { r: chan(m[1], m[2]), g: chan(m[3], m[4]), b: chan(m[5], m[6]), a };
  }
  m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(s);
  if (m) {
    const inner = env && env[m[1]];
    const byName = inner ? toRgba(inner, env, depth + 1) : null;
    return byName ?? (m[2] ? toRgba(m[2], env, depth + 1) : null);
  }
  m = /^color-mix\(\s*in\s+srgb\s*,\s*([\s\S]+)\)$/i.exec(s);
  if (m) {
    const parts = [];
    let d = 0, cur = "";
    for (const ch of m[1]) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur);
    if (parts.length < 2) return null;
    const split = (tok) => {
      const mm = /^(.*?)\s+(-?[\d.]+)%$/.exec(tok.trim());
      return mm ? [mm[1], Number(mm[2])] : [tok.trim(), null];
    };
    const [ta, ra] = split(parts[0]);
    const [tb, rb] = split(parts[1]);
    const A = toRgba(ta, env, depth + 1);
    const B = toRgba(tb, env, depth + 1);
    if (!A || !B) return null;
    const f = ra !== null ? ra : rb !== null ? 100 - rb : null;
    if (f === null) return null;
    const p = f / 100;
    return { r: A.r * p + B.r * (1 - p), g: A.g * p + B.g * (1 - p), b: A.b * p + B.b * (1 - p), a: A.a * p + B.a * (1 - p) };
  }
  return null;
}
function lstarRgb(c) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const y = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

{
  const PROBE = ["--bg", "--bg-panel", "--bg-inset", "--bg-titlebar", "--raise-1", "--raise-2", "--text"];
  let unresolved = 0;
  let ladderFails = 0;
  const lines = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const scheme = (/color-scheme:\s*(\w+)/.exec(src) || [])[1] || "dark";
    const own = rawVarBlocks(src, `:root[data-theme="${f.replace(".css", "")}"]`);
    // 层叠顺序与运行时一致：theme.css 的派生块 → 亮色覆写 → 主题文件自己（inline 变量压过样式表）
    const env = { ...rootDarkVars, ...(scheme === "light" ? rootLightVars : {}), ...own };
    const c = {};
    for (const k of PROBE) {
      c[k] = toRgba(env[k], env);
      if (env[k] && !c[k]) unresolved++;
    }
    const name = f.replace(".css", "");
    const L = (k) => (c[k] ? lstarRgb(c[k]) : NaN);
    const bad = [];
    for (const k of ["--raise-1", "--raise-2"]) {
      if (!c[k] || !c["--bg-panel"] || !c["--text"]) continue;
      if (c[k].a < 0.999) bad.push(`${k} 半透明(alpha=${c[k].a.toFixed(2)})`);
      const want = Math.sign(L("--text") - L("--bg-panel"));
      const d = L(k) - L("--bg-panel");
      // 与 themeCore 同一顺序：先"根本没抬"，再方向，再幅度（Δ=0 的符号是 0，比方向会误判成反向）
      if (Math.abs(d) < RAISE_MIN_DELTA_L) bad.push(`${k} 与面板同档(ΔL*=${d.toFixed(1)})`);
      else if (want !== 0 && Math.sign(d) !== want) bad.push(`${k} 方向反了(ΔL*=${d.toFixed(1)}, 应为 ${want > 0 ? "往亮" : "往暗"})`);
      else if (Math.abs(d) > RAISE_MAX_DELTA_L) bad.push(`${k} 抬过头(ΔL*=${d.toFixed(1)} > ${RAISE_MAX_DELTA_L})`);
    }
    for (const k of ["--bg", "--bg-panel", "--bg-inset", "--bg-titlebar"]) {
      if (c[k] && c[k].a < 0.999) bad.push(`${k} 表面含 alpha(${c[k].a.toFixed(2)})`);
    }
    if (bad.length) ladderFails++;
    lines.push(
      `${name.padEnd(8)} ${scheme.padEnd(5)} inset=${L("--bg-inset").toFixed(1)} shell=${L("--bg-titlebar").toFixed(1)} canvas=${L("--bg").toFixed(1)} panel=${L("--bg-panel").toFixed(1)} raise1=${L("--raise-1").toFixed(1)}(${(L("--raise-1") - L("--bg-panel")).toFixed(1)}) raise2=${L("--raise-2").toFixed(1)}(${(L("--raise-2") - L("--bg-panel")).toFixed(1)}) ${bad.length ? "FAIL " + bad.join("; ") : "ok"}`,
    );
  }
  console.log("\n-- P110-A 表面阶梯（L*，派生档按声明的 scheme 判） --");
  console.log(lines.join("\n"));
  if (unresolved) console.log(`note: ${unresolved} 个值这份门禁算不出（不是 CSS 引擎，认不出的形式一律跳过不猜）`);
  if (ladderFails) {
    console.log(`FAIL: ${ladderFails} 枚内置主题的派生表面阶梯不合格`);
    fails += ladderFails;
  } else {
    console.log("OK: 内置主题的表面阶梯与抬升方向全部合格");
  }
}

/* ---- P132-D：`--accent-text` 这条派生必须真的够 4.5 ----
   `--accent` 当文字用是审计量出来的第二大族（亮色系里普遍只有 3.25~4.08：amber 3.25、
   matcha 3.35、begonia 3.70）。修法不是逐枚主题手压品牌色，而是 theme.css 里派生一档
   `color-mix(in srgb, var(--accent) 70%, var(--text))`。
   派生这东西一旦没人算，就会变成"写着好看、算着不对"——所以这里按**运行时同一张层叠表**
   把它复算一遍，压在四档表面与 `--accent-soft` 胶囊上都得 ≥4.5。
   这条同时管两件事：① 声明还在（删掉它，244 处之外的 `var(--accent-text)` 会静默失效）；
   ② 混式没被改松（把 70% 调到 90% 当场红）。 */
{
  const hexOf = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const DECL = rootDarkVars["--accent-text"];
  if (!DECL) {
    console.log("FAIL: theme.css 的 :root 里没有 --accent-text（它被样式表引用，删掉等于静默失效）");
    fails++;
  } else {
    let bad = 0;
    const softBad = [];
    const lines = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const scheme = (/color-scheme:\s*(\w+)/.exec(src) || [])[1] || "dark";
      const own = rawVarBlocks(src, `:root[data-theme="${f.replace(".css", "")}"]`);
      const env = { ...rootDarkVars, ...(scheme === "light" ? rootLightVars : {}), ...own };
      const at = toRgba(DECL, env);
      const name = f.replace(".css", "");
      if (!at) {
        lines.push(`${name.padEnd(8)} FAIL 这份混式本门算不出（不猜）`);
        bad++;
        continue;
      }
      const soft = toRgba(env["--accent-soft"], env);
      const panel = toRgba(env["--bg-panel"], env);
      const chips = [];
      for (const k of ["--bg", "--bg-panel", "--bg-inset", "--bg-titlebar"]) {
        const s = toRgba(env[k], env);
        if (s && s.a > 0.999) chips.push([k, hexOf(s)]);
      }
      // 胶囊：accent-soft 是半透明，先合成到面板上再谈比值
      if (soft && panel && soft.a < 0.999) {
        const mix = (i) => soft.a * soft[["r", "g", "b"][i]] + (1 - soft.a) * panel[["r", "g", "b"][i]];
        chips.push(["accent-soft", hexOf({ r: mix(0), g: mix(1), b: mix(2) })]);
      }
      const surfaces = chips.filter(([k]) => k !== "accent-soft");
      const rs = chips.map(([k, s]) => [k, ratio(hexOf(at), s)]);
      /* P132-E：`--text-faint` 的注释写着"第三级文字"，值却是个装饰档（掺 38% 洗到 2.23~2.94）。
         给它一条自己的地板 3.0（非文本/大字那一档）——**不吃上面那条 4.5**，
         因为这一档的用途就是"比 dim 更轻"，要 4.5 就等于取消这一档。
         正文级小字该用哪一档由审计说：账点到谁，谁升 `--text-dim`。 */
      const faint = toRgba(rootDarkVars["--text-faint"], env);
      const fw = faint ? Math.min(...surfaces.map(([, s]) => ratio(hexOf(faint), s))) : 0;
      if (!faint) softBad.push(`${name}: --text-faint 这份混式本门算不出（不猜）`);
      else if (fw < 3.0) softBad.push(`${name}: --text-faint 压表面只有 ${fw.toFixed(2)}，地板是 3.0`);
      /* 白字压 danger 实底那一档（P132-D 另起 `--danger-fill`，比 --danger 深 12%） */
      const df = toRgba(rootDarkVars["--danger-fill"], env);
      const ink = toRgba(env["--on-danger"] ?? rootDarkVars["--on-danger"], env);
      if (!df) rs.push(["danger-fill 算不出", 0]);
      else if (!ink) rs.push(["on-danger 算不出", 0]);
      else rs.push(["白字/danger-fill", ratio(hexOf(ink), hexOf(df))]);
      /* danger 当文字那一档（`.fc-sync-warn`、描边型 danger 钮）：四档表面 + 12% 红底胶囊 */
      const dt = toRgba(rootDarkVars["--danger-text"], env);
      if (!dt) rs.push(["danger-text 算不出", 0]);
      else {
        const dRaw = toRgba(env["--danger"], env);
        const panelBg = toRgba(env["--bg-panel"], env);
        if (dRaw && panelBg && dRaw.a > 0.999) {
          const t = 0.12;
          const chip = (i) => t * dRaw[["r", "g", "b"][i]] + (1 - t) * panelBg[["r", "g", "b"][i]];
          rs.push([
            "danger-text/表面",
            Math.min(
              ...chips.filter(([k]) => k !== "accent-soft").map(([, s]) => ratio(hexOf(dt), s)),
              ratio(hexOf(dt), hexOf({ r: chip(0), g: chip(1), b: chip(2) })),
            ),
          ]);
        } else rs.push(["danger-text/表面", 0]);
      }
      const worst = Math.min(...rs.map(([, r]) => r));
      const ok = worst >= 4.5;
      if (!ok) bad++;
      lines.push(
        `${name.padEnd(8)} ${scheme.padEnd(5)} accent-text=${hexOf(at)} ` +
          rs.map(([k, r]) => `${k.replace("--", "")}=${r.toFixed(2)}`).join(" ") +
          (ok ? " ok" : " FAIL"),
      );
    }
    console.log("\n-- P132-D --accent-text 派生复算（accent 当文字用的那一档，四档表面 + soft 胶囊都要 ≥4.5） --");
    console.log(lines.join("\n"));
    for (const s of softBad) console.log(`FAIL ${s}`);
    if (softBad.length) fails += softBad.length;
    if (bad) {
      console.log(`FAIL: ${bad} 枚主题的 --accent-text 不够 4.5（混式或品牌色改过，得重新算）`);
      fails += bad;
    } else {
      console.log(`OK: ${files.length} 枚内置主题的 --accent-text 全部 ≥4.5`);
    }
  }
}

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
