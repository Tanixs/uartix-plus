/**
 * MCP 工具定义与纯变换（P64）——前端执行端与 Node CLI 桥共用的唯一来源。
 *
 * 本文件必须保持零依赖（不 import Tauri / store / DOM）：Node 桥经 esbuild
 * 打包时直接引用 TOOL_DEFS 生成 tools/list，前端执行端引用它做分发校验。
 * 纯变换（compactFrame / summarizeRun / flattenResults）配 vitest 单测。
 */

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

/** v1 工具面：8 个（详设 §2.2）。描述里写清权限门控，让 IDE 智能体自己判断 */
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
    name: "send",
    description:
      "向已连接的串口/TCP/UDP 发送数据。mode=ascii 支持 \\r \\n \\t \\xNN 转义；mode=hex 为空格分隔的十六进制。需要 Uartix+ 设置 → 集成 开启「允许远程发送」。",
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
      "执行 Uartix+ 的 App Action（writeTemplate/writeCommand/openPanel/addChannel/openPort… 完整清单见 tools 说明）。写模板/命令等非破坏动作直接可用；openPort/closePort/删除类属高权限，需在设置 → 集成 开启「允许高权限动作」。",
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
      "在 Uartix+ 内执行一个测试序列套件（JSON，与「测试序列器」导出格式一致），返回逐步结果摘要。会真实向设备发包，需要开启「允许远程发送」。",
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
