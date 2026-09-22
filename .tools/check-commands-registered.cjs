#!/usr/bin/env node
/**
 * P99a-N1 附带守卫：每个 `#[tauri::command]` 都必须出现在 `lib.rs` 的 `generate_handler![]` 里。
 *
 * 起因（实锤，不是洁癖）：`take_pending_open` 在 `lib.rs:101` 定义、前端 `operatorStore.ts:107/109` 在调，
 * 但**从来没进过 handler 列表** ⇒ 双击 .uopk 文件关联打开的部署包永远取不走路径，
 * 而调用点在 `try { … } catch {}` 里，**reject 被静默吞掉**——用户看到的就是"双击没反应"。
 * §8-P44 的老教训是"`manage()` 了才用得了 State（注册命令 ≠ State 可用）"，
 * 这条是它的**镜像**："写了 `#[tauri::command]` ≠ 前端调得到"。
 *
 * 用法：node .tools/check-commands-registered.cjs
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src-tauri", "src");
const LIB = path.join(SRC, "lib.rs");

/**
 * 已知的"只给 Rust 侧用"的命令（不进前端 invoke）。**每条都要写理由**，
 * 空理由或理由过时就算守卫失败——豁免清单不该变成第二个"没人检查的形容词"。
 */
const EXEMPT = new Map();

function commandFns() {
  const out = [];
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith(".rs"))) {
    const src = fs.readFileSync(path.join(SRC, name), "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/^\s*#\[tauri::command\]/.test(line)) return;
      // 属性后面的下一个非空、非属性行就是函数签名
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l || l.startsWith("//") || l.startsWith("#")) continue;
        const m = /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/.exec(l);
        if (m) out.push({ name: m[1], file: name, line: j + 1 });
        break;
      }
    });
  }
  return out;
}

function registered() {
  const src = fs.readFileSync(LIB, "utf8");
  const start = src.indexOf("generate_handler![");
  if (start < 0) throw new Error("lib.rs 里找不到 generate_handler![]，守卫要看的是这个列表");
  const end = src.indexOf("])", start);
  const body = src.slice(start, end < 0 ? src.length : end);
  const set = new Set();
  for (const m of body.matchAll(/([A-Za-z0-9_]+)\s*::\s*([A-Za-z0-9_]+)\s*,?/g)) set.add(m[2]);
  for (const m of body.matchAll(/^\s*([A-Za-z0-9_]{3,})\s*,?\s*$/gm)) set.add(m[1]); // 末项可以没有尾逗号
  return set;
}

const cmds = commandFns();
const reg = registered();
const missing = cmds.filter((c) => !reg.has(c.name) && !EXEMPT.has(c.name));
const staleExempts = [...EXEMPT.keys()].filter((n) => !cmds.some((c) => c.name === n));

console.log(`命令属性 ${cmds.length} 个 / handler 列表登记 ${reg.size} 项`);
if (cmds.length === 0 || reg.size === 0) {
  console.error("FAIL: 解析结果为空——守卫自己瞎了比没守卫更坏（§8-43②）");
  process.exit(1);
}
for (const c of missing) console.error(`FAIL: ${c.file}:${c.line} 的 ${c.name} 有 #[tauri::command]，但没进 generate_handler![]`);
for (const n of staleExempts) console.error(`FAIL: 豁免项 ${n} 已经不存在了，删掉它`);
for (const [n, why] of EXEMPT) if (!why || !why.trim()) console.error(`FAIL: 豁免 ${n} 没写理由`);
if (missing.length || staleExempts.length) process.exit(1);
console.log("OK: 每个 tauri::command 都注册了（或带理由地豁免）");
