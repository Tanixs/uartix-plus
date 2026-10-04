/**
 * P143-T4 · 交互签名覆盖率：把"所有可交互元素都要有签名"从口号变成一个读数。
 *
 * 为什么必须跑在真 DOM 里：判据是"这个可点物是什么元素"，而 CSS 侧看不出来——
 * `.tpl-item` 是个 div、`.le-btn` 是个 button，两者在 theme.css 里都只写着 `cursor:pointer`。
 * 静态扫出来的 204 个"可交互类"没法回答"总线够不够得着它"，够得着的定义是
 * **元素自己匹配 `:where(button, .btn, .icon-btn, [data-ctl])`**，那只有渲染时才知道。
 *
 * 面表与对比度基线**同一批面**（抄两份就等着漂）：import `.tools/audit-faces.mjs`。
 * 与 class-census 同理：签名覆盖与颜色无关，所以只跑一枚主题。
 *
 * 用法（前置同 audit:live：1421 dev server + 9333 一次性 profile 的 headless 浏览器）：
 *   node .tools/ctl-coverage.mjs              # 打摘要与未覆盖清单
 *   node .tools/ctl-coverage.mjs --write      # 另写 .tools/ctl-coverage.json
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ORIGIN, VIEWPORT, SURFACES, assertNoDupKeys, makeSession } from "./audit-faces.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const THEME = process.env.CTL_THEME || "fluent";
const WRITE = process.argv.includes("--write");
/** 与 theme.css 里那条总线**必须逐字一致**——改了样式没改这里，读数就是假的（hostHooks.test.ts 钉这条） */
const BUS =
  'button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], .btn, .icon-btn, [data-ctl]';

const list = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("连不上 127.0.0.1:9333：先起 vite(1421) 与 headless Edge(9333)，profile 用一次性的");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
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

/**
 * 页内只收事实、不做判据：按"标签 + 排序后的类名 + 有没有 data-ctl"折成指纹，
 * 同一指纹只回一条并带上出现次数（几千个元素 → 几百条，载荷与面数都不至于爆）。
 *
 * **为什么不用 `getComputedStyle(el).cursor === "pointer"`**（第一版就是这么写的，量出 41.8%）：
 * `cursor` 会**继承**，于是一枚按钮里的 `<span>`、uPlot 画布里的 491 个 `<svg>`/`<path>`
 * 全被算成"可交互元素"——那份读数 6 成是图形的内脏，分母是假的，百分比也就是假的。
 * 真正的判据是"**有规则直接指着这个元素**"：把 CSSOM 里声明了 `cursor:pointer` 的选择器
 * 逐个 `querySelectorAll`，被指到的才是控件。（选择器写不出来的手写内联 cursor 不在这本账里，
 * 全仓 `style cursor:pointer` 命中 0 处，所以这本账目前不缺角。）
 */
const GRAB = `(() => {
  const bus = ${JSON.stringify(BUS)};
  const sels = new Set();
  const walk = (rules) => {
    for (const r of rules || []) {
      // 顺序不能反：Chromium 给 CSSStyleRule 也挂了 cssRules（嵌套规则用），
      // 先判 r.cssRules 会把每一条普通样式规则当成容器跳进去——第一版就是这样收到 0 条的。
      if (r.selectorText && r.style) {
        if (r.style.getPropertyValue("cursor") !== "pointer") continue;
        for (const part of r.selectorText.split(",")) {
          const p = part.trim();
          // 伪元素与 ::picker 这类指不到元素的段，直接跳过（querySelectorAll 会抛）
          if (!p || p.includes("::")) continue;
          sels.add(p);
        }
        continue;
      }
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* 跨源表读不到 cssRules：本仓没有跨源样式表 */ }
  }
  const seen = new Set();
  for (const sel of sels) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch { continue; }
    for (const el of nodes) if (el.tagName !== "HTML" && el.tagName !== "BODY") seen.add(el);
  }
  const map = new Map();
  for (const el of seen) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cls = (el.getAttribute("class") || "").split(/\\s+/).filter(Boolean).sort().join(".");
    const ctl = el.getAttribute("data-ctl") || "";
    const tag = el.tagName.toLowerCase();
    // 顺带记一笔"它长在谁身上"：光看 tag+类名认不出那是哪件控件时，这一栏就是线索
    const p = el.parentElement;
    const pcls = p ? ((p.getAttribute("class") || "").split(/\\s+/).filter(Boolean)[0] || p.tagName.toLowerCase()) : "";
    const k = tag + "|" + cls + "|" + ctl;
    const hit = map.get(k);
    if (hit) { hit.n++; continue; }
    let onBus = false;
    try { onBus = el.matches(bus); } catch { onBus = false; }
    map.set(k, { tag, cls, ctl, pcls, n: 1, bus: onBus });
  }
  return [...map.values()];
})()`;

await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });
await goto(`${ORIGIN}/?welcome=0`);

const perFace = {};
const union = new Map();
for (const s of SURFACES) {
  assertNoDupKeys(s.path(THEME), THEME + "/" + s.id);
  let open = false;
  for (let attempt = 1; attempt <= 3 && !open; attempt++) {
    await goto(`${ORIGIN}${s.path(THEME)}`);
    if (s.drive) await drive(s.drive);
    open = !s.require || (await waitOpen(s.require));
  }
  if (!open) throw new Error(`${s.id}：这一面开不出来，覆盖率不能空着记`);
  const rows = await evaluate(GRAB);
  if (!Array.isArray(rows) || rows.length < 20) throw new Error(`${s.id}：只收到 ${rows && rows.length} 个可交互指纹，探针与页面结构脱钩了`);
  perFace[s.id] = { elems: rows.reduce((a, r) => a + r.n, 0), kinds: rows.length };
  for (const r of rows) {
    const key = `${r.tag}|${r.cls}|${r.ctl}`;
    const acc = union.get(key);
    if (acc) acc.n += r.n;
    else union.set(key, r);
  }
}

/** Fluent 组件层写了哪些类名：总线够不着、但主题自己点名盖过的，也算"有签名" */
const fluentCss = readFileSync(join(HERE, "..", "src", "styles", "builtinStyles", `${THEME}.css`), "utf8");
const fluentClasses = new Set([...fluentCss.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]));

/**
 * 豁免账：**每条都必须写清"为什么这件不需要签名"**，写不出理由的就是遗漏（这就是门槛的本意）。
 * 与 marketContent 的 ALLOWED_DIFF 同一口径——空转的豁免判红，否则它会变成下一个 `.wlc-skip`。
 * key = `tag|排序后的类名|data-ctl`，与页内指纹同一个拼法（类名不是属性，别看错）。
 */
const EXEMPT = {
  "input||":
    "无类名的原生输入件，14 面里量到两族：帧画布那枚单元尺寸滑杆（.fc-cellsz 里的 range）与插件开关/勾选框那层 opacity:0 的输入核。" +
    "滑杆按下去缩放整条轨道，等于把拇指从手指底下挪走；输入核本身看不见，缩放它没有意义（可见件是旁边的 .plg-switch-ui / .chk-box，它们跟着 checked 走）。" +
    "⇒ 这一族要的是「焦点环 + 值变化」，不是按压位移，故签名总线刻意不含 input/select/textarea（见 theme.css 那条总线的注释）。",
  "span||":
    "开关（.set-switch）里那枚没挂类名的滑块 span：它是控件的**可视零件**，不是一枚控件——" +
    "命中、按压、焦点都归外层 label（.set-switch 在流利层已点名覆盖），让滑块自己再按一档就是同一个动作画两次。",
};

let elems = 0;
let covered = 0;
let exempted = 0;
const gaps = new Map();
const usedExempts = new Set();
for (const r of union.values()) {
  elems += r.n;
  const cls = r.cls ? r.cls.split(".") : [];
  const fp = `${r.tag}|${r.cls}|${r.ctl}`;
  const byName = cls.some((c) => fluentClasses.has(c));
  if (EXEMPT[fp]) {
    exempted += r.n;
    usedExempts.add(fp);
    continue;
  }
  if (r.bus || byName) covered += r.n;
  else {
    const k = `${r.tag}.${cls.join(".") || "(无类名)"} ⟵ .${r.pcls || "(无父类)"}`;
    gaps.set(k, (gaps.get(k) || 0) + r.n);
  }
}
const pct = ((covered + exempted) / elems) * 100;

console.log(`面（${Object.keys(perFace).length}）：` + Object.entries(perFace).map(([k, v]) => `${k} ${v.elems}`).join(" / "));
console.log(`去重后可交互指纹 ${union.size} 条，覆盖元素 ${elems} 个（14 面各数一次，与对比度基线同一套面）`);
console.log(`签名覆盖 ${covered} + 豁免 ${exempted} = ${pct.toFixed(1)}%（总线 ${JSON.stringify(BUS)} ∪ ${THEME}.css 点名的类）`);
for (const [fp, why] of Object.entries(EXEMPT)) {
  if (!usedExempts.has(fp)) console.log(`FAIL: 豁免账这条指不到元素了（空转的出口该删）：${fp}`);
  else console.log(`豁免 ${fp} —— ${why}`);
}
console.log(`未覆盖 ${elems - covered - exempted} 个，按指纹聚合（前 30）：`);
for (const [k, n] of [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(n).padStart(4)}  ${k}`);
const idle = Object.keys(EXEMPT).length - usedExempts.size;
if (pct < 95) console.log(`FAIL: 覆盖率 ${pct.toFixed(1)}% 低于 95% 门槛——上面每条要么挂 data-ctl，要么写进豁免账并说明为什么不需要`);
if (idle) console.log(`FAIL: 豁免账有 ${idle} 条空转`);

if (WRITE) {
  writeFileSync(
    join(HERE, "ctl-coverage.json"),
    JSON.stringify(
      { theme: THEME, bus: BUS, faces: perFace, elems, covered, exempted, pct: Number(pct.toFixed(2)), gaps: Object.fromEntries(gaps) },
      null,
      2,
    ) + "\n",
  );
  console.log("写出 .tools/ctl-coverage.json");
}
process.exit(pct < 95 || idle ? 1 : 0);
