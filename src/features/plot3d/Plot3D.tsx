/**
 * P69 3D 轨迹面板组件（T1）。
 *
 * 职责边界：本组件只做 UI 编排——
 * - 数据在 plot3dStore（120ms 泵 + 时间水位续传），渲染在 scene.ts（双层 LOD）；
 * - HUD：左上三轴绑定（与 2D 共享图例通道）、右上视角组、右下统计、左下测量气泡；
 * - 右键菜单：视图 / 测量 / 数据 / 设置 四组（Flyout 级联，复用全站 ctx-* 规范）；
 * - 长按测距：400ms + 位移 6px 双阈值防误触；Esc 退出；双击聚焦悬停点/重置视角；
 * - 高频路径（悬停 tooltip、长按判定）直写 DOM/ref，绝不走 React state——
 *   拾取/移动 60Hz 进 state 会把 HUD 拖进重渲染风暴。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import * as plotStore from "../plot/plotStore";
import * as plot3dStore from "./plot3dStore";
import * as sessionStore from "../session/sessionStore";
import type { PickResult, Plot3DScene, ViewPreset } from "./scene";
import { createScene } from "./scene";
import { fitEllipsoid, grade, FIT_MIN_POINTS, type FitOk } from "./ellipsoidFit";
import { buildPairedTriples } from "./pairTriples";
import { useSettings } from "../settings/settingsStore";
import { useOperator } from "../operator/operatorStore";
import { toast } from "../ai/extRuntime";
import { Flyout } from "../../shared/Flyout";
import { IconCheck, IconChevron, IconCircle, IconClose, IconCrosshair, IconDot, IconLock, IconPlay, IconRotate, IconTarget } from "../../shared/icons";
import { fmtVal } from "../plot/plotMeasure";
import { tx, useLocale } from "../../i18n/strings";

/** 轴显示色：与 scene 轴线配色一致（X 红 / Y 绿 / Z 蓝，RViz 惯例） */
const AX_COLOR = { x: "#e05252", y: "#4caf50", z: "#4e9cef" } as const;
/** 测量强调色：与 scene 测量线一致 */
const MEASURE_COLOR = "#e8a13c";

/** 补偿预览迷你图逻辑尺寸（CSS px；canvas 属性固定 2×，P73 §2.2） */
const SPARK_W = 224;
const SPARK_H = 54;

/** 加计六面采集顺序（详设 §4.1 固定）：该面朝上静止 2s */
const A6_FACES = [
  { zh: "+X 朝上", en: "+X up" },
  { zh: "−X 朝上", en: "−X up" },
  { zh: "+Y 朝上", en: "+Y up" },
  { zh: "−Y 朝上", en: "−Y up" },
  { zh: "+Z 朝上", en: "+Z up" },
  { zh: "−Z 朝上", en: "−Z up" },
] as const;

type MenuSub = "style" | "fade" | "color" | "density" | "pair" | "tol" | "ascale" | null;

/** 相对秒短标签（34s / 5m / 1.2h）——与 2D fmtTickSec 同款语义，本地小函数不做跨文件抽象 */
const fmtTickSec = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 7200) return `${+(v / 3600).toFixed(1)}h`;
  if (a >= 150) return `${Math.round(v / 60)}m`;
  return `${Math.round(v * 10) / 10}s`;
};

/** 拟合失败原因（按错误码出双语；无码的历史文案回退中文 reason） */
function fitErrText(r: { reason: string; code?: string; p?: (number | string)[] }): string {
  const p = r.p ?? [];
  switch (r.code) {
    case "few":
      return tx(`采样点数不足（${p[0]}/${p[1]}），请继续翻滚传感器采样`, `Not enough samples (${p[0]}/${p[1]}) — keep tumbling the sensor`);
    case "octants":
      return tx("象限覆盖不足：点云集中在部分空间区域，请绕各轴翻滚一圈（画 8 字）覆盖全部象限后重试", "Poor quadrant coverage — tumble around every axis (figure-8) and retry");
    case "coincident":
      return tx("采样点重合，无法拟合（请检查数据是否在变化）", "Samples coincide; cannot fit (is the data changing?)");
    case "singular":
      return tx("采样覆盖不足：点分布近乎共面或集中在半球，请让传感器在空间各方向充分翻滚后重试", "Degenerate coverage (near-coplanar or hemisphere) — tumble fully and retry");
    case "solveFail":
    case "kNonPos":
      return tx("采样覆盖不足：请让传感器在空间各方向充分翻滚后重试", "Poor coverage — tumble the sensor in all directions and retry");
    case "hyperboloid":
      return tx("采样覆盖不足：点云分布无法构成封闭椭球，请全方位翻滚后重试", "Points cannot form a closed ellipsoid — tumble fully and retry");
    case "cigar":
      return tx("采样覆盖不足：椭球过度细长（旋转平面缺失），请绕各轴都翻滚一圈后重试", "Ellipsoid too slender (rotation plane missing) — tumble around every axis");
    case "oneSide":
      return tx("采样覆盖不足：某主轴方向只采样了单侧，请继续翻滚补齐对侧后重试", "One side of a principal axis is missing — cover the other side and retry");
    case "facesIncomplete":
      return tx("六面数据不完整（需要 +X/-X/+Y/-Y/+Z/-Z 六面各采一次）", "Six faces incomplete (+X/-X/+Y/-Y/+Z/-Z each needed)");
    case "faceFew":
      return tx(`面 ${Number(p[0]) + 1} 样本不足（${p[1]}/${p[2]}），请重新采集该面`, `Face ${Number(p[0]) + 1} has too few samples (${p[1]}/${p[2]}) — recapture it`);
    case "zeroDiff":
      return tx("两面均值差≈0：请检查采集顺序（+X 与 −X 是否摆对）", "Opposite faces differ by ~0 — check face order (+X vs −X)");
    case "axisOrder":
      return tx(`${["X", "Y", "Z"][Number(p[0])]} 轴两面均值差异常（+面应大于 −面）：疑似采集顺序错或传感器异常，请核对后重采`, `${["X", "Y", "Z"][Number(p[0])]} axis faces look inverted (+ should exceed −) — check order or sensor`);
    case "sigma":
      return tx(`面 ${Number(p[0]) + 1} 采集抖动过大（σ 超尺度均值 5%），请放稳后重采该面`, `Face ${Number(p[0]) + 1} too shaky (σ > 5% of scale) — hold still and recapture`);
    default:
      return r.reason;
  }
}

export function Plot3D() {
  useLocale(); // 语言切换重渲染（文案即时更新）
  const settings = useSettings();
  const zf = (settings.zoom || 100) / 100;
  const cbSafe = settings.chartPalette === "cbSafe";

  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Plot3DScene | null>(null);
  const plotRef = useRef(plotStore.getSnapshot());
  const s3dRef = useRef(plot3dStore.getSnapshot().settings);
  const zfRef = useRef(zf);
  zfRef.current = zf;

  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  plotRef.current = plot;
  const p3d = useSyncExternalStore(plot3dStore.subscribe, plot3dStore.getSnapshot);
  s3dRef.current = p3d.settings;
  const s3d = p3d.settings;

  /* C1：Operator 只读边界 —— 「配置类」设置（轴绑定/样式/密度/渐隐/着色/网格/键盘飞行…）锁定，
     视图与操作态（视角预设、自动旋转、跟随、缩放、测距、时间游标、清空轨迹、导出、椭球校准/六面）
     全部放行：只读不允许改部署口径，但必须允许看和测。store 层另有同等守卫兜底。 */
  const opLocked = useOperator().pkg !== null;
  const roTip = opLocked ? tx("（Operator 只读：设置已锁定）", " (operator read-only: settings locked)") : "";

  const [ready, setReady] = useState(false);
  const [gen, setGen] = useState(0); // WebGL context lost → +1 重建
  const [stats, setStats] = useState({ tail: 0, overview: 0, fps: 0 });
  // P75 B2：配对诊断（三轴值域 + 配对/跳过计数），1Hz 低频刷新
  const [pairInfo, setPairInfo] = useState<plot3dStore.PairStatSnapshot | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  // ---------- 右键菜单 ----------
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<MenuSub>(null);
  const [subPinned, setSubPinned] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const styleRowRef = useRef<HTMLDivElement | null>(null);
  const fadeRowRef = useRef<HTMLDivElement | null>(null);
  const colorRowRef = useRef<HTMLDivElement | null>(null);
  const densityRowRef = useRef<HTMLDivElement | null>(null);
  const pairRowRef = useRef<HTMLDivElement | null>(null);
  const tolRowRef = useRef<HTMLDivElement | null>(null);
  const ascaleRowRef = useRef<HTMLDivElement | null>(null);
  const subTimer = useRef<number | null>(null);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu !== null;

  // ---------- 悬停 / 测距（高频路径，ref 化） ----------
  const hoverRef = useRef<PickResult | null>(null);
  const lastMoveT = useRef(0);
  const ldownRef = useRef<{ x: number; y: number; moved: boolean; menuOpen: boolean } | null>(null);
  const rdownRef = useRef<{ x: number; y: number } | null>(null);
  const lpTimer = useRef<number | null>(null);
  const suppressUpRef = useRef(false);
  const [measureMode, setMeasureMode] = useState(false);
  const measureModeRef = useRef(false);
  const mPts = useRef<{ a: PickResult | null; b: PickResult | null }>({ a: null, b: null });
  const [measureInfo, setMeasureInfo] = useState<{ a: PickResult; b: PickResult | null } | null>(null);

  // ---------- 椭球校准（P71）：拟合结果/错误为低频 state；采样计数 500ms 轮询 ----------
  const [fit, setFit] = useState<FitOk | null>(null);
  const fitRef = useRef<FitOk | null>(null);
  fitRef.current = fit;
  const [fitErr, setFitErr] = useState<string | null>(null);
  const [fitStale, setFitStale] = useState(false);
  const fitStaleRef = useRef(false);
  fitStaleRef.current = fitStale;
  const [calibUi, setCalibUi] = useState({ capturing: false, count: 0, coverage: 0 });
  const calSentRef = useRef(0); // 已推送 scene 的点数水位（缓冲清空 → 归零重推）
  /** P74c A5：场景重建后待重放的校准态（线框/显示模式）——必须在点云重新灌入之后应用 */
  const calReplayRef = useRef(false);

  // ---------- 校准 T+（P73）：子页 / 显示切换 / 预览迷你图 / 六面向导 ----------
  const [calibTab, setCalibTab] = useState<"ellipsoid" | "six">("ellipsoid");
  const [calibDisp, setCalibDisp] = useState<"raw" | "corrected">("raw");
  const calibDispRef = useRef<"raw" | "corrected">("raw");
  calibDispRef.current = calibDisp;
  const [previewOn, setPreviewOn] = useState(false);
  const [a6, setA6] = useState<plot3dStore.Accel6Snapshot | null>(null);
  const sparkRef = useRef<HTMLCanvasElement>(null);
  const a6StartRef = useRef(0); // 采集面开始时刻（UI 侧秒表，仅倒计时显示用）
  const a6LastRef = useRef(-2); // 上一轮快照采集面（-2 = 未初始化）

  // ---------- 时间条（P70 T2）：高频路径全走 DOM/ref，不进 state ----------
  const tbTrackRef = useRef<HTMLDivElement>(null);
  const tbFillRef = useRef<HTMLDivElement>(null);
  const tbCurRef = useRef<HTMLDivElement>(null);
  const tbBubbleRef = useRef<HTMLDivElement>(null);
  const tbTRef = useRef<HTMLSpanElement>(null);
  const tbDragRef = useRef(false); // 非回放 scrub 拖动中
  const tbReplayDragRef = useRef(false); // 回放中拖动（节流 seek）
  const tbSeekT = useRef(0);
  const endRelRef = useRef(0); // 数据末端相对秒（渲染时刷新）
  const ptsRef = useRef(0); // br 行点数（DOM 写入时判断分隔符）

  // ---------- 场景生命周期 ----------
  // 区分「WebGL 重建」与「面板真正卸载」：清理顺序 = 声明顺序（本 effect 先于
  // gen-effect 声明），真卸载时本清理先行置 false；重建时 gen-effect 清理读到 true
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let scene: Plot3DScene | null = null;
    (async () => {
      const host = hostRef.current;
      if (!host) return;
      const s = await createScene(host, {
        onContextLost: () => setGen((g) => g + 1), // 触发整场景重建
        onToggleFollow: () =>
          plot3dStore.setSetting({ follow: !plot3dStore.getSnapshot().settings.follow }), // 键盘飞行 F 键（P72）
      });
      if (disposed) {
        s.dispose();
        return;
      }
      scene = s;
      sceneRef.current = s;
      plot3dStore.setSink((b, reloaded, cursorSec) => s.applyBatch(b, reloaded, cursorSec));
      // P74c A5：新场景是空的 → 点云推送水位归零 + 挂上「校准态重放」标记。
      // 否则重建后 snap.count 与水位相等，增量判定两个分支都不命中，
      // 出现「UI 有拟合结果、画布空点云」的假象。
      calSentRef.current = 0;
      calReplayRef.current = true;
      // 游标同理：静态/回放暂停时没有新批次，pump 不会重发 → 强制下一拍重发一次
      plot3dStore.invalidateCursor();
      setReady(true);
    })();
    return () => {
      disposed = true;
      // scrub 是 store 模块级视图态：不清掉，重开面板会落回上次的历史位置
      plot3dStore.setScrub(null);
      plot3dStore.invalidateCursor();
      // C8：重建只停泵保留校准（采样是几分钟的工作量，显卡抖一下不该全灭）；
      // 真卸载才丢缓冲 + 退校准会话（红线：关闭了的面板不许后台跑）
      const final = !aliveRef.current;
      plot3dStore.setSink(null, { keepCalib: !final });
      scene?.dispose();
      sceneRef.current = null;
      setReady(false);
      if (final) plot3dStore.endCalibSession();
    };
  }, [gen]);

  // 主题切换（data-theme 属性）→ 场景重新读 CSS 变量
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    sceneRef.current?.applyTheme();
  }, [themeTick]);

  // 设置/通道/色弱 → 应用到场景。通道用签名做依赖：plotStore 快照 10Hz 刷新
  // 会换 channels 数组身份，直接依赖会把 rebuildGrid 拖成 10Hz 风暴
  const chansSig = plot.channels.map((c) => `${c.id}:${c.name}`).join("|");
  useEffect(() => {
    if (!ready) return;
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
      "#4e9cef";
    sceneRef.current?.applySettings(
      s3dRef.current,
      plotRef.current.channels,
      cbSafe,
      accent,
    );
  }, [ready, s3d, chansSig, cbSafe, themeTick]);

  // 1Hz 统计（点数/FPS/配对诊断）：低频 state，可接受
  useEffect(() => {
    if (!ready) return;
    const t = window.setInterval(() => {
      const st = sceneRef.current?.stats();
      if (st) setStats(st);
      setPairInfo(plot3dStore.pairSnapshot());
    }, 1000);
    return () => window.clearInterval(t);
  }, [ready]);

  // 跟随模式开关（P70 T2）：scene 侧 target 平滑锁定锚点；与 autoRotate 互斥已在 store 层联动
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setFollow(s3d.follow);
  }, [ready, s3d.follow]);

  // 校准模式开关（P71）：scene 切点云/轨迹层（退出零重建）；进入时退出测距（互斥）
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setCalibMode(s3d.calibMode);
    if (s3d.calibMode && measureModeRef.current) exitMeasure();
  }, [ready, s3d.calibMode]);

  // 键盘飞行开关（P72）：scene 侧挂/摘 window 按键监听（悬停画布才响应）
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setKeyFlight(s3d.keyFlight);
  }, [ready, s3d.keyFlight]);

  // 校准采样轮询（500ms 低频）：store 缓冲 → scene 点云增量推送；
  // 缓冲缩水（重灌签名变化/清空）→ 场景点云与拟合结果同步重置；
  // 同拍带出六面快照（P73 向导 UI）与采集倒计时锚点
  useEffect(() => {
    if (!ready || !s3d.calibMode) return;
    const poll = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const snap = plot3dStore.calibSnapshot();
      if (snap.count < calSentRef.current) {
        scene.resetCalibView();
        scene.setCalibEllipsoid(null);
        calSentRef.current = 0;
        setFit(null);
        setFitErr(null);
        setFitStale(false);
        setPreviewOn(false);
        setCalibDisp("raw");
      }
      if (snap.count > calSentRef.current) {
        scene.setCalibPoints(plot3dStore.calibPoints(), calSentRef.current);
        calSentRef.current = snap.count;
        if (fitRef.current && snap.count > fitRef.current.n) setFitStale(true);
      }
      // P74c A5：重建后的校准态重放——必须排在点云推送之后
      // （scene 的 applyCalibView 依赖 calCount > 0，否则线框会被判定为「无点云」而隐藏）
      if (calReplayRef.current) {
        calReplayRef.current = false;
        scene.setCalibEllipsoid(fitRef.current);
        scene.setCalibDisplay(calibDispRef.current);
      }
      setCalibUi(snap);
      const a6s = plot3dStore.accel6Snapshot();
      if (a6s.collecting) {
        if (a6s.idx !== a6LastRef.current) a6StartRef.current = performance.now();
      } else {
        a6StartRef.current = 0;
      }
      a6LastRef.current = a6s.collecting ? a6s.idx : -1;
      setA6(a6s);
    };
    poll();
    const t = window.setInterval(poll, 500);
    return () => window.clearInterval(t);
  }, [ready, s3d.calibMode]);

  // ---------- 测距模式 ----------
  const enterMeasure = () => {
    measureModeRef.current = true;
    setMeasureMode(true);
    mPts.current = { a: null, b: null };
    setMeasureInfo(null);
    sceneRef.current?.setMeasure(null, null);
  };
  const exitMeasure = () => {
    measureModeRef.current = false;
    setMeasureMode(false);
    mPts.current = { a: null, b: null };
    setMeasureInfo(null);
    sceneRef.current?.setMeasure(null, null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && measureModeRef.current) exitMeasure();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- 悬停 tooltip（直写 DOM，不进 state） ----------
  const hideTip = () => {
    const tip = tipRef.current;
    if (tip) tip.style.display = "none";
  };
  const showTip = (pr: PickResult) => {
    const host = hostRef.current;
    const tip = tipRef.current;
    if (!host || !tip) return;
    const hr = host.getBoundingClientRect();
    const z = zfRef.current || 1;
    const s = s3dRef.current;
    const chans = plotRef.current.channels;
    const nameOf = (id: string) => chans.find((c) => c.id === id)?.name ?? id;
    const lines = [
      `t = ${pr.tSec.toFixed(2)} s`,
      `X ${fmtVal(pr.real[0])}   Y ${fmtVal(pr.real[1])}   Z ${fmtVal(pr.real[2])}`,
    ];
    if (s.colorBy === "ch") lines.push(`${nameOf(s.colorCh)} = ${fmtVal(pr.val)}`);
    tip.textContent = lines.join("\n");
    tip.style.display = "block";
    const vx = pr.screen[0] - hr.left;
    const vy = pr.screen[1] - hr.top;
    let lx = vx / z + 14;
    let ly = vy / z + 12;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    if (lx + w > hr.width / z - 4) lx = vx / z - w - 12;
    if (ly + h > hr.height / z - 4) ly = vy / z - h - 10;
    tip.style.left = `${Math.max(2, lx)}px`;
    tip.style.top = `${Math.max(2, ly)}px`;
  };

  // ---------- 指针交互（长按测距 / 右键菜单 / 悬停拾取） ----------
  const onPointerDown = (e: React.PointerEvent) => {
    // HUD 控件（轴绑定下拉/按钮）不冒泡进画布：长按会误触测距、按住下拉 400ms 直接进测距模式
    if ((e.target as HTMLElement).closest(".p3d-hud")) return;
    hideTip();
    if (e.button === 0) {
      ldownRef.current = { x: e.clientX, y: e.clientY, moved: false, menuOpen: menuOpenRef.current };
      if (lpTimer.current !== null) window.clearTimeout(lpTimer.current);
      lpTimer.current = window.setTimeout(() => {
        lpTimer.current = null;
        if (ldownRef.current && !ldownRef.current.moved) {
          suppressUpRef.current = true; // 长按已消费本次按压，弹起不再放点
          if (!s3dRef.current.calibMode) enterMeasure(); // 校准模式下不进测距（互斥）
        }
      }, 400);
    } else if (e.button === 2) {
      rdownRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const ld = ldownRef.current;
    if (ld) {
      if (Math.hypot(e.clientX - ld.x, e.clientY - ld.y) > 6) {
        ld.moved = true;
        if (lpTimer.current !== null) {
          window.clearTimeout(lpTimer.current);
          lpTimer.current = null;
        }
      }
      if (ld.moved) return; // 拖拽中不拾取
    }
    if (e.buttons !== 0) return;
    const now = performance.now();
    if (now - lastMoveT.current < 30) return; // 30ms 节流
    lastMoveT.current = now;
    const pr = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
    hoverRef.current = pr;
    if (pr) showTip(pr);
    else hideTip();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button === 0) {
      if (lpTimer.current !== null) {
        window.clearTimeout(lpTimer.current);
        lpTimer.current = null;
      }
      const ld = ldownRef.current;
      ldownRef.current = null;
      const wasSuppress = suppressUpRef.current;
      suppressUpRef.current = false;
      if (
        measureModeRef.current &&
        ld &&
        !ld.moved &&
        !wasSuppress &&
        !ld.menuOpen
      ) {
        const pr = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
        if (!pr) return; // 未命中轨迹点：保持等待
        if (!mPts.current.a) {
          mPts.current.a = pr;
          setMeasureInfo({ a: pr, b: null });
        } else {
          const a = mPts.current.a;
          sceneRef.current?.setMeasure(a, pr);
          setMeasureInfo({ a, b: pr });
          mPts.current = { a: null, b: null }; // 下一次点击开始新测量
        }
      }
    } else if (e.button === 2) {
      rdownRef.current = null;
    }
  };

  const onPointerLeave = () => {
    hideTip();
    hoverRef.current = null;
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rd = rdownRef.current;
    rdownRef.current = null;
    if (rd && Math.hypot(e.clientX - rd.x, e.clientY - rd.y) < 6) {
      setSub(null);
      setSubPinned(false);
      setMenu({ x: e.clientX, y: e.clientY });
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".p3d-hud")) return; // 双击 HUD 按钮（拟合/停止等）不该触发相机动作
    if (measureModeRef.current) return;
    const pr = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
    if (pr) sceneRef.current?.focusPoint(pr.real);
    else sceneRef.current?.resetView();
  };

  // ---------- 时间条（P70 T2）：非回放 scrub / 回放真 seek；进度直写 DOM（10Hz 红线） ----------
  /** 回放时钟 → 相对秒（与泵的游标映射一致：firstTs+posMs 对齐 timeOrigin，clamp 防御） */
  const sessionRelSec = (): number | null => {
    const s = sessionStore.getSnapshot();
    if ((s.state !== "playing" && s.state !== "paused") || s.firstTs <= 0) return null;
    const rel = (s.firstTs + s.posMs - plotStore.timeOrigin()) / 1000;
    return Math.min(Math.max(rel, 0), endRelRef.current);
  };
  const writeTb = (ratio: number, bubble: boolean) => {
    const r = Math.min(Math.max(ratio, 0), 1);
    const pct = `${r * 100}%`;
    if (tbFillRef.current) tbFillRef.current.style.width = pct;
    if (tbCurRef.current) tbCurRef.current.style.left = pct;
    const bub = tbBubbleRef.current;
    if (!bub) return;
    if (bubble) {
      bub.textContent = fmtTickSec(r * endRelRef.current);
      bub.style.left = pct;
      bub.style.display = "block";
    } else {
      bub.style.display = "none";
    }
  };
  const writeBrT = (relSec: number | null) => {
    const el = tbTRef.current;
    if (!el) return;
    el.textContent =
      relSec !== null
        ? `${ptsRef.current > 0 ? " · " : ""}t = ${fmtTickSec(relSec)}`
        : "";
  };
  const clearScrub = () => {
    plot3dStore.setScrub(null);
    sceneRef.current?.setTimeCursor(null);
    writeTb(1, false);
    writeBrT(null);
  };
  /** clientX → 轨道比例（ratio 无量纲，天然免疫 zoom，无需补偿） */
  const tbRatio = (clientX: number): number => {
    const track = tbTrackRef.current;
    if (!track) return 0;
    const r = track.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
  };
  const applyScrub = (ratio: number) => {
    const rel = ratio * endRelRef.current;
    sceneRef.current?.setTimeCursor(rel);
    plot3dStore.setScrub(rel);
    writeTb(ratio, true);
    writeBrT(rel);
  };
  const tbSeek = (ratio: number) => {
    const s = sessionStore.getSnapshot();
    const sp = typeof s.lastSpeed === "number" && s.lastSpeed >= 0 ? s.lastSpeed : 1; // 0=MAX 全速，不能 || 吞掉
    void sessionStore.seek(ratio, sp);
  };
  const onTbPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation(); // 不触发画布长按/拾取/右键
    if (e.button !== 0) return;
    const track = tbTrackRef.current;
    if (!track) return;
    const s = sessionStore.getSnapshot();
    const replaying = s.state === "playing" || s.state === "paused";
    const ratio = tbRatio(e.clientX);
    if (replaying) {
      // 回放中：真时间机器 seek（hex 环复位 + 全面板同步倒带，3D 经重灌+游标自动跟随）
      track.setPointerCapture(e.pointerId);
      tbReplayDragRef.current = true;
      tbSeekT.current = performance.now();
      tbSeek(ratio);
      return;
    }
    track.setPointerCapture(e.pointerId);
    tbDragRef.current = true;
    applyScrub(ratio);
  };
  const onTbPointerMove = (e: React.PointerEvent) => {
    if (tbDragRef.current) {
      e.stopPropagation();
      applyScrub(tbRatio(e.clientX));
      return;
    }
    if (tbReplayDragRef.current) {
      e.stopPropagation();
      const now = performance.now();
      if (now - tbSeekT.current > 150) {
        tbSeekT.current = now;
        tbSeek(tbRatio(e.clientX));
      }
    }
  };
  const onTbPointerUp = (e: React.PointerEvent) => {
    if (tbDragRef.current) {
      e.stopPropagation();
      tbDragRef.current = false;
      const bub = tbBubbleRef.current;
      if (bub) bub.style.display = "none"; // 松手游标保留（查看历史意图明确）
    } else if (tbReplayDragRef.current) {
      e.stopPropagation();
      tbReplayDragRef.current = false;
      tbSeek(tbRatio(e.clientX)); // 收尾 seek 到最终位置
    }
  };
  const onTbDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = sessionStore.getSnapshot();
    if (s.state === "playing" || s.state === "paused") return; // 回放中无 scrub 语义
    clearScrub(); // 双击 = 回到最新
  };

  // 回放进度 / scrub 游标 → 直写 DOM（sessionStore 10Hz posMs 推送，绝不进 React state）
  useEffect(() => {
    const update = () => {
      const endRel = endRelRef.current;
      if (endRel <= 0 || !tbFillRef.current) return;
      const rel = sessionRelSec();
      if (rel !== null) {
        writeTb(rel / endRel, false);
        writeBrT(rel);
      } else {
        const c = plot3dStore.lastCursorSec();
        if (c === null) writeTb(1, false);
        else writeTb(Math.min(Math.max(c / endRel, 0), 1), false);
        writeBrT(c);
      }
    };
    update();
    return sessionStore.subscribe(update);
  }, []);

  // ---------- 菜单定位（zoom 补偿）与关闭闭环 ----------
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    const left = Math.max(8, Math.min(menu.x / zf, vw - w - 8));
    let top = menu.y / zf;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    setMenuPos({ left, top });
  }, [menu, zf]);

  const armSub = () => {
    if (subTimer.current !== null) window.clearTimeout(subTimer.current);
    subTimer.current = window.setTimeout(() => setSub(null), 250);
  };
  const disarmSub = () => {
    if (subTimer.current !== null) {
      window.clearTimeout(subTimer.current);
      subTimer.current = null;
    }
  };
  useEffect(
    () => () => {
      if (subTimer.current !== null) window.clearTimeout(subTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!menu) return;
    let t: number | null = null;
    const inEl = (el: Element | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
    };
    const insideAny = (x: number, y: number) => {
      if (inEl(menuRef.current, x, y)) return true;
      for (const el of Array.from(document.querySelectorAll(".ctx-flyout")))
        if (inEl(el, x, y)) return true;
      return false;
    };
    const closeAll = () => {
      setMenu(null);
      setSub(null);
      setSubPinned(false);
    };
    const onMove = (e: PointerEvent) => {
      if (insideAny(e.clientX, e.clientY)) {
        if (t !== null) {
          window.clearTimeout(t);
          t = null;
        }
        return;
      }
      if (t === null)
        t = window.setTimeout(() => {
          t = null;
          closeAll();
        }, 500);
    };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".ctx-menu")) return;
      closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", closeAll, true);
    return () => {
      if (t !== null) window.clearTimeout(t);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", closeAll, true);
    };
  }, [menu]);

  // ---------- 菜单动作 ----------
  const chanName = (id: string) => plot.channels.find((c) => c.id === id)?.name ?? id;
  const closeAnd = (fn: () => void) => () => {
    fn();
    setMenu(null);
    setSub(null);
    setSubPinned(false);
  };
  const copyHover = () => {
    const pr = hoverRef.current;
    if (!pr) return;
    const s = s3dRef.current;
    const parts = [
      `t=${pr.tSec.toFixed(3)}s`,
      `X=${fmtVal(pr.real[0])}`,
      `Y=${fmtVal(pr.real[1])}`,
      `Z=${fmtVal(pr.real[2])}`,
    ];
    if (s.colorBy === "ch") parts.push(`${chanName(s.colorCh)}=${fmtVal(pr.val)}`);
    void navigator.clipboard?.writeText(parts.join("  "));
  };

  // ---------- 椭球校准动作（P71 / P73 T+）----------
  const doFit = () => {
    const r = fitEllipsoid(plot3dStore.calibPoints());
    if (r.ok) {
      setFit(r);
      setFitStale(false);
      setFitErr(null);
      plot3dStore.setCalibFit(r); // 下沉 store：泵在线补偿预览 + scene 显示切换共用（P73）
      sceneRef.current?.setCalibEllipsoid(r);
    } else {
      setFitErr(fitErrText(r)); // 保留旧结果与线框，错误就地展示（详设 §3.2）
    }
  };
  const clearCalibAll = () => {
    plot3dStore.clearCalib();
    sceneRef.current?.resetCalibView();
    calSentRef.current = 0;
    setFit(null);
    setFitErr(null);
    setFitStale(false);
    setPreviewOn(false);
    setCalibDisp("raw");
  };
  const copyCalibJson = () => {
    const f = fitRef.current;
    if (!f) return;
    void navigator.clipboard?.writeText(
      JSON.stringify({ offset: f.offset, gains: f.gains, matrix: f.matrix, cv: f.cv, points: f.n }),
    );
  };
  const copyCalibC = () => {
    const f = fitRef.current;
    if (!f) return;
    const rows = f.matrix.map((r) => `{${r.join(", ")}}`).join(", ");
    void navigator.clipboard?.writeText(
      `float mag_offset[3] = {${f.offset.join(", ")}};\nfloat mag_matrix[3][3] = {${rows}};`,
    );
  };

  /** 子页切换（P73 §4.2）：椭球 ↔ 六面互清对方缓冲（数据语义不同，混采无意义）。
   *  对侧已有可观工作量（采样达标或已有拟合/已采面）时先确认，误点不再瞬间清空 */
  const switchCalibTab = (t: "ellipsoid" | "six") => {
    if (t === calibTab) return;
    const snap = plot3dStore.calibSnapshot();
    const a6s = plot3dStore.accel6Snapshot();
    const dropEllipsoid = t === "six" && (snap.count >= FIT_MIN_POINTS || !!fitRef.current);
    const dropSix = t === "ellipsoid" && a6s.faces.some(Boolean);
    if (dropEllipsoid || dropSix) {
      if (
        !window.confirm(
          tx(
            "切换子页会清空另一侧已采集的数据与结果（椭球点云 / 六面清单互不兼容），确定继续？",
            "Switching clears the other side's samples and results (ellipsoid cloud vs six-face data are incompatible). Continue?",
          ),
        )
      )
        return;
    }
    setCalibTab(t);
    if (t === "six") {
      clearCalibAll();
    } else {
      plot3dStore.accel6Reset();
    }
  };
  /** 点云显示切换：raw = 原始椭球+残差着色；corrected = 校正后球壳+参考球 */
  const switchCalibDisp = (m: "raw" | "corrected") => {
    setCalibDisp(m);
    sceneRef.current?.setCalibDisplay(m);
  };

  /** 退出校准模式：正在采样/六面采集先自动停止并告知（缓冲保留，重进可继续/清空） */
  const exitCalibMode = () => {
    const snap = plot3dStore.calibSnapshot();
    const a6s = plot3dStore.accel6Snapshot();
    if (snap.capturing) {
      plot3dStore.stopCalibCapture();
      toast(tx("已退出校准模式，椭球采样自动停止（已采数据保留）", "Left calibration mode; ellipsoid capture stopped (samples kept)"));
    } else if (a6s.collecting) {
      plot3dStore.accel6Abort();
      toast(tx("已退出校准模式，六面采集自动停止（已采面保留）", "Left calibration mode; six-face capture stopped (faces kept)"));
    }
    plot3dStore.setSetting({ calibMode: false });
  };

  // ---------- 补偿预览迷你图（P73）：10Hz canvas 直绘，不走 React state ----------
  const drawSpark = () => {
    const cvs = sparkRef.current;
    const ctx = cvs?.getContext("2d");
    if (!cvs || !ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0); // 画布属性固定 2×抗锯齿，CSS 尺寸 224×54
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#4e9cef";
    const dim = css.getPropertyValue("--text-dim").trim() || "#8a929e";
    const pv = plot3dStore.previewSnapshot();
    ctx.font = "10px ui-monospace, Consolas, monospace";
    if (!pv || pv.len < 2) {
      ctx.fillStyle = dim;
      ctx.textAlign = "center";
      ctx.fillText(tx("等待数据流…", "waiting for data…"), SPARK_W / 2, SPARK_H / 2 + 3);
      ctx.textAlign = "left";
      return;
    }
    const CAP = plot3dStore.PREVIEW_CAP;
    const n = pv.len;
    const mr = pv.meanR > 1e-12 ? pv.meanR : 1;
    let sum = 0;
    let sum2 = 0;
    let maxDev = 0;
    let lastK = 1;
    for (let i = 0; i < n; i++) {
      const k = pv.r[(pv.head - n + CAP + i + CAP) % CAP] / mr;
      sum += k;
      sum2 += k * k;
      const d = Math.abs(k - 1);
      if (d > maxDev) maxDev = d;
      lastK = k;
    }
    const mean = sum / n;
    const cv = mean > 0 ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) / mean : 0;
    // 纵窗至少 ±12%（保证 3%/8% 参考带可见），偏差爆表时自适应放大
    const band = Math.max(0.12, maxDev * 1.15);
    const padY = 3;
    const yOf = (k: number) => padY + ((1 + band - k) / (2 * band)) * (SPARK_H - 2 * padY);
    const bandRect = (k0: number, k1: number, fill: string) => {
      const lo = Math.max(k0, 1 - band);
      const hi = Math.min(k1, 1 + band);
      if (hi <= lo) return;
      ctx.fillStyle = fill;
      ctx.fillRect(0, yOf(hi), SPARK_W, yOf(lo) - yOf(hi));
    };
    bandRect(0.97, 1.03, "rgba(76,175,80,0.16)"); // ±3% 绿带（grade 优）
    bandRect(0.92, 0.97, "rgba(232,161,60,0.14)"); // 3–8% 黄带（grade 良）
    bandRect(1.03, 1.08, "rgba(232,161,60,0.14)");
    ctx.strokeStyle = dim; // 1.0 基线
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yOf(1));
    ctx.lineTo(SPARK_W, yOf(1));
    ctx.stroke();
    ctx.globalAlpha = 1;
    // 横轴 = 最近窗口实际时长（缓冲 t 自适应）；主线 accent，越界 ±8% 段红
    const i0 = (pv.head - n + CAP + CAP) % CAP;
    const t0 = pv.t[i0];
    const span = Math.max(pv.t[(pv.head - 1 + CAP) % CAP] - t0, 1e-6);
    const pt = (i: number): [number, number] => {
      const idx = (i0 + i) % CAP;
      return [(pv.t[idx] - t0) / span * (SPARK_W - 1), yOf(pv.r[idx] / mr)];
    };
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath(); // 越界段覆盖重绘
    let anyBad = false;
    for (let i = 1; i < n; i++) {
      const ka = pv.r[(i0 + i - 1) % CAP] / mr;
      const kb = pv.r[(i0 + i) % CAP] / mr;
      if (Math.abs(ka - 1) <= 0.08 && Math.abs(kb - 1) <= 0.08) continue;
      const a = pt(i - 1);
      const b = pt(i);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      anyBad = true;
    }
    if (anyBad) {
      ctx.strokeStyle = "#e5534b";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.fillStyle = dim; // 实时数字：当前偏差 + 窗口 CV
    ctx.textAlign = "right";
    ctx.fillText(
      `Δ ${((lastK - 1) * 100).toFixed(2)}% · CV ${(cv * 100).toFixed(2)}%`,
      SPARK_W - 4,
      SPARK_H - 4,
    );
    ctx.textAlign = "left";
  };
  useEffect(() => {
    if (!previewOn) return;
    const draw = () => {
      if (!fitStaleRef.current) drawSpark(); // 陈旧挂起：冻结最后一帧（灰显由 CSS 承担）
    };
    draw();
    const t = window.setInterval(draw, 100);
    return () => window.clearInterval(t);
  }, [previewOn]);

  // ---------- 加计六面（P73）：解算 / 复制 / 重置 ----------
  const a6Solve = () => {
    plot3dStore.accel6Solve(); // gRef=1：scale/gain 以「原始单位/g」计，offset 恒原始单位
    setA6(plot3dStore.accel6Snapshot()); // 结果（含拒绝原因）随快照回 UI
  };
  const a6ok = a6?.result && a6.result.ok ? a6.result : null;
  const copyAccel6C = () => {
    if (!a6ok) return;
    void navigator.clipboard?.writeText(
      `float acc_offset[3] = {${a6ok.offset.join(", ")}};\nfloat acc_gain[3] = {${a6ok.gains.join(", ")}};\n// a' = (a - offset) * gain ≈ 1g`,
    );
  };

  // ---------- 导出（P72）：轨迹 CSV / 快照 PNG ----------
  const exportCsv = async () => {
    const s = s3dRef.current;
    if (!s.axisX || !s.axisY || !s.axisZ) return;
    const chans = plotRef.current.channels;
    const nameOf = (id: string) => chans.find((c) => c.id === id)?.name ?? id;
    // P75 B2：与轨迹严格同源——按当前配对方式/容差从原始序列构建
    // （旧实现走联合对齐源，配对修复后两者不再一致）
    const pair = buildPairedTriples(
      plotStore.getChanData(s.axisX),
      plotStore.getChanData(s.axisY),
      plotStore.getChanData(s.axisZ),
      { mode: s.pairMode, tolMs: s.pairTolMs, sinceT: -Infinity },
    );
    const org = plotStore.timeOrigin();
    const esc = (v: string | number) => {
      const str = String(v);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const rows: string[] = [
      ["t_s", nameOf(s.axisX), nameOf(s.axisY), nameOf(s.axisZ)].map(esc).join(","),
    ];
    for (let i = 0; i < pair.t.length; i++) {
      rows.push(
        `${((pair.t[i] - org) / 1000).toFixed(3)},${pair.x[i]},${pair.y[i]},${pair.z[i]}`,
      );
    }
    if (rows.length <= 1) return; // 无轨迹点
    const path = await save({
      title: tx("导出轨迹 CSV", "Export trajectory CSV"),
      defaultPath: `trajectory-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-")}.csv`,
      filters: [{ name: "CSV 文件", extensions: ["csv"] }],
    });
    if (typeof path !== "string") return;
    try {
      await invoke("save_text_file", { path, content: "\uFEFF" + rows.join("\r\n") });
    } catch (e) {
      toast(tx(`轨迹 CSV 写盘失败：${String(e).slice(0, 80)}`, `Failed to write trajectory CSV: ${String(e).slice(0, 80)}`));
    }
  };
  const exportPng = async () => {
    const scene = sceneRef.current;
    if (!scene) return;
    const url = scene.snapshotPng(); // 先同步渲染取像素，再弹对话框（await 后画布会被清）
    const path = await save({
      title: tx("快照 PNG", "Snapshot PNG"),
      defaultPath: `p3d-snapshot-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-")}.png`,
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (typeof path !== "string") return;
    try {
      const bin = atob(url.slice(url.indexOf(",") + 1));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await invoke("save_binary_file", { path, content: Array.from(arr) });
    } catch (e) {
      toast(tx(`快照写盘失败：${String(e).slice(0, 80)}`, `Failed to write snapshot: ${String(e).slice(0, 80)}`));
    }
  };

  const presets: { p: ViewPreset; zh: string; en: string; tipZh: string; tipEn: string }[] = [
    { p: "top", zh: "俯", en: "T", tipZh: "俯视：看航迹/路径平面形状", tipEn: "Top view: plan-form shape" },
    { p: "side", zh: "侧", en: "S", tipZh: "侧视", tipEn: "Side view" },
    { p: "front", zh: "正", en: "F", tipZh: "正视", tipEn: "Front view" },
    { p: "iso", zh: "等", en: "I", tipZh: "等轴：立体全貌（默认）", tipEn: "Isometric: full 3D view (default)" },
  ];

  const allBound = !!(s3d.axisX && s3d.axisY && s3d.axisZ);
  const styleCur =
    s3d.style === "line+points"
      ? tx("线+点", "Line+points")
      : s3d.style === "line"
        ? tx("仅线", "Line")
        : tx("仅点", "Points");
  const fadeCur =
    s3d.fade === 0
      ? tx("全程", "Full span")
      : s3d.fade === 300
        ? tx("最近 5 分钟", "Last 5 min")
        : tx(`最近 ${s3d.fade}s`, `Last ${s3d.fade}s`);
  const colorCur =
    s3d.colorBy === "time" ? tx("按时间", "By time") : chanName(s3d.colorCh);
  const densityCur =
    s3d.density === "high" ? tx("高 1:1", "High 1:1") : s3d.density === "mid" ? tx("中 1:2", "Mid 1:2") : tx("低 1:4", "Low 1:4");
  // P75 B2：数据配对 / 三轴缩放
  const pairCur =
    s3d.pairMode === "interp"
      ? tx("插值配对", "Interpolated")
      : s3d.pairMode === "nearest"
        ? tx("最近邻配对", "Nearest")
        : tx("旧版前向填充", "Legacy fill");
  const tolCur = s3d.pairTolMs > 0 ? `${s3d.pairTolMs} ms` : tx("自动", "Auto");
  const ascaleCur =
    s3d.axisScale === "perAxis" ? tx("逐轴归一化", "Per-axis") : tx("等比（真实比例）", "Uniform");

  const totalPts = stats.tail + stats.overview;
  ptsRef.current = totalPts;

  // P75 B2：配对诊断副行（三轴值域 + 配对/跳过计数；union 模式额外提示阶梯口径）
  const fmtRange = (mn: number, mx: number) =>
    isFinite(mn) && isFinite(mx) ? `${fmtVal(mn)}~${fmtVal(mx)}` : "—";
  const pairLine =
    allBound && pairInfo && pairInfo.paired + pairInfo.skipped > 0
      ? [
          `X ${fmtRange(pairInfo.min[0], pairInfo.max[0])}`,
          `Y ${fmtRange(pairInfo.min[1], pairInfo.max[1])}`,
          `Z ${fmtRange(pairInfo.min[2], pairInfo.max[2])}`,
          tx(
            `配对 ${pairInfo.paired.toLocaleString()} · 跳过 ${pairInfo.skipped.toLocaleString()}`,
            `paired ${pairInfo.paired.toLocaleString()} · skipped ${pairInfo.skipped.toLocaleString()}`,
          ),
          s3d.pairMode === "union"
            ? tx("前向填充（旧版）", "forward-fill (legacy)")
            : s3d.pairTolMs > 0
              ? `±${s3d.pairTolMs}ms`
              : tx("自动容差", "auto tol"),
        ].join(" · ")
      : null;

  // 时间条数据范围：P75 B2 起与泵游标同口径——三轴绑定时的原始序列末端
  // （未绑齐时回退联合轴末端）；plot 10Hz 快照驱动重渲染，O(1) 读缓存首末
  const endRel = (() => {
    const org = plotStore.timeOrigin();
    if (s3d.axisX && s3d.axisY && s3d.axisZ) {
      let end = -Infinity;
      for (const id of [s3d.axisX, s3d.axisY, s3d.axisZ]) {
        const d = plotStore.getChanData(id);
        if (d.t.length > 0 && d.t[d.t.length - 1] > end) end = d.t[d.t.length - 1];
      }
      if (isFinite(end)) return Math.max(0, (end - org) / 1000);
    }
    const rawAll = plotStore.fullAlignedRaw();
    return rawAll.x.length > 0
      ? Math.max(0, (rawAll.x[rawAll.x.length - 1] - org) / 1000)
      : 0;
  })();
  endRelRef.current = endRel;

  return (
    <div className="plot p3d">
      <div
        ref={hostRef}
        className={`p3d-host${measureMode ? " measuring" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
      >
        {/* 三轴绑定（左上）：通道与 2D 图例共享 */}
        <div className="p3d-hud tl">
          <label
            className="p3d-axis"
            title={tx("X 轴绑定通道（红 · 横向）", "Bind X axis (red · lateral)") + roTip}
          >
            <b style={{ color: AX_COLOR.x }}>X</b>
            <select
              className="input"
              value={s3d.axisX}
              onChange={(e) => plot3dStore.setSetting({ axisX: e.target.value })}
              disabled={plot.channels.length === 0 || opLocked}
            >
              <option value="">{plot.channels.length === 0 ? tx("无通道", "No channels") : tx("未绑定", "Unbound")}</option>
              {plot.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label
            className="p3d-axis"
            title={tx("Y 轴绑定通道（绿 · 垂直/高度）", "Bind Y axis (green · vertical/height)") + roTip}
          >
            <b style={{ color: AX_COLOR.y }}>Y</b>
            <select
              className="input"
              value={s3d.axisY}
              onChange={(e) => plot3dStore.setSetting({ axisY: e.target.value })}
              disabled={plot.channels.length === 0 || opLocked}
            >
              <option value="">{plot.channels.length === 0 ? tx("无通道", "No channels") : tx("未绑定", "Unbound")}</option>
              {plot.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label
            className="p3d-axis"
            title={tx("Z 轴绑定通道（蓝 · 深度）", "Bind Z axis (blue · depth)") + roTip}
          >
            <b style={{ color: AX_COLOR.z }}>Z</b>
            <select
              className="input"
              value={s3d.axisZ}
              onChange={(e) => plot3dStore.setSetting({ axisZ: e.target.value })}
              disabled={plot.channels.length === 0 || opLocked}
            >
              <option value="">{plot.channels.length === 0 ? tx("无通道", "No channels") : tx("未绑定", "Unbound")}</option>
              {plot.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* 视角组（右上） */}
        <div className="p3d-hud tr">
          {presets.map((it) => (
            <button
              key={it.p}
              className="icon-btn"
              onClick={() => sceneRef.current?.setViewPreset(it.p)}
              title={tx(it.tipZh, it.tipEn)}
            >
              {tx(it.zh, it.en)}
            </button>
          ))}
          <button
            className="icon-btn"
            onClick={() => sceneRef.current?.resetView()}
            title={tx("重置视角", "Reset view")}
          >
            <IconRotate />
          </button>
          <button
            className="icon-btn"
            onClick={() => sceneRef.current?.focusLatest()}
            title={tx("聚焦最新点", "Focus latest point")}
          >
            <IconCrosshair />
          </button>
          <button
            className={`icon-btn${s3d.follow ? " primary" : ""}`}
            onClick={() => plot3dStore.setSetting({ follow: !s3d.follow })}
            title={tx(
              "跟随模式：视角平滑锁定最新点（与自动旋转互斥；开启时平移暂失效）",
              "Follow mode: camera smoothly locks onto the latest point (mutually exclusive with auto-rotate; panning disabled while on)",
            )}
          >
            <IconLock />
          </button>
          <button
            className={`icon-btn${s3d.calibMode ? " primary" : ""}`}
            disabled={!allBound}
            onClick={() => (s3d.calibMode ? exitCalibMode() : plot3dStore.setSetting({ calibMode: true }))}
            title={tx(
              "椭球校准模式：点云采样 + 九参数拟合（磁力计/加计）",
              "Ellipsoid calibration: point-cloud sampling + 9-parameter fit (mag/acc)",
            )}
          >
            <IconTarget />
          </button>
        </div>

        {/* 统计（右下）：scrub/回放时追加游标相对秒（tbTRef 直写 DOM）；
            配对诊断副行（P75 B2）：三轴值域 + 配对/跳过计数 */}
        {ready && (
          <div className="p3d-hud br">
            {pairLine && (
              <div
                className="p3d-hud-sub"
                title={tx(
                  "三轴值域与时间戳配对情况：配对=成功生成轨迹点，跳过=容差外/无数据被丢弃（3D 不编造坐标）",
                  "Per-axis range and timestamp pairing: paired = points emitted, skipped = dropped (out-of-tolerance / no data)",
                )}
              >
                {pairLine}
              </div>
            )}
            {totalPts > 0
              ? `${totalPts.toLocaleString()} ${tx("点", "pts")}${settings.perfHud ? ` · ${stats.fps} FPS` : ""}`
              : ""}
            <span ref={tbTRef} />
          </div>
        )}

        {/* 测量气泡（左下）——校准模式下让位给校准 HUD */}
        {(measureMode || measureInfo) && !s3d.calibMode && (
          <div className="p3d-hud bl">
            <div className="p3d-measure">
              <div className="p3d-measure-head">
                <b>{tx("测距", "Measure")}</b>
                <button
                  className="p3d-mclose"
                  onClick={exitMeasure}
                  title={tx("清除测量并退出测距模式（Esc）", "Clear measurement and exit (Esc)")}
                >
                  <IconClose />
                </button>
              </div>
              <div className="p3d-measure-row">
                <span className="p3d-mtag" style={{ color: MEASURE_COLOR }}>A</span>
                {measureInfo ? (
                  <span>
                    {fmtVal(measureInfo.a.real[0])}, {fmtVal(measureInfo.a.real[1])},{" "}
                    {fmtVal(measureInfo.a.real[2])}
                  </span>
                ) : (
                  <i>{tx("点击轨迹放置 A", "Click the trajectory to place A")}</i>
                )}
              </div>
              <div className="p3d-measure-row">
                <span className="p3d-mtag" style={{ color: MEASURE_COLOR }}>B</span>
                {measureInfo?.b ? (
                  <span>
                    {fmtVal(measureInfo.b.real[0])}, {fmtVal(measureInfo.b.real[1])},{" "}
                    {fmtVal(measureInfo.b.real[2])}
                  </span>
                ) : (
                  <i>
                    {measureInfo
                      ? tx("点击轨迹放置 B", "Click the trajectory to place B")
                      : tx("长按或菜单进入测距模式", "Long-press or use the menu to start measuring")}
                  </i>
                )}
              </div>
              {measureInfo?.b && (
                <div className="p3d-measure-dt">
                  Δ ={" "}
                  {fmtVal(
                    Math.hypot(
                      measureInfo.a.real[0] - measureInfo.b.real[0],
                      measureInfo.a.real[1] - measureInfo.b.real[1],
                      measureInfo.a.real[2] - measureInfo.b.real[2],
                    ),
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 校准 HUD（左下，P71/P73）：子页（椭球拟合 | 六面向导）+ 采样 + 拟合 + 预览/对比 */}
        {s3d.calibMode && (
          <div className="p3d-hud bl">
            <div className={`p3d-calib${fitStale ? " stale" : ""}`}>
              <div className="p3d-measure-head">
                <b>{tx("椭球校准", "Calibration")}</b>
                <button
                  className="p3d-mclose"
                  onClick={exitCalibMode}
                  title={tx("退出校准模式（回到轨迹）", "Exit calibration (back to trajectory)")}
                >
                  <IconClose />
                </button>
              </div>
              <div className="p3d-calib-tabs">
                <button
                  className={calibTab === "ellipsoid" ? "on" : ""}
                  onClick={() => switchCalibTab("ellipsoid")}
                  title={tx(
                    "连续翻滚采样 + 九参数椭球拟合（磁力计/加计通用）",
                    "Continuous tumble sampling + 9-param ellipsoid fit (mag/acc)",
                  )}
                >
                  {tx("椭球拟合（磁/加通用）", "Ellipsoid (mag/acc)")}
                </button>
                <button
                  className={calibTab === "six" ? "on" : ""}
                  onClick={() => switchCalibTab("six")}
                  title={tx(
                    "六面静止采样分步向导（加计专用，切换清空椭球采样）",
                    "Step-by-step six-face wizard (acc only; switching clears ellipsoid samples)",
                  )}
                >
                  {tx("六面向导（加计专用）", "Six-face wizard (acc)")}
                </button>
              </div>

              {calibTab === "ellipsoid" ? (
                <>
                  <div className="p3d-calib-hint">
                    {tx(
                      "缓慢翻滚传感器覆盖全空间（画 8 字），点云越接近球面越好",
                      "Slowly tumble the sensor to cover all directions (figure-8); the closer the cloud is to a sphere, the better",
                    )}
                  </div>
                  <div className="p3d-calib-row">
                    <button
                      className={`p3d-cbtn${calibUi.capturing ? " stop" : ""}`}
                      onClick={() =>
                        calibUi.capturing
                          ? plot3dStore.stopCalibCapture()
                          : plot3dStore.startCalibCapture()
                      }
                    >
                      {calibUi.capturing ? tx("停止采样", "Stop capture") : tx("开始采样", "Start capture")}
                    </button>
                    <span className="p3d-calib-count">
                      {calibUi.count.toLocaleString()} / {plot3dStore.CALIB_CAP.toLocaleString()}
                    </span>
                  </div>
                  <div className="p3d-calib-row">
                    <span>
                      {tx("象限覆盖", "Octant coverage")} {calibUi.coverage}/8
                    </span>
                    {calibUi.count >= plot3dStore.CALIB_CAP && (
                      <span className="p3d-calib-warn">{tx("已达上限，自动停止", "Cap reached — auto-stopped")}</span>
                    )}
                  </div>
                  <div className="p3d-calib-row">
                    <button className="p3d-cbtn" disabled={calibUi.count < 500} onClick={doFit}>
                      {tx("拟合椭球", "Fit ellipsoid")}
                    </button>
                    {!fit && calibUi.count < 500 && (
                      <i className="p3d-calib-dim">{tx("至少采样 500 点", "min 500 points")}</i>
                    )}
                  </div>
                  {fitErr && <div className="p3d-calib-err">{fitErr}</div>}
                  {fit && (
                    <>
                      <div className="p3d-calib-sec">
                        {tx("拟合结果", "Fit result")}
                        {fitStale && (
                          <span className="p3d-calib-stale">{tx("（基于旧采样）", " (stale samples)")}</span>
                        )}
                      </div>
                      <div className="p3d-calib-grid">
                        <span>offset</span>
                        <span className="p3d-calib-mono">[{fit.offset.map((v) => fmtVal(v)).join(", ")}]</span>
                        <span>gains</span>
                        <span className="p3d-calib-mono">[{fit.gains.map((v) => v.toFixed(4)).join(", ")}]</span>
                        <span>W</span>
                        <span className="p3d-calib-mono">
                          {fit.matrix.map((row, i) => (
                            <span key={i}>
                              [{row.map((v) => v.toFixed(4)).join(", ")}]
                              {i < 2 && <br />}
                            </span>
                          ))}
                        </span>
                      </div>
                      <div className="p3d-calib-row">
                        <span>
                          CV {(fit.cv * 100).toFixed(2)}%（{grade(fit.cv)}）
                        </span>
                        <span>
                          RMS {(fit.rms * 100).toFixed(2)}% · {fit.n.toLocaleString()} {tx("点", "pts")}
                        </span>
                      </div>
                      {/* P73：补偿预览 toggle + 校正前后显示切换（无 fit 禁用） */}
                      <div className="p3d-calib-row">
                        <button
                          className={`p3d-cbtn${previewOn ? " on" : ""}`}
                          onClick={() => setPreviewOn((v) => !v)}
                          title={tx(
                            "实时显示校正后幅值 r=|W·(x−offset)|：贴平 1.0 线 = 校准有效",
                            "Live corrected radius r=|W·(x−offset)|: flat around 1.0 = calibration works",
                          )}
                        >
                          {previewOn ? tx("关闭预览", "Hide preview") : tx("补偿预览", "Comp. preview")}
                        </button>
                        <div className="p3d-seg" role="group" aria-label={tx("点云显示模式", "Point-cloud display")}>
                          <span className="p3d-seg-l">{tx("显示", "Show")}</span>
                          <button
                            className={calibDisp === "raw" ? "on" : ""}
                            disabled={!fit}
                            onClick={() => switchCalibDisp("raw")}
                            title={tx("原始点云 + 椭球线框 + 残差着色", "Raw cloud + ellipsoid + residual colors")}
                          >
                            {tx("原始", "Raw")}
                          </button>
                          <button
                            className={calibDisp === "corrected" ? "on" : ""}
                            disabled={!fit}
                            onClick={() => switchCalibDisp("corrected")}
                            title={tx("校正后点云（应收缩为均匀球壳）+ 参考球", "Corrected cloud (should shrink to a uniform shell) + reference sphere")}
                          >
                            {tx("校正后", "Corrected")}
                          </button>
                        </div>
                      </div>
                      {previewOn && (
                        <div className={`p3d-spark${fitStale ? " stale" : ""}`}>
                          <canvas ref={sparkRef} width={SPARK_W * 2} height={SPARK_H * 2} />
                          {fitStale && (
                            <span className="p3d-spark-susp">
                              {tx("已挂起 · 重新拟合后恢复", "suspended · re-fit to resume")}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="p3d-calib-row">
                        <button className="p3d-cbtn" onClick={copyCalibJson}>
                          {tx("复制 JSON", "Copy JSON")}
                        </button>
                        <button className="p3d-cbtn" onClick={copyCalibC}>
                          {tx("复制 C 数组", "Copy C array")}
                        </button>
                        <button className="p3d-cbtn" onClick={clearCalibAll}>
                          {tx("清空重来", "Clear & restart")}
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="p3d-calib-hint">
                    {tx(
                      "每面朝上静置，点「采集该面」自动采 2 秒；六面齐后计算参数",
                      "Rest each face up and capture (2 s auto); solve after all six faces",
                    )}
                  </div>
                  <div className="p3d-a6-list">
                    {A6_FACES.map((f, i) => {
                      const face = a6?.faces[i] ?? null;
                      const col = !!a6?.collecting && a6.idx === i;
                      const dom = i >> 1; // 该面的主轴下标（+X/−X → 轴 0 …）
                      return (
                        <div key={i} className={`p3d-a6-row${col ? " run" : ""}`}>
                          <span className={`p3d-a6-ico${face ? " ok" : col ? " run" : ""}`}>
                            {face ? <IconCheck /> : col ? <IconPlay /> : <IconCircle />}
                          </span>
                          <span className="p3d-a6-lbl">{tx(f.zh, f.en)}</span>
                          {face ? (
                            <span className="p3d-a6-stat" title={tx("主轴均值 ± 标准差（原始单位）", "Dominant-axis mean ± std (raw units)")}>
                              μ {fmtVal(face.mean[dom])} · σ {fmtVal(face.std[dom])}
                            </span>
                          ) : col ? (
                            <span className="p3d-a6-stat run">
                              {tx("采集中", "capturing")}{" "}
                              {(a6StartRef.current > 0
                                ? Math.min(
                                    plot3dStore.ACCEL6_WINDOW_MS / 1000,
                                    (performance.now() - a6StartRef.current) / 1000,
                                  )
                                : 0
                              ).toFixed(1)}
                              s
                            </span>
                          ) : null}
                          <button
                            className={`p3d-cbtn${col ? " stop" : ""}`}
                            onClick={() => (col ? plot3dStore.accel6Abort() : plot3dStore.accel6StartFace(i))}
                          >
                            {col ? tx("中止", "Abort") : face ? tx("重采", "Redo") : tx("采集该面", "Capture")}
                          </button>
                        </div>
                      );
                    })}
                  {a6?.stalled && (
                    <div className="p3d-calib-err">
                      {tx(
                        "数据流中断：连续 4 秒未收到样本，本轮采集已作废。恢复数据流后重试。",
                        "Data stream stalled: no sample for 4 s; this capture was discarded. Restore the stream and retry.",
                      )}
                    </div>
                  )}
                  </div>
                  <div className="p3d-calib-row">
                    <button
                      className="p3d-cbtn"
                      disabled={!a6 || a6.faces.some((f) => f === null)}
                      onClick={a6Solve}
                    >
                      {tx("计算参数", "Solve")}
                    </button>
                    {a6 && !a6.result && (
                      <i className="p3d-calib-dim">{tx("六面齐后可用", "needs all six faces")}</i>
                    )}
                  </div>
                  {a6?.result && !a6.result.ok && <div className="p3d-calib-err">{fitErrText(a6.result)}</div>}
                  {a6ok && (
                    <>
                      <div className="p3d-calib-sec">{tx("六面结果", "Six-face result")}</div>
                      <div className="p3d-calib-grid">
                        <span>offset</span>
                        <span className="p3d-calib-mono">[{a6ok.offset.map((v) => fmtVal(v)).join(", ")}]</span>
                        <span>gain</span>
                        <span className="p3d-calib-mono">[{a6ok.gains.map((v) => v.toFixed(4)).join(", ")}]</span>
                        <span>scale</span>
                        <span className="p3d-calib-mono">
                          [{a6ok.scales.map((v) => fmtVal(v)).join(", ")}] {tx("原始单位/g", "raw/g")}
                        </span>
                      </div>
                      <div className="p3d-calib-row">
                        <span title={tx("三轴尺度一致性，>2% 提示装配/对齐问题", "Scale consistency; >2% hints assembly/misalignment")}>
                          CV {(a6ok.cvScale * 100).toFixed(2)}%（{a6ok.grade}）
                        </span>
                        <span title={tx("各面校正后非主轴分量占比最大值（对齐/正交性指示）", "Max off-axis ratio after correction (alignment/orthogonality indicator)")}>
                          {tx("面偏差", "Face dev")} {(a6ok.faceDev * 100).toFixed(2)}%
                        </span>
                      </div>
                      <div className="p3d-calib-row">
                        <button className="p3d-cbtn" onClick={copyAccel6C}>
                          {tx("复制 C 数组", "Copy C array")}
                        </button>
                        <button className="p3d-cbtn" onClick={() => plot3dStore.accel6Reset()}>
                          {tx("清空重来", "Clear & restart")}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 未绑定提示（居中，不挡交互） */}
        {ready && !allBound && (
          <div className="p3d-hint">
            <div>
              {tx("绑定 X / Y / Z 三个通道后开始绘制 3D 轨迹", "Bind X / Y / Z channels to draw the 3D trajectory")}
              <br />
              <span className="p3d-hint-sub">
                {tx("通道在 2D 曲线图例或帧画布中添加，此处直接共享", "Channels are shared from the 2D plot legend / frame canvas")}
              </span>
            </div>
          </div>
        )}

        {/* 底部时间条（P70 T2）：非回放拖动 = scrub 查看历史；回放中拖动 = 真时间机器 seek；
            双击 = 回到最新。有数据才显示。P74c B5：校准模式下轨迹层已隐藏，
            拖动没有任何视觉因果 → 直接禁用并说明原因（指针事件一起摘掉）。 */}
        {ready && endRel > 0 && (
          <div
            className={`p3d-timebar${s3d.calibMode ? " off" : ""}`}
            aria-disabled={s3d.calibMode || undefined}
            title={
              s3d.calibMode
                ? tx("校准模式下时间游标不适用（轨迹层已隐藏）；退出校准即可拖动", "The time cursor does not apply in calibration mode (trajectory hidden)")
                : undefined
            }
            onPointerDown={onTbPointerDown}
            onPointerMove={onTbPointerMove}
            onPointerUp={onTbPointerUp}
            onDoubleClick={onTbDoubleClick}
          >
            <span className="p3d-tb-lbl">0s</span>
            <div className="p3d-tb-track" ref={tbTrackRef}>
              <div className="p3d-tb-fill" ref={tbFillRef} />
              <div className="p3d-tb-cursor" ref={tbCurRef} />
              <div className="p3d-tb-bubble" ref={tbBubbleRef} />
            </div>
            <span className="p3d-tb-lbl">{fmtTickSec(endRel)}</span>
            {/* C14：三态标识。scrub 残留此前唯一的线索是右下角一行小字，
                极易误判为「采集停了」；回放 seek 与 scrub 也无从区分 */}
            {(() => {
              const sess = sessionStore.getSnapshot().state;
              if (sess === "playing" || sess === "paused") {
                return <span className="p3d-tb-badge">{tx("回放 seek", "replay seek")}</span>;
              }
              if (!s3d.calibMode && plot3dStore.lastCursorSec() !== null) {
                return (
                  <button
                    className="p3d-tb-badge on"
                    onClick={clearScrub}
                    title={tx(
                      "历史模式：轨迹停在拖动点，新数据继续在后台积累；点击回到最新",
                      "History mode: trajectory parked at the dragged spot; new data keeps accumulating. Click to jump to latest",
                    )}
                  >
                    {tx("历史模式 · 回最新", "history · to latest")}
                  </button>
                );
              }
              return null;
            })()}
          </div>
        )}

        <div ref={tipRef} className="p3d-tip" />
      </div>

      {/* 右键菜单：视图 / 测量 / 数据 / 设置 */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="ctx-menu"
            style={{
              left: menuPos?.left ?? -9999,
              top: menuPos?.top ?? -9999,
              visibility: menuPos ? "visible" : "hidden",
            }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">{tx("3D 轨迹", "3D Trajectory")}</div>
            {opLocked && (
              <div className="ctx-lock" title={tx("Operator 只读模式：设置项已锁定，视角/测量/校准仍可用", "Operator read-only: settings locked; view, measure and calibration remain available")}>
                <IconLock />
                {tx("Operator 只读：设置已锁定", "Operator read-only: settings locked")}
              </div>
            )}

            <div className="ctx-group">{tx("模式", "Mode")}</div>
            <button
              className="ctx-item"
              disabled={!allBound}
              title={!allBound ? tx("需先绑定 X / Y / Z 三轴", "Bind X / Y / Z axes first") : undefined}
              onClick={closeAnd(() => (s3d.calibMode ? exitCalibMode() : plot3dStore.setSetting({ calibMode: true })))}
            >
              {s3d.calibMode ? <IconDot /> : <IconCircle />} {tx("椭球校准模式", "Ellipsoid calibration")}
            </button>

            <div className="ctx-group">{tx("视图", "View")}</div>
            <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("top"))}>
              {tx("俯视", "Top view")}
            </button>
            <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("side"))}>
              {tx("侧视", "Side view")}
            </button>
            <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("front"))}>
              {tx("正视", "Front view")}
            </button>
            <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("iso"))}>
              {tx("等轴", "Isometric")}
            </button>
            <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.resetView())}>
              {tx("重置视角", "Reset view")}
            </button>
            <button
              className="ctx-item"
              onClick={closeAnd(() => plot3dStore.setSetting({ autoRotate: !s3d.autoRotate }))}
            >
              {s3d.autoRotate ? <IconDot /> : <IconCircle />} {tx("自动旋转", "Auto rotate")}
            </button>
            <button
              className="ctx-item"
              onClick={closeAnd(() => plot3dStore.setSetting({ follow: !s3d.follow }))}
            >
              {s3d.follow ? <IconDot /> : <IconCircle />} {tx("跟随模式（锁定最新点）", "Follow mode (lock to latest point)")}
            </button>
            <button
              className="ctx-item"
              disabled={opLocked}
              title={opLocked ? tx("键盘飞行", "Keyboard flight") + roTip : undefined}
              onClick={closeAnd(() => plot3dStore.setSetting({ keyFlight: !s3d.keyFlight }))}
            >
              {s3d.keyFlight ? <IconDot /> : <IconCircle />} {tx("键盘飞行（WASD/QE/方向键，悬停生效）", "Keyboard flight (WASD/QE/arrows, while hovered)")}
            </button>
            <button
              className="ctx-item"
              disabled={opLocked}
              title={opLocked ? tx("缩放到光标", "Zoom to cursor") + roTip : undefined}
              onClick={closeAnd(() => plot3dStore.setSetting({ zoomToCursor: !s3d.zoomToCursor }))}
            >
              {s3d.zoomToCursor ? <IconDot /> : <IconCircle />} {tx("缩放到光标", "Zoom to cursor")}
            </button>
            <button
              className="ctx-item"
              disabled={opLocked}
              title={opLocked ? tx("网格与坐标轴", "Grid & axes") + roTip : undefined}
              onClick={closeAnd(() => plot3dStore.setSetting({ showGrid: !s3d.showGrid }))}
            >
              {s3d.showGrid ? <IconDot /> : <IconCircle />} {tx("网格与坐标轴", "Grid & axes")}
            </button>
            {s3d.showGrid &&
              (
                [
                  ["coarse", tx("网格：疏（步长×2）", "Grid: coarse (step ×2)")],
                  ["std", tx("网格：标准（自适应）", "Grid: standard (auto)")],
                  ["fine", tx("网格：密（步长×0.5）", "Grid: fine (step ×0.5)")],
                ] as const
              ).map(([v, lab]) => (
                <button
                  key={v}
                  className="ctx-item"
                  disabled={opLocked}
                  onClick={closeAnd(() => plot3dStore.setSetting({ gridDensity: v }))}
                >
                  {s3d.gridDensity === v ? <IconDot /> : <IconCircle />} {lab}
                </button>
              ))}
            <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.focusLatest())}>
              {tx("聚焦最新点", "Focus latest point")}
            </button>

            <div className="ctx-group">{tx("测量", "Measure")}</div>
            <button
              className="ctx-item"
              onClick={closeAnd(() => (measureModeRef.current ? exitMeasure() : enterMeasure()))}
            >
              {measureMode ? <IconDot /> : <IconCircle />} {tx("测距模式（同长按）", "Measure mode (same as long-press)")}
            </button>
            <button
              className="ctx-item"
              disabled={!measureInfo}
              onClick={closeAnd(() => sceneRef.current?.setMeasure(null, null))}
            >
              {tx("清除测量", "Clear measurement")}
            </button>

            <div className="ctx-group">{tx("数据", "Data")}</div>
            <button className="ctx-item" disabled={!hoverRef.current} onClick={closeAnd(copyHover)}>
              {tx("复制悬停点坐标", "Copy hovered point")}
            </button>
            <button
              className="ctx-item"
              disabled={!allBound}
              onClick={closeAnd(() => void exportCsv())}
            >
              {tx("导出轨迹 CSV", "Export trajectory CSV")}
            </button>
            <button className="ctx-item" onClick={closeAnd(() => void exportPng())}>
              {tx("快照 PNG", "Snapshot PNG")}
            </button>
            <button
              className="ctx-item"
              disabled={endRel <= 0}
              onClick={closeAnd(() => clearScrub())}
            >
              {tx("回到最新（清除时间游标）", "Back to latest (clear time cursor)")}
            </button>
            <button
              className="ctx-item danger"
              onClick={closeAnd(() => sceneRef.current?.clearTrajectory())}
            >
              {tx("清空轨迹（不影响采集）", "Clear trajectory (keeps capture)")}
            </button>

            <div className="ctx-group">{tx("设置", "Settings")}</div>
            <div
              ref={styleRowRef}
              className={`ctx-row${opLocked ? " dis" : ""}`}
              onMouseEnter={() => {
                if (opLocked) return;
                disarmSub();
                setSub("style");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                if (opLocked) return;
                setSub((s) => (s === "style" ? null : "style"));
                setSubPinned(sub !== "style");
                disarmSub();
              }}
            >
              <button className="ctx-item" disabled={opLocked}>
                <span className="ctx-item-l">
                  {tx("轨迹样式", "Trajectory style")}{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
                </span>
                <span className="ctx-cur">{styleCur}</span>
              </button>
            </div>
            <div
              ref={fadeRowRef}
              className={`ctx-row${opLocked ? " dis" : ""}`}
              onMouseEnter={() => {
                if (opLocked) return;
                disarmSub();
                setSub("fade");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                if (opLocked) return;
                setSub((s) => (s === "fade" ? null : "fade"));
                setSubPinned(sub !== "fade");
                disarmSub();
              }}
            >
              <button className="ctx-item" disabled={opLocked}>
                <span className="ctx-item-l">
                  {tx("渐隐窗口", "Fade window")}{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
                </span>
                <span className="ctx-cur">{fadeCur}</span>
              </button>
            </div>
            <div
              ref={colorRowRef}
              className={`ctx-row${opLocked ? " dis" : ""}`}
              onMouseEnter={() => {
                if (opLocked) return;
                disarmSub();
                setSub("color");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                if (opLocked) return;
                setSub((s) => (s === "color" ? null : "color"));
                setSubPinned(sub !== "color");
                disarmSub();
              }}
            >
              <button className="ctx-item" disabled={opLocked}>
                <span className="ctx-item-l">
                  {tx("着色", "Color by")}{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
                </span>
                <span className="ctx-cur">{colorCur}</span>
              </button>
            </div>
            <div
              ref={densityRowRef}
              className={`ctx-row${opLocked ? " dis" : ""}`}
              onMouseEnter={() => {
                if (opLocked) return;
                disarmSub();
                setSub("density");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                if (opLocked) return;
                setSub((s) => (s === "density" ? null : "density"));
                setSubPinned(sub !== "density");
                disarmSub();
              }}
            >
              <button className="ctx-item" disabled={opLocked}>
                <span className="ctx-item-l">
                  {tx("点密度", "Point density")}{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
                </span>
                <span className="ctx-cur">{densityCur}</span>
              </button>
            </div>
            <div
              ref={pairRowRef}
              className={`ctx-row${opLocked ? " dis" : ""}`}
              onMouseEnter={() => {
                if (opLocked) return;
                disarmSub();
                setSub("pair");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                if (opLocked) return;
                setSub((s) => (s === "pair" ? null : "pair"));
                setSubPinned(sub !== "pair");
                disarmSub();
              }}
            >
              <button className="ctx-item" disabled={opLocked}>
                <span className="ctx-item-l">
                  {tx("数据配对", "Data pairing")}{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
                </span>
                <span className="ctx-cur">{pairCur}</span>
              </button>
            </div>
            <div
              ref={tolRowRef}
              className={`ctx-row${opLocked || s3d.pairMode === "union" ? " dis" : ""}`}
              onMouseEnter={() => {
                if (opLocked || s3d.pairMode === "union") return;
                disarmSub();
                setSub("tol");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                if (opLocked || s3d.pairMode === "union") return;
                setSub((s) => (s === "tol" ? null : "tol"));
                setSubPinned(sub !== "tol");
                disarmSub();
              }}
            >
              <button className="ctx-item" disabled={opLocked || s3d.pairMode === "union"}>
                <span className="ctx-item-l">
                  {tx("配对容差", "Pair tolerance")}{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
                </span>
                <span className="ctx-cur">{tolCur}</span>
              </button>
            </div>
            <div
              ref={ascaleRowRef}
              className={`ctx-row${opLocked ? " dis" : ""}`}
              onMouseEnter={() => {
                if (opLocked) return;
                disarmSub();
                setSub("ascale");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                if (opLocked) return;
                setSub((s) => (s === "ascale" ? null : "ascale"));
                setSubPinned(sub !== "ascale");
                disarmSub();
              }}
            >
              <button className="ctx-item" disabled={opLocked}>
                <span className="ctx-item-l">
                  {tx("三轴缩放", "Axis scaling")}{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
                </span>
                <span className="ctx-cur">{ascaleCur}</span>
              </button>
            </div>
            <button className="ctx-item" disabled={opLocked} onClick={closeAnd(() => plot3dStore.resetSettings())}>
              {tx("恢复默认", "Reset to defaults")}
            </button>

            {/* 样式子菜单 */}
            {sub === "style" && (
              <Flyout anchor={styleRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={150}>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ style: "line+points" }))}
                >
                  {s3d.style === "line+points" ? <IconDot /> : <IconCircle />} {tx("线 + 点", "Line + points")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ style: "line" }))}
                >
                  {s3d.style === "line" ? <IconDot /> : <IconCircle />} {tx("仅线", "Line only")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ style: "points" }))}
                >
                  {s3d.style === "points" ? <IconDot /> : <IconCircle />} {tx("仅点", "Points only")}
                </button>
              </Flyout>
            )}

            {/* 渐隐子菜单 */}
            {sub === "fade" && (
              <Flyout anchor={fadeRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={150}>
                {([10, 60, 300, 0] as const).map((f) => (
                  <button
                    key={f}
                    className="ctx-item"
                    onClick={closeAnd(() => plot3dStore.setSetting({ fade: f }))}
                  >
                    {s3d.fade === f ? <IconDot /> : <IconCircle />}{" "}
                    {f === 0
                      ? tx("全程渐变", "Full span")
                      : f === 300
                        ? tx("最近 5 分钟", "Last 5 min")
                        : tx(`最近 ${f} 秒`, `Last ${f}s`)}
                  </button>
                ))}
              </Flyout>
            )}

            {/* 着色子菜单：按时间 / 按通道（通道列表） */}
            {sub === "color" && (
              <Flyout anchor={colorRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={170}>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ colorBy: "time" }))}
                >
                  {s3d.colorBy === "time" ? <IconDot /> : <IconCircle />} {tx("按时间", "By time")}
                </button>
                {plot.channels.length > 0 && <div className="ctx-group">{tx("按通道", "By channel")}</div>}
                {plot.channels.map((c) => (
                  <button
                    key={c.id}
                    className="ctx-item"
                    onClick={closeAnd(() =>
                      plot3dStore.setSetting({ colorBy: "ch", colorCh: c.id }),
                    )}
                  >
                    {s3d.colorBy === "ch" && s3d.colorCh === c.id ? <IconDot /> : <IconCircle />} {c.name}
                  </button>
                ))}
              </Flyout>
            )}

            {/* 密度子菜单 */}
            {sub === "density" && (
              <Flyout anchor={densityRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={160}>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ density: "high" }))}
                >
                  {s3d.density === "high" ? <IconDot /> : <IconCircle />} {tx("高（1:1 全点）", "High (1:1)")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ density: "mid" }))}
                >
                  {s3d.density === "mid" ? <IconDot /> : <IconCircle />} {tx("中（1:2 抽稀）", "Mid (1:2)")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ density: "low" }))}
                >
                  {s3d.density === "low" ? <IconDot /> : <IconCircle />} {tx("低（1:4 抽稀）", "Low (1:4)")}
                </button>
              </Flyout>
            )}

            {/* 数据配对子菜单（P75 B2）：同帧三轴的阶梯轨迹请用插值配对 */}
            {sub === "pair" && (
              <Flyout anchor={pairRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={210}>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ pairMode: "interp" }))}
                  title={tx(
                    "按 X 时间轴对 Y/Z 做带容差线性插值：轨迹平滑（推荐）",
                    "Tolerance-checked linear interp of Y/Z on the X timeline: smooth trajectory (recommended)",
                  )}
                >
                  {s3d.pairMode === "interp" ? <IconDot /> : <IconCircle />}{" "}
                  {tx("插值配对（推荐）", "Interpolated (recommended)")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ pairMode: "nearest" }))}
                  title={tx(
                    "按 X 时间轴取 Y/Z 最近样本：保持原始采样节奏（阶梯感）",
                    "Nearest Y/Z sample per X timestamp: keeps raw cadence (stepped)",
                  )}
                >
                  {s3d.pairMode === "nearest" ? <IconDot /> : <IconCircle />}{" "}
                  {tx("最近邻配对", "Nearest neighbor")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ pairMode: "union" }))}
                  title={tx(
                    "旧版联合前向填充口径：与 P75 之前行为一致（横平竖直阶梯）",
                    "Legacy union forward-fill: same as before P75 (right-angle staircase)",
                  )}
                >
                  {s3d.pairMode === "union" ? <IconDot /> : <IconCircle />}{" "}
                  {tx("旧版前向填充", "Legacy forward-fill")}
                </button>
              </Flyout>
            )}

            {/* 配对容差子菜单（P75 B2）：Y/Z 样本距锚点超过容差即丢弃（不编造坐标）；0=自动 */}
            {sub === "tol" && s3d.pairMode !== "union" && (
              <Flyout anchor={tolRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={200}>
                {([0, 5, 10, 25, 50, 100] as const).map((v) => (
                    <button
                      key={v}
                      className="ctx-item"
                      onClick={closeAnd(() => plot3dStore.setSetting({ pairTolMs: v }))}
                      title={
                        v === 0
                          ? tx(
                              "按三轴采样节奏自动推算（1.5×锚点间隔）",
                              "Derived from the axes' sampling cadence (1.5× anchor interval)",
                            )
                          : undefined
                      }
                    >
                      {s3d.pairTolMs === v ? <IconDot /> : <IconCircle />}{" "}
                      {v === 0 ? tx("自动", "Auto") : `${v} ms`}
                    </button>
                  ))}
              </Flyout>
            )}

            {/* 三轴缩放子菜单（P75 B2）：等比=真实比例；逐轴=各轴独立撑满（扁平数据查看） */}
            {sub === "ascale" && (
              <Flyout anchor={ascaleRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={220}>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ axisScale: "uniform" }))}
                  title={tx(
                    "三轴同一比例尺：反映真实几何形状（默认）",
                    "One scale for all axes: true geometry (default)",
                  )}
                >
                  {s3d.axisScale === "uniform" ? <IconDot /> : <IconCircle />}{" "}
                  {tx("等比（真实比例）", "Uniform (true scale)")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ axisScale: "perAxis" }))}
                  title={tx(
                    "各轴独立归一化撑满视锥：查看扁平/量级悬殊的数据",
                    "Normalize each axis to fill the view: for flat / mixed-magnitude data",
                  )}
                >
                  {s3d.axisScale === "perAxis" ? <IconDot /> : <IconCircle />}{" "}
                  {tx("逐轴归一化", "Per-axis normalize")}
                </button>
              </Flyout>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
