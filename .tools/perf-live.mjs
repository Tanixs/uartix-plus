/**
 * P156-B2 · 高频前端活体仪表（手动跑，不进 check:all——帧率做常开门必抖）。
 *
 * 为什么要在**真应用**里跑：浏览器里没有 Tauri `invoke`，`parser:frames` 这条 IPC
 * 根本不存在，帧总线之后的整段（Rust 解码 → binbus → 各面板）都覆盖不到。
 * 所以这里连的是 `pnpm tauri dev` 的 WebView2 远程调试口（9333），走真 IPC。
 *
 * 用法（一次一档；`--spawn` 会自己拉应用并在结束时收掉）：
 *   node .tools/perf-live.mjs --hz=10   --minutes=2 --spawn
 *   node .tools/perf-live.mjs --hz=500  --minutes=5 --spawn
 *   node .tools/perf-live.mjs --hz=2000 --minutes=5 --spawn
 *   node .tools/perf-live.mjs --hz=2000 --minutes=3 --preset=3d --spawn
 *
 * 关键开关：
 *   --hz        UARTIX_DEMO_HZ（只在 --spawn 时生效：环境变量在进程启动时读一次）
 *   --preset    base（默认布局）| 3d（额外 open=panel/view3d）
 *   --attach    连已开的 9333（不 spawn）；默认是 attach，--spawn 才拉应用
 *   --keep      --spawn 结束时不杀应用（留给人肉看现场）
 *
 * 分母自证：帧收发数从生产的 `framesBus` 订阅（不是"看页面卡不卡"），
 * 各面板渲染量从各自 store 读：table=framesStore.rows/maxRows、console=DOM 块数、
 * plot=plotStore 每通道点数/上限、hex=serialStore.rxTotal。面板没开就记 null，
 * 不编一个"0 = 通过"。
 *
 * 已知边界：窗口被最小化/遮挡时 rAF 会被节流——快照里带 visibility，报告要一起看。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const HZ = Number(opt("hz", "10"));
const MINUTES = Number(opt("minutes", "2"));
const PRESET = opt("preset", "base");
const PANEL = opt("panel", "");
const PORT = Number(opt("port", "9333"));
const APP = opt("app", "http://localhost:1420");
const OUT = opt("out", `.tmp/p156/perf-${HZ}hz-${PRESET}.json`);
const SPAWN = args.includes("--spawn");
const KEEP = args.includes("--keep");

if (!Number.isFinite(HZ) || HZ < 1 || HZ > 5000) throw new Error("--hz 需 1..5000");
if (!Number.isFinite(MINUTES) || MINUTES <= 0) throw new Error("--minutes 需 > 0");
if (!["base", "3d"].includes(PRESET)) throw new Error("--preset 只认 base | 3d");

let appProc = null;
if (SPAWN) {
  console.log(`spawn: tauri dev（UARTIX_DEMO_HZ=${HZ}，调试口 ${PORT}）`);
  /* 直接跑 @tauri-apps/cli 的入口，不走 `pnpm tauri`：pnpm 在执行脚本前会做一次
     依赖状态自检并 auto `pnpm install`，本机因 esbuild 构建脚本未批准直接 exit 1
     （ERR_PNPM_IGNORED_BUILDS）——那是环境账，不该记到应用头上。 */
  appProc = spawn(process.execPath, ["node_modules/@tauri-apps/cli/tauri.js", "dev"], {
    cwd: ROOT,
    // CARGO_BUILD_JOBS=1：本机上并发 rustc 会把提交内存吃穿（os error 1455 实测），
    // 串行只是慢一点，不会把"环境失败"记到产品头上
    env: {
      ...process.env,
      UARTIX_DEMO_HZ: String(HZ),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

const rest = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page" && String(t.url).startsWith(APP));
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await rest(1000);
  }
  throw new Error(
    `等不到 ${APP} 的调试页（${PORT}/json）：${lastErr?.message ?? "超时"}。` +
      (SPAWN ? "看上面 tauri dev 的日志。" : "先开应用，或加 --spawn。"),
  );
}

const page = await findPage(SPAWN ? 600_000 : 30_000);
console.log(`连上：${page.url}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let seq = 0;
const pending = new Map();
/** CDP 异常事件（Runtime.exceptionThrown）：页内监听抓不到"模块加载期崩"这类，两条都要 */
const cdpExceptions = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    cdpExceptions.push(String(m.params?.exceptionDetails?.text ?? "").slice(0, 200));
  }
  // 应用有 beforeunload（未保存协议模板）会顶住导航：不接这个事件，Page.navigate
  // 就永远等不到回包（P156-B2 实测 20s 超时）。自动放行是审计脚本该做的事——
  // 这不是"替用户点确定"，是"别让一个确认框把仪表挂死"。
  if (m.method === "Page.javascriptDialogOpening") {
    ws.send(JSON.stringify({ id: ++seq, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
  }
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++seq;
    // 不带超时的 CDP send 会挂死：WebView2 侧偶发丢一次回包（P156-B2 首跑实测
    // 卡在采样循环超过 10 分钟无输出），没有 reject 的 Promise 就是永久等待。
    const timer = setTimeout(() => {
      pending.delete(n);
      rej(new Error(`CDP ${method} 20s 没回包`));
    }, 20_000);
    pending.set(n, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(`页内异常：${JSON.stringify(ex).slice(0, 400)}`);
  return r.result?.result?.value;
}

await send("Runtime.enable");
await send("Performance.enable");
await send("Page.enable");

// ---- 导航到干净入口；3d 档额外开一个 3D 面板 ----
const url = `${APP}/?welcome=0${PRESET === "3d" ? "&open=panel/view3d" : ""}`;
const here = await evaluate("location.href");
if (here === url) {
  console.log("已在目标页：跳过导航（beforeunload 拦不住的一次省下），仪表直接重装");
} else {
  await send("Page.navigate", { url });
}
let ready = false;
for (let i = 0; i < 120; i++) {
  if (await evaluate('!!document.querySelector(".dv-tab")')) {
    ready = true;
    break;
  }
  await rest(500);
}
if (!ready) throw new Error("应用没起来：120 次轮询里都没看到 dockview 面板");

/**
 * 装仪表 + 用**生产路径**拉起演示源：loadDemoRules()（协议预设）+ toggleDemo()（demo_start）。
 * 不直接用 `__TAURI_INTERNALS__.invoke`：那会绕过 UI 的那套状态同步（demoRunning 等），
 * 之后"停止"就停不干净了。
 */
const START = `(async () => {
  const st = window.__p156 ?? (window.__p156 = {});
  st.rows = 0; st.bytes = 0; st.byTpl = {}; st.byTplInvalid = {}; st.invalid = 0; st.frameEvents = 0;
  st.errors = []; st.longMs = 0; st.longMax = 0; st.longTasks = 0; st.raf = 0;
  st.t0 = performance.now(); st.active = true; st.longtaskUnsupported = false;
  if (st.off) { st.off(); st.off = null; }
  const fb = await import("/src/ipc/framesBus.ts");
  const ts = await import("/src/features/protocol/templateStore.ts");
  const pr = await import("/src/features/framecanvas/presets.ts");
  st.off = fb.onFrames((p) => {
    st.frameEvents++;
    st.rows += p.rows.length;
    for (const r of p.rows) {
      st.bytes += r.len;
      if (!r.valid) {
        st.invalid++;
        st.byTplInvalid[r.tplId] = (st.byTplInvalid[r.tplId] ?? 0) + 1;
      }
      st.byTpl[r.tplId] = (st.byTpl[r.tplId] ?? 0) + 1;
    }
  });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        st.longTasks++;
        st.longMs += e.duration;
        st.longMax = Math.max(st.longMax, e.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch { st.longtaskUnsupported = true; }
  window.addEventListener("error", (e) => st.errors.push(String(e.message).slice(0, 200)));
  window.addEventListener("unhandledrejection", (e) => st.errors.push("rejection: " + String(e.reason).slice(0, 200)));
  const loop = () => { if (!st.active) return; st.raf++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  /* 归档里每跑一次 applyPreset 就多一代同名预设副本（上一轮实测叠到 4 代同锚同一批
     字节 = 四倍重复解析，坏帧洪水就是这么来的）。这里按「族 + 代号」只开第一代，
     其余组（含历史遗留的 demo-a/b、csv-*）全关——不删，删会弹一堆通知。 */
  const allow = ["ano-v7", "wit-imu"];
  const genOf = (t) => String(t.id).split("-")[1] ?? "";
  const effOf = (t) => (t.presetKey ?? t.id) + "|" + genOf(t);
  const firstGen = new Map();
  for (const t of ts.getSnapshot().rules.templates) {
    const k = t.presetKey ?? t.id;
    if (allow.includes(k) && !firstGen.has(k)) firstGen.set(k, genOf(t));
  }
  const seen = new Set();
  for (const t of ts.getSnapshot().rules.templates) {
    const ek = effOf(t);
    if (seen.has(ek)) continue;
    seen.add(ek);
    const k = t.presetKey ?? t.id;
    const want = allow.includes(k) && firstGen.get(k) === genOf(t);
    ts.setGroupEnabled(ek, want, (x) => effOf(x));
  }
  // 允许族里一个都没有才现导（幂等：重复跑不会叠副本）
  const have = new Set(ts.getSnapshot().rules.templates.map((t) => t.presetKey ?? t.id));
  for (const key of ["ano-v7", "wit-imu"]) {
    if (!have.has(key)) {
      const def = pr.PRESETS.find(p => p.key === key);
      if (def) pr.applyPreset(def);
    }
  }
  await new Promise(r => setTimeout(r, 800));
  /* 2D 曲线默认没有通道（用户手点才有数据），分母会是空的。这里按生产入口
     addChannel 挂前几路数采字段——只挑 V7/WIT 模板：Modbus 组那批在混流里有
     大量坏帧，挂它们的字段等于挂了个空曲线。 */
  let added = 0;
  try {
    const ps = await import("/src/features/plot/plotStore.ts");
    const numeric = ["float32", "float64", "int16", "uint16", "int32", "uint32"];
    for (const t of ts.getSnapshot().rules.templates) {
      if (!t.enabled) continue;
      if (!(String(t.name).includes("V7") || String(t.name).includes("WIT"))) continue;
      for (const f of (t.fields || [])) {
        if (added >= 8) break;
        if (f.role === "data" && numeric.includes(f.type)) {
          if (ps.addChannel({ tplId: t.id, fieldId: f.id, name: t.name + "·" + f.name, color: "#4e9cef" })) added++;
        }
      }
      if (added >= 8) break;
    }
  } catch {}
  st.channelsAdded = added;
  try {
    if (!ts.getSnapshot().demoRunning) await ts.toggleDemo();
  } catch (e) {
    /* 上一次会话被中断（页面刷新但 Rust 演示线程还活着）：前端快照说没跑、
       Rust 说已在跑，toggleDemo 会拿到"已在运行"。用原生 stop 对齐两侧再起。 */
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!inv) throw e;
    await inv("demo_stop");
    await new Promise(r => setTimeout(r, 400));
    await ts.toggleDemo();
  }
  return {
    demoRunning: ts.getSnapshot().demoRunning,
    channelsAdded: added,
    tplCount: ts.getSnapshot().rules.templates.length,
    panels: [...document.querySelectorAll(".dv-tab")].map(x => x.textContent.trim()),
  };
})()`;
const started = await evaluate(START);
console.log(`演示源：${started.demoRunning ? "运行中" : "没启动"}；面板：${started.panels.join(" / ")}`);
if (!started.demoRunning) throw new Error("toggleDemo 之后 demoRunning 仍是 false");

/* --panel=Hex：切到指定面板再测（Hex 等画布面板只有在前台才走取数/重绘） */
if (PANEL) {
  const hit = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".dv-tab")].find((x) => x.textContent.includes(${JSON.stringify(PANEL)}));
    if (!tab) return null;
    tab.click();
    return tab.textContent.trim();
  })()`);
  console.log(hit ? `已切面板：${hit}` : `未找到面板：${PANEL}`);
  await rest(1200);
}

// 等第一批帧真的到前端（不然 5 秒采样全 0 会读成"很流畅"）
for (let i = 0; i < 40; i++) {
  const n = await evaluate("window.__p156.frameEvents");
  if (n > 0) break;
  await rest(500);
}
if (!((await evaluate("window.__p156.frameEvents")) > 0)) {
  throw new Error("10 秒内一帧都没到 framesBus：分母是 0，这一趟不算数");
}

const SNAP = `(async () => {
  const st = window.__p156;
  const el = performance.now() - st.t0;
  let table = null;
  try {
    const m = await import("/src/features/table/framesStore.ts");
    const s = m.getSnapshot();
    table = { rows: s.rows.length, maxRows: s.maxRows, capped: s.capped, paused: s.paused };
  } catch {}
  let plot = null;
  try {
    const m = await import("/src/features/plot/plotStore.ts");
    const chans = m.getSnapshot().channels.map(c => ({ id: c.id, points: m.getChanData(c.id).t.length }));
    plot = {
      channels: chans.length,
      pointsMax: chans.length ? Math.max(...chans.map(c => c.points)) : 0,
      pointsSum: chans.reduce((n, c) => n + c.points, 0),
      cap: m.MAX_POINTS,
    };
  } catch {}
  let hex = null;
  try {
    const m = await import("/src/features/serial/serialStore.ts");
    hex = { rxTotal: m.getSnapshot().rxTotal };
  } catch {}
  /* P159：发送端与接收端计数对照。Rust 还在发、JS 停收 ⇒ 通道层堵；
     Rust 入队也停 ⇒ send 本身阻塞。 */
  let ipc = null;
  try { ipc = await window.__TAURI_INTERNALS__?.invoke("ipc_stats"); } catch {}
  let bus = null;
  try { bus = (await import("/src/ipc/binbus.ts")).ipcStats(); } catch {}
  return {
    elMs: Math.round(el),
    raf: st.raf,
    frames: { events: st.frameEvents, rows: st.rows, bytes: st.bytes, invalid: st.invalid, byTpl: st.byTpl, byTplInvalid: st.byTplInvalid },
    pageErrors: st.errors.slice(0, 20),
    longTasks: st.longTasks,
    longMs: Math.round(st.longMs),
    longMax: Math.round(st.longMax),
    longtaskUnsupported: st.longtaskUnsupported,
    consoleBlocks: document.querySelector(".console-view")?.childElementCount ?? null,
    table, plot, hex, ipc, bus,
    visibility: document.visibilityState,
    panels: [...document.querySelectorAll(".dv-tab")].map(x => x.textContent.trim()),
  };
})()`;

const samples = [];
const totalSamples = Math.max(1, Math.round((MINUTES * 60) / 5));
let prev = null;
let consecutiveFails = 0;
for (let i = 0; i < totalSamples; i++) {
  let snap;
  let metrics;
  try {
    snap = await evaluate(SNAP);
    metrics = (await send("Performance.getMetrics")).result?.metrics ?? [];
    consecutiveFails = 0;
  } catch (e) {
    consecutiveFails++;
    console.error(`第 ${i + 1}/${totalSamples} 个采样失败（连续 ${consecutiveFails}）：${e.message}`);
    if (consecutiveFails >= 3) {
      console.error("连续三次采不到：结束这一趟（已采到的照样写盘，别把半截账丢掉）");
      break;
    }
    await rest(5000);
    i--; // 这一格没采到，补一格（总时长因此顺延）
    continue;
  }
  const mv = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  const row = {
    at: new Date().toISOString(),
    tSec: Math.round(snap.elMs / 1000),
    fps: prev ? +(((snap.raf - prev.raf) / (snap.elMs - prev.elMs)) * 1000).toFixed(1) : null,
    rows: snap.frames.rows,
    rowsPerSec: prev ? +(((snap.frames.rows - prev.frames.rows) / (snap.elMs - prev.elMs)) * 1000).toFixed(1) : null,
    bytes: snap.frames.bytes,
    invalid: snap.frames.invalid,
    longTasks: snap.longTasks,
    longMs: snap.longMs,
    longMax: Math.round(snap.longMax),
    jsHeapMB: Math.round(((mv.JSHeapUsedSize ?? 0) / 1048576) * 10) / 10,
    nodes: mv.Nodes ?? null,
    taskDuration: mv.TaskDuration != null ? Math.round(mv.TaskDuration * 1000) : null,
    consoleBlocks: snap.consoleBlocks,
    tableRows: snap.table?.rows ?? null,
    plotPointsMax: snap.plot?.pointsMax ?? null,
    hexRx: snap.hex?.rxTotal ?? null,
    ipcOut: snap.ipc?.framesOut ?? null,
    ipcIn: snap.ipc?.framesIn ?? null,
    ipcRowsOut: snap.ipc?.framesRowsOut ?? null,
    ipcSendUs: snap.ipc?.sendUs ?? null,
    ipcSendErr: snap.ipc?.sendErr ?? null,
    ipcStage: snap.ipc?.ingestStage ?? null,
    demoStage: snap.ipc?.demoStage ?? null,
    demoTick: snap.ipc?.demoTick ?? null,
    hexFetches: snap.ipc?.hexFetches ?? null,
    hexFetchMs: snap.ipc?.hexFetchUs != null ? Math.round(snap.ipc.hexFetchUs / 1000) : null,
    spanScans: snap.ipc?.spanScans ?? null,
    hexFetchDelta:
      prev && snap.ipc && prev.ipc ? snap.ipc.hexFetches - prev.ipc.hexFetches : null,
    spanScanDelta:
      prev && snap.ipc && prev.ipc ? snap.ipc.spanScans - prev.ipc.spanScans : null,
    busMsgs: snap.bus?.msgs ?? null,
    busGap: snap.bus?.maxGapMs != null ? Math.round(snap.bus.maxGapMs) : null,
    visibility: snap.visibility,
  };
  prev = snap;
  samples.push(row);
  console.log(
    `t=${String(row.tSec).padStart(4)}s fps=${String(row.fps ?? "-").padStart(5)} 行/s=${String(row.rowsPerSec ?? "-").padStart(7)} ` +
      `行=${row.rows} 堆=${row.jsHeapMB}MB 长任务=${row.longTasks}(${row.longMs}ms max ${row.longMax}) ` +
      `console=${row.consoleBlocks} table=${row.tableRows} plotMax=${row.plotPointsMax} hex=${row.hexRx} ` +
      `ipcOut=${row.ipcOut}/${row.ipcIn} bus=${row.busMsgs} gap=${row.busGap} stage=${row.ipcStage} demo=${row.demoStage}@${row.demoTick} ` +
      `hexFetch=${row.hexFetchDelta} scan=${row.spanScanDelta} ${row.visibility}`,
  );
  if (i < totalSamples - 1) await rest(5000);
}

const last = samples[samples.length - 1];
const first = samples[0];
let final = prev;
try {
  final = await evaluate(SNAP);
} catch (e) {
  console.error(`收尾快照取不到（${e.message}），用最后一次成功的`);
}
if (!final) throw new Error("一个采样都没成功：这一趟没有账可记");

// 收尾：停演示源、摘订阅（--keep 时也停——留着它只是"别杀应用进程"）
const STOP = `(async () => {
  try {
    const ts = await import("/src/features/protocol/templateStore.ts");
    if (ts.getSnapshot().demoRunning) await ts.toggleDemo();
  } catch {}
  if (window.__p156?.active) {
    window.__p156.active = false;
    if (window.__p156.off) { window.__p156.off(); window.__p156.off = null; }
  }
  return true;
})()`;
try {
  await evaluate(STOP);
} catch (e) {
  console.error(`停演示源失败（${e.message}）——应用里可能还留着在跑的演示源，下趟 START 有对齐兜底`);
}

const fpsList = samples.map((s) => s.fps).filter((v) => typeof v === "number");
const fpsMed = fpsList.length ? fpsList.slice().sort((a, b) => a - b)[Math.floor(fpsList.length / 2)] : null;
const heapGrow = first && last ? last.jsHeapMB / Math.max(first.jsHeapMB, 0.1) : null;
const heapDriftMBPerMin = first && last ? +(((last.jsHeapMB - first.jsHeapMB) / MINUTES) || 0).toFixed(1) : null;

const report = {
  tool: "P156-B2 perf-live",
  hz: HZ,
  preset: PRESET,
  panel: PANEL || null,
  minutes: MINUTES,
  url,
  startedAt: samples[0]?.at ?? null,
  panels: final.panels,
  /** 2D 通道挂了几个：分母为 0 的"流畅"不算流畅 */
  plotChannelsAdded: started.channelsAdded ?? 0,
  cdpEnabled: true,
  // 判据①：零未捕获错误（页内 + CDP 事件两条线，任何一条非空都算红）
  pageErrors: [...final.pageErrors, ...cdpExceptions.slice(0, 20)],
  // 判据②：堆增长有界（首末比 < 1.5 且不持续线性涨——斜率给人看）
  heap: { firstMB: first?.jsHeapMB ?? null, lastMB: last?.jsHeapMB ?? null, growRatio: heapGrow, driftMBPerMin: heapDriftMBPerMin },
  // 判据③：帧率与长任务：先报数，不拍脑袋立线
  fps: { median: fpsMed, min: fpsList.length ? Math.min(...fpsList) : null },
  longTasks: { count: final.longTasks, totalMs: final.longMs, maxMs: final.longMax, unsupported: final.longtaskUnsupported },
  visibility: final.visibility,
  // 判据④：分母——收到多少 / 各面板渲染多少 / 上限
  denominators: {
    frames: final.frames,
    console: { blocks: final.consoleBlocks, cap: 400 },
    table: final.table,
    plot: final.plot,
    hex: final.hex,
  },
  samples,
};
mkdirSync(path.dirname(path.resolve(ROOT, OUT)), { recursive: true });
writeFileSync(path.resolve(ROOT, OUT), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
console.log(`\n写入 ${OUT}`);
console.log(
  `合计：帧事件 ${final.frames.events} / 行 ${final.frames.rows} / 字节 ${final.frames.bytes} / 坏帧 ${final.frames.invalid}；` +
    `fps 中位 ${fpsMed ?? "-"}；长任务 ${final.longTasks} 条共 ${final.longMs}ms；` +
    `堆 ${first?.jsHeapMB}→${last?.jsHeapMB}MB（${heapGrow?.toFixed(2) ?? "-"}×，${heapDriftMBPerMin}MB/min）；` +
    `错误 ${report.pageErrors.length}`,
);
ws.close();

if (appProc && !KEEP) {
  console.log("收掉 tauri dev…");
  spawnSync("taskkill", ["/PID", String(appProc.pid), "/T", "/F"], { stdio: "ignore" });
}
/* 显式退出：spawn 出来的 tauri dev（stdio inherit）与 CDP WebSocket 都可能把
   Node 的事件循环按着不放——首跑就是活干完了、进程不散，被外层按超时当挂死。 */
process.exit(0);
