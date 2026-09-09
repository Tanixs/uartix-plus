const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "src", "styles", "themes");

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

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".css"));
let fails = 0;
const rows = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  const vars = {};
  for (const m of src.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const val = m[2].trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(val)) vars[m[1]] = val;
  }
  const need = ["--bg", "--bg-panel", "--bg-inset", "--bg-titlebar", "--text", "--text-dim", "--accent", "--danger"];
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
    ["on-accent/accent(btn)", vars["--on-accent"] || "#ffffff", vars["--accent"], 3.0],
    ["danger/panel", vars["--danger"], vars["--bg-panel"], 3.0],
    ["accent/panel(text)", vars["--accent"], vars["--bg-panel"], 3.0],
  ];
  const line = [f.replace(".css", "")];
  for (const [name, fg, bg, min] of checks) {
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) fails++;
    line.push(`${name}=${r.toFixed(2)}${ok ? "" : "!!"}`);
  }
  rows.push(line.join("  "));
}
console.log(rows.join("\n"));
console.log(fails === 0 ? "OK: all theme contrast checks passed" : `FAIL: ${fails} problem(s)`);
process.exit(fails === 0 ? 0 : 1);
