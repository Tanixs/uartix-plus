import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P113-E：插件库快照的**引用语义**。
 *
 * 为什么单独钉这一件事（而不是钉"装完列表对不对"）：事故形态不是算错了，是**算了没人信**——
 * `emit()` 原来只 `{\u2026snapshot}`，外层换了、`plugins` 数组的引用原样带走，
 * 于是插件库列表那个 `useMemo([plugins, query, filter])` 永远等不到重算。
 * 市场装完插件要重进才刷新、而同一页的计数徽标却当场变了，就是这一条的两面。
 *
 * 所以这里钉的是契约本身：**写入之后数组引用必须是新的**，
 * 而"没有写入时不得换引用"是它的另一半（否则每次渲染都在原地换对象，
 * `useSyncExternalStore` 会白重渲染 —— 那是把 bug 换成另一种病）。
 */

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});
// 投影会真去动主题与 DOM，本案不问它。但**只覆盖那两个重的**：
// `./artifact` 还导出 `kindOfContribKey` 之类的纯函数，整模块替换会把它们一起抹掉
// （第一版就是这么红的：`No "kindOfContribKey" export is defined on the mock`）。
vi.mock("./artifact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifact")>()),
  disposeProjections: vi.fn(),
  rebuildProjections: vi.fn(),
}));

const KEY = "vs.pluginLib.v1";

function seed() {
  storage.set(
    KEY,
    JSON.stringify({
      plugins: [
        {
          pkg: {
            format: "uartix-plugin", schemaVersion: 2, id: "user.theme.a", version: "0.1.0",
            name: "A", hostApi: "^1.0", capabilities: ["theme.tokens"],
            contributions: { themes: [{ id: "main", entry: "main.json" }] },
            artifacts: { "main.json": { kind: "theme", vars: { "--bg": "#101014" } } },
            provenance: { createdBy: "user", reviewed: false },
          },
          state: "enabled",
          nonce: "n-a",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
}

const store = () => import("./pluginStore");

beforeEach(() => {
  storage.clear();
  seed();
});

describe("插件库快照：写入必须换数组引用", () => {
  it("没有写入时不换引用（否则订阅方每次渲染都白重算）", async () => {
    const s = await store();
    const a = s.getSnapshot();
    const b = s.getSnapshot();
    expect(b).toBe(a);
    expect(b.plugins).toBe(a.plugins);
  });

  it("一次写入之后：外层与 plugins 数组都必须换新引用", async () => {
    const s = await store();
    const before = s.getSnapshot();
    const beforeArr = before.plugins;
    const r = s.setEnabled("user.theme.a", false);
    expect(r.ok, `关不掉就没法测引用：${r.msg}`).toBe(true);
    const after = s.getSnapshot();
    expect(after).not.toBe(before);
    // 这一条才是本案的正主：消费方 memo 的依赖是 `plugins`，不是外层对象
    expect(after.plugins).not.toBe(beforeArr);
    expect(after.plugins.length).toBe(1);
  });

  it("订阅者被通知到（引用换了但没人知道，等于没修）", async () => {
    const s = await store();
    let hits = 0;
    const off = s.subscribe(() => { hits += 1; });
    s.setEnabled("user.theme.a", false);
    expect(hits).toBeGreaterThan(0);
    off();
    s.setEnabled("user.theme.a", false);
    expect(hits).toBe(1); // 取消订阅之后不再被打扰
  });
});
