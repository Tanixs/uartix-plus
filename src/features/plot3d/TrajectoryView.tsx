import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as plotStore from "../plot/plotStore";
import * as plot3dStore from "./plot3dStore";
import * as panelActivity from "../../panels/panelActivity";
import { attachViewWheelGuard } from "../../panels/viewQuality";
import { useSettings } from "../settings/settingsStore";
import { tx } from "../../i18n/strings";
import { createScene, type Plot3DScene } from "./scene";
import {
  nextQuality,
  pixelRatioFor,
  renderFpsCapOf,
  type QualityLevel,
} from "./trajectoryViewQuality";

export interface TrajectoryViewProps {
  /** 锁定后 OrbitControls 不接管指针：卡片拖动/页面滚动不会被误转视角。 */
  locked?: boolean;
}

/** 容器宽度分档（spec §14.8）：HUD / 轴标签 / 图例逐级收敛，绝不叠放 */
type ChromeLevel = 0 | 1 | 2;

function chromeOf(width: number): ChromeLevel {
  if (width >= 300) return 0;
  if (width >= 220) return 1;
  return 2;
}

function accentColor(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
    "#4e9cef"
  );
}

/**
 * 画布内嵌 3D 轨迹**视图**：只画轨迹那一块（画布 + 轴标签 + 最小 HUD），
 * 不挂停靠面板的组托盘 / 时间条 / 统计栏 / 右键菜单。
 *
 * 与 `Plot3D` 的分工：
 * - 渲染、双层 LOD、配色、归一化全部复用 `scene.ts`，这里只做编排，不复制第二套；
 * - 数据只订阅 `plotStore`（通道）与 `plot3dStore`（组配置），后者走**第二 sink**
 *   与停靠面板并列消费同一批数据，不另开泵；
 * - 可见性由宿主 rAF 判定 + `scene` 的 `isVisible` 门控，不可见时整帧跳过；
 * - 每实例一个 WebGL 上下文，实例上限与降级阶梯见 `trajectoryViewQuality.ts`。
 */
export function TrajectoryView({ locked = false }: TrajectoryViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Plot3DScene | null>(null);
  const lockedRef = useRef(locked);
  const levelRef = useRef<QualityLevel>(0);
  const chromeRef = useRef<ChromeLevel>(0);
  const [ready, setReady] = useState(false);
  const [gen, setGen] = useState(0);
  const [themeTick, setThemeTick] = useState(0);
  const [chrome, setChrome] = useState<ChromeLevel>(0);

  const settings = useSettings();
  const zoomRef = useRef(settings.zoom);
  zoomRef.current = settings.zoom;
  lockedRef.current = locked;

  const p3d = useSyncExternalStore(plot3dStore.subscribe, plot3dStore.getSnapshot);
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  const plotRef = useRef(plot);
  plotRef.current = plot;
  const s3dRef = useRef(p3d.settings);
  s3dRef.current = p3d.settings;
  const cbSafe = settings.chartPalette === "cbSafe";
  const cbSafeRef = useRef(cbSafe);
  cbSafeRef.current = cbSafe;

  /** 像素比与渲染上限帧率都由当前档位决定；界面缩放变化也要重算（dpr × zf） */
  const applyQuality = (s: Plot3DScene, level: QualityLevel) => {
    const zf = (zoomRef.current || 100) / 100;
    s.setPixelRatio(pixelRatioFor(window.devicePixelRatio || 1, zf, level));
    s.setFpsCap(renderFpsCapOf(level));
  };

  useEffect(() => {
    const s = sceneRef.current;
    if (s) applyQuality(s, levelRef.current);
  }, [settings.zoom]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.setInteractionsEnabled(!locked);
  }, [locked]);

  // 主题切换：只重读 CSS 变量，不重建场景、不重置相机
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    sceneRef.current?.applyTheme();
  }, [themeTick]);

  // 场景创建/重建（context lost → gen+1）。只在挂载与重建时跑，日常设置变化走下面的 effect。
  useEffect(() => {
    let disposed = false;
    let scene: Plot3DScene | null = null;
    let detachWheel: () => void = () => {};
    (async () => {
      const host = hostRef.current;
      if (!host) return;
      const s = await createScene(host, {
        onContextLost: () => setGen((g) => g + 1),
        isVisible: () => panelActivity.isVisible("trajectory3d"),
      });
      if (disposed) {
        s.dispose();
        return;
      }
      scene = s;
      sceneRef.current = s;
      s.applySettings(
        s3dRef.current,
        plotRef.current.channels,
        cbSafeRef.current,
        accentColor(),
      );
      s.setAutoRotate(s3dRef.current.autoRotate);
      s.setFollow(s3dRef.current.follow);
      s.setAxisLabelsVisible(chromeRef.current === 0);
      s.setInteractionsEnabled(!lockedRef.current);
      applyQuality(s, levelRef.current);
      // 与停靠面板并列的消费端：后挂时 store 会重灌保留历史
      plot3dStore.setViewSink((entries, cursorSec) => s.applyBatch(entries, cursorSec));
      plot3dStore.invalidateCursor();
      detachWheel = attachViewWheelGuard(host, () => lockedRef.current);
      setReady(true);
    })();
    return () => {
      disposed = true;
      detachWheel();
      plot3dStore.setViewSink(null);
      plot3dStore.invalidateCursor();
      scene?.dispose();
      sceneRef.current = null;
      setReady(false);
    };
  }, [gen]);

  // 组配置/通道/色弱/主题 → 场景。通道用签名做依赖：plotStore 快照 10Hz 刷新会换数组身份
  const chansSig = plot.channels.map((c) => `${c.id}:${c.name}`).join("|");
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.applySettings(
      s3dRef.current,
      plotRef.current.channels,
      cbSafe,
      accentColor(),
    );
  }, [ready, p3d.settings, chansSig, cbSafe, themeTick]);

  useEffect(() => {
    if (ready) sceneRef.current?.setAutoRotate(p3d.settings.autoRotate);
  }, [ready, p3d.settings.autoRotate]);

  useEffect(() => {
    if (ready) sceneRef.current?.setFollow(p3d.settings.follow);
  }, [ready, p3d.settings.follow]);

  // 容器宽度分档：只在跨档时写一次，避免每帧读布局
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const sync = () => {
      const next = chromeOf(el.clientWidth);
      if (next === chromeRef.current) return;
      chromeRef.current = next;
      setChrome(next);
      sceneRef.current?.setAxisLabelsVisible(next === 0);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 1s 采一次 fps 走阶梯；不可见时跳过并重置窗口（避免离屏 0fps 误降级）
  useEffect(() => {
    if (!ready) return;
    let levelAt = performance.now();
    let skipNext = true;
    const id = setInterval(() => {
      const s = sceneRef.current;
      if (!s) return;
      if (!panelActivity.isVisible("trajectory3d")) {
        skipNext = true;
        return;
      }
      if (skipNext) {
        skipNext = false;
        levelAt = performance.now();
        return;
      }
      const st = s.stats();
      const next = nextQuality(levelRef.current, {
        fps: st.fps,
        msInLevel: performance.now() - levelAt,
      });
      if (next !== levelRef.current) {
        levelRef.current = next;
        levelAt = performance.now();
        applyQuality(s, next);
      }
      if (hudRef.current) {
        let pts = 0;
        for (const k in st.groups) pts += st.groups[k].tail + st.groups[k].overview;
        hudRef.current.textContent = `${st.fps} fps · ${fmtCount(pts)}`;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [ready]);

  const groups = p3d.settings.groups.filter((g) => g.visible && g.chX && g.chY);
  const hasData = groups.length > 0;

  return (
    <div
      className="tv-root"
      ref={rootRef}
      data-chrome={String(chrome)}
      data-locked={locked ? "1" : "0"}
      data-ready={ready ? "1" : "0"}
    >
      <div className="tv-canvas" ref={hostRef} />
      {hasData && (
        <div className="tv-legend" aria-hidden="true">
          {groups.map((g) => (
            <span className="tv-legend-item" key={g.id}>
              <i className="tv-dot" style={{ background: g.color }} />
              <span className="tv-legend-name">{g.name}</span>
            </span>
          ))}
        </div>
      )}
      <div className="tv-hud" ref={hudRef} aria-hidden="true" />
      {!hasData && (
        <div className="tv-empty">
          {tx("未绑定通道：在 3D 轨迹面板里为组绑定 X/Y", "No channels: bind X/Y in the 3D trajectory panel")}
        </div>
      )}
    </div>
  );
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(n);
}
