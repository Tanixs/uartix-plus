/**
 * P94-G1 静态 import 环守卫（P92-F 白屏的制度化）。
 *
 * 为什么需要它：`pluginStore` 模块顶层调 `extRuntime.applyStyleExts`，而两者同处一个静态环
 * ⇒ 求值期撞进对方未初始化的 `let` ⇒ TDZ ⇒ React 从未挂载 = 整窗白屏。而 **tsc / vitest /
 * build / cargo 当时全绿**（rollup 把环拉平，vitest 的解析顺序也不同），只有 dev 的 ESM
 * 实时求值会炸。仓库此前对循环依赖零护栏（eslint 未装 import/no-cycle）。
 *
 * 设计取舍：43 节点的强连通分量里长度 ≤6 的基本环上百条，**按环逐条登记不可行**。所以本脚本
 * 用三层可执行的约束代替"禁止一切环"：
 *   ① BANNED_EDGES：显式禁止的高危静态边（分层规则），出现即 FAIL；
 *   ② 长度 2/3 短环数量**只准降不准升**（棘轮），且新增具体短环也 FAIL；
 *   ③ 模块求值期顶层调用：数量与位置全部登记在册，新增即 FAIL——这才是 P92-F 真正的形态。
 * SCC 规模与环总数只做信息输出，便于看到"收紧/恶化"的趋势。
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

/* ============ ① 禁止的静态边（模块 → 模块；from 以 "/" 结尾＝目录前缀） ============ */
const BANNED_EDGES = [
  {
    from: "features/plugins/",
    to: "features/ai/extRuntime.ts",
    why: "P92-F 白屏根因：pluginStore 求值期顶层 restoreProjections() 会撞进 extRuntime 未初始化的 let appliedVars。plugins/ 全目录都不准静态依赖样式运行时——反向调用走 pluginStore 已导出的 setStyleApplier(fn)。",
  },
];

/* ============ ② 短环基线（长度 2/3）：新增即红，消除请同步删条目 ============ */
/* ============ ② 短环允许清单（**P99a-D1c 起为空**）============
 * 原来登记的 4 条全部是 extRuntime 那圈历史边：
 *   appActions ↔ extRuntime、extRuntime ↔ widgetHub、
 *   appActions ↔ xferStore ↔ extRuntime、appActions ↔ sentinelStore ↔ extRuntime
 * P99a-D1c 删掉主世界脚本通道后，extRuntime 不再 import appActions / widgetHub / chatStore /
 * framesBus / variableStore / serialStore / settingsStore（那些 import 只为喂 ScriptApi），
 * 四条环当场一起消失——**删对代码会把环守卫变成空清单**，这比给清单再加一条好得多。
 * 现在任何一条短环都是新增，直接红。 */
const ALLOWED_SHORT_CYCLES = [];

/* ============ ③ 模块求值期顶层调用基线：file::调用文本 ============
 * 这一层才是 P92-F 的真正形态：**顶层调用别的模块的函数 = 把执行顺序写死进模块体**，
 * 两侧同处 import 环时就是 dev 白屏。清单里每一条都是"已知且刻意留在求值期"的历史包袱，
 * 新增任何一条都必须先说清为什么不能交给显式 init 调用。 */
const ALLOWED_EVAL_CALLS = new Set([
  // store 启动从 localStorage 恢复（只碰自己的模块状态，不跨模块）
  "features/modbus/pollStore.ts::load()",
  "features/modbus/slaveStore.ts::load()",
  "features/orchestrator/orchestratorStore.ts::load()",
  "features/orchestrator/orchestratorStore.ts::loadVars()",
  "features/sequencer/sequencerStore.ts::load()",
  // 编排器绑定层在求值期起引擎心跳并同步一次（历史包袱：应改为 App 显式 start）
  "features/orchestrator/orchestratorBind.ts::setInterval(tick, TICK_MS)",
  "features/orchestrator/orchestratorBind.ts::syncFromStore()",
  // 插件库启动重建 theme 投影（P91-D1 单一真相；样式层已改走下面的注册边）
  "features/plugins/pluginStore.ts::restoreProjections()",
  // P92-F 的替代边：extRuntime 求值时把样式层应用者交给 pluginStore（注册即补跑脏活）
  "features/ai/extRuntime.ts::setStyleApplier(applyStyleExts)",
]);

/* ============================ 采集 ============================ */

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC, []);
const rel = (p) => path.relative(SRC, p).split(path.sep).join("/");
const known = new Set(files.map(rel));

/** 抓顶层静态 import/export-from 边；跳过纯 type 边与动态 import()。 */
function staticEdges(code) {
  const edges = [];
  const re = /(^|\n)\s*(import|export)\s([^;]*?)\s?from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[3];
    if (/^type\s/.test(clause.trim())) continue; // import type { X } from
    if (/^\{?\s*type\b/.test(clause.trim()) && !/[,(]\s*[A-Za-z_$]/.test(clause)) continue; // export type { X } from
    edges.push(m[4]);
  }
  const bareRe = /(^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = bareRe.exec(code))) edges.push(m[2]);
  return edges;
}

function resolve(fromRel, spec) {
  if (!spec.startsWith(".")) return null; // 裸包名 = 依赖，不入图
  const base = path.posix.join(path.posix.dirname(fromRel), spec);
  const cands = [base, base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"];
  for (const c of cands) if (known.has(c)) return c;
  return undefined; // 未解析（含 css/asset/别名）
}

const graph = new Map(); // rel -> Set(rel)
const dynamicCount = {};
let unresolved = 0;
const evalCalls = []; // {file, text, line}

for (const f of files) {
  const r = rel(f);
  const code = fs.readFileSync(f, "utf8");
  graph.set(r, new Set());
  for (const spec of staticEdges(code)) {
    const t = resolve(r, spec);
    if (!t) {
      if (t === undefined && spec.startsWith(".")) unresolved++;
      continue;
    }
    if (t !== r) graph.get(r).add(t);
  }
  dynamicCount[r] = (code.match(/\bimport\s*\(/g) || []).length;
  // 求值期顶层调用：第 0 列的 `foo(...)`（非声明/控制语句）。
  // 必须先剥掉注释与字符串——帮助页里嵌的示例代码（`send("AA 01 02","hex")`）会被误判成顶层调用。
  //
  // **一趟扫完、按出现位置裁决**（P99a-D2 修正）：旧写法是"先剥注释再剥字符串"的多次全量替换，
  // 于是模板字符串里一行以 `//` 开头的示例（且收尾反引号就在该行末尾）会被注释剥离连尾巴一起吃掉，
  // 反引号就此落单、后面所有字符串/模板配对整体错位——本批改帮助时它把一段无关的老示例
  // 报成了"新增求值期顶层调用"，行号还因为模板被折叠而指到别处（守卫自己的探针也是探针，§8-39）。
  // 现在注释/字符串/模板在同一次扫描里按先后顺序各归各位，且**保留换行数**，报告的行号就是真行号。
  const stripped = code.replace(
    /\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|[ \t]*\/\/[^\n]*/g,
    (m) => "\n".repeat((m.match(/\n/g) || []).length),
  );
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m2 = /^([A-Za-z_$][\w$]*)\(([^()]*)\)\s*;?\s*$/.exec(line);
    if (!m2) continue;
    if (["if", "for", "while", "switch", "catch", "return", "function", "const", "let", "var", "export", "import"].includes(m2[1])) continue;
    evalCalls.push({ file: r, text: `${m2[1]}(${m2[2]})`, line: i + 1 });
  }
}

/* ============================ Tarjan SCC ============================ */

let index = 0;
const idx = new Map();
const low = new Map();
const onStack = new Set();
const stack = [];
const sccs = [];

function strongConnect(v) {
  const work = [[v, 0]];
  idx.set(v, index);
  low.set(v, index);
  index++;
  stack.push(v);
  onStack.add(v);
  while (work.length) {
    const top = work[work.length - 1];
    const node = top[0];
    const nbrs = [...graph.get(node).values()];
    let advanced = false;
    while (top[1] < nbrs.length) {
      const w = nbrs[top[1]++];
      if (!idx.has(w)) {
        idx.set(w, index);
        low.set(w, index);
        index++;
        stack.push(w);
        onStack.add(w);
        work.push([w, 0]);
        advanced = true;
        break;
      } else if (onStack.has(w)) {
        low.set(node, Math.min(low.get(node), idx.get(w)));
      }
    }
    if (advanced) continue;
    work.pop();
    if (work.length) {
      const parent = work[work.length - 1][0];
      low.set(parent, Math.min(low.get(parent), low.get(node)));
    }
    if (low.get(node) === idx.get(node)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== node);
      sccs.push(comp);
    }
  }
}
for (const v of graph.keys()) if (!idx.has(v)) strongConnect(v);

const bigScc = sccs.filter((c) => c.length > 1).sort((a, b) => b.length - a.length);

/* ============================ 短环（长度 2/3） ============================ */

function cyclesUpTo(maxLen) {
  const found = [];
  const nodes = [...graph.keys()].sort();
  for (const start of nodes) {
    // 只允许经由 >= start 的节点，保证每条环只被最小节点发现一次
    const dfs = (cur, pathArr) => {
      for (const nxt of graph.get(cur)) {
        if (nxt === start && pathArr.length >= 2 && pathArr.length <= maxLen) {
          found.push(pathArr.slice());
          continue;
        }
        if (nxt < start) continue;
        if (pathArr.includes(nxt)) continue;
        if (pathArr.length >= maxLen) continue;
        dfs(nxt, pathArr.concat(nxt));
      }
    };
    dfs(start, [start]);
  }
  return found;
}

const shortCycles = cyclesUpTo(3);

/* ============================ 判定 ============================ */

let fails = 0;
const fail = (msg) => {
  fails++;
  console.log("FAIL: " + msg);
};

const totalEdges = [...graph.values()].reduce((n, s) => n + s.size, 0);
console.log(
  `图规模：文件 ${files.length}，静态边 ${totalEdges}，动态 import ${Object.values(dynamicCount).reduce((a, b) => a + b, 0)}，未解析 ${unresolved}（type-only 边已排除）`,
);
console.log(
  `强连通分量：>1 的有 ${bigScc.length} 个${bigScc.length ? `（最大 ${bigScc[0].length} 节点）` : ""}；长度 2/3 短环 ${shortCycles.length} 条`,
);

for (const b of BANNED_EDGES) {
  const hit = [...graph.entries()].filter(
    ([u, outs]) => (b.from.endsWith("/") ? u.startsWith(b.from) : u === b.from) && outs.has(b.to),
  );
  for (const [u] of hit) fail(`禁止的静态边 ${u} → ${b.to}。${b.why}`);
}
console.log(`OK: 禁止边规则 ${BANNED_EDGES.length} 条全部未命中`);

const seen = new Set();
for (const cyc of shortCycles) {
  const key = cyc.slice().sort().join("|");
  if (seen.has(key)) continue;
  seen.add(key);
  if (!ALLOWED_SHORT_CYCLES.includes(key)) {
    fail(`新增短环：${cyc.join(" → ")} → ${cyc[0]}`);
  }
}
const removed = ALLOWED_SHORT_CYCLES.filter((k) => !seen.has(k));
if (removed.length)
  console.log(`提示：${removed.length} 条已登记短环已被消除，可从允许清单删掉（收紧）：\n  - ${removed.join("\n  - ")}`);
// seen 只可能包含"在清单里且实际存在"的键（不在清单的早就 fail 了），所以命中数就是 seen.size。
// 这里以前写 `seen.size - removed.length`，清单全部命中时看着对，一旦有登记项被消除就直接印出负数
// （P99a-D1c 当场撞上"实际命中 -4 条"）——守卫自己把异常数字印给用户看，就是§8-36②说的第二种取证失误。
console.log(`OK: 短环允许清单 ${ALLOWED_SHORT_CYCLES.length} 条，实际命中 ${seen.size} 条`);

const evalSeen = new Set(evalCalls.map((c) => `${c.file}::${c.text}`));
for (const c of evalCalls) {
  const key = `${c.file}::${c.text}`;
  if (!ALLOWED_EVAL_CALLS.has(key)) {
    fail(`新增模块求值期顶层调用 ${c.file}:${c.line} → ${c.text}。顶层调用别的模块函数等于把执行顺序写进模块体，一旦两侧同处 import 环就是 dev 白屏（P92-F 实录，见 HANDOFF §8-33）；改成注册式回调 + 脏标记，或把动作交给显式 init 调用方。`);
  }
}
const evalGone = [...ALLOWED_EVAL_CALLS].filter((k) => !evalSeen.has(k));
if (evalGone.length) console.log(`提示：${evalGone.length} 条已登记的顶层调用已消失（可从清单删掉）：\n  - ${evalGone.join("\n  - ")}`);
console.log(`OK: 求值期顶层调用在册 ${evalSeen.size} 处（清单 ${ALLOWED_EVAL_CALLS.size} 条）`);

if (bigScc.length && bigScc[0].length > 45) fail(`最大 SCC 从 43 涨到 ${bigScc[0].length}：耦合面在扩大，新代码不要在环里加边`);

process.exit(fails === 0 ? 0 : 1);
