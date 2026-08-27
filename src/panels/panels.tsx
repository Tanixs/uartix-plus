import { memo } from "react";
import type { PanelId } from "../ipc/types";
import { ConsolePanel } from "../features/console/ConsolePanel";
import { HexView } from "../features/hexview/HexView";
import { TemplatesPanel } from "../features/protocol/TemplatesPanel";
import { PropertiesPanel } from "../features/protocol/PropertiesPanel";
import { DataTable } from "../features/table/DataTable";
import { Plot2D } from "../features/plot/Plot2D";
import { View3D } from "../features/attitude/View3D";
import { ControlCanvas } from "../features/controls/ControlCanvas";
import FrameCanvas from "../features/framecanvas/FrameCanvas";

export const PANEL_TITLES: Record<PanelId, string> = {
  hexview: "Hex 数据流",
  console: "控制台",
  templates: "协议模板",
  properties: "属性",
  controls: "控制画布",
  table: "数据表格",
  plot2d: "2D 曲线",
  view3d: "3D 姿态",
  framecanvas: "帧画布",
};

const MTemplates = memo(TemplatesPanel);
const MHexView = memo(HexView);
const MProperties = memo(PropertiesPanel);
const MControls = memo(ControlCanvas);
const MConsole = memo(ConsolePanel);
const MTable = memo(DataTable);
const MPlot2D = memo(Plot2D);
const MView3D = memo(View3D);
const MFrameCanvas = memo(FrameCanvas);

export const panelComponents = {
  templates: () => <MTemplates />,
  hexview: () => <MHexView />,
  properties: () => <MProperties />,
  controls: () => <MControls />,
  console: () => <MConsole />,
  table: () => <MTable />,
  plot2d: () => <MPlot2D />,
  view3d: () => <MView3D />,
  framecanvas: () => <MFrameCanvas />,
  placeholder: () => (
    <div className="ph">
      <div className="ph-card">
        <div className="ph-title">空显示区</div>
        <div className="ph-desc">
          将面板页签拖入此处，或用工具栏「+ 面板」填充内容；不需要时点页签 × 移除。
        </div>
      </div>
    </div>
  ),
};
