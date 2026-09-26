import { useSyncExternalStore } from "react";
import { IconFrameSpec, IconLayoutEdit, IconPlug, IconSlider, IconStack, IconTerminal } from "../shared/icons";
import { tx, useLocale } from "../i18n/strings";
import { railPanel, subscribeRail, toggleRailPanel, type RailKey } from "./railState";
import { RailPanel, type RailActions } from "./RailPanel";

/**
 * P104-R 左侧导轨（48px）+ 二级面板（300px）。
 *
 * 分界线：**库在左，视图在中间画布**。导轨上每一项是一个"库"，点开在右侧展开二级面板；
 * 再点同一项收起。上次开着哪项会记住（常驻）。
 *
 * 这套交互不是新发明：控制画布里的 `sideTab` 抽屉（控件库 / 命令库两个 Tab、再点收起）
 * 已经用了一年多，本文件只是把它从面板里升到壳层、给它几个目的地。
 * R3 起那两个 Tab 的内容真的搬过来了，抽屉本身连状态一起删除。
 *
 * 图标是**借的**现有图标，B12 会按 28 命中/16 字形/1.5 描边统一重画一整套。
 */
const railItems = (): { key: RailKey; label: string; tip: string; icon: () => React.ReactNode }[] => [
  { key: "link", label: tx("接入", "Link"), tip: tx("接口与链路参数（串口 / TCP / UDP / BLE）", "Interface and link parameters (serial / TCP / UDP / BLE)"), icon: () => <IconPlug /> },
  { key: "templates", label: tx("协议", "Protocol"), tip: tx("协议模板与帧型树", "Protocol templates and frame-type tree"), icon: () => <IconFrameSpec /> },
  { key: "widgets", label: tx("控件", "Widgets"), tip: tx("控件库：拖到控制画布上摆放", "Widget gallery: drag onto the control canvas"), icon: () => <IconSlider /> },
  { key: "commands", label: tx("命令", "Commands"), tip: tx("命令库：分组树、脚本与插值", "Command library: groups, scripts and interpolation"), icon: () => <IconTerminal /> },
  { key: "views", label: tx("视图", "Views"), tip: tx("打开/聚焦面板、布局与编辑布局", "Open and focus panels, layouts, layout editing"), icon: () => <IconStack /> },
];

export function SideRail({ actions }: { actions: RailActions }) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const open = useSyncExternalStore(subscribeRail, railPanel);

  return (
    <>
      <nav className="rail2" aria-label={tx("工作区", "Workspaces")}>
        {railItems().map((it) => (
          <button
            key={it.key}
            type="button"
            className={`rail2-btn${open === it.key ? " on" : ""}${it.key === "views" && actions.editLayout ? " act" : ""}`}
            aria-expanded={open === it.key}
            title={it.label + " · " + it.tip}
            onClick={() => toggleRailPanel(it.key)}
          >
            {it.icon()}
            <span className="rail2-label">{it.label}</span>
          </button>
        ))}
        <span className="rail2-spacer" />
        {/* 编辑布局的开关位在「视图」项上（它才是"看什么"的那一节），这里只给状态点 */}
        {actions.editLayout && (
          <span className="rail2-editing" title={tx("正在编辑显示区布局", "Editing the area layout")}>
            <IconLayoutEdit />
          </span>
        )}
      </nav>
      <RailPanel actions={actions} />
    </>
  );
}
