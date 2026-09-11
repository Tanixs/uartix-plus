/**
 * Operator 部署包（P67-O1）——.uopk 单文件发行物：
 * 把工程机上的工作区（协议模板 / 控制页 / 命令库 / 布局 / 设置子集）打包，
 * 操作员端导入后以只读模式运行（连设备、发命令、看数据；不能改配置）。
 *
 * 本模块保持纯函数（不 import store），便于单测；收集与应用在 operatorStore.ts。
 * 文件外壳复用导出约定：{ kind, version, data }，data = OperatorPkg。
 */
import type { FrameTemplate } from "../../ipc/types";
import type { GroupMeta } from "../protocol/templateStore";
import type { ControlPage } from "../controls/controlsStore";
import type { CommandGroup } from "../controls/commandStore";
import type { Settings } from "../settings/settingsStore";

export const OPERATOR_KIND = "uartix-operator";
export const OPERATOR_VERSION = 1;

export interface OperatorMeta {
  /** 包名（操作员界面横幅展示） */
  name: string;
  description: string;
  createdAt: number;
  /** 生成时的应用版本（诊断用，不校验） */
  appVersion: string;
}

export interface OperatorPayload {
  templates?: { templates: FrameTemplate[]; groups: Record<string, GroupMeta> };
  controls?: ControlPage[];
  commands?: CommandGroup[];
  /** dockview api.toJSON() 序列化结果（导入后整屏应用） */
  layout?: unknown;
  /** 已按白名单过滤的设置子集（filterSettings 产出） */
  settings?: Partial<Settings>;
}

export interface OperatorPkg {
  meta: OperatorMeta;
  payload: OperatorPayload;
}

/** 文件外壳（saveJson/loadJson 的 kind 包装） */
export interface OperatorPkgFile {
  kind: typeof OPERATOR_KIND;
  version: typeof OPERATOR_VERSION;
  data: OperatorPkg;
}

/**
 * 进包的设置白名单：外观与交互行为。
 * 本机私有/环境相关不进包：AI 服务与密钥、MCP token/端口、窗口缩放、perfHud。
 */
const SETTINGS_KEYS: readonly (keyof Settings)[] = [
  "theme",
  "locale",
  "decimals",
  "workspace",
  "cellSize",
  "chartPalette",
  "conWrap",
  "reduceMotion",
  "autoReconnect",
];

export function filterSettings(s: Settings): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of SETTINGS_KEYS) {
    (out as Record<string, unknown>)[k] = structuredClone(s[k]);
  }
  return out;
}

/** 生成文件外壳（不校验内容；导出前内容来自各 store 的导出函数） */
export function buildPkgFile(pkg: OperatorPkg): OperatorPkgFile {
  return { kind: OPERATOR_KIND, version: OPERATOR_VERSION, data: structuredClone(pkg) };
}

/** 校验并规整（loadJson 解包 data 后调用）；失败抛用户可读错误 */
export function validatePkg(raw: unknown): OperatorPkg {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Operator 包格式不正确：缺少内容");
  }
  const r = raw as Partial<OperatorPkg>;
  const meta = r.meta as Partial<OperatorMeta> | undefined;
  if (!meta || typeof meta.name !== "string" || !meta.name.trim()) {
    throw new Error("Operator 包缺少包名（meta.name）");
  }
  if (typeof r.payload !== "object" || r.payload === null) {
    throw new Error("Operator 包缺少载荷（payload）");
  }
  const p = r.payload as OperatorPayload;
  if (p.templates !== undefined) {
    if (typeof p.templates !== "object" || p.templates === null || !Array.isArray(p.templates.templates)) {
      throw new Error("Operator 包的协议模板数据不正确");
    }
  }
  if (p.controls !== undefined && !Array.isArray(p.controls)) {
    throw new Error("Operator 包的控制页数据不正确");
  }
  if (p.commands !== undefined && !Array.isArray(p.commands)) {
    throw new Error("Operator 包的命令库数据不正确");
  }
  return {
    meta: {
      name: meta.name.trim().slice(0, 60),
      description: typeof meta.description === "string" ? meta.description.slice(0, 200) : "",
      createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
      appVersion: typeof meta.appVersion === "string" ? meta.appVersion : "",
    },
    payload: p,
  };
}
