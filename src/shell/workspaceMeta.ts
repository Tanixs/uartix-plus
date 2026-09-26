import { t } from "../i18n/strings";
import type { WorkspacePreset } from "../features/settings/settingsStore";

/**
 * 九套工作区预设的显示名与一句话说明（设置页的预设卡与命令条的工作区药丸共用这一份）。
 *
 * 为什么是**函数**而不是数组：它此前是 `SettingsModal.tsx` 里的模块级 `const PRESETS`，
 * 里面调 `t()` —— 模块求值时就把文案钉死了，切语言不重开窗口，这九张卡的字不会跟着变。
 * 与 `PANEL_TITLES()` 同款：渲染期取值。
 *
 * 为什么搬出 SettingsModal：命令条要在工作区药丸上显示同一组名字，
 * 抄一份就是第二真值（历史上"改名批漏扫抄本"就是这么翻车的）。
 */
export const WORKSPACE_META = (): {
  key: WorkspacePreset;
  label: string;
  desc: string;
}[] => [
  { key: "proto", label: t("set.preset.proto"), desc: t("set.preset.proto.desc") },
  { key: "analyze", label: t("set.preset.analyze"), desc: t("set.preset.analyze.desc") },
  { key: "attitude", label: t("set.preset.attitude"), desc: t("set.preset.attitude.desc") },
  { key: "console", label: t("set.preset.console"), desc: t("set.preset.console.desc") },
  { key: "video", label: t("set.preset.video"), desc: t("set.preset.video.desc") },
  { key: "calib", label: t("set.preset.calib"), desc: t("set.preset.calib.desc") },
  { key: "auto", label: t("set.preset.auto"), desc: t("set.preset.auto.desc") },
  { key: "modbus", label: t("set.preset.modbus"), desc: t("set.preset.modbus.desc") },
  { key: "vdev", label: t("set.preset.vdev"), desc: t("set.preset.vdev.desc") },
];

export const workspaceMetaOf = (k: WorkspacePreset) =>
  WORKSPACE_META().find((m) => m.key === k);
