import { memo, useEffect, useRef } from "react";
import type { EmbedCard } from "../features/controls/controlsStore";
import { CardFrame, type CardFrameProps } from "../features/controls/CardViews";
import { EMBED_PANEL_MIN, embedPanelName } from "../features/controls/embedPanels";
import { HexView } from "../features/hexview/HexView";
import { Plot2D } from "../features/plot/Plot2D";
import { tx, useLocale } from "../i18n/strings";
import * as panelActivity from "./panelActivity";
import { rectsOverlap } from "./embedVisibility";
import { primePanelView } from "./viewState";

/**
 * memo 在这里是必需的：控制画布任何一个卡片补丁都会重渲染整页，
 * 而 uPlot / Hex canvas 的重渲染要从头走一遍 React 树。宿主切换时只该挂一次。
 */
const MPlot2D = memo(Plot2D);
const MHexView = memo(HexView);

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
        panelActivity.setEmbeddedCardVisible(card.id, visible);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      panelActivity.clearEmbeddedCardVisibility(card.id);
    };
  }, [card.id]);

  const min = EMBED_PANEL_MIN[card.panelId];
  return (
    <CardFrame {...props} card={card} dragHandleOnly>
      <div className="ctl-embed">
        <div className="ctl-embed-head" data-embed-head>
          <span className="ctl-embed-title">{card.name}</span>
          <span className="ctl-embed-meta">{embedPanelName(card.panelId)}</span>
          <span
            className="ctl-embed-min"
            title={tx(
              `最小 ${min.w}×${min.h} 格，拖右下角调整大小`,
              `Minimum ${min.w}×${min.h} cells; drag the bottom-right corner to resize`,
            )}
          >
            ≥{min.w}×{min.h}
          </span>
        </div>
        <div className="ctl-embed-body" ref={bodyRef}>
          {card.panelId === "plot2d" ? <MPlot2D /> : <MHexView />}
        </div>
      </div>
    </CardFrame>
  );
}
