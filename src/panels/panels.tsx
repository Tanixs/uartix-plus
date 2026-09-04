import { memo } from "react";
import type { PanelId } from "../ipc/types";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { getLocale, tx, useLocale } from "../i18n/strings";
import { getExt } from "../features/ai/extensionStore";
import { ConsolePanel } from "../features/console/ConsolePanel";
import { HexView } from "../features/hexview/HexView";
import { TemplatesPanel } from "../features/protocol/TemplatesPanel";
import { PropertiesPanel } from "../features/protocol/PropertiesPanel";
import { DataTable } from "../features/table/DataTable";
import { Plot2D } from "../features/plot/Plot2D";
import { View3D } from "../features/attitude/View3D";
import { ControlCanvas } from "../features/controls/ControlCanvas";
import FrameCanvas from "../features/framecanvas/FrameCanvas";
import { VideoLink } from "../features/video/VideoLink";
import { AiChat } from "../features/ai/AiChat";
import { ExtPanelHost } from "../features/ai/ExtPanel";

/** 面板页签名（语言感知，P33 i18n）；页签重挂靠 App 的 retitlePanels（locale 变化时 setTitle） */
export const PANEL_TITLES = (): Record<PanelId, string> => {
  const en = getLocale() === "en";
  const pick = (zh: string, eng: string) => (en ? eng : zh);
  return {
    hexview: pick("Hex 数据流", "Hex Stream"),
    console: pick("控制台", "Console"),
    templates: pick("协议模板", "Templates"),
    properties: pick("属性", "Properties"),
    controls: pick("控制画布", "Controls"),
    table: pick("数据表格", "Data Table"),
    plot2d: pick("2D 曲线", "2D Plot"),
    view3d: pick("3D 姿态", "3D Attitude"),
    framecanvas: pick("帧画布", "Frame Canvas"),
    video: pick("图传", "Video Link"),
    ai: pick("AI 助手", "AI Assistant"),
  };
};

/** 任意面板 id → 页签标题：内置面板查表；AI 扩展面板用扩展名（用户数据不翻译） */
export function panelTitleOf(id: string): string {
  if (id.startsWith("ext-panel-")) {
    const ext = getExt(id.slice("ext-panel-".length));
    return ext?.name ?? (getLocale() === "en" ? "AI Panel" : "AI 面板");
  }
  return PANEL_TITLES()[id as PanelId] ?? id;
}

const MTemplates = memo(TemplatesPanel);
const MHexView = memo(HexView);
const MProperties = memo(PropertiesPanel);
const MControls = memo(ControlCanvas);
const MConsole = memo(ConsolePanel);
const MTable = memo(DataTable);
const MPlot2D = memo(Plot2D);
const MView3D = memo(View3D);
const MFrameCanvas = memo(FrameCanvas);
const MVideo = memo(VideoLink);
const MAi = memo(AiChat);

export const panelComponents = {
  templates: () => (
    <ErrorBoundary label={panelTitleOf("templates")}>
      <MTemplates />
    </ErrorBoundary>
  ),
  hexview: () => (
    <ErrorBoundary label={panelTitleOf("hexview")}>
      <MHexView />
    </ErrorBoundary>
  ),
  properties: () => (
    <ErrorBoundary label={panelTitleOf("properties")}>
      <MProperties />
    </ErrorBoundary>
  ),
  controls: () => (
    <ErrorBoundary label={panelTitleOf("controls")}>
      <MControls />
    </ErrorBoundary>
  ),
  console: () => (
    <ErrorBoundary label={panelTitleOf("console")}>
      <MConsole />
    </ErrorBoundary>
  ),
  table: () => (
    <ErrorBoundary label={panelTitleOf("table")}>
      <MTable />
    </ErrorBoundary>
  ),
  plot2d: () => (
    <ErrorBoundary label={panelTitleOf("plot2d")}>
      <MPlot2D />
    </ErrorBoundary>
  ),
  view3d: () => (
    <ErrorBoundary label={panelTitleOf("view3d")}>
      <MView3D />
    </ErrorBoundary>
  ),
  framecanvas: () => (
    <ErrorBoundary label={panelTitleOf("framecanvas")}>
      <MFrameCanvas />
    </ErrorBoundary>
  ),
  video: () => (
    <ErrorBoundary label={panelTitleOf("video")}>
      <MVideo />
    </ErrorBoundary>
  ),
  ai: () => (
    <ErrorBoundary label={panelTitleOf("ai")}>
      <MAi />
    </ErrorBoundary>
  ),
  aiExtPanel: (props: { params?: { extId?: string } }) => (
    <ErrorBoundary label={panelTitleOf(`ext-panel-${props.params?.extId ?? ""}`)}>
      <ExtPanelHost extId={props.params?.extId ?? ""} />
    </ErrorBoundary>
  ),
  placeholder: () => (
    <PlaceholderPanel />
  ),
};

function PlaceholderPanel() {
  useLocale();
  return (
    <div className="ph">
      <div className="ph-card">
        <div className="ph-title">{tx("空显示区", "Empty area")}</div>
        <div className="ph-desc">
          {tx(
            "将面板页签拖入此处，或用工具栏「+ 面板」填充内容；不需要时点页签 × 移除。",
            "Drag panel tabs in here, or use “+ Panel” in the toolbar to fill it; click × on a tab to remove it when not needed.",
          )}
        </div>
      </div>
    </div>
  );
}
