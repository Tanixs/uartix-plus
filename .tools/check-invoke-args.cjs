#!/usr/bin/env node
/**
 * P133 · 第十五道门：`invoke` 的参数键名必须与 Rust 形名对得上。
 *
 * 为什么补这道门（实录）：`fs_edit` 从 P109-D 交付起**一次都没成功过**。
 * TS 侧发 `old_text`，而 Tauri 把 Rust 的 snake_case 形名转成 camelCase 作为 JS 侧键名，
 * 于是每次调用都在进 Rust 之前就被拒：`invalid args 'oldText' for command 'agent_fs_edit'`。
 * 这条通路是"AI 能改源码"的主干，它坏了两周没人发现——因为单测 mock 掉了 `invoke`：
 * mock 测的是"我们怎么调自己"，不是"线上到底是什么键名"。
 * 与 §8-43 同一课：**能被 mock 掉的契约等于没被测过**；这次把契约挪到门禁里，
 * 判据落在两份源码的对照上（JS 发的键 × Rust 的形名），任何一侧改名都会红。
 *
 * 判据（三条，全是可判的）：
 *  ① JS 侧键名含下划线 ⇒ 判红（Tauri 要 camelCase；Rust 侧显式 `rename_all="snake_case"` 的命令除外）；
 *  ② JS 侧某个键在 Rust 形名表里找不到 ⇒ 判红（改名/拼错）；
 *  ③ Rust 侧某个必填形名 JS 没发 ⇒ 判红（`Option<T>` 与 `State/Window` 注入项不算必填）；
 *  ④ 自证：检测式先咬一口内置夹具，咬不到就说明这道门自己瞎了，当场 FAIL。
 *
 * 已知局限（明写）：
 *  - 参数对象里带展开（`...x`）的调用跳过 ②③，但仍判 ①；跳过的条数会打印出来，不静默；
 *  - 只认字面量命令名：`invoke(cmd, …)` 这种变量名扫不到（全仓 0 处，由另一条规矩守着）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function walk(dir, re, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** 按深度切 Rust 参数表：`State<'_, crate::X>` 里的逗号不是分隔符 */
function splitParams(raw) {
  const out = [];
  let d = 0;
  let token = "";
  for (const ch of raw) {
    if (ch === "<" || ch === "(" || ch === "{") d++;
    else if (ch === ">" || ch === ")" || ch === "}") d--;
    if (ch === "," && d === 0) { out.push(token); token = ""; continue; }
    token += ch;
  }
  out.push(token);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 是不是宿主注入项（不是 JS 该发的参数）。Rust 里常写成 `tauri::State<'_, …>`，要先剥路径前缀 */
function isInjected(typeText) {
  const bare = typeText.replace(/^(?:[a-z0-9_]+::)+/i, "");
  return /^(State|RefState|Window|WebviewWindow|AppHandle|Manager|self)\b/.test(bare);
}

/* ---------- 1) Rust 侧：函数 → 形名（含"是不是必填"） ----------
 * 不要求 `#[tauri::command]` 紧邻：那条属性与 fn 之间常隔着 doc 注释，按距离筛会漏掉一批命令
 * （第一版就是这么漏了 ai_abort / hex_fetch / …，把"门没解析到"误报成"调用不存在的命令"）。
 * 注册与否由第十道门 check-commands-registered 管，这里只管**键名对不对**。 */
const rsFiles = walk(path.join(ROOT, "src-tauri", "src"), /\.rs$/);
/** @type {Map<string, {required: string[], optional: string[], snake: boolean}>} */
const commands = new Map();
for (const f of rsFiles) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:pub\s+)?(?:async\s+)?fn\s+([a-z0-9_]+)\s*\(([\s\S]{0,1200}?)\)\s*(?:->|\{)/g)) {
    const [, name, raw] = m;
    const required = [];
    const optional = [];
    for (const p of splitParams(raw)) {
      const pm = /^([a-z0-9_]+)\s*:\s*(.+)$/.exec(p);
      if (!pm) continue;
      const [, pname, ptypeRaw] = pm;
      const ptype = ptypeRaw.trim();
      if (isInjected(ptype)) continue;
      if (/^Option</.test(ptype)) optional.push(camel(pname));
      else required.push(camel(pname));
    }
    const head = src.slice(Math.max(0, m.index - 800), m.index);
    if (!commands.has(name)) {
      commands.set(name, { required, optional, snake: /rename_all\s*=\s*"snake_case"/.test(head) });
    }
  }
}

/* ---------- 2) 检测本体（文件扫描与夹具自证**共用这一份**） ----------
 * 第一版把自证写成另一段手搓的 probe()，于是文件扫描整个瞎掉时夹具照样绿——
 * 那正是 §8-43② 说的"守卫的夹具自己红不了＝没有守卫"。现在自证调用同一个函数。 */

/** 从对象字面量正文里取**本层**键（含 `x,` 这种简写；嵌套对象不算） */
function keysOf(body) {
  const out = [];
  let d = 0;
  let token = "";
  const push = (t) => {
    // 参数之间常夹着注释行；不先剥掉，`apiKey: …` 会因为 token 以 `//` 开头而整个被漏读
    // （只剥**前导**注释，不动 token 中间的——`url: "https://…"` 那种字符串不能被误伤）
    t = t.replace(/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
    const km = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(t);
    if (km) { out.push(km[1]); return; }
    const sh = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(t);
    if (sh) out.push(sh[1]); // 简写：`path,` 的键名就是 path
  };
  for (const ch of body) {
    if (ch === "{" || ch === "[" || ch === "(") d++;
    else if (ch === "}" || ch === "]" || ch === ")") d--;
    else if (ch === "," && d === 0) { push(token); token = ""; continue; }
    token += ch;
  }
  push(token);
  return out;
}

/** 返回这一处调用的问题列表（空数组＝对得上）。 */
function checkCall(cmd, body, sig) {
  const problems = [];
  const sent = new Set();
  for (const key of keysOf(body)) {
    if (!sig.snake && key.includes("_")) {
      problems.push(`invoke("${cmd}") 发的是 snake_case 键 ${key} —— Tauri 要 ${camel(key)}（命令根本不会进 Rust）`);
    }
    sent.add(sig.snake ? key : camel(key));
  }
  if (/\.\.\./.test(body)) return problems; // 有展开：只判键名，不判缺不缺
  const all = new Set([...sig.required, ...sig.optional]);
  for (const k of sent) if (!all.has(k)) problems.push(`invoke("${cmd}") 发了 Rust 没有的键 ${k}`);
  for (const r of sig.required) if (!sent.has(r)) problems.push(`invoke("${cmd}") 缺 Rust 必填参数 ${r}`);
  return problems;
}

/* ---------- 3) JS 侧扫描 ---------- */
const problems = [];
let calls = 0;
let skippedSpread = 0;
for (const f of walk(path.join(ROOT, "src"), /\.(?:ts|tsx)$/)) {
  if (/\.test\.tsx?$/.test(f)) continue;
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  for (const m of src.matchAll(/invoke(?:<[\s\S]{0,400}?>)?\(\s*"([a-z0-9_]+)"\s*(?:,\s*\{)?/g)) {
    const cmd = m[1];
    const sig = commands.get(cmd);
    if (!sig) { problems.push(`${rel}: invoke("${cmd}") 在 src-tauri 里找不到同名 fn（拼错，或命令定义在别处）`); continue; }
    const braceAt = m.index + m[0].length - 1; // m[0] 以参数对象的 `{` 结尾（正则里已经吃掉它）
    if (src[braceAt] !== "{") continue;        // 没有参数对象的调用没什么可判
    let depth = 0;
    let end = braceAt;
    for (let i = braceAt; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(braceAt + 1, end);
    calls++;
    if (/\.\.\./.test(body)) skippedSpread++;
    for (const p of checkCall(cmd, body, sig)) problems.push(`${rel}: ${p}`);
  }
}

/* ---------- 4) 自证：夹具必须被**同一个** checkCall 判红（§8-43②） ---------- */
const fixtureSig = { required: ["oldText", "path"], optional: ["all"], snake: false };
const fixtureBody = " path, old_text: a, extraKey: 1,";
const caught = checkCall("demo_cmd", fixtureBody, fixtureSig);
const want = ["snake_case 键 old_text", "Rust 没有的键 extraKey"];
for (const w of want) {
  if (!caught.some((c) => c.includes(w))) {
    console.error(`FAIL: 门自己瞎了——夹具没被判出「${w}」，本文件的检测式不可信（§8-43②）`);
    process.exit(1);
  }
}

if (problems.length) {
  console.error(`FAIL: invoke 参数键名与 Rust 形名不一致 ${problems.length} 处：`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`OK: ${calls} 处 invoke 的参数键名与 Rust 形名逐一对上（含展开跳过 ${skippedSpread} 处；夹具自证命中 ${caught.length} 项）`);
