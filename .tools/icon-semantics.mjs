/* B12：图标语义盘点。
   数的是"一枚图标在多少个**语义不同的地方**被用"——同一枚在两个不相干的地方出现，
   用户就没法靠形状建立联想；反过来同一个意思有好几枚画法，也是同一种病。
   分组靠调用点所在的文件，不靠人脑记，因为人脑记的就是错的（IconColumns 从 2 义长到 4 义）。 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const rel = path.join(d, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) && !rel.includes("shared/icons")) out.push(rel);
  }
  return out;
};

const files = walk("src");
const uses = new Map(); // icon -> Set(file)
for (const f of files) {
  const s = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of s.matchAll(/<(Icon[A-Za-z0-9]+)[\s/>]/g)) {
    if (!uses.has(m[1])) uses.set(m[1], new Set());
    uses.get(m[1]).add(f.replace(/\\/g, "/"));
  }
}

const rows = [...uses.entries()].sort((a, b) => b[1].size - a[1].size);
console.log("图标总数（有使用点）:", rows.length, "\n");
console.log("=== 一枚图标跨多个领域 = 语义被稀释，形状建立不起联想 ===");
for (const [icon, set] of rows) {
  const dirs = new Set([...set].map((f) => f.split("/").slice(0, 3).join("/")));
  if (set.size >= 3) {
    console.log(`${icon.padEnd(18)} ${String(set.size).padStart(2)} 个文件 / ${dirs.size} 个领域`);
    console.log("   ", [...set].join("  "));
  }
}

console.log("\n=== 同一领域里图标命名是否成族 ===");
const byDomain = new Map();
for (const [icon, set] of uses) {
  for (const f of set) byDomain.set(f, [...(byDomain.get(f) ?? []), icon]);
}
const dom = new Map();
for (const [f, icons] of byDomain) {
  const d = f.split("/").slice(0, 3).join("/");
  dom.set(d, new Set([...(dom.get(d) ?? []), ...icons]));
}
for (const [d, set] of [...dom].sort((a, b) => b[1].size - a[1].size).slice(0, 10)) {
  console.log(`${String(set.size).padStart(3)} 枚  ${d}`);
}
