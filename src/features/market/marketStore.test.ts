/**
 * P99b-N1：市场 store 的行为测试。
 *
 * 重点不是"能不能取回"，而是三条**刻意的不宽松**有没有被以后的人"优化"掉：
 * 拉不到时不许拿旧清单当现状、启动路径不许联网、镜像不许变成绕过白名单的后门。
 * 每条都配了反向断言（例如失败后 index 必须是 null，而不是"还是上一次的内容"）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// 夹具的信封版本跟着契约层走（写死数字的话，抬版时这一批会集体变红却没人知道为什么）
import { MARKET_SCHEMA_VERSION } from "./marketIndex";

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
const browse = await import("./marketBrowse");
const { MARKET_ALLOW_HOSTS } = await import("./marketIndex");

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
      schemaVersion: MARKET_SCHEMA_VERSION, name: "货架", generatedAt: "2026-09-22T00:00:00Z", source: "s",
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
    const payload = enc.encode(JSON.stringify({ schemaVersion: MARKET_SCHEMA_VERSION, categories: { theme: "外观" }, entries: [] }));
    st.invokeImpl = async () => ({ data: Buffer2b64(payload), sha256: "a".repeat(64), bytes: payload.length, contentType: "application/json" });
    const s = await store.refreshIndex();
    expect(s.status).toBe("ready");
    const call = st.invokes.find((i) => i.cmd === "market_fetch");
    // 这条按**字面清单**对：多一个域就是多一个信任面，改白名单必须在这里显式过一次手（P99c-R2 加的就是 registry）
    expect(call?.args.allowHosts).toEqual(["raw.githubusercontent.com", "github.com", "registry.npmjs.org"]);
    expect(Number(call?.args.maxBytes)).toBeGreaterThan(1024 * 100);
  });
});

describe("P99b-N1：拉不到就说拉不到", () => {
  it("失败时 index 归 null、原因与耗时可显示（不许把旧清单当现状）", async () => {
    st.fetchImpl = await okJson({ schemaVersion: MARKET_SCHEMA_VERSION, categories: { theme: "外观" }, entries: [] });
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
    const payload = enc.encode(JSON.stringify({ schemaVersion: MARKET_SCHEMA_VERSION, categories: { theme: "外观" }, entries: [] }));
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

  it("设置页那句回显与 applyMirror 同一支判定：说「会被用上」的，装包时就得真的用上（详设 R5）", () => {
    for (const p of ["", "https://github.com/m/", "https://github.com/m", "http://github.com/", "https://mirror.evil.example/", "not a url"]) {
      st.settings.marketMirrorPrefix = p;
      const used = store.applyMirror("https://raw.githubusercontent.com/x/y") !== null;
      const talk = browse.mirrorEndpointTalk(p, MARKET_ALLOW_HOSTS);
      expect(talk.ok, `前缀「${p}」：回显说${talk.ok ? "会被用上" : "用不上"}，applyMirror 却判${used ? "用上了" : "没用"}`).toBe(used);
    }
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
      schemaVersion: MARKET_SCHEMA_VERSION, categories: { theme: "外观" }, entries: [{
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

/* ================= P99c-R2：npm 条目这条取回半边 =================
 * 这里测的不是"能不能解 tar"（那是 `npmUnpack.test` 的活），而是三条**取回口径**：
 *  ① 哈希与字节数比的是 tarball 那枚对象，解出来的清单文本另算；
 *  ② 任一条不过就拒，且拒在解包**之前**（没对过账的字节不许先进内存再挑内容）；
 *  ③ npm 条目不退镜像——这条要有对照组，否则"只调了一次"可能只是因为镜像根本没配。
 */
const cryptoSpec = "node:crypto";
const { createHash } = (await import(cryptoSpec)) as unknown as {
  createHash: (alg: string) => { update(b: Uint8Array): { digest(enc: string): string } };
};
const tgzB64 = await readFile(fileURLToPath(new URL("__fixtures__/probe-1.0.0.tgz", import.meta.url)), "base64");
const tgzBytes = Uint8Array.from(atob(tgzB64), (c) => c.charCodeAt(0));
const REAL_SHA = createHash("sha256").update(tgzBytes).digest("hex");
const NPM_URL = "https://registry.npmjs.org/probe/-/probe-1.0.0.tgz";

describe("P99c-R2：npm 条目这条取回半边", () => {
  function npmE(over: Record<string, unknown> = {}) {
    return {
      id: "uartix.probe.theme", name: "探针", author: "a", category: "theme",
      description: { zh: "只用于测试" }, version: "1.0.0", packageUrl: NPM_URL,
      sha256: REAL_SHA, bytes: tgzBytes.length, capabilities: ["theme.tokens"], screenshots: [],
      minAppVersion: "0.4.1", updated: "2026-09-20", npm: { name: "probe", version: "1.0.0" }, ...over,
    } as unknown as import("./marketIndex").MarketEntry;
  }
  const shelfE = (over: Record<string, unknown> = {}) =>
    ({ ...npmE(over), npm: undefined, packageUrl: "https://raw.githubusercontent.com/o/r/a.uartix.json" }) as unknown as import("./marketIndex").MarketEntry;

  it("夹具是真东西：583 上下的 tarball，不是空字节（§8-54）", () => {
    expect(tgzBytes.length).toBeGreaterThan(300);
    expect(REAL_SHA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("成功路径：取回 tarball、按声明比完才解包，bytes 报的是 tarball 那个数", async () => {
    st.invokeImpl = async () => ({ data: tgzB64, sha256: REAL_SHA, bytes: tgzBytes.length });
    const r = await store.fetchPackage(npmE());
    expect(r.ok, r.ok ? "" : r.msg).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.text).id).toBe("uartix.probe.theme");
    expect(r.bytes, "确认框要显示「实际到手多少字节」，报成清单文本的长度就是骗人").toBe(tgzBytes.length);
    expect(r.bytes, "两个数必须是两个不同的数，否则这条测不出语义").not.toBe(enc.encode(r.text).length);
  });

  it("哈希不符就拒，而且拒在解包之前", async () => {
    // 送回去的既不是那枚 tarball、哈希也不是声明的那个：先对账就该先在这里停下
    st.invokeImpl = async () => ({ data: btoa("not-a-tarball"), sha256: "f".repeat(64), bytes: 12 });
    const r = await store.fetchPackage(npmE());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.msg).toContain("包哈希");
    expect(r.msg, "走到了取清单那一步＝顺序反了，没对过账的字节先进了内存").not.toContain("取不出清单");
  });

  it("字节数不符也拒（npm 条目比的是 tarball 的字节）", async () => {
    st.invokeImpl = async () => ({ data: tgzB64, sha256: REAL_SHA, bytes: tgzBytes.length });
    const r = await store.fetchPackage(npmE({ bytes: tgzBytes.length - 1 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.msg).toContain("字节数");
  });

  it("npm 条目配了镜像也只打一次：对照组（自建货架条目）会退镜像", async () => {
    st.settings.marketMirrorPrefix = "https://github.com/";
    st.invokeImpl = async () => {
      throw new Error("直连超时");
    };
    const npm = await store.fetchPackage(npmE());
    expect(npm.ok).toBe(false);
    expect(st.invokes.map((i) => String(i.args.url))).toEqual([NPM_URL]);
    if (npm.ok) return;
    expect(npm.msg, "npm 那条不该出现「镜像：…」这句——它根本没退镜像").not.toContain("镜像");

    st.invokes.length = 0;
    const shelf = await store.fetchPackage(shelfE());
    expect(shelf.ok).toBe(false);
    expect(st.invokes.length, "对照组没退镜像：镜像那半条坏了，上面的 npm 断言也就没测到东西").toBe(2);
  });
});
