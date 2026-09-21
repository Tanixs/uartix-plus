/**
 * P99a-C1：**宿主自省目录**——"Agent 能读到软件的那些东西"的唯一声明处（详设 §6）。
 *
 * 为什么是一张目录而不是 11 个 getter（§6.1）：每加一个 store 就写一支工具，工具面会先涨到
 * 模型用不动，然后开始互相重叠（今天 `app_state` 里那段"协议 24 条 × 每条 24 个字段名"的切片
 * 就是这种叠加的产物——它既不是完整字段表，也不是摘要，模型拿到手以为看全了）。
 * 目录把"有哪些可读视图、各自能拿到什么字段、上限多少、怎么分页"收成一份声明，
 * `app_catalog` 与 `app_read` 只是它的两个前端；`app_state` 也改成从这份声明派生
 * （§8-37"同一件事两个门"的只读版复发预防）。
 *
 * 三条硬规矩（都有测试钉）：
 * 1. **路径只来自目录**：不给"读任意 store"的反射能力（§6.3），未知路径一律拒并回最近建议；
 * 2. **不接敏感源**：目录里根本没有 settings/密钥这一类视图，所以"敏感值掩码"这件事
 *    不需要一个 flag 来兜——比 §6.1 原计划的 `sensitive: boolean` 更强（详设 §15 记了这次改判）；
 * 3. **超限必须带截断标记**（A7）：分页字段 `returned/total/nextCursor` 与 `truncated` 一起回，
 *    模型永远知道"我看的是不是全部"。
 *
 * 环纪律（§8-33）：所有 store 一律**读者内部动态 import**。这个文件被 `localEntries`/适配器
 * 在求值期读，静态挂上 store 就等于把 `pluginStore→extRuntime→chatStore→agentRun` 那条老环
 * 再焊一次。
 */
import { channelStats } from "./runMath";
// 只 import 类型：type-only 边会被环守卫排除，也不会把 store 焊进求值期
import type { CommandNode } from "../controls/commandStore";

/** 指令树是递归的（组里还能有组）：数叶子走这一条，别处不再抄第二份遍历 */
function countCommands(nodes: readonly CommandNode[]): number {
  return nodes.reduce((n, x) => n + ("items" in x ? countCommands(x.items) : 1), 0);
}

export type CatalogGroup =
  | "runtime"
  | "protocols"
  | "commands"
  | "controls"
  | "frames"
  | "session"
  | "channels"
  | "plugins";

export const CATALOG_GROUP_ZH: Record<CatalogGroup, string> = {
  runtime: "运行现状",
  protocols: "协议模板",
  commands: "指令库",
  controls: "控件面板",
  frames: "帧与解析",
  session: "会话录制",
  channels: "曲线通道",
  plugins: "插件库",
};

export interface CatalogArgs {
  /** byId 视图的目标（协议 id / 指令 id / 控件 id） */
  id?: string;
  /** 列表偏移（0 基）；负数按 0 处理 */
  cursor?: number;
  limit?: number;
}

export interface CatalogView {
  /** 目录里的路径；`<id>` 结尾表示按 id 取单个对象 */
  path: string;
  group: CatalogGroup;
  zh: string;
  /** 回给模型的"这里能拿到哪些字段"——它据此决定点哪道菜 */
  gives: string;
  /** 按 id 取详情 */
  byId?: boolean;
  /** 分页读哪个数组字段（不填＝整体返回） */
  listKey?: string;
  defaultLimit?: number;
  maxBytes: number;
  read(args: CatalogArgs): Promise<unknown>;
}

const DEFAULT_LIST_LIMIT = 40;

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function hexOf(bytes?: Uint8Array, max = 32): string {
  if (!bytes || !bytes.length) return "";
  const head = Array.from(bytes.slice(0, max))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return bytes.length > max ? `${head} …(${bytes.length}B)` : head;
}

/* ============================ 视图声明（唯一一份） ============================ */

export const CATALOG_VIEWS: readonly CatalogView[] = [
  {
    path: "runtime",
    group: "runtime",
    zh: "运行现状（连接/锁/录制/规模）",
    gives:
      "serial{iface,status,port,rxTotal,txTotal,bps,error} · operatorLocked · appVersion · session{state,frames,durationMs,bridgePort,bridgeClients} · counts{channels,protocols,commands,controls,plugins}",
    maxBytes: 4096,
    async read() {
      const [{ getSnapshot: serial }, { getSnapshot: op }, { getSnapshot: sess }, plot, { getSnapshot: tpl }, { getSnapshot: cmds }, { getSnapshot: ctl }, { getSnapshot: plug }] =
        await Promise.all([
          import("../serial/serialStore"),
          import("../operator/operatorStore"),
          import("../session/sessionStore"),
          import("../plot/plotStore"),
          import("../protocol/templateStore"),
          import("../controls/commandStore"),
          import("../controls/controlsStore"),
          import("../plugins/pluginStore"),
        ]);
      const s = serial();
      const ss = sess();
      return {
        serial: { iface: s.iface, status: s.status, port: s.portName, rxTotal: s.rxTotal, txTotal: s.txTotal, bps: Math.round(s.bps), error: s.error },
        operatorLocked: !!op().pkg,
        appVersion: await appVersion(),
        session: { state: ss.state, frames: ss.frameCount, durationMs: Math.round(ss.durationMs), bridgeListening: ss.bridgeListening, bridgePort: ss.bridgePort, bridgeClients: ss.bridgeClients },
        counts: {
          channels: plot.getSnapshot().channels.length,
          protocols: tpl().rules.templates.length,
          commands: countCommands(cmds().groups),
          controls: ctl().pages.reduce((n, p) => n + p.cards.length, 0),
          plugins: plug().plugins.length,
        },
      };
    },
  },
  {
    path: "protocols",
    group: "protocols",
    zh: "协议模板清单",
    gives: "每项 {id,name,enabled,groupKey,color,fieldCount,boundaryMode,checksumAlgo}；字段明细请读 protocols/<id>",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 8192,
    async read() {
      const { getSnapshot } = await import("../protocol/templateStore");
      const tps = getSnapshot().rules.templates;
      return {
        total: tps.length,
        items: tps.map((t) => ({
          id: t.id,
          name: t.name,
          enabled: t.enabled,
          groupKey: t.groupKey ?? null,
          color: t.color,
          fieldCount: t.fields.length,
          boundaryMode: t.boundary?.mode ?? null,
          checksumAlgo: t.checksum?.algo ?? null,
        })),
      };
    },
  },
  {
    path: "protocols/<id>",
    group: "protocols",
    zh: "单个协议的完整定义",
    gives: "协议元信息 + boundary/checksum 全量 + **全部字段表**（offset/type/endian/size/scale/unit/bits/disc/枚举），不再截前 24 个",
    byId: true,
    listKey: "fields",
    defaultLimit: 120,
    maxBytes: 24576,
    async read({ id }) {
      const { getSnapshot } = await import("../protocol/templateStore");
      const t = getSnapshot().rules.templates.find((x) => x.id === id);
      if (!t) return { error: "unknown_id", id, want: getSnapshot().rules.templates.slice(0, 40).map((x) => x.id) };
      const { boundary, checksum, fields, ...meta } = t;
      return {
        ...meta,
        boundary: boundary ?? null,
        checksum: checksum ?? null,
        totalFields: fields.length,
        fields: fields.map((f) => ({
          id: f.id,
          name: f.name,
          role: f.role,
          offset: f.offset,
          type: f.type,
          endian: f.endian,
          size: f.size ?? null,
          scale: f.scale ?? null,
          offsetValue: f.offsetValue ?? null,
          unit: f.unit ?? null,
          bits: f.bits ?? null,
          disc: f.disc ?? null,
        })),
      };
    },
  },
  {
    path: "commands",
    group: "commands",
    zh: "指令库清单",
    gives: "每项 {id,name,group,sendMode,scriptEnabled,template}；payload 明细请读 commands/<id>",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 8192,
    async read() {
      const { getSnapshot } = await import("../controls/commandStore");
      const items: unknown[] = [];
      const walk = (nodes: CommandNode[], trail: string) => {
        for (const n of nodes) {
          if ("items" in n) walk(n.items, trail ? `${trail}/${n.name}` : n.name);
          else items.push({ id: n.id, name: n.name, group: trail, sendMode: n.sendMode, scriptEnabled: n.scriptEnabled, template: n.template });
        }
      };
      walk(getSnapshot().groups, "");
      return { total: items.length, items };
    },
  },
  {
    path: "commands/<id>",
    group: "commands",
    zh: "单条指令完整定义",
    gives: "{id,name,template,sendMode,note,script,scriptEnabled}（template 就是发送内容）",
    byId: true,
    maxBytes: 8192,
    async read({ id }) {
      const { getSnapshot } = await import("../controls/commandStore");
      const find = (nodes: CommandNode[]): CommandNode | null => {
        for (const n of nodes) {
          if ("items" in n) {
            const hit = find(n.items);
            if (hit) return hit;
          } else if (n.id === id) return n;
        }
        return null;
      };
      const hit = find(getSnapshot().groups);
      if (!hit) return { error: "unknown_id", id, hint: "先读 commands 列表拿 id" };
      return hit;
    },
  },
  {
    path: "controls",
    group: "controls",
    zh: "控件与面板清单",
    gives: "页面 {id,name,grid,locked,active} + 控件 {id,type,name,pos,size}；单控件配置请读 controls/<id>",
    listKey: "items",
    defaultLimit: 80,
    maxBytes: 8192,
    async read() {
      const { getSnapshot } = await import("../controls/controlsStore");
      const s = getSnapshot();
      const items = s.pages.flatMap((p) =>
        p.cards.map((c) => ({ id: c.id, type: c.type, name: c.name, page: p.id, pageName: p.name, x: c.x, y: c.y, w: c.w, h: c.h })),
      );
      return {
        pages: s.pages.map((p) => ({ id: p.id, name: p.name, active: p.id === s.activePageId, grid: `${p.cols}x${p.rows}`, locked: p.locked, cards: p.cards.length })),
        total: items.length,
        items,
      };
    },
  },
  {
    path: "controls/<id>",
    group: "controls",
    zh: "单控件完整配置",
    gives: "该类型的全部字段（绑定模板/发送模式/量程/步进/LED 条件/键盘项…），未设的字段省略",
    byId: true,
    maxBytes: 8192,
    async read({ id }) {
      const { getSnapshot } = await import("../controls/controlsStore");
      for (const p of getSnapshot().pages) {
        const c = p.cards.find((x) => x.id === id);
        if (c) {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(c)) if (v !== undefined && v !== null && v !== "") out[k] = v;
          out.page = { id: p.id, name: p.name, locked: p.locked };
          return out;
        }
      }
      return { error: "unknown_id", id, hint: "先读 controls 拿 id" };
    },
  },
  {
    path: "frames.recent",
    group: "frames",
    zh: "最近帧（分页，从最新往回）",
    gives: "每条 {seq,tsMs,tplId,tplName,len,valid,error,hex(前 32 字节),fields{id,name,value,text}}；要完整字节请用导出而不是这里",
    listKey: "rows",
    defaultLimit: 20,
    maxBytes: 16384,
    async read({ cursor, limit }) {
      const { getSnapshot } = await import("../table/framesStore");
      const rows = getSnapshot().rows;
      const start = clampInt(cursor, 0, Math.max(0, rows.length - 1), 0);
      const take = clampInt(limit, 1, 200, 20);
      const slice = rows.slice(rows.length - start - take, rows.length - start).reverse();
      return {
        total: rows.length,
        newestFirst: true,
        rows: slice.map((r) => ({
          seq: r.seq,
          tsMs: r.tsMs,
          tplId: r.tplId,
          tplName: r.tplName,
          len: r.len,
          valid: r.valid,
          error: r.error,
          hex: hexOf(r.bytes),
          fields: r.fields.slice(0, 24).map((f) => ({ id: f.id, name: f.name, value: f.value, text: f.text })),
        })),
        nextCursor: start + take < rows.length ? start + take : null,
      };
    },
  },
  {
    path: "frames.stats",
    group: "frames",
    zh: "解析统计",
    gives: "{total,errors,perTemplate{tplId,ok,err},capped,paused}",
    maxBytes: 8192,
    async read() {
      const [{ getSnapshot: tm }, { getSnapshot: fr }] = await Promise.all([import("../protocol/telemetryStore"), import("../table/framesStore")]);
      const s = tm();
      const f = fr();
      return {
        total: s.stats.total,
        errors: s.stats.errors,
        perTemplate: Object.entries(s.tplStats).map(([tplId, v]) => ({ tplId, ok: v.ok, err: v.err })),
        table: { rows: f.rows.length, paused: f.paused, capped: f.capped, maxRows: f.maxRows },
      };
    },
  },
  {
    path: "frames.latest",
    group: "frames",
    zh: "各字段最新值（分页）",
    gives: "每项 {fieldId,value,text,valid,ts}；这是「解析后的当前值」，不是历史曲线（历史曲线用 plot_window）",
    listKey: "items",
    defaultLimit: 80,
    maxBytes: 12288,
    async read() {
      const { getSnapshot } = await import("../protocol/telemetryStore");
      const latest = getSnapshot().latest;
      return {
        total: Object.keys(latest).length,
        items: Object.entries(latest).map(([fieldId, v]) => ({ fieldId, value: v.text ?? v.value, valid: v.valid, ts: v.ts })),
      };
    },
  },
  {
    path: "session",
    group: "session",
    zh: "会话录制/回放/内控桥状态",
    gives: "{state,frames,durationMs,posMs,file,firstTs,lastTs,lastSpeed,bridge{listening,port,clients},meta}；meta 是最近一次会话的文件信息（无会话列表）",
    maxBytes: 4096,
    async read() {
      const { getSnapshot } = await import("../session/sessionStore");
      const s = getSnapshot();
      return {
        state: s.state,
        frames: s.frameCount,
        durationMs: Math.round(s.durationMs),
        posMs: Math.round(s.posMs),
        file: s.fileName || null,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        lastSpeed: s.lastSpeed,
        bridge: { listening: s.bridgeListening, port: s.bridgePort, clients: s.bridgeClients },
        meta: s.meta,
      };
    },
  },
  {
    path: "channels",
    group: "channels",
    zh: "2D 曲线通道",
    gives: "每项 {id,name,visible,points,last,min,max,sampleRate}；逐点数据请用 plot_window",
    listKey: "items",
    defaultLimit: 60,
    maxBytes: 8192,
    async read() {
      const plot = await import("../plot/plotStore");
      const chs = plot.getSnapshot().channels;
      return {
        total: chs.length,
        originMs: plot.timeOrigin(),
        items: chs.map((c) => ({ id: c.id, name: c.name, visible: c.visible, ...channelStats(c.id) })),
      };
    },
  },
  {
    path: "plugins",
    group: "plugins",
    zh: "插件库",
    gives:
      "每项 {id,name,version,state,caps,createdBy,historyVersions,candidateVersion}；含逻辑模块的包另给 modules/tools（它注册了哪几支 Agent 工具）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 8192,
    async read() {
      const [{ getSnapshot }, { moduleArtifactsOf }, { pluginToolDefsOf }] = await Promise.all([
        import("../plugins/pluginStore"),
        import("../plugins/moduleHost"),
        import("../plugins/pluginToolDefs"),
      ]);
      return {
        total: getSnapshot().plugins.length,
        items: getSnapshot().plugins.map((p) => ({
          id: p.pkg.id,
          name: p.pkg.name,
          version: p.pkg.version,
          state: p.state,
          caps: p.pkg.capabilities,
          createdBy: p.pkg.provenance.createdBy,
          historyVersions: p.versions.length,
          ...(p.candidate ? { candidateVersion: p.candidate.version } : {}),
          ...(moduleArtifactsOf(p.pkg).length ? { modules: moduleArtifactsOf(p.pkg).length } : {}),
          ...(pluginToolDefsOf(p.pkg.id).length ? { tools: pluginToolDefsOf(p.pkg.id).map((t) => t.baseName) } : {}),
        })),
      };
    },
  },
];

/* ============================ 目录查询与读取 ============================ */

let versionCache: string | null = null;
async function appVersion(): Promise<string> {
  if (versionCache !== null) return versionCache;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    versionCache = (await getVersion()) ?? "unknown";
  } catch {
    versionCache = "dev";
  }
  return versionCache;
}

/**
 * 路径归一：**点号与斜杠同义**（`frames.recent` ≡ `frames/recent` ≡ `frames.recent`）。
 *
 * 这条必须两边都过：目录里写的是 `frames.recent`（点号=同组变体），而查询侧把点当分隔符
 * 归一过、声明侧没归一，结果那三支 frames 视图**谁都读不到**——C1 的"菜单里每条路径都能读通"
 * 测试第一次跑就把它抓出来了。同一支路径有两种写法还要都能读，是因为模型会把 `protocols/<id>`
 * 照抄成 `protocols.t1`，拒它没有意义。
 */
function normPath(p: string): string {
  return String(p ?? "").trim().replace(/^\//, "").replace(/\./g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}

/** 路径模板匹配：`protocols/<id>` 吃 `protocols.jly901` 也吃 `protocols/jly901`。 */
function matchView(path: string): { view: CatalogView; id?: string } | null {
  const raw = String(path ?? "").trim().replace(/^\//, "");
  const norm = normPath(raw);
  const direct = CATALOG_VIEWS.find((v) => normPath(v.path) === norm);
  if (direct) return { view: direct };
  for (const v of CATALOG_VIEWS) {
    if (!v.byId || !v.path.endsWith("/<id>")) continue;
    const head = v.path.slice(0, -"/<id>".length).toLowerCase(); // "protocols"
    if (!norm.startsWith(`${head}/`) && !norm.startsWith(`${head}.`)) continue;
    /**
     * id 取**未归一**的原样尾段：模板/控件 id 可以带点、也可以有大写，
     * 一起归一会把 `protocols/my.tpl` 读成三段、把 `MyTpl` 变成 `mytpl`——那就永远对不上号。
     */
    const rest = raw.slice(head.length + 1);
    if (!rest || rest.includes("/")) continue;
    return { view: v, id: decodeURIComponent(rest) };
  }
  return null;
}

function suggest(path: string): string[] {
  const p = normPath(path);
  const all = CATALOG_VIEWS.map((v) => v.path);
  const near = all.filter((x) => normPath(x).startsWith(p.split("/")[0]) || p.includes(normPath(x).split("/")[0]));
  return [...new Set([...near, ...all.slice(0, 6)])].slice(0, 8);
}

export interface CatalogMenu {
  groups: { group: CatalogGroup; zh: string; views: { path: string; zh: string; gives: string; byId?: boolean; paginated?: boolean; defaultLimit?: number; maxBytes: number }[] }[];
  usage: string;
}

/** `app_catalog` 的数据：先看菜单再点菜（DSH `cordis_inspect_list` 口径）。 */
export function catalogMenu(): CatalogMenu {
  const groups = (Object.keys(CATALOG_GROUP_ZH) as CatalogGroup[]).map((g) => ({
    group: g,
    zh: CATALOG_GROUP_ZH[g],
    views: CATALOG_VIEWS.filter((v) => v.group === g).map((v) => ({
      path: v.path,
      zh: v.zh,
      gives: v.gives,
      ...(v.byId ? { byId: true } : {}),
      ...(v.listKey ? { paginated: true, defaultLimit: v.defaultLimit ?? DEFAULT_LIST_LIMIT } : {}),
      maxBytes: v.maxBytes,
    })),
  }));
  return {
    groups,
    usage:
      "用 app_read(path, {id?, cursor?, limit?}) 取具体内容。列表视图分页；详情视图给 id。" +
      "这里读不到的东西（任意 store 反射、设置密钥、写操作）不存在——需要改动请走 run_app_action / settings_apply / style_patch。",
  };
}

export interface CatalogReadOk {
  ok: true;
  path: string;
  data: unknown;
  total?: number;
  returned?: number;
  cursor: number;
  nextCursor: number | null;
  truncated: boolean;
  bytes: number;
}
export interface CatalogReadErr {
  ok: false;
  code: string;
  data: Record<string, unknown>;
}
export type CatalogReadResult = CatalogReadOk | CatalogReadErr;

/** `app_read` 的实现：路径解析 → 读者 → 分页 → 体积兜底（A7：超限必须留标记）。 */
export async function readCatalog(rawPath: string, args: CatalogArgs = {}): Promise<CatalogReadResult> {
  const hit = matchView(String(rawPath ?? ""));
  if (!hit) {
    return { ok: false, code: "unknown_path", data: { path: rawPath, near: suggest(String(rawPath ?? "")), all: CATALOG_VIEWS.map((v) => v.path) } };
  }
  const { view } = hit;
  /**
   * id 有两个来源，按优先级：**路径里**（`protocols/t1`，模型最常这么写）→ **参数里**
   * （把菜单原文 `protocols/<id>` 整串抄过来时只能靠 id 参数）。两个入口收的是一个字段，
   * 不是两套读取逻辑（§8-37① 的只读版复发预防）。
   */
  const id = hit.id ?? (typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined);
  if (view.byId && !id) {
    return { ok: false, code: "needs_id", data: { path: view.path, hint: `这支视图按 id 取详情，例如 ${view.path.replace("<id>", "某个 id")}；先读同组的列表视图拿 id` } };
  }
  let payload: unknown;
  try {
    payload = await view.read({ ...(id ? { id } : {}), cursor: args.cursor, limit: args.limit });
  } catch (err) {
    return { ok: false, code: "read_failed", data: { path: rawPath, err: String((err as Error)?.message ?? err).slice(0, 200) } };
  }
  if (payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)) {
    const code = String((payload as { error: unknown }).error);
    return { ok: false, code: code === "unknown_id" ? "unknown_id" : "read_failed", data: { path: rawPath, ...(payload as Record<string, unknown>) } };
  }

  const cursor = clampInt(args.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
  let total: number | undefined;
  let returned: number | undefined;
  let paged = payload;
  if (view.listKey && payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const list = Array.isArray(obj[view.listKey]) ? (obj[view.listKey] as unknown[]) : null;
    if (list) {
      const limit = clampInt(args.limit, 1, 500, view.defaultLimit ?? DEFAULT_LIST_LIMIT);
      total = typeof obj.total === "number" ? obj.total : list.length;
      const slice = list.slice(cursor, cursor + limit);
      returned = slice.length;
      paged = { ...obj, [view.listKey]: slice };
    }
  }
  let bytes: number;
  try {
    bytes = JSON.stringify(paged)?.length ?? 0;
  } catch {
    bytes = Number.MAX_SAFE_INTEGER; // 序列化都炸了＝这一份必然超预算，按"超限"处理而不是当 0 字节放过
  }
  let truncated = Boolean(view.listKey && total !== undefined && returned !== undefined && cursor + returned < total);
  let overflowed = false;
  if (bytes > view.maxBytes) {
    /**
     * 整体超限：不是"悄悄切一半"，而是把这一份换成"预览 + 明确指令"。
     * 列表视图本来就该靠分页解决，走到这里说明调用方给了过大的 limit。
     * 此时 `nextCursor` 必须为空——"接着翻下一页"是错药（下一页同样超限），
     * 真正的下一步是 `limit` 调小，所以只能留 note，不能留一个看起来能用的游标。
     */
    truncated = true;
    overflowed = true;
    paged = {
      preview: JSON.stringify(paged).slice(0, Math.max(0, view.maxBytes - 512)),
      note: `这一页仍超过 ${view.maxBytes} 字节：请把 limit 调小（当前视图 ${view.listKey ? "支持 cursor/limit 分页" : "是整体对象，请改用列表视图"}）`,
    };
  }
  return {
    ok: true,
    path: rawPath,
    data: paged,
    ...(total !== undefined ? { total, returned } : {}),
    cursor,
    nextCursor: truncated && !overflowed && total !== undefined && returned !== undefined ? cursor + returned : null,
    truncated,
    bytes,
  };
}

/** §6.2 每轮注入的事实行上限（字符）。它每轮都进请求，长了就是 24 轮的纯浪费。 */
export const RUNTIME_FACTS_MAX = 360;

/**
 * §6.2：每步注入的**运行时事实快照**。
 *
 * 抄 DSH 的 per-step snapshot，但**只注事实不注指令**（不抄 `agent.inject`）：
 * 授权域、可见工具面、连接现状、内控锁、宿主版本。为什么值得每轮重算——
 * 旧实现里模型只在第 1 轮知道"串口没连"，第 6 轮它已经把端口连上了却照旧
 * 建议"先检查接线"；反之写操作被锁时它还在生成需要解锁的动作。
 *
 * 读不到就说读不到（`host=unavailable`）：这一行每轮都注，静默缺一段会让模型
 * 以为"没有连接"就是现状。宿主侧只读快照（`getSnapshot()` 返回模块级对象），
 * 一轮一次的代价可以忽略。
 */
export async function runtimeFacts(ctx: {
  scope: string;
  allowed: readonly string[];
  toolCount: number;
  toolBytes: number;
}): Promise<string> {
  const bits = [
    `scope=${ctx.scope}${ctx.scope === "custom" ? ` domains=${ctx.allowed.join(",") || "(none)"}` : ""}`,
    `tools=${ctx.toolCount}/${Math.round(ctx.toolBytes / 1024)}KB`,
  ];
  try {
    const [ser, sess, op] = await Promise.all([
      import("../serial/serialStore"),
      import("../session/sessionStore"),
      import("../operator/operatorStore"),
    ]);
    const s = ser.getSnapshot();
    const ss = sess.getSnapshot();
    bits.push(`serial=${s.iface}:${s.status}${s.portName ? `(${s.portName})` : ""} rx${s.rxTotal} tx${s.txTotal}`);
    if (s.error) bits.push(`serialError=${s.error.slice(0, 60)}`);
    bits.push(`session=${ss.state}(${ss.frameCount})`);
    if (op.getSnapshot().pkg) bits.push("operatorLocked=true");
    bits.push(`app=${await appVersion()}`);
  } catch (err) {
    bits.push(`host=unavailable(${String((err as Error)?.message ?? err).slice(0, 40)})`);
  }
  const line = bits.join(" · ");
  return line.length > RUNTIME_FACTS_MAX ? `${line.slice(0, RUNTIME_FACTS_MAX - 1)}…` : line;
}
