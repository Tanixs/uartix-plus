/**
 * P104-B7 首启欢迎轮播（一次性）。
 *
 * 形态是用户 2026-09-24 定的：两张卡（概念管线 + 标注版真实截图）、图下几颗透明小圆点、
 * 圆点下方配文字介绍，对标现代手机 UI。**不是** v1 那张常驻起始面卡。
 *
 * 三条落点纪律（详设 §6）：
 *  - portal 到 `body`（浮层一律如此），所以键盘**不能**用 React 合成事件——
 *    portal 出来的节点住在 React 根之外，`onKeyDown` 挂在遮罩上不会响（B9 实测撞过），
 *    这里统一走 `window` 捕获。
 *  - 它不是 dockview 面板：不加 `PanelId`、不进序列化、不动 20 面板计数那条测试。
 *  - 徽标是 DOM 不是像素：文字能被 i18n 门看见，坐标能被 `welcome.test.ts` 钉住。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tx, useLocale } from "../i18n/strings";
import { Glyph, IconFrameSpec, IconLanes, IconMonitor, IconPlug } from "../shared/icons";
import { PIPELINE_NODES, WELCOME_SLIDES, type WelcomeSlide } from "./welcomeSlides";
import shotLight from "../assets/welcome/proto-light.png";
import shotDark from "../assets/welcome/proto-dark.png";

export interface WelcomeProps {
  /** 主题族（暗色族用暗色底图；九套主题只有两套底图，详设 §8） */
  dark: boolean;
  /** 起始第几张卡。dev 取证入口 `?welcome=N` 给的值，生产恒 0 */
  initial?: number;
  onStartTour: () => void;
  onRunDemo: () => void;
  onDismiss: () => void;
}

/** 卡 1 的管线：四个节点 + 箭头，全部 DOM。画成 SVG 就得自己抄一份图标路径（第二出处）。 */
const PIPE_ICONS = {
  plug: <IconPlug />,
  frame: <IconFrameSpec />,
  lanes: <IconLanes />,
  monitor: <IconMonitor />,
};

function Pipeline() {
  return (
    <div className="wlc-pipe" role="img" aria-label={tx("数据管线示意：字节流 → 筛帧 → 字段 → 用它", "Pipeline: bytes, frames, fields, use")}>
      {PIPELINE_NODES.map((n, i) => (
        <div key={n.zh} className="wlc-pipe-row">
          {i > 0 && (
            <div className="wlc-arrow" aria-hidden="true">
              <Glyph>
                <path d="M5 12h14M13 6l6 6-6 6" />
              </Glyph>
            </div>
          )}
          <div className="wlc-node">
            <span className="wlc-node-n">{i + 1}</span>
            <span className="wlc-node-i">{PIPE_ICONS[n.icon]}</span>
            <span className="wlc-node-t">{tx(n.zh, n.en)}</span>
            <span className="wlc-node-s">{tx(n.subZh, n.subEn)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 卡 2：真实截图 + 按比例定位的编号徽标。 */
function AnnotatedShot({ slide, dark }: { slide: WelcomeSlide; dark: boolean }) {
  return (
    <div className="wlc-shotbox">
      <img
        className="wlc-shot"
        src={dark ? shotDark : shotLight}
        alt={tx("Uartix+ 主界面截图", "Screenshot of the Uartix+ main window")}
        draggable={false}
      />
      {slide.badges?.map((b) => (
        <span
          key={b.n}
          className="wlc-badge"
          style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%` }}
          aria-hidden="true"
        >
          {b.n}
        </span>
      ))}
    </div>
  );
}

export function Welcome({ dark, initial = 0, onStartTour, onRunDemo, onDismiss }: WelcomeProps) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const [idx, setIdx] = useState(() =>
    Math.min(Math.max(0, Math.trunc(initial)), WELCOME_SLIDES.length - 1),
  );
  const primaryRef = useRef<HTMLButtonElement>(null);
  const last = WELCOME_SLIDES.length - 1;

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      } else if (e.key === "ArrowRight") setIdx((i) => Math.min(last, i + 1));
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
    };
    // 捕获：本组件 portal 在 React 根之外，合成事件到不了这里
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [last, onDismiss]);

  const slide = WELCOME_SLIDES[idx];

  return createPortal(
    <div className="wlc-mask">
      <div className="wlc" role="dialog" aria-modal="true" aria-label={tx("欢迎使用 Uartix+", "Welcome to Uartix+")}>
        <button
          type="button"
          className="btn icon-btn wlc-x"
          title={tx("关闭（不再显示）", "Close (don't show again)")}
          aria-label={tx("关闭", "Close")}
          onClick={onDismiss}
        >
          <Glyph>
            <path d="M18 6 6 18M6 6l12 12" />
          </Glyph>
        </button>

        <div className="wlc-body">
          {slide.id === "pipeline" ? <Pipeline /> : <AnnotatedShot slide={slide} dark={dark} />}
        </div>

        <div className="wlc-dots" role="tablist" aria-label={tx("切换介绍页", "Switch slide")}>
          {WELCOME_SLIDES.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              className={`wlc-dot${i === idx ? " on" : ""}`}
              aria-selected={i === idx}
              aria-label={tx(s.title.zh, s.title.en)}
              onClick={() => setIdx(i)}
            />
          ))}
        </div>

        <div className="wlc-copy">
          <h2 className="wlc-h">{tx(slide.title.zh, slide.title.en)}</h2>
          <ol className="wlc-leads">
            {slide.leads.map((l, i) => (
              <li key={i} className="wlc-lead">
                <span className="wlc-lead-n" aria-hidden="true">{i + 1}</span>
                <span>{tx(l.zh, l.en)}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* 快捷键是**壳**的事，不是某一张卡的事：挂在卡 2 下面会让两张卡差出一行高，
            点圆点时卡片跟着跳——定高舞台白定了。 */}
        <p className="wlc-hint">
          <kbd>Ctrl+Shift+P</kbd>{tx(" 命令面板 · ", " command palette · ")}
          <kbd>Ctrl+K</kbd>{tx(" AI 助手", " AI assistant")}
        </p>

        <div className="wlc-cta">
          <button ref={primaryRef} type="button" className="btn primary" onClick={onStartTour}>
            {tx("跟着走一遍", "Take the tour")}
          </button>
          <button type="button" className="btn" onClick={onRunDemo}>
            {tx("跑演示源看看", "Run the demo")}
          </button>
          <button type="button" className="btn ghost" onClick={onDismiss}>
            {tx("先不用", "Skip")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
