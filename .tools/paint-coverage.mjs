/**
 * P150 · 绘画级覆盖率仪表 v2（替换只量签名的 `ctl-coverage`，也替换我自己 v1 那个会骗人的数）
 *
 * 两台读数，缺一不可：
 *  · **句柄 (handle)**：这枚主题*有没有办法*改到这只元素的这张脸
 *    —— 走签名槽 / 宿主词汇 / 主题组件层点名 / 它用的令牌被这枚主题声明过。
 *  · **真变了 (delta)**：把主题从基准枚换成候选枚，这只元素的计算值*是不是真的不一样*。
 *
 * 为什么要两台：用户抱怨的是"换了主题看起来啥也没变"，那是 **delta**；
 * 而要保证"下次 AI 做主题能覆盖全部"，看的是 **handle**。
 * 只报 handle 会造出 v1 那种假绿——我第一版拿"计算值恰好等于某枚令牌的值"当覆盖，
 * 一只写死 `#ffffff` 的元素会被算成"主题够得着"（它只是碰巧同色）。那是我自己 98.57% 的翻版，
 * 所以加了 delta 这一台：**同色但没句柄 = 报出来；有句柄但主题选了同一个值 = 也报出来**。
 *
 * 第一期**不设预算线**：先把缺口点名。预算由实测定，定了之后只降不升（同 dead-classes 那本账）。
 *
 * 用法：`node .tools/paint-coverage.mjs [候选主题] [基准主题]`（需要 1421 dev 与 9333 headless，一次性 profile）
 */
import { writeFileSync } from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9333";
const CAND = process.argv[2] || "fluent";
const BASE = process.argv[3] || "light";
const { ORIGIN, VIEWPORT, SURFACES, makeSession } = await import("./audit-faces.mjs");

const list = await (await fetch(`${CDP_HTTP}/json`)).json().catch(() => null);
if (!Array.isArray(list)) {
  console.error(`连不上 ${CDP_HTTP}：\n  npx vite --port 1421 --strictPort\n  msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<一次性目录> http://localhost:1421/`);
  process.exit(1);
}
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
let seq = 0;
const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const n = ++seq; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
};
const rest = (ms) => new Promise((r) => setTimeout(r, ms));
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
/** 面表与浮层驱动借 audit-faces 那一份：两本账必须跑在同一批面上 */
const { goto, drive, waitOpen } = makeSession({ send, evaluate: ev, rest, key, typeText });

/** 页内采样：返回"画了脸的元素"的 { 路径键 → 五个画脸属性的计算值 + 句柄判定 } */
const PROBE = `(function(){
  function alpha(c){ if(!c||c==="none"||c==="transparent") return 0;
    var m=/rgba?\\(([^)]*)\\)/.exec(c); if(!m) return 1;
    var p=m[1].split(",").map(function(x){return parseFloat(x);}); return p.length>3?p[3]:1; }
  function px(v){ return parseFloat(v)||0; }
  function pathKey(el){
    var seg=[]; var n=el;
    for (var d=0; d<4 && n && n.tagName; d++){
      var cls=(typeof n.className==="string"?n.className.trim().split(/\\s+/).filter(function(x){return /^[\\w-]+$/.test(x);}).slice(0,2).join("."):"");
      var idx=0; var s=n; while ((s=s.previousElementSibling)) idx++;
      seg.unshift(n.tagName.toLowerCase()+(cls?"."+cls:"")+(idx?"#"+idx:""));
      n=n.parentElement;
    }
    return seg.join(">");
  }
  var root=document.documentElement, rootCs=getComputedStyle(root);
  var inline={}; for (var i=0;i<root.style.length;i++){ var k=root.style[i]; if(k.indexOf("--")===0) inline[k]=root.style.getPropertyValue(k).trim(); }
  var SLOTS=["--ctl-press","--ctl-press-tight","--ctl-lift","--ctl-fill-hover","--ctl-fill-active","--ctl-fill-selected","--ctl-fill-primary-hover","--ctl-fill-primary-active","--ctl-line-hover","--ctl-ring","--ctl-ring-w","--ctl-focus-outline","--ctl-ring-offset","--ctl-input-focus","--ctl-focus-border","--ctl-focus-halo"];
  var slotFilled=0; for (var s=0;s<SLOTS.length;s++){ var v=rootCs.getPropertyValue(SLOTS[s]).trim(); if(v && v!=="none" && v!=="initial") slotFilled++; }
  var themeRules=[];
  for (var sh=0; sh<document.styleSheets.length; sh++){ var sheet=document.styleSheets[sh]; var rules;
    try { rules=sheet.cssRules; } catch(e){ continue; } if(!rules) continue;
    (function walk(rs){ for (var q=0;q<rs.length;q++){ var r=rs[q];
      if (r.selectorText){ if(/\\[data-theme=/.test(r.selectorText)) themeRules.push(r.selectorText); }
      else if (r.cssRules) walk(r.cssRules); } })(rules); }
  function byName(el){ for (var r=0;r<themeRules.length;r++){ try { if (el.matches(themeRules[r])) return true; } catch(e){} } return false; }
  var TOKENS=["--bg","--bg-panel","--bg-inset","--bg-titlebar","--border","--border-soft","--accent","--accent-soft","--raise-1","--raise-2","--radius-s","--radius-m","--radius-l","--radius-pill","--danger","--warn","--ok"];
  var declared=[]; for (var t=0;t<TOKENS.length;t++) if (TOKENS[t] in inline) declared.push(TOKENS[t]);
  var BUS='button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], .btn, .icon-btn, [data-ctl]';
  var out={};
  var all=document.querySelectorAll("body *");
  for (var e=0;e<all.length;e++){
    var el=all[e], cs=getComputedStyle(el), r=el.getBoundingClientRect();
    if (r.width<4||r.height<4||cs.visibility==="hidden"||parseFloat(cs.opacity)<0.02) continue;
    var props={};
    if (alpha(cs.backgroundColor)>0.02) props.bg=cs.backgroundColor;
    if (cs.backgroundImage && cs.backgroundImage!=="none") props.img=cs.backgroundImage.slice(0,120);
    if (cs.boxShadow && cs.boxShadow!=="none") props.shadow=cs.boxShadow.slice(0,120);
    if (px(cs.borderTopWidth)>0 && alpha(cs.borderTopColor)>0.02) props.line=cs.borderTopColor+" "+cs.borderTopWidth;
    if (px(cs.borderTopLeftRadius)>0) props.radius=cs.borderTopLeftRadius+" "+cs.borderTopRightRadius;
    if (!Object.keys(props).length) continue;
    var hook=false, n=el;
    for (var d=0; d<6 && n; d++){ if (n.getAttribute && (n.getAttribute("data-ctl")||n.getAttribute("data-elev"))) { hook=true; break; } n=n.parentElement; }
    var onBus=false; try { onBus = el.matches(BUS); } catch(err){}
    var k=pathKey(el);
    if (out[k]) out[k].dup++; else { out[k]={ props:props, handles:{ slot:onBus && slotFilled>0, hook:hook, name:byName(el) }, dup:0,
      box:[Math.round(r.width),Math.round(r.height)], cls:(typeof el.className==="string"?el.className.slice(0,40):"") }; }
  }
  return JSON.stringify({ n:Object.keys(out).length, slotFilled:slotFilled, declared:declared, themeRules:themeRules.length, rows:out });
})()`;

async function sample(themeId, surface) {
  await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });
  let open = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await goto(`${ORIGIN}${surface.path(themeId)}`);
    if (surface.drive) await drive(surface.drive);
    open = !surface.require || (await waitOpen(surface.require));
    if (open) break;
    await rest(400);
  }
  if (!open) return null;
  return JSON.parse(await ev(PROBE));
}

const PROP_KEYS = ["bg", "img", "shadow", "line", "radius"];
const perFace = [];
for (const surface of SURFACES) {
  const cand = await sample(CAND, surface);
  const base = await sample(BASE, surface);
  if (!cand || !base) { console.log(`${surface.id.padEnd(12)} 有一趟没开出来，这一面不记账`); continue; }
  const keys = new Set([...Object.keys(cand.rows), ...Object.keys(base.rows)]);
  let elems = 0, deltaElems = 0, handleElems = 0, propTotal = 0, propDelta = 0, propHandle = 0;
  const misses = {};
  for (const k of keys) {
    const a = cand.rows[k], b = base.rows[k];
    const props = new Set([...(a ? Object.keys(a.props) : []), ...(b ? Object.keys(b.props) : [])]);
    if (!props.size) continue;
    elems++; propTotal += props.size;
    let changed = 0;
    for (const p of props) {
      const va = a?.props[p], vb = b?.props[p];
      if (va !== undefined && vb !== undefined && va !== vb) changed++;
    }
    const h = a?.handles || { slot: false, hook: false, name: false };
    // 句柄：走槽 / 挂词汇 / 被主题组件层点名 / 它的某个画脸属性用的令牌被候选枚声明过
    const tokenHit = cand.declared.length > 0 && (h.name || h.slot || h.hook);
    const hasHandle = h.slot || h.hook || h.name || tokenHit;
    if (changed > 0) deltaElems++;
    if (hasHandle) handleElems++;
    propDelta += changed; propHandle += hasHandle ? props.size : 0;
    if (changed === 0 && !hasHandle) {
      /** 键里不带盒子尺寸：同一只元素在各面宽度不同，带上尺寸会把一条缺口拆成十几条（第一版就是这么读的） */
      const key2 = (a?.cls || b?.cls || "(无类名)");
      misses[key2] = (misses[key2] || 0) + 1;
    }
  }
  const row = { face: surface.id, elems, deltaElems, handleElems, propTotal, propDelta, propHandle,
    deltaPct: elems ? (100 * deltaElems / elems) : 0, handlePct: elems ? (100 * handleElems / elems) : 0,
    propDeltaPct: propTotal ? (100 * propDelta / propTotal) : 0,
    declaredTokens: cand.declared.length, slotsFilled: cand.slotFilled, themeRules: cand.themeRules,
    misses: Object.entries(misses).sort((x, y) => y[1] - x[1]).slice(0, 20) };
  perFace.push(row);
  console.log(`${surface.id.padEnd(12)} 画脸 ${String(row.elems).padStart(4)}  真变了 ${String(row.deltaElems).padStart(4)}=${row.deltaPct.toFixed(1)}%  有句柄 ${String(row.handleElems).padStart(4)}=${row.handlePct.toFixed(1)}%  按属性 ${row.propDeltaPct.toFixed(1)}%`);
}

const sum = (k) => perFace.reduce((a, r) => a + r[k], 0);
const agg = { cand: CAND, base: BASE, faces: perFace, elems: sum("elems"), deltaElems: sum("deltaElems"), handleElems: sum("handleElems"),
  propTotal: sum("propTotal"), propDelta: sum("propDelta"),
  deltaPct: sum("elems") ? +(100 * sum("deltaElems") / sum("elems")).toFixed(1) : 0,
  handlePct: sum("elems") ? +(100 * sum("handleElems") / sum("elems")).toFixed(1) : 0,
  propDeltaPct: sum("propTotal") ? +(100 * sum("propDelta") / sum("propTotal")).toFixed(1) : 0 };
const missAgg = {};
for (const r of perFace) for (const [k, n] of r.misses) missAgg[k] = (missAgg[k] || 0) + n;
const topMisses = Object.entries(missAgg).sort((a, b) => b[1] - a[1]).slice(0, 40);

console.log(`\n${CAND} 对基准 ${BASE}：画脸元素 ${agg.elems}（各面累加）`);
console.log(`  真变了 ${agg.deltaElems} = ${agg.deltaPct}%   ← 用户眼睛看到的"换主题到底变了多少"`);
console.log(`  有句柄 ${agg.handleElems} = ${agg.handlePct}%   ← 未来那枚 AI 主题够不够得着`);
console.log(`  按属性算真变了 ${agg.propDeltaPct}%（分母 ${agg.propTotal} 个画脸属性）`);
console.log(`\n既没变、也没句柄的（这些才是真缺口）：`);
for (const [k, n] of topMisses) console.log(`  ${k.padEnd(46)} ${n}`);
writeFileSync(new URL("./paint-coverage.json", import.meta.url), JSON.stringify(agg, null, 2) + "\n");
console.log("\n写出 .tools/paint-coverage.json（第一期不设预算线：先让缺口点名）");
ws.close();
