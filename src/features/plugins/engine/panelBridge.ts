/**
 * P174-A7：插件面板的**桥**（纯函数，可单测）。
 *
 * 这一批让插件"长出界面"：清单里 `contributes.panels[].entry` 指向包内的一个 HTML，
 * 宿主把它渲染进一个 **不透明源（opaque origin）的 iframe**，两边只靠 `postMessage` 说话。
 *
 * 三条刻意的做法：
 *
 * 1. **iframe 用 `srcdoc` + 只给 `allow-scripts`**。不给 `allow-same-origin` ⇒ 这个文档是
 *    不透明源：拿不到宿主的 DOM、cookie、localStorage，也拿不到别的插件。这正是我们要的。
 *    代价是它也没有自己的存储与相对路径解析——所以资源要经 `uartix.readText()` 显式取。
 *    换来的好处是不用开 `asset://` 协议、不用改 tauri.conf、不用动 CSP，
 *    而"资源要显式取"这件事本身就顺带把"它到底读了什么"留在桥上了。
 *
 * 2. **桥只认形状，不认内容**：`parseBridgeMessage` 严格判 kind 与字段长度。
 *    iframe 里跑的是用户装的代码——它会（有意或无意地）发出各种形状的消息，
 *    宽松解析的结果是宿主这边一堆 undefined 往里传。
 *
 * 3. **注入的顺序是硬的**：`uartix` 必须在插件自己的脚本之前定义，
 *    否则 `document.onload` 里第一句 `uartix.call(...)` 就是 undefined。
 */

import { ROOT_SPEC_RE, type PluginManifest } from "./manifest";
import { iframeThemeCss, type IframeTheme } from "./iframeTheme";

/** 消息信封上的标记。用一个大写开头、带前缀的键，冲突概率远低于 `type`。 */
export const PANEL_MSG_KEY = "__uartixPanel";
export const PANEL_PROTOCOL = 1;

/** 面板视图的 dockview 组件名前缀。**与 AI 影子面板的 `ext-panel-` 刻意区分**：
 *  两者都叫"插件面板"但一个是声明式 JSON、一个是真 iframe，混用前缀迟早有人猜错。 */
export const PLUGIN_VIEW_PREFIX = "plugin-view-";

/** 面板视图 id：`plugin-view-<pluginId>:<panelId>`。用 `:` 分隔——两个 id 的正则里都不允许 `:`。 */
export function panelViewId(pluginId: string, panelId: string): string {
  return `${PLUGIN_VIEW_PREFIX}${pluginId}:${panelId}`;
}

export function parsePanelViewId(id: string): { pluginId: string; panelId: string } | null {
  if (!id.startsWith(PLUGIN_VIEW_PREFIX)) return null;
  const rest = id.slice(PLUGIN_VIEW_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const pluginId = rest.slice(0, i);
  const panelId = rest.slice(i + 1);
  if (!pluginId || !panelId) return null;
  return { pluginId, panelId };
}

/** 面板清单的一项（给「+ 面板」下拉与标题用）。 */
export interface PluginPanelItem {
  pluginId: string;
  panelId: string;
  title: string;
  entry: string;
  /** 视图 id（dockview 用）。 */
  viewId: string;
}

/** 只取这里需要的字段，避免为了类型把 IO 层（pluginEngine）拖进来。 */
export interface PanelSource {
  id: string;
  manifest: Pick<PluginManifest, "contributes">;
  /**
   * 这个插件的面板该不该出现（= 已启用**且**已批准，判据在 `pluginEngine.panelEnabled`）。
   *
   * **必填**，不给默认值：这一条就是"装完不会自动出现在 +面板"的那道门。
   * 少了它，产品流程会悄悄退回"装上就有"，而那正是这次要改掉的行为。
   */
  enabled: boolean;
}

/**
 * 从已安装的插件里收出所有面板。
 *
 * 两条规则：
 * - **按 viewId 升序**：下拉里的顺序不能依赖目录列举顺序（那是文件系统的顺序，
 *   同一台机器上换个文件系统就变了）。
 * - **同 id 只留第一个**：清单校验已经拦了包内重复 id，但两个**不同插件**可以各有一个
 *   `id: "main"`——它们的 viewId 不同（含 pluginId），所以不会撞；这里只防同一 ext 内重复。
 */
export function collectPluginPanels(sources: readonly PanelSource[]): PluginPanelItem[] {
  const out: PluginPanelItem[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!s.enabled) continue;
    for (const p of s.manifest.contributes.panels ?? []) {
      const viewId = panelViewId(s.id, p.id);
      if (seen.has(viewId)) continue;
      seen.add(viewId);
      out.push({ pluginId: s.id, panelId: p.id, title: p.title, entry: p.entry, viewId });
    }
  }
  out.sort((a, b) => a.viewId.localeCompare(b.viewId));
  return out;
}

/**
 * 一个 `plugin-view-…` 面板能不能现在打开（R7：AI 动作面与「+面板」同一道门）。
 *
 * 纯函数：`openPanel` 的判据留在这里，`appActions` 只负责把结果变成回执或错误。
 * 三种"打不开"要分得清——插件没装、插件在但没启用/没批准、插件有但没有这块面板；
 * 合成一句"未知面板"会让模型以为 id 拼错了，而真正的原因是要用户去点启用。
 */
export function pluginPanelTarget(
  plugins: readonly { id: string; name: string; manifest: Pick<PluginManifest, "contributes">; enabled: boolean }[],
  viewId: string,
): { ok: true; title: string; pluginId: string; panelId: string } | { ok: false; reason: string } {
  const v = parsePanelViewId(viewId);
  if (!v) return { ok: false, reason: `插件面板 id 不合法：${viewId}（应为 plugin-view-<插件id>:<面板id>）` };
  const p = plugins.find((x) => x.id === v.pluginId);
  if (!p) return { ok: false, reason: `没有这个插件：${v.pluginId}` };
  if (!p.enabled) {
    return { ok: false, reason: `「${p.name}」还没启用或权限没批准：它的面板不会出现在「+面板」里。先在 设置 → 插件管理 里启用并批准` };
  }
  const def = p.manifest.contributes.panels?.find((x) => x.id === v.panelId);
  if (!def) return { ok: false, reason: `「${p.name}」没有这个面板：${v.panelId}` };
  return { ok: true, title: def.title, pluginId: p.id, panelId: def.id };
}

/* ============================ 消息形状 ============================ */

export type BridgeIn =
  /** 调插件的方法：`panel.<panelId>.<method>`。 */
  | { kind: "req"; reqId: string; method: string; args: unknown }
  /** 包内文件读写：路径必须落在插件目录里（由宿主再解析一次）。 */
  | { kind: "fs"; reqId: string; op: "readText" | "writeText" | "list"; path: string; content?: string }
  /**
   * 问宿主的事：当前工作区根、让用户挑一个目录、把挑到的目录登记成这个插件的绑定。
   * **都不是文件读写**，不需要包内路径。
   *
   * `bindRoot` 的 spec 只收 `$WS` 与 `$EXT:<key>` 两种整形（与清单里写的一模一样）：
   * 键名让插件自己编，就等于给它一个"注册表里凭空多一行"的通道。
   */
  | { kind: "host"; reqId: string; op: "workspace" | "pickFolder" | "bindRoot"; spec?: string }
  /** iframe 里的脚本跑起来了（宿主据此判断"页面真的活了"，而不是"iframe 加载完了"）。 */
  | { kind: "ready" };

const MAX_REQ_ID = 64;
const MAX_METHOD = 200;
const MAX_PATH = 300;
/** 一次写文件的字节上限。与 `plugin_fs_write` 的 8 MiB 上限对齐，这里是更早的一道。 */
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
  if (kind === "host") {
    const op = data.op;
    if (op !== "workspace" && op !== "pickFolder" && op !== "bindRoot") return null;
    if (op === "bindRoot") {
      // 认不出形状就当没这条消息（返回 null 是不回错误：iframe 那边会等到自己超时，
      // 而"传了个非法 spec"的插件本来就该在控制台看到一次未回应，不是看到一条宿主编的错误码）
      const spec = typeof data.spec === "string" ? data.spec.trim() : "";
      if (!ROOT_SPEC_RE.test(spec)) return null;
      return { kind: "host", reqId, op, spec };
    }
    return { kind: "host", reqId, op };
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
  | { kind: "hello"; pluginId: string; panelId: string; title: string };

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
  "    m.pluginId = INFO.pluginId;",
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
  "    pluginId: INFO.pluginId,",
  "    panelId: INFO.panelId,",
  "    title: INFO.title,",
  "    call: function (method, args) { return ask({ kind: 'req', method: String(method), args: args }); },",
  "    readText: function (p) { return ask({ kind: 'fs', op: 'readText', path: String(p) }); },",
  "    writeText: function (p, s) { return ask({ kind: 'fs', op: 'writeText', path: String(p), content: String(s) }); },",
  "    list: function (p) { return ask({ kind: 'fs', op: 'list', path: String(p) }); },",
  "    workspace: function () { return ask({ kind: 'host', op: 'workspace' }); },",
  "    pickFolder: function () { return ask({ kind: 'host', op: 'pickFolder' }); },",
  // R7③：把"用户在这个面板里选的目录"登记成该插件的绑定。
  // 宿主会先校验清单声明、再弹一次**宿主自己的**确认条，用户在确认条上点头才算数；
  // 拒绝的话这个 Promise 直接 reject，插件该显示的就是"用户没批"。
  "    bindRoot: function (spec) { return ask({ kind: 'host', op: 'bindRoot', spec: String(spec) }); },",
  "    theme: function () { return INFO.theme || { vars: {}, scheme: 'dark' }; },",
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
  "      if (d.event === 'theme' && d.payload) {",
  "        var t = d.payload;",
  "        INFO.theme = t;",
  "        var v = t.vars || {};",
  "        for (var k in v) {",
  // 只认 --uartix-* 形状的属性名：这条消息的来源是宿主，但 iframe 里的插件代码可以
  // 自己 postMessage 伪造一条，形状收死比"反正来源可信"便宜。
  "          if (Object.prototype.hasOwnProperty.call(v, k) && /^--uartix-[a-z0-9-]+$/.test(k)) {",
  "            try { document.documentElement.style.setProperty(k, v[k]); } catch (e3) {}",
  "          }",
  "        }",
  "        if (t.scheme === 'dark' || t.scheme === 'light') {",
  "          document.documentElement.style.colorScheme = t.scheme;",
  "          document.documentElement.setAttribute('data-uartix-scheme', t.scheme);",
  "        }",
  "      }",
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
 * 组装 iframe 的 `srcdoc`：把 `uartix` 定义插到插件自己的脚本**之前**。
 *
 * 插入点：第一个 `<head...>` 之后 > `<html...>` 之后 > doctype 之后 > 最前面。
 * 不用正则去匹配 `</head>`：插件 HTML 里一个字符串就可能含有它，而错了之后
 * 表现是"某些面板的 uartix 是 undefined"——查起来毫无线索。
 */
export function buildSrcdoc(
  html: string,
  info: { pluginId: string; panelId: string; title: string; theme?: IframeTheme; paintPage?: boolean },
): string {
  const theme = info.theme ?? { vars: {}, scheme: "dark" as const, font: "" };
  const boot =
    '<style id="uartix-host-theme">' +
    iframeThemeCss(theme, { paintPage: info.paintPage }) +
    "</style>" +
    "<script>var INFO = " +
    jsonForScript({
      pluginId: info.pluginId,
      panelId: info.panelId,
      title: info.title,
      theme: { vars: theme.vars, scheme: theme.scheme, font: theme.font },
    }) +
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
