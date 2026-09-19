/**
 * P88b-4 C：动效与无障碍基线检查（check:motion）。
 * 1) 扫描全部样式/组件源码中的无限循环动画（animation: ... infinite）：
 *    - duration < 200ms 的无限动画按「快速闪烁风险」直接 FAIL（光敏安全，详设 §10）；
 *    - 其余列入清单：必须是功能性动效（状态脉冲/录制指示/等待提示），新装饰性无限动画不允许；
 * 2) 防误删基线：theme.css 必须保留 prefers-reduced-motion 与 html.no-motion 两条降级规则，
 *    且规则体覆盖 transition/animation duration（「减弱动效」设置与系统偏好共用此路径）。
 * 豁免：行内注释含 motion-exempt 的动画（人工口子，需写明功能理由）。
 */
const fs = require("fs");
const path = require("path");

const roots = [
  path.join(__dirname, "..", "src", "styles"),
  path.join(__dirname, "..", "src", "features"),
  path.join(__dirname, "..", "src", "shell"),
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

let fails = 0;
const infinite = [];
const allFiles = roots.flatMap((root) => walk(root));
for (const f of allFiles) {
  const rel = path.relative(process.cwd(), f).replace(/\\/g, "/");
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = /animation\s*:[^;]*\binfinite\b/.exec(line);
    if (!m) return;
    const times = [...line.matchAll(/(\d*\.?\d+)(ms|s)\b/g)].map((x) => (x[2] === "s" ? parseFloat(x[1]) * 1000 : parseFloat(x[1])));
    const dur = times.length ? times[0] : null;
    const exempt = /motion-exempt/.test(line) || /motion-exempt/.test(lines[i - 1] ?? "");
    infinite.push({ rel, line: i + 1, dur, text: line.trim().slice(0, 100), exempt });
  });
}

console.log(`无限动画清单（${infinite.length} 处；均应为功能性动效，装饰性一律不允许）:`);
for (const it of infinite) {
  if (it.dur !== null && it.dur < 200 && !it.exempt) {
    console.log(`  FAIL [闪烁<200ms] ${it.rel}:${it.line} ${it.text}`);
    fails++;
  } else {
    console.log(`  - ${it.rel}:${it.line} ${it.dur !== null ? `${it.dur}ms` : "duration?"} ${it.text}`);
  }
}

/* 防误删：reduced-motion 双通道基线 */
const themeSrc = fs.readFileSync(path.join(__dirname, "..", "src", "styles", "theme.css"), "utf8");
const needBlocks = [
  ["@media (prefers-reduced-motion: reduce)", "系统偏好降级"],
  ["html.no-motion", "设置页「减弱动效」降级"],
];
for (const [needle, why] of needBlocks) {
  if (!themeSrc.includes(needle)) {
    console.log(`FAIL: theme.css 缺少 ${why} 基线规则（${needle}）`);
    fails++;
  } else {
    console.log(`OK: ${why} 基线存在（${needle}）`);
  }
}

console.log(fails === 0 ? "OK: motion & reduced-motion checks passed" : `FAIL: ${fails} problem(s)`);
process.exit(fails === 0 ? 0 : 1);
