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
 * P132-I 把同一条规矩扩到**面表**：面与浮层驱动在 `.tools/audit-faces.mjs`，
 * 类名普查（`.tools/class-census.mjs`）与这里共用一份——两本账必须跑在同一批面上。
 *
 * 用法（需要 1421 的 dev server 与 9333 的 headless Chrome/Edge，且**必须是一次性 profile**：
 * `preset=proto` 会清已存布局，拿它跑日常那个 profile 等于删人布局）：
 *   node .tools/audit-live.mjs            # 采一遍，打摘要，与磁盘上的基线比差（不改文件）
 *   node .tools/audit-live.mjs --write    # 采一遍并写 .tools/audit-baseline.json
 *   node .tools/audit-live.mjs --check    # 只判"有没有变差"，差即 exit 1（给 npm run audit:live 用）
 *   node .tools/audit-live.mjs --only=fluent,dark   # 调试用局部采集；不许配 --write，交门禁前必须跑全量
 */
const CDP_HTTP = "http://127.0.0.1:9333";
const OUT = new URL("./audit-baseline.json", import.meta.url);
const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { ORIGIN, VIEWPORT, SURFACES, assertNoDupKeys, makeSession } = await import("./audit-faces.mjs");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const CHECK = args.includes("--check");

let list = null;
try {
  list = await (await fetch(`${CDP_HTTP}/json`)).json();
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
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(`页内异常：${JSON.stringify(ex).slice(0, 300)}`);
  return r.result?.result?.value;
}
async function key(k, code, vk, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
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
/** 面表、哨兵、落点与浮层驱动都在 audit-faces：这里只决定"跑完之后量什么" */
const { goto, drive, waitOpen } = makeSession({ send, evaluate, rest, key, typeText });

/** 页内跑的就是生产那两份：采样 + 判定，一个都不另写 */
const COLLECT = `(async () => {
  const ui = await import("/src/features/agent/uiSurface.ts");
  const ra = await import("/src/styles/renderAudit.ts");
  const input = ui.collectAuditInput({ root: "body", maxSamples: 800 });
  const c = ra.auditContrast(input.textSamples);
  const hits = ra.auditHitTargets(input.hits, ra.HIT_TARGET_MIN_PX);
  const over = ra.auditOverflow(input.overflow);
  /* P151：形状三族。判定核在 renderAudit（转口自 shapeAudit），这里只调不判 */
  const shapes = [...ra.auditSquareBehindRounded(input.shapes, [innerWidth, innerHeight]), ...ra.auditShadowWithoutFace(input.shapes)];
  const parts = ra.auditInertWidgetRules(input.partRules);
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
    shapes: shapes.map((x) => ({ selector: x.key, kind: x.kind, why: x.why })),
    parts: { issues: (parts.issues || []).map((x) => ({ selector: x.rule, why: x.why })), denominator: parts.denominator, blind: parts.blind },
  };
})()`;

/** selector 是人话链不是稳定身份：数字段折成 `#`，归一化后同一条取最坏值 */
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

async function collectOne(themeId, surface) {
  /* 真事件偶发丢一次（焦点还没进文档，Ctrl+Shift+P 就没人接）：重开这一面，而不是放过这一面。
     一轮全量里中一次是实测发生的（P132-F 的 matcha/palette），把它当"覆盖到了"是假绿，
     直接抛又会让整本账因为一次抖动重跑——所以只重试**同一面**，第三次还开不出来才判红。 */
  assertNoDupKeys(surface.path(themeId), `${themeId}/${surface.id}`);
  let open = true;
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
       回退比对也就没有可对的身份（上一版正是这样，而且 `hitMin` 恒 null）。 */
    hits,
    hitMin: hits.length ? Math.min(...hits.map((h) => h.minSide)) : null,
    overflow: over,
    overflowWorst: over.length ? Math.max(...over.map((o) => o.overPx)) : null,
    shapes: fold(raw.shapes ?? [], (a, b) => a.overPx > b.overPx),
    partsDenominator: raw.parts?.denominator ?? 0,
    partsIssues: raw.parts?.issues ?? [],
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

/**
 * P150-5（P145 那条纪律的工具化）：跑量前先把这个 profile 的存档清掉。
 *
 * 为什么：dev 探针写的是**持久** localStorage（`?railw=` → `vs.rail.panel.w`、`?theme=`、`?zoom=`、
 * 导轨开合、拖分割条…）。P145 那次用 `?railw=180` 量完最窄面板，同一个一次性 profile 之后每次加载
 * 都是 180px 窄布局，于是 `audit:live` 连挂两次 `ctxmenu：.ctl-main 被盖住` 并误报 `ocean/lbx 溢出 1`——
 * 量到的是自己上一步留下的现场，而它长得非常像别人的回归。
 * 一次性 profile 这条约定挡不住"同一个 profile 上先跑过探针"，所以这里主动清，并如实报清掉了几个键。
 */
await send("Page.navigate", { url: `${ORIGIN}/?welcome=0` });
for (let i = 0; i < 60; i++) {
  if (await evaluate('!!document.querySelector(".dv-react-tab")')) break;
  await rest(200);
}
const wiped = await evaluate(`(function(){var n=localStorage.length;var k=[];for(var i=0;i<n;i++)k.push(localStorage.key(i));localStorage.clear();return JSON.stringify(k);})()`);
const keys = (() => { try { return JSON.parse(wiped); } catch { return []; } })();
console.log(`跑量前清存档：丢掉 ${keys.length} 个键${keys.length ? `（${keys.slice(0, 8).join(" ")}${keys.length > 8 ? " …" : ""}）` : ""}`);

await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });

const baseline = {
  version: 3,
  generatedAt: new Date().toISOString().slice(0, 10),
  viewport: VIEWPORT,
  judge: "生产同一份：src/features/agent/uiSurface.collectAuditInput + src/styles/renderAudit",
  faces: "面表在 .tools/audit-faces.mjs（与 class-census 共用一份）",
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
      `${id.padEnd(8)} ${s.id.padEnd(11)} 采样 ${String(r.sampled).padStart(3)}${r.truncated ? "(截断)" : "     "} 问题 ${String(r.issues.length).padStart(2)} 最坏 ${r.worst ?? "-"} 采不出 ${r.unmeasurable.count} 命中区 ${r.hits.length}${r.hitMin != null ? `(最小 ${r.hitMin})` : "     "} 溢出 ${r.overflow.length}  形状 ${r.shapes.length}`,
    );
  }
}

/* P151：C 类探测器的**分母自证**。它一条都没报，可能是因为真没有问题，也可能因为
   这批面上根本没有原生控件——后者不是通过（P146 那次就是这么假绿的）。 */
const partsSeen = Object.values(baseline.themes).reduce(
  (n, t) => n + Object.values(t.surfaces).reduce((m, r) => m + (r.partsDenominator ?? 0), 0), 0,
);
if (partsSeen === 0) console.log("注意：全批面都没扫到任何原生控件部件规则 ⇒ 形状 C 探测器这一趟没有分母，它的 0 不等于通过");

/** 三族各自的身份比对：账上存的是条目，所以"哪一条新出现/变差"都能说出来，不只有一个数 */
const FAMILIES = [
  { field: "issues", side: "ratio", worse: (a, b) => a.ratio < b.ratio - 0.005, label: "对比度", at: (i) => `${i.ratio}（需 ${i.need}）` },
  { field: "hits", side: "minSide", worse: (a, b) => a.minSide < b.minSide - 0.5, label: "命中区", at: (h) => `${h.minSide}px（需 ${h.need}）` },
  { field: "overflow", side: "overPx", worse: (a, b) => a.overPx > b.overPx + 0.5, label: "溢出", at: (o) => `溢出 ${o.overPx}px` },
  /** 形状没有"更差"这个方向（要么方底垫圆身，要么没有），所以只比身份：新出现即回退 */
  { field: "shapes", side: "kind", worse: () => false, label: "形状", at: (x) => x.why },
];

/* ---- 与磁盘上那份比差：变差就是回退，回退要解释 ---- */
const regressions = [];
if (prev && prev.version !== baseline.version) {
  // 形状换了（v1 把命中区/溢出记成"一个数"）就没法逐条对——
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
const BUDGET_KEY = { issues: "total", hits: "hitTargets", overflow: "overflow", shapes: "shapes" };

if (WRITE) {
  // 人工写过的豁免与预算跟着基线走：重新采集不该把它们冲掉，也不该让预算悄悄变大
  baseline.exemptions = prev?.exemptions ?? [];
  baseline.budget = { total: 0, hitTargets: 0, overflow: 0, shapes: 0 };
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
