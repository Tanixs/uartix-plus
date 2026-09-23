/**
 * P99a-C1 宿主自省目录单测（详设 §6）。
 *
 * 这里要钉住的不是"能不能读出东西"，而是**目录作为唯一声明处**的四条性质：
 * 1. 自洽：菜单里每一道菜都点得到（模型照着 `app_catalog` 走不会撞 `unknown_path`）；
 * 2. 封闭：路径只来自目录，未声明的一律拒并回建议——没有"读任意 store"的反射后门；
 * 3. 说真话：分页字段与截断标记齐全（A7），超限降级成"预览 + 怎么办"而不是静默切半；
 * 4. 不接敏感源：读者能 import 哪些模块由这份测试的白名单管着，加一个源必须同时改这里。
 *
 * store 全部 mock：目录本身只依赖 `getSnapshot()` 这一读口，不必把渲染链拖进来。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogReadResult } from "./hostCatalog";

// 读源文本走项目既有的一段式动态导入（helpCoverage 同一手法）：**字面量** `"node:fs"` 会被
// vite 当真去解析、tsc 又按文件内是否出现字面量 import("node:fs") 判成 CommonJS 目标，
// 于是连带整文件的顶层 await 一起报错。用变量说明符绕开这两层。
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
// 变量说明符同时绕开 vite 的字面量解析与 tsc 缺 @types/node 的"找不到模块"（helpCoverage 同一手法）

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });

const ho = vi.hoisted(() => {
  const tplFields = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `f${i}`, name: `字段${i}`, role: "data", offset: i, type: "u16", endian: "be", size: 2, scale: 1, unit: "v",
    }));
  return {
    serial: { iface: "serial" as string, status: "connected" as string, portName: "COM7" as string | null, rxTotal: 1234, txTotal: 5, bps: 12.4, error: null as string | null },
    operator: { pkg: null as unknown },
    session: {
      state: "recording", frameCount: 90, durationMs: 1500.6, posMs: 0, fileName: "a.vsj",
      firstTs: 1, lastTs: 2, lastSpeed: 1, bridgeListening: true, bridgePort: 5599, bridgeClients: 1, meta: { frames: 90 },
    },
    plot: {
      getSnapshot: vi.fn(() => ({ channels: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, name: `通道${i}`, visible: true, tplId: "t1", fieldId: "f0", color: "#fff" })) })),
      getChanData: vi.fn(() => ({ t: [0, 10, 20], v: [1, 7, 3] })),
      sampleRate: vi.fn(() => 50),
      timeOrigin: vi.fn(() => 1000),
    },
    templates: {
      rules: {
        templates: [
          { id: "t1", name: "常规帧", enabled: true, groupKey: "g1", color: "#123", fields: tplFields(4), boundary: { mode: "header", header: "AA55" }, checksum: { algo: "crc16" } },
          { id: "big", name: "大协议", enabled: false, fields: tplFields(300) },
        ],
      },
    },
    commands: {
      groups: [
        { id: "g1", name: "组一", items: [{ id: "cmd1", name: "查询", template: "AT\r\n", sendMode: "once", scriptEnabled: false, note: "n" }] },
        { id: "cmd2", name: "单条", template: "01 03", sendMode: "loop", scriptEnabled: false },
      ],
    },
    controls: {
      activePageId: "p1",
      pages: [{ id: "p1", name: "面板1", cols: 12, rows: 8, locked: false, cards: [{ id: "k1", type: "button", name: "按钮", x: 0, y: 0, w: 2, h: 1, bindTemplate: "t1" }] }],
    },
    frames: {
      rows: [] as unknown[],
      paused: false, capped: false, maxRows: 5000,
    },
    telemetry: {
      stats: { total: 100, errors: 2 },
      tplStats: { t1: { ok: 98, err: 2 } },
      latest: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, { value: i, text: `${i}.0`, valid: true, ts: i }])) as Record<string, unknown>,
    },
    plugins: { plugins: [] as unknown[] },
    moduleArtifactsOf: vi.fn(() => [] as unknown[]),
    pluginToolDefsOf: vi.fn(() => [] as { baseName: string }[]),
    getVersion: vi.fn(async () => "9.9.9-test"),
    failSession: false,
  };
});

function makeRows(n: number, fat = false) {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1, tsMs: i * 10, tplId: "t1", tplName: "常规帧", len: 8, valid: i % 7 !== 0, error: null,
    bytes: new Uint8Array([0xaa, 0x55, i & 0xff, 0x01]),
    fields: Array.from({ length: fat ? 24 : 2 }, (_, k) => ({ id: `f${k}`, name: `字段${k}`, value: k, text: `${k}` })),
  }));
}

vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ho.serial }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ho.operator }));
vi.mock("../session/sessionStore", () => ({
  getSnapshot: () => {
    if (ho.failSession) throw new Error("store 读取炸了");
    return ho.session;
  },
}));
vi.mock("../plot/plotStore", () => ho.plot);
vi.mock("../protocol/templateStore", () => ({ getSnapshot: () => ho.templates }));
vi.mock("../controls/commandStore", () => ({ getSnapshot: () => ho.commands }));
vi.mock("../controls/controlsStore", () => ({ getSnapshot: () => ho.controls }));
vi.mock("../table/framesStore", () => ({ getSnapshot: () => ho.frames }));
vi.mock("../protocol/telemetryStore", () => ({ getSnapshot: () => ho.telemetry }));
vi.mock("../plugins/pluginStore", () => ({ getSnapshot: () => ho.plugins }));
vi.mock("../plugins/moduleHost", () => ({ moduleArtifactsOf: ho.moduleArtifactsOf }));
vi.mock("../plugins/pluginToolDefs", () => ({ pluginToolDefsOf: ho.pluginToolDefsOf }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: ho.getVersion }));
/**
 * P99c-M：Tauri 命令通道本身钉住。ESM 命名空间是只读的，`core.invoke = …` 那种monkey-patch
 * 在测试里会直接 TypeError，所以只能在这里 mock 成"记一笔 + 抛"——**任何视图**偷偷发一条命令都当场红。
 */
const netSpy = vi.hoisted(() => ({ invokes: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    netSpy.invokes.push(cmd);
    throw new Error(`守卫夹具：自省面不该发 Tauri 命令（${cmd}）`);
  },
}));
// 插件回滚会 scheduleStyles → extRuntime 直取 document（node 环境没有）
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));

/* ================= P99a-C1b：七面的 mock =================
 * 每一份快照里都**故意塞进毒值**（绝对路径、串口号、原始 hex、备注自由文本、寄存器历史数组、
 * 静音键名）。目录读者的义务是"摘要"，所以这些毒值既不能以那个键名出现、也不能换了个键名
 * 把值带出去——两条各一条断言（§5.1）。只比键名会被"`filePath: snap.path`"这种改名绕过，
 * 只比值会被"截断到 40 字但确实给了"绕过，两条一起才封得住。 */
const { POISON, c1b } = vi.hoisted(() => {
  const POISON = {
    gltf: "POISON_GLTF_PATH",
    com: "POISON_SERIAL_PORT",
    hex: "POISON_RAW_HEX",
    note: "POISON_FREE_TEXT",
    host: "POISON_HOST",
    hist: 1234567,
    // P99b-N6：货架条目里那三样都不该整包进模型上下文（描述是投稿人写的自由文本）
    marketUrl: "POISON_MARKET_PACKAGE_URL",
    marketDesc: "POISON_MARKET_DESCRIPTION",
    marketSha: "POISON_MARKET_SHA256",
    marketDropped: "POISON_MARKET_DROPPED_REASON",
  };
  /**
   * 初值就是"该有什么都有、且带毒"的完整状态——**不在 describe 里 fill**：
   * 目录自洽那条老用例会把每支路径都读一遍，状态若是空的，新面的读者当场抛错，
   * 红的原因就成了"测试顺序"而不是"字段外带"（§8-36：探针自己得先站得住）。
   */
  const c1b = {
    plot3d: {
      snapshot: {
        settings: {
          v: 3, axisScale: 1, showGrid: true, gridDensity: 10, follow: false, autoRotate: false,
          keyFlight: true, zoomToCursor: true, calibMode: false, calibSrc: "g1",
          groups: [
            {
              id: "g1", name: "惯导推算", color: "#4a9", visible: true, mode: "line",
              chX: "c0", chY: "c1", chZ: "", pointSize: 3, opacity: 1, showDots: false,
              maxPoints: 0, colorBy: "time", colorCh: "", fade: 60, density: "mid",
              smooth: "catmullRom", smoothWin: 5, smoothSub: 4, smoothTension: 0.5,
              arrowEvery: 20, showStartEnd: true,
              heading: { src: "velocity" }, model: { kind: "gltf", src: POISON.gltf, scale: 1 },
              transform: { rotX: 0, rotY: 0, rotZ: 0, offX: 0, offY: 0, offZ: 0, scale: 1 },
              pairMode: "nearest", pairTolMs: 50, notes: POISON.note,
            },
          ],
        },
        canUndo: true, canRedo: false,
      } as Record<string, unknown>,
      diag: [{ id: "g1", name: "惯导推算", visible: true, mode: "line", missingAxis: "z", hasSource: true, paired: 42, skipped: 3 }],
      calib: { capturing: false, count: 1800, coverage: [{ octant: 0, n: 225 }] },
      accel6: { collecting: false, idx: 0, n: 0, faces: [], result: null, minSamples: 6, stalled: false },
    },
    orch: {
      doc: {
        version: 1, title: POISON.note,
        vars: [{ name: "目标温度", type: "number", def: 25, persist: true }],
        groups: [
          {
            id: "og1", name: "看门狗", enabled: true, cooldownMs: 500, queuePolicy: "dropNew", note: POISON.note,
            events: [{ id: "e1", kind: "timer", intervalMs: 5000 }],
            children: [
              { id: "b1", kind: "send", text: POISON.hex, sendMode: "hex", enabled: true },
              { id: "b2", kind: "waitFrame", hex: POISON.hex, timeoutMs: 500, enabled: true },
              { id: "b3", kind: "group", name: "子组", enabled: true, events: [], children: [{ id: "b4", kind: "toast", text: POISON.note, level: "warn", enabled: true }] },
            ],
          },
        ],
        settings: { masterOn: true },
      } as Record<string, unknown>,
    },
    seq: {
      suites: [
        {
          id: "s1", name: "上电自检", failFast: true,
          trigger: { mode: "onFrame", match: { kind: "hex", hex: POISON.hex }, cooldownMs: 1000 },
          steps: [
            { id: "st1", kind: "send", enabled: true, payload: { mode: "hex", text: POISON.hex } },
            { id: "st2", kind: "assert", enabled: true, note: POISON.note },
          ],
        },
      ] as unknown[],
      lastResults: {
        s1: { suiteId: "s1", suiteName: "上电自检", startedAt: 1, finishedAt: 9, status: "done", steps: [{ stepId: "st1", kind: "send", label: "发", status: "pass", startedAt: 1, durationMs: 2, detail: POISON.note }] },
      } as Record<string, unknown>,
    },
    analysis: {
      error: null as string | null,
      result: {
        schema: "vs-analysis-snapshot/v1", algorithmVersion: "v1", generatedAt: 5,
        limits: { maxChannels: 32, maxPointsPerChannel: 30000, totalPoints: 120000, effectivePointsPerChannel: 30000 },
        selection: {}, range: {},
        channels: [{ id: "c0", stats: { n: 100, rms: 1.2, std: 0.1, range: {}, coverage: {}, timeGap: {}, units: {} } }],
        trajectories: [], sourceFile: POISON.gltf, notes: POISON.note,
      } as Record<string, unknown>,
    },
    slave: {
      running: false, address: 1, anyAddress: false, delayMs: 0, fault: "none", faultCode: 2,
      bitSize: 2048, wordSize: 64, version: 7, banks: new Uint8Array([1, 2, 3]),
      counters: { requests: 10, replies: 9, exceptions: 1, silents: 0, ignored: 0, noise: 2 },
      events: Array.from({ length: 9 }, (_, i) => ({ ts: i, dir: "in", text: `${POISON.hex} ${i}` })),
    } as Record<string, unknown>,
    poll: {
      running: true, transport: "rtu", txns: 20, timeouts: 1, errs: 0, lastError: POISON.note,
      rows: [
        { id: "r1", enabled: true, slave: 1, fn: 3, addr: 0, qty: 3, periodMs: 500, varName: "MB温度", elem: 0, scale: 0.1, ok: 19, timeout: 1, err: 0, last: 25.4, lastTs: 9, latencyMs: 12, nextTs: 10, hist: [POISON.hist, 2, 3] },
        { id: "r2", enabled: false, slave: 2, fn: 1, addr: 0, qty: 8, periodMs: 1000, varName: "DI", elem: 0, scale: 1, ok: 0, timeout: 0, err: 0, last: null, lastTs: null, latencyMs: null, nextTs: 0, hist: [] },
      ],
    } as Record<string, unknown>,
    vdev: {
      running: true, device: "温控炉", dirty: false, err: null, editingId: "d1",
      savedSnapshot: POISON.note, editing: null,
      specs: [
        {
          id: "d1",
          spec: {
            kind: "uartix-vdev", version: 1, name: "温控炉", desc: POISON.note, periodMs: 100,
            frame: { header: "AA55", fields: [{ name: "temp", type: "f32" }, { name: "press", type: "u16" }] },
            inputs: [{ name: "heat", value: 0 }], signals: [{ name: "temp" }, { name: "press" }],
            faults: { dropPct: 5, stuckPct: 0, spikePct: 1, spikeAmp: 3, spikeSignal: "temp" },
            commands: [{ prefix: "HEAT ON", reply: { text: POISON.hex } }],
            net: { transport: "serial", host: POISON.host, port: 502, bind: "0.0.0.0", listenPort: 503, listenBind: "0.0.0.0", path: POISON.com, baud: 115200, extraTargets: [] },
          },
        },
      ],
      netStatus: { transport: "serial", target: POISON.com, outSent: 3, outBytes: 24, outErrs: 0, inRecv: 2, clients: 0, lastError: null, lastCmd: POISON.hex },
    } as Record<string, unknown>,
    sentinel: {
      running: true, learning: false, unack: 2, health: 70, chanTotal: 3,
      lastFrameTs: 9, silenceMs: 12, conn: true, totals: { frames: 500, errors: 4 },
      activeCrit: 1, activeWarn: 1, floating: false,
      alerts: Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`, ts: i, kind: "spike", level: "crit", key: `spike:温度${i}`, channel: "温度",
        tplId: "t1", fieldId: "f0", msg: POISON.note, count: i + 1, acked: false,
        detail: { from: 1, to: 9, score: 4.2 },
      })),
      chans: [{ name: "温度", score: 4.2, level: "crit", last: 88, tplId: "t1", fieldId: "f0", color: "#f00" }],
      frameTypes: [{ id: "t1", name: "常规帧", count: 480, firstTs: 1, isNew: false }],
      cfg: {
        enabled: true, sensitivity: "mid", silenceSec: 5, errRatePct: 5, sound: false, volume: 60,
        alertCap: 200, autoDiag: false, diagCooldownMin: 10, mutedKeys: ["spike:温度1", "spike:温度2", "spike:温度3"],
      },
    } as Record<string, unknown>,
    /* P99b-N6 · 插件市场：初值同样得是"取回成功、条目齐、带毒"的一份索引。
       留一份空索引在这里，下面那两条毒值/键名扫描对 market.* 就等于没扫（§8-54）。 */
    market: {
      status: "ready",
      index: {
        schemaVersion: 1, name: "测试货架", generatedAt: "2026-09-20", source: "repo:tanixs/market",
        docsUrl: "", categories: { theme: "主题", panel: "面板" },
        entries: [
          {
            id: "uartix.b", name: "乙主题", author: "作者丙", category: "theme",
            description: { zh: POISON.marketDesc, en: "english-ding" },
            version: "1.2.0", packageUrl: POISON.marketUrl, sha256: POISON.marketSha, bytes: 2048,
            capabilities: ["theme.tokens"], screenshots: ["s1", "s2"],
            minAppVersion: "0.4.0", updated: "2026-09-18", verified: true,
            homepage: "https://example.org/b",
          },
          {
            id: "uartix.a", name: "甲面板", author: "作者乙", category: "panel",
            description: { zh: "另一条说明" },
            version: "0.1.0", packageUrl: POISON.marketUrl, sha256: POISON.marketSha, bytes: 512,
            capabilities: [], screenshots: [], minAppVersion: "0.4.0", updated: "2026-09-19",
          },
          // 第三条专为"本机比货架新"那一格：少它的话，把 compareInstall 换成
          // `local === shelf ? "same" : "update"` 这种naive 写法照样绿（探针 P13b 实测过）
          {
            id: "uartix.c", name: "丙小件", author: "作者丁", category: "panel",
            description: { zh: "三条说明" },
            version: "0.3.0", packageUrl: POISON.marketUrl, sha256: POISON.marketSha, bytes: 128,
            capabilities: [], screenshots: [], minAppVersion: "0.3.0", updated: "2026-09-17",
          },
        ],
        dropped: [{ id: "uartix.bad", reason: POISON.marketDropped }],
      },
      fetchedAt: 1234, elapsedMs: 4321, error: "", viaMirror: false,
      favorites: [] as string[], appVersion: "0.4.1",
    } as Record<string, unknown>,
    marketPending: [] as { entryId: string; phase: string }[],
    marketRefreshCalls: 0,
  };
  return { POISON, c1b };
});
vi.mock("../plot3d/plot3dStore", () => ({
  getSnapshot: () => c1b.plot3d.snapshot,
  diagFacts: () => c1b.plot3d.diag,
  calibSnapshot: () => c1b.plot3d.calib,
  accel6Snapshot: () => c1b.plot3d.accel6,
  CALIB_CAP: 20000,
}));
vi.mock("../orchestrator/orchestratorStore", () => ({ getSnapshot: () => ({ doc: c1b.orch.doc }) }));
/**
 * P99c-O1：活值那一份。三处原文（组备注 `note`、上次失败详情 `lastDetail`、日志 `detail`）都带毒，
 * 目录的投影必须把它们丢掉——只留计数与阶段。
 * **变量现值是刻意留下的**：动作 `orchestratorRead` 今天就免批准地给同一批值，目录不给才是不对称，
 * 所以这里的 poison 只放在"三类原文"上（放错地方会让这条钉变成"活值不该进目录"的假信号）。
 */
const orchFail = vi.hoisted(() => ({ on: false }));
vi.mock("../orchestrator/orchRuntimeRead", () => ({
  ORCH_RUNTIME_LOG_TAIL: 10,
  readOrchestratorRuntime: async () => {
    if (orchFail.on) throw new Error("夹具：引擎装载不上");
    return {
      masterOn: true, runningInstances: 2, groupCount: 1, groupCap: 32, queueCap: 8, logCap: 800, logCount: 12,
      groups: [
        {
          id: "og1", name: "看门狗", enabled: true, events: ["timer"], autoTriggers: true,
          cooldownMs: 500, queuePolicy: "dropNew", note: POISON.note, blocks: 4, kinds: { send: 1 },
          runs: 7, fails: 1, lastAt: "2026-09-23T00:00:00.000Z", lastDetail: POISON.hex,
        },
      ],
      vars: [
        { name: "目标温度", type: "number", value: 25, default: 25, persist: true },
        { name: "长文本", type: "string", value: "一".repeat(300), default: "", persist: false },
      ],
      recentLogs: [{ at: "2026-09-23T00:00:01.000Z", groupId: "og1", phase: "done", detail: POISON.note }],
    };
  },
}));
vi.mock("../sequencer/sequencerStore", () => ({ getSnapshot: () => c1b.seq }));
vi.mock("../analysis/analysisStore", () => ({ getSnapshot: () => c1b.analysis }));
// 真身的 safeAnalysisSnapshot 已经是递归白名单；mock 只做同样的"把路径/文本类字段剔掉"
vi.mock("../analysis/analysisSnapshot", () => ({
  safeAnalysisSnapshot: (s: Record<string, unknown>) =>
    JSON.parse(
      JSON.stringify(s, (k, v) =>
        /path|serial|notes|title|file|host/i.test(k) || String(v).includes("POISON") ? undefined : v,
      ),
    ),
}));
vi.mock("../modbus/slaveStore", () => ({ getSnapshot: () => c1b.slave }));
vi.mock("../modbus/pollStore", () => ({ getSnapshot: () => c1b.poll }));
vi.mock("../vdev/vdevStore", () => ({ getSnapshot: () => c1b.vdev }));
vi.mock("../sentinel/sentinelStore", () => ({ getSnapshot: () => c1b.sentinel }));
/* P99b-N6 · 市场的两支视图。这里 mock 的形态本身就是那条守卫的一部分：
   `refreshIndex` 一被调用就抛——"视图不顺手联网"这件事光靠源文本钉防不住改天换个写法，
   而这一炸会让「目录自洽」那条老用例当场红（R3/G5）。 */
vi.mock("../market/marketStore", () => ({
  getMarketSnapshot: () => c1b.market,
  refreshIndex: () => {
    c1b.marketRefreshCalls++;
    throw new Error("视图不许联网刷新：market.* 只读现状，刷新是用户打开那一页的动作");
  },
  fetchPackage: () => {
    throw new Error("视图不许取包");
  },
}));
vi.mock("../market/marketPending", () => ({ marketPendingSnapshot: () => c1b.marketPending }));

const { CATALOG_VIEWS, catalogMenu, readCatalog, runtimeFacts, RUNTIME_FACTS_MAX } = await import("./hostCatalog");

/** 目录里每一支非 byId 视图（byId 的先从列表拿 id 再测） */
const listPaths = CATALOG_VIEWS.filter((v) => !v.byId).map((v) => v.path);

beforeEach(() => {
  ho.failSession = false;
  ho.serial = { iface: "serial", status: "connected", portName: "COM7", rxTotal: 1234, txTotal: 5, bps: 12.4, error: null };
  ho.operator.pkg = null;
  ho.frames.rows = makeRows(3);
  ho.plugins.plugins = [{ pkg: { id: "user.agent.a", name: "A", version: "0.1.0", capabilities: ["theme.tokens"], provenance: { createdBy: "agent" }, artifacts: {} }, state: "enabled", versions: [] }];
  ho.moduleArtifactsOf.mockReturnValue([]);
  ho.pluginToolDefsOf.mockReturnValue([]);
});

describe("hostCatalog：目录自洽（菜单=能点到的菜）", () => {
  it("菜单里每条路径都能被 readCatalog 命中，且分组无空、路径无重复", async () => {
    const menu = catalogMenu();
    const flat = menu.groups.flatMap((g) => g.views.map((v) => v.path));
    expect(flat).toEqual(CATALOG_VIEWS.map((v) => v.path)); // 第二份清单＝第二真相
    expect(new Set(flat).size).toBe(flat.length);
    for (const g of menu.groups) expect(g.views.length).toBeGreaterThan(0);
    for (const p of listPaths) {
      const r = await readCatalog(p);
      expect(r.ok, `${p} 应可读`).toBe(true);
    }
    // byId 视图：三种写法都要认（菜单原文 + id 参数 / 斜杠 / 点号）
    for (const v of CATALOG_VIEWS.filter((x) => x.byId)) {
      /**
       * id 从**这条详情路自己的 unknown_id 回执**里拿（`want` 就是它给模型的"可用 id 清单"）。
       * 原来是这里手写一张 `{ "protocols/<id>": "t1", ... }` 三行表——新加的 byId 视图不在表里，
       * 循环就永远不覆盖它，于是"点号组名配不上前缀"这个真 bug 一路绿到本批（§8-36① 在测试里同样成立）。
       */
      const miss = await readCatalog(v.path, { id: "__no_such_id__" });
      expect(miss.ok, `${v.path} 的假 id 竟然读通了？`).toBe(false);
      const want = (miss as { data?: { want?: string[] } }).data?.want;
      expect(want?.length, `${v.path} 读不到 id 时没回 want 清单（模型只能瞎猜）`).toBeGreaterThan(0);
      const id = want![0];
      const forms: [string, () => Promise<CatalogReadResult>][] = [
        ["菜单原文 + id 参数", () => readCatalog(v.path, { id })],
        ["斜杠写法", () => readCatalog(v.path.replace("<id>", id))],
        ["点号写法", () => readCatalog(v.path.replace("/<id>", `.${id}`))], // 组名带点时最容易配错
      ];
      /**
       * **一条条 await，不许 Promise.all**：vitest 对同一个"被 mock 的模块"并发 dynamic import
       * 会给出两份实例（一份带 mock、一份是真身），并发跑就出现"第一条读通、第二条 unknown_id"的
       * 假故障。浏览器里 ESM 注册表会去重，应用侧也是按工具调用逐个跑，所以这是测试运行器的脾气，
       * 记在这里免得下次被"顺手优化"成并发。
       */
      for (const [how, go] of forms) {
        const r = await go();
        expect(r.ok, `${v.path}（${how}）读不通：${JSON.stringify(r).slice(0, 160)}`).toBe(true);
      }
    }
  });

  it("id 保持原样：路径归一不得改掉大小写、也不得把带点的 id 拆成两段", async () => {
    ho.templates.rules.templates.push({ id: "My.Tpl2", name: "混合", enabled: true, fields: [] });
    try {
      const r = await readCatalog("protocols/My.Tpl2");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as { id: string }).id).toBe("My.Tpl2");
      // 把菜单原文整串抄过来 + id 参数：同一条路，不收成第二套读取逻辑
      expect((await readCatalog("protocols/<id>", { id: "My.Tpl2" })).ok).toBe(true);
      expect(((await readCatalog("protocols/My.Tpl2", { id: "t1" })) as { data?: { id?: string } }).data?.id).toBe("My.Tpl2"); // 路径里的 id 优先
    } finally {
      ho.templates.rules.templates.pop();
    }
  });

  it("P99a-C1 敏感源封闭：读者只准 import 白名单里的 store", async () => {
    const src = readFileSync(fileURLToPath(new URL("./hostCatalog.ts", import.meta.url)), "utf8");
    const specs = [...src.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]).filter((s) => !s.startsWith("./"));
    // 新增一个可读源＝扩大 Agent 的读面，必须同时在这份白名单里登记（谁忘了谁红）
    const ALLOWED = [
      "../analysis/analysisSnapshot", "../analysis/analysisStore",
      "../controls/commandStore", "../controls/controlsStore",
      // P99b-N6：插件市场那两支。`marketIndex` 是纯契约函数（compareInstall/compat），
      // `marketStore` 只被读快照——**它带 refreshIndex，读者一句都不许碰**（G5 那条钉）。
      "../market/marketIndex", "../market/marketPending", "../market/marketStore",
      "../modbus/pollStore", "../modbus/slaveStore",
      "../operator/operatorStore",
      // P99c-O1：编排器活值。它自己不去碰 bind/engine，只调 `readOrchestratorRuntime`（那里只有一份判定）
      "../orchestrator/orchRuntimeRead",
      "../orchestrator/orchestratorStore", "../orchestrator/types",
      "../plot/plotStore", "../plot3d/plot3dStore",
      "../plugins/moduleHost", "../plugins/pluginStore", "../plugins/pluginToolDefs",
      "../protocol/telemetryStore", "../protocol/templateStore",
      "../sentinel/sentinelStore", "../serial/serialStore",
      "../session/sessionStore", "../sequencer/sequencerStore",
      "../table/framesStore", "../vdev/vdevStore",
      "@tauri-apps/api/app",
    ];
    expect([...new Set(specs)].sort()).toEqual(ALLOWED.sort());
    // 目录里没有任何"设置/密钥/令牌"这一类视图（比 sensitive flag 强：压根不接）
    for (const v of CATALOG_VIEWS) {
      expect(`${v.path} ${v.group} ${v.zh}`.toLowerCase()).not.toMatch(/setting|secret|token|apikey|api_key|license|credential/);
    }
  });
});

describe("hostCatalog：封闭与分页", () => {
  it("未声明路径一律拒，并回最近建议（不给反射读 store 的路）", async () => {
    const r = await readCatalog("settings");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_path");
    expect(r.data.all).toEqual(CATALOG_VIEWS.map((v) => v.path));
    expect((r.data.near as string[]).length).toBeGreaterThan(0);
    expect((await readCatalog("")).ok).toBe(false);
    expect((await readCatalog("frames/recent/../latest")).ok).toBe(false); // 点号被当成分隔符，不做路径折叠
  });

  it("详情视图缺 id → needs_id；id 不存在 → unknown_id 并给下一步", async () => {
    const miss = await readCatalog("protocols/<id>");
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.code).toBe("needs_id");
    expect(String(miss.data.hint)).toContain("protocols/");
    const bad = await readCatalog("protocols/no-such");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("unknown_id");
    expect(bad.data.want).toContain("t1"); // 协议视图直接给了可用 id
    const codeOf = (r: CatalogReadResult) => (r.ok ? "ok" : r.code);
    expect(codeOf(await readCatalog("commands/no-such"))).toBe("unknown_id");
    expect(codeOf(await readCatalog("controls/no-such"))).toBe("unknown_id");
  });

  it("协议详情给完整字段表（旧 app_state 那种“前 24 个”不再存在），字段按 cursor 翻页", async () => {
    const r = await readCatalog("protocols/big");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(300);
    expect(r.returned).toBe(120); // 默认页
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe(120);
    const d = r.data as { totalFields: number; fields: { offset: number; type: string }[] };
    expect(d.totalFields).toBe(300);
    expect(d.fields[0]).toMatchObject({ offset: 0, type: "u16" });
    const p2 = await readCatalog("protocols/big", { cursor: 120 });
    if (!p2.ok) throw new Error("第二页应可读");
    expect((p2.data as { fields: { offset: number }[] }).fields[0].offset).toBe(120); // 不重不漏
    const last = await readCatalog("protocols/big", { cursor: 240 });
    if (!last.ok) throw new Error("第三页应可读");
    expect(last.returned).toBe(60);
    expect(last.truncated).toBe(false);
    expect(last.nextCursor).toBeNull();
  });

  it("frames.recent 从最新往回分页，字节数与 truncated 一起回（A7：不给“看全了”的错觉）", async () => {
    ho.frames.rows = makeRows(25, true);
    const r = await readCatalog("frames.recent", { limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(25);
    expect(r.returned).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe(10);
    expect(r.bytes).toBeGreaterThan(0);
    const d = r.data as { rows: { seq: number }[]; newestFirst: boolean };
    expect(d.newestFirst).toBe(true);
    expect(d.rows[0].seq).toBe(25); // 第一页就是最新的 10 条
    const over = await readCatalog("frames.recent", { limit: 200 }); // 25 条 × 24 字段 > 16 KiB
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect(over.truncated).toBe(true);
    // 超字节不是"还有下一页"：接着翻只会再撞一次上限，所以 nextCursor 必须为空、话要说清
    expect(over.nextCursor).toBeNull();
    expect((over.data as { note?: string; preview?: string }).note).toContain("limit");
    expect(typeof (over.data as { preview?: string }).preview).toBe("string");
  });

  it("读者自己炸了 → read_failed 带原因（不静默返回空对象）", async () => {
    ho.failSession = true;
    const r = await readCatalog("session");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("read_failed");
    expect(String(r.data.err)).toContain("store 读取炸了");
  });

  it("limits 有边界：limit 越界折回区间、负 cursor 当 0、非数字走默认", async () => {
    const r = await readCatalog("frames.latest", { limit: 99999, cursor: -5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returned).toBe(5);
    expect(r.cursor).toBe(0);
    expect(r.truncated).toBe(false);
    const d = await readCatalog("commands", { limit: 0 });
    if (!d.ok) throw new Error("limit=0 应被夹到 1 而不是返回空页");
    expect(d.returned).toBeGreaterThan(0);
  });
});

describe("hostCatalog：各视图内容口径", () => {
  it("runtime 一屏给完连接/锁/规模；counts 是递归数叶子而不是组数", async () => {
    const r = await readCatalog("runtime");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, Record<string, unknown>>;
    expect(d.serial).toMatchObject({ iface: "serial", status: "connected", port: "COM7", rxTotal: 1234, bps: 12 });
    expect(d.operatorLocked).toBe(false);
    expect(d.appVersion).toBe("9.9.9-test");
    expect(d.counts).toMatchObject({ channels: 3, protocols: 2, commands: 2, controls: 1, plugins: 1 });
    expect(d.session).toMatchObject({ state: "recording", frames: 90, durationMs: 1501, bridgePort: 5599 });
    expect(r.bytes).toBe(JSON.stringify(r.data).length); // bytes 说的就是这份 data 的体积（§8-34）
  });

  it("操纵者锁与串口错误都按现状出（不缓存不省略）", async () => {
    ho.operator.pkg = { x: 1 };
    ho.serial.error = "端口被占用";
    const r = await readCatalog("runtime");
    if (!r.ok) throw new Error("runtime 应可读");
    const d = r.data as { operatorLocked: boolean; serial: { error: string } };
    expect(d.operatorLocked).toBe(true);
    expect(d.serial.error).toBe("端口被占用");
  });

  it("plugins 视图带来源/版本链/模块与工具（list_plugins 就是它的投影）", async () => {
    ho.moduleArtifactsOf.mockReturnValue([{ path: "m.js" }]);
    ho.pluginToolDefsOf.mockReturnValue([{ baseName: "ping" }]);
    const r = await readCatalog("plugins");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = (r.data as { items: Record<string, unknown>[] }).items[0];
    expect(item).toMatchObject({ id: "user.agent.a", name: "A", version: "0.1.0", state: "enabled", caps: ["theme.tokens"], createdBy: "agent", modules: 1 });
    expect(item.tools).toEqual(["ping"]);
    expect(item.historyVersions).toBe(0);
  });

  it("通道视图带统计与时间原点（逐点数据仍归 plot_window）", async () => {
    const r = await readCatalog("channels");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { originMs: number }).originMs).toBe(1000);
    const c = (r.data as { items: Record<string, unknown>[] }).items[0];
    expect(c).toMatchObject({ id: "c0", points: 3, min: 1, max: 7, last: 3, sampleRate: 50 });
  });
});

describe("hostCatalog §6.2：每轮注入的运行时事实", () => {
  it("只注事实：档位 / 工具面 / 连接现状 / 版本，一段都不落就不叫自省", async () => {
    const line = await runtimeFacts({ scope: "create", allowed: [], toolCount: 41, toolBytes: 28 * 1024 });
    expect(line).toContain("scope=create");
    expect(line).not.toContain("domains="); // 非 custom 档不报勾选集（那本来就不是它的事实）
    expect(line).toContain("tools=41/28KB");
    expect(line).toContain("serial=serial:connected(COM7) rx1234 tx5");
    expect(line).toContain("session=recording(90)");
    expect(line).toContain("app=9.9.9-test");
    expect(line).not.toContain("operatorLocked");
  });

  it("custom 档给授权域；锁与断开必须显式出现（模型据此少发一轮试探）", async () => {
    ho.operator.pkg = { x: 1 };
    ho.serial.status = "disconnected";
    ho.serial.portName = null;
    const line = await runtimeFacts({ scope: "custom", allowed: ["config", "plugins"], toolCount: 3, toolBytes: 1024 });
    expect(line).toContain("scope=custom domains=config,plugins");
    expect(line).toContain("operatorLocked=true");
    expect(line).toContain("serial=serial:disconnected rx");
  });

  it("读不到就承认读不到，并给整行封顶（每轮都进请求，长了就是 24 轮的浪费）", async () => {
    ho.failSession = true;
    const line = await runtimeFacts({ scope: "create", allowed: [], toolCount: 1, toolBytes: 1024 });
    expect(line).toContain("scope=create"); // 前面几段仍是真读数，不因一段失败整行作废
    expect(line).toContain("host=unavailable(store 读取炸了)");
    ho.failSession = false;

    const long = await runtimeFacts({ scope: "custom", allowed: Array.from({ length: 40 }, (_, i) => `domain${i}`), toolCount: 999, toolBytes: 999 * 1024 });
    expect(long.length).toBeLessThanOrEqual(RUNTIME_FACTS_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

/* ================= P99a-C1b：七面进目录后的"字段封闭" =================
 * C1 的门只管"能 import 谁"，而这批的风险全在**字段**上：这些 store 的 `getSnapshot()`
 * 是整包给的，谁在读者里写一句 `...snap` 就把 220k 点云、绝对路径、原始 hex 一起送进模型。
 * 所以两条断言一起上（详设 §5.1）：
 *  ① 键名黑名单——`src`/`path`/`host`/`hist`/`notes`/`payload` 这类键根本不许出现在输出里；
 *  ② 毒值扫描——mock 里那些 `POISON_*` 值不许以任何形式（含改名、含截断后仍然可读）漏出。
 * 只做①会被 `filePath: snap.path` 绕过；只做②会被"给了但改了名"绕过——两条一起才封得住。
 */
describe("hostCatalog：C1b 七面 + N6 市场两支的字段封闭", () => {
  const FORBIDDEN_KEYS = new Set([
    // 端点与路径
    "src", "path", "host", "bind", "listenBind", "listenPort", "port", "baud", "target", "lastCmd",
    // 原始载荷与大数组
    "hist", "pts", "banks", "faces", "payload", "raw", "hex", "text", "html", "code",
    // 自由文本：一律只给数量（A7 的"要么截断要么计数"里，这一面选了计数）
    "notes", "note", "detail", "msg", "desc", "title", "lastError", "savedSnapshot", "mutedKeys",
  ]);
  /** 声明路径（byId 视图带一个真实 id 才读得通） */
  const NEW_VIEWS: { path: string; id?: string }[] = [
    { path: "plot3d.groups" }, { path: "plot3d.groups/<id>", id: "g1" },
    { path: "orchestrator.groups" }, { path: "orchestrator.groups/<id>", id: "og1" }, { path: "orchestrator.vars" },
    // P99c-O1：活值那一支（三处原文带毒，投影必须丢掉）
    { path: "orchestrator.runtime" },
    { path: "sequencer.suites" }, { path: "sequencer.suites/<id>", id: "s1" },
    { path: "analysis.last" }, { path: "modbus.slave" }, { path: "modbus.poll" },
    { path: "vdev.devices" }, { path: "sentinel.health" },
    // P99b-N6：市场那两支一起进扫描（毒值/键名两条断言对它们同样成立）
    { path: "market.status" }, { path: "market.entries" },
  ];
  /** 串行读（并发 dynamic import 同一被 mock 模块会拿到两份实例，见上面 byId 循环的注释） */
  async function readNew() {
    const out: { path: string; r: CatalogReadResult }[] = [];
    for (const v of NEW_VIEWS) out.push({ path: v.path, r: await readCatalog(v.path, v.id ? { id: v.id } : {}) });
    return out;
  }

  /** 递归收集所有层级的键名 */
  function collectKeys(node: unknown, out: string[]): string[] {
    if (Array.isArray(node)) {
      for (const x of node) collectKeys(x, out);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out.push(k);
        collectKeys(v, out);
      }
    }
    return out;
  }

  it("这批新增的视图都声明了（条数取自 NEW_VIEWS 本身，标题里不写死数字；每条读通由上面「菜单自洽」覆盖）", () => {
    for (const v of NEW_VIEWS) {
      expect(CATALOG_VIEWS.some((x) => x.path === v.path), `目录里缺视图 ${v.path}`).toBe(true);
    }
  });

  it("禁外带键名一个都不许出现（`...snap` 一写就红）", async () => {
    const bad: string[] = [];
    for (const { path: p, r } of await readNew()) {
      expect(r.ok, `${p} 读不通：${JSON.stringify(r).slice(0, 260)}`).toBe(true);
      if (!r.ok) continue;
      for (const k of collectKeys(r.data, [])) if (FORBIDDEN_KEYS.has(k)) bad.push(`${p} → ${k}`);
    }
    expect(bad, `这些字段属于"整包外带"，视图只能给摘要：${bad.join("、")}`).toEqual([]);
  });

  it("毒值（绝对路径 / 串口号 / 原始 hex / 自由文本 / 寄存器历史 / 静音键）一个都不许漏出去", async () => {
    const tokens = Object.values(POISON).filter((x) => typeof x === "string") as string[];
    const leaked: string[] = [];
    for (const { path: p, r } of await readNew()) {
      // 先确认真的读到了东西：不然"读不通"的错误回执里当然没有毒值，这条就成了假守卫
      expect(r.ok, `${p} 读不通，毒值扫描等于没扫`).toBe(true);
      const text = JSON.stringify(r);
      for (const t of tokens) if (text.includes(t)) leaked.push(`${p} → ${t}`);
      // 数值型毒值单独查（它在 JSON 里是裸数字）
      if (text.includes(String(POISON.hist))) leaked.push(`${p} → hist 数值`);
    }
    expect(leaked, `毒值漏进回执：${leaked.join("、")}`).toEqual([]);
  });

  it("自由文本要么截断带标记、要么只给数量（A7 口径，不给「看起来完整其实被裁」）", async () => {
    const slave = await readCatalog("modbus.slave");
    expect(slave.ok).toBe(true);
    if (!slave.ok) return;
    const s = slave.data as { counters?: Record<string, unknown>; eventsRecent?: { ts: number }[]; eventsTotal?: number; eventsOmitted?: number };
    expect(s.counters).toBeTruthy();
    expect(Array.isArray(s.eventsRecent)).toBe(true);
    expect(s.eventsRecent!.length).toBeLessThanOrEqual(5);
    // 给了"最近事件"就必须同时给"后面还有多少条"——否则模型以为这就是全部（A7）
    expect(s.eventsTotal).toBe(9);
    expect(s.eventsOmitted).toBe(4);
  });

  it("列表视图次序可复现（每秒重算的面尤其：两次调用行序不得漂）", async () => {
    const a = await readCatalog("modbus.poll");
    const b = await readCatalog("modbus.poll");
    const ids = (r: CatalogReadResult) => ((r.data as { items: { id: string }[] }).items ?? []).map((x) => x.id);
    expect(ids(a)).toEqual(["r1", "r2"]);
    expect(ids(b)).toEqual(ids(a));
    const sa = await readCatalog("sentinel.health");
    expect(sa.ok).toBe(true);
  });
});

/* ================= P99b-N6 · market 两支：只读、不联网、对照用同一支判定 =================
 * 这一组的风险与 C1b 七面不同：七面怕"整包外带"，这两支怕**顺手刷新**。
 * 市场的"只有打开那一页才联网"是用户能感知的承诺（N1 起的第一条），模型问一句"货架上有什么"
 * 就把人推出这个承诺，等于拿自省面当后门——所以源文本钉 + 行为钉 + mock 里那记会炸的 refreshIndex 一起上。
 */
describe("P99b-N6 · hostCatalog：market.status / market.entries", () => {
  type Data = Record<string, unknown>;
  const items = (r: CatalogReadResult) => ((r.data as Data).items ?? []) as Data[];

  it("两支都在目录里，且都归「插件市场」这一组", () => {
    const ms = CATALOG_VIEWS.filter((v) => v.group === "market");
    expect(ms.map((v) => v.path)).toEqual(["market.status", "market.entries"]);
    for (const v of ms) expect(v.gives.length, `${v.path} 没写能给哪些字段`).toBeGreaterThan(20);
  });

  it("status 读的是现状：几条 / 被剔几 / 走没走镜像 / 耗时，一个都不少", async () => {
    const r = await readCatalog("market.status");
    expect(r.ok).toBe(true);
    const d = r.data as Data;
    expect(d.available).toBe(true);
    expect(d.entryCount).toBe(3);
    // 货架页显示得、AI 读不到就是不对称（详设 §4-5）
    expect(d.droppedCount).toBe(1);
    expect(d.viaMirror).toBe(false);
    expect(d.elapsedMs).toBe(4321);
    expect(d.fetchedAt).toBe(1234);
    expect(d.status).toBe("ready");
  });

  it("未取过 / 取回失败：照实说没有，并指向该去哪儿，且不回一份空货架当现状", async () => {
    const saved = { ...c1b.market } as Record<string, unknown>;
    try {
      for (const [status, err] of [["idle", ""], ["failed", "拉不到索引（3.2 s）：直连不通"]] as const) {
        c1b.market.index = null;
        c1b.market.status = status;
        c1b.market.error = err;
        for (const p of ["market.status", "market.entries"]) {
          const r = await readCatalog(p);
          expect(r.ok, `${p} 在未取过时应当仍是一次成功的读取`).toBe(true);
          const d = r.data as Data;
          expect(d.available, `${p} 没照实说"没取过"`).toBe(false);
          expect(String(d.next), `${p} 没说该去哪儿`).toContain("插件市场");
          expect(String(d.next)).toContain("不替你联网刷新");
        }
      }
    } finally {
      c1b.market.index = saved.index;
      c1b.market.status = saved.status;
      c1b.market.error = saved.error;
    }
  });

  it("本机有旧版是 update、本机更新是 newer-than-shelf：换 naive 写法就红（探针 P13b）", async () => {
    ho.plugins.plugins.push(
      { pkg: { id: "uartix.b", version: "1.1.0" } },
      { pkg: { id: "uartix.c", version: "0.9.0" } },
    );
    try {
      const r = await readCatalog("market.entries");
      const byId = Object.fromEntries(items(r).map((x) => [x.id as string, x]));
      expect(byId["uartix.b"].install, "本机 1.1.0 / 货架 1.2.0 该是 update").toBe("update");
      expect(byId["uartix.a"].install, "本机没有的该是 absent").toBe("absent");
      // 这一格是"local !== shelf 就叫 update"那种抄本写法的照妖镜
      expect(byId["uartix.c"].install, "本机 0.9.0 / 货架 0.3.0 该是 newer-than-shelf").toBe("newer-than-shelf");
      expect(byId["uartix.b"].verified).toBe(true);
      expect(byId["uartix.b"].shots).toBe(2);
      // 描述是投稿人写的自由文本：只给长度
      expect(byId["uartix.a"].descLen).toBe(5);
      // 次序按 id 稳定（§3-1）
      expect(items(r).map((x) => x.id)).toEqual(["uartix.a", "uartix.b", "uartix.c"]);
    } finally {
      ho.plugins.plugins.length = 0;
    }
  });

  it("有一条在飞的请求时才带 pending，没有就这个键压根不出现", async () => {
    const before = await readCatalog("market.entries");
    expect(items(before).some((x) => "pending" in x), "没排队却回了 pending").toBe(false);
    c1b.marketPending.push({ entryId: "uartix.b", phase: "awaiting_you" });
    try {
      const after = await readCatalog("market.entries");
      const byId = Object.fromEntries(items(after).map((x) => [x.id as string, x]));
      expect(byId["uartix.b"].pending).toBe("awaiting_you");
      expect("pending" in byId["uartix.a"], "没排队的那条不该带 pending").toBe(false);
    } finally {
      c1b.marketPending.length = 0;
    }
  });

  it("读这两支一次都不会触发刷新（计数器 + mock 里那记会炸的 refreshIndex 两路一起钉）", async () => {
    await readCatalog("market.status");
    await readCatalog("market.entries");
    expect(c1b.marketRefreshCalls, "自省面替用户联网了").toBe(0);
  });

  it("视图源码里不许出现 refreshIndex / fetch（R3 的源文本半边）", () => {
    const src = readFileSync(fileURLToPath(new URL("./hostCatalog.ts", import.meta.url)), "utf8");
    const start = src.indexOf("P99b-N6：插件市场（两支都不联网）");
    expect(start, "市场那一段的锚点没了：这条守卫要跟着改").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n];", start));
    // 切片自己得先站得住：锚点找错、切到空串，后面四条断言就全是"凭空通过"（§8-52）
    expect(body).toContain("market.entries");
    expect(body.length, "切片小得不像两支视图：锚点或收尾找错了").toBeGreaterThan(600);
    for (const bad of ["refreshIndex(", "fetch(", "fetchPackage(", "invoke("]) {
      expect(body, `market 视图里出现了 ${bad} ⇒ 自省面开始替用户联网`).not.toContain(bad);
    }
    // 对照只能引契约那一份：视图里自己 `version.split(".")` 就是第二套判定（徽章与回执会分叉）
    expect(body).toContain("compareInstall(");
    expect(body, "市场视图自己比版本号＝第二套判定，与货架徽章会分叉").not.toMatch(/versions\.get\([^)]*\)\s*[=!]==?\s*e\.version|e\.version\s*[=!]==?\s*versions\.get/);
  });
});

/* ================= P99c-O1：编排器活值进目录（一处判定，两处投影） ================= */
describe("P99c-O1 · orchestrator.runtime", () => {
  it("给的是计数与阶段：三处原文一个都不漏，长值截断带标记（A7）", async () => {
    const r = await readCatalog("orchestrator.runtime");
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d).toMatchObject({ available: true, masterOn: true, runningInstances: 2, groupCap: 32, queueCap: 8, logCap: 800, logCount: 12 });
    const groups = d.groups as Record<string, unknown>[];
    const events = d.events as Record<string, unknown>[];
    expect(Object.keys(groups[0])).toEqual(["id", "name", "enabled", "runs", "fails", "lastAt"]);
    expect(Object.keys(events[0])).toEqual(["at", "groupId", "phase"]);
    const json = JSON.stringify(d);
    for (const p of [POISON.note, POISON.hex]) expect(json, `原文漏出去了：${p}`).not.toContain(p);
    const long = String((d.vars as { value: unknown }[])[1].value);
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith("…"), "截断不留标记就等于让模型以为这就是全文").toBe(true);
  });

  it("引擎装载不上回 available:false，顶层不带 error（带了会被判成视图自毁）", async () => {
    orchFail.on = true;
    try {
      const r = await readCatalog("orchestrator.runtime");
      expect(r.ok, "读不到应当是一条能读的「读不到」，不是崩").toBe(true);
      const d = (r as { data: Record<string, unknown> }).data;
      expect(d.available).toBe(false);
      expect(d.error, "顶层 error 键会被 readCatalog 当成视图失败，回执只剩 read_failed").toBeUndefined();
      expect(String(d.why)).toContain("引擎");
      expect(String(d.next).length).toBeGreaterThan(8);
    } finally {
      orchFail.on = false;
    }
    expect((await readCatalog("orchestrator.runtime")).ok, "翻回false之后没翻回来：夹具自己漏还原").toBe(true);
  });

  it("一处判定：动作与目录共用那份活值读取，appActions 不再自己数", () => {
    const actions = readFileSync(fileURLToPath(new URL("../ai/appActions.ts", import.meta.url)), "utf8");
    expect(actions).toContain("../orchestrator/orchRuntimeRead");
    // 那三处是"状态表"的读法；`listVars()` 留着不算第二真相（那是 varWrite 的改前改后对照，不是快照）
    for (const bad of ["runningCount(", "statsOf(", "getLogs("]) {
      expect(actions, `appActions 里还留着 ${bad}＝第二份活值判定`).not.toContain(bad);
    }
    expect(actions, "把整段读值删空也会满足上面四条：这里钉住它确实在读那份判定").toContain("readOrchestratorRuntime(");
    expect(readFileSync(fileURLToPath(new URL("./hostCatalog.ts", import.meta.url)), "utf8")).toContain("readOrchestratorRuntime");
  });

  it("旧话改口：两条 gives 不再把活值推给动作，帮助也不再写目录读不到", () => {
    const cat = readFileSync(fileURLToPath(new URL("./hostCatalog.ts", import.meta.url)), "utf8");
    expect(cat, "还在说「运行统计不在这里」＝这条视图成了暗面").not.toContain("**运行统计不在这里**");
    const help = readFileSync(fileURLToPath(new URL("../help/HelpModal.tsx", import.meta.url)), "utf8");
    expect(help).toContain("orchestrator.runtime");
    expect(help, "帮助仍在说目录读不到编排器").not.toMatch(/编排器[^。]{0,24}(读不到|没接|不含|不支持)/);
  });
});

/* ============ P99c-M：市场那两支的**网络层**半边 ============
 * N6 那批只钉到"没人叫 refreshIndex"（调用层）与"源码里没那几个动词"（源文本层）。
 * 少一层：视图哪天改成直接 `fetch(...)` 或 `invoke("market_fetch")`，上面两条都不红。
 * 这里把两个入口本身钉住——并且先自证探针接得住调用，否则这条绿是空的（§8-43②）。
 */
describe("P99c-M · 市场视图的网络层探针", () => {
  it("读两支市场视图期间，fetch 与 tauri invoke 一次都没被叫（对照组证明探针接得住）", async () => {
    const real = globalThis.fetch;
    let fetchCalls: string[] = [];
    globalThis.fetch = (async (u: string | URL) => {
      fetchCalls.push(String(u));
      throw new Error("守卫夹具：自省面不许出网");
    }) as typeof globalThis.fetch;
    try {
      await readCatalog("market.status");
      await readCatalog("market.entries");
      await readCatalog("orchestrator.runtime");
      expect(fetchCalls, `读一次目录就出网了：${fetchCalls.join("、")}`).toEqual([]);
      // 正向对照：同一颗探针抓得住一次真调用
      await globalThis.fetch("/market/index.json").catch(() => undefined);
      expect(fetchCalls.length, "fetch 这颗探针根本没接住调用，上面那条绿是空的").toBe(1);
    } finally {
      globalThis.fetch = real;
    }
    fetchCalls = [];
    await readCatalog("market.status");
    expect(fetchCalls, "还原后又被叫上了：说明出网的是这条读路径").toEqual([]);
  });

  it("invoke 那一层也一样：市场读面不碰任何 Tauri 通道", async () => {
    netSpy.invokes.length = 0;
    await readCatalog("market.status");
    await readCatalog("market.entries");
    await readCatalog("orchestrator.runtime");
    expect(netSpy.invokes, `读目录把命令发出去了：${netSpy.invokes.join("、")}`).toEqual([]);
    // 正向对照：这颗探针接得住一次真调用（不然上面的空数组是假的）
    const core = (await import("@tauri-apps/api/core")) as unknown as { invoke: (c: string) => Promise<unknown> };
    await expect(core.invoke("market_fetch")).rejects.toThrow("守卫夹具");
    expect(netSpy.invokes).toEqual(["market_fetch"]);
    netSpy.invokes.length = 0;
  });
});
