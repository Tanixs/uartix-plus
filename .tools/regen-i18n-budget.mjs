/* 用实测数重写 check-i18n.cjs 里的 BUDGETS 块（预算 = 现状，只许降）。
   手抄这 48 个数一定会抄错或抄漏，所以让门自己生成自己的基线。 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

// 基线过期时门会以 1 退出（这正是它该做的），但 --print 的 stdout 仍然有效，
// 所以这里要把"非零退出"和"真的跑挂了"分开：只有拿不到 stdout 才算失败。
let out;
try {
  out = execFileSync("node", [".tools/check-i18n.cjs", "--print"], { encoding: "utf8" });
} catch (e) {
  out = typeof e.stdout === "string" ? e.stdout : "";
  if (!out.trim()) throw e;
}
const rows = [];
for (const line of out.split("\n")) {
  const m = line.match(/^\s*(\d+)\s+(src\/\S+)$/);
  if (m) rows.push([m[2], Number(m[1])]);
}
if (rows.length < 10) throw new Error("FAIL: 没读到足够的行，基线不写");

const p = ".tools/check-i18n.cjs";
let s = fs.readFileSync(p, "utf8");
const eol = s.includes("\r\n") ? "\r\n" : "\n";
const start = s.indexOf("const BUDGETS = {");
const end = s.indexOf("\n};", start);
if (start < 0 || end < 0) throw new Error("FAIL: 找不到 BUDGETS 块");

const body = rows.map(([f, n]) => `  ${JSON.stringify(f)}: ${n},`).join("\n");

/* ⚠ 这道门的全部意义在于"预算只降不升"，而这个脚本一条命令就能把基线刷成现状 ——
   也就是说它同时是**拆门的工具**。所以这里硬性拒绝任何上调：
   新增条目、把某个数改大，都必须手改 check-i18n.cjs 并写明理由，不能借脚本洗掉。
   唯一的例外是 `--rebaseline "<理由>"`：测量口径本身换了（P105-F 那次把正则扫描器换成
   AST 之后，旧扫描器漏报的债第一次被看见），此时"把数改对"不是放松棘轮。
   但它必须①带上非空理由②逐条打出改了哪些上调，让这次改判在终端和提交里都看得见。 */
const rebaselineArg = process.argv.indexOf("--rebaseline");
const rebaseline = rebaselineArg >= 0 ? String(process.argv[rebaselineArg + 1] ?? "").trim() : "";
if (rebaselineArg >= 0 && !rebaseline) {
  console.error("FAIL: --rebaseline 必须跟一句理由（它是要写进交付记录的，不能空着）");
  process.exit(1);
}
const old = {};
for (const m of s.matchAll(/^\s{2}"(src\/[^"]+)": (\d+),$/gm)) old[m[1]] = Number(m[2]);
const raised = rows.filter(([f, n]) => old[f] !== undefined && n > old[f]);
const added = rows.filter(([f]) => old[f] === undefined);
if ((raised.length || added.length) && !rebaseline) {
  console.error("FAIL: 基线不许借这个脚本上调（要加条目请手改 check-i18n.cjs 并写明理由）：");
  for (const [f, n] of raised) console.error(`  上调 ${f}: ${old[f]} → ${n}`);
  for (const [f] of added) console.error(`  新增 ${f}`);
  console.error("只有测量口径本身换了才用 --rebaseline \"<理由>\"。");
  process.exit(1);
}
if (rebaseline && (raised.length || added.length)) {
  console.log(`重新基线（理由：${rebaseline}）——本次上调 ${raised.length} 条、新增 ${added.length} 条：`);
  for (const [f, n] of raised) console.log(`  上调 ${f}: ${old[f]} → ${n}`);
  for (const [f] of added) console.log(`  新增 ${f}`);
}

s = s.slice(0, start) + "const BUDGETS = {\n" + body + "\n};\n" + s.slice(end + 3);
fs.writeFileSync(p, s.split("\n").join(eol), "utf8");
const lowered = rows.filter(([f, n]) => old[f] !== undefined && n < old[f]).length;
const cleared = Object.keys(old).filter((k) => !rows.some(([f]) => f === k)).length;
console.log(`BUDGETS 已收紧：${rows.length} 条（下调 ${lowered}、清零移除 ${cleared}），合计 ${rows.reduce((a, b) => a + b[1], 0)} 汉字`);
