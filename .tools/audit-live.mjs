/**
 * P132-C · 审计基线采集器（详设 §9）。
 *
 * 为什么要在真浏览器里跑：文字压在哪层底上是**计算样式 + 祖先背景合成**的结果
 * （`color-mix`、半透明面板色、`--fb-acrylic` 都得先落地成 rgb 才谈得上比值）。
 * 静态那道 `check-contrast` 管的是 token 层那张表，管不到"组件层改了某条规则的文字色"这一格。
 *
 * 为什么判据不另写一份：下面 `import()` 的是 vite 服务着的**生产模块本体**
 * （`collectAuditInput` 采样、`auditContrast` / `auditHitTargets` / `auditOverflow` 判定）。
 * 自己抄一份"看起来差不多"的比值算法就是制造第二真值——那扇门永远测不到产品实际会报什么。
 *
 * 用法（需要 1421 的 dev server 与 9333 的 headless Chrome/Edge）：
 *   node .tools/audit-live.mjs            # 采一遍，打摘要，与磁盘上的基线比差（不改文件）
 *   node .tools/audit-live.mjs --write    # 采一遍并写 .tools/audit-baseline.json
 *   node .tools/audit-live.mjs --check    # 只判"有没有变差"，差即 exit 1（给 npm run audit:live 用）
 *
 * 状态怎么摆：不靠点击链（点第几下、哪个动画没跑完都会漂），走 P104-B0 那层 dev 覆盖，
 * 把每一面的状态写死在 URL 里：`?theme=<id>&welcome=0&preset=proto&rail=none[&open=…][&click=…]`。
 *
 * 用法里加一条 `--only=fluent,dark`：调试时只采那几枚（一轮 63 次采集太重），**交门禁前必须跑全量**。
 */
const CDP_HTTP = "http://127.0.0.1:9333";
const ORIGIN = "http://localhost:1421";
const OUT = new URL("./audit-baseline.json", import.meta.url);
const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const CHECK = args.includes("--check");
const VIEWPORT = { w: 1440, h: 900 };

/**
 * 十面：启动态两面 + 五张浮层 + 三个"要点一下才出现"的面（P132-G）。
 * 浮层**必须靠真事件开**（按键 / 真点击 / 真右键 / 真 hover），注入一个 DOM 节点出来不算——
 * 注入的浮层没有真实的定位、层叠与 backdrop，量出来的东西用户看不到。
 * `require` 是"开没开出来"的哨兵：没开出来直接抛，而不是静默少测一面（P132-E）。
 *
 * 每一面都把状态**写死在 URL 里**（P132-F）：`preset=proto` 钉布局、`rail=none|link` 钉导轨。
 * 不钉的代价是实测撞上的——profile 里留着"接入"面板开着，于是每一面都多扫 89 个带字节点、
 * 多背 2 条命中区，同一份代码在两个 profile 上交出两本账。账要能当判据，前提是"这一面长什么样"
 * 只有一个答案；否则它记的是那台机器此刻的记忆。
 *
 * 为什么这几面以前不在账上（P132-F 实测才补上，不是"以后再说"）：
 *  - `menu`/`lbx`：dev 层早有 `?click=<选择器>`（P113），一直没拿它开浮层；`.baud-toggle`
 *    要先有「接入」面板，所以这一面单独 `rail=link`；
 *  - `ctxmenu`：右键落点从**问元素**来（旧版写死坐标，面板开合后点到别处＝静默少测一面）；
 *  - `hint`：`.help-bubble` 靠 hover，而 DOM 里前两枚 `.help-hint` 被设置整页**盖在后面**
 *    （实测 938,326 与 963,713 那两枚 `elementFromPoint` 命中的是 `set-card`/`set-content`）——
 *    照 DOM 顺序点第一枚就永远开不出泡。现在按"那个点上是不是它自己"挑目标。
 */
/** 每一面都把状态写进 URL：`preset=proto` 钉布局、`rail=none|…` 钉导轨、`welcome=…` 钉首启卡。
    三个键都只能出现一次（`assertNoDupKeys`），所以拼 URL 只能走这里，不许在外面再挂同名参数。 */
const base = (t, { extra = "", rail = "none", welcome = "0" } = {}) =>
  `/?theme=${t}&welcome=${welcome}&preset=proto&rail=${rail}${extra}`;
/** 同一个键写两遍时 `URLSearchParams.get` 只认第一个：`rail=none` 后面再挂一个 `rail=templates`
   不会覆盖它，只会让那一面**静默地"导轨没开"**（本批实测踩了一次）。所以钉住：路径里不许有重复键。 */
function assertNoDupKeys(path, id) {
  const keys = (path.replace(/^[^?]*\?/, "").match(/[^&=?]+=/g) || []).map((k) => k.slice(0, -1));
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) throw new Error(`${id}：URL 里 ${dup.join(",")} 出现了两次——后写的会被静默忽略，这一面的状态不是你以为的那个`);
}
const SURFACES = [
  { id: "workspace", path: (t) => base(t) },
  { id: "settings", path: (t) => base(t, { extra: "&open=settings/appearance" }) },
  { id: "palette", path: (t) => base(t), drive: "palette", require: ".cmdk" },
  { id: "menu", path: (t) => base(t, { extra: "&click=.cb-ws-btn" }), require: ".cb-ws-menu" },
  { id: "lbx", path: (t) => base(t, { extra: "&click=.baud-toggle", rail: "link" }), require: ".ctx-menu.lbx" },
  { id: "ctxmenu", path: (t) => base(t), drive: "ctxmenu", require: ".ctx-menu" },
  { id: "hint", path: (t) => base(t, { extra: "&open=settings/appearance" }), drive: "hint", require: ".help-bubble" },
  /* P132-G 三面：faint 当字那一族只有把面板摆出来才量得到（P132-F §7.1）。
     `model`/`speclib` 各抓到 2 条；`hovermenu` 现在是 0 条——它钉的是上一批那个结论，
     以后谁把 `.tb-menu-item:hover` 改回 `--accent`，这一面会当场多一条。 */
  { id: "model", path: (t) => base(t, { extra: "&open=settings/model" }) },
  /* `?click=` 的值里有空格（`:nth-child` 前那个后代选择器）——必须编码，
     否则 `URLSearchParams` 会把空格读成 `+`，`querySelector(".rp-seg+button…")` 直接抛，
     表现就是"这一面永远开不出来"（实测踩过：探针里手写 %20 能开，脚本里裸空格不能）。 */
  { id: "speclib", path: (t) => base(t, { extra: `&click=${encodeURIComponent(".rp-seg button:nth-child(2)")}`, rail: "templates" }), require: ".spl-list" },
  { id: "hovermenu", path: (t) => base(t, { extra: "&click=.cb-ws-btn" }), drive: "hovermenu", require: ".cb-ws-menu" },
  /* P132-H 三面：首启两张卡 + 命令面板的**空态**。
     前一批的 `palette` 面是"有结果"那一档，空态那句"没有匹配的命令"从来不进账——
     它用的正是 `--text-faint`（实测 3.64~3.77）。两张卡分开记：卡 1 有管线示意（那条 +5px 溢出在它身上），
     卡 2 有截图与徽标，两身的文字位不一样。`welcome=1|2` 是 dev 入口，会把"已看过"标记清掉，
     所以这三面**必须**用一次性 profile（脚本头那条规矩同 `preset=`）。 */
  { id: "welcome1", path: (t) => base(t, { welcome: "1" }), require: ".wlc-body" },
  { id: "welcome2", path: (t) => base(t, { welcome: "2" }), require: ".wlc-body" },
  { id: "cmdk-empty", path: (t) => base(t), drive: "cmdkEmpty", require: ".cmdk-empty" },
];

/** 哨兵问的是"看得见的一张浮层"，不是"DOM 里有没有这个类"：屏外的隐藏实例（如列树那份）不算开出来 */
const OPEN_CHECK = (sel) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  return els.some((e) => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"
      && r.width > 8 && r.height > 8 && r.left > -100 && r.top > -100;
  });
})()`;


let list = null;
try {
  const r = await fetch(`${CDP_HTTP}/json`);
  list = await r.json();
} catch {
  list = null;
}
if (!Array.isArray(list)) {
  console.error(
    `连不上 ${CDP_HTTP}。这一步要有真浏览器：\n  npx vite --port 1421 --strictPort\n  msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<一次性目录> http://localhost:1421/`,
  );
  process.exit(1);
}
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("9333 上没有页（上面那条 msedge 命令带 URL 启动即可）");
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
async function key(k, code, vk, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
}
/** 落点从"问到元素"来：写死坐标在面板开合后会点到别处，点到别处＝静默少测一面。
    还要那个点上落得下它——被别的层盖住的元素（设置整页身后的工作区）派发不出真事件。
    `el.contains(hit)` 而不是 `hit === el`：容器类的落点（`.ctl-main`）中心往往是自己的孩子。 */
async function clickableCenter(sel) {
  return hoverableCenter(sel, 0);
}
/** 第 n 枚"落得下鼠标"的元素中心（选中态那一族要的是"把鼠标停在某一项上"） */
async function hoverableCenter(sel, n) {
  return evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = els[${n}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) return null;
    return { x, y };
  })()`);
}
async function rightClickOn(sel, label) {
  const at = await clickableCenter(sel);
  if (!at) throw new Error(`${label}：${sel} 不存在、太小或被盖住，右键点不到——这一面不能空着记账`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", clickCount: 1, buttons: 2 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", clickCount: 1, buttons: 0 });
  await rest(450);
}
async function hoverAt(at) {
  // 先从上方移进来：没有"进入"这一步就没有 mouseover/mouseenter，React 的 onMouseEnter 不会跑
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y - 24, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
  await rest(450);
}
/** 往焦点里打字：`keyDown` 带 `text` 才真的落字符（`Input.insertText` 不发 key 事件，React 收不到） */
async function typeText(s) {
  for (const ch of s) {
    const up = ch.toUpperCase();
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: "Key" + up, windowsVirtualKeyCode: up.charCodeAt(0), text: ch, unmodifiedText: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "Key" + up, windowsVirtualKeyCode: up.charCodeAt(0) });
    await rest(30);
  }
}
/** 浮层怎么开：命令面板是 Ctrl+Shift+P（真按键）；右键菜单落在控制画布那块；提示泡要真 hover */
async function drive(how) {
  if (how === "palette") {
    await key("P", "KeyP", 80, 2 | 8);
    await rest(550);
    return;
  }
  if (how === "cmdkEmpty") {
    // 先等面板真开出来再打字：不等的结果是字符落进工作区，"空态"这一面就成了假面
    await key("P", "KeyP", 80, 2 | 8);
    if (!(await waitOpen(".cmdk"))) throw new Error("cmdkEmpty：命令面板没开出来，空态无从谈起");
    await typeText("qqqzzz");
    await rest(450);
    return;
  }
  if (how === "ctxmenu") { await rightClickOn(".ctl-main", "ctxmenu"); return; }
  if (how === "hovermenu") {
    // 先等菜单开出来再移鼠标：`?click=` 是挂载后 1400ms 才点的，先移后等就是拿时序赌
    if (!(await waitOpen(".cb-ws-menu"))) throw new Error("hovermenu：菜单没开出来，悬停档无从谈起");
    const at = await hoverableCenter(".tb-menu-item", 1);
    if (!at) throw new Error("hovermenu：第 2 枚 .tb-menu-item 落不下鼠标——这一面不能空着记账");
    await hoverAt(at);
    return;
  }
  if (how === "hint") {
    /* 逐枚挑"点得到的那一枚"：DOM 里第一枚 `.help-hint` 实测在设置整页**身后**
       （938,326 那枚 elementFromPoint 命中的是 set-card），照 DOM 顺序点第一枚就永远开不出泡。 */
    const at = await evaluate(`(() => {
      const els = [...document.querySelectorAll(".help-hint")];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        if (document.elementFromPoint(x, y) === el) return { x, y, n: els.length };
      }
      return { n: els.length };
    })()`);
    if (!at || at.x === undefined) {
      throw new Error(`hint：${at?.n ?? 0} 枚 .help-hint 没有一枚点得到（全被盖住？）——这一面不能空着记账`);
    }
    await hoverAt(at);
    return;
  }
  throw new Error(`不认识的驱动方式：${how}`);
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(`页内异常：${JSON.stringify(ex).slice(0, 300)}`);
  return r.result?.result?.value;
}

async function goto(url) {
  await send("Page.navigate", { url });
  // 等到外壳真的画出来（.titlebar 是宿主自己的，.dv-react-tab 是 dockview 摆好布局的），
  // 再给一点时间：布局没摆完时采到的盒子尺寸是假的
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate(`!!document.querySelector(".titlebar") && !!document.querySelector(".dv-react-tab")`);
    if (ready) break;
    await rest(200);
  }
  await rest(1200);
}

/** 页内跑的就是生产那两份：采样 + 判定，一个都不另写 */
const COLLECT = `(async () => {
  const ui = await import("/src/features/agent/uiSurface.ts");
  const ra = await import("/src/styles/renderAudit.ts");
  const input = ui.collectAuditInput({ root: "body", maxSamples: 800 });
  const c = ra.auditContrast(input.textSamples);
  const hits = ra.auditHitTargets(input.hits, ra.HIT_TARGET_MIN_PX);
  const over = ra.auditOverflow(input.overflow);
  const fgs = input.textSamples.map((s) => s.fg).filter(Boolean).length;
  return {
    sampled: input.visited,
    truncated: input.truncated,
    withFg: fgs,
    perf: input.perf,
    issues: c.issues.map((i) => ({ selector: i.selector, ratio: i.ratio, need: i.need, fg: i.fg, bg: i.bg, severe: i.severe })),
    unmeasurable: c.unmeasurable.map((u) => u.reason),
    /** 字段名直接抄判据返回的那份（HitIssue 是 minSide/need，不是 width/height）：
        上一版在这里手写 \`h.width/h.height\`，采出来全是 undefined，JSON 落盘时静默丢字段，
        \`hitMin\` 于是恒为 null——命中区那一族账上看着有数，其实一条都没记下来（P132-F 实测）。 */
    hits: hits.map((h) => ({ selector: h.selector, minSide: h.minSide, need: h.need })),
    overflow: over.map((o) => ({ selector: o.selector, overPx: o.overPx })),
  };
})()`;

/** selector 是人话链不是稳定身份：数字段折成 \`#\`，归一化后同一条取最坏值 */
const norm = (sel) => sel.replace(/\d+/g, "#");
function fold(items, worse) {
  const m = new Map();
  for (const it of items) {
    const k = norm(it.selector);
    const cur = m.get(k);
    if (!cur || worse(it, cur)) m.set(k, { ...it, selector: k });
  }
  return [...m.values()];
}

/** 轮询哨兵：`?click=` 那枚 dev 入口是挂载后 1400ms 才点的，只看一眼会把"还没点开"误判成"开不出来"。 */
async function waitOpen(sel, ms = 6000) {
  const expr = OPEN_CHECK(sel);
  for (let waited = 0; waited < ms; waited += 200) {
    if (await evaluate(expr)) return true;
    await rest(200);
  }
  return false;
}

async function collectOne(themeId, surface) {
  /* 真事件偶发丢一次（焦点还没进文档，Ctrl+Shift+P 就没人接）：重开这一面，而不是放过这一面。
     一轮全量里中一次是实测发生的（P132-F 的 matcha/palette），把它当"覆盖到了"是假绿，
     直接抛又会让整本账因为一次抖动重跑——所以只重试**同一面**，第三次还开不出来才判红。 */
  let open = true;
  assertNoDupKeys(surface.path(themeId), `${themeId}/${surface.id}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await goto(`${ORIGIN}${surface.path(themeId)}`);
    if (surface.drive) await drive(surface.drive);
    open = !surface.require || (await waitOpen(surface.require));
    if (open) break;
    if (attempt < 3) console.log(`  · ${themeId}/${surface.id} 第 ${attempt} 次没开出 ${surface.require}，重开这一面`);
  }
  if (!open) throw new Error(`${themeId}/${surface.id}：浮层没开出来（三次都找不到看得见的 ${surface.require}）——这一面不能空着记账`);
  const raw = await evaluate(COLLECT);
  if (!raw || typeof raw.sampled !== "number") throw new Error(`${themeId}/${surface.id} 没采到东西`);
  const reasons = {};
  for (const r of raw.unmeasurable) reasons[r] = (reasons[r] ?? 0) + 1;
  const issues = fold(raw.issues, (a, b) => a.ratio < b.ratio).sort((a, b) => a.ratio - b.ratio);
  const hits = fold(raw.hits, (a, b) => a.minSide < b.minSide).sort((a, b) => a.minSide - b.minSide);
  const over = fold(raw.overflow, (a, b) => a.overPx > b.overPx).sort((a, b) => b.overPx - a.overPx);
  return {
    sampled: raw.sampled,
    truncated: raw.truncated,
    styleBytes: raw.perf?.styleBytes ?? 0,
    rules: raw.perf?.rules ?? 0,
    issues,
    worst: issues.length ? Math.min(...issues.map((i) => i.ratio)) : null,
    unmeasurable: { count: raw.unmeasurable.length, byReason: reasons },
    /** 命中区与溢出都记**条目**不记条数：只记条数的话，"哪一颗控件变小了"这条信息在账上不存在，
       回退比对也就没有可对的身份（上一版正是这样，而且 \`hitMin\` 恒 null）。 */
    hits,
    hitMin: hits.length ? Math.min(...hits.map((h) => h.minSide)) : null,
    overflow: over,
    overflowWorst: over.length ? Math.max(...over.map((o) => o.overPx)) : null,
  };
}

/** 主题清单从页面里那枚表读，不在脚本里再抄一份（抄了就会与内置表漂） */
await goto(`${ORIGIN}/?welcome=0`);
const themes = await evaluate(`(async () => {
  const m = await import("/src/styles/builtinThemes.ts");
  return [...m.BUILTIN_THEME_IDS];
})()`);
if (!Array.isArray(themes) || themes.length < 5) throw new Error(`读到的主题清单不对：${JSON.stringify(themes)}`);
/** 调试用的局部采集：认不出来的名字直接抛，别让它静默变成"采了个空集所以全绿" */
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length)?.split(",").filter(Boolean);
const want = only?.length ? only : themes;
for (const id of want) {
  if (!themes.includes(id)) throw new Error(`--only= 里的 ${id} 不在内置主题表里（拼错了？还是主题下架了？）`);
}
const pick = want;
if (WRITE && only) throw new Error("--only= 是调试用的局部采集，不许 --write：那会把没采到的主题从账里删掉");

await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });

const baseline = {
  version: 2,
  generatedAt: new Date().toISOString().slice(0, 10),
  viewport: VIEWPORT,
  judge: "生产同一份：src/features/agent/uiSurface.collectAuditInput + src/styles/renderAudit",
  surfaces: SURFACES.map((s) => s.id),
  themes: {},
  /** 豁免由人写、由门管：每条都要有理由，severe 一条都不许豁免（详设 §9.3） */
  exemptions: [],
};
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;

for (const id of pick) {
  baseline.themes[id] = { kind: "builtin", surfaces: {} };
  for (const s of SURFACES) {
    baseline.themes[id].surfaces[s.id] = await collectOne(id, s);
    const r = baseline.themes[id].surfaces[s.id];
    console.log(
      `${id.padEnd(8)} ${s.id.padEnd(10)} 采样 ${String(r.sampled).padStart(3)}${r.truncated ? "(截断)" : "     "} 问题 ${String(r.issues.length).padStart(2)} 最坏 ${r.worst ?? "-"} 采不出 ${r.unmeasurable.count} 命中区 ${r.hits.length}${r.hitMin != null ? `(最小 ${r.hitMin})` : "     "} 溢出 ${r.overflow.length}`,
    );
  }
}

/** 三族各自的身份比对：账上存的是条目，所以"哪一条新出现/变差"都能说出来，不只有一个数 */
const FAMILIES = [
  { field: "issues", side: "ratio", worse: (a, b) => a.ratio < b.ratio - 0.005, label: "对比度", at: (i) => `${i.ratio}（需 ${i.need}）` },
  { field: "hits", side: "minSide", worse: (a, b) => a.minSide < b.minSide - 0.5, label: "命中区", at: (h) => `${h.minSide}px（需 ${h.need}）` },
  { field: "overflow", side: "overPx", worse: (a, b) => a.overPx > b.overPx + 0.5, label: "溢出", at: (o) => `溢出 ${o.overPx}px` },
];

/* ---- 与磁盘上那份比差：变差就是回退，回退要解释 ---- */
const regressions = [];
if (prev && prev.version !== baseline.version) {
  // v1 那本把命中区/溢出记成"一个数"，与这一版的"一组条目"没法逐条对——
  // 与其假装能比（或者更坏：因为读不出旧字段而比出"无回退"），不如明说这一趟没有对照。
  console.log(`注意：磁盘上的基线是 version ${prev.version}，这一版写的是 ${baseline.version}（形状换了），本轮不做回退比对；--write 之后下一轮才有线可拉`);
} else if (prev) {
  for (const id of Object.keys(baseline.themes)) {
    for (const s of SURFACES) {
      const now = baseline.themes[id].surfaces[s.id];
      const old = prev.themes?.[id]?.surfaces?.[s.id];
      if (!old) {
        regressions.push(`${id}/${s.id}：基线里没有这一面（新面要重新生成基线）`);
        continue;
      }
      for (const f of FAMILIES) {
        const oldMap = new Map((old[f.field] ?? []).map((x) => [x.selector, x]));
        for (const x of now[f.field]) {
          const o = oldMap.get(x.selector);
          if (!o) regressions.push(`${id}/${s.id}：${f.label}多出一条 ${x.selector} ${f.at(x)}`);
          else if (f.worse(x, o)) regressions.push(`${id}/${s.id}：${f.label} ${x.selector} 从 ${o[f.side]} 变差到 ${x[f.side]}`);
        }
      }
    }
  }
}

console.log(`\n主题 ${Object.keys(baseline.themes).length} 枚 × 面 ${SURFACES.length} 张`);
if (regressions.length) {
  console.log(`回退 ${regressions.length} 条：`);
  for (const r of regressions) console.log(`  - ${r}`);
} else if (prev && prev.version === baseline.version) {
  console.log("与磁盘上那份比：无回退");
}

const measured = {};
for (const f of FAMILIES) {
  measured[f.field] = Object.values(baseline.themes).reduce(
    (n, e) => n + Object.values(e.surfaces).reduce((k, r) => k + (r[f.field]?.length ?? 0), 0),
    0,
  );
}
/** 预算的名字与账上的族对齐：issues→total、hits→hitTargets、overflow→overflow */
const BUDGET_KEY = { issues: "total", hits: "hitTargets", overflow: "overflow" };

if (WRITE) {
  // 人工写过的豁免与预算跟着基线走：重新采集不该把它们冲掉，也不该让预算悄悄变大
  baseline.exemptions = prev?.exemptions ?? [];
  baseline.budget = { total: 0, hitTargets: 0, overflow: 0 };
  for (const f of FAMILIES) {
    const k = BUDGET_KEY[f.field];
    const old = prev?.budget?.[k];
    // 族第一次进账时旧基线没有这一格：拿实测值起线，而不是拿 0 假装"从来就是 0"
    baseline.budget[k] = typeof old === "number" ? Math.min(old, measured[f.field]) : measured[f.field];
  }
  writeFileSync(OUT, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8" });
  console.log(
    `已写 ${fileURLToPath(OUT)}（实测 对比度 ${measured.issues} / 命中区 ${measured.hits} / 溢出 ${measured.overflow}，预算 ${JSON.stringify(baseline.budget)}）`,
  );
} else {
  const looser = FAMILIES.filter((f) => typeof prev?.budget?.[BUDGET_KEY[f.field]] === "number" && prev.budget[BUDGET_KEY[f.field]] > measured[f.field]);
  for (const f of looser) {
    console.log(`提示：${f.label}实测 ${measured[f.field]} 条比基线预算 ${prev.budget[BUDGET_KEY[f.field]]} 低，可以把预算收紧（要显式改基线）`);
  }
}
ws.close();
if (CHECK && regressions.length) process.exit(1);
