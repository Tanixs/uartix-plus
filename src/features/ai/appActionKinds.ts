/**
 * P88b-1 §12：App Action 名单常量（轻量模块，零 UI/store 依赖）。
 * appActions 与工具目录（agent/toolCatalog）共用同一份名单，
 * 目录测试可导入本模块而不触达 plotStore/uPlot 等渲染链。
 */

/** 需要脚本高权限的动作（MCP 桥 run_action 门控复用同一集合） */
export const HIGH_ONLY = new Set([
  "clearPage",
  "patchCard",
  "removeCard",
  "removeProtocol",
  "removeCommand",
  "removeCodec",
  "addPage",
  "openPort",
  "closePort",
  "removeWidget",
  // 从站/轮询会主动占用总线发数据，等同发送权限
  "modbus",
  // 哨兵可暂停监测/清报警，属全局控制
  "sentinel",
  // 考古报告会驱动模型长输出并代表「分析结论」，限脚本高权限
  "xrayReport",
  // P74c C2：编排器可向设备发数据（等同 send），且写入口会改自动化逻辑
  "orchestrator",
  // P74c C2：3D 轴绑定/显示设置决定「数据口径」（看哪三个通道），属配置写入
  "plot3d",
  // P78c：虚拟设备占据数据管线（与真实接口互斥、接管发送路由），等同发送权限
  "vdev",
]);

export const APP_ACTION_KINDS = [
  "openPanel",
  "applyPreset",
  "setTheme",
  "listProtocols",
  "listCommands",
  "listCards",
  "addChannel",
  "clearChannels",
  "writeCard",
  "writeCommand",
  "writeTemplate",
  "writeCodec",
  "clearPage",
  "patchCard",
  "addPage",
  "removeCard",
  "removeProtocol",
  "removeCommand",
  "removeCodec",
  "openPort",
  "closePort",
  "modbus",
  "xferStart",
  "readPlot",
  "sentinel",
  "xrayEvidence",
  "xrayCrack",
  "xrayReport",
  "orchestratorRead",
  "orchestrator",
  "plot3dRead",
  "plot3d",
  "vdev",
  "toast",
  "listWidgets",
  "openWidget",
  "closeWidget",
  "popWidget",
  "removeWidget",
] as const;

export type AppActionKind = (typeof APP_ACTION_KINDS)[number];
