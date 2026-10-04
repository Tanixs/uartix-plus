// P104-B1 默认布局生成器；B13 在此续写新拓扑与 v3 迁移。详见 applyDefaultLayout 上方注释。
import type { DockviewApi } from "dockview-react";
import type { WorkspacePreset } from "../features/settings/settingsStore";
import { logicalViewport } from "../shared/zoom";

/**
 * 壳占掉的尺寸（**逻辑 CSS px**），默认布局要从视口里先扣掉它们再分配。
 *
 * 为什么必须扣：dockview 的网格不是整窗。B5 之前只有横向没扣（当时顶栏不占横向），
 * 加了 48px 导轨后若不扣，`leftW + midW + rightW` 就比网格实际宽度多出 48px，
 * templates 会被挤掉这 48px —— 与 B1 修掉的那笔「分母没除缩放」是同一个形状的错误。
 * 竖向同理：命令条与信息栏都在网格外面。
 *
 * 这四个数与 theme.css 里的 `.rail2{flex:0 0 48px}` / `.rail-panel{flex:0 0 300px}` /
 * `.ibar{flex:0 0 38px}` / `.tbar{flex:0 0 34px}` / `.statusbar{flex:0 0 28px}`
 * 是同一件事的两处写法（CSS 拿不到 TS 常量）。改这里必须同时改那里——
 * `defaultLayout.test.ts` 会逐条比对，漂了直接判红。
 */
export const SHELL_CHROME = {
  railW: 48,
  /** R2：身份栏（品牌 / 系统入口 / 窗口控件） */
  barH: 38,
  /** R2：工具栏（工作区预设 + 链路 / 会话 / 面板三段） */
  toolH: 34,
  infoH: 28,
  /** R 二级面板：展开 300 / 收起 0（两态都要过布局不变量） */
  railPanelW: 300,
} as const;

/** 网格（dockview 那块画布）的可用尺寸 = 整窗逻辑尺寸扣掉壳。
 *
 *  两处要算它：`applyDefaultLayout` 排初始拓扑，App 在导轨开合后拿
 *  `api.layout()` 强制重排（dockview 自己的 ResizeObserver 绑在渲染帧上，
 *  页面被遮挡时不发，B8 实测撞到过）。各写一遍就是两个真值——改一条横栏
 *  的高度只会中一处，另一处就悄悄错位。本函数是唯一实现。 */
export function gridSize(railPanelW = 0, stripW: number = SHELL_CHROME.railW): { w: number; h: number } {
  const vp = logicalViewport();
  return {
    // P145：导轨条可以整体收起，那 48px 就还给画布——默认值仍是满条，
    // 所以不传第二个参数的调用方（含全部既有测试）行为一字不变。
    w: vp.w - stripW - railPanelW,
    h: vp.h - SHELL_CHROME.barH - SHELL_CHROME.toolH - SHELL_CHROME.infoH,
  };
}

/** 主区与右栏的绝对下限（逻辑 px）。`applyDefaultLayout` 与下面的
 *  `railPanelMaxAvailable` 用的是同一对数 —— 上限要是抄出来的，改下限就没人记得改上限。 */
const MID_MIN = 480;
const RIGHT_MIN = 260;

/**
 * P105-D：二级面板**此刻**最多能占多宽（逻辑 px）。
 *
 * 为什么不是一个常数：导轨可以拖宽，但拖到把画布挤没就本末倒置了 ——
 * 网格至少要剩"主区下限 + 右栏下限"，否则 dockview 会把面板压到工具条点不到
 * （P3 那批实测过的形状）。1100 逻辑 px 的最小窗里，这个值是
 * `1100 − 48 − 740 = 312`，而不是写死的 460。
 */
export function railPanelMaxAvailable(): number {
  return logicalViewport().w - SHELL_CHROME.railW - (MID_MIN + RIGHT_MIN);
}

/**
 * P104-B1：默认停靠拓扑生成器。从 App.tsx 抽出来只为一件事——它能被读、能被测。
 * 取标题函数由调用方注入：panels.tsx 急加载全部面板组件，直接 import 会把整个应用拖进测试环境。
 *
 * 除下面这一处外，函数体与抽出前**逐字相同**：
 * 视口分母改用 logicalViewport()。dockview 的 initialWidth 最终写进 style.width，
 * 是**逻辑 CSS px**；而 window.innerWidth 不随 CSS zoom 变。二者不同源，
 * 影响只在 Math.max(绝对下限, ...) 的钳制真正生效时才显形（小窗口 / 高缩放）。
 *
 * 记一笔被推翻的假设：审计曾判"四处 midW + rightW 超配一整个右栏、templates 被挤到
 * minimumWidth 200"，据此改成 midW —— 实测直接反证：改后 templates 反而拿到 649/1319。
 * dockview 的语义是"新面板从参考面板切走 initialWidth，其余归参考"，
 * 所以主区给 midW+rightW 时 templates 才恰剩 leftW，随后右栏再从主区切走 rightW。
 * 原写法是对的，已逐字还原。
 */
export function applyDefaultLayout(
  api: DockviewApi,
  preset: WorkspacePreset,
  titleOf: (id: string) => string,
  /** R：二级面板占掉的宽度（逻辑 px，在导轨与画布之间）。由调用方按当前展开态传进来，
   *  本模块不读 store——否则这条纯布局文件会被 React 依赖拖进测试环境。 */
  railPanelW = 0,
  /** P145：活动导轨条当下占的宽度（收起时传 0）。默认满条，既有调用方行为不变。 */
  stripW: number = SHELL_CHROME.railW,
) {
  const { w, h } = gridSize(railPanelW, stripW);
  const leftW = Math.max(240, Math.round(w * 0.25));
  const rightW = Math.max(RIGHT_MIN, Math.round(w * 0.25));
  const midW = Math.max(MID_MIN, w - rightW);
  const bottomH = Math.round(h * 0.5);
  const bottomColW = Math.max(280, Math.round(midW / 2));

  /* P104-R5：`templates` 不再是每个预设的第一块。
     协议模板搬进导轨「接入 / 协议」之后，左列只是把它在画布里再摆一份——
     而这一列正是三列下限之和（240+480+260=980）撑破 971px 网格的那一位。
     去掉它：主区从 `w - leftW - rightW` 变成 `w - rightW`，八个预设一致。
     `auto` 保持三列（序列器/编排器/哨兵是三个并列的工作台，不是"库 + 画布"），
     它用的是 `leftW`，见下。 */

  if (preset === "console") {
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: titleOf("hexview"),
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: titleOf("console"),
      initialHeight: Math.round(h * 0.4),
      minimumHeight: 140,
      position: { referencePanel: "hexview", direction: "below" },
    });
    api.addPanel({
      id: "controls",
      component: "controls",
      title: titleOf("controls"),
      initialWidth: rightW,
      minimumWidth: 230,
      position: { referencePanel: "hexview", direction: "right" },
    });
    api.getPanel("hexview")?.api.setActive();
    return;
  }

  if (preset === "video") {
    api.addPanel({
      id: "video",
      component: "video",
      title: titleOf("video"),
    });
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: titleOf("hexview"),
      initialHeight: Math.round(h * 0.35),
      minimumHeight: 140,
      position: { referencePanel: "video", direction: "below" },
    });
    api.addPanel({
      id: "properties",
      component: "properties",
      title: titleOf("properties"),
      initialWidth: rightW,
      minimumWidth: 230,
      position: { referencePanel: "video", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: titleOf("console"),
      initialHeight: Math.round(h * 0.3),
      minimumHeight: 120,
      position: { referencePanel: "properties", direction: "below" },
    });
    api.getPanel("video")?.api.setActive();
    return;
  }

  if (preset === "calib") {
    // 3D 校准（P82③）：3D 轨迹主视 + 帧画布堆叠，右侧 2D 曲线看原始通道，底部控制台
    api.addPanel({
      id: "plot3d",
      component: "plot3d",
      title: titleOf("plot3d"),
    });
    api.addPanel({
      id: "framecanvas",
      component: "framecanvas",
      title: titleOf("framecanvas"),
      position: { referencePanel: "plot3d", direction: "within" },
    });
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: titleOf("plot2d"),
      initialWidth: rightW,
      minimumWidth: 240,
      position: { referencePanel: "plot3d", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: titleOf("console"),
      initialHeight: bottomH,
      minimumHeight: 120,
      position: { referencePanel: "plot3d", direction: "below" },
    });
    api.getPanel("plot3d")?.api.setActive();
    return;
  }

  if (preset === "auto") {
    // 自动化（P82③）：编排器居中，序列器左、哨兵右，底部曲线+控制台——无模板锚点（自动化场景协议已就绪）
    api.addPanel({
      id: "sequencer",
      component: "sequencer",
      title: titleOf("sequencer"),
      initialWidth: leftW,
      minimumWidth: 260,
    });
    api.addPanel({
      id: "orchestrator",
      component: "orchestrator",
      title: titleOf("orchestrator"),
      initialWidth: midW,
      position: { referencePanel: "sequencer", direction: "right" },
    });
    api.addPanel({
      id: "sentinel",
      component: "sentinel",
      title: titleOf("sentinel"),
      initialWidth: rightW,
      minimumWidth: 240,
      position: { referencePanel: "orchestrator", direction: "right" },
    });
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: titleOf("plot2d"),
      initialHeight: bottomH,
      minimumHeight: 140,
      position: { referencePanel: "orchestrator", direction: "below" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: titleOf("console"),
      position: { referencePanel: "plot2d", direction: "within" },
    });
    api.getPanel("orchestrator")?.api.setActive();
    return;
  }

  if (preset === "modbus") {
    // 工业 Modbus（P82③）：工作台居中，右侧指令工厂所在控制台，底部 Hex + 表格
    api.addPanel({
      id: "modbus",
      component: "modbus",
      title: titleOf("modbus"),
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: titleOf("console"),
      initialWidth: rightW,
      minimumWidth: 260,
      position: { referencePanel: "modbus", direction: "right" },
    });
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: titleOf("hexview"),
      initialHeight: bottomH,
      minimumHeight: 120,
      position: { referencePanel: "modbus", direction: "below" },
    });
    api.addPanel({
      id: "table",
      component: "table",
      title: titleOf("table"),
      position: { referencePanel: "hexview", direction: "right" },
    });
    api.getPanel("modbus")?.api.setActive();
    return;
  }

  if (preset === "vdev") {
    // 虚拟设备（P82③）：工坊居中，右侧曲线即时观察，底部帧画布 + 控制台
    api.addPanel({
      id: "vdev",
      component: "vdev",
      title: titleOf("vdev"),
    });
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: titleOf("plot2d"),
      initialWidth: rightW,
      minimumWidth: 240,
      position: { referencePanel: "vdev", direction: "right" },
    });
    api.addPanel({
      id: "framecanvas",
      component: "framecanvas",
      title: titleOf("framecanvas"),
      initialHeight: bottomH,
      minimumHeight: 120,
      position: { referencePanel: "vdev", direction: "below" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: titleOf("console"),
      position: { referencePanel: "framecanvas", direction: "right" },
    });
    api.getPanel("vdev")?.api.setActive();
    return;
  }

  const centerPanels =
    preset === "analyze"
      ? (["plot2d", "hexview", "console"] as const)
      : (["framecanvas", "hexview", "console"] as const);

  const first = centerPanels[0];
  api.addPanel({
    id: first,
    component: first,
    title: titleOf(first),
  });
  for (let i = 1; i < centerPanels.length; i++) {
    api.addPanel({
      id: centerPanels[i],
      component: centerPanels[i],
      title: titleOf(centerPanels[i]),
      position: { referencePanel: first, direction: "within" },
    });
  }
  if (preset === "attitude") {
    api.addPanel({
      id: "view3d",
      component: "view3d",
      title: titleOf("view3d"),
      position: { referencePanel: first, direction: "within" },
    });
  }
  api.addPanel({
    id: "properties",
    component: "properties",
    title: titleOf("properties"),
    initialWidth: rightW,
    minimumWidth: 230,
    minimumHeight: 260,
    position: { referencePanel: first, direction: "right" },
  });
  api.addPanel({
    id: "table",
    component: "table",
    title: titleOf("table"),
    initialHeight: bottomH,
    minimumHeight: 140,
    position: { referencePanel: first, direction: "below" },
  });
  if (preset !== "analyze") {
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: titleOf("plot2d"),
      initialWidth: bottomColW,
      minimumWidth: 240,
      position: { referencePanel: "table", direction: "right" },
    });
  }
  if (preset === "analyze") {
    // P82③：分析预设右下从 3D 姿态换成频谱——与 2D 共享通道，"分析"主题更聚焦
    api.addPanel({
      id: "spectrum",
      component: "spectrum",
      title: titleOf("spectrum"),
      initialWidth: bottomColW,
      minimumWidth: 240,
      position: { referencePanel: "plot2d", direction: "right" },
    });
  }
  api.addPanel({
    id: "controls",
    component: "controls",
    title: titleOf("controls"),
    initialHeight: bottomH,
    minimumHeight: 120,
    position: { referencePanel: "properties", direction: "below" },
  });
  api.getPanel(first)?.api.setActive();
}
