/**
 * P69 3D 轨迹面板渲染核心（纯 three.js，无 React 依赖）。
 *
 * 性能架构（对照详设 §10 + 评审优化）：
 * - 双层 LOD：全精度尾窗（12 万点，追加式 + 满时最老一半压入全景）+
 *   抽稀全景（10 万点上限，满时 2:1 对数减半）——全程轨迹形状永不丢失，
 *   内存有界（~13MB 含真实值副列），GPU 两条 Line 合计 <2ms。
 * - 缓冲一次性预分配 Float32/Float64；追加 O(k)；压实/减半均为单次
 *   copyWithin/批量搬移（摊销 O(1)/点），绝无逐点 shift。
 * - 着色全部在顶点着色器完成（turbo/viridis × 按时间/按通道值域 × 渐隐），
 *   CPU 每点只写 aTime/aVal 两个标量，主题/色带切换只改 uniform，零重算。
 * - needsRender 脏标记：数据追加 / controls change / 相机动画 / resize 才渲染，
 *   相机静止且无新数据时 GPU 0 负载；dpr 上限 2。
 * - 位置缓冲存「去均值归一化」坐标（f32 精度足够），真实值存 f64 副列——
 *   大坐标（经纬度 120.xxx）不丢精度，重锚定只需 O(n) 重写归一化列。
 * - 面板生命周期：IntersectionObserver 不可见即跳渲染（数据由 store 泵喫，
 *   与 rAF 解耦，后台页签不丢段）；dispose 全量释放。
 */
import type * as THREE_NS from "three";
import type { Channel } from "../plot/plotStore";
import type { Plot3DBatch, Plot3DSettings } from "./plot3dStore";
import { correctedRadius, type FitOk } from "./ellipsoidFit";

/** 全精度尾窗容量（点） */
const TAIL_CAP = 120000;
/** 抽稀全景容量（点） */
const OVERVIEW_CAP = 100000;
/** 归一化视界半宽：norm 坐标映射到 ±VIEW_HALF */
const VIEW_HALF = 0.8;

export interface PickResult {
  tSec: number;
  real: [number, number, number];
  val: number;
  /** 画布 CSS 像素 */
  screen: [number, number];
  distPx: number;
}

export type ViewPreset = "top" | "side" | "front" | "iso";

export interface Plot3DScene {
  applyBatch(b: Plot3DBatch, reloaded: boolean, cursorSec: number | null): void;
  applySettings(
    s: Plot3DSettings,
    chans: Channel[],
    cbSafe: boolean,
    accent: string,
  ): void;
  applyTheme(): void;
  setViewPreset(p: ViewPreset): void;
  resetView(): void;
  focusLatest(): void;
  setAutoRotate(on: boolean): void;
  /** 跟随模式：target 平滑锁定最新点（游标时锁定截断点），保持视角偏移向量 */
  setFollow(on: boolean): void;
  focusPoint(real: [number, number, number]): void;
  setMeasure(a: PickResult | null, b: PickResult | null): void;
  /** 时间游标（P70 T2）：null = 跟随最新；数值 = 截断显示到该相对秒（二分 drawRange，
   *  uNow 锚定游标，最新点标记/拾取范围同步截断）——回放联动/scrub 的唯一渲染原语 */
  setTimeCursor(relSec: number | null): void;
  /** 校准模式（P71）：轨迹层隐藏、切换为点云+椭球线框；退出零重建恢复 */
  setCalibMode(on: boolean): void;
  /** 追加校准点云（store 缓冲 [from..) 段，原始值）；内部独立归一化/重锚；
   *  colorHex = 本段覆盖色（六面按面着色用），缺省走 残差着色/accent */
  setCalibPoints(
    pts: { x: number[]; y: number[]; z: number[] },
    from: number,
    colorHex?: string | null,
  ): void;
  /** 清空校准点云与线框（store 缓冲被清时由 UI 调用） */
  resetCalibView(): void;
  /** 拟合结果（原始单位，内部转归一化空间）；null = 清除；驱动线框+残差着色 */
  setCalibEllipsoid(fit: FitOk | null): void;
  /** 点云显示模式（P73）：raw = 原始+椭球线框+残差着色；corrected = 校正后+参考球 */
  setCalibDisplay(mode: "raw" | "corrected"): void;
  /** 键盘飞行（P72）：WASD/QE 平移升降、方向键旋转、F 跟随、R 重置（悬停画布时生效） */
  setKeyFlight(on: boolean): void;
  /** 强制渲染一帧并返回 PNG dataURL（快照导出用） */
  snapshotPng(): string;
  clearTrajectory(): void;
  pick(px: number, py: number): PickResult | null;
  stats(): { tail: number; overview: number; fps: number };
  dispose(): void;
}

/** CSS 变量 → 实色（含回退） */
function cssVar(name: string, fb: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}

export async function createScene(
  host: HTMLElement,
  cbs: { onContextLost: () => void; onToggleFollow?: () => void },
): Promise<Plot3DScene> {
  const T3 = await import("three");
  const { OrbitControls } = await import(
    "three/examples/jsm/controls/OrbitControls.js"
  );

  // ---------- 场景基座 ----------
  const scene = new T3.Scene();
  const bgColor = new T3.Color(cssVar("--bg-inset", "#0b0d10"));
  scene.background = bgColor;
  const camera = new T3.PerspectiveCamera(45, 1, 0.01, 100);
  const renderer = new T3.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(host.clientWidth, 60), Math.max(host.clientHeight, 60));
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.mouseButtons = {
    LEFT: T3.MOUSE.ROTATE,
    MIDDLE: T3.MOUSE.PAN,
    RIGHT: T3.MOUSE.PAN,
  };
  controls.addEventListener("change", () => {
    needsRender = true;
  });

  camera.position.set(1.9, 1.5, 2.1);
  camera.lookAt(0, 0, 0);

  // ---------- 双层 LOD 缓冲 ----------
  // 尾窗：posN(f32×3) + real(f64×3) + tSec(f64) + aVal(f32)
  const tPos = new Float32Array(TAIL_CAP * 3);
  const tReal = new Float64Array(TAIL_CAP * 3);
  const tT = new Float64Array(TAIL_CAP);
  const tVal = new Float32Array(TAIL_CAP);
  let tCount = 0;
  // 全景：posN(f32×3) + real(f64×3) + tSec(f64) + aVal(f32)
  const oPos = new Float32Array(OVERVIEW_CAP * 3);
  const oReal = new Float64Array(OVERVIEW_CAP * 3);
  const oT = new Float64Array(OVERVIEW_CAP);
  const oVal = new Float32Array(OVERVIEW_CAP);
  let oCount = 0;

  // 归一化锚定：norm = (real - anchor) * scaleVec[axis]
  // P75 B2：scale 为等比基准；scaleVec 为实际生效的逐轴缩放——
  // uniform 模式三值恒等于 scale（与旧版完全一致）；perAxis 模式各轴独立
  // 撑满视锥（扁平数据查看用；退化轴/无数据轴回退 scale）。
  const anchor = [0, 0, 0];
  let scale = 1;
  const scaleVec: [number, number, number] = [1, 1, 1];
  const toN = (v: number, i: 0 | 1 | 2) => (v - anchor[i]) * scaleVec[i];
  /** 按当前设置与包围盒重算逐轴缩放（重锚/首批数据/切换 axisScale 时调用） */
  function updateScaleVec() {
    if (curSettings?.axisScale !== "perAxis") {
      scaleVec[0] = scaleVec[1] = scaleVec[2] = scale;
      return;
    }
    for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
      const ext = bbMax[a] - bbMin[a];
      scaleVec[a] = isFinite(ext) && ext > 1e-9 ? (VIEW_HALF * 2) / ext : scale;
    }
  }
  // 真实值包围盒（增量维护 + 压实/重锚时重算）
  const bbMin = [Infinity, Infinity, Infinity];
  const bbMax = [-Infinity, -Infinity, -Infinity];
  let baseExtent = 1; // 建立 scale 时的包围盒跨度

  // ---------- 尾窗几何与材质 ----------
  const aTimeArr = new Float32Array(TAIL_CAP);
  const tailGeo = new T3.BufferGeometry();
  const posAttr = new T3.BufferAttribute(tPos, 3).setUsage(
    T3.DynamicDrawUsage,
  );
  const aTimeAttr = new T3.BufferAttribute(aTimeArr, 1).setUsage(
    T3.DynamicDrawUsage,
  );
  const valAttr = new T3.BufferAttribute(tVal, 1).setUsage(
    T3.DynamicDrawUsage,
  );
  tailGeo.setAttribute("position", posAttr);
  tailGeo.setAttribute("aTime", aTimeAttr);
  tailGeo.setAttribute("aVal", valAttr);
  tailGeo.setDrawRange(0, 0);
  tailGeo.boundingSphere = new T3.Sphere(new T3.Vector3(), 10);

  const uniforms = {
    uBg: { value: bgColor.clone() },
    uMode: { value: 0 }, // 0=按时间 1=按通道
    uSpan: { value: 1 }, // 会话时间跨度（秒）
    uValMin: { value: 0 },
    uValMax: { value: 1 },
    uNow: { value: 0 },
    uW: { value: 60 }, // 渐隐窗口秒；0=全程
    uPalette: { value: 0 }, // 0=turbo 1=viridis（色弱）
  };

  const VERT = /* glsl */ `
    attribute float aTime;
    attribute float aVal;
    uniform float uMode, uSpan, uValMin, uValMax, uNow, uW, uPalette;
    varying vec3 vBase;
    varying float vFade;
    vec3 turbo(float x) {
      x = clamp(x, 0.0, 1.0);
      vec3 c = vec3(
        0.13572138 + x*(4.61539260 + x*(-42.66032258 + x*(132.13108234 + x*(-152.94239396 + x*59.28637943)))),
        0.09140261 + x*(2.19418839 + x*( 4.84296658 + x*(-14.18503333 + x*(  4.27729857 + x*2.82956604)))),
        0.10667330 + x*(12.64194608 + x*(-60.58204836 + x*(110.36276771 + x*(-89.90310912 + x*27.34824973)))));
      return clamp(c, 0.0, 1.0);
    }
    vec3 viridis(float t) {
      const vec3 c0 = vec3(0.277727, 0.00540784, 0.334099);
      const vec3 c1 = vec3(0.105093, 1.40461, 1.38459);
      const vec3 c2 = vec3(-0.330862, 0.214848, 0.0950952);
      const vec3 c3 = vec3(-4.63423, -5.7991, -19.3324);
      const vec3 c4 = vec3(6.22827, 14.1799, 56.6906);
      const vec3 c5 = vec3(4.77638, -13.7451, -65.353);
      const vec3 c6 = vec3(-5.43546, 4.64585, 26.3124);
      return clamp(c0 + t*(c1 + t*(c2 + t*(c3 + t*(c4 + t*(c5 + t*c6))))), 0.0, 1.0);
    }
    void main() {
      float kTime = clamp(aTime / max(uSpan, 1e-3), 0.0, 1.0);
      float kVal = clamp((aVal - uValMin) / max(uValMax - uValMin, 1e-9), 0.0, 1.0);
      float k = uMode < 0.5 ? kTime : kVal;
      vBase = uPalette < 0.5 ? turbo(k) : viridis(k);
      float age = uNow - aTime;
      float f = uW > 0.0
        ? clamp(1.0 - age / uW, 0.0, 1.0)
        : clamp(1.0 - age / max(uSpan, 1e-3), 0.0, 1.0);
      vFade = mix(0.18, 1.0, f);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = 3.0;
    }
  `;
  const FRAG = /* glsl */ `
    precision highp float;
    uniform vec3 uBg;
    varying vec3 vBase;
    varying float vFade;
    void main() {
      gl_FragColor = vec4(mix(uBg, vBase, vFade), 1.0);
    }
  `;
  const tailMatLine = new T3.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const tailMatPoints = new T3.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const tailLine = new T3.Line(tailGeo, tailMatLine);
  const tailPoints = new T3.Points(tailGeo, tailMatPoints);
  tailLine.frustumCulled = false;
  tailPoints.frustumCulled = false;
  scene.add(tailLine);
  scene.add(tailPoints);

  // ---------- 全景层（单色暗线，形状保留） ----------
  const ovGeo = new T3.BufferGeometry();
  const ovPosAttr = new T3.BufferAttribute(oPos, 3).setUsage(
    T3.DynamicDrawUsage,
  );
  ovGeo.setAttribute("position", ovPosAttr);
  ovGeo.setDrawRange(0, 0);
  ovGeo.boundingSphere = new T3.Sphere(new T3.Vector3(), 10);
  const ovMat = new T3.LineBasicMaterial({
    color: 0x888888,
    transparent: true,
    opacity: 0.35,
  });
  const ovLine = new T3.Line(ovGeo, ovMat);
  ovLine.frustumCulled = false;
  scene.add(ovLine);

  // ---------- 网格 / 轴 / 标签（可整体重建） ----------
  const gridGroup = new T3.Group();
  scene.add(gridGroup);
  let axisLabels: THREE_NS.Sprite[] = [];

  function makeTextSprite(text: string, color: string, worldH: number): THREE_NS.Sprite {
    const pad = 8;
    const fs = 32;
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d")!;
    ctx.font = `${fs}px system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cv.width = w;
    cv.height = fs + pad * 2;
    const ctx2 = cv.getContext("2d")!;
    ctx2.font = `${fs}px system-ui, sans-serif`;
    ctx2.fillStyle = color;
    ctx2.textBaseline = "middle";
    ctx2.fillText(text, pad, cv.height / 2);
    const tex = new T3.CanvasTexture(cv);
    tex.colorSpace = T3.SRGBColorSpace;
    const mat = new T3.SpriteMaterial({ map: tex, transparent: true });
    const sp = new T3.Sprite(mat);
    sp.scale.set((worldH * w) / cv.height, worldH, 1);
    return sp;
  }

  function niceStep(raw: number): number {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const r = raw / p;
    return (r >= 5 ? 5 : r >= 2 ? 2 : 1) * p;
  }

  /** 重建网格：真实值 nice 刻度 → 归一化空间画线；轴标签带字段名 */
  function rebuildGrid(axN: [string, string, string], accent: string) {
    for (const c of gridGroup.children) {
      const l = c as THREE_NS.Line;
      if (l.geometry) l.geometry.dispose();
      const m = l.material as THREE_NS.Material;
      if (m) m.dispose();
    }
    gridGroup.clear();
    for (const s of axisLabels) {
      (s.material as THREE_NS.SpriteMaterial).map?.dispose();
      (s.material as THREE_NS.SpriteMaterial).dispose();
    }
    axisLabels = [];

    const gx = cssVar("--border", "#262b33");
    const gxc = cssVar("--text-dim", "#8b93a1");
    const ext = (bbMax[0] - bbMin[0]) || baseExtent;
    const ey = (bbMax[1] - bbMin[1]) || baseExtent;
    const ez = (bbMax[2] - bbMin[2]) || baseExtent;
    const span = Math.max(ext, ey, ez, baseExtent * 0.5, 1e-9);
    // 密度倍率（设置：网格 疏/标准/密）；步长仍走 nice 刻度保证整数感
    const dens = curSettings?.gridDensity ?? "std";
    const step = niceStep(span / 8) * (dens === "fine" ? 0.5 : dens === "coarse" ? 2 : 1);
    const yGround =
      anchor[1] -
      Math.max(bbMax[1] - anchor[1], bbMin[1] >= -Infinity ? anchor[1] - bbMin[1] : 0) -
      step * 0.5;
    const nx = Math.ceil((ext + step) / (2 * step)) * 2; // 步数
    const nz = Math.ceil((ez + step) / (2 * step)) * 2;
    // 网格中心贴包围盒中心（此前用 anchor：轨迹缓慢漂移未触发重锚时网格不跟随，
    // 轨迹会爬到网格外——用户反馈「网格不自适应」的真实原因）
    const cx = Number.isFinite(bbMin[0] + bbMax[0]) ? (bbMin[0] + bbMax[0]) / 2 : anchor[0];
    const cz = Number.isFinite(bbMin[2] + bbMax[2]) ? (bbMin[2] + bbMax[2]) / 2 : anchor[2];
    const pts: number[] = [];
    for (let i = -nx / 2; i <= nx / 2; i++) {
      const x = cx + i * step;
      pts.push(toN(x, 0), toN(yGround, 1), toN(cz - (nz / 2) * step, 2));
      pts.push(toN(x, 0), toN(yGround, 1), toN(cz + (nz / 2) * step, 2));
    }
    for (let i = -nz / 2; i <= nz / 2; i++) {
      const z = cz + i * step;
      pts.push(toN(cx - (nx / 2) * step, 0), toN(yGround, 1), toN(z, 2));
      pts.push(toN(cx + (nx / 2) * step, 0), toN(yGround, 1), toN(z, 2));
    }
    const g = new T3.BufferGeometry();
    g.setAttribute("position", new T3.Float32BufferAttribute(pts, 3));
    const gm = new T3.LineBasicMaterial({
      color: new T3.Color(gx),
      transparent: true,
      opacity: 0.5,
    });
    gridGroup.add(new T3.LineSegments(g, gm));

    // 三轴短线 + 标签（X 红 Y 绿 Z 蓝，RViz 惯例）
    const axisLen = (span * scale) / 2;
    const axes: [THREE_NS.Vector3, THREE_NS.Vector3, string, string, string][] = [
      [
        new T3.Vector3(0, toN(yGround, 1), 0),
        new T3.Vector3(axisLen, toN(yGround, 1), 0),
        "#e05252",
        "X",
        axN[0],
      ],
      [
        new T3.Vector3(0, toN(yGround, 1), 0),
        new T3.Vector3(0, toN(yGround, 1) + axisLen, 0),
        "#4caf50",
        "Y",
        axN[1],
      ],
      [
        new T3.Vector3(0, toN(yGround, 1), 0),
        new T3.Vector3(0, toN(yGround, 1), axisLen),
        "#4e9cef",
        "Z",
        axN[2],
      ],
    ];
    for (const [a, b, col, letter, field] of axes) {
      const ag = new T3.BufferGeometry().setFromPoints([a, b]);
      gridGroup.add(
        new T3.Line(ag, new T3.LineBasicMaterial({ color: col })),
      );
      const sp = makeTextSprite(
        field ? `${letter} ${field}` : letter,
        col === "#e05252" ? gxc : gxc,
        0.09,
      );
      sp.position.copy(b);
      sp.position.y += 0.05;
      axisLabels.push(sp);
      gridGroup.add(sp);
    }
    void accent;
    needsRender = true;
  }

  // ---------- 最新点标记 ----------
  const dotCv = document.createElement("canvas");
  {
    const c = dotCv.getContext("2d")!;
    dotCv.width = 64;
    dotCv.height = 64;
    const g = c.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.35, "#4e9cef");
    g.addColorStop(1, "rgba(78,156,239,0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(32, 32, 30, 0, Math.PI * 2);
    c.fill();
  }
  const dotTex = new T3.CanvasTexture(dotCv);
  const latestDot = new T3.Sprite(
    new T3.SpriteMaterial({ map: dotTex, transparent: true, depthTest: false }),
  );
  latestDot.scale.setScalar(0.06);
  latestDot.visible = false;
  latestDot.renderOrder = 10;
  scene.add(latestDot);

  // ---------- 时间游标（P70 T2）----------
  // null = 跟随最新；数值 = drawRange 二分截断 + uNow 锚定。回放 seek 向后
  // 不重建：场景缓冲 append-only 有序，截断即可"倒带"（详设 §1）。
  let curCursorSec: number | null = null;

  function applyCursor(sec: number | null) {
    curCursorSec = sec;
    if (sec === null || tCount + oCount === 0) {
      tailGeo.setDrawRange(0, tCount);
      ovGeo.setDrawRange(0, oCount);
      uniforms.uNow.value = lastT;
      if (tCount > 0) {
        latestDot.position.set(
          tPos[(tCount - 1) * 3],
          tPos[(tCount - 1) * 3 + 1],
          tPos[(tCount - 1) * 3 + 2],
        );
        latestDot.visible = !calibOn; // 校准模式下批次仍在泵入（轨迹隐身），最新点标记不出现
      } else {
        latestDot.visible = false;
      }
      needsRender = true;
      return;
    }
    const co = lowerBoundLe(oT, oCount, sec);
    const ct = lowerBoundLe(tT, tCount, sec);
    tailGeo.setDrawRange(0, ct);
    ovGeo.setDrawRange(0, co);
    uniforms.uNow.value = sec; // 渐隐窗口锚定游标：轨迹头部亮、尾部暗随游标移动
    if (ct > 0) {
      latestDot.position.set(
        tPos[(ct - 1) * 3],
        tPos[(ct - 1) * 3 + 1],
        tPos[(ct - 1) * 3 + 2],
      );
      latestDot.visible = !calibOn;
    } else if (co > 0) {
      latestDot.position.set(
        oPos[(co - 1) * 3],
        oPos[(co - 1) * 3 + 1],
        oPos[(co - 1) * 3 + 2],
      );
      latestDot.visible = !calibOn;
    } else {
      latestDot.visible = false;
    }
    needsRender = true;
  }

  // ---------- 测量层 ----------
  const measureGroup = new T3.Group();
  measureGroup.visible = false;
  measureGroup.renderOrder = 20;
  scene.add(measureGroup);
  // 端点缓存（真实值）：重锚定（anchor/scale 变化）后按新归一化重画
  let measureA: PickResult | null = null;
  let measureB: PickResult | null = null;

  function drawMeasure() {
    for (const c of [...measureGroup.children]) {
      const l = c as THREE_NS.Line;
      if (l.geometry) l.geometry.dispose();
      const m = l.material as THREE_NS.Material;
      if (m) m.dispose();
      measureGroup.remove(c);
    }
    const a = measureA;
    const b2 = measureB;
    if (!a || !b2) {
      measureGroup.visible = false;
      needsRender = true;
      return;
    }
    const pa = new T3.Vector3(
      (a.real[0] - anchor[0]) * scaleVec[0],
      (a.real[1] - anchor[1]) * scaleVec[1],
      (a.real[2] - anchor[2]) * scaleVec[2],
    );
    const pb = new T3.Vector3(
      (b2.real[0] - anchor[0]) * scaleVec[0],
      (b2.real[1] - anchor[1]) * scaleVec[1],
      (b2.real[2] - anchor[2]) * scaleVec[2],
    );
    const g = new T3.BufferGeometry().setFromPoints([pa, pb]);
    measureGroup.add(
      new T3.Line(
        g,
        new T3.LineBasicMaterial({ color: 0xe8a13c, depthTest: false }),
      ),
    );
    const dist = Math.hypot(
      a.real[0] - b2.real[0],
      a.real[1] - b2.real[1],
      a.real[2] - b2.real[2],
    );
    const label = makeTextSprite(`Δ ${formatNum(dist)}`, "#e8a13c", 0.09);
    label.position.copy(pa).add(pb).multiplyScalar(0.5);
    measureGroup.add(label);
    measureGroup.visible = !calibOn; // 校准模式隐藏测量层
    needsRender = true;
  }

  // ---------- 渲染循环 ----------
  let needsRender = true;
  let raf = 0;
  let visible = true;
  const io = new IntersectionObserver((es) => {
    visible = es[0]?.isIntersecting ?? true;
  });
  io.observe(host);

  interface Tween {
    p0: THREE_NS.Vector3;
    p1: THREE_NS.Vector3;
    t0v: THREE_NS.Vector3;
    t1v: THREE_NS.Vector3;
    start: number;
    dur: number;
  }
  let tween: Tween | null = null;
  const easeInOut = (u: number) =>
    u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

  let fps = 0;
  let frames = 0;
  let fpsT = performance.now();
  // 跟随模式（P70 T2）：target 每帧向锚点 lerp（指数平滑），camera 加同款
  // delta 保持视角偏移向量（Foxglove Position 档语义）；tween 进行时让路
  let follow = false;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (!visible) return;
    if (tween) {
      const u = Math.min(1, (now - tween.start) / tween.dur);
      const e = easeInOut(u);
      camera.position.lerpVectors(tween.p0, tween.p1, e);
      controls.target.lerpVectors(tween.t0v, tween.t1v, e);
      if (u >= 1) tween = null;
      needsRender = true;
    }
    controls.update();
    const dt = lastFrameT > 0 ? Math.min((now - lastFrameT) / 1000, 0.05) : 0;
    lastFrameT = now;
    const flying = keyFlight && flightKeys.size > 0;
    // 键盘飞行进行时跟随让路（否则 target 被拉回最新点，飞行无效）
    if (follow && !tween && !flying) {
      const n =
        curCursorSec === null
          ? tCount
          : lowerBoundLe(tT, tCount, curCursorSec);
      let px = 0;
      let py = 0;
      let pz = 0;
      if (n > 0) {
        px = tPos[(n - 1) * 3];
        py = tPos[(n - 1) * 3 + 1];
        pz = tPos[(n - 1) * 3 + 2];
      } else if (oCount > 0) {
        px = oPos[(oCount - 1) * 3];
        py = oPos[(oCount - 1) * 3 + 1];
        pz = oPos[(oCount - 1) * 3 + 2];
      }
      const dx = (px - controls.target.x) * 0.15;
      const dy = (py - controls.target.y) * 0.15;
      const dz = (pz - controls.target.z) * 0.15;
      if (dx * dx + dy * dy + dz * dz > 1e-12) {
        controls.target.x += dx;
        controls.target.y += dy;
        controls.target.z += dz;
        camera.position.x += dx;
        camera.position.y += dy;
        camera.position.z += dz;
        needsRender = true;
      }
    }
    // 键盘飞行步进（P72）：平移/升降 + 方向键绕目标旋转；比例速度（dist 越小越慢）
    if (flying && !tween && dt > 0) {
      const v = Math.max(camera.position.distanceTo(controls.target), 0.05) * 1.4 * dt;
      camera.getWorldDirection(FWD);
      FWD.y = 0;
      if (FWD.lengthSq() < 1e-8) FWD.set(0, 0, -1); // 俯视退化：退回 -Z 前向
      FWD.normalize();
      RGT.crossVectors(UP, FWD).normalize().negate(); // up×fwd = 左向 → 取反得右
      let mx = 0;
      let my = 0;
      let mz = 0;
      if (flightKeys.has("KeyW")) {
        mx += FWD.x;
        mz += FWD.z;
      }
      if (flightKeys.has("KeyS")) {
        mx -= FWD.x;
        mz -= FWD.z;
      }
      if (flightKeys.has("KeyD")) {
        mx += RGT.x;
        mz += RGT.z;
      }
      if (flightKeys.has("KeyA")) {
        mx -= RGT.x;
        mz -= RGT.z;
      }
      if (flightKeys.has("KeyE")) my += 1;
      if (flightKeys.has("KeyQ")) my -= 1;
      const mlen = Math.hypot(mx, my, mz);
      if (mlen > 0) {
        const k = v / mlen;
        camera.position.x += mx * k;
        camera.position.y += my * k;
        camera.position.z += mz * k;
        controls.target.x += mx * k;
        controls.target.y += my * k;
        controls.target.z += mz * k;
        needsRender = true;
      }
      const th = 1.8 * dt;
      let rot = false;
      OFF.subVectors(camera.position, controls.target);
      SPH.setFromVector3(OFF);
      if (flightKeys.has("ArrowLeft")) {
        SPH.theta += th;
        rot = true;
      }
      if (flightKeys.has("ArrowRight")) {
        SPH.theta -= th;
        rot = true;
      }
      if (flightKeys.has("ArrowUp")) {
        SPH.phi = Math.max(0.05, SPH.phi - th);
        rot = true;
      }
      if (flightKeys.has("ArrowDown")) {
        SPH.phi = Math.min(Math.PI - 0.05, SPH.phi + th);
        rot = true;
      }
      if (rot) {
        OFF.setFromSpherical(SPH);
        camera.position.copy(controls.target).add(OFF);
        needsRender = true;
      }
    }
    if (needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
    }
    frames++;
    if (now - fpsT >= 1000) {
      fps = Math.round((frames * 1000) / (now - fpsT));
      frames = 0;
      fpsT = now;
    }
  };
  raf = requestAnimationFrame(loop);

  const ro = new ResizeObserver(() => {
    const w = Math.max(host.clientWidth, 60);
    const h = Math.max(host.clientHeight, 60);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    needsRender = true;
  });
  ro.observe(host);

  const onCtxLost = (e: Event) => {
    e.preventDefault();
    cbs.onContextLost();
  };
  renderer.domElement.addEventListener("webglcontextlost", onCtxLost);

  // ---------- 追加 / 压实 / 重锚 ----------
  let dirtyFrom = -1; // 本轮脏区起点（上传优化）
  let lastT = 0;
  let valMin = Infinity;
  let valMax = -Infinity;
  let lastGridBuild = 0;
  let gridSig = "";
  let curSettings: Plot3DSettings | null = null;
  let curChans: Channel[] = [];
  let curAccent = "#4e9cef";

  // ---------- 校准层（P71/P73）：点云 + 线框 + 中心标记 + 残差着色 + 显示切换 ----------
  // raw 模式：归一化沿用轨迹 anchor/scale 流水线（同一数据源，量级一致；重锚时随 rewriteNorm 重写）
  // corrected 模式（P73）：W(x−offset) 校正后空间独立归一化（质心平移 + ā 缩放），与轨迹锚互不影响
  const CALIB_CAP_SCENE = 20000; // 与 plot3dStore.CALIB_CAP 一致（store 自动停止，此处防御）
  let calibOn = false;
  let calFit: FitOk | null = null;
  let calDisplay: "raw" | "corrected" = "raw";
  let calCValid = false; // corrected 归一化基准（calCenN/calScaleC）是否就绪
  const calCenN = new Float64Array(3); // corrected 空间点云质心（校正值域）
  let calScaleC = 1; // corrected → norm 缩放（VIEW_HALF / meanR）
  const calGroup = new T3.Group();
  calGroup.visible = false;
  scene.add(calGroup);
  const calReal = new Float64Array(CALIB_CAP_SCENE * 3);
  const calPosArr = new Float32Array(CALIB_CAP_SCENE * 3);
  const calColArr = new Float32Array(CALIB_CAP_SCENE * 3); // 顶点色（残差/面覆盖/accent）
  let calCount = 0;
  const calGeo = new T3.BufferGeometry();
  const calPosAttr = new T3.BufferAttribute(calPosArr, 3).setUsage(
    T3.DynamicDrawUsage,
  );
  calGeo.setAttribute("position", calPosAttr);
  const calColAttr = new T3.BufferAttribute(calColArr, 3).setUsage(
    T3.DynamicDrawUsage,
  );
  calGeo.setAttribute("color", calColAttr);
  calGeo.setDrawRange(0, 0);
  calGeo.boundingSphere = new T3.Sphere(new T3.Vector3(), 10);
  const calMat = new T3.PointsMaterial({
    size: 3.5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.9,
    vertexColors: true, // 颜色全部走顶点（残差/面/accent），material.color 恒白
    color: new T3.Color("#ffffff"),
  });
  const calPointsObj = new T3.Points(calGeo, calMat);
  calPointsObj.frustumCulled = false;
  calGroup.add(calPointsObj);
  const calWire = new T3.LineSegments(
    new T3.BufferGeometry(),
    new T3.LineBasicMaterial({
      color: new T3.Color("#4e9cef"),
      transparent: true,
      opacity: 0.95,
    }),
  );
  calWire.frustumCulled = false;
  calWire.visible = false;
  calGroup.add(calWire);
  // 参考球（corrected 模式）：三个大圆线框，半径 = ā·calScaleC = VIEW_HALF
  const calSphere = new T3.LineSegments(
    new T3.BufferGeometry(),
    new T3.LineBasicMaterial({
      color: new T3.Color("#4e9cef"),
      transparent: true,
      opacity: 0.6,
    }),
  );
  calSphere.frustumCulled = false;
  calSphere.visible = false;
  calGroup.add(calSphere);
  const calCenter = new T3.Sprite(
    new T3.SpriteMaterial({ map: dotTex, transparent: true, depthTest: false }),
  );
  calCenter.scale.setScalar(0.05);
  calCenter.visible = false;
  calCenter.renderOrder = 11;
  calGroup.add(calCenter);

  // 残差/覆盖色（P73）：±3% 绿 → ±8% 黄 → 出界 红；accentCol 为缺省顶点色
  const accentCol = new T3.Color("#4e9cef");
  const tmpCol = new T3.Color();
  const RESID_OK = new T3.Color("#3fbf6f");
  const RESID_WARN = new T3.Color("#e6c14a");
  const RESID_BAD = new T3.Color("#e05a4e");
  function residColor(k: number, out: THREE_NS.Color) {
    const d = Math.abs(k - 1);
    out.copy(d <= 0.03 ? RESID_OK : d <= 0.08 ? RESID_WARN : RESID_BAD);
  }

  /** 轨迹层/网格/校准层可见性统一裁决（applySettings 与 setCalibMode 共用，退出零重建） */
  function applyModeVis() {
    const s = curSettings;
    calGroup.visible = calibOn;
    tailLine.visible = !calibOn && (!s || s.style !== "points");
    tailPoints.visible = !calibOn && (!s || s.style !== "line");
    ovLine.visible = !calibOn;
    gridGroup.visible = !calibOn && (!s || s.showGrid);
    if (calibOn) {
      latestDot.visible = false;
      measureGroup.visible = false;
    }
    needsRender = true;
  }

  /** 校准点云按当前 anchor/scale 全量重写（raw 模式；重锚/firstData 换锚后调用；按模式分派） */
  function rewriteCalibNorm() {
    if (calCount === 0) return;
    if (calDisplay === "corrected" && calFit) {
      rebuildCalibCorrected();
      return;
    }
    for (let i = 0; i < calCount; i++) {
      const j = i * 3;
      calPosArr[j] = (calReal[j] - anchor[0]) * scaleVec[0];
      calPosArr[j + 1] = (calReal[j + 1] - anchor[1]) * scaleVec[1];
      calPosArr[j + 2] = (calReal[j + 2] - anchor[2]) * scaleVec[2];
    }
    uploadCalibPos();
  }

  function uploadCalibPos() {
    calPosAttr.clearUpdateRanges();
    calPosAttr.addUpdateRange(0, calCount * 3);
    calPosAttr.needsUpdate = true;
  }

  /** 单点校正后坐标 p' = W·(p − offset)（原始校正值域） */
  function correctInto(rx: number, ry: number, rz: number, fit: FitOk, out: Float64Array, o: number) {
    const W = fit.matrix;
    const dx = rx - fit.offset[0];
    const dy = ry - fit.offset[1];
    const dz = rz - fit.offset[2];
    out[o] = W[0][0] * dx + W[0][1] * dy + W[0][2] * dz;
    out[o + 1] = W[1][0] * dx + W[1][1] * dy + W[1][2] * dz;
    out[o + 2] = W[2][0] * dx + W[2][1] * dy + W[2][2] * dz;
  }

  /** corrected 显示几何重算：全量 W(x−offset) + 独立归一化（质心平移 + ā=meanR 缩放）。
   *  一次 O(n)（≤20000 点 ×15 FLOP）；calScaleC = VIEW_HALF/meanR → 参考球半径恰为 VIEW_HALF */
  function rebuildCalibCorrected() {
    if (!calFit || calCount === 0) return;
    const tmp = new Float64Array(3);
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < calCount; i++) {
      const j = i * 3;
      correctInto(calReal[j], calReal[j + 1], calReal[j + 2], calFit, tmp, 0);
      mx += tmp[0];
      my += tmp[1];
      mz += tmp[2];
    }
    calCenN[0] = mx / calCount;
    calCenN[1] = my / calCount;
    calCenN[2] = mz / calCount;
    calScaleC = calFit.meanR > 1e-12 ? VIEW_HALF / calFit.meanR : 1;
    for (let i = 0; i < calCount; i++) {
      const j = i * 3;
      correctInto(calReal[j], calReal[j + 1], calReal[j + 2], calFit, tmp, 0);
      calPosArr[j] = (tmp[0] - calCenN[0]) * calScaleC;
      calPosArr[j + 1] = (tmp[1] - calCenN[1]) * calScaleC;
      calPosArr[j + 2] = (tmp[2] - calCenN[2]) * calScaleC;
    }
    calCValid = true;
    uploadCalibPos();
  }

  /** 顶点色全量重算（残差着色 raw+fit / 其余 accent；面覆盖色在追加点写入后由增量着色保留）。
   *  注意：面覆盖色是采样期覆盖，重算（新拟合/换 accent）后回退残差/accent——语义正确 */
  function recolorAll() {
    if (calCount === 0) return;
    for (let i = 0; i < calCount; i++) {
      let c = accentCol;
      if (calFit && calDisplay === "raw") {
        const j = i * 3;
        residColor(correctedRadius(calReal[j], calReal[j + 1], calReal[j + 2], calFit) / calFit.meanR, tmpCol);
        c = tmpCol;
      }
      const j3 = i * 3;
      calColArr[j3] = c.r;
      calColArr[j3 + 1] = c.g;
      calColArr[j3 + 2] = c.b;
    }
    calColAttr.clearUpdateRanges();
    calColAttr.addUpdateRange(0, calCount * 3);
    calColAttr.needsUpdate = true;
  }

  /** 参考球线框（corrected 模式）：三个大圆，球心 = 校正空间原点映射，半径 = meanR·calScaleC */
  function buildCalibSphere() {
    if (!calFit) return;
    const SEG = 96;
    const cx = -calCenN[0] * calScaleC;
    const cy = -calCenN[1] * calScaleC;
    const cz = -calCenN[2] * calScaleC;
    const rN = calFit.meanR * calScaleC;
    const arr: number[] = [];
    const circles: [number, number][] = [
      [0, 1],
      [1, 2],
      [0, 2],
    ];
    for (const [a, b] of circles) {
      let px = 0;
      let py = 0;
      let pz = 0;
      for (let k = 0; k <= SEG; k++) {
        const t = (k / SEG) * Math.PI * 2;
        const p = [0, 0, 0];
        p[a] = Math.cos(t) * rN;
        p[b] = Math.sin(t) * rN;
        if (k > 0) {
          arr.push(cx + px, cy + py, cz + pz, cx + p[0], cy + p[1], cz + p[2]);
        }
        px = p[0];
        py = p[1];
        pz = p[2];
      }
    }
    calSphere.geometry.dispose();
    const g = new T3.BufferGeometry();
    g.setAttribute("position", new T3.Float32BufferAttribute(arr, 3));
    calSphere.geometry = g;
  }

  /** 校准层整体重建（setCalibEllipsoid / setCalibDisplay 共用）：位置 + 线框 + 着色 */
  function applyCalibView() {
    if (calCount === 0 || !calFit) {
      calWire.visible = false;
      calCenter.visible = false;
      calSphere.visible = false;
      if (calCount > 0) {
        rewriteCalibNorm(); // fit 清除 → 回 raw 位置
        recolorAll(); // 恢复 accent
      }
      needsRender = true;
      return;
    }
    if (calDisplay === "corrected") {
      calWire.visible = false;
      calCenter.visible = false;
      rebuildCalibCorrected();
      buildCalibSphere();
      calSphere.visible = true;
    } else {
      calSphere.visible = false;
      rewriteCalibNorm(); // corrected → raw 位置还原
      buildCalibWire(calFit);
      calWire.visible = true;
      calCenter.position.set(
        (calFit.offset[0] - anchor[0]) * scaleVec[0],
        (calFit.offset[1] - anchor[1]) * scaleVec[1],
        (calFit.offset[2] - anchor[2]) * scaleVec[2],
      );
      calCenter.visible = true;
    }
    recolorAll();
    needsRender = true;
  }

  /** 椭球线框（raw 模式）：三主平面参数椭圆（各 128 段）→ 单个 LineSegments；
   *  主轴 i/j：p = offset + e_i·a_i·cosθ + e_j·a_j·sinθ（rot 列 = 主方向单位向量） */
  function buildCalibWire(fit: FitOk) {
    const SEG = 128;
    const pairs: [number, number][] = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    const arr: number[] = [];
    const pushN = (p: number[]) => {
      arr.push(
        (p[0] - anchor[0]) * scaleVec[0],
        (p[1] - anchor[1]) * scaleVec[1],
        (p[2] - anchor[2]) * scaleVec[2],
      );
    };
    for (const [i, jj] of pairs) {
      const ei = [fit.rot[0][i], fit.rot[1][i], fit.rot[2][i]];
      const ej = [fit.rot[0][jj], fit.rot[1][jj], fit.rot[2][jj]];
      const ai = fit.axes[i];
      const aj = fit.axes[jj];
      let prev: number[] | null = null;
      for (let k = 0; k <= SEG; k++) {
        const t = (k / SEG) * Math.PI * 2;
        const ct = Math.cos(t);
        const st = Math.sin(t);
        const p = [
          fit.offset[0] + ei[0] * ai * ct + ej[0] * aj * st,
          fit.offset[1] + ei[1] * ai * ct + ej[1] * aj * st,
          fit.offset[2] + ei[2] * ai * ct + ej[2] * aj * st,
        ];
        if (prev) {
          pushN(prev);
          pushN(p);
        }
        prev = p;
      }
    }
    calWire.geometry.dispose();
    const g = new T3.BufferGeometry();
    g.setAttribute("position", new T3.Float32BufferAttribute(arr, 3));
    calWire.geometry = g;
  }

  // ---------- 键盘飞行（P72）：悬停画布时才响应，避免抢全局按键 ----------
  // WASD 平移（相机水平前向） / QE 升降（世界 Y） / 方向键绕目标旋转 /
  // F 跟随开关（回调 UI 层） / R 重置视角；比例速度（离目标越近飞得越慢）
  let keyFlight = false;
  let canvasHover = false;
  let lastFrameT = 0;
  const flightKeys = new Set<string>();
  const FLIGHT_CODES = new Set([
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "KeyQ",
    "KeyE",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]);
  const UP = new T3.Vector3(0, 1, 0);
  const FWD = new T3.Vector3();
  const RGT = new T3.Vector3();
  const OFF = new T3.Vector3();
  const SPH = new T3.Spherical();

  const onCanvasEnter = () => {
    canvasHover = true;
  };
  const onCanvasLeave = () => {
    canvasHover = false;
    flightKeys.clear();
  };
  const handleFlightKey = (e: KeyboardEvent, down: boolean) => {
    if (!keyFlight || !canvasHover) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable)) {
      return;
    }
    if (down && !e.repeat && e.code === "KeyF") {
      cbs.onToggleFollow?.();
      return;
    }
    if (down && !e.repeat && e.code === "KeyR") {
      api.resetView();
      return;
    }
    if (!FLIGHT_CODES.has(e.code)) return;
    e.preventDefault(); // 方向键防页面滚动
    if (down) flightKeys.add(e.code);
    else flightKeys.delete(e.code);
  };
  const onFlightKeyDown = (e: KeyboardEvent) => handleFlightKey(e, true);
  const onFlightKeyUp = (e: KeyboardEvent) => handleFlightKey(e, false);
  const onFlightBlur = () => flightKeys.clear();
  renderer.domElement.addEventListener("pointerenter", onCanvasEnter);
  renderer.domElement.addEventListener("pointerleave", onCanvasLeave);
  window.addEventListener("keydown", onFlightKeyDown);
  window.addEventListener("keyup", onFlightKeyUp);
  window.addEventListener("blur", onFlightBlur);

  function uploadTail(from: number) {
    if (dirtyFrom < 0 || from < dirtyFrom) dirtyFrom = from;
  }
  function flushTail() {
    if (dirtyFrom < 0) return;
    const n = tCount - dirtyFrom;
    if (n > 0) {
      posAttr.clearUpdateRanges();
      posAttr.addUpdateRange(dirtyFrom * 3, n * 3);
      posAttr.needsUpdate = true;
      aTimeAttr.clearUpdateRanges();
      aTimeAttr.addUpdateRange(dirtyFrom, n);
      aTimeAttr.needsUpdate = true;
      valAttr.clearUpdateRanges();
      valAttr.addUpdateRange(dirtyFrom, n);
      valAttr.needsUpdate = true;
    }
    dirtyFrom = -1;
  }

  function ovAppendChunk(real: Float64Array, t: Float64Array, val: Float32Array, s: number, e: number) {
    for (let i = s; i < e; i++) {
      if (oCount >= OVERVIEW_CAP) ovHalve();
      const j = oCount * 3;
      oPos[j] = (real[i * 3] - anchor[0]) * scaleVec[0];
      oPos[j + 1] = (real[i * 3 + 1] - anchor[1]) * scaleVec[1];
      oPos[j + 2] = (real[i * 3 + 2] - anchor[2]) * scaleVec[2];
      oReal[j] = real[i * 3];
      oReal[j + 1] = real[i * 3 + 1];
      oReal[j + 2] = real[i * 3 + 2];
      oT[oCount] = t[i];
      oVal[oCount] = val[i];
      oCount++;
    }
    ovPosAttr.clearUpdateRanges();
    ovPosAttr.addUpdateRange(0, oCount * 3);
    ovPosAttr.needsUpdate = true;
    ovGeo.setDrawRange(0, oCount);
  }

  /** 全景满 → 2:1 对数减半（保留末点），全程形状不丢 */
  function ovHalve() {
    let j = 0;
    for (let i = 0; i < oCount; i += 2) {
      if (i !== oCount - 1 || oCount % 2 === 1) {
        const s3 = i * 3;
        const d3 = j * 3;
        oPos[d3] = oPos[s3];
        oPos[d3 + 1] = oPos[s3 + 1];
        oPos[d3 + 2] = oPos[s3 + 2];
        oReal[d3] = oReal[s3];
        oReal[d3 + 1] = oReal[s3 + 1];
        oReal[d3 + 2] = oReal[s3 + 2];
        oT[j] = oT[i];
        oVal[j] = oVal[i];
        j++;
      }
    }
    // 强制保留末点（连续性）
    if (oT[j - 1] !== oT[oCount - 1]) {
      const s3 = (oCount - 1) * 3;
      const d3 = j * 3;
      oPos[d3] = oPos[s3];
      oPos[d3 + 1] = oPos[s3 + 1];
      oPos[d3 + 2] = oPos[s3 + 2];
      oReal[d3] = oReal[s3];
      oReal[d3 + 1] = oReal[s3 + 1];
      oReal[d3 + 2] = oReal[s3 + 2];
      oT[j] = oT[oCount - 1];
      oVal[j] = oVal[oCount - 1];
      j++;
    }
    oCount = j;
  }

  function recomputeBBox(fromTail: number, fromOv: number) {
    bbMin[0] = bbMin[1] = bbMin[2] = Infinity;
    bbMax[0] = bbMax[1] = bbMax[2] = -Infinity;
    const scan = (real: Float64Array, s: number, e: number) => {
      for (let i = s; i < e; i++) {
        for (let a = 0; a < 3; a++) {
          const v = real[i * 3 + a];
          if (v < bbMin[a]) bbMin[a] = v;
          if (v > bbMax[a]) bbMax[a] = v;
        }
      }
    };
    scan(oReal, fromOv, oCount);
    scan(tReal, fromTail, tCount);
  }

  function rewriteNorm() {
    for (let i = 0; i < oCount; i++) {
      const j = i * 3;
      oPos[j] = (oReal[j] - anchor[0]) * scaleVec[0];
      oPos[j + 1] = (oReal[j + 1] - anchor[1]) * scaleVec[1];
      oPos[j + 2] = (oReal[j + 2] - anchor[2]) * scaleVec[2];
    }
    for (let i = 0; i < tCount; i++) {
      const j = i * 3;
      tPos[j] = (tReal[j] - anchor[0]) * scaleVec[0];
      tPos[j + 1] = (tReal[j + 1] - anchor[1]) * scaleVec[1];
      tPos[j + 2] = (tReal[j + 2] - anchor[2]) * scaleVec[2];
    }
    rewriteCalibNorm();
    ovPosAttr.clearUpdateRanges();
    ovPosAttr.addUpdateRange(0, oCount * 3);
    ovPosAttr.needsUpdate = true;
    posAttr.clearUpdateRanges();
    posAttr.addUpdateRange(0, tCount * 3);
    posAttr.needsUpdate = true;
    if (measureA && measureB) drawMeasure(); // 重锚后按新归一化重画测量线
  }

  function maybeReanchor(forceGrid: boolean) {
    if (tCount + oCount === 0) return;
    const ext = Math.max(
      bbMax[0] - bbMin[0],
      bbMax[1] - bbMin[1],
      bbMax[2] - bbMin[2],
    );
    if (!isFinite(ext)) return;
    const cx = (bbMin[0] + bbMax[0]) / 2;
    const cy = (bbMin[1] + bbMax[1]) / 2;
    const cz = (bbMin[2] + bbMax[2]) / 2;
    // 漂移判定换算到归一化空间（perAxis 时各轴权重不同；uniform 下与旧式
    // drift > (VIEW_HALF*2/scale)·0.4 完全等价）
    const driftN =
      Math.abs(cx - anchor[0]) * scaleVec[0] +
      Math.abs(cy - anchor[1]) * scaleVec[1] +
      Math.abs(cz - anchor[2]) * scaleVec[2];
    const needMove = driftN > VIEW_HALF * 2 * 0.4;
    const needScale = ext > baseExtent * 2.2 || ext < baseExtent / 2.2;
    if (!needMove && !needScale) {
      // 网格节流重建：包围盒变化 >25% 且距上次 ≥1s
      const now = performance.now();
      const sig2 = `${ext.toFixed(6)}|${cx.toFixed(4)}|${cz.toFixed(4)}`;
      if ((forceGrid || sig2 !== gridSig) && now - lastGridBuild > 1000) {
        gridSig = sig2;
        lastGridBuild = now;
        rebuildGrid(axisFieldNames(), curAccent);
      }
      return;
    }
    anchor[0] = cx;
    anchor[1] = cy;
    anchor[2] = cz;
    baseExtent = Math.max(ext, 1e-9);
    scale = (VIEW_HALF * 2) / baseExtent;
    updateScaleVec();
    rewriteNorm();
    rebuildGrid(axisFieldNames(), curAccent);
    gridSig = `${ext.toFixed(6)}|${cx.toFixed(4)}|${cz.toFixed(4)}`;
    lastGridBuild = performance.now();
    needsRender = true;
  }

  function axisFieldNames(): [string, string, string] {
    const find = (id: string) => curChans.find((c) => c.id === id)?.name ?? "";
    return [
      find(curSettings?.axisX ?? ""),
      find(curSettings?.axisY ?? ""),
      find(curSettings?.axisZ ?? ""),
    ];
  }

  // ---------- 对外接口 ----------
  const api: Plot3DScene = {
    applyBatch(b, reloaded, cursorSec) {
      if (reloaded) {
        tCount = 0;
        oCount = 0;
        valMin = Infinity;
        valMax = -Infinity;
        tailGeo.setDrawRange(0, 0);
        ovGeo.setDrawRange(0, 0);
        latestDot.visible = false;
        measureA = null;
        measureB = null;
        measureGroup.visible = false;
        dirtyFrom = 0;
        curCursorSec = null;
        if (b.t.length === 0) {
          applyCursor(cursorSec);
          return;
        }
      }
      if (b.t.length === 0) {
        // 空批次 + 游标变化（如回放 seek 向后：重灌点全 ≤ 水位）→ 仅更新游标
        applyCursor(cursorSec);
        return;
      }

      const firstData = tCount === 0 && oCount === 0;
      // 首批数据 → 建立锚定
      if (firstData) {
        const mn = [Infinity, Infinity, Infinity];
        const mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < b.t.length; i++) {
          const vs = [b.x[i], b.y[i], b.z[i]];
          for (let a = 0; a < 3; a++) {
            if (vs[a] < mn[a]) mn[a] = vs[a];
            if (vs[a] > mx[a]) mx[a] = vs[a];
          }
        }
        for (let a = 0; a < 3; a++) {
          anchor[a] = (mn[a] + mx[a]) / 2;
          bbMin[a] = mn[a];
          bbMax[a] = mx[a];
        }
        baseExtent = Math.max(
          mx[0] - mn[0],
          mx[1] - mn[1],
          mx[2] - mn[2],
          1e-9,
        );
        scale = (VIEW_HALF * 2) / baseExtent;
        updateScaleVec(); // perAxis：首批即按三轴各自跨度撑满（uniform 下三值 = scale）
        rewriteCalibNorm(); // 清空轨迹后重锚：校准点云随新锚重写，避免滞留旧坐标系
      }

      for (let i = 0; i < b.t.length; i++) {
        if (tCount >= TAIL_CAP) {
          // 尾窗满：最老一半压入全景，剩余前移（单次 copyWithin，非逐点 shift）
          const half = TAIL_CAP >> 1;
          ovAppendChunk(tReal, tT, tVal, 0, half);
          tPos.copyWithin(0, half * 3, tCount * 3);
          tReal.copyWithin(0, half * 3, tCount * 3);
          aTimeArr.copyWithin(0, half, tCount);
          tT.copyWithin(0, half, tCount);
          tVal.copyWithin(0, half, tCount);
          tCount -= half;
          dirtyFrom = 0;
          recomputeBBox(0, 0);
        }
        const j = tCount * 3;
        const rx = b.x[i];
        const ry = b.y[i];
        const rz = b.z[i];
        tReal[j] = rx;
        tReal[j + 1] = ry;
        tReal[j + 2] = rz;
        tPos[j] = (rx - anchor[0]) * scaleVec[0];
        tPos[j + 1] = (ry - anchor[1]) * scaleVec[1];
        tPos[j + 2] = (rz - anchor[2]) * scaleVec[2];
        tT[tCount] = b.t[i];
        aTimeArr[tCount] = b.t[i];
        tVal[tCount] = b.val[i];
        if (b.val[i] < valMin) valMin = b.val[i];
        if (b.val[i] > valMax) valMax = b.val[i];
        for (let a = 0; a < 3; a++) {
          const v = a === 0 ? rx : a === 1 ? ry : rz;
          if (v < bbMin[a]) bbMin[a] = v;
          if (v > bbMax[a]) bbMax[a] = v;
        }
        tCount++;
        uploadTail(tCount - 1);
      }

      lastT = b.t[b.t.length - 1];
      uniforms.uNow.value = lastT;
      uniforms.uSpan.value = Math.max(lastT, 1e-3);
      if (isFinite(valMin) && isFinite(valMax)) {
        uniforms.uValMin.value = valMin;
        uniforms.uValMax.value = valMax;
      }
      maybeReanchor(firstData);
      flushTail();
      // 游标收尾：null = 恢复全量（与上面 uNow/drawRange 一致）；数值 = 覆盖截断
      applyCursor(cursorSec);
    },

    applySettings(s, chans, cbSafe, accent) {
      const prevAxisScale = curSettings?.axisScale;
      curSettings = s;
      curChans = chans;
      curAccent = accent;
      // P75 B2：等比/逐轴切换 → 重算逐轴缩放并全量重写归一化坐标
      // （updateScaleVec 须先于 rebuildGrid：网格线端点同样经 toN 映射）
      if (prevAxisScale !== s.axisScale && (tCount > 0 || oCount > 0)) {
        updateScaleVec();
        rewriteNorm();
      }
      calMat.color.set(accent); // 校准点云/线框随主题 accent
      (calWire.material as THREE_NS.LineBasicMaterial).color.set(accent);
      uniforms.uW.value = s.fade;
      uniforms.uMode.value = s.colorBy === "ch" ? 1 : 0;
      uniforms.uPalette.value = cbSafe ? 1 : 0;
      controls.autoRotate = s.autoRotate;
      controls.autoRotateSpeed = 1.2;
      controls.zoomToCursor = s.zoomToCursor; // P72：滚轮缩放到光标（three r151+ 原生支持）
      applyModeVis(); // 轨迹/网格/校准层可见性统一裁决（含 calibOn 门控）
      rebuildGrid(axisFieldNames(), accent);
      needsRender = true;
    },

    applyTheme() {
      const bg = new T3.Color(cssVar("--bg-inset", "#0b0d10"));
      uniforms.uBg.value.copy(bg);
      scene.background = bg;
      const ovCol = new T3.Color(cssVar("--text-dim", "#8b93a1"));
      ovMat.color.copy(ovCol);
      if (curChans.length) {
        rebuildGrid(axisFieldNames(), curAccent);
      }
      needsRender = true;
    },

    setViewPreset(p) {
      const d = camera.position.distanceTo(controls.target) || 2.6;
      const t = controls.target.clone();
      let pos: THREE_NS.Vector3;
      if (p === "top") pos = new T3.Vector3(t.x, t.y + d, t.z + 1e-4 * d);
      else if (p === "side") pos = new T3.Vector3(t.x + d, t.y, t.z);
      else if (p === "front") pos = new T3.Vector3(t.x, t.y, t.z + d);
      else
        pos = new T3.Vector3(
          t.x + 0.62 * d,
          t.y + 0.5 * d,
          t.z + 0.62 * d,
        );
      tween = {
        p0: camera.position.clone(),
        p1: pos,
        t0v: t.clone(),
        t1v: t.clone(),
        start: performance.now(),
        dur: 600,
      };
    },

    resetView() {
      tween = {
        p0: camera.position.clone(),
        p1: new T3.Vector3(1.9, 1.5, 2.1),
        t0v: controls.target.clone(),
        t1v: new T3.Vector3(0, 0, 0),
        start: performance.now(),
        dur: 600,
      };
    },

    focusLatest() {
      if (tCount === 0) return;
      const p = new T3.Vector3(
        tPos[(tCount - 1) * 3],
        tPos[(tCount - 1) * 3 + 1],
        tPos[(tCount - 1) * 3 + 2],
      );
      tween = {
        p0: camera.position.clone(),
        p1: camera.position.clone(),
        t0v: controls.target.clone(),
        t1v: p,
        start: performance.now(),
        dur: 400,
      };
    },

    focusPoint(real) {
      const p = new T3.Vector3(
        (real[0] - anchor[0]) * scaleVec[0],
        (real[1] - anchor[1]) * scaleVec[1],
        (real[2] - anchor[2]) * scaleVec[2],
      );
      tween = {
        p0: camera.position.clone(),
        p1: camera.position.clone(),
        t0v: controls.target.clone(),
        t1v: p,
        start: performance.now(),
        dur: 400,
      };
    },

    setAutoRotate(on) {
      controls.autoRotate = on;
      needsRender = true;
    },

    setTimeCursor(relSec) {
      applyCursor(relSec);
    },

    setFollow(on) {
      follow = on;
      needsRender = true;
    },

    setMeasure(a, b2) {
      measureA = a;
      measureB = b2;
      drawMeasure();
    },

    // ---------- 校准模式（P71）----------
    setCalibMode(on) {
      calibOn = on;
      applyModeVis(); // 退出零重建：轨迹层 visible 恢复即可
    },

    setCalibPoints(pts, from, colorHex) {
      const nx = pts.x.length;
      if (nx <= from) return;
      const overrideCol = colorHex ? tmpCol.set(colorHex) : null;
      // corrected 模式且基准未建（拟合后首批点）→ 先以现有点建归一化基准
      if (calDisplay === "corrected" && calFit && !calCValid) rebuildCalibCorrected();
      const corrected = calDisplay === "corrected" && calFit && calCValid;
      const tmp = new Float64Array(3);
      const startIdx = calCount;
      for (let i = from; i < nx; i++) {
        if (calCount >= CALIB_CAP_SCENE) break; // store 侧 CAP 自动停，此处防御
        const j = calCount * 3;
        const rx = pts.x[i];
        const ry = pts.y[i];
        const rz = pts.z[i];
        calReal[j] = rx;
        calReal[j + 1] = ry;
        calReal[j + 2] = rz;
        if (corrected && calFit) {
          correctInto(rx, ry, rz, calFit, tmp, 0);
          calPosArr[j] = (tmp[0] - calCenN[0]) * calScaleC;
          calPosArr[j + 1] = (tmp[1] - calCenN[1]) * calScaleC;
          calPosArr[j + 2] = (tmp[2] - calCenN[2]) * calScaleC;
        } else {
          calPosArr[j] = (rx - anchor[0]) * scaleVec[0];
          calPosArr[j + 1] = (ry - anchor[1]) * scaleVec[1];
          calPosArr[j + 2] = (rz - anchor[2]) * scaleVec[2];
        }
        // 顶点色：面覆盖色 > 残差着色（raw+fit）> accent
        let c: THREE_NS.Color = accentCol;
        if (overrideCol) c = overrideCol;
        else if (calFit && calDisplay === "raw") {
          residColor(correctedRadius(rx, ry, rz, calFit!) / calFit!.meanR, tmpCol);
          c = tmpCol;
        }
        calColArr[j] = c.r;
        calColArr[j + 1] = c.g;
        calColArr[j + 2] = c.b;
        calCount++;
      }
      if (calCount === startIdx) return;
      uploadCalibPos();
      calColAttr.clearUpdateRanges();
      calColAttr.addUpdateRange(startIdx * 3, (calCount - startIdx) * 3);
      calColAttr.needsUpdate = true;
      calGeo.setDrawRange(0, calCount);
      needsRender = true;
    },

    resetCalibView() {
      calCount = 0;
      calFit = null;
      calDisplay = "raw"; // 清空即回原始显示（UI 状态同步复位，避免残留 corrected 空壳）
      calCValid = false;
      calGeo.setDrawRange(0, 0);
      calWire.visible = false;
      calSphere.visible = false;
      calCenter.visible = false;
      needsRender = true;
    },

    setCalibEllipsoid(fit) {
      calFit = fit;
      calCValid = false;
      applyCalibView(); // 线框/参考球/位置/着色统一重建（含 null 清除）
    },

    setCalibDisplay(mode) {
      if (calDisplay === mode) return;
      calDisplay = mode;
      calCValid = false;
      applyCalibView();
    },

    // ---------- 键盘飞行 / 快照（P72）----------
    setKeyFlight(on) {
      keyFlight = on;
      if (!on) flightKeys.clear();
    },

    snapshotPng() {
      renderer.render(scene, camera); // 同步渲染一帧后再取像素（无需 preserveDrawingBuffer）
      needsRender = false;
      return renderer.domElement.toDataURL("image/png");
    },

    clearTrajectory() {
      tCount = 0;
      oCount = 0;
      valMin = Infinity;
      valMax = -Infinity;
      tailGeo.setDrawRange(0, 0);
      ovGeo.setDrawRange(0, 0);
      latestDot.visible = false;
      measureA = null;
      measureB = null;
      measureGroup.visible = false;
      bbMin[0] = bbMin[1] = bbMin[2] = Infinity;
      bbMax[0] = bbMax[1] = bbMax[2] = -Infinity;
      uniforms.uNow.value = 0;
      uniforms.uSpan.value = 1;
      needsRender = true;
    },

    pick(px, py) {
      if (tCount + oCount === 0) return null;
      camera.updateMatrixWorld();
      const rect = renderer.domElement.getBoundingClientRect();
      const vp = new T3.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      const v = new T3.Vector4();
      const search = (
        pos: Float32Array,
        count: number,
      ): { idx: number; d: number } | null => {
        if (count === 0) return null;
        const stride = Math.max(1, Math.floor(count / 1200));
        let best = -1;
        let bd = Infinity;
        for (let i = 0; i < count; i += stride) {
          v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 1).applyMatrix4(vp);
          if (v.w <= 0) continue;
          const sx = ((v.x / v.w + 1) / 2) * rect.width + rect.left;
          const sy = ((1 - (v.y / v.w + 1) / 2) * rect.height) + rect.top;
          const dx = sx - px;
          const dy = sy - py;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (best < 0) return null;
        // 邻域精化
        const lo = Math.max(0, best - stride);
        const hi = Math.min(count - 1, best + stride);
        for (let i = lo; i <= hi; i++) {
          v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 1).applyMatrix4(vp);
          if (v.w <= 0) continue;
          const sx = ((v.x / v.w + 1) / 2) * rect.width + rect.left;
          const sy = ((1 - (v.y / v.w + 1) / 2) * rect.height) + rect.top;
          const dx = sx - px;
          const dy = sy - py;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        return { idx: best, d: Math.sqrt(bd) };
      };
      const tHit = search(tPos, tCount);
      const oHit = search(oPos, oCount);
      const useOv =
        oHit !== null && (tHit === null || oHit.d < tHit.d) && oHit.d <= 14;
      const hit = useOv ? oHit : tHit;
      if (!hit || hit.d > 14) return null;
      const inOv = useOv;
      const i = hit.idx;
      const real: [number, number, number] = inOv
        ? [oReal[i * 3], oReal[i * 3 + 1], oReal[i * 3 + 2]]
        : [tReal[i * 3], tReal[i * 3 + 1], tReal[i * 3 + 2]];
      v.set(
        inOv ? oPos[i * 3] : tPos[i * 3],
        inOv ? oPos[i * 3 + 1] : tPos[i * 3 + 1],
        inOv ? oPos[i * 3 + 2] : tPos[i * 3 + 2],
        1,
      ).applyMatrix4(vp);
      const sx = ((v.x / v.w + 1) / 2) * rect.width + rect.left;
      const sy = (1 - (v.y / v.w + 1) / 2) * rect.height + rect.top;
      return {
        tSec: inOv ? oT[i] : tT[i],
        real,
        val: inOv ? oVal[i] : tVal[i],
        screen: [sx, sy],
        distPx: hit.d,
      };
    },

    stats() {
      return { tail: tCount, overview: oCount, fps };
    },

    dispose() {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", onCtxLost);
      renderer.domElement.removeEventListener("pointerenter", onCanvasEnter);
      renderer.domElement.removeEventListener("pointerleave", onCanvasLeave);
      window.removeEventListener("keydown", onFlightKeyDown);
      window.removeEventListener("keyup", onFlightKeyUp);
      window.removeEventListener("blur", onFlightBlur);
      controls.dispose();
      scene.traverse((obj) => {
        const l = obj as THREE_NS.Line & THREE_NS.Sprite;
        if (l.geometry) l.geometry.dispose();
        const m = (l as unknown as { material?: THREE_NS.Material | THREE_NS.Material[] })
          .material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else if (m) m.dispose();
        const sp = obj as THREE_NS.Sprite;
        if (sp.material && (sp.material as THREE_NS.SpriteMaterial).map) {
          (sp.material as THREE_NS.SpriteMaterial).map?.dispose();
        }
      });
      dotTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
    },
  };

  return api;
}

function formatNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.001) return v.toFixed(5);
  return v.toExponential(2);
}

/**
 * 升序 Float64Array 中「末个 ≤ v」的下标 + 1（= drawRange 截断数）。
 * 导出仅供 vitest 验证边界（空/首/尾/重复 ts）；scene 内用于时间游标截断。
 */
export function lowerBoundLe(arr: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
