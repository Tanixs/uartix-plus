/**
 * P88d ④：工具调用的人类可读展示层。P99a-A5：**中文名词与参数摘要都从注册表派生**。
 *
 * 这一层此前是四份手抄表的汇聚点：`TOOL_LABEL`（不是穷举类型，漏配只静默显示 snake_case）、
 * `summarizeArgs` 的大 `switch`（`default: ""` 静默空摘要）、动作 kind 中文表、产物种类中文表
 * （而且产物表在同文件里还被抄了第二份）。P99a 之后：
 *  - 工具名/摘要 → `hostEntries.hostEntryByName()`（entry 上就带 labelZh/summarize）；
 *  - 动作 kind → `toolCatalog.ACTION_LABEL_ZH`（`Record<AppActionKind,…>`，漏配 tsc 直接红）；
 *  - 产物种类 → `plugins/artifact.ARTIFACT_KIND_LABEL`（与插件库同一份）。
 * 本文件只剩"怎么把一条回执画成人话"这件它本来该管的事。
 */
import { hostEntryByName, hostToolLabel, readableToolName } from "./hostEntries";
import { actionKindLabel } from "./toolCatalog";
import { INSTALL_CODE_ZH } from "../market/marketIndex";

export { actionKindLabel };

/** 未登记的工具名（历史台账里的旧工具、插件工具）走可读化兜底，绝不显示裸常量 */
export function toolLabel(name: string): string {
  return hostToolLabel(name);
}

/** 解析参数 JSON（失败返回空对象，调用方按缺字段降级） */
export function parseArgs(args?: string): Record<string, unknown> {
  if (!args) return {};
  try {
    const v = JSON.parse(args) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 工具参数 → 一句话中文摘要。
 * 无摘要可给时回空串，UI 回退成通用形态；`read_artifact` 那类"参数过长"的情况由
 * entry.summarize 自己按 truncated 决定文案（P92 D1：绝不替模型编造它没说的话）。
 */
export function summarizeArgs(tool: string, args: Record<string, unknown>, truncated = false): string {
  const entry = hostEntryByName(tool);
  if (!entry?.summarize) return "";
  return entry.summarize(args, truncated);
}

/** 展示用兜底名（时间线里遇到没有 entry 的工具时仍给得出人话） */
export function fallbackToolLabel(name: string): string {
  return readableToolName(name);
}

/** 回执 data → 人类可读行（表格化：只列标量与短数组，嵌套对象折叠为键名列表） */
export function receiptRows(data: unknown): { k: string; v: string }[] {
  if (data == null) return [];
  if (typeof data !== "object") return [{ k: "结果", v: String(data).slice(0, 200) }];
  if (Array.isArray(data)) {
    if (data.length === 0) return [{ k: "结果", v: "（空）" }];
    return [{ k: "条目数", v: String(data.length) }, ...data.slice(0, 6).map((it, i) => ({ k: `#${i + 1}`, v: cell(it) }))];
  }
  const out: { k: string; v: string }[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (v === null || typeof v !== "object") {
      out.push({ k, v: String(v).slice(0, 160) });
    } else if (Array.isArray(v)) {
      out.push({ k, v: v.length <= 3 ? v.map((x) => cell(x)).join("、").slice(0, 160) || "（空）" : `${v.length} 项：${v.slice(0, 3).map((x) => cell(x)).join("、")}…`.slice(0, 160) });
    } else {
      out.push({ k, v: `对象 {${Object.keys(v as object).slice(0, 6).join(", ")}}` });
    }
    if (out.length >= 12) break;
  }
  return out;
}

function cell(v: unknown): string {
  if (v === null || typeof v !== "object") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  return `{${Object.keys(v as object).slice(0, 4).join(",")}}`;
}

/**
 * 状态徽章文案（回执→中文）。
 * `known` 里保留的 `general_tool_requires_custom` 是**历史码**：P99a 之后域门统一回
 * `unauthorized_scope`，但用户本地台账里存着旧码的事件还要能读出徽章，所以不能删。
 */
export function receiptStatusText(ok: boolean, status: string, code?: string): string {
  if (ok) {
    return status === "applied" ? "已完成" : status === "read" ? "已读取" : status === "validated" ? "已校验" : status;
  }
  const known: Record<string, string> = {
    // 市场装链的码：中文在契约层（`marketIndex.INSTALL_CODE_ZH`，穷举 Record），这里只合表不重抄
    ...INSTALL_CODE_ZH,
    needs_local_approval: "等待批准",
    preview_only: "仅预览未执行",
    unauthorized_scope: "超出授权范围",
    general_tool_requires_custom: "未勾选对应授权域",
    shell_disabled: "命令执行未开启",
    path_outside_whitelist: "路径不在白名单",
    unknown_token: "未知外观 token",
    invalid_value: "token 值非法",
    unknown_preset: "配方不存在",
    unsupported_image: "不支持的图片格式",
    empty_overlay: "当前没有外观修改可保存",
    denied_by_policy: "策略拒绝",
    revision_conflict: "目标已被修改",
    approval_rejected: "已被你拒绝",
    lease_busy: "数据租约繁忙",
    invalid_json: "参数格式错误",
    invalid_package: "插件包校验失败",
    install_failed: "插件安装失败",
    plugin_not_found: "插件不存在",
    // 下面四支是**目录**（`app_read`/`app_state`）能回的失败码：它们经 `r.code` 变量传进来，
    // P99a-F 那条"扫源码字面量"的钉看不见变量，所以这四个一直是裸码挂在时间线上（P99c-C2 补）
    unknown_path: "目录里没有这条路径",
    needs_id: "这条视图要带 id",
    read_failed: "视图读取出错",
    unknown_id: "标识不存在",
    market_not_loaded: "货架索引还没取回",
    artifact_expired: "缓存已过期",
    enable_failed: "启用失败",
    module_probe_failed: "逻辑模块未通过封网自证",
    no_scratch_layers: "没有待固化的临时样式",
    invalid_tool_args: "参数不符合工具声明",
    invalid_args: "参数不合法",
    unknown_tool: "工具不存在",
    unknown_action: "动作不在清单里",
    unknown_tool_ref: "模板引用了不存在的工具",
    unsafe_css: "样式未通过净化",
    too_large: "内容超出单次上限",
    is_dir: "目标是目录不是文件",
    invalid_kind: "产物种类不支持",
    invalid_name: "名称不合法",
    invalid_id: "标识不合法",
    invalid_payload: "载荷不符合产物形状",
    update_needs_user: "需要你在插件库里批准",
    update_rejected: "候选未通过校验",
    update_failed: "更新失败（已回退）",
    rollback_failed: "回滚失败",
    module_not_live: "插件模块未在线",
    tool_frozen_for_this_run: "工具不在本任务清单内",
    plugin_timeout: "插件工具超时（已重建）",
    plugin_error: "插件工具执行失败",
    plugin_unreachable: "插件模块不可达",
    module_busy: "插件模块并发已满",
    args_invalid: "参数无法序列化",
    args_too_large: "参数过大",
    cancelled: "已取消",
    call_id_reused: "调用重复（协议违规）",
    tool_failed_or_invalid_arguments: "工具执行失败或参数无效",
    tool_threw: "工具内部异常",
  };
  return known[code ?? ""] ?? (code || "失败");
}
