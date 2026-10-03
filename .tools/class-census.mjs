/**
 * P132-I · 类名普查：把"这 13 面**运行时真渲染过**的 class token"记成一本账。
 *
 * 为什么要它：`.wlc-skip` 那条死规则是 P132-H 靠 grep 撞上的（CSS 里有、没人渲染），
 * 而"没人渲染"这件事静态查不准——类名可以是模板拼出来的（`.orch-dot-${kind}`），
 * 也可以是第三方库自己画的 DOM（dockview 的 `.dv-*`）。所以判据要三方对齐：
 *   CSS 里定义了 ∧ 源码里没有这个字面量 ∧ 源码里没有任何能拼出它的模板前缀 ∧ 面上没渲染过。
 * 这里出的是第四方（运行时），静态那三方在 `.tools/check-dead-classes.cjs`。
 *
 * 面表与驱动 import `.tools/audit-faces.mjs`——**与对比度基线同一批面**（面表抄两份就是等着漂）。
 * 类名与主题无关（换主题换的是颜色不是 DOM），所以只跑一枚，3 分钟而不是 30 分钟；
 * 这一点写进产物里，别让下一位以为它覆盖九枚。
 *
 * 用法（与 audit:live 同一套前置：1421 dev server + 9333 一次性 profile 的 headless 浏览器）：
 *   node .tools/class-census.mjs            # 打摘要
 *   node .tools/class-census.mjs --write    # 写 .tools/class-census.json
 */
const CDP_HTTP = "http://127.0.0.1:9333";
const OUT = new URL("./class-census.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { ORIGIN, VIEWPORT, SURFACES, assertNoDupKeys, makeSession } = await import("./audit-faces.mjs");
const THEME = "fluent";
const WRITE = process.argv.includes("--write");

const list = await (await fetch(`${CDP_HTTP}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error(`连不上 ${CDP_HTTP}：先起 vite(1421) 与 headless Edge(9333)，profile 用一次性的`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const n = ++seq;
  pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const rest = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`页内异常：${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}
async function key(k, code, vk, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
}
async function typeText(s) {
  for (const ch of s) {
    const up = ch.toUpperCase();
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: "Key" + up, windowsVirtualKeyCode: up.charCodeAt(0), text: ch, unmodifiedText: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "Key" + up, windowsVirtualKeyCode: up.charCodeAt(0) });
    await rest(30);
  }
}
const { goto, drive, waitOpen } = makeSession({ send, evaluate, rest, key, typeText });

/** 页内只做一件事：把 DOM 里出现过的 class token 收上来。判定不在这里（这里没有判据可抄） */
const GRAB = `(() => {
  const out = new Set();
  for (const el of document.querySelectorAll("*")) {
    const c = el.getAttribute && el.getAttribute("class");
    if (!c) continue;
    for (const t of String(c).split(/\\s+/)) if (t) out.add(t);
  }
  return [...out];
})()`;

await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });
await goto(`${ORIGIN}/?welcome=0`);

const union = new Set();
const faces = {};
for (const s of SURFACES) {
  assertNoDupKeys(s.path(THEME), THEME + "/" + s.id);
  let open = false;
  for (let attempt = 1; attempt <= 3 && !open; attempt++) {
    await goto(`${ORIGIN}${s.path(THEME)}`);
    if (s.drive) await drive(s.drive);
    open = !s.require || (await waitOpen(s.require));
  }
  // 面开不出来就不能记这一面：记了就是一个"看着覆盖到、其实没渲染"的空面
  if (!open) throw new Error(`${s.id}：这一面开不出来，普查不能空着记`);
  const cls = await evaluate(GRAB);
  if (!Array.isArray(cls) || cls.length < 60) throw new Error(`${s.id}：只收到 ${cls && cls.length} 个类名，探针与页面结构脱钩了`);
  faces[s.id] = cls.length;
  for (const c of cls) union.add(c);
  console.log(`${s.id.padEnd(11)} 类名 ${String(cls.length).padStart(3)}  累计并集 ${union.size}`);
}

const census = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  theme: THEME,
  note: "类名与主题无关（换主题换的是颜色不是 DOM），所以只跑一枚；面表与 audit-live 共用 .tools/audit-faces.mjs",
  faces,
  rendered: [...union].sort(),
};
console.log(`\n${SURFACES.length} 面并集 ${union.size} 个 class token`);
if (WRITE) {
  writeFileSync(OUT, `${JSON.stringify(census, null, 2)}\n`, { encoding: "utf8" });
  console.log(`已写 ${fileURLToPath(OUT)}`);
}
ws.close();
