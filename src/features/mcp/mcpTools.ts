/**
 * MCP 工具定义与纯变换（P64）——前端执行端与 Node CLI 桥共用的唯一来源。
 *
 * 本文件必须保持**只依赖纯数据模块**（不 import Tauri / store / DOM）：Node 桥经 esbuild
 * 打包时直接引用 TOOL_DEFS 生成 tools/list，前端执行端引用它做分发校验。
 * 纯变换（compactFrame / summarizeRun / flattenResults）配 vitest 单测。
 *
 * P99a-E1 放宽了一条：允许引 `ai/appActionKinds`（纯常量表，零副作用）。理由是这里曾把
 * "有哪些动作、哪些属高权限"**手抄第二份**进描述文本——清单会过期，而外部 IDE 照着过期清单
 * 调用的失败现象是"未知动作"，看起来像我们坏了（§8-36① 的又一同源病灶）。
 */
import { APP_ACTION_KINDS, HIGH_ONLY } from "../ai/appActionKinds";

/** MCP tools/list 工具描述（inputSchema 为 JSON Schema 子集：object） */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * P99a-E1：门控与状态码话术**只写一份**。
 *
 * 改之前的实情：`允许高权限动作` 这句话在 4 条工具描述里各抄一遍、在 `mcpServer.ts` 里再抄一遍；
 * `async_required` 那句在 `mcpTools`（描述）、`mcpServer`（抛错）与 `bridge.rs`（Rust 侧）各有一份。
 * 措辞要改就得同时动六处，漏一处的结果是"IDE 读到的说明"和"实际拿到的错误"对不上——
 * 外部调用方只能靠猜。Rust 那一份跨语言，只能靠注释与测试钉住同文，这里先把 TS 侧收成一处。
 */
/** 设置项的中文名只写一次：描述里、抛错里、设置页 `row(tx(...))` 三处必须同字（不同字用户找不到） */
export const SETTING_SEND = "允许远程发送";
export const SETTING_HIGH = "允许高权限动作";
export const GATE_SEND = `需要 Uartix+ 设置 → 集成 开启「${SETTING_SEND}」`;
export const GATE_HIGH_KIND = SETTING_HIGH;
export const gateHighPriv = (kind: string): string =>
  `动作「${kind}」属高权限：请到 Uartix+ 设置 → 集成 开启「${SETTING_HIGH}」`;
export const ASYNC_REQUIRED =
  "async_required: use create_job({taskType:'sequence.run', input:{json}, idempotencyKey}). No sequence was executed.";
export const NEEDS_MANUAL =
  "needs_manual_confirmation: background execution must be started locally; highPriv/confirmed are not approval";

/** 工具面：v1 为 8 个（详设 §2.2）；P74c C2 增 get_orchestrator / get_plot3d 两个只读工具（编排器与 3D 的写通路统一走 run_action）。描述里写清权限门控，让 IDE 智能体自己判断 */
export const TOOL_DEFS: McpToolDef[] = [
  {
    name: "get_status",
    description:
      "Uartix+ 连接状态总览：连接状态/接口/端口/波特率、RX/TX 字节计数、帧解析统计（总数/错误）、MCP 客户端数。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_fields",
    description:
      "当前变量快照：所有已解析字段（模板字段 id）的最新值/文本/更新时刻。适合回答「现在 xx 是多少」。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_frames",
    description:
      "最近解析的原始帧（新→旧），含模板名/有效标志/字段值/帧字节 hex（截断 64B）。支持 beforeSeq 游标分页向更旧历史翻页。",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          description: "单页条数（默认 32，上限 256）",
          minimum: 1,
          maximum: 256,
        },
        beforeSeq: {
          type: "integer",
          description:
            "分页游标：只返回 seq 小于该值的帧。传上一页响应里的 nextBeforeSeq 即可翻更旧一页；缺省从最新开始",
          minimum: 0,
        },
      },
    },
  },
  {
    name: "get_plot_stats",
    description: "2D 曲线面板统计文本：数据点数、X 范围、每条可见通道的 min/max/均值/斜率/周期等。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_alerts",
    description: "哨兵监测快照：健康分、未确认/严重/警告计数，以及最近的报警列表（新→旧，截 20 条）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_orchestrator",
    description:
      "自动编排器只读快照：总开关、在跑实例数、各组（事件种类/冷却 ms/满队列策略 dropNew·dropOld·stopOld/块数与类型直方图/累计运行与失败次数/最近一次结果）、变量现值、最近 10 条运行日志。只读、不需高权限。写操作（增删改组/触发运行/写变量）用 run_action，kind=orchestrator（属高权限，清单见 run_action 描述）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_plot3d",
    description:
      "3D 轨迹面板只读快照（P87e 弹性组数）：groups 数组（每组 name/color/visible、axes x/y/z 通道 id 与是否绑齐、mode=point|points|line、colorBy、fade、density、smooth、maxPoints、配对与备注）、view 全局视图设置（三轴缩放/网格/跟随/自动旋转/键盘飞行/光标缩放）、是否椭球校准模式（采样源=calibSource，可为 null）、采样点数与八象限覆盖度、椭球拟合结果（offset/gains/半径变异系数 cv/残差 RMS）、六面校准进度。只读、不需高权限。写操作（组绑定/显示设置/清空/撤销/校准会话）用 run_action，kind=plot3d（属高权限，清单见 run_action 描述）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send",
    description:
      "向已连接的串口/TCP/UDP 发送数据。mode=ascii 支持 \\r \\n \\t \\xNN 转义；mode=hex 为空格分隔的十六进制。" + GATE_SEND + "。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "发送内容" },
        mode: { type: "string", enum: ["ascii", "hex"], description: "默认 ascii" },
      },
      required: ["text"],
    },
  },
  {
    name: "run_action",
    description:
      // 动作清单与高权限子集**从常量表派生**：原先这里是手抄的"常用 kind"，
      // 新增动作忘了抄，外部 IDE 就拿到一个永远"未知动作"的名字。
      `执行 Uartix+ 的 App Action。kind ∈ ${APP_ACTION_KINDS.join(" | ")}。` +
      `其中需要「${GATE_HIGH_KIND}」的一组：${[...HIGH_ONLY].join(" | ")}。` +
      "编排器与 3D 的读写也都走这里：kind=orchestrator（只读请改用 get_orchestrator）、kind=plot3d（只读改用 get_plot3d）。" +
      "写模板/命令等非破坏动作直接可用；groupRemove/覆盖已有文件一类无确认通路时直接返回 needs_manual_confirmation，未执行——highPriv 或 confirmed 参数不构成批准。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "动作名，如 writeTemplate" },
        args: { type: "object", description: "动作参数（与 App Action API 一致）" },
      },
      required: ["kind"],
    },
  },
  {
    name: "run_sequence",
    description:
      "旧同步入口已停用：执行前返回 async_required，不执行任何步骤。改用 create_job(sequence.run)，只允许可证无设备副作用的序列；发送需本机人工确认，highPriv/confirmed 不构成批准。",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "套件 JSON（单个 suite 对象或其数组包一层的导出格式）" },
        maxRunMs: { type: "integer", description: "运行超时毫秒（默认 120000，上限 600000）" },
      },
      required: ["json"],
    },
  },
];

export const JOB_TOOL_DEFS: McpToolDef[] = [
  { name: "create_job", description: "Create an async job (accepted means registered, not completed). sequence.validate is local validation; sequence.run permits only side-effect-free steps. Sends/unknown steps return needs_manual_confirmation immediately, without queueing. highPriv/confirmed are not approval. Retry only with the identical jobId idempotency key within the same instance/auth epoch; never auto-replace an expired or old-instance task.", inputSchema: { type: "object", properties: {
    taskType: { type: "string", enum: ["sequence.validate", "sequence.run"] },
    input: { type: "object", description: "{suite: exportedSuite} or {json: exportedSuiteJson}" },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
    deadlineMs: { type: "integer", minimum: 1000, maximum: 600000, default: 120000 },
  }, required: ["taskType", "input", "idempotencyKey"] } },
  { name: "get_job", description: "Read the authoritative job snapshot by jobId without waiting for the WebView. Optional result pages are JSON UTF-8 text chunks; concatenate all pages before parsing. interrupted/instance_changed means effects cannot be confirmed; do not resubmit automatically.", inputSchema: { type: "object", properties: {
    jobId: { type: "string" }, includeResult: { type: "boolean" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 4, maximum: 16384 },
  }, required: ["jobId"] } },
  { name: "wait_event", description: "Read bounded job events by jobId, optionally wait up to 1000ms. Empty events are normal, not failure. gap=true requires resynchronizing from the returned snapshot; event order never regresses.", inputSchema: { type: "object", properties: {
    jobId: { type: "string" }, afterSeq: { type: "integer", minimum: 0 }, waitMs: { type: "integer", minimum: 0, maximum: 1000 },
  }, required: ["jobId", "afterSeq"] } },
  { name: "cancel_job", description: "Request cooperative stop of the job by jobId. cancel_requested is not stop confirmation; cancellation does not undo previous effects. Idempotent, still available after permission withdrawal.", inputSchema: { type: "object", properties: {
    jobId: { type: "string" }, reason: { type: "string", maxLength: 120 },
  }, required: ["jobId"] } },
];
export const ALL_TOOL_DEFS = [...TOOL_DEFS, ...JOB_TOOL_DEFS];

/** 生成 MCP 客户端配置 JSON（claude_desktop_config.json / Cursor mcp.json 同构）。
 *  cliPath 由用户在设置页填（repo 场景为 dist-cli/uartix-mcp.cjs 的绝对路径）。 */
export function mcpServerConfig(cliPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        uartix: {
          command: "node",
          args: [cliPath.trim() || "<uartix-mcp.cjs 的绝对路径>"],
        },
      },
    },
    null,
    2,
  );
}

/* ================= 纯变换 ================= */

/** 帧环形分页（P66-1）：ringAsc 为 seq 升序（末尾最新）。
 *  取 seq < beforeSeq（缺省=全部）的最新 count 条，返回新→旧页 + 下一页游标。
 *  hasMore 表示环形里还有更旧的帧可翻。 */
export function pageFrames<T extends { seq: number }>(
  ringAsc: readonly T[],
  count: number,
  beforeSeq: number | null,
): { page: T[]; nextBeforeSeq: number | null; hasMore: boolean } {
  const n = Math.min(256, Math.max(1, Math.round(count) || 32));
  let end = ringAsc.length;
  if (beforeSeq !== null && Number.isFinite(beforeSeq)) {
    // 二分：第一个 seq >= beforeSeq 的下标 = < beforeSeq 区间的右边界
    let lo = 0;
    let hi = ringAsc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ringAsc[mid].seq < beforeSeq) lo = mid + 1;
      else hi = mid;
    }
    end = lo;
  }
  const start = Math.max(0, end - n);
  const page = ringAsc.slice(start, end).reverse();
  return {
    page,
    nextBeforeSeq: page.length > 0 ? page[page.length - 1].seq : null,
    hasMore: start > 0,
  };
}

/** 帧行 → MCP 友好的紧凑 JSON（字节 hex 截 64B，字段名 → 值/文本） */
export function compactFrame(row: {
  tplName: string;
  tsMs: number;
  seq: number;
  valid: boolean;
  error: string | null;
  fields: { name: string; value: number; text: string | null }[];
  bytes?: Uint8Array;
}): Record<string, unknown> {
  const fields: Record<string, number | string> = {};
  for (const f of row.fields) {
    fields[f.name] = f.text !== null ? f.text : f.value;
  }
  const out: Record<string, unknown> = {
    tpl: row.tplName,
    ts: row.tsMs,
    seq: row.seq,
    valid: row.valid,
    fields,
  };
  if (row.error) out.err = row.error;
  if (row.bytes && row.bytes.length > 0) {
    const n = Math.min(row.bytes.length, 64);
    const hex = Array.from(row.bytes.slice(0, n), (b) =>
      b.toString(16).toUpperCase().padStart(2, "0"),
    ).join(" ");
    out.hex = row.bytes.length > n ? `${hex} …(共${row.bytes.length}B)` : hex;
  }
  return out;
}

export interface StepLike {
  kind: string;
  label: string;
  status: string;
  durationMs: number;
  detail: string;
  children?: StepLike[];
}

/** 结果树 → 扁平行（depth 缩进语义保留，报告摘要用；cap 防超长） */
export function flattenResults(steps: StepLike[], depth = 0, cap = 200): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (list: StepLike[], d: number) => {
    for (const s of list) {
      if (out.length >= cap) return;
      out.push({ depth: d, kind: s.kind, label: s.label, status: s.status, ms: s.durationMs, detail: s.detail });
      if (s.children?.length) walk(s.children, d + 1);
    }
  };
  walk(steps, depth);
  return out;
}

/** 统计 pass/fail/其他（group.children 参与计数；skipped/aborted 计入 other） */
export function countStatuses(steps: StepLike[]): { pass: number; fail: number; other: number } {
  let pass = 0;
  let fail = 0;
  let other = 0;
  const walk = (list: StepLike[]) => {
    for (const s of list) {
      if (s.status === "pass") pass++;
      else if (s.status === "fail" || s.status === "timeout") fail++;
      else other++;
      if (s.children?.length) walk(s.children);
    }
  };
  walk(steps);
  return { pass, fail, other };
}

/** RunResult → MCP 返回摘要（树拍平 + 计数 + 总时长） */
export function summarizeRun(result: {
  suiteName: string;
  status: string;
  startedAt: number;
  finishedAt: number;
  steps: StepLike[];
}): Record<string, unknown> {
  return {
    suite: result.suiteName,
    status: result.status,
    durationMs: Math.max(0, result.finishedAt - result.startedAt),
    ...countStatuses(result.steps),
    steps: flattenResults(result.steps),
  };
}
