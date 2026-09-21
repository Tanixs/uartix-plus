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
// 插件回滚会 scheduleStyles → extRuntime 直取 document（node 环境没有）
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));

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
    // byId 视图：拿列表里的真 id 走一遍，菜单上的尖括号写法与点号写法都要认
    const ids = { "protocols/<id>": "t1", "commands/<id>": "cmd1", "controls/<id>": "k1" } as const;
    for (const [path, id] of Object.entries(ids)) {
      expect((await readCatalog(path, { id })).ok).toBe(true);
      expect((await readCatalog(path.replace("<id>", id))).ok).toBe(true);
      expect((await readCatalog(path.replace("/<id>", `.${id}`))).ok).toBe(true);
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
      "../controls/commandStore", "../controls/controlsStore", "../operator/operatorStore", "../plot/plotStore",
      "../plugins/moduleHost", "../plugins/pluginStore", "../plugins/pluginToolDefs", "../protocol/telemetryStore",
      "../protocol/templateStore", "../session/sessionStore", "../table/framesStore", "../serial/serialStore", "@tauri-apps/api/app",
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
