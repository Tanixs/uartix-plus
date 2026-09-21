/**
 * P88b-1 §12：单一工具目录。
 * 以 appActions.APP_ACTION_KINDS 为唯一动作面，逐动作声明副作用分类、幂等性与可逆性，
 * 并导出为 Agent ToolDefinition。策略判定（toolPolicy.decide）读这里的 meta，
 * 不读模型提交的任何 risk 字段。
 *
 * 八类功能覆盖度随 P88b-2/3 逐批补齐；本文件先把已有动作全部标注，
 * 避免“新对象再建第二套动作面”导致 UI/MCP/脚本各自绕权限（HANDOVER §6.3）。
 */
import { APP_ACTION_KINDS, HIGH_ONLY, type AppActionKind } from "../ai/appActionKinds";
import type { ToolPolicyMeta } from "./toolPolicy";
import type { ToolDefinition } from "./types";

/** 动作 → 副作用标注。read/analysis 类默认可并发；写类由 loop 串行。 */
const META: Record<AppActionKind, ToolPolicyMeta> = {
  // —— 观察/分析（零副作用）——
  listProtocols: { effect: "read", idempotent: true, reversible: true, mayTouchDevice: false },
  listCommands: { effect: "read", idempotent: true, reversible: true, mayTouchDevice: false },
  listCards: { effect: "read", idempotent: true, reversible: true, mayTouchDevice: false },
  listWidgets: { effect: "read", idempotent: true, reversible: true, mayTouchDevice: false },
  xrayEvidence: { effect: "analysis", idempotent: true, reversible: true, mayTouchDevice: false },
  xrayCrack: { effect: "analysis", idempotent: true, reversible: true, mayTouchDevice: false },
  orchestratorRead: { effect: "read", idempotent: true, reversible: true, mayTouchDevice: false },
  plot3dRead: { effect: "read", idempotent: true, reversible: true, mayTouchDevice: false },
  // 读图/报告：向模型发送上下文，不改应用状态，但会占用聊天流，按 analysis 处理
  readPlot: { effect: "analysis", idempotent: false, reversible: true, mayTouchDevice: false },
  xrayReport: { effect: "analysis", idempotent: false, reversible: true, mayTouchDevice: false },

  // —— UI 视图操作（可逆、无数据副作用）——
  openPanel: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },
  applyPreset: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },
  setTheme: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },
  toast: { effect: "read", idempotent: false, reversible: true, mayTouchDevice: false },
  openWidget: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },
  closeWidget: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },
  popWidget: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },
  clearChannels: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },

  // —— 新建草稿/新对象（自动，但不覆盖既有）——
  addChannel: { effect: "draft_write", idempotent: false, reversible: true, mayTouchDevice: false },
  addPage: { effect: "draft_write", idempotent: false, reversible: true, mayTouchDevice: false },
  writeCard: { effect: "draft_write", idempotent: false, reversible: true, mayTouchDevice: false },
  writeCommand: { effect: "draft_write", idempotent: false, reversible: true, mayTouchDevice: false },
  writeTemplate: { effect: "draft_write", idempotent: false, reversible: true, mayTouchDevice: false },
  writeCodec: { effect: "draft_write", idempotent: false, reversible: true, mayTouchDevice: false },

  // —— 修改既有用户对象（HANDOVER §6.3：覆盖用户已定义内容需人工批准）——
  patchCard: { effect: "destructive_write", idempotent: false, reversible: false, mayTouchDevice: false },
  plot3d: { effect: "config_write", idempotent: false, reversible: true, mayTouchDevice: false },

  // —— 破坏性：删除/清空用户内容 → 人工批准 ——
  removeCard: { effect: "destructive_write", idempotent: false, reversible: false, mayTouchDevice: false },
  removeProtocol: { effect: "destructive_write", idempotent: false, reversible: false, mayTouchDevice: false },
  removeCommand: { effect: "destructive_write", idempotent: false, reversible: false, mayTouchDevice: false },
  removeCodec: { effect: "destructive_write", idempotent: false, reversible: false, mayTouchDevice: false },
  removeWidget: { effect: "destructive_write", idempotent: false, reversible: false, mayTouchDevice: false },
  clearPage: { effect: "destructive_write", idempotent: false, reversible: false, mayTouchDevice: false },

  // —— 设备/总线相关：可能触达实车 → 依 deviceContext 判定 ——
  openPort: { effect: "device_send", idempotent: false, reversible: true, mayTouchDevice: true },
  closePort: { effect: "device_send", idempotent: false, reversible: true, mayTouchDevice: true },
  modbus: { effect: "device_send", idempotent: false, reversible: true, mayTouchDevice: true },
  xferStart: { effect: "device_send", idempotent: false, reversible: true, mayTouchDevice: true },
  vdev: { effect: "device_send", idempotent: false, reversible: true, mayTouchDevice: true },
  orchestrator: { effect: "device_send", idempotent: false, reversible: true, mayTouchDevice: true },
  // 哨兵可暂停监测/清报警：全局控制，按安全边界处理
  sentinel: { effect: "safety_boundary", idempotent: false, reversible: true, mayTouchDevice: false },
};

/** 目录完整性自检用：返回未标注的动作（应为空）。 */
export function untaggedActions(): string[] {
  return APP_ACTION_KINDS.filter((k) => !META[k]);
}

/**
 * 动作 kind → 中文。**放在动作目录里而不是显示层**，并且是 `Record<AppActionKind,…>`：
 * 新增一个动作忘了配中文名，tsc 直接报错（旧表在 toolDisplay 里是 `Record<string,string>`，
 * 漏配只会静默回显 snake_case——§8-36① 说的就是这类"看得见的漂移"）。
 */
export const ACTION_LABEL_ZH: Record<AppActionKind, string> = {
  openPanel: "打开面板", applyPreset: "应用预设", setTheme: "切换主题",
  listProtocols: "列出协议模板", listCommands: "列出指令", listCards: "列出卡片", listWidgets: "列出小部件",
  addChannel: "新增通道", clearChannels: "清空通道",
  writeCard: "新建控制卡片", writeCommand: "新建指令", writeTemplate: "写入协议模板", writeCodec: "写入编码配置",
  patchCard: "修改卡片", addPage: "新增页", clearPage: "清空页",
  removeCard: "删除卡片", removeProtocol: "删除协议模板", removeCommand: "删除指令", removeCodec: "删除编码配置", removeWidget: "删除小部件",
  openPort: "打开串口", closePort: "关闭串口", modbus: "Modbus 工作台", xferStart: "启动文件传输",
  readPlot: "读取曲线图", sentinel: "哨兵", xrayEvidence: "结构证据", xrayCrack: "校验爆破", xrayReport: "协议考古报告",
  orchestratorRead: "读取编排", orchestrator: "编排器操作", plot3dRead: "读取 3D 轨迹", plot3d: "3D 轨迹操作", vdev: "虚拟设备",
  toast: "弹提示", openWidget: "打开小部件", closeWidget: "关闭小部件", popWidget: "弹出小部件",
};

/** 动作 kind 的中文（未登记时同样可读化，绝不显示裸常量） */
export function actionKindLabel(kind: string): string {
  const hit = (ACTION_LABEL_ZH as Record<string, string>)[kind];
  return hit ?? kind.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

export function actionMeta(kind: string): ToolPolicyMeta | undefined {
  return META[kind as AppActionKind];
}

/** 供 Agent adapter 使用的 ToolDefinition 列表（描述与参数 schema 沿用现有动作契约）。 */
export function toolDefinitions(): ToolDefinition[] {
  return APP_ACTION_KINDS.map((kind) => ({
    name: kind,
    description: `${kind}${HIGH_ONLY.has(kind) ? "（需高权限，受审批策略约束）" : ""}`,
    parameters: { type: "object", properties: { args: { type: "object" } }, required: ["args"], additionalProperties: false },
  }));
}

export { META as ACTION_POLICY_META };
