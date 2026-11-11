import { memo, useEffect, useRef, useState } from "react";
import type { EmbedCard } from "../features/controls/controlsStore";
import { CardFrame, type CardFrameProps } from "../features/controls/CardViews";
import {
  embedMinOf,
  embedName,
  hasPointerLock,
  parsePluginEmbedId,
} from "../features/controls/embedPanels";
import { AttitudeModelView } from "../features/attitude/AttitudeModelView";
import { TrajectoryView } from "../features/plot3d/TrajectoryView";
import { HexView } from "../features/hexview/HexView";
import { Plot2D } from "../features/plot/Plot2D";
import { DataTable } from "../features/table/DataTable";
import { SpectrumPanel } from "../features/plot/SpectrumPanel";
import { XRayPanel } from "../features/xray/XRayPanel";
import { SequencerPanel } from "../features/sequencer/SequencerPanel";
import { SendBuildPanel } from "../features/send/SendBuildPanel";
import { SentinelPanel } from "../features/sentinel/SentinelPanel";
import FrameCanvas from "../features/framecanvas/FrameCanvas";
import { PluginViewPanel } from "../features/plugins/engine/PluginViewPanel";
import { IconLock, IconUnlock } from "../shared/icons";
import { tx, useLocale } from "../i18n/strings";
import * as panelActivity from "./panelActivity";
import { rectsOverlap } from "./embedVisibility";
import { primePanelView } from "./viewState";

/**
 * memo 在这里是必需的：控制画布任何一个卡片补丁都会重渲染整页，
 * 而 uPlot / Hex canvas / 姿态模型的重建要从头走一遍 React 树与 WebGL 上下文。
 * 宿主切换时只该挂一次。
 */
const MPlot2D = memo(Plot2D);
const MHexView = memo(HexView);
const MDataTable = memo(DataTable);
const MXRayPanel = memo(XRayPanel);
const MSpectrumPanel = memo(SpectrumPanel);
const MSequencer = memo(SequencerPanel);
const MSendBuild = memo(SendBuildPanel);
const MSentinel = memo(SentinelPanel);
const MFrameCanvas = memo(FrameCanvas);
const MAttitudeView = memo(AttitudeModelView);
const MTrajectoryView = memo(TrajectoryView);
/** 插件面板自己管 iframe/消息桥/续租；memo 只是不跟着整页补丁重建 iframe。 */
const MPluginView = memo(PluginViewPanel);

export interface EmbedCardViewProps extends Omit<CardFrameProps, "card" | "children"> {
  card: EmbedCard;
}

/**
 * 画布内嵌卡片的宿主。
 *
 * 两件事只在这里做：
 * 1. 把 whitelist 里的面板组件真正挂进卡片（此前 renderCard 走到 embed 是空分支，卡片等于死图）；
 * 2. 用 rAF 比较卡片 rect 与 `.ctl-grid` 视口，把"滚出去了"同步给 panelActivity。
 *
 * 可见性不订阅任何 store，也不在循环里分配对象：每 6 帧（约 100ms）读一次布局，
 * 布尔值变化才写 registry。面板组件自己再按 `panelActivity.isVisible()` 决定画不画。
 */
export function EmbedCardView(props: EmbedCardViewProps) {
  useLocale(); // 标题与最小尺寸提示都是 tx()，切语言要有人重渲染
  const { card } = props;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const primedRef = useRef(false);
  // 视图形态的指针交互（旋转/平移/缩放）默认开启；锁上之后拖卡片、滚页面都不会误转视角。
  // 只影响视图形态：2D/Hex 的平移与滚动本来就是用户意图。
  const [locked, setLocked] = useState(false);
  // 只有带指针相机的 3D 视图需要"锁定交互"；哨兵/帧画布是普通数据视图。
  const canLock = hasPointerLock(card.panelId);

  // 卡片里存着上次的视野（切页/重启后仍在）。预置必须发生在子组件注册 adapter 之前，
  // 所以放在 render 阶段的一次性初始化里；已有 pending（刚 capture）时 prime 不覆盖。
  if (!primedRef.current) {
    primedRef.current = true;
    primePanelView(card.panelId, card.viewState);
  }

  useEffect(() => {
    let raf = 0;
    let frame = 0;
    // 初始按"可见"记：新卡先画一帧，第一轮判定再纠正；这样不会因为 rAF 晚到而白屏。
    let last = true;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (frame++ % 6 !== 0) return;
      const body = bodyRef.current;
      const view = body?.closest(".ctl-grid");
      if (!body || !view) return;
      const visible = rectsOverlap(
        body.getBoundingClientRect(),
        view.getBoundingClientRect(),
      );
      if (visible !== last) {
        last = visible;
        // 必须用 panelId：registry 的 embedded 集合由 setEmbeddedPanels(panelId) 建立，
        // 此前传 card.id 的 uuid 永远对不上，滚出视口从未真正生效。
        panelActivity.setEmbeddedCardVisible(card.panelId, visible);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      panelActivity.clearEmbeddedCardVisibility(card.panelId);
    };
  }, [card.panelId]);

  const min = embedMinOf(card.panelId);
  // 插件面板：卡片 id 就是它的停靠 id `plugin-view-<插件>:<面板>`，拆出参数交给 iframe 宿主。
  const pluginPanel = parsePluginEmbedId(card.panelId);
  return (
    <CardFrame {...props} card={card} dragHandleOnly>
      <div className="ctl-embed">
        <div className="ctl-embed-head" data-embed-head>
          <span className="ctl-embed-title">{card.name}</span>
          <span className="ctl-embed-meta">{embedName(card.panelId)}</span>
          <span
            className="ctl-embed-min"
            title={tx(
              `最小 ${min.w}×${min.h} 格，拖右下角调整大小`,
              `Minimum ${min.w}×${min.h} cells; drag the bottom-right corner to resize`,
            )}
          >
            ≥{min.w}×{min.h}
          </span>
          {canLock && (
            <button
              className="ctl-embed-lock"
              title={
                locked
                  ? tx(
                      "解锁：恢复左键旋转 / 右键平移 / 滚轮缩放",
                      "Unlock: restore drag-rotate / right-drag-pan / wheel-zoom",
                    )
                  : tx(
                      "锁定交互：拖动卡片时不误转视角",
                      "Lock interaction so dragging the card cannot rotate the view",
                    )
              }
              aria-pressed={locked}
              onClick={() => setLocked((v) => !v)}
            >
              {locked ? <IconLock /> : <IconUnlock />}
            </button>
          )}
        </div>
        <div className="ctl-embed-body" ref={bodyRef}>
          {card.panelId === "plot2d" ? (
            <MPlot2D />
          ) : card.panelId === "hexview" ? (
            <MHexView />
          ) : card.panelId === "datatable" ? (
            <MDataTable />
          ) : card.panelId === "xray" ? (
            <MXRayPanel />
          ) : card.panelId === "spectrum" ? (
            <MSpectrumPanel />
          ) : card.panelId === "sequencer" ? (
            <MSequencer />
          ) : card.panelId === "sendbuild" ? (
            <MSendBuild />
          ) : card.panelId === "sentinel" ? (
            <MSentinel embedded />
          ) : card.panelId === "framecanvas" ? (
            <MFrameCanvas />
          ) : card.panelId === "attitude3d" ? (
            <MAttitudeView locked={locked} />
          ) : card.panelId === "trajectory3d" ? (
            <MTrajectoryView locked={locked} />
          ) : pluginPanel ? (
            // bare：卡片自己的标题栏已经写了名字，不要让 iframe 再长一个面板头。
            <MPluginView
              bare
              params={{ pluginId: pluginPanel.pluginId, panelId: pluginPanel.panelId }}
            />
          ) : (
            <MTrajectoryView locked={locked} />
          )}
        </div>
      </div>
    </CardFrame>
  );
}
