/**
 * P174-B4：变更日志的判据测试。
 *
 * 核心承诺只有一条：**账本被正常操作改过之后，日志从头重放必须逐字段回到同一状态**。
 * 所以这里不手搓"期望的日志长什么样"，而是用真的 `planInstall / applyInstall /
 * applyUninstall` 造账本，再按 `pluginEngine` 的写点追加事件，最后让 `verifyJournal` 对账。
 *
 * 另一半是"日志不是摆设"：账本被人动过一格，核对必须指名道姓地说出是哪一格；
 * 读坏的事件不能半懂不懂地留下（那会让后面的差异全部指向错误的原因）。
 */
import { describe, expect, it } from "vitest";
import { validateExtension, type PluginManifest } from "./manifest";
import {
  REPO_VERSION,
  emptyIndex,
  emptyTrust,
  type PluginIndex,
  type TrustBook,
} from "./repo";
import { applyInstall, applyUninstall, planInstall, trustRecordFor } from "./install";
import {
  JOURNAL_VERSION,
  appendJournalEvent,
  approveJournalEvent,
  createJournalBook,
  installJournalEvent,
  normalizeJournal,
  rebuildFromJournal,
  toJournalState,
  verifyJournal,
  type JournalBook,
  type JournalState,
} from "./journal";

// 与 draftTools.test 同一写法：vitest 的 node 内置模块类型不在本仓 tsconfig 里
const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as {
  dirname: (p: string) => string;
  join: (...p: string[]) => string;
};

const APP = "C:/app";

function manifest(over: Record<string, unknown> = {}): PluginManifest {
  const r = validateExtension({
    format: "uartix-plugin",
    schemaVersion: 3,
    id: "demo.tool",
    version: "1.0.0",
    name: "示例工具",
    main: "main.mjs",
    activation: ["onPanel:p1"],
    permissions: { fs: { write: ["$WS/runs"], read: ["$WS"] } },
    contributes: { panels: [] },
    ...over,
  });
  if (!r.ok) throw new Error(`夹具清单不合法：${r.errors.join("；")}`);
  return r.manifest!;
}

interface Ledger {
  index: PluginIndex;
  trust: TrustBook;
  theme: string;
  book: JournalBook;
}

function install(led: Ledger, m: PluginManifest, at: number, source: "local" | "market", origin?: string): void {
  const p = planInstall({ appDir: APP, srcDir: "D:/pkgs/x", manifest: m, trust: led.trust, draftId: `d-${at}` });
  const next = applyInstall(led.index, led.trust, p, { approvedAt: at, source, ...(origin ? { origin } : {}) });
  const wroteTrust = p.verdict !== "trusted";
  led.index = next.index;
  led.trust = next.trust;
  led.book = appendJournalEvent(
    led.book,
    installJournalEvent(m.id, next.index.items[m.id], wroteTrust ? next.trust.items[m.id] : undefined, at),
  );
}

function start(): Ledger {
  const index = emptyIndex();
  const trust = emptyTrust();
  return {
    index,
    trust,
    theme: "",
    book: createJournalBook(toJournalState(index, trust, ""), 1000),
  };
}

function stateOf(led: Ledger): JournalState {
  return toJournalState(led.index, led.trust, led.theme);
}

describe("投影与重放", () => {
  it("`toJournalState` 只记逻辑事实：没有 dir，origin 为空就不留字段", () => {
    const led = start();
    install(led, manifest(), 1100, "local");
    const s = stateOf(led);
    expect(s.index["demo.tool"]).toEqual({
      version: "1.0.0",
      digest: expect.any(String),
      installedAt: 1100,
      source: "local",
      enabled: false,
    });
    expect("dir" in s.index["demo.tool"]).toBe(false);
    expect(s.trust["demo.tool"].grantedSummary.length).toBeGreaterThan(0);
  });

  it("安装→启用→换主题→批准磁盘孤儿→卸载→执行命令：重放与账本逐字段相同", () => {
    const led = start();

    install(led, manifest(), 1100, "local");
    install(led, manifest({ id: "demo.two", name: "第二个" }), 1200, "market", "github:acme/two");

    led.index = {
      ...led.index,
      items: { ...led.index.items, "demo.tool": { ...led.index.items["demo.tool"], enabled: true } },
    };
    led.book = appendJournalEvent(led.book, { t: "enable", at: 1300, id: "demo.tool" });

    led.theme = "plg:demo.tool:dark";
    led.book = appendJournalEvent(led.book, { t: "theme", at: 1400, key: led.theme });

    // 磁盘上手工放进来的插件：不在 index 里，只补一条信任记录
    const orphan = manifest({ id: "demo.three" });
    const rec = trustRecordFor(orphan, 1500);
    led.trust = { version: REPO_VERSION, items: { ...led.trust.items, [rec.id]: rec } };
    led.book = appendJournalEvent(led.book, approveJournalEvent(rec));

    const un = applyUninstall(led.index, led.trust, "demo.two");
    led.index = un.index;
    led.trust = un.trust;
    led.book = appendJournalEvent(led.book, { t: "uninstall", at: 1600, id: "demo.two" });

    // 命令只审计，不改状态
    led.book = appendJournalEvent(led.book, { t: "command", at: 1700, id: "demo.tool", command: "run", ok: false });

    expect(verifyJournal(led.book, stateOf(led))).toEqual([]);
    expect(rebuildFromJournal(led.book)).toEqual(stateOf(led));
    expect("demo.two" in rebuildFromJournal(led.book).index).toBe(false);
    expect(rebuildFromJournal(led.book).trust["demo.three"].digest).toBe(rec.digest);
    expect(rebuildFromJournal(led.book).trust["demo.three"].grantedSummary).toEqual(rec.grantedSummary);
    expect(rebuildFromJournal(led.book).activeTheme).toBe("plg:demo.tool:dark");
  });

  it("同一份权限面重装不重写信任库，日志里也不许带 trust（批准时间不能被改成今天）", () => {
    const led = start();
    install(led, manifest(), 1100, "local");
    const grantedAt = led.trust.items["demo.tool"].grantedAt;
    expect(grantedAt).toBe(1100);

    install(led, manifest(), 9000, "local");
    expect(led.book.events[1].t).toBe("install");
    expect("trust" in led.book.events[1]).toBe(false);
    expect(rebuildFromJournal(led.book).trust["demo.tool"].grantedAt).toBe(grantedAt);
    expect(led.index.items["demo.tool"].installedAt).toBe(9000);
    expect(verifyJournal(led.book, stateOf(led))).toEqual([]);
  });

  it("启用/停用只改账本里存在的条目：日志不能凭一条事件造出一个插件", () => {
    const led = start();
    led.book = appendJournalEvent(led.book, { t: "enable", at: 1200, id: "ghost" });
    expect(rebuildFromJournal(led.book).index).toEqual({});
    expect(verifyJournal(led.book, stateOf(led))).toEqual([]);
  });
});

describe("对账（日志被人动过 / 账本被人动过）", () => {
  function baseline(): { book: JournalBook; state: JournalState } {
    const led = start();
    install(led, manifest(), 1100, "local");
    return { book: led.book, state: stateOf(led) };
  }

  it("版本差一格也报，且指名插件与字段", () => {
    const { book, state } = baseline();
    const dirty = { ...state, index: { ...state.index, "demo.tool": { ...state.index["demo.tool"], version: "1.0.1" } } };
    const issues = verifyJournal(book, dirty);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("demo.tool");
    expect(issues[0]).toContain("版本");
    expect(issues[0]).toContain("1.0.1");
  });

  it("启用状态、权限摘要、当前主题各自都能被抓到", () => {
    const { book, state } = baseline();
    const idx = { ...state.index, "demo.tool": { ...state.index["demo.tool"], enabled: true } };
    expect(verifyJournal(book, { ...state, index: idx }).join("\n")).toContain("启用状态");

    const trust = { ...state.trust, "demo.tool": { ...state.trust["demo.tool"], digest: "改过了" } };
    expect(verifyJournal(book, { ...state, trust }).join("\n")).toContain("权限摘要不同");

    expect(verifyJournal(book, { ...state, activeTheme: "plg:x:y" }).join("\n")).toContain("当前主题");
  });

  it("账本多一个、日志多一个，都说得出来", () => {
    const { book, state } = baseline();
    const extraIndex = {
      ...state.index,
      ghost: { version: "1.0.0", digest: "d", installedAt: 1, source: "import" as const, enabled: true },
    };
    expect(verifyJournal(book, { ...state, index: extraIndex }).join("\n")).toContain("在账本里，日志里没有");

    const extraTrust = {
      ...state.trust,
      ghost: { version: "1.0.0", digest: "d", grantedAt: 1, grantedSummary: [] },
    };
    expect(verifyJournal(book, { ...state, trust: extraTrust }).join("\n")).toContain("信任记录「ghost」");
  });

  it("差异很多时截断，不让面板被一次坏账刷满", () => {
    const { book, state } = baseline();
    const index = { ...state.index };
    for (let i = 0; i < 12; i++) {
      index[`x${i}`] = { version: "1.0.0", digest: "d", installedAt: 1, source: "import", enabled: true };
    }
    const issues = verifyJournal(book, { ...state, index });
    expect(issues).toHaveLength(9); // 8 条 + 一条汇总
    expect(issues[8]).toContain("还有");
  });

  it("日志为空、账本非空 ⇒ 满屏差异（起底必须真的发生在账本为空时）", () => {
    const { state } = baseline();
    const empty = { version: JOURNAL_VERSION, events: [] } as JournalBook;
    expect(verifyJournal(empty, state).length).toBeGreaterThan(0);
  });
});

describe("追加与封顶折叠", () => {
  it("追加不改旧对象（append-only 的最基本证据）", () => {
    const led = start();
    const before = JSON.parse(JSON.stringify(led.book)) as JournalBook;
    const after = appendJournalEvent(led.book, { t: "theme", at: 2000, key: "k" });
    expect(led.book).toEqual(before);
    expect(after.events).toHaveLength(led.book.events.length + 1);
    expect(after.events[after.events.length - 1]).toEqual({ t: "theme", at: 2000, key: "k" });
  });

  it("超过上限先折叠：重放结果与不封顶的全量日志完全一致", () => {
    const events = [
      { t: "theme", at: 1, key: "a" },
      { t: "theme", at: 2, key: "b" },
      { t: "theme", at: 3, key: "c" },
      { t: "theme", at: 4, key: "d" },
      { t: "theme", at: 5, key: "e" },
    ] as const;

    let full: JournalBook = { version: JOURNAL_VERSION, events: [] };
    let capped: JournalBook = { version: JOURNAL_VERSION, events: [] };
    for (const ev of events) {
      full = appendJournalEvent(full, ev, 999);
      capped = appendJournalEvent(capped, ev, 3);
    }

    expect(capped.events.length).toBeLessThanOrEqual(3);
    expect(capped.baseline).toBeTruthy();
    expect(rebuildFromJournal(capped)).toEqual(rebuildFromJournal(full));
    expect(rebuildFromJournal(capped).activeTheme).toBe("e");
  });
});

describe("归一（磁盘上的普通 JSON）", () => {
  it("能读回自己写出去的：JSON 往返后重放结果不变", () => {
    const led = start();
    install(led, manifest(), 1100, "local");
    const raw = JSON.parse(JSON.stringify(led.book)) as unknown;
    const { journal, issues } = normalizeJournal(raw);
    expect(issues).toEqual([]);
    expect(journal).not.toBeNull();
    expect(rebuildFromJournal(journal!)).toEqual(stateOf(led));
  });

  it("版本不认、起点读不出来 ⇒ 整本作废并说明原因（调用方按当前账本重新起底）", () => {
    expect(normalizeJournal(null).journal).toBeNull();
    expect(normalizeJournal(null).issues).toEqual([]);

    const wrong = normalizeJournal({ version: 99, events: [] });
    expect(wrong.journal).toBeNull();
    expect(wrong.issues.join("")).toContain("99");

    const broken = normalizeJournal({ version: 1, baseline: { at: 1, state: { index: [], trust: {} } }, events: [] });
    expect(broken.journal).toBeNull();
    expect(broken.issues.join("")).toContain("起点快照");
  });

  it("单条事件坏了只丢那一条，且说出是第几条；好的照常留下", () => {
    const { journal, issues } = normalizeJournal({
      version: 1,
      events: [
        { t: "theme", at: 1, key: "ok" },
        { t: "no-such-event", at: 2 },
        { t: "enable", at: 3, id: "" },
      ],
    });
    expect(journal?.events).toHaveLength(1);
    expect(journal?.events[0]).toEqual({ t: "theme", at: 1, key: "ok" });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("第 2 条");
  });

  it("信任记录没有摘要的安装事件算坏事件（不能参与重建）", () => {
    const { journal, issues } = normalizeJournal({
      version: 1,
      events: [
        {
          t: "install",
          at: 1,
          id: "a.b",
          item: { version: "1.0.0", digest: "d" },
          trust: { version: "1.0.0", digest: "", grantedAt: 1, grantedSummary: [] },
        },
      ],
    });
    expect(journal?.events).toHaveLength(0);
    expect(issues.join("")).toContain("信任记录");
  });
});

describe("接线（日志不能只是几个纯函数）", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pluginEngine.ts"), "utf8");

  function bodyOf(name: string): string {
    const start = src.indexOf(`export async function ${name}`);
    if (start < 0) return "";
    const rest = src.slice(start + 1);
    const next = rest.indexOf("\nexport ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  it("每一个改账本的写点都追加了对应事件", () => {
    expect(bodyOf("commitInstall")).toContain("installJournalEvent(");
    expect(bodyOf("uninstall")).toContain('t: "uninstall"');
    expect(bodyOf("setEnabled")).toContain('t: "enable"');
    expect(bodyOf("setEnabled")).toContain('t: "disable"');
    expect(bodyOf("setActiveTheme")).toContain('t: "theme"');
    expect(bodyOf("approve")).toContain("approveJournalEvent(");
    expect(bodyOf("runCommand")).toContain('t: "command"');
    expect(bodyOf("runCommand")).toContain("ok: false");
  });

  it("加载时会核对；没有日志才起底", () => {
    expect(bodyOf("reload")).toContain("loadJournal(");
    expect(bodyOf("reload")).toContain("verifyJournal(");
    expect(bodyOf("reload")).toContain("createJournalBook(");
  });

  it("写日志失败不抛（账本已经写成功，不能为了日志回滚业务）", () => {
    const helper = src.slice(src.indexOf("async function appendJournal"), src.indexOf("async function recordJournal"));
    expect(helper).toContain("try {");
    expect(helper).toContain("catch");
    expect(helper).toContain("return `变更日志写入失败");
  });
});

describe("B2：场景事件只审计、不参与重建", () => {
  it("profile apply/revert 能归一；重放时状态不变（真正的状态变化由 enable/disable/theme 各自入账）", () => {
    const led = start();
    install(led, manifest(), 1100, "local");
    const before = stateOf(led);
    led.book = appendJournalEvent(led.book, { t: "profile", at: 1200, id: "p1", name: "YOLO", action: "apply" });
    led.book = appendJournalEvent(led.book, { t: "profile", at: 1300, id: "p1", name: "YOLO", action: "revert" });
    expect(rebuildFromJournal(led.book)).toEqual(before);
    expect(verifyJournal(led.book, before)).toEqual([]);

    const round = normalizeJournal(JSON.parse(JSON.stringify(led.book)) as unknown);
    expect(round.issues).toEqual([]);
    expect(round.journal?.events.slice(-2)).toEqual([
      { t: "profile", at: 1200, id: "p1", name: "YOLO", action: "apply" },
      { t: "profile", at: 1300, id: "p1", name: "YOLO", action: "revert" },
    ]);
  });

  it("缺动作的 profile 事件算坏事件", () => {
    const r = normalizeJournal({ version: 1, events: [{ t: "profile", at: 1, id: "p1", name: "x" }] });
    expect(r.journal?.events).toHaveLength(0);
    expect(r.issues.join("")).toContain("场景动作");
  });
});

describe("R7③：目录绑定事件只审计、不参与重建", () => {
  it("root 事件能归一；重放时状态不变（绑定在 settings 账本里，不在 index/trust）", () => {
    const led = start();
    install(led, manifest(), 1100, "local");
    const before = stateOf(led);
    led.book = appendJournalEvent(led.book, { t: "root", at: 1200, id: "a.b", spec: "$WS", path: "D:/ws", forWrite: true });
    led.book = appendJournalEvent(led.book, { t: "root", at: 1300, id: "", spec: "$EXT:deploy", path: "D:/d", forWrite: false });
    expect(rebuildFromJournal(led.book)).toEqual(before);
    expect(verifyJournal(led.book, before)).toEqual([]);

    const round = normalizeJournal(JSON.parse(JSON.stringify(led.book)) as unknown);
    expect(round.issues).toEqual([]);
    expect(round.journal?.events.slice(-2)).toEqual([
      { t: "root", at: 1200, id: "a.b", spec: "$WS", path: "D:/ws", forWrite: true },
      // `id` 空串是合法的：那是用户自己在设置页改的，没有"请求方插件"
      { t: "root", at: 1300, id: "", spec: "$EXT:deploy", path: "D:/d", forWrite: false },
    ]);
  });

  // 这一条是整个类型存在的意义：账本里能写的形状必须比"桥能送来的形状"更窄，
  // 否则一次坏写入就能把任意路径安到某个插件头上
  it("路径变量形状不对的 root 事件算坏事件", () => {
    for (const spec of ["deploy", "$APP", "$EXT:../x", "$EXT:Bad_Key", "C:/Users"]) {
      const r = normalizeJournal({ version: 1, events: [{ t: "root", at: 1, id: "a.b", spec, path: "D:/x", forWrite: true }] });
      expect(r.journal?.events, spec).toHaveLength(0);
      expect(r.issues.join(""), spec).toContain("路径变量");
    }
    const noFlag = normalizeJournal({ version: 1, events: [{ t: "root", at: 1, id: "a.b", spec: "$WS", path: "D:/x" }] });
    expect(noFlag.journal?.events).toHaveLength(0);
    expect(noFlag.issues.join("")).toContain("写权限标记");
  });
});
