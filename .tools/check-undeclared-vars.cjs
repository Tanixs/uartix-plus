/*
 * P99b-N5（详设 R5）：样式里不许引用**没定义过**的自定义属性。
 *
 * 为什么现在加这道门（真账两笔，都在本批被发现）：
 *  - 两份市场主题示例写了 `--panel` / `--accent-contrast`，而应用里根本没有这两个键
 *    （叫 `--bg-panel` / `--on-accent`）——旧的产物校验只查"以 -- 开头"，于是那份主题
 *    实际只落地 4 项，界面上没有任何一处说出来；
 *  - `theme.css` 里 `.mkt-img`/`.mkt-big-img` 引用 `var(--panel)`，同样是未定义键。
 * theme.css 第 86 行早就为同一个坑记过一次账（`--warn-fg` 未定义时静默回退 accent，
 * 失去"警告"语义）。**同一条坑摔第二次，说明靠人记是记不住的。**
 *
 * 口径：声明 = 任何一份主题文件里的 `--x:`、theme.css 里的 `:root` 声明、
 * 或 `appearanceStore.ts` 的 `APPEARANCE_TOKENS` 白名单（AI/插件可写入的那批）。
 * 组件内联 style 里的 `var(--x, 兜底)` 有兜底值 ⇒ 不算悬空引用（放行）。
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const STYLE_DIR = path.join(root, "src", "styles");
const THEME_DIR = path.join(STYLE_DIR, "themes");
const TOKENS_FILE = path.join(root, "src", "styles", "themeCore.ts");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

/** 声明侧：主题文件 + theme.css 里的 `--x:` */
const declared = new Set();
const themeFiles = fs.readdirSync(THEME_DIR).filter((f) => f.endsWith(".css"));
for (const f of themeFiles) {
  const src = fs.readFileSync(path.join(THEME_DIR, f), "utf8");
  for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
}
const themeCss = fs.readFileSync(path.join(STYLE_DIR, "theme.css"), "utf8");
for (const m of themeCss.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
// APPEARANCE_TOKENS 白名单（这些由合成器/插件写入，源码里不会有声明）
const tokensSrc = fs.readFileSync(TOKENS_FILE, "utf8");
const block = /APPEARANCE_TOKENS\s*=\s*\[([\s\S]*?)\]/.exec(tokensSrc);
if (!block) {
  console.error("[check:vars] 读不到 APPEARANCE_TOKENS 白名单，这道门自己失效了");
  process.exit(1);
}
for (const m of block[1].matchAll(/"(--[\w-]+)"/g)) declared.add(m[1]);

/** 引用侧：只扫声明文件（组件里的内联 var() 与 var(x, 兜底) 不在本门范围内） */
const refs = new Map();
for (const file of [path.join(STYLE_DIR, "theme.css"), ...themeFiles.map((f) => path.join(THEME_DIR, f))]) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      if (m[2]) continue; // 带兜底值：引用不到也不会白屏
      if (declared.has(m[1])) continue;
      if (!refs.has(m[1])) refs.set(m[1], []);
      refs.get(m[1]).push(`${path.relative(root, file)}:${i + 1}`);
    }
  });
}

const rows = [...refs.entries()];
if (!rows.length) {
  console.log(`[check:vars] 通过：${declared.size} 个已声明键，无悬空 var() 引用（主题文件 ${themeFiles.length} 份）`);
  process.exit(0);
}
console.error(`[check:vars] ${rows.length} 个自定义属性被引用却没有任何声明（浏览器会静默当作未设置）：`);
for (const [name, where] of rows) {
  console.error(`  ${name}  ← ${where.slice(0, 5).join(", ")}${where.length > 5 ? ` …共 ${where.length} 处` : ""}`);
}
console.error("要么改成已存在的键，要么在主题文件/基线里给它一个值（详设 §1-4/§1-5 就是这两笔账）。");
process.exit(1);
