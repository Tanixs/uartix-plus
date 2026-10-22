/**
 * P174-A7：扩展面板的**桥**（纯函数，可单测）。
 *
 * 这一批让插件"长出界面"：清单里 `contributes.panels[].entry` 指向包内的一个 HTML，
 * 宿主把它渲染进一个 **不透明源（opaque origin）的 iframe**，两边只靠 `postMessage` 说话。
 *
 * 三条刻意的做法：
 *
 * 1. **iframe 用 `srcdoc` + 只给 `allow-scripts`**。不给 `allow-same-origin` ⇒ 这个文档是
 *    不透明源：拿不到宿主的 DOM、cookie、localStorage，也拿不到别的扩展。这正是我们要的。
 *    代价是它也没有自己的存储与相对路径解析——所以资源要经 `uartix.readText()` 显式取。
 *    换来的好处是不用开 `asset://` 协议、不用改 tauri.conf、不用动 CSP，
 *    而"资源要显式取"这件事本身就顺带把"它到底读了什么"留在桥上了。
 *
 * 2. **桥只认形状，不认内容**：`parseBridgeMessage` 严格判 kind 与字段长度。
 *    iframe 里跑的是用户装的代码——它会（有意或无意地）发出各种形状的消息，
 *    宽松解析的结果是宿主这边一堆 undefined 往里传。
 *
 * 3. **注入的顺序是硬的**：`uartix` 必须在扩展自己的脚本之前定义，
 *    否则 `document.onload` 里第一句 `uartix.call(...)` 就是 undefined。
 */

import type { ExtensionManifest } from "./manifest";

/** 消息信封上的标记。用一个大写开头、带前缀的键，冲突概率远低于 `type`。 */
export const PANEL_MSG_KEY = "__uartixPanel";
export const PANEL_PROTOCOL = 1;

/** 面板视图的 dockview 组件名前缀。**与 AI 影子面板的 `ext-panel-` 刻意区分**：
 *  两者都叫"扩展面板"但一个是声明式 JSON、一个是真 iframe，混用前缀迟早有人猜错。 */
export const EXT_VIEW_PREFIX = "ext-view-";

/** 面板视图 id：`ext-view-<extId>:<panelId>`。用 `:` 分隔——两个 id 的正则里都不允许 `:`。 */
export function panelViewId(extId: string, panelId: string): string {
  return `${EXT_VIEW_PREFIX}${extId}:${panelId}`;
}

export function parsePanelViewId(id: string): { extId: string; panelId: string } | null {
  if (!id.startsWith(EXT_VIEW_PREFIX)) return null;
  const rest = id.slice(EXT_VIEW_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const extId = rest.slice(0, i);
  const panelId = rest.slice(i + 1);
  if (!extId || !panelId) return null;
  return { extId, panelId };
}

/** 面板清单的一项（给「+ 面板」下拉与标题用）。 */
export interface ExtPanelItem {
  extId: string;
  panelId: string;
  title: string;
  entry: string;
  /** 视图 id（dockview 用）。 */
  viewId: string;
}

/** 只取这里需要的字段，避免为了类型把 IO 层（extStore）拖进来。 */
export interface PanelSource {
  id: string;
  manifest: Pick<ExtensionManifest, "contributes">;
}

/**
 * 从已安装的扩展里收出所有面板。
 *
 * 两条规则：
 * - **按 viewId 升序**：下拉里的顺序不能依赖目录列举顺序（那是文件系统的顺序，
 *   同一台机器上换个文件系统就变了）。
 * - **同 id 只留第一个**：清单校验已经拦了包内重复 id，但两个**不同扩展**可以各有一个
 *   `id: "main"`——它们的 viewId 不同（含 extId），所以不会撞；这里只防同一 ext 内重复。
 */
export function collectExtensionPanels(sources: readonly PanelSource[]): ExtPanelItem[] {
  const out: ExtPanelItem[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    for (const p of s.manifest.contributes.panels ?? []) {
      const viewId = panelViewId(s.id, p.id);
      if (seen.has(viewId)) continue;
      seen.add(viewId);
      out.push({ extId: s.id, panelId: p.id, title: p.title, entry: p.entry, viewId });
    }
  }
  out.sort((a, b) => a.viewId.localeCompare(b.viewId));
  return out;
}

/* ============================ 消息形状 ============================ */

export type BridgeIn =
  /** 调扩展的方法：`panel.<panelId>.<method>`。 */
  | { kind: "req"; reqId: string; method: string; args: unknown }
  /** 包内文件读写：路径必须落在扩展目录里（由宿主再解析一次）。 */
  | { kind: "fs"; reqId: string; op: "readText" | "writeText" | "list"; path: string; content?: string }
  /** iframe 里的脚本跑起来了（宿主据此判断"页面真的活了"，而不是"iframe 加载完了"）。 */
  | { kind: "ready" };

const MAX_REQ_ID = 64;
const MAX_METHOD = 200;
const MAX_PATH = 300;
/** 一次写文件的字节上限。与 `ext_fs_write` 的 8 MiB 上限对齐，这里是更早的一道。 */
const MAX_WRITE = 1024 * 1024;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 严格解析一条来自 iframe 的消息。认不出就返回 null（宿主据此忽略，不回错误）。 */
export function parseBridgeMessage(data: unknown): BridgeIn | null {
  if (!isObj(data) || data[PANEL_MSG_KEY] !== PANEL_PROTOCOL) return null;
  const kind = data.kind;
  if (kind === "ready") return { kind: "ready" };
  const reqId = data.reqId;
  if (typeof reqId !== "string" || !reqId || reqId.length > MAX_REQ_ID) return null;
  if (kind === "req") {
    const method = data.method;
    if (typeof method !== "string" || !method || method.length > MAX_METHOD) return null;
    if (!/^[A-Za-z0-9_.-]+$/.test(method)) return null;
    return { kind: "req", reqId, method, args: data.args };
  }
  if (kind === "fs") {
    const op = data.op;
    if (op !== "readText" && op !== "writeText" && op !== "list") return null;
    const path = data.path;
    if (typeof path !== "string" || !path || path.length > MAX_PATH) return null;
    const content = typeof data.content === "string" ? data.content : undefined;
    if (op === "writeText") {
      if (content === undefined) return null;
      if (content.length > MAX_WRITE) return null;
    }
    return { kind: "fs", reqId, op, path, content };
  }
  return null;
}

export type BridgeOut =
  | { kind: "res"; reqId: string; ok: true; data: unknown }
  | { kind: "res"; reqId: string; ok: false; code: string; err: string }
  | { kind: "event"; event: string; payload: unknown }
  | { kind: "hello"; extId: string; panelId: string; title: string };

export function resOk(reqId: string, data: unknown): BridgeOut {
  return { kind: "res", reqId, ok: true, data: data === undefined ? null : data };
}

export function resErr(reqId: string, code: string, err: string): BridgeOut {
  return { kind: "res", reqId, ok: false, code, err: err.slice(0, 2000) };
}

export function eventMsg(event: string, payload: unknown): BridgeOut {
  return { kind: "event", event, payload };
}

/* ============================ srcdoc 组装 ============================ */

/**
 * 把一段 JSON 安全地塞进 `<script>` 里。
 *
 * `JSON.stringify` 不转义 `<`，所以标题里写 `</script>` 就能提前结束脚本块，把后面的内容
 * 变成可执行代码。转成 `\u003c` 之后它在 JSON 里还是同一个字符，但在 HTML 里不再是标签开头。
 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * iframe 里那个 `uartix` 对象。**它跑在不透明源里**，所以：
 * - 不能校验 `event.origin`（父窗口的源是 `null`），只能校验 `event.source === parent`；
 * - `postMessage` 的目标源只能是 `"*"`（没得选）。
 *
 * 这两条不是偷懒，是不透明源的固有形状；真正的界限在"父窗口收到消息后只做这几件事"。
 */
const BRIDGE_JS = [
  "(function () {",
  "  var P = " + PANEL_PROTOCOL + ";",
  "  var seq = 0;",
  "  var waits = {};",
  "  var handlers = {};",
  "  function post(m) {",
  "    m.__uartixPanel = P;",
  "    m.extId = INFO.extId;",
  "    m.panelId = INFO.panelId;",
  "    try { parent.postMessage(m, '*'); } catch (e) {}",
  "  }",
  "  function ask(m) {",
  "    return new Promise(function (res, rej) {",
  "      var id = 'r' + (++seq);",
  "      waits[id] = { res: res, rej: rej, at: Date.now() };",
  "      m.reqId = id;",
  "      m.kind = m.kind || 'req';",
  "      post(m);",
  "    });",
  "  }",
  "  window.uartix = {",
  "    extId: INFO.extId,",
  "    panelId: INFO.panelId,",
  "    title: INFO.title,",
  "    call: function (method, args) { return ask({ kind: 'req', method: String(method), args: args }); },",
  "    readText: function (p) { return ask({ kind: 'fs', op: 'readText', path: String(p) }); },",
  "    writeText: function (p, s) { return ask({ kind: 'fs', op: 'writeText', path: String(p), content: String(s) }); },",
  "    list: function (p) { return ask({ kind: 'fs', op: 'list', path: String(p) }); },",
  "    on: function (event, fn) {",
  "      var k = String(event);",
  "      (handlers[k] = handlers[k] || []).push(fn);",
  "      return function () {",
  "        var a = handlers[k] || [];",
  "        var i = a.indexOf(fn);",
  "        if (i >= 0) a.splice(i, 1);",
  "      };",
  "    },",
  "  };",
  "  window.addEventListener('message', function (e) {",
  "    if (e.source !== parent) return;",
  "    var d = e.data;",
  "    if (!d || d.__uartixPanel !== P) return;",
  "    if (d.kind === 'res') {",
  "      var w = waits[d.reqId];",
  "      if (!w) return;",
  "      delete waits[d.reqId];",
  "      if (d.ok) w.res(d.data);",
  "      else { var err = new Error(d.err || 'call failed'); err.code = d.code; w.rej(err); }",
  "      return;",
  "    }",
  "    if (d.kind === 'event') {",
  "      var hs = handlers[d.event] || [];",
  "      for (var i = 0; i < hs.length; i++) {",
  "        try { hs[i](d.payload); } catch (e2) { /* 面板自己的错不该打断别的监听者 */ }",
  "      }",
  "    }",
  "  });",
  "  post({ kind: 'ready' });",
  "})();",
].join("\n");

/**
 * 组装 iframe 的 `srcdoc`：把 `uartix` 定义插到扩展自己的脚本**之前**。
 *
 * 插入点：第一个 `<head...>` 之后 > `<html...>` 之后 > doctype 之后 > 最前面。
 * 不用正则去匹配 `</head>`：扩展 HTML 里一个字符串就可能含有它，而错了之后
 * 表现是"某些面板的 uartix 是 undefined"——查起来毫无线索。
 */
export function buildSrcdoc(html: string, info: { extId: string; panelId: string; title: string }): string {
  const boot =
    "<script>var INFO = " +
    jsonForScript({ extId: info.extId, panelId: info.panelId, title: info.title }) +
    ";\n" +
    BRIDGE_JS +
    "</script>";
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + boot + html.slice(at);
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + boot + html.slice(at);
  }
  const doc = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doc) {
    const at = doc[0].length;
    return html.slice(0, at) + boot + html.slice(at);
  }
  return boot + html;
}
