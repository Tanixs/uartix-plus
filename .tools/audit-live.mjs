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
 * 状态怎么摆：不靠点击链（点第几下、哪个动画没跑完都会漂），走 P104-B0 那层 dev 覆盖
 * `?theme=<id>&welcome=0[&open=settings/appearance]`。
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
 * 四面：默认工作区 + 设置窗（外观页）+ 两张浮层。
 * 浮层这两面**必须靠真事件开**（按键 / 右键），注入一个 DOM 节点出来不算——
 * 注入的浮层没有真实的定位、层叠与 backdrop，量出来的东西用户看不到。
 * `require` 是"开没开出来"的哨兵：没开出来直接抛，而不是静默少测一面（P132-E）。
 */
const SURFACES = [
  { id: "workspace", path: (t) => `/?theme=${t}&welcome=0` },
  { id: "settings", path: (t) => `/?theme=${t}&welcome=0&open=settings/appearance` },
  { id: "palette", path: (t) => `/?theme=${t}&welcome=0`, drive: "palette", require: ".cmdk" },
  /* 右键菜单那一族**这一批没进账**，原因是实测出来的而不是"以后再说"：
     `.ctx-menu` 是逐功能挂的，HexView 那条要先 `hitTest` 命中一字节序列才出菜单（无数据=不弹），
     控制画布那条要右键在网格上——固定坐标在面板开合后会点到别处，点到别处就是**静默少测一面**。
     要覆盖它得给 dev 层加一个"启动即右键某处"的入口，那是独立的一件事（记在验收 §7）。 */
];

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
async function rightClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1, buttons: 2 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1, buttons: 0 });
}
/** 浮层怎么开：命令面板是 Ctrl+Shift+P；右键菜单落在控制画布那块（实测唯一能稳定开出 `.ctx-menu` 的落点） */
async function drive(how) {
  if (how === "palette") {
    await key("P", "KeyP", 80, 2 | 8);
    await rest(550);
    return;
  }
  if (how === "ctxmenu") {
    /** 落点不写死坐标：布局一换（面板开合、窗口尺寸）死坐标就点到别处——上次就是这么"静默开不出菜单"的 */
    const at = await evaluate(`(() => {
      const el = document.querySelector('.hex-canvas') || document.querySelector('canvas');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!at) throw new Error("ctxmenu：找不到可右键的画布（Hex 数据流那面没开出来？）");
    await rightClick(at.x, at.y);
    await rest(550);
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
    hitIssues: hits.map((h) => ({ selector: h.selector, w: h.width, h: h.height })),
    hitMin: hits.length ? Math.min(...hits.map((x) => Math.min(x.width, x.height))) : null,
    overflow: over.map((o) => ({ selector: o.selector, overPx: o.overPx })),
  };
})()`;

/** selector 是人话链不是稳定身份：数字段折成 `#`，归一化后同一条取最坏值 */
const norm = (sel) => sel.replace(/\d+/g, "#");
function fold(items, key, worse) {
  const m = new Map();
  for (const it of items) {
    const k = norm(it[key] ?? it.selector);
    const cur = m.get(k);
    if (!cur || worse(it, cur)) m.set(k, { ...it, selector: k });
  }
  return [...m.values()].sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0));
}

async function collectOne(themeId, surface) {
  await goto(`${ORIGIN}${surface.path(themeId)}`);
  if (surface.drive) await drive(surface.drive);
  if (surface.require) {
    const open = await evaluate(`!!document.querySelector(${JSON.stringify(surface.require)})`);
    if (!open) throw new Error(`${themeId}/${surface.id}：浮层没开出来（找不到 ${surface.require}）——这一面不能空着记账`);
  }
  const raw = await evaluate(COLLECT);
  if (!raw || typeof raw.sampled !== "number") throw new Error(`${themeId}/${surface.id} 没采到东西`);
  const reasons = {};
  for (const r of raw.unmeasurable) reasons[r] = (reasons[r] ?? 0) + 1;
  return {
    sampled: raw.sampled,
    truncated: raw.truncated,
    styleBytes: raw.perf?.styleBytes ?? 0,
    rules: raw.perf?.rules ?? 0,
    issues: fold(raw.issues, "selector", (a, b) => a.ratio < b.ratio),
    worst: raw.issues.length ? Math.min(...raw.issues.map((i) => i.ratio)) : null,
    unmeasurable: { count: raw.unmeasurable.length, byReason: reasons },
    hitIssues: raw.hitIssues.length,
    hitMin: raw.hitMin,
    overflow: raw.overflow.length,
  };
}

/** 主题清单从页面里那枚表读，不在脚本里再抄一份（抄了就会与内置表漂） */
await goto(`${ORIGIN}/?welcome=0`);
const themes = await evaluate(`(async () => {
  const m = await import("/src/styles/builtinThemes.ts");
  return [...m.BUILTIN_THEME_IDS];
})()`);
if (!Array.isArray(themes) || themes.length < 5) throw new Error(`读到的主题清单不对：${JSON.stringify(themes)}`);

await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });

const baseline = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  viewport: VIEWPORT,
  judge: "生产同一份：src/features/agent/uiSurface.collectAuditInput + src/styles/renderAudit",
  surfaces: SURFACES.map((s) => s.id),
  themes: {},
  /** 豁免由人写、由门管：每条都要有理由，severe 一条都不许豁免（详设 §9.3） */
  exemptions: [],
};
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;

for (const id of themes) {
  baseline.themes[id] = { kind: "builtin", surfaces: {} };
  for (const s of SURFACES) {
    baseline.themes[id].surfaces[s.id] = await collectOne(id, s);
    const r = baseline.themes[id].surfaces[s.id];
    console.log(
      `${id.padEnd(8)} ${s.id.padEnd(10)} 采样 ${String(r.sampled).padStart(3)}${r.truncated ? "(截断)" : "     "} 问题 ${String(r.issues.length).padStart(2)} 最坏 ${r.worst ?? "-"} 采不出 ${r.unmeasurable.count} 命中区<24 ${r.hitIssues} 溢出 ${r.overflow}`,
    );
  }
}

/* ---- 与磁盘上那份比差：变差就是回退，回退要解释 ---- */
const regressions = [];
if (prev) {
  for (const id of Object.keys(baseline.themes)) {
    for (const s of SURFACES) {
      const now = baseline.themes[id].surfaces[s.id];
      const old = prev.themes?.[id]?.surfaces?.[s.id];
      if (!old) {
        regressions.push(`${id}/${s.id}：基线里没有这一面（新面要重新生成基线）`);
        continue;
      }
      const oldMap = new Map((old.issues ?? []).map((i) => [i.selector, i]));
      for (const i of now.issues) {
        const o = oldMap.get(i.selector);
        if (!o) regressions.push(`${id}/${s.id}：多出一条 ${i.selector} ${i.ratio}（need ${i.need}）`);
        else if (i.ratio < o.ratio - 0.005) regressions.push(`${id}/${s.id}：${i.selector} 从 ${o.ratio} 掉到 ${i.ratio}`);
      }
      if (now.hitMin != null && old.hitMin != null && now.hitMin < old.hitMin - 0.5) {
        regressions.push(`${id}/${s.id}：最小命中区从 ${old.hitMin} 掉到 ${now.hitMin}`);
      }
    }
  }
}

console.log(`\n主题 ${Object.keys(baseline.themes).length} 枚 × 面 ${SURFACES.length} 张`);
if (regressions.length) {
  console.log(`回退 ${regressions.length} 条：`);
  for (const r of regressions) console.log(`  - ${r}`);
} else if (prev) {
  console.log("与磁盘上那份比：无回退");
}

if (WRITE) {
  // 人工写过的豁免与预算跟着基线走：重新采集不该把它们冲掉，也不该让预算悄悄变大
  baseline.exemptions = prev?.exemptions ?? [];
  const measured = Object.values(baseline.themes).reduce(
    (n, e) => n + Object.values(e.surfaces).reduce((k, r) => k + r.issues.length, 0),
    0,
  );
  const old = prev?.budget?.total;
  baseline.budget = typeof old === "number" ? { total: Math.min(old, measured) } : { total: measured };
  writeFileSync(OUT, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8" });
  console.log(`已写 ${fileURLToPath(OUT)}（记账 ${measured} 条，预算 ${baseline.budget.total}）`);
} else {
  const measured = Object.values(baseline.themes).reduce(
    (n, e) => n + Object.values(e.surfaces).reduce((k, r) => k + r.issues.length, 0),
    0,
  );
  if (prev?.budget?.total > measured) {
    console.log(`提示：实测记账 ${measured} 条比基线预算 ${prev.budget.total} 低，可以把预算收紧（要显式改基线）`);
  }
}
ws.close();
if (CHECK && regressions.length) process.exit(1);
