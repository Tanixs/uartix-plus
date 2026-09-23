/**
 * P99c-C2/O1：编排器**活值**的唯一读取处（一处判定，两处投影）。
 *
 * 为什么单独一层，而不是让自省目录再去 `statsOf` 一遍：动作 `orchestratorRead` 今天已经在算
 * 同一批数（总开关 / 在跑实例 / 各组 runs·fails / 变量现值 / 最近日志）。目录再算一遍就是第二真相
 * ——两处迟早会给出两个"现在在跑几条"，而这批要给人的恰恰就是这一个数（§8-48）。
 * 于是：动作返回这一份，目录在**同一份**上做投影（改名、去原文、限长）。
 *
 * 装载副作用照实说一遍，因为它就住在这个文件的形状里：读活值要动态加载 `orchestratorBind`
 * （它在求值期 `new OrchEngine`、接事件源、起 `setInterval`）。这与动作 `orchestratorRead`
 * 走的是**同一条装载路**（`appActions.orchMods`），本模块不新造第二条装载点；批准代价也一样——
 * `orchestratorRead` 在动作元表里本来就是 `effect:"read"`、免批准，所以目录读它不多放一格权限。
 * 反过来，把 bind 改成**静态** import 会砸进启动路径（P74 那次 TDZ 白屏的现场），所以这里必须是动态。
 */
import { ORCH_LIMITS } from "./types";

export interface OrchRuntimeGroup {
  id: string;
  name: string;
  enabled: boolean;
  /** 事件块的种类清单（空数组＝只能靠别的组触发或手动跑） */
  events: string[];
  autoTriggers: boolean;
  cooldownMs: number;
  queuePolicy: string;
  note: string;
  /** 块树规模：只数数量与种类直方图，不递归给结构（结构走 `orchestrator.groups/<id>`） */
  blocks: number;
  kinds: Record<string, number>;
  runs: number;
  fails: number;
  /** 上一次跑是什么时候（ISO）；从没跑过是 null */
  lastAt: string | null;
  lastDetail: string;
}

export interface OrchRuntime {
  masterOn: boolean;
  runningInstances: number;
  groupCount: number;
  groupCap: number;
  queueCap: number;
  logCap: number;
  /** 日志环里现在有多少条（上限 `logCap`，超出淘汰最旧的） */
  logCount: number;
  groups: OrchRuntimeGroup[];
  vars: { name: string; type: string; value: number | string | boolean; default: number | string | boolean; persist: boolean }[];
  recentLogs: { at: string; groupId: string; phase: string; detail: string }[];
}

/** 最近日志只带这么几条出去（与动作 `orchestratorRead` 历来的口径一致，不为目录另设一个数） */
export const ORCH_RUNTIME_LOG_TAIL = 10;

/** 块树规模统计：只报数量与种类直方图，不展开结构。 */
function blockBrief(nodes: unknown[]): { blocks: number; kinds: Record<string, number> } {
  let blocks = 0;
  const kinds: Record<string, number> = {};
  const walk = (list: unknown[]) => {
    for (const raw of list) {
      const n = raw as { kind?: string; then?: unknown[]; els?: unknown[]; body?: unknown[]; children?: unknown[] };
      if (!n || typeof n.kind !== "string") continue;
      blocks++;
      kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
      if (Array.isArray(n.then)) walk(n.then);
      if (Array.isArray(n.els)) walk(n.els);
      if (Array.isArray(n.body)) walk(n.body);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(nodes);
  return { blocks, kinds };
}

/**
 * 读一次活值。两条边界：
 *  - **不刷新、不改任何东西**：只读 store 快照与引擎里那几本账；
 *  - 引擎装载失败（非 Tauri 环境、模块图未就绪）时**照实抛**，由两个投影各自决定怎么出声
 *    （动作回一条 error 回执；目录回 `{available:false, why, next}`——目录那条不能带 `error` 键，
 *    `readCatalog` 会把顶层 `error` 当视图自己失败）。
 */
export async function readOrchestratorRuntime(): Promise<OrchRuntime> {
  const [bind, store] = await Promise.all([import("./orchestratorBind"), import("./orchestratorStore")]);
  const doc = store.getSnapshot().doc;
  const eng = bind.orchEngine;
  const logs = eng.getLogs();
  return {
    masterOn: doc.settings.masterOn,
    runningInstances: eng.runningCount(),
    groupCount: doc.groups.length,
    groupCap: ORCH_LIMITS.groupCap,
    queueCap: ORCH_LIMITS.queueCap,
    logCap: ORCH_LIMITS.logCap,
    logCount: logs.length,
    groups: doc.groups.map((g) => {
      const st = eng.statsOf(g.id);
      return {
        id: g.id,
        name: g.name,
        enabled: g.enabled,
        events: g.events.map((e) => e.kind),
        autoTriggers: g.events.length > 0,
        cooldownMs: g.cooldownMs ?? 0,
        queuePolicy: g.queuePolicy ?? "dropNew",
        note: g.note ?? "",
        ...blockBrief(g.children),
        runs: st.total,
        fails: st.fail,
        lastAt: st.lastTs ? new Date(st.lastTs).toISOString() : null,
        lastDetail: st.lastDetail,
      };
    }),
    vars: eng.listVars().map((v) => ({ name: v.name, type: v.type, value: v.value, default: v.def, persist: v.persist })),
    recentLogs: logs
      .slice(-ORCH_RUNTIME_LOG_TAIL)
      .map((l) => ({ at: new Date(l.ts).toISOString(), groupId: l.groupId, phase: l.phase, detail: l.detail })),
  };
}
