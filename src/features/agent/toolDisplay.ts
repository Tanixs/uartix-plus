/**
 * P88d ④：工具调用的人类可读展示层。
 * 时间线卡片不再裸贴 JSON——每个工具登记摘要规则（参数→一句话），
 * 展开详情按字段表格化；未知工具回退「名称 · 状态」，绝不显示原始 JSON 串。
 */

/** 工具名 → 中文显示名（未登记回退原名） */
export const TOOL_LABEL: Record<string, string> = {
  settings_read: "读取设置",
  settings_describe: "设置项目录",
  settings_apply: "应用设置",
  settings_apply_patch: "应用设置",
  template_list: "协议模板列表",
  template_write: "写入协议模板",
  command_write: "写入指令",
  card_write: "生成控制卡片",
  plot_channels: "通道统计",
  plot_window: "采样窗口",
  read_artifact: "取回回执",
  save_plugin: "保存插件",
  enable_plugin: "启用插件",
  list_plugins: "查看插件库",
  run_action: "执行动作",
  fs_read: "读取文件",
  fs_list: "列出目录",
  web_fetch: "抓取网页",
  web_search: "搜索网页",
  shell_exec: "执行命令",
  theme_read: "读取外观",
  theme_patch: "修改外观",
  theme_preset: "应用配方",
  image_swatch: "图片取色",
  save_theme_extension: "保存主题",
};

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

const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const n = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

/** 工具参数 → 一句话中文摘要（登记制；未登记工具返回 ""，UI 回退通用形态） */
export function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "settings_read":
      return "读取当前设置";
    case "settings_describe":
      return "查询可改设置项";
    case "settings_apply":
    case "settings_apply_patch": {
      const keys = Object.keys(args);
      const named = keys.filter((k) => k !== "revision" && k !== "patch");
      const patch = args.patch;
      const patchKeys = patch && typeof patch === "object" ? Object.keys(patch as object) : [];
      const all = (named.length ? named : patchKeys).filter((k) => k !== "revision");
      return all.length ? `修改 ${all.slice(0, 4).join("、")}${all.length > 4 ? ` 等 ${all.length} 项` : ""}` : "应用设置修改";
    }
    case "template_list":
      return "列出协议模板";
    case "template_write":
      return args.name ? `保存模板「${s(args.name)}」` : args.name_ ? `保存模板「${s(args.name_)}」` : "新建协议模板";
    case "command_write":
      return args.name ? `保存指令「${s(args.name)}」` : "新建指令";
    case "card_write":
      return args.title ? `生成卡片「${s(args.title)}」` : "生成控制卡片";
    case "plot_channels":
      return "读取通道统计";
    case "plot_window": {
      const ch = Array.isArray(args.channels) ? args.channels.length : 0;
      const pts = n(args.points) ?? n(args.count);
      return `采样 ${ch || "?"} 通道${pts ? ` · 每道 ${pts} 点` : ""}`;
    }
    case "read_artifact":
      return `取回回执 ${s(args.callId).slice(0, 8)}`;
    case "save_plugin": {
      const kindZh: Record<string, string> = {
        theme: "主题", widget: "小部件", panel: "面板", motionPreset: "动效", workspacePreset: "工作区", workflow: "工作流", reportView: "报告",
      };
      const k = kindZh[s(args.kind)] ?? s(args.kind);
      return `保存${k}插件「${s(args.name) || "?"}」${args.enable === true ? "并启用" : ""}`;
    }
    case "enable_plugin":
      return `启用插件 ${s(args.id)}`;
    case "list_plugins":
      return "查看插件库";
    case "fs_read":
      return `读取 ${s(args.path)}`;
    case "fs_list":
      return `列出 ${s(args.path)}${n(args.depth) ? ` · ${n(args.depth)} 层` : ""}`;
    case "web_fetch":
      return `抓取 ${s(args.url).slice(0, 60)}`;
    case "web_search":
      return `搜索「${s(args.query).slice(0, 40)}」`;
    case "shell_exec":
      return `执行 ${s(args.command).slice(0, 60)}`;
    case "theme_read":
      return "读取外观 token";
    case "theme_patch": {
      const tokens = args.tokens;
      const keys = tokens && typeof tokens === "object" ? Object.keys(tokens as object) : [];
      return keys.length ? `调整 ${keys.slice(0, 4).join("、")}${keys.length > 4 ? ` 等 ${keys.length} 项` : ""}` : "调整外观";
    }
    case "theme_preset":
      return `配方「${s(args.name) || "?"}」`;
    case "image_swatch":
      return `取色 ${s(args.path).split(/[\\/]/).pop() || s(args.path).slice(0, 40)}`;
    case "save_theme_extension":
      return `保存主题「${s(args.name) || "?"}」`;
    case "run_action": {
      const a = s(args.action);
      const zh: Record<string, string> = {
        "layout.switch": "切换布局", "layout.save": "保存布局", "serial.send": "发送串口数据",
        "seq.run": "运行测试序列", "seq.stop": "停止序列", "orch.run": "运行编排组", "orch.stop": "停止编排",
      };
      return a ? `${zh[a] ?? `执行 ${a}`}` : "执行动作";
    }
    default:
      return "";
  }
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

/** 状态徽章文案（回执→中文） */
export function receiptStatusText(ok: boolean, status: string, code?: string): string {
  if (ok) {
    return status === "applied" ? "已完成" : status === "read" ? "已读取" : status === "validated" ? "已校验" : status;
  }
  const known: Record<string, string> = {
    needs_local_approval: "等待批准",
    preview_only: "仅预览未执行",
    unauthorized_scope: "超出授权范围",
    general_tool_requires_custom: "需自定义档位授权",
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
    plugin_not_found: "插件不存在",
    enable_failed: "启用失败",
    cancelled: "已取消",
    call_id_reused: "调用重复（协议违规）",
    tool_failed_or_invalid_arguments: "工具执行失败或参数无效",
  };
  return known[code ?? ""] ?? (code || "失败");
}
