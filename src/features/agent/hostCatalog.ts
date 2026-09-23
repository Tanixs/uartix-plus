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
  | "plugins"
  // P99a-C1b：另七面（组名＝帮助与详设里叫的那七个名字，反向钉靠字面对应）
  | "plot3d"
  | "orchestrator"
  | "sequencer"
  | "analysis"
  | "modbus"
  | "vdev"
  | "sentinel"
  // P99b-N6：插件市场（C2「AI 提名装」的只读半边；写侧仍不在这条路上）
  | "market";

export const CATALOG_GROUP_ZH: Record<CatalogGroup, string> = {
  runtime: "运行现状",
  protocols: "协议模板",
  commands: "指令库",
  controls: "控件面板",
  frames: "帧与解析",
  session: "会话录制",
  channels: "曲线通道",
  plugins: "插件库",
  plot3d: "3D 轨迹",
  orchestrator: "自动编排器",
  sequencer: "测试序列器",
  analysis: "分析面板",
  modbus: "Modbus 工作台",
  vdev: "虚拟设备工坊",
  sentinel: "哨兵",
  market: "插件市场",
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
      /** 每条 byId 路都回 `want`（可用 id 前 40 个）：模型拿着 hint 只会再猜一次，
       *  递上真 id 才能一步走通。测试也靠这份 `want` 取 id，不再手写第二份 id 清单。 */
      if (!hit) {
        const all: string[] = [];
        const collect = (nodes: CommandNode[]) => {
          for (const n of nodes) if ("items" in n) collect(n.items);
          else all.push(n.id);
        };
        collect(getSnapshot().groups);
        return { error: "unknown_id", id, want: all.slice(0, 40), total: all.length };
      }
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
      return {
        error: "unknown_id", id,
        want: getSnapshot().pages.flatMap((p) => p.cards.map((c) => c.id)).slice(0, 40),
      };
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

  /* ---------------- P99a-C1b：另七面 ---------------- */
  {
    path: "plot3d.groups",
    group: "plot3d",
    zh: "3D 轨迹组清单（绑定与显示配置 + 配对事实）",
    gives:
      "view{axisScale,showGrid,gridDensity,follow,autoRotate,keyFlight,zoomToCursor,calibMode,calibSrcId,canUndo,canRedo} · items[{id,name,color,visible,mode,boundX/boundY/boundZ,colorBy,fadeSec,density,smooth,maxPoints,pairMode,pairTolMs,arrowEvery,showStartEnd,headingSrc,modelKind,hasModelFile,notesLen,paired,skipped,missingAxis,hasSource}]（备注只给长度，模型文件路径不外带）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 8192,
    async read() {
      const m = await import("../plot3d/plot3dStore");
      const { settings, canUndo, canRedo } = m.getSnapshot();
      const facts = new Map(m.diagFacts().map((d) => [d.id, d]));
      return {
        total: settings.groups.length,
        view: {
          axisScale: settings.axisScale, showGrid: settings.showGrid, gridDensity: settings.gridDensity,
          follow: settings.follow, autoRotate: settings.autoRotate, keyFlight: settings.keyFlight,
          zoomToCursor: settings.zoomToCursor, calibMode: settings.calibMode, calibSrcId: settings.calibSrc ?? null,
          canUndo, canRedo,
        },
        items: settings.groups.map((g) => {
          const f = facts.get(g.id);
          return {
            id: g.id, name: g.name, color: g.color, visible: g.visible, mode: g.mode,
            boundX: Boolean(g.chX), boundY: Boolean(g.chY), boundZ: Boolean(g.chZ),
            colorBy: g.colorBy, fadeSec: g.fade, density: g.density, smooth: g.smooth,
            maxPoints: g.maxPoints, pairMode: g.pairMode, pairTolMs: g.pairTolMs,
            arrowEvery: g.arrowEvery, showStartEnd: g.showStartEnd, notesLen: len(g.notes),
            headingSrc: g.heading?.src ?? null,
            modelKind: g.model?.kind ?? null, hasModelFile: Boolean(g.model?.src),
            paired: f?.paired ?? 0, skipped: f?.skipped ?? 0,
            missingAxis: f?.missingAxis ?? null, hasSource: f?.hasSource ?? false,
          };
        }),
      };
    },
  },
  {
    path: "plot3d.groups/<id>",
    group: "plot3d",
    zh: "单个轨迹组的完整配置与校准进度",
    gives:
      "三轴绑定通道 id + 平滑/着色/配对/变换/朝向 + 椭球校准{capturing,sampleCount,cap,octants[]} + 六面校准{collecting,idx,n,minSamples,stalled}（`modelFile` 只给有无与缩放，路径不外带）",
    byId: true,
    maxBytes: 6144,
    async read({ id }) {
      const m = await import("../plot3d/plot3dStore");
      const { settings } = m.getSnapshot();
      const g = settings.groups.find((x) => x.id === id);
      if (!g) return { error: "unknown_id", id, want: settings.groups.map((x) => x.id) };
      const calib = m.calibSnapshot();
      const a6 = m.accel6Snapshot();
      const f = m.diagFacts().find((d) => d.id === id);
      return {
        id: g.id, name: g.name, color: g.color, visible: g.visible, mode: g.mode,
        chX: g.chX, chY: g.chY, chZ: g.chZ,
        pointSize: g.pointSize, opacity: g.opacity, showDots: g.showDots, maxPoints: g.maxPoints,
        colorBy: g.colorBy, colorCh: g.colorCh, fadeSec: g.fade, density: g.density,
        smooth: g.smooth, smoothWin: g.smoothWin, smoothSub: g.smoothSub, smoothTension: g.smoothTension,
        arrowEvery: g.arrowEvery, showStartEnd: g.showStartEnd,
        heading: {
          // 键名不叫 `src`：目录侧的字段黑名单（测试钉）把 `src` 划成"路径/端点"这一类，
          // 而这里的语义是"朝向取哪个源"——换成说人话的 `source`，也让模型不会误以为它是文件。
          source: g.heading?.src ?? null, chYaw: g.heading?.chYaw || null,
          quat: g.heading?.src === "quat" ? [g.heading.qX, g.heading.qY, g.heading.qZ, g.heading.qW] : null,
          yawOff: g.heading?.yawOff ?? 0, pitchOff: g.heading?.pitchOff ?? 0, rollOff: g.heading?.rollOff ?? 0,
          yawSign: g.heading?.yawSign ?? 1,
        },
        model: { kind: g.model?.kind ?? null, scale: g.model?.scale ?? 1, hasFile: Boolean(g.model?.src) },
        transform: g.transform ?? null, pairMode: g.pairMode, pairTolMs: g.pairTolMs, notesLen: len(g.notes),
        paired: f?.paired ?? 0, skipped: f?.skipped ?? 0, missingAxis: f?.missingAxis ?? null, hasSource: f?.hasSource ?? false,
        calib: { capturing: calib.capturing, sampleCount: calib.count, cap: m.CALIB_CAP, octants: calib.coverage },
        accel6: { collecting: a6.collecting, idx: a6.idx, n: a6.n, minSamples: a6.minSamples, stalled: a6.stalled },
      };
    },
  },
  {
    path: "orchestrator.groups",
    group: "orchestrator",
    zh: "编排器组清单（结构与开关）",
    gives:
      "masterOn · varCount · cap{groupCap,varCap,queueCap} · items[{id,name,enabled,eventKinds[],blockCount,depth,cooldownMs,queuePolicy,noteLen}]（这一条只给**结构与开关**；在跑几条、哪组失败过是活值，在 `orchestrator.runtime`——同一份判定，两个视图）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 8192,
    async read() {
      const [{ getSnapshot }, { ORCH_LIMITS }] = await Promise.all([
        import("../orchestrator/orchestratorStore"),
        import("../orchestrator/types"),
      ]);
      const doc = getSnapshot().doc;
      return {
        total: doc.groups.length,
        masterOn: doc.settings.masterOn,
        varCount: doc.vars.length,
        docTitleLen: len(doc.title),
        cap: { groupCap: ORCH_LIMITS.groupCap, varCap: ORCH_LIMITS.varCap, queueCap: ORCH_LIMITS.queueCap },
        items: byId(doc.groups).map((g) => ({
          id: g.id, name: g.name, enabled: g.enabled,
          eventKinds: g.events.map((e) => e.kind),
          blockCount: countBlocks(g.children), depth: 1 + (g.children.some((c) => "children" in c) ? 1 : 0),
          cooldownMs: g.cooldownMs ?? 0, queuePolicy: g.queuePolicy ?? "dropNew", noteLen: len(g.note),
        })),
      };
    },
  },
  {
    path: "orchestrator.groups/<id>",
    group: "orchestrator",
    zh: "单个编排组的块树与事件参数",
    gives:
      "events[{id,kind,intervalMs?,stride?,level?,varName?,idleMs?,name?}] + blocks[{id,kind,enabled,parentId,depth}]（发送块只给 payloadMode，**不给字节**；文本块只给长度）",
    byId: true,
    listKey: "blocks",
    defaultLimit: 120,
    maxBytes: 8192,
    async read({ id }) {
      const { getSnapshot } = await import("../orchestrator/orchestratorStore");
      const groups = getSnapshot().doc.groups;
      const g = groups.find((x) => x.id === id);
      if (!g) return { error: "unknown_id", id, want: groups.map((x) => x.id) };
      const blocks: { id: string; kind: string; enabled: boolean; parentId: string | null; depth: number; payloadMode?: string; textLen?: number }[] = [];
      const walk = (nodes: { id: string; kind: string; enabled?: boolean; children?: unknown[] }[], parent: string | null, depth: number) => {
        for (const n of nodes) {
          const rec = n as Record<string, unknown>;
          blocks.push({
            id: n.id, kind: n.kind, enabled: n.enabled !== false, parentId: parent, depth,
            ...(n.kind === "send" ? { payloadMode: String(rec.sendMode ?? "ascii") } : {}),
            ...("text" in rec ? { textLen: len(rec.text) } : {}),
          });
          if (Array.isArray(n.children)) walk(n.children as { id: string; kind: string; enabled?: boolean; children?: unknown[] }[], n.id, depth + 1);
        }
      };
      walk(g.children as { id: string; kind: string; enabled?: boolean; children?: unknown[] }[], null, 0);
      return {
        id: g.id, name: g.name, enabled: g.enabled, cooldownMs: g.cooldownMs ?? 0,
        queuePolicy: g.queuePolicy ?? "dropNew", noteLen: len(g.note),
        totalEvents: g.events.length,
        events: g.events.map((e) => {
          const rec = e as unknown as Record<string, unknown>;
          return {
            id: e.id, kind: e.kind,
            ...(typeof rec.intervalMs === "number" ? { intervalMs: rec.intervalMs } : {}),
            ...(typeof rec.idleMs === "number" ? { idleMs: rec.idleMs } : {}),
            ...(typeof rec.stride === "number" ? { stride: rec.stride } : {}),
            ...(typeof rec.level === "string" ? { level: rec.level } : {}),
            ...(typeof rec.varName === "string" ? { varName: rec.varName } : {}),
            ...(typeof rec.name === "string" && e.kind === "flowEvt" ? { name: rec.name } : {}),
            ...(rec.match && typeof rec.match === "object" ? { matchKind: String((rec.match as { kind?: string }).kind ?? "any") } : {}),
          };
        }),
        blocks,
      };
    },
  },
  {
    path: "orchestrator.vars",
    group: "orchestrator",
    zh: "编排器变量库（声明与默认值）",
    gives: "每项 {name,type,def,persist}（`def` 是声明里的默认值；**现值**在 `orchestrator.runtime` 的 `vars` 里）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 6144,
    async read() {
      const { getSnapshot } = await import("../orchestrator/orchestratorStore");
      const vars = getSnapshot().doc.vars;
      return {
        total: vars.length,
        items: vars.map((v) => ({
          name: v.name, type: v.type,
          def: typeof v.def === "string" && v.def.length > 120 ? `${v.def.slice(0, 120)}…` : v.def,
          persist: v.persist,
        })),
      };
    },
  },
  {
    /**
     * P99c-O1（C1b Q2 的**反向**落地）：活值进目录。
     *
     * 当初"本批不接"的理由是别去装载 `orchestratorBind`（求值期 new 引擎 + 起 tick + 接事件源）。
     * 今天这条路**动作 `orchestratorRead` 早就在走**，而它在动作元表里是 `effect:"read"`、免批准
     * ——所以把它接进目录不多放一格权限，只是让"看一眼现在在跑几条"不再需要模型想起有支动作。
     * 代价照实在 `gives` 里说清楚，不藏。
     *
     * 两处边界：① 数字全部来自 `readOrchestratorRuntime` 那**一次**读取（与动作同一份判定，§8-48）；
     * ② 日志只给阶段、不给原文，备注正文与上次失败详情不外带（与其余视图同一口径，也是 `FORBIDDEN_KEYS` 那一条）。
     */
    path: "orchestrator.runtime",
    group: "orchestrator",
    zh: "编排器活值：现在在跑什么、跑成怎样",
    gives:
      "{available:true,masterOn,runningInstances,groupCount,groupCap,queueCap,logCap,logCount} + groups[{id,name,enabled,runs,fails,lastAt}] + vars[{name,type,value,persist}] + events[{at,groupId,phase}]（字符串值超 120 字截断带省略号；**日志只有阶段，没有原文**）· 读这一条会装载编排器引擎与事件源——与动作 orchestratorRead 走同一条装载路，本视图不新造第二条",
    listKey: "groups",
    defaultLimit: 20,
    maxBytes: 8192,
    async read() {
      try {
        const { readOrchestratorRuntime } = await import("../orchestrator/orchRuntimeRead");
        const r = await readOrchestratorRuntime();
        return {
          available: true,
          masterOn: r.masterOn,
          runningInstances: r.runningInstances,
          groupCount: r.groupCount,
          groupCap: r.groupCap,
          queueCap: r.queueCap,
          logCap: r.logCap,
          logCount: r.logCount,
          groups: r.groups.map((g) => ({
            id: g.id, name: g.name, enabled: g.enabled, runs: g.runs, fails: g.fails, lastAt: g.lastAt,
          })),
          vars: r.vars.map((v) => ({
            name: v.name,
            type: v.type,
            value: typeof v.value === "string" && v.value.length > 120 ? `${v.value.slice(0, 120)}…` : v.value,
            persist: v.persist,
          })),
          events: r.recentLogs.map((l) => ({ at: l.at, groupId: l.groupId, phase: l.phase })),
        };
      } catch (err) {
        // 不抛：装载失败要说清"读不到"与"下一步怎么办"（顶层带 error 键会被 `readCatalog` 判成视图自毁）
        return {
          available: false,
          why: `装载编排器引擎失败：${String((err as Error)?.message ?? err)}`,
          next: "在应用里打开一次「编排器」那一页再读；或用动作 orchestratorRead 试同一条装载路",
        };
      }
    },
  },
  {
    path: "sequencer.suites",
    group: "sequencer",
    zh: "测试序列套件清单与最近一次结果",
    gives:
      "items[{id,name,stepCount,triggerMode,cooldownMs,failFast,lastRun{status,startedAt,finishedAt,durationMs,total,pass,fail,other}}]（lastRun 缺＝本机还没跑过；步骤正文与发送内容在 sequencer.suites/<id>）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 6144,
    async read() {
      const { getSnapshot } = await import("../sequencer/sequencerStore");
      const s = getSnapshot();
      return {
        total: s.suites.length,
        items: byId(s.suites).map((x) => {
          const r = s.lastResults[x.id];
          const sum = r ? sumSteps(r.steps) : null;
          return {
            id: x.id, name: x.name, stepCount: countBlocks(x.steps), triggerMode: x.trigger.mode,
            cooldownMs: x.trigger.mode === "onFrame" ? x.trigger.cooldownMs : 0, failFast: x.failFast,
            ...(r && sum ? { lastRun: { status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.finishedAt - r.startedAt, ...sum } } : {}),
          };
        }),
      };
    },
  },
  {
    path: "sequencer.suites/<id>",
    group: "sequencer",
    zh: "单个序列套件的步骤树",
    gives:
      "{id,name,failFast,triggerMode,steps[{id,kind,enabled,parentId,depth,payloadMode?,matchKind?,noteLen?}]}（发送内容/匹配字节一律不外带，只给形态）",
    byId: true,
    listKey: "steps",
    defaultLimit: 120,
    maxBytes: 8192,
    async read({ id }) {
      const { getSnapshot } = await import("../sequencer/sequencerStore");
      const s = getSnapshot();
      const suite = s.suites.find((x) => x.id === id);
      if (!suite) return { error: "unknown_id", id, want: s.suites.map((x) => x.id) };
      const flat: { id: string; kind: string; enabled: boolean; parentId: string | null; depth: number; payloadMode?: string; matchKind?: string; noteLen?: number }[] = [];
      const walk = (steps: { id: string; kind: string; enabled?: boolean; children?: unknown[] }[], parent: string | null, depth: number) => {
        for (const st of steps) {
          const rec = st as unknown as Record<string, unknown>;
          flat.push({
            id: st.id, kind: st.kind, enabled: st.enabled !== false, parentId: parent, depth,
            ...(rec.payload && typeof rec.payload === "object" ? { payloadMode: String((rec.payload as { mode?: string }).mode ?? "ascii") } : {}),
            ...(rec.match && typeof rec.match === "object" ? { matchKind: String((rec.match as { kind?: string }).kind ?? "any") } : {}),
            ...("note" in rec ? { noteLen: len(rec.note) } : {}),
          });
          if (Array.isArray(st.children)) walk(st.children as { id: string; kind: string; enabled?: boolean; children?: unknown[] }[], st.id, depth + 1);
        }
      };
      walk(suite.steps as unknown as { id: string; kind: string; enabled?: boolean; children?: unknown[] }[], null, 0);
      return {
        id: suite.id, name: suite.name, failFast: suite.failFast, triggerMode: suite.trigger.mode,
        totalSteps: flat.length, steps: flat,
      };
    },
  },
  {
    path: "analysis.last",
    group: "analysis",
    zh: "分析面板最近一次分析包",
    gives:
      "safeAnalysisSnapshot 的那一份白名单结果：{algorithmVersion,generatedAt,provenance,request,groups,limits,channels[{id,stats}],trajectories[{id,pairing,stats}]}（路径/标题/备注这类自由文本已经被白名单剔掉）",
    maxBytes: 8192,
    async read() {
      const [{ getSnapshot }, { safeAnalysisSnapshot }] = await Promise.all([
        import("../analysis/analysisStore"),
        import("../analysis/analysisSnapshot"),
      ]);
      const st = getSnapshot();
      if (!st.result) return { available: false, reason: st.error ? String(st.error).slice(0, 160) : "本机还没有算过分析：让用户在分析面板点一次「开始分析」" };
      return { available: true, ...safeAnalysisSnapshot(st.result) };
    },
  },
  {
    path: "modbus.slave",
    group: "modbus",
    zh: "Modbus 模拟从站配置与计数",
    gives:
      "{running,address,anyAddress,delayMs,fault,faultCode,bitSize,wordSize,counters{requests,replies,exceptions,silents,ignored,noise},eventsRecent[{ts,dir}],eventsTotal,eventsOmitted}（原始请求/响应文本不外带；数据区内容不在目录面）",
    maxBytes: 4096,
    async read() {
      const { getSnapshot } = await import("../modbus/slaveStore");
      const s = getSnapshot();
      return {
        running: s.running, address: s.address, anyAddress: s.anyAddress, delayMs: s.delayMs,
        fault: s.fault, faultCode: s.faultCode, bitSize: s.bitSize, wordSize: s.wordSize,
        counters: s.counters,
        eventsRecent: s.events.slice(0, 5).map((e) => ({ ts: e.ts, dir: e.dir })),
        eventsTotal: s.events.length, eventsOmitted: Math.max(0, s.events.length - 5),
      };
    },
  },
  {
    path: "modbus.poll",
    group: "modbus",
    zh: "Modbus 主站轮询表",
    gives:
      "{running,transport,txns,timeouts,errs,items[{id,slave,fn,addr,qty,periodMs,varName,elem,scale,enabled,ok,timeout,err,last,lastTs,latencyMs}]}（每行读数历史数组不外带）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 8192,
    async read() {
      const { getSnapshot } = await import("../modbus/pollStore");
      const p = getSnapshot();
      return {
        total: p.rows.length, running: p.running, transport: p.transport,
        txns: p.txns, timeouts: p.timeouts, errs: p.errs,
        items: byId(p.rows).map((r) => ({
          id: r.id, slave: r.slave, fn: r.fn, addr: r.addr, qty: r.qty, periodMs: r.periodMs,
          varName: r.varName, elem: r.elem, scale: r.scale, enabled: r.enabled,
          ok: r.ok, timeout: r.timeout, err: r.err, last: r.last, lastTs: r.lastTs, latencyMs: r.latencyMs,
        })),
      };
    },
  },
  {
    path: "vdev.devices",
    group: "vdev",
    zh: "虚拟设备清单与运行链路",
    gives:
      "{running,device,dirty,net{transport,outSent,outBytes,inRecv,clients,fault},items[{id,name,periodMs,frameFieldCount,inputCount,signalCount,commandCount,faults{dropPct,stuckPct,spikePct},netConfigured,netTransport,descLen}]}（设备 JSON 全文、网络地址与串口路径不外带，只回有无）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 6144,
    async read() {
      const { getSnapshot } = await import("../vdev/vdevStore");
      const v = getSnapshot();
      const ns = v.netStatus;
      return {
        total: v.specs.length, running: v.running, device: v.device, dirty: v.dirty,
        ...(ns ? { net: { transport: ns.transport, outSent: ns.outSent, outBytes: ns.outBytes, inRecv: ns.inRecv, clients: ns.clients, fault: ns.outErrs > 0 } } : {}),
        items: byId(v.specs).map((x) => ({
          id: x.id, name: x.spec.name, periodMs: x.spec.periodMs,
          frameFieldCount: x.spec.frame.fields.length, inputCount: x.spec.inputs.length,
          signalCount: x.spec.signals.length, commandCount: x.spec.commands.length,
          faults: { dropPct: x.spec.faults.dropPct, stuckPct: x.spec.faults.stuckPct, spikePct: x.spec.faults.spikePct },
          netConfigured: Boolean(x.spec.net), netTransport: x.spec.net?.transport ?? null,
          descLen: len(x.spec.desc),
        })),
      };
    },
  },
  {
    path: "sentinel.health",
    group: "sentinel",
    zh: "哨兵健康度、通道评分与报警",
    gives:
      "{running,learning,health,unack,activeCrit,activeWarn,conn,silenceMs,totals{frames,errors},cfg{sensitivity,silenceSec,errRatePct,sound,alertCap,autoDiag,mutedCount},chans[{name,score,level,last,tplId,fieldId}],frameTypes[{id,name,count,isNew}],alertsTotal,items[{id,ts,kind,level,key,count,acked}]}（报警正文与详情数值不外带，只给级别/键/计数；静音列表只给数量）",
    listKey: "items",
    defaultLimit: 20,
    maxBytes: 8192,
    async read() {
      const { getSnapshot } = await import("../sentinel/sentinelStore");
      const s = getSnapshot();
      return {
        running: s.running, learning: s.learning, health: s.health, unack: s.unack,
        activeCrit: s.activeCrit, activeWarn: s.activeWarn, conn: s.conn,
        silenceMs: s.silenceMs, totals: s.totals,
        cfg: {
          sensitivity: s.cfg.sensitivity, silenceSec: s.cfg.silenceSec, errRatePct: s.cfg.errRatePct,
          sound: s.cfg.sound, alertCap: s.cfg.alertCap, autoDiag: s.cfg.autoDiag, mutedCount: s.cfg.mutedKeys.length,
        },
        chans: s.chans, chanTotal: s.chanTotal, frameTypes: s.frameTypes,
        alertsTotal: s.alerts.length,
        items: s.alerts.map((a) => ({ id: a.id, ts: a.ts, kind: a.kind, level: a.level, key: a.key, count: a.count, acked: a.acked })),
      };
    },
  },

  /* ---------------- P99b-N6：插件市场（两支都不联网） ----------------
   *
   * R3 是这批在这里的全部难度：**视图绝不能顺手刷新**。市场的第一条口径是"只有打开那一页才联网"，
   * 模型问一句"货架上有什么"就把人推出这个承诺，那是拿自省面当后门。所以两支读 `getMarketSnapshot()`，
   * 没取过就照实回"没取过 + 该怎么办"（与 `analysis.last` 同一形状），也不回用户配的地址原值——
   * 目录一向不接 settings 这个源（`hostCatalog.test` 那条敏感源封闭的白名单就是为它设的）。
   *
   * 还有一条本批踩到的：`readCatalog` 把**顶层带 `error` 键**的回执当作"视图自己报失败"（→ ok:false），
   * 所以失败原因放在未取回那一支的 `why` 里，ready 那一支不再挂错误字段（成功时 `error` 恒为空串）。
   */
  {
    path: "market.status",
    group: "market",
    zh: "插件市场：上一次取回索引的现状",
    gives:
      "{available:true,status,indexName,source,generatedAt,entryCount,droppedCount,viaMirror,elapsedMs,fetchedAt,appVersion,why?} · 未取回时 {available:false,status,why,next}（货架页那句状态行读的就是这几个数；`why`＝上次取回失败的原因；用户配的索引地址与镜像前缀不外带——目录一向不接 settings 这个源）",
    maxBytes: 4096,
    async read() {
      const { getMarketSnapshot } = await import("../market/marketStore");
      const s = getMarketSnapshot();
      if (!s.index) {
        return {
          available: false,
          status: s.status,
          why:
            s.status === "loading"
              ? "索引正在取回中（只可能在有人打开市场页时发生）"
              : s.error || "本机还没取过这份索引",
          next: "在应用里打开一次「插件市场」那一页；本视图不替你联网刷新",
        };
      }
      return {
        available: true,
        status: s.status,
        indexName: s.index.name,
        source: s.index.source,
        generatedAt: s.index.generatedAt,
        entryCount: s.index.entries.length,
        // 被剔除几条：货架页显示得、AI 读不到就是不对称（详设 §4-5）
        droppedCount: s.index.dropped.length,
        viaMirror: s.viaMirror,
        elapsedMs: s.elapsedMs,
        fetchedAt: s.fetchedAt,
        appVersion: s.appVersion,
        // 键名不能叫 `error`：readCatalog 把"顶层带 error 键"当作视图自己报失败（`runtime` 那支也是嵌在 serial 里给的）
        ...(s.error ? { why: s.error } : {}),
      };
    },
  },
  {
    path: "market.entries",
    group: "market",
    zh: "插件市场：货架上的条目（含与本机库的对照）",
    gives:
      "每项 {id,name,author,version,category,caps,verified,bytes,shots,descLen,compat,install,via,pending?}（`install`＝absent/same/update/newer-than-shelf，与货架徽章同一个 `compareInstall` 判定；`via`＝shelf/npm，即字节来自自建货架直链还是 npm 官方 registry；`pending` 只在有一条在飞的请求时出现；描述只给长度）",
    listKey: "items",
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxBytes: 8192,
    async read() {
      const [{ getMarketSnapshot }, { getSnapshot: local }, { marketPendingSnapshot }, { compat, compareInstall, packageOrigin }] =
        await Promise.all([
          import("../market/marketStore"),
          import("../plugins/pluginStore"),
          import("../market/marketPending"),
          import("../market/marketIndex"),
        ]);
      const s = getMarketSnapshot();
      if (!s.index) {
        return {
          available: false,
          total: 0,
          items: [],
          why: s.error || "本机还没取过这份索引",
          next: "在应用里打开一次「插件市场」那一页；本视图不替你联网刷新",
        };
      }
      const versions = new Map(local().plugins.map((r) => [r.pkg.id, r.pkg.version]));
      const live = new Map(marketPendingSnapshot().map((p) => [p.entryId, p.phase]));
      return {
        available: true,
        total: s.index.entries.length,
        items: byId(s.index.entries).map((e) => ({
          id: e.id,
          name: e.name,
          author: e.author,
          version: e.version,
          category: e.category,
          caps: e.capabilities,
          verified: e.verified === true,
          bytes: e.bytes,
          shots: e.screenshots.length,
          descLen: len(e.description.zh),
          compat: compat(e, s.appVersion),
          install: compareInstall(e, versions.get(e.id)),
          via: packageOrigin(e),
          ...(live.has(e.id) ? { pending: live.get(e.id) } : {}),
        })),
      };
    },
  },
];

/* ============================ C1b 七面：读者侧的收敛助手 ============================
 * 这七面的 `getSnapshot()` 都是**整包**（点云 220k、校准点 20k、寄存器 hist 环、原始 hex、
 * GLTF 绝对路径、串口号、自由文本备注全在里面）。目录给出去的必须是摘要，所以收敛写在读者侧：
 * 逐字段挑、自由文本只给长度、端点与路径一概不外带。`hostCatalog.test.ts` 的"键名黑名单 +
 * 毒值扫描"两条钉看着这里写的每一个键（详设 §5.1）。
 */

/** 编排块是递归的（if/loop/组里还有块）：数块走这一条。参数收 `unknown[]` 是因为块是**判别联合**，
 *  联合成员各有各的字段，只有 `children` 这条递归边是共有的——按共有面收，不给联合加壳。 */
function countBlocks(nodes: readonly unknown[]): number {
  return nodes.reduce<number>((n, x) => {
    const kids = (x as { children?: unknown }).children;
    return n + 1 + (Array.isArray(kids) ? countBlocks(kids) : 0);
  }, 0);
}

/** 序列运行结果树：数总数 + 按状态给计数 */
function sumSteps<T extends { children?: T[]; status?: string }>(steps: readonly T[]): { total: number; pass: number; fail: number; other: number } {
  let total = 0;
  let pass = 0;
  let fail = 0;
  let other = 0;
  const walk = (list: readonly T[]) => {
    for (const s of list) {
      total++;
      if (s.status === "pass") pass++;
      else if (s.status === "fail" || s.status === "timeout") fail++;
      else other++;
      if (Array.isArray(s.children)) walk(s.children);
    }
  };
  walk(steps);
  return { total, pass, fail, other };
}

function len(s: unknown): number {
  return typeof s === "string" ? s.length : 0;
}

/** 按 id 稳定排序（§3-1：列表次序必须可复现，别让模型把"第 3 行"当稳定引用） */
function byId<T extends { id: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

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
    /**
     * 前缀也要**归一后再比**（C1b 修的潜伏 bug）：C1 那三支 byId（`protocols/<id>` 等）恰好
     * 都不带点，所以"拿未归一的声明前缀去比归一后的输入"一直没露馅；本批的组名带点
     * （`orchestrator.groups/<id>`），`orchestrator/groups/og1` 就永远配不上，读者只能靠
     * `args.id` 才读得通——菜单里那条"点号与斜杠两种写法等价"的承诺当场成了假话。
     * 归一是 1:1 字符映射（前导 `/` 已在 raw 上剥掉），所以按长度切原样尾段仍然成立。
     */
    const head = normPath(v.path.slice(0, -"/<id>".length)); // "orchestrator/groups"
    if (!norm.startsWith(`${head}/`) && !norm.startsWith(`${head}.`)) continue;
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
