export type Locale = "zh" | "en";

type Dict = Record<string, string>;

const zh: Dict = {
  "app.name": "Uartix+",
  "iface.title": "数据接口",
  "iface.serial": "串口",
  "iface.tcpClient": "TCP 客户端",
  "iface.tcpServer": "TCP 服务端",
  "iface.udp": "UDP",
  "iface.soon": "即将支持",
  "title.settings": "设置",
  "title.help": "帮助与入门",
  "title.pin": "窗口置顶",
  "title.unpin": "取消窗口置顶",
  "title.minimize": "最小化",
  "title.maximize": "最大化",
  "title.restore": "还原",
  "title.close": "关闭",
  "set.general": "通用",
  "set.workspace": "工作区",
  "set.data": "数据",
  "set.diagnostics": "诊断",
  "set.about": "关于",
  "set.io": "导入 / 导出",
  "set.language": "界面语言",
  "set.theme": "界面主题",
  "set.theme.dark": "暗色",
  "set.theme.light": "亮色",
  "set.zoom": "界面缩放",
  "set.preset": "预设布局",
  "set.preset.proto": "协议调试",
  "set.preset.analyze": "数据分析",
  "set.preset.attitude": "姿态调参",
  "set.preset.console": "纯串口",
  "set.resetLayout": "重置布局",
  "set.decimals": "图例小数位数",
  "set.perfHud": "诊断 HUD（FPS/长任务/渲染计数）",
  "set.checkUpdate": "检查更新",
  "set.version": "版本",
  "set.repo": "开源仓库",
  "set.license": "开源协议",
  "set.export": "导出",
  "set.import": "导入",
  "set.exportTemplates": "协议模板（含协议簇名）",
  "set.importTemplates": "协议模板 → 追加为副本",
  "set.exportControls": "控制画布（全部页+卡片+脚本）",
  "set.importControls": "控制画布 → 导入为新控制页",
  "set.exportCommands": "命令库（递归树+脚本）",
  "set.importCommands": "命令库 → 合并导入",
  "set.ioHint": "文件格式为 JSON（含 kind/version 校验），可分享给同事或做备份。",
};

const en: Dict = {
  "app.name": "Uartix+",
  "iface.title": "Data Interface",
  "iface.serial": "Serial Port",
  "iface.tcpClient": "TCP Client",
  "iface.tcpServer": "TCP Server",
  "iface.udp": "UDP",
  "iface.soon": "Coming soon",
  "title.settings": "Settings",
  "title.help": "Help",
  "title.pin": "Always on top",
  "title.unpin": "Disable always on top",
  "title.minimize": "Minimize",
  "title.maximize": "Maximize",
  "title.restore": "Restore",
  "title.close": "Close",
  "set.general": "General",
  "set.workspace": "Workspace",
  "set.data": "Data",
  "set.diagnostics": "Diagnostics",
  "set.about": "About",
  "set.io": "Import / Export",
  "set.language": "Language",
  "set.theme": "Theme",
  "set.theme.dark": "Dark",
  "set.theme.light": "Light",
  "set.zoom": "UI Scale",
  "set.preset": "Layout Preset",
  "set.preset.proto": "Protocol Debug",
  "set.preset.analyze": "Data Analysis",
  "set.preset.attitude": "Attitude Tuning",
  "set.preset.console": "Serial Only",
  "set.resetLayout": "Reset Layout",
  "set.decimals": "Legend Decimals",
  "set.perfHud": "Perf HUD (FPS/long tasks/renders)",
  "set.checkUpdate": "Check Updates",
  "set.version": "Version",
  "set.repo": "Repository",
  "set.license": "License",
  "set.export": "Export",
  "set.import": "Import",
  "set.exportTemplates": "Protocol templates (with cluster names)",
  "set.importTemplates": "Protocol templates → append as copies",
  "set.exportControls": "Control canvas (all pages, cards, scripts)",
  "set.importControls": "Control canvas → import as new page",
  "set.exportCommands": "Command library (tree + scripts)",
  "set.importCommands": "Command library → merge",
  "set.ioHint": "Files are JSON with kind/version validation; share or back up freely.",
};

export function getLocale(): Locale {
  try {
    const s = JSON.parse(localStorage.getItem("vs.settings") ?? "{}") as { locale?: Locale };
    return s.locale === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function t(key: string): string {
  const loc = getLocale();
  return (loc === "en" ? en[key] : zh[key]) ?? zh[key] ?? key;
}
