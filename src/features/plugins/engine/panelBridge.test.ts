/**
 * P174-A7：面板桥的判据。
 *
 * 这一层的输入**来自 iframe**——也就是用户装的代码。所以这里的每一条都是"恶意/写错的消息
 * 会不会被当成正常请求处理"，而不是"happy path 通不通"。
 */

import { describe, expect, it } from "vitest";
import {
  PANEL_MSG_KEY,
  PANEL_PROTOCOL,
  buildSrcdoc,
  collectPluginPanels,
  eventMsg,
  panelViewId,
  parseBridgeMessage,
  parsePanelViewId,
  resErr,
  resOk,
} from "./panelBridge";

describe("视图 id", () => {
  it("拼出来能解回去（插件 id 带点、面板 id 带短横都不影响）", () => {
    const id = panelViewId("uartix.hello", "train-panel");
    expect(id).toBe("plugin-view-uartix.hello:train-panel");
    expect(parsePanelViewId(id)).toEqual({ pluginId: "uartix.hello", panelId: "train-panel" });
  });

  it("不是这个前缀的一律 null（不能把内置面板 id 当插件面板）", () => {
    expect(parsePanelViewId("plot2d")).toBeNull();
    expect(parsePanelViewId("ext-panel-abc")).toBeNull();
    expect(parsePanelViewId("plugin-view-")).toBeNull();
    expect(parsePanelViewId("plugin-view-abc")).toBeNull(); // 没有冒号 ⇒ 分不出两段
    expect(parsePanelViewId("plugin-view-:p")).toBeNull(); // 缺插件 id
    expect(parsePanelViewId("plugin-view-a:")).toBeNull(); // 缺面板 id
  });
});

describe("collectPluginPanels", () => {
  const src = (id: string, panels: { id: string; title: string; entry: string }[], enabled = true) => ({
    id,
    manifest: { contributes: { panels } },
    enabled,
  });

  it("按视图 id 排序，与目录/安装顺序无关", () => {
    const out = collectPluginPanels([
      src("zzz.last", [{ id: "b", title: "B", entry: "b.html" }]),
      src("aaa.first", [{ id: "z", title: "Z", entry: "z.html" }]),
    ]);
    expect(out.map((p) => p.viewId)).toEqual(["plugin-view-aaa.first:z", "plugin-view-zzz.last:b"]);
  });

  it("同一插件里重复的面板 id 只留第一个", () => {
    const out = collectPluginPanels([
      src("a.b", [
        { id: "p", title: "第一个", entry: "1.html" },
        { id: "p", title: "第二个", entry: "2.html" },
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("第一个");
  });

  it("两个不同插件可以用同一个面板 id（视图 id 里有插件 id）", () => {
    const out = collectPluginPanels([
      src("a.b", [{ id: "main", title: "A", entry: "a.html" }]),
      src("c.d", [{ id: "main", title: "C", entry: "c.html" }]),
    ]);
    expect(out.map((p) => p.viewId)).toEqual(["plugin-view-a.b:main", "plugin-view-c.d:main"]);
  });

  it("没声明面板的插件贡献 0 条（不产生空 optgroup）", () => {
    expect(collectPluginPanels([{ id: "x.y", manifest: { contributes: {} }, enabled: true }])).toEqual([]);
  });

  /**
   * A12：**装完不启用就不该出现在 +面板**。
   *
   * 这条是产品流程的那半句"然后启用"。它红了的表现很具体：用户刚在市场里装完一个插件，
   * 还没点启用，菜单里就已经多了一项——于是"启用"这个动作变成装饰。
   */
  it("没启用的插件贡献 0 条；启用与否不影响别的插件", () => {
    const panels = [{ id: "p", title: "P", entry: "p.html" }];
    expect(collectPluginPanels([src("a.b", panels, false)])).toEqual([]);
    const out = collectPluginPanels([src("a.b", panels, false), src("c.d", panels)]);
    expect(out.map((p) => p.viewId)).toEqual(["plugin-view-c.d:p"]);
  });
});

describe("parseBridgeMessage（来自 iframe 的输入一律当不可信）", () => {
  const env = (o: Record<string, unknown>) => ({ [PANEL_MSG_KEY]: PANEL_PROTOCOL, ...o });

  it("req：形状对就收", () => {
    expect(parseBridgeMessage(env({ kind: "req", reqId: "r1", method: "ping", args: { a: 1 } }))).toEqual({
      kind: "req",
      reqId: "r1",
      method: "ping",
      args: { a: 1 },
    });
  });

  it("req：方法名只许 [A-Za-z0-9_.-]（挡住路径式与空白式方法名）", () => {
    for (const m of ["a b", "a/b", "../x", "a\nb", ""]) {
      expect(parseBridgeMessage(env({ kind: "req", reqId: "r1", method: m })), m).toBeNull();
    }
    expect(parseBridgeMessage(env({ kind: "req", reqId: "r1", method: "a.b-c_1" }))).not.toBeNull();
  });

  it("req：超长方法名 / 超长 reqId 一律拒", () => {
    expect(parseBridgeMessage(env({ kind: "req", reqId: "r1", method: "a".repeat(201) }))).toBeNull();
    expect(parseBridgeMessage(env({ kind: "req", reqId: "r".repeat(65), method: "ping" }))).toBeNull();
  });

  it("fs：writeText 必须带 content，且不许超过 1 MiB", () => {
    expect(parseBridgeMessage(env({ kind: "fs", reqId: "r1", op: "writeText", path: "a.txt" }))).toBeNull();
    expect(
      parseBridgeMessage(env({ kind: "fs", reqId: "r1", op: "writeText", path: "a.txt", content: "x".repeat(1024 * 1024 + 1) })),
    ).toBeNull();
    expect(parseBridgeMessage(env({ kind: "fs", reqId: "r1", op: "readText", path: "a.txt" }))).not.toBeNull();
  });

  it("fs：未知 op 拒（不然宿主会走到一个没有分支的路径上）", () => {
    expect(parseBridgeMessage(env({ kind: "fs", reqId: "r1", op: "delete", path: "a" }))).toBeNull();
  });

  it("信封不对一律 null：协议版本不对 / 不是对象 / 缺标记", () => {
    expect(parseBridgeMessage({ [PANEL_MSG_KEY]: 2, kind: "req", reqId: "r", method: "a" })).toBeNull();
    expect(parseBridgeMessage({ kind: "req", reqId: "r", method: "a" })).toBeNull();
    expect(parseBridgeMessage("req")).toBeNull();
    expect(parseBridgeMessage(null)).toBeNull();
    expect(parseBridgeMessage([env({ kind: "ready" })])).toBeNull();
  });

  it("host：只认 workspace / pickFolder / bindRoot（多一条就是给插件多一条宿主能力）", () => {
    expect(parseBridgeMessage(env({ kind: "host", reqId: "r1", op: "workspace" }))).toEqual({
      kind: "host",
      reqId: "r1",
      op: "workspace",
    });
    expect(parseBridgeMessage(env({ kind: "host", reqId: "r1", op: "pickFolder" }))).not.toBeNull();
    for (const op of ["exec", "openUrl", "dialog", ""]) {
      expect(parseBridgeMessage(env({ kind: "host", reqId: "r1", op })), op).toBeNull();
    }
  });

  it("bindRoot：spec 只收清单里那种整形，别的写法一律不认", () => {
    expect(parseBridgeMessage(env({ kind: "host", reqId: "r7", op: "bindRoot", spec: "$WS" }))).toEqual({
      kind: "host",
      reqId: "r7",
      op: "bindRoot",
      spec: "$WS",
    });
    expect(parseBridgeMessage(env({ kind: "host", reqId: "r7", op: "bindRoot", spec: "$EXT:deploy" }))).not.toBeNull();
    // 这些是"键名让插件自己编"的各种形状：绝对路径、穿越、自造变量、大写键、空串
    for (const spec of ["", "deploy", "$EXT:", "$EXT:Deploy", "$EXT:a/b", "$APP", "C:/Windows", "$EXT:../x", "$EXT:k".padEnd(60, "x")]) {
      expect(parseBridgeMessage(env({ kind: "host", reqId: "r7", op: "bindRoot", spec })), spec).toBeNull();
    }
    // 少了 spec 的 bindRoot 同样不认：宿主不该猜它要绑哪一条
    expect(parseBridgeMessage(env({ kind: "host", reqId: "r7", op: "bindRoot" }))).toBeNull();
  });

  it("ready 是最小形状，不需要 reqId", () => {
    expect(parseBridgeMessage(env({ kind: "ready" }))).toEqual({ kind: "ready" });
  });
});

describe("回给 iframe 的消息", () => {
  it("ok 的 data 是 undefined 时给 null（postMessage 会把 undefined 变成缺失字段）", () => {
    expect(resOk("r1", undefined)).toEqual({ kind: "res", reqId: "r1", ok: true, data: null });
  });

  it("错误文本截断在 2000 字以内（一条超长堆栈不该撑爆消息）", () => {
    const e = resErr("r1", "internal", "x".repeat(5000));
    expect(e.kind).toBe("res");
    if (e.kind === "res" && !e.ok) expect(e.err).toHaveLength(2000);
  });

  it("事件消息带 event 与 payload", () => {
    expect(eventMsg("heartbeat", { beats: 3 })).toEqual({ kind: "event", event: "heartbeat", payload: { beats: 3 } });
  });
});

describe("buildSrcdoc", () => {
  const info = { pluginId: "a.b", panelId: "p", title: "面板" };

  it("桥必须排在插件自己的脚本之前（否则 onload 里第一句 uartix.call 就是 undefined）", () => {
    const html = "<html><head><title>x</title></head><body><script>uartix.call('a')</script></body></html>";
    const out = buildSrcdoc(html, info);
    expect(out).toContain("window.uartix");
    expect(out.indexOf("window.uartix")).toBeLessThan(out.indexOf("uartix.call('a')"));
    // 插件自己的 HTML 一个字节都不能少
    expect(out).toContain("<title>x</title>");
    expect(out).toContain("uartix.call('a')");
  });

  it("没有 <head> 时插在 <html> 之后", () => {
    const out = buildSrcdoc("<html><body>hi</body></html>", info);
    expect(out.startsWith("<html>")).toBe(true);
    expect(out.indexOf("window.uartix")).toBeLessThan(out.indexOf("hi"));
  });

  it("没有 <html> 但有 doctype 时插在 doctype 之后（保持标准模式）", () => {
    const out = buildSrcdoc("<!doctype html><body>hi</body>", info);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out.indexOf("window.uartix")).toBeLessThan(out.indexOf("hi"));
  });

  it("什么都没有就直接前置（不为了好看去编一个 <html>）", () => {
    const out = buildSrcdoc("纯文本", info);
    expect(out.indexOf("window.uartix")).toBeLessThan(out.indexOf("纯文本"));
  });

  it("主题变量里的 </style> 逃不出样式块（这是第二个注入面，不是同一个）", () => {
    const out = buildSrcdoc("<html><head></head><body>x</body></html>", {
      ...info,
      theme: { vars: { "--uartix-bg": "</style><script>alert(1)</script>" }, scheme: "dark", font: "x" },
    });
    // 脏值整条丢掉：样式块里既没有多出的 </style>，也没有第二条 style/script
    expect(out.match(/<\/style>/g)).toHaveLength(1);
    expect(out.match(/<script/g)).toHaveLength(1);
    expect(out).not.toContain("--uartix-bg: </style>");
    expect(out).toContain('<style id="uartix-host-theme">');
    // INFO 里那份只是 JSON 字符串（给 uartix.theme() 读的），标签必须转义过
    expect(out).not.toContain("</script>alert");
  });

  it("主题桥：宿主 token 以 --uartix-* 落进 iframe，且排在插件自己的样式之前", () => {
    const html = "<html><head><style>:root{--bg:#123456}</style></head><body>x</body></html>";
    const out = buildSrcdoc(html, {
      ...info,
      theme: { vars: { "--uartix-bg": "#101014", "--uartix-accent": "#4c8dff" }, scheme: "dark", font: '"Segoe UI"' },
    });
    expect(out).toContain("--uartix-bg: #101014;");
    expect(out).toContain("--uartix-accent: #4c8dff;");
    expect(out.indexOf("uartix-host-theme")).toBeLessThan(out.indexOf("--bg:#123456"));
    // 插件自己的那份一个字节不少：零特异性基础层是"垫",不是"替"
    expect(out).toContain("<style>:root{--bg:#123456}</style>");
  });

  it("主题桥：uartix.theme() 读当前值，theme 事件来了要真的落到根上", () => {
    const out = buildSrcdoc("<html><head></head><body>x</body></html>", { ...info });
    expect(out).toContain("theme: function ()");
    expect(out).toContain("d.event === 'theme'");
    expect(out).toContain("document.documentElement.style.setProperty");
    // 伪造的键名不接受：只认 --uartix-* 形状
    expect(out).toContain("/^--uartix-[a-z0-9-]+$/.test(k)");
  });

  it("没传主题也要能出 srcdoc（草稿预览之外的老调用方不该因此白屏）", () => {
    const out = buildSrcdoc("<html><head></head><body>x</body></html>", info);
    expect(out).toContain('<style id="uartix-host-theme">');
    expect(out).toContain("color-scheme: dark");
    expect(out).not.toContain("undefined");
  });

  it("标题里的 </script> 不许逃出脚本块（这是注入面，不是显示问题）", () => {
    const out = buildSrcdoc("<html><head></head><body>x</body></html>", {
      ...info,
      title: "</script><img src=x onerror=alert(1)>",
    });
    // 原始形态一次都不许出现
    expect(out).not.toContain("</script><img");
    // 但值本身要完整送达（`\u003c` 在 JSON 里就是 `<`，解析回来必须一字不差）
    const m = /var INFO = (\{.*?\});/s.exec(out);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]) as { title: string };
    expect(parsed.title).toBe("</script><img src=x onerror=alert(1)>");
  });
});
