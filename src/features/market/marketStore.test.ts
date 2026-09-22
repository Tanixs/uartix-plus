/**
 * P99b-N1：市场 store 的行为测试。
 *
 * 重点不是"能不能取回"，而是三条**刻意的不宽松**有没有被以后的人"优化"掉：
 * 拉不到时不许拿旧清单当现状、启动路径不许联网、镜像不许变成绕过白名单的后门。
 * 每条都配了反向断言（例如失败后 index 必须是 null，而不是"还是上一次的内容"）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 读源文本走变量说明符的动态导入（同时绕开 vite 的字面量解析与 tsc 缺 @types/node）
const fsSpec = "node:fs/promises";
const urlSpec = "node:url";
const { readFile } = (await import(fsSpec)) as { readFile: (p: string, enc?: string) => Promise<string> };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const readSrc = (rel: string) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const st = vi.hoisted(() => ({
  settings: { marketIndexUrl: "/market/index.json", marketMirrorPrefix: "", aiProxy: "", aiNoProxy: "" },
  invokes: [] as { cmd: string; args: Record<string, unknown> }[],
  fetchImpl: null as null | ((u: string) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer>; blob: () => Promise<Blob>; text?: string }>),
  invokeImpl: null as null | ((cmd: string, args: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock("../settings/settingsStore", () => ({ getSnapshot: () => st.settings }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    st.invokes.push({ cmd, args });
    if (!st.invokeImpl) throw new Error("测试没设 invokeImpl");
    return st.invokeImpl(cmd, args);
  },
}));

// 单实例：这个模块有模块级状态，并发 dynamic import 会拿到两份（vitest 的脾气，§8-43③）
const store = await import("./marketStore");

const enc = new TextEncoder();

function okJson(obj: unknown) {
  const buf = enc.encode(JSON.stringify(obj));
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    blob: async () => new Blob([buf], { type: "application/json" }),
  });
}

beforeEach(() => {
  st.invokes.length = 0;
  st.settings.marketIndexUrl = "/market/index.json";
  st.settings.marketMirrorPrefix = "";
  st.fetchImpl = null;
  st.invokeImpl = null;
  // 同源相对地址在 node 的 fetch 里会因缺 base 报错，那样测的是 node 不是我们
  globalThis.fetch = (async (u: string | URL) => {
    if (!st.fetchImpl) throw new Error("测试没设 fetchImpl");
    return st.fetchImpl(String(u));
  }) as unknown as typeof fetch;
});

describe("P99b-N1：不自动联网", () => {
  it("模块加载后是 idle，且一次请求都没发过", () => {
    expect(store.getMarketSnapshot().status).toBe("idle");
    expect(st.invokes).toHaveLength(0);
  });

  it("同源索引用 webview fetch，绝不走远程白名单通道", async () => {
    st.fetchImpl = await okJson({
      schemaVersion: 1, name: "货架", generatedAt: "2026-09-22T00:00:00Z", source: "s",
      categories: { theme: "外观" },
      entries: [{
        id: "uartix.theme.a", name: "甲", author: "uartix", category: "theme",
        description: { zh: "甲主题" }, version: "1.0.0", minAppVersion: "0.4.1", updated: "2026-09-20",
        packageUrl: "/market/pkg/a.json", sha256: "b".repeat(64), bytes: 10, capabilities: ["theme.tokens"], screenshots: [],
      }],
    });
    const s = await store.refreshIndex();
    expect(s.status).toBe("ready");
    expect(s.index?.entries).toHaveLength(1);
    expect(s.viaMirror).toBe(false);
    expect(st.invokes.filter((i) => i.cmd === "market_fetch")).toHaveLength(0);
  });

  it("外部索引必须走 Rust 通道，并把白名单与字节上限一起带下去", async () => {
    st.settings.marketIndexUrl = "https://raw.githubusercontent.com/Tanixs/uartix-market/main/index.json";
    const payload = enc.encode(JSON.stringify({ schemaVersion: 1, categories: { theme: "外观" }, entries: [] }));
    st.invokeImpl = async () => ({ data: Buffer2b64(payload), sha256: "a".repeat(64), bytes: payload.length, contentType: "application/json" });
    const s = await store.refreshIndex();
    expect(s.status).toBe("ready");
    const call = st.invokes.find((i) => i.cmd === "market_fetch");
    expect(call?.args.allowHosts).toEqual(["raw.githubusercontent.com", "github.com"]);
    expect(Number(call?.args.maxBytes)).toBeGreaterThan(1024 * 100);
  });
});

describe("P99b-N1：拉不到就说拉不到", () => {
  it("失败时 index 归 null、原因与耗时可显示（不许把旧清单当现状）", async () => {
    st.fetchImpl = await okJson({ schemaVersion: 1, categories: { theme: "外观" }, entries: [] });
    expect((await store.refreshIndex()).status).toBe("ready");
    st.fetchImpl = async () => {
      throw new Error("连接被重置");
    };
    const s = await store.refreshIndex();
    expect(s.status).toBe("failed");
    expect(s.index).toBeNull();
    expect(s.error).toContain("拉不到索引");
    expect(s.error).toContain("连接被重置");
    expect(s.error).toMatch(/s）/); // 带耗时
  });

  it("索引不是 JSON 时说清楚，不硬解析成空货架", async () => {
    st.fetchImpl = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => enc.encode("<html>网关拦截页</html>").buffer as ArrayBuffer,
      blob: async () => new Blob(["<html></html>"]),
    });
    const s = await store.refreshIndex();
    expect(s.status).toBe("failed");
    expect(s.error).toContain("不是合法 JSON");
  });
});

describe("P99b-N1：镜像只兜底，不绕闸", () => {
  it("直连失败才试镜像，且把两条原因都留在日志里", async () => {
    st.settings.marketMirrorPrefix = "https://github.com/";
    st.settings.marketIndexUrl = "https://raw.githubusercontent.com/Tanixs/uartix-market/main/index.json";
    const payload = enc.encode(JSON.stringify({ schemaVersion: 1, categories: { theme: "外观" }, entries: [] }));
    st.invokeImpl = async (_cmd, args) => {
      if (String(args.url).startsWith("https://github.com/")) {
        return { data: Buffer2b64(payload), sha256: "a".repeat(64), bytes: payload.length, contentType: "application/json" };
      }
      throw new Error("直连超时");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await store.refreshIndex();
    expect(s.status).toBe("ready");
    expect(s.viaMirror).toBe(true);
    expect(String(warn.mock.calls[0]?.[0])).toContain("直连超时"); // 镜像不能变成唯一真相
    warn.mockRestore();
  });

  it("镜像前缀的域不在白名单就忽略它（否则镜像是绕闸的后门）", async () => {
    st.settings.marketMirrorPrefix = "https://mirror.evil.example/";
    st.settings.marketIndexUrl = "https://raw.githubusercontent.com/Tanixs/uartix-market/main/index.json";
    st.invokeImpl = async () => {
      throw new Error("直连不通");
    };
    const s = await store.refreshIndex();
    expect(s.status).toBe("failed");
    expect(s.error).toContain("直连不通");
    expect(s.error).not.toContain("镜像："); // 压根没试镜像
    expect(st.invokes.map((i) => String(i.args.url))).toEqual(["https://raw.githubusercontent.com/Tanixs/uartix-market/main/index.json"]);
  });

  it("前缀不是 https 也忽略", () => {
    st.settings.marketMirrorPrefix = "http://github.com/";
    expect(store.applyMirror("https://raw.githubusercontent.com/a/b")).toBeNull();
  });
});

describe("P99b-N1：包体与截图", () => {
  it("哈希与索引声明不符就拒，绝不入库", async () => {
    st.settings.marketIndexUrl = "https://raw.githubusercontent.com/Tanixs/uartix-market/main/pkg/a.json";
    st.invokeImpl = async () => ({ data: Buffer2b64(enc.encode("{}")), sha256: "e".repeat(64), bytes: 2, contentType: "application/json" });
    const r = await store.fetchPackage({
      id: "a", name: "a", author: "x", category: "theme", description: { zh: "a" }, version: "1.0.0",
      packageUrl: "https://raw.githubusercontent.com/Tanixs/uartix-market/main/pkg/a.json",
      sha256: "a".repeat(64), bytes: 2, capabilities: [], screenshots: [], minAppVersion: "0.4.1", updated: "2026-09-20",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toContain("哈希与索引声明不符");
  });

  it("哈希对得上但字节数对不上 ⇒ 同样拒（「货架写的」与「给你的」必须同一件东西）", async () => {
    const body = enc.encode('{"format":"uartix-plugin"}');
    st.invokeImpl = async () => ({
      data: Buffer2b64(body), sha256: "a".repeat(64), bytes: body.length, contentType: "application/json",
    });
    const r = await store.fetchPackage({
      id: "a", name: "a", author: "x", category: "theme", description: { zh: "a" }, version: "1.0.0",
      packageUrl: "https://raw.githubusercontent.com/Tanixs/uartix-market/main/pkg/a.json",
      sha256: "a".repeat(64), bytes: body.length + 7, capabilities: [], screenshots: [], minAppVersion: "0.4.1", updated: "2026-09-20",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toContain("字节数与索引声明不符");
  });

  it("截图走同一条白名单通道，并带 mime 的 data URL 回来", async () => {
    st.invokeImpl = async () => ({ data: "AAAB", sha256: "", bytes: 3, contentType: "image/png; charset=binary" });
    const r = await store.fetchImage("https://raw.githubusercontent.com/Tanixs/uartix-market/main/img/x.png");
    expect(r.ok && (r as { dataUrl: string }).dataUrl.startsWith("data:image/png;base64,AAAB")).toBe(true);
  });
});

describe("P99b-N1：收藏（与本机库的对照已挪到契约层 compareInstall）", () => {
  it("下架条目一键清除：只清不在架上的，收藏里的在架条目留着", async () => {
    st.fetchImpl = await okJson({
      schemaVersion: 1, categories: { theme: "外观" }, entries: [{
        id: "uartix.theme.keep", name: "留", author: "x", category: "theme", description: { zh: "留" },
        version: "1.0.0", minAppVersion: "0.4.1", updated: "2026-09-20",
        packageUrl: "/market/pkg/k.json", sha256: "c".repeat(64), bytes: 1, capabilities: [], screenshots: [],
      }],
    });
    await store.refreshIndex();
    expect(store.toggleFavorite("uartix.theme.keep").added).toBe(true);
    expect(store.toggleFavorite("uartix.theme.gone").added).toBe(true);
    expect(store.getMarketSnapshot().favorites).toContain("uartix.theme.gone");
    expect(store.clearMissingFavorites().removed).toBe(1);
    expect(store.getMarketSnapshot().favorites).toEqual(["uartix.theme.keep"]);
    expect(store.toggleFavorite("uartix.theme.keep").added).toBe(false);
  });

  it("同源判定与版本比较只有契约里那一份实现（各写一份，「有更新」就会说谎）", async () => {
    const src = await readSrc("./marketStore.ts");
    expect(src, "store 不许自带第二份「是不是包内文件」的判定").not.toMatch(/startsWith\("\/"\)/);
    expect(src, "对照是契约层的事，store 里不许再出现第二份比较器或四态映射").not.toMatch(/function\s+(compare\w*Version|compareInstall)/);
    expect(src).toContain("isBundledPath");
  });

  it("包内索引取不到时不去敲镜像的门（那是安装坏了，不是网络不通）", async () => {
    st.settings.marketMirrorPrefix = "https://raw.githubusercontent.com/mirror/";
    st.fetchImpl = async () => {
      throw new Error("本地文件读不到");
    };
    const s = await store.refreshIndex();
    expect(s.status).toBe("failed");
    expect(s.error).toContain("本地文件读不到");
    expect(st.invokes.length, "镜像不该替包内文件兜底").toBe(0);
  });
});

/** 造 base64 给 mock 用（node 18+ / web 都有全局 btoa，不必引 node 类型） */
function Buffer2b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
