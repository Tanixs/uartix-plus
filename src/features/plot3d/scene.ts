/**
 * P69 3D 轨迹面板渲染核心（纯 three.js，无 React 依赖）· P87a 三组轨迹升级。
 *
 * 性能架构（对照详设 §10 + 评审优化，P87a §7）：
 * - 逐组双层 LOD：每组「全精度尾窗（12 万点，追加式 + 满时最老一半压入全景）+
 *   抽稀全景（10 万点上限，满时 2:1 对数减半）」，缓冲按组懒建——point 模式
 *   只留最新点零缓冲（内存 O(1) 红线）；组 maxPoints>0 时超限从最老端丢弃。
 * - 重锚/包围盒 = 全组并集（三组共享世界坐标语义；组1 大坐标经纬度与组3 米级
 *   小坐标共存不炸精度）；真实值 f64 副列 + 归一化 f32 主列不变。
 * - 着色全部在顶点着色器完成（turbo/viridis × 时间/通道/固定组色 × 渐隐 ×
 *   透明度），CPU 每点只写 aTime/aVal 两个标量；逐组 uniform，切主题只改副本。
 * - 连线平滑（P87a = 滑动平均）：几何列从真实值副列重算（recomputeTailPos），
 *   pick/测量/导出仍读原始真实值——平滑只影响视觉不篡改数据。
 * - needsRender 脏标记：数据追加 / controls change / 相机动画 / resize 才渲染，
 *   相机静止且无新数据时 GPU 0 负载；dpr 上限 2。
 * - 面板生命周期：IntersectionObserver 不可见即跳渲染；dispose 全量释放。
 */
import type * as THREE_NS from "three";
import type { Channel } from "../plot/plotStore";
import type { GroupBatch, Plot3DBatch, Plot3DSettings, TrajGroup, GroupId } from "./plot3dStore";
import { correctedRadius, type FitOk } from "./ellipsoidFit";
import { kernelFor } from "./smoothing";

/** 全精度尾窗容量（点/组） */
const TAIL_CAP = 120000;
/** 抽稀全景容量（点/组） */
const OVERVIEW_CAP = 100000;
/** 归一化视界半宽：norm 坐标映射到 ±VIEW_HALF */
const VIEW_HALF = 0.8;
/** P87b：细分平滑层窗口（原始段数上限，超出滑窗重算；暗线全景始终原始） */
const SMOOTH_W = 20000;
const SMOOTH_SUB_MAX = 10;
const SMOOTH_CAP = SMOOTH_W * SMOOTH_SUB_MAX + 16;

export interface PickResult {
  tSec: number;
  real: [number, number, number];
  val: number;
  /** 画布 CSS 像素 */
  screen: [number, number];
  distPx: number;
  /** P87a：命中的组（tooltip 归属 + 复制来源） */
  gid: GroupId;
}

export type ViewPreset = "top" | "side" | "front" | "iso";

export interface GroupStats {
  tail: number;
  overview: number;
}

export interface Plot3DScene {
  /** P87a：批次按组分发；空数组 + cursorSec 变化 = 仅更新游标 */
  applyBatch(entries: GroupBatch[], cursorSec: number | null): void;
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
  /** 聚焦某组轨迹包围盒（组行双击/定位菜单） */
  focusGroup(gid: GroupId): void;
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
  /** P87b：注入组模型的二进制（GLTF/GLB bytes；null=失败，scene 回退箭头）。
   *  bytes 由 UI 侧读文件（scene 不碰 IPC），按 cfg.model.src 缓存解析结果 */
  beginModelRequest(gid: GroupId): symbol | null;
  /** Pass the token captured before disk I/O; omitted only for synchronous injection. */
  setModelBytes(gid: GroupId, bytes: ArrayBuffer | null, request?: symbol): void;
  /** P87b：时间标注（会话 annotate 相对秒列表）→ 主组轨迹立旗标（≤48，超出取最近 48） */
  setAnnots(relSecs: number[]): void;
  /** 强制渲染一帧并返回 PNG dataURL（快照导出用） */
  snapshotPng(): string;
  /** 清空某组（或全部）场景缓冲（store 水位由 UI 先行推进） */
  clearTrajectory(gid?: GroupId): void;
  pick(px: number, py: number): PickResult | null;
  stats(): { groups: Record<GroupId, GroupStats>; fps: number; gridStep: number };
  dispose(): void;
}

/** CSS 变量 → 实色（含回退） */
function cssVar(name: string, fb: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}

export async function createScene(
  host: HTMLElement,
  cbs: {
    onContextLost: () => void;
    onToggleFollow?: () => void;
    /** P87b：gltf 文件读/解析失败回调（UI toast + 场景回退箭头占位） */
    onModelError?: (gid: GroupId, src: string) => void;
  },
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

  // ---------- 归一化锚定（全局，跨组并集） ----------
  // norm = (real - anchor) * scaleVec[axis]
  // P75 B2：scale 为等比基准；scaleVec 为实际生效的逐轴缩放——
  // uniform 模式三值恒等于 scale；perAxis 各轴独立撑满视锥（退化/无数据轴回退 scale）。
  const anchor = [0, 0, 0];
  let scale = 1;
  const scaleVec: [number, number, number] = [1, 1, 1];
  const toN = (v: number, i: 0 | 1 | 2) => (v - anchor[i]) * scaleVec[i];
  let baseExtent = 1; // 建立 scale 时的包围盒跨度
  let curSettings: Plot3DSettings | null = null;
  let curChans: Channel[] = [];
  let curAccent = "#4e9cef";

  const toModeVal = (g: TrajGroup): number =>
    g.colorBy === "time" ? 0 : g.colorBy === "ch" ? 1 : 2;

  /** 按当前设置与并集包围盒重算逐轴缩放（重锚/首批数据/切换 axisScale 时调用） */
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

  // ---------- 逐组状态与图层 ----------
  interface GState {
    gid: GroupId;
    cfg: TrajGroup;
    // 缓冲（懒建：首帧非空批次才分配）
    tPos: Float32Array | null;
    tReal: Float64Array | null;
    tT: Float64Array | null;
    tVal: Float32Array | null;
    tCount: number;
    oPos: Float32Array | null;
    oReal: Float64Array | null;
    oT: Float64Array | null;
    oVal: Float32Array | null;
    oCount: number;
    tailGeo: THREE_NS.BufferGeometry | null;
    tailLine: THREE_NS.Line | null;
    tailPoints: THREE_NS.Points | null;
    posAttr: THREE_NS.BufferAttribute | null;
    aTimeAttr: THREE_NS.BufferAttribute | null;
    valAttr: THREE_NS.BufferAttribute | null;
    dirtyFrom: number;
    ovGeo: THREE_NS.BufferGeometry | null;
    ovLine: THREE_NS.Line | null;
    ovPoints: THREE_NS.Points | null;
    ovPosAttr: THREE_NS.BufferAttribute | null;
    lastT: number;
    valMin: number;
    valMax: number;
    bbMin: [number, number, number];
    bbMax: [number, number, number];
    /** 最新点真实值（point 模式唯一存储；所有模式都跟踪） */
    latest: { t: number; x: number; y: number; z: number } | null;
    /** P87b：批内透传的最新点（含朝向源采样） */
    latestRaw: Plot3DBatch["latest"] | null;
    dot: THREE_NS.Sprite;
    // ---------- P87b 显示层 ----------
    /** 细分平滑层（catmullRom/spline 时启用；movingAvg 走 1:1 尾窗列） */
    smPos: Float32Array | null;
    smT: Float64Array | null;
    smVal: Float32Array | null;
    smCount: number;
    smGeo: THREE_NS.BufferGeometry | null;
    smLine: THREE_NS.Line | null;
    smPosAttr: THREE_NS.BufferAttribute | null;
    smTimeAttr: THREE_NS.BufferAttribute | null;
    smValAttr: THREE_NS.BufferAttribute | null;
    /** 模型标记（kind!=="point" 时替代 dot 显示在最新点） */
    markerObj: THREE_NS.Object3D | null;
    markerKind: string;
    markerSrc: string;
    /** 起点标记 */
    startMark: THREE_NS.Sprite | null;
    /** 方向箭头（InstancedMesh 预分配 600） */
    arrows: THREE_NS.InstancedMesh | null;
    uniforms: {
      uBg: { value: THREE_NS.Color };
      uMode: { value: number };
      uSpan: { value: number };
      uValMin: { value: number };
      uValMax: { value: number };
      uNow: { value: number };
      uW: { value: number };
      uPalette: { value: number };
      uColor: { value: THREE_NS.Color };
      uPtSize: { value: number };
      uOpacity: { value: number };
    };
  }

  const gstates = new Map<GroupId, GState>();
  let disposed = false;

  // 真实值并集包围盒（重锚/网格/perAxis 缩放共用）——由各组 bbMin/bbMax 合成
  const bbMin = [Infinity, Infinity, Infinity];
  const bbMax = [-Infinity, -Infinity, -Infinity];
  function unionBBox() {
    bbMin[0] = bbMin[1] = bbMin[2] = Infinity;
    bbMax[0] = bbMax[1] = bbMax[2] = -Infinity;
    for (const g of gstates.values()) {
      for (let a = 0; a < 3; a++) {
        if (g.bbMin[a] < bbMin[a]) bbMin[a] = g.bbMin[a];
        if (g.bbMax[a] > bbMax[a]) bbMax[a] = g.bbMax[a];
      }
    }
  }

  /** Creation is private to applySettings; batches and async results only look up members. */
  function ensureGroup(cfg: TrajGroup): GState {
    const gid = cfg.id;
    let g = gstates.get(gid);
    if (!g) {
      g = {
        gid,
        cfg: { ...cfg },
        tPos: null,
        tReal: null,
        tT: null,
        tVal: null,
        tCount: 0,
        oPos: null,
        oReal: null,
        oT: null,
        oVal: null,
        oCount: 0,
        tailGeo: null,
        tailLine: null,
        tailPoints: null,
        posAttr: null,
        aTimeAttr: null,
        valAttr: null,
        dirtyFrom: -1,
        ovGeo: null,
        ovLine: null,
        ovPoints: null,
        ovPosAttr: null,
        lastT: 0,
        valMin: Infinity,
        valMax: -Infinity,
        bbMin: [Infinity, Infinity, Infinity],
        bbMax: [-Infinity, -Infinity, -Infinity],
        latest: null,
        latestRaw: null,
        dot: null as unknown as THREE_NS.Sprite,
        smPos: null,
        smT: null,
        smVal: null,
        smCount: 0,
        smGeo: null,
        smLine: null,
        smPosAttr: null,
        smTimeAttr: null,
        smValAttr: null,
        markerObj: null,
        markerKind: "point",
        markerSrc: "",
        startMark: null,
        arrows: null,
        uniforms: {
          uBg: { value: bgColor.clone() },
          uMode: { value: 0 },
          uSpan: { value: 1 },
          uValMin: { value: 0 },
          uValMax: { value: 1 },
          uNow: { value: 0 },
          uW: { value: 60 },
          uPalette: { value: 0 },
          uColor: { value: new T3.Color(cfg.color || "#4e9cef") },
          uPtSize: { value: 3 },
          uOpacity: { value: 1 },
        },
      };
      g.dot = new T3.Sprite(
        new T3.SpriteMaterial({ map: dotTex, transparent: true, depthTest: false }),
      );
      g.dot.scale.setScalar(0.06);
      g.dot.visible = false;
      g.dot.renderOrder = 10;
      g.dot.material.color.set(cfg.color || "#ffffff");
      scene.add(g.dot);
      gstates.set(gid, g);
    }
    return g;
  }

  const VERT = /* glsl */ `
    attribute float aTime;
    attribute float aVal;
    uniform float uMode, uSpan, uValMin, uValMax, uNow, uW, uPalette, uPtSize, uOpacity;
    uniform vec3 uColor;
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
      vec3 pal = uPalette < 0.5 ? turbo(kTime) : viridis(kTime);
      vec3 palV = uPalette < 0.5 ? turbo(kVal) : viridis(kVal);
      vBase = uMode < 0.5 ? pal : uMode < 1.5 ? palV : uColor;
      float age = uNow - aTime;
      float f = uW > 0.0
        ? clamp(1.0 - age / uW, 0.0, 1.0)
        : clamp(1.0 - age / max(uSpan, 1e-3), 0.0, 1.0);
      vFade = mix(0.18, 1.0, f) * uOpacity;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uPtSize;
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
  // Points 层专用：gl_PointCoord 圆形裁剪+软边（无裁剪时点渲染成黑灰方片）
  const FRAG_POINTS = /* glsl */ `
    precision highp float;
    uniform vec3 uBg;
    varying vec3 vBase;
    varying float vFade;
    void main() {
      float d = length(gl_PointCoord - vec2(0.5));
      if (d > 0.5) discard;
      float a = 1.0 - smoothstep(0.42, 0.5, d);
      gl_FragColor = vec4(mix(uBg, vBase, vFade * a), 1.0);
    }
  `;
  // 全景抽稀层专用：圆形裁剪 + 屏幕像素尺寸（PointsMaterial 方片且不随 pointSize 更新）
  const FRAG_OV = /* glsl */ `
    precision highp float;
    uniform vec3 uColor;
    uniform float uOpacity;
    void main() {
      float d = length(gl_PointCoord - vec2(0.5));
      if (d > 0.5) discard;
      float a = 1.0 - smoothstep(0.42, 0.5, d);
      gl_FragColor = vec4(uColor, uOpacity * a);
    }
  `;
  const VERT_OV = /* glsl */ `
    uniform float uPtSize;
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uPtSize;
    }
  `;

  /** 首次非空批次：建该组双层缓冲与网格对象（point 模式永不调用） */
  function ensureLayers(g: GState) {
    if (g.tailGeo) return;
    g.tPos = new Float32Array(TAIL_CAP * 3);
    g.tReal = new Float64Array(TAIL_CAP * 3);
    g.tT = new Float64Array(TAIL_CAP);
    g.tVal = new Float32Array(TAIL_CAP);
    g.tailGeo = new T3.BufferGeometry();
    g.posAttr = new T3.BufferAttribute(g.tPos, 3).setUsage(T3.DynamicDrawUsage);
    g.aTimeAttr = new T3.BufferAttribute(new Float32Array(TAIL_CAP), 1).setUsage(
      T3.DynamicDrawUsage,
    );
    g.valAttr = new T3.BufferAttribute(g.tVal, 1).setUsage(T3.DynamicDrawUsage);
    g.tailGeo.setAttribute("position", g.posAttr);
    g.tailGeo.setAttribute("aTime", g.aTimeAttr);
    g.tailGeo.setAttribute("aVal", g.valAttr);
    g.tailGeo.setDrawRange(0, 0);
    g.tailGeo.boundingSphere = new T3.Sphere(new T3.Vector3(), 10);
    const matLine = new T3.ShaderMaterial({
      uniforms: g.uniforms as unknown as Record<string, THREE_NS.IUniform>,
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    const matPts = new T3.ShaderMaterial({
      uniforms: g.uniforms as unknown as Record<string, THREE_NS.IUniform>,
      vertexShader: VERT,
      fragmentShader: FRAG_POINTS,
    });
    g.tailLine = new T3.Line(g.tailGeo, matLine);
    g.tailPoints = new T3.Points(g.tailGeo, matPts);
    g.tailLine.frustumCulled = false;
    g.tailPoints.frustumCulled = false;
    scene.add(g.tailLine);
    scene.add(g.tailPoints);

    g.oPos = new Float32Array(OVERVIEW_CAP * 3);
    g.oReal = new Float64Array(OVERVIEW_CAP * 3);
    g.oT = new Float64Array(OVERVIEW_CAP);
    g.oVal = new Float32Array(OVERVIEW_CAP);
    g.ovGeo = new T3.BufferGeometry();
    g.ovPosAttr = new T3.BufferAttribute(g.oPos, 3).setUsage(T3.DynamicDrawUsage);
    g.ovGeo.setAttribute("position", g.ovPosAttr);
    g.ovGeo.setDrawRange(0, 0);
    g.ovGeo.boundingSphere = new T3.Sphere(new T3.Vector3(), 10);
    const ovColor = new T3.Color(g.cfg.color || "#888888");
    g.ovLine = new T3.Line(
      g.ovGeo,
      new T3.LineBasicMaterial({
        color: ovColor,
        transparent: true,
        opacity: 0.35,
      }),
    );
    g.ovPoints = new T3.Points(
      g.ovGeo,
      new T3.ShaderMaterial({
        uniforms: {
          uColor: { value: ovColor.clone() },
          uOpacity: { value: 0.3 },
          uPtSize: { value: Math.max(2, g.cfg.pointSize * 0.7) },
        },
        vertexShader: VERT_OV,
        fragmentShader: FRAG_OV,
        transparent: true,
      }),
    );
    g.ovLine.frustumCulled = false;
    g.ovPoints.frustumCulled = false;
    scene.add(g.ovLine);
    scene.add(g.ovPoints);
    applyOneVis(g);
  }

  // ---------- P87b：细分平滑层（catmullRom / spline）----------
  // 从尾窗 f64 真值列派生独立几何（窗口 ≤SMOOTH_W 段）；尾窗原始点仍负责
  // pick/测量/导出/游标截断——「平滑只影响视觉不篡改数据」红线的几何层落实。
  const isSubSmooth = (g: GState): boolean =>
    g.cfg.smooth === "catmullRom" || g.cfg.smooth === "spline";

  // 跨组复用窗口提取 scratch（单线程安全；每次 rebuild 覆写使用区）
  const wPx = new Float64Array(SMOOTH_W + 2);
  const wPy = new Float64Array(SMOOTH_W + 2);
  const wPz = new Float64Array(SMOOTH_W + 2);
  const wT = new Float64Array(SMOOTH_W + 2);

  function ensureSm(g: GState) {
    if (g.smGeo) return;
    g.smPos = new Float32Array(SMOOTH_CAP * 3);
    g.smT = new Float64Array(SMOOTH_CAP);
    g.smVal = new Float32Array(SMOOTH_CAP);
    g.smGeo = new T3.BufferGeometry();
    g.smPosAttr = new T3.BufferAttribute(g.smPos, 3).setUsage(T3.DynamicDrawUsage);
    g.smTimeAttr = new T3.BufferAttribute(new Float32Array(SMOOTH_CAP), 1).setUsage(
      T3.DynamicDrawUsage,
    );
    g.smValAttr = new T3.BufferAttribute(g.smVal, 1).setUsage(T3.DynamicDrawUsage);
    g.smGeo.setAttribute("position", g.smPosAttr);
    g.smGeo.setAttribute("aTime", g.smTimeAttr);
    g.smGeo.setAttribute("aVal", g.smValAttr);
    g.smGeo.setDrawRange(0, 0);
    g.smGeo.boundingSphere = new T3.Sphere(new T3.Vector3(), 10);
    g.smLine = new T3.Line(
      g.smGeo,
      new T3.ShaderMaterial({
        uniforms: g.uniforms as unknown as Record<string, THREE_NS.IUniform>,
        vertexShader: VERT,
        fragmentShader: FRAG,
      }),
    );
    g.smLine.frustumCulled = false;
    scene.add(g.smLine);
    applyOneVis(g);
  }

  function hideSm(g: GState) {
    g.smCount = 0;
    if (g.smGeo) g.smGeo.setDrawRange(0, 0);
    if (g.smLine) g.smLine.visible = false;
  }

  /** 整窗重建细分平滑几何（数据批/参数变化/压实/重锚时；O(窗口×sub)） */
  function rebuildSmoothed(g: GState) {
    if (!isSubSmooth(g) || !g.tReal || !g.tT || !g.tVal || g.tCount < 2) {
      hideSm(g);
      return;
    }
    ensureSm(g);
    const sub = Math.max(2, Math.min(SMOOTH_SUB_MAX, Math.round(g.cfg.smoothSub)));
    const start = Math.max(0, g.tCount - 1 - SMOOTH_W); // 窗口起始原始下标
    const n = g.tCount - start; // 窗口内点数
    const segs = n - 1;
    for (let i = 0; i < n; i++) {
      wPx[i] = g.tReal[(start + i) * 3];
      wPy[i] = g.tReal[(start + i) * 3 + 1];
      wPz[i] = g.tReal[(start + i) * 3 + 2];
      wT[i] = g.tT[start + i];
    }
    const kernel = kernelFor(g.cfg.smooth, g.cfg.smoothTension);
    if (!kernel) {
      hideSm(g);
      return;
    }
    const out: { pos: number[]; t: number[] } = { pos: [], t: [] };
    kernel.emit(wPx, wPy, wPz, wT, 0, segs, sub, out);
    const vc = Math.min(SMOOTH_CAP - 1, Math.floor(out.pos.length / 3));
    // 首顶点 = 窗口起点原值（曲线穿过数据点）
    g.smPos![0] = toN(wPx[0], 0);
    g.smPos![1] = toN(wPy[0], 1);
    g.smPos![2] = toN(wPz[0], 2);
    g.smT![0] = wT[0];
    (g.smTimeAttr!.array as Float32Array)[0] = wT[0];
    g.smVal![0] = g.tVal[start];
    for (let j = 0; j < vc; j++) {
      const kRaw = j * 3;
      const seg = Math.floor(j / sub);
      const frac = (j % sub + 1) / sub;
      const i3 = (j + 1) * 3;
      g.smPos![i3] = toN(out.pos[kRaw], 0);
      g.smPos![i3 + 1] = toN(out.pos[kRaw + 1], 1);
      g.smPos![i3 + 2] = toN(out.pos[kRaw + 2], 2);
      g.smT![j + 1] = out.t[j];
      (g.smTimeAttr!.array as Float32Array)[j + 1] = out.t[j];
      g.smVal![j + 1] = g.tVal[start + seg] + (g.tVal[start + seg + 1] - g.tVal[start + seg]) * frac;
    }
    g.smCount = vc + 1;
    g.smPosAttr!.clearUpdateRanges();
    g.smPosAttr!.addUpdateRange(0, g.smCount * 3);
    g.smPosAttr!.needsUpdate = true;
    g.smTimeAttr!.clearUpdateRanges();
    g.smTimeAttr!.addUpdateRange(0, g.smCount);
    g.smTimeAttr!.needsUpdate = true;
    g.smValAttr!.clearUpdateRanges();
    g.smValAttr!.addUpdateRange(0, g.smCount);
    g.smValAttr!.needsUpdate = true;
    applyOneVis(g);
    needsRender = true;
  }

  // ---------- P87b：模型标记（内置程序化几何 + GLTF）与朝向 ----------
  interface ModelCacheEntry {
    users: Set<GState>;
    template: THREE_NS.Object3D | null;
    pending: Promise<THREE_NS.Object3D | null> | null;
  }
  const gltfCache = new Map<string, ModelCacheEntry>();
  const modelRequests = new Map<GState, symbol>();

  function beginModelRequest(gid: GroupId): symbol | null {
    const g = gstates.get(gid);
    if (disposed || !g || g.cfg.model.kind !== "gltf" || !g.cfg.model.src) return null;
    const token = Symbol(g.cfg.model.src);
    modelRequests.set(g, token);
    return token;
  }

  function releaseMarker(g: GState) {
    modelRequests.delete(g);
    if (g.markerObj) {
      scene.remove(g.markerObj);
      if (g.markerKind !== "gltf") disposeProc(g.markerObj);
      g.markerObj = null;
    }
    if (g.markerKind === "gltf") {
      const entry = gltfCache.get(g.markerSrc);
      if (entry) {
        entry.users.delete(g);
        if (entry.users.size === 0) {
          gltfCache.delete(g.markerSrc);
          if (entry.template) disposeOwned([entry.template], true);
        }
      }
    }
  }

  function modelMat(color: string): THREE_NS.MeshBasicMaterial {
    return new T3.MeshBasicMaterial({ color: new T3.Color(color) });
  }

  function buildProcModel(kind: string, color: string): THREE_NS.Object3D | null {
    const grp = new T3.Group();
    if (kind === "sphere") {
      grp.add(new T3.Mesh(new T3.SphereGeometry(0.022, 18, 12), modelMat(color)));
      return grp;
    }
    if (kind === "arrow") {
      const shaft = new T3.Mesh(new T3.CylinderGeometry(0.004, 0.004, 0.028, 8), modelMat(color));
      shaft.rotation.z = -Math.PI / 2;
      shaft.position.x = 0.016;
      const head = new T3.Mesh(new T3.ConeGeometry(0.010, 0.018, 10), modelMat(color));
      head.rotation.z = -Math.PI / 2;
      head.position.x = 0.040;
      grp.add(shaft, head);
      return grp;
    }
    if (kind === "car") {
      const body = new T3.Mesh(new T3.BoxGeometry(0.070, 0.018, 0.038), modelMat(color));
      const cabin = new T3.Mesh(new T3.BoxGeometry(0.030, 0.015, 0.032), modelMat(color));
      cabin.position.set(-0.004, 0.016, 0);
      const nose = new T3.Mesh(new T3.ConeGeometry(0.016, 0.014, 4), modelMat(color));
      nose.rotation.z = -Math.PI / 2;
      nose.rotation.x = Math.PI / 4;
      nose.position.x = 0.040;
      nose.scale.y = 0.55;
      grp.add(body, cabin, nose);
      return grp;
    }
    if (kind === "cone") {
      const c = new T3.Mesh(new T3.ConeGeometry(0.016, 0.042, 14), modelMat(color));
      c.rotation.z = -Math.PI / 2; // 尖朝 +X（车头约定）
      return c;
    }
    if (kind === "axes") {
      const mk = (
        dir: [number, number, number],
        col: string,
      ) => {
        const len = 0.03;
        const g2 = new T3.BufferGeometry().setFromPoints([
          new T3.Vector3(0, 0, 0),
          new T3.Vector3(dir[0] * len, dir[1] * len, dir[2] * len),
        ]);
        return new T3.Line(g2, new T3.LineBasicMaterial({ color: col }));
      };
      grp.add(mk([1, 0, 0], "#e05252"), mk([0, 1, 0], "#4caf50"), mk([0, 0, 1], "#4e9cef"));
      grp.add(new T3.Mesh(new T3.SphereGeometry(0.005, 8, 6), modelMat("#ffffff")));
      return grp;
    }
    return null; // point / gltf 走别的路径
  }

  /** Dispose unique owned resources; Sprite geometry belongs to three, not the group. */
  function disposeOwned(objects: THREE_NS.Object3D[], textures = false) {
    const geos = new Set<THREE_NS.BufferGeometry>();
    const mats = new Set<THREE_NS.Material>();
    const texs = new Set<THREE_NS.Texture>();
    const skeletons = new Set<THREE_NS.Skeleton>();
    for (const obj of objects) obj.traverse((o) => {
      const m = o as THREE_NS.Mesh;
      if (m.geometry && !(o as THREE_NS.Sprite).isSprite) geos.add(m.geometry);
      if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat);
      const sk = (o as THREE_NS.SkinnedMesh).skeleton;
      if (sk) skeletons.add(sk);
      if ((o as THREE_NS.InstancedMesh).isInstancedMesh) (o as THREE_NS.InstancedMesh).dispose();
    });
    if (textures) for (const mat of mats) for (const v of Object.values(mat)) {
      if (v && typeof v === "object" && (v as THREE_NS.Texture).isTexture) texs.add(v as THREE_NS.Texture);
    }
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    texs.forEach((t) => t.dispose());
    skeletons.forEach((s) => s.dispose());
  }

  function disposeProc(obj: THREE_NS.Object3D) {
    disposeOwned([obj]);
  }

  /** 挂载/换模型：kind 或 gltf src 变化才重建（procedural 换掉即 dispose；
   *  gltf 实例与缓存模板共享资源，不 dispose——泄漏上限=每次换模一小份共享引用，会话内可控） */
  function attachMarker(g: GState) {
    const kind = g.cfg.model.kind;
    const src = g.cfg.model.src;
    if (g.markerKind === kind && (kind !== "gltf" || g.markerSrc === src) && (g.markerObj || kind !== "gltf")) {
      orientMarker(g);
      return;
    }
    if (g.markerKind !== kind || g.markerSrc !== src) releaseMarker(g);
    g.markerKind = kind;
    g.markerSrc = src;
    if (kind === "gltf" && src) {
      let entry = gltfCache.get(src);
      if (!entry) {
        entry = { users: new Set(), template: null, pending: null };
        gltfCache.set(src, entry);
      }
      entry.users.add(g);
      if (entry.template) {
        g.markerObj = entry.template.clone(true);
        scene.add(g.markerObj);
      } // 未就绪：等 setModelBytes 回调挂载；期间无标记（dot 已由 applyOneVis 隐藏）
    } else if (kind !== "point" && kind !== "gltf") {
      g.markerObj = buildProcModel(kind, g.cfg.color);
      if (g.markerObj) scene.add(g.markerObj);
    }
    orientMarker(g);
  }

  const EUL = new T3.Euler();
  /** 朝向合成：heading(Y)→pitch(X)→roll(Z)（Euler "YXZ"）∘ 模型自校正旋转 */
  function orientMarker(g: GState) {
    const m = g.markerObj;
    if (!m) return;
    const h = g.cfg.heading;
    const hdg = g.cfg.model;
    let yawDeg = h.yawOff;
    if (h.src === "ch" && g.latestRaw?.hd != null) yawDeg = g.latestRaw.hd * h.yawSign + h.yawOff;
    else if (h.src === "velocity" && g.latest && g.latestRaw?.pv) {
      const dx = g.latest.x - g.latestRaw.pv[0];
      const dz = g.latest.z - g.latestRaw.pv[2];
      if (dx * dx + dz * dz > 1e-18)
        yawDeg = (Math.atan2(-dz, dx) * 180) / Math.PI + h.yawOff;
    }
    if (h.src === "quat" && g.latestRaw?.q && g.latestRaw.q.length === 4) {
      const [q0, q1, q2, q3] = g.latestRaw.q;
      m.quaternion.set(q0, q1, q2, q3).normalize();
    } else {
      EUL.set((h.pitchOff * Math.PI) / 180, (yawDeg * Math.PI) / 180, (h.rollOff * Math.PI) / 180, "YXZ");
      m.quaternion.setFromEuler(EUL);
    }
    EUL.set((hdg.rotX * Math.PI) / 180, (hdg.rotY * Math.PI) / 180, (hdg.rotZ * Math.PI) / 180, "XYZ");
    m.quaternion.multiply(new T3.Quaternion().setFromEuler(EUL));
    m.position.set(
      g.latest ? toN(g.latest.x, 0) : 0,
      g.latest ? toN(g.latest.y + hdg.heightOff, 1) : hdg.heightOff * scaleVec[1],
      g.latest ? toN(g.latest.z, 2) : 0,
    );
    // 模型几何建在归一化空间（球 r=0.022 等），scale 直接是相对视口的视觉系数；
    // 旧实现除以数据尺度 scaleVec 会把模型放大数百倍（"模型特别大"根因）。
    // heightOff 为真实单位，经 toN 随数据尺度换算（物理正确，修"高度无反应"）。
    m.scale.setScalar(hdg.scale);
    needsRender = true;
  }

  // ---------- P87b：方向箭头 / 起点标记 / 装饰统一刷新 ----------
  const UPV = new T3.Vector3(0, 1, 0);
  const DV = new T3.Vector3();
  const PV = new T3.Vector3();
  const QV = new T3.Quaternion();
  const MV = new T3.Matrix4();

  function rebuildArrows(g: GState) {
    const every = g.cfg.arrowEvery;
    // 游标截断后只数可见段（拖时间条箭头跟着消失，与 drawRange 同一因果）
    const n =
      curCursorSec === null || !g.tT || !g.tPos
        ? g.tCount
        : lowerBoundLe(g.tT, g.tCount, curCursorSec);
    if (!every || g.cfg.mode !== "line" || n < 3 || !g.tPos) {
      if (g.arrows) g.arrows.count = 0;
      return;
    }
    const spacing = Math.max(10, every);
    const count = Math.min(600, Math.floor((n - 1) / spacing));
    if (!g.arrows) {
      g.arrows = new T3.InstancedMesh(
        new T3.ConeGeometry(0.007, 0.02, 8),
        new T3.MeshBasicMaterial({
          color: new T3.Color(g.cfg.color),
          transparent: true,
          opacity: 0.9,
        }),
        600,
      );
      g.arrows.frustumCulled = false;
      scene.add(g.arrows);
    } else {
      (g.arrows.material as THREE_NS.MeshBasicMaterial).color.set(g.cfg.color);
    }
    for (let k = 0; k < count; k++) {
      const i = n - 1 - k * spacing; // 从可见末端向老排布
      PV.set(g.tPos[i * 3], g.tPos[i * 3 + 1], g.tPos[i * 3 + 2]);
      DV.set(
        g.tPos[(i + 1) * 3] - g.tPos[i * 3],
        g.tPos[(i + 1) * 3 + 1] - g.tPos[i * 3 + 1],
        g.tPos[(i + 1) * 3 + 2] - g.tPos[i * 3 + 2],
      );
      if (DV.lengthSq() < 1e-16) DV.set(1, 0, 0);
      DV.normalize();
      QV.setFromUnitVectors(UPV, DV);
      MV.compose(PV, QV, new T3.Vector3(1, 1, 1));
      g.arrows.setMatrixAt(k, MV);
    }
    g.arrows.count = count;
    g.arrows.instanceMatrix.needsUpdate = true;
    applyOneVis(g);
  }

  /** 数据批/游标/设置变化后的组装饰刷新（marker 位姿 + 起点标记 + 箭头） */
  function updateDecorations(g: GState) {
    if (g.cfg.model.kind !== "point") orientMarker(g);
    if (g.cfg.showStartEnd && (g.tCount > 0 || g.oCount > 0)) {
      if (!g.startMark) {
        g.startMark = new T3.Sprite(
          new T3.SpriteMaterial({ map: dotTex, transparent: true, depthTest: false }),
        );
        g.startMark.scale.setScalar(0.04);
        g.startMark.renderOrder = 9;
        g.startMark.material.color.set(g.cfg.color);
        scene.add(g.startMark);
      }
      const src = g.oCount > 0 ? g.oPos! : g.tPos!;
      if (src) g.startMark.position.set(src[0], src[1], src[2]);
    } else if (g.startMark) {
      g.startMark.visible = false;
    }
    if (g.cfg.arrowEvery && g.cfg.mode === "line") rebuildArrows(g);
    else if (g.arrows) g.arrows.count = 0;
    applyOneVis(g);
  }

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

  /** 重建网格：真实值 nice 刻度 → 归一化空间画线；轴标签带组1 通道名 */
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
    curGridStep = step;
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
    const gm = new T3.BufferGeometry();
    gm.setAttribute("position", new T3.Float32BufferAttribute(pts, 3));
    gridGroup.add(
      new T3.LineSegments(
        gm,
        new T3.LineBasicMaterial({
          color: new T3.Color(gx),
          transparent: true,
          opacity: 0.5,
        }),
      ),
    );

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
        gxc,
        0.09,
      );
      sp.position.copy(b);
      sp.position.y += 0.05;
      axisLabels.push(sp);
      gridGroup.add(sp);
    }
    void accent;
    void gxc;
    needsRender = true;
  }

  // ---------- 最新点标记底图（各组 Sprite 复用同一纹理，颜色按组） ----------
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

  // ---------- 时间游标（P70 T2 → P87a 逐组截断）----------
  // null = 跟随最新；数值 = drawRange 二分截断 + uNow 锚定。回放 seek 向后
  // 不重建：各组缓冲 append-only 有序，截断即可"倒带"（详设 §1）。
  let curCursorSec: number | null = null;
  let calibOn = false;

  /** 游标/最新 → 该组截断点数 + 标记位置；返回 marker 归一化坐标或 null */
  function cursorCut(g: GState): { ct: number; co: number; marker: [number, number, number] | null } {
    const cut = (arr: Float64Array | null, n: number) =>
      curCursorSec === null || !arr ? n : lowerBoundLe(arr, n, curCursorSec);
    const ct = cut(g.tT, g.tCount);
    const co = cut(g.oT, g.oCount);
    let marker: [number, number, number] | null = null;
    if (ct > 0 && g.tPos) {
      marker = [g.tPos[(ct - 1) * 3], g.tPos[(ct - 1) * 3 + 1], g.tPos[(ct - 1) * 3 + 2]];
    } else if (co > 0 && g.oPos) {
      marker = [g.oPos[(co - 1) * 3], g.oPos[(co - 1) * 3 + 1], g.oPos[(co - 1) * 3 + 2]];
    } else if (g.cfg.mode === "point" && g.latest && (curCursorSec === null || g.latest.t <= curCursorSec)) {
      marker = [toN(g.latest.x, 0), toN(g.latest.y, 1), toN(g.latest.z, 2)];
    }
    return { ct, co, marker };
  }

  function applyCursor(sec: number | null) {
    curCursorSec = sec;
    for (const g of gstates.values()) {
      if (g.tailGeo && g.ovGeo) {
        const { ct, co, marker } = cursorCut(g);
        g.tailGeo.setDrawRange(0, ct);
        g.ovGeo.setDrawRange(0, co);
        if (g.smGeo) g.smGeo.setDrawRange(0, sec === null ? g.smCount : lowerBoundLe(g.smT!, g.smCount, sec));
        if (marker) {
          g.dot.position.set(marker[0], marker[1], marker[2]);
        }
        g.dot.visible =
          !calibOn && g.cfg.visible && marker !== null && g.cfg.model.kind === "point";
        g.uniforms.uNow.value = sec === null ? g.lastT : sec;
        if (g.cfg.arrowEvery > 0 && g.cfg.mode === "line") rebuildArrows(g);
      } else if (g.cfg.mode === "point" && g.latest) {
        const live = sec === null || g.latest.t <= sec;
        if (live) {
          g.dot.position.set(toN(g.latest.x, 0), toN(g.latest.y, 1), toN(g.latest.z, 2));
        }
        g.dot.visible = !calibOn && g.cfg.visible && live && g.cfg.model.kind === "point";
        g.uniforms.uNow.value = sec === null ? g.lastT : sec;
      } else {
        g.dot.visible = false;
      }
      if (g.markerObj)
        g.markerObj.visible =
          !calibOn && g.cfg.visible && g.latest != null && g.cfg.model.kind !== "point";
    }
    refreshFlags();
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

  // ---------- P87b：会话标注旗标（主组轨迹立旗；≤48 面） ----------
  const flagGroup = new T3.Group();
  flagGroup.renderOrder = 12;
  scene.add(flagGroup);
  const flagPool: THREE_NS.Sprite[] = [];
  let flagTex: THREE_NS.CanvasTexture | null = null;
  let flagRels: number[] = [];

  function ensureFlagTex(): THREE_NS.CanvasTexture {
    if (flagTex) return flagTex;
    const cv = document.createElement("canvas");
    cv.width = 32;
    cv.height = 40;
    const c = cv.getContext("2d")!;
    c.fillStyle = "#e8a13c";
    c.beginPath();
    c.moveTo(6, 2);
    c.lineTo(28, 9);
    c.lineTo(6, 18);
    c.closePath();
    c.fill();
    c.fillStyle = "rgba(232,161,60,.85)";
    c.fillRect(5, 2, 2.5, 38);
    flagTex = new T3.CanvasTexture(cv);
    flagTex.colorSpace = T3.SRGBColorSpace;
    return flagTex;
  }

  /** 旗标落位：第一个可见且有缓冲的组（按设置数组序，P87e 弹性组） */
  function refreshFlags() {
    const hostOrder = curSettings?.groups ?? [];
    let host: GState | null = null;
    for (const cfg of hostOrder) {
      const g = gstates.get(cfg.id);
      if (g && g.cfg.visible && (g.tCount > 0 || g.oCount > 0)) {
        host = g;
        break;
      }
    }
    const hideAll = calibOn || !host || flagRels.length === 0;
    for (let k = 0; k < flagPool.length; k++) {
      const sp = flagPool[k];
      if (hideAll || k >= flagRels.length || !host) {
        sp.visible = false;
        continue;
      }
      const rel = flagRels[k];
      const ct = lowerBoundLe(host.tT!, host.tCount, rel);
      const co = host.oT ? lowerBoundLe(host.oT, host.oCount, rel) : 0;
      let src: Float32Array | null = null;
      let si = 0;
      if (ct > 0 && host.tPos) {
        src = host.tPos;
        si = (ct - 1) * 3;
      } else if (co > 0 && host.oPos) {
        src = host.oPos;
        si = (co - 1) * 3;
      } else if (host.tPos && host.tCount > 0) {
        src = host.tPos;
      } else if (host.oPos && host.oCount > 0) {
        src = host.oPos;
      }
      if (!src) {
        sp.visible = false;
        continue;
      }
      sp.position.set(src[si], src[si + 1] + 0.035, src[si + 2]);
      sp.visible = true;
    }
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
  // delta 保持视角偏移向量（Foxglove Position 档语义）；tween 进行时让路。
  // P87a：锚点 = 主组（g1 优先，其次任一有数据的可见组）游标截断点/最新点
  let follow = false;
  function followAnchor(): THREE_NS.Vector3 | null {
    for (const cfg of curSettings?.groups ?? []) {
      const g = gstates.get(cfg.id);
      if (!g || !g.cfg.visible) continue;
      const { marker } = cursorCut(g);
      if (marker) return new T3.Vector3(...marker);
    }
    return null;
  }
  // 光点恒定像素：Sprite 处于世界空间会随远近缩放，每帧按相机距离补偿
  // 使 point 模式的最新点光点在屏幕上保持 pointSize 设定的像素大小。
  const _dotV = new T3.Vector3();
  let dotSizeWarned = false;
  function updateDotPixelSize() {
    const halfH = Math.tan(((camera.fov * Math.PI) / 180) / 2);
    const pxH = Math.max(host.clientHeight, 60);
    for (const g of gstates.values()) {
      // 仅 point 模式的最新点光点恒定像素；起点标记 startMark 是固定装饰不参与
      if (g.cfg.model.kind !== "point" || !g.dot.visible) continue;
      const dist = camera.position.distanceTo(g.dot.getWorldPosition(_dotV));
      // NaN 防护（P88d）：位置/距离异常时保持现尺寸并告警一次，
      // 绝不让 NaN 写进 scale 污染整条渲染链（曾致 computeBoundingSphere NaN 刷屏）
      if (!isFinite(dist) || dist <= 0 || !isFinite(halfH)) {
        if (!dotSizeWarned) {
          dotSizeWarned = true;
          console.warn(`[P3D诊断] 组 ${g.gid} 光点距离异常 dist=${dist}，已保持原尺寸`);
        }
        continue;
      }
      const worldPerPx = (2 * halfH * dist) / pxH;
      g.dot.scale.setScalar(Math.max(2, g.cfg.pointSize) * worldPerPx);
    }
  }

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
      const p = followAnchor();
      const dx = p ? (p.x - controls.target.x) * 0.15 : 0;
      const dy = p ? (p.y - controls.target.y) * 0.15 : 0;
      const dz = p ? (p.z - controls.target.z) * 0.15 : 0;
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
      // 异常隔离（P88d）：单组尺寸补偿异常绝不允许中断整个 rAF 循环
      //（循环一断=点线全消失的"面板空白"观感）
      try {
        updateDotPixelSize();
      } catch (e) {
        if (!dotSizeWarned) {
          dotSizeWarned = true;
          console.warn("[P3D诊断] 光点尺寸补偿异常，已跳过", e);
        }
      }
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

  // ---------- 校准层（P71/P73）：点云 + 线框 + 中心标记 + 残差着色 + 显示切换 ----------
  // raw 模式：归一化沿用轨迹 anchor/scale 流水线（同一数据源，量级一致；重锚时随 rewriteNorm 重写）
  // corrected 模式（P73）：W(x−offset) 校正后空间独立归一化（质心平移 + ā 缩放），与轨迹锚互不影响
  const CALIB_CAP_SCENE = 20000; // 与 plot3dStore.CALIB_CAP 一致（store 自动停止，此处防御）
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

  /** 单组全层可见性（模式/组可见/校准门控统一裁决；applySettings 与 setCalibMode 共用） */
  function applyOneVis(g: GState) {
    const hide = calibOn || !g.cfg.visible;
    const lineOn = g.cfg.mode === "line";
    const ptsOn = g.cfg.mode === "points";
    const sub = isSubSmooth(g);
    if (g.tailLine) g.tailLine.visible = !hide && lineOn && !sub;
    if (g.tailPoints) g.tailPoints.visible = !hide && (ptsOn || (lineOn && g.cfg.showDots));
    if (g.ovLine) g.ovLine.visible = !hide && lineOn;
    if (g.ovPoints) g.ovPoints.visible = !hide && ptsOn;
    if (g.smLine) g.smLine.visible = !hide && lineOn && sub && g.smCount > 0;
    if (g.markerObj) g.markerObj.visible = !hide && g.cfg.model.kind !== "point" && g.latest != null;
    if (g.arrows) g.arrows.visible = !hide && g.cfg.arrowEvery > 0 && lineOn && g.cfg.mode === "line";
    if (g.startMark) g.startMark.visible = !hide && g.cfg.showStartEnd;
    if (g.cfg.model.kind !== "point") g.dot.visible = false;
    needsRender = true;
  }

  /** 全层可见性统一裁决（含网格/校准；退出零重建） */
  function applyModeVis() {
    const s = curSettings;
    calGroup.visible = calibOn;
    gridGroup.visible = !calibOn && (!s || s.showGrid);
    for (const g of gstates.values()) applyOneVis(g);
    if (calibOn) {
      for (const g of gstates.values()) g.dot.visible = false;
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

  // ---------- 组缓冲追加 / 压实 / 平滑 / 重锚 ----------
  let lastGridBuild = 0;
  let gridSig = "";
  /** P87b：最近一次网格步长（真实单位/格），br HUD 比例尺读数用 */
  let curGridStep = 0;

  function uploadTail(g: GState, from: number) {
    if (g.dirtyFrom < 0 || from < g.dirtyFrom) g.dirtyFrom = from;
  }
  function flushTail(g: GState) {
    if (g.dirtyFrom < 0 || !g.posAttr || !g.aTimeAttr || !g.valAttr) return;
    const n = g.tCount - g.dirtyFrom;
    if (n > 0) {
      g.posAttr.clearUpdateRanges();
      g.posAttr.addUpdateRange(g.dirtyFrom * 3, n * 3);
      g.posAttr.needsUpdate = true;
      g.aTimeAttr.clearUpdateRanges();
      g.aTimeAttr.addUpdateRange(g.dirtyFrom, n);
      g.aTimeAttr.needsUpdate = true;
      g.valAttr.clearUpdateRanges();
      g.valAttr.addUpdateRange(g.dirtyFrom, n);
      g.valAttr.needsUpdate = true;
    }
    g.dirtyFrom = -1;
  }

  /** 滑动平均几何重写（P87a）：从真实值副列算平滑位置写入归一化主列。
   *  pick/测量/导出读副列原始值——平滑只影响视觉。win≤1 或 smooth=none = 直接归一化。
   *  尾部半窗处的点因右侧数据未到暂用收缩窗（后续批次到达时经重写区间修正） */
  function recomputeTailPos(g: GState, from: number) {
    if (!g.tPos || !g.tReal) return;
    const h = g.cfg.mode === "line" && g.cfg.smooth === "movingAvg" ? (g.cfg.smoothWin - 1) / 2 : 0;
    const n = g.tCount;
    const lo = Math.max(0, from);
    for (let i = lo; i < n; i++) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let cnt = 0;
      const a0 = Math.max(0, i - h);
      const a1 = Math.min(n - 1, i + h);
      for (let k = a0; k <= a1; k++) {
        sx += g.tReal[k * 3];
        sy += g.tReal[k * 3 + 1];
        sz += g.tReal[k * 3 + 2];
        cnt++;
      }
      const j = i * 3;
      g.tPos[j] = (sx / cnt - anchor[0]) * scaleVec[0];
      g.tPos[j + 1] = (sy / cnt - anchor[1]) * scaleVec[1];
      g.tPos[j + 2] = (sz / cnt - anchor[2]) * scaleVec[2];
    }
    if (n > lo) uploadTail(g, lo);
  }

  /** 尾窗满 → 最老一半压入全景（含逐组 maxPoints 上限判定），剩余前移。
   *  注意 posAttr/valAttr 与 tPos/tVal 共享同一底层数组，只搬一次 */
  function compactTail(g: GState) {
    if (!g.tReal || !g.tT || !g.tVal || !g.tPos || !g.aTimeAttr) return;
    const half = TAIL_CAP >> 1;
    ovPushChunk(g, 0, half);
    g.tPos.copyWithin(0, half * 3, g.tCount * 3);
    g.tReal.copyWithin(0, half * 3, g.tCount * 3);
    (g.aTimeAttr.array as Float32Array).copyWithin(0, half, g.tCount);
    g.tT.copyWithin(0, half, g.tCount);
    g.tVal.copyWithin(0, half, g.tCount);
    g.tCount -= half;
    g.dirtyFrom = 0;
    scanGroupBB(g);
    unionBBox();
    recomputeTailPos(g, 0); // 平移后几何位置全重算（窗口边界改变；O(tail) 半窗均摊）
  }

  function ovPushChunk(g: GState, s: number, e: number) {
    if (!g.oPos || !g.oReal || !g.oT || !g.oVal || !g.tReal || !g.tT || !g.tVal) return;
    for (let i = s; i < e; i++) {
      if (g.oCount >= OVERVIEW_CAP) ovHalve(g);
      const j = g.oCount * 3;
      g.oPos[j] = (g.tReal[i * 3] - anchor[0]) * scaleVec[0];
      g.oPos[j + 1] = (g.tReal[i * 3 + 1] - anchor[1]) * scaleVec[1];
      g.oPos[j + 2] = (g.tReal[i * 3 + 2] - anchor[2]) * scaleVec[2];
      g.oReal[j] = g.tReal[i * 3];
      g.oReal[j + 1] = g.tReal[i * 3 + 1];
      g.oReal[j + 2] = g.tReal[i * 3 + 2];
      g.oT[g.oCount] = g.tT[i];
      g.oVal[g.oCount] = g.tVal[i];
      g.oCount++;
    }
    if (g.ovPosAttr) {
      g.ovPosAttr.clearUpdateRanges();
      g.ovPosAttr.addUpdateRange(0, g.oCount * 3);
      g.ovPosAttr.needsUpdate = true;
    }
    g.ovGeo?.setDrawRange(0, g.oCount);
  }

  /** 全景满 → 2:1 对数减半（保留末点），全程形状不丢 */
  function ovHalve(g: GState) {
    if (!g.oPos || !g.oReal || !g.oT || !g.oVal) return;
    let j = 0;
    for (let i = 0; i < g.oCount; i += 2) {
      if (i !== g.oCount - 1 || g.oCount % 2 === 1) {
        const s3 = i * 3;
        const d3 = j * 3;
        g.oPos[d3] = g.oPos[s3];
        g.oPos[d3 + 1] = g.oPos[s3 + 1];
        g.oPos[d3 + 2] = g.oPos[s3 + 2];
        g.oReal[d3] = g.oReal[s3];
        g.oReal[d3 + 1] = g.oReal[s3 + 1];
        g.oReal[d3 + 2] = g.oReal[s3 + 2];
        g.oT[j] = g.oT[i];
        g.oVal[j] = g.oVal[i];
        j++;
      }
    }
    // 强制保留末点（连续性）
    if (g.oT[j - 1] !== g.oT[g.oCount - 1]) {
      const s3 = (g.oCount - 1) * 3;
      const d3 = j * 3;
      g.oPos[d3] = g.oPos[s3];
      g.oPos[d3 + 1] = g.oPos[s3 + 1];
      g.oPos[d3 + 2] = g.oPos[s3 + 2];
      g.oReal[d3] = g.oReal[s3];
      g.oReal[d3 + 1] = g.oReal[s3 + 1];
      g.oReal[d3 + 2] = g.oReal[s3 + 2];
      g.oT[j] = g.oT[g.oCount - 1];
      g.oVal[j] = g.oVal[g.oCount - 1];
      j++;
    }
    g.oCount = j;
  }

  /** 组 maxPoints 上限（P87a 弹窗「最大点数」）：先弃全景最老段，再弃尾窗最老段。
   *  全景数组前移 O(n) 仅在越限瞬间发生（每批最多一次），非逐点 shift */
  function trimGroupMax(g: GState) {
    const cap = g.cfg.maxPoints;
    if (!cap || !g.oPos || !g.oReal || !g.oT || !g.oVal) return;
    let over = g.tCount + g.oCount - cap;
    while (over > 0 && g.oCount > 0) {
      const drop = Math.min(over, Math.max(1, g.oCount >> 1));
      g.oPos.copyWithin(0, drop * 3, g.oCount * 3);
      g.oReal.copyWithin(0, drop * 3, g.oCount * 3);
      g.oT.copyWithin(0, drop, g.oCount);
      g.oVal.copyWithin(0, drop, g.oCount);
      g.oCount -= drop;
      over -= drop;
    }
    if (over > 0 && g.tPos && g.tReal && g.tT && g.tVal) {
      const drop = Math.min(over, g.tCount);
      g.tPos.copyWithin(0, drop * 3, g.tCount * 3);
      g.tReal.copyWithin(0, drop * 3, g.tCount * 3);
      (g.aTimeAttr!.array as Float32Array).copyWithin(0, drop, g.tCount);
      g.tT.copyWithin(0, drop, g.tCount);
      g.tVal.copyWithin(0, drop, g.tCount);
      g.tCount -= drop;
      g.dirtyFrom = 0;
      scanGroupBB(g);
    }
    if (g.ovPosAttr && g.oCount >= 0) {
      g.ovPosAttr.clearUpdateRanges();
      g.ovPosAttr.addUpdateRange(0, g.oCount * 3);
      g.ovPosAttr.needsUpdate = true;
    }
    g.ovGeo?.setDrawRange(0, g.oCount);
  }

  function scanGroupBB(g: GState) {
    g.bbMin = [Infinity, Infinity, Infinity];
    g.bbMax = [-Infinity, -Infinity, -Infinity];
    const scan = (real: Float64Array | null, e: number) => {
      if (!real) return;
      for (let i = 0; i < e; i++) {
        for (let a = 0; a < 3; a++) {
          const v = real[i * 3 + a];
          if (v < g.bbMin[a]) g.bbMin[a] = v;
          if (v > g.bbMax[a]) g.bbMax[a] = v;
        }
      }
    };
    scan(g.oReal, g.oCount);
    scan(g.tReal, g.tCount);
  }

  function rewriteNorm() {
    for (const g of gstates.values()) {
      if (!g.tReal || !g.oReal) {
        // P87b：point 组零缓冲也要随重锚刷新标记位姿（latest 的 norm 位置变了）
        if (g.latest) updateDecorations(g);
        continue;
      }
      for (let i = 0; i < g.oCount; i++) {
        const j = i * 3;
        g.oPos![j] = (g.oReal[j] - anchor[0]) * scaleVec[0];
        g.oPos![j + 1] = (g.oReal[j + 1] - anchor[1]) * scaleVec[1];
        g.oPos![j + 2] = (g.oReal[j + 2] - anchor[2]) * scaleVec[2];
      }
      recomputeTailPos(g, 0);
      // 立即上传：静态数据下切设置（逐轴缩放/平滑）不能等下一批数据才刷 GPU
      if (g.ovPosAttr) {
        g.ovPosAttr.clearUpdateRanges();
        g.ovPosAttr.addUpdateRange(0, g.oCount * 3);
        g.ovPosAttr.needsUpdate = true;
      }
      flushTail(g);
      // P87b：派生层随归一化重写（细分平滑/箭头在 norm 空间重建，标记位姿重算）
      if (isSubSmooth(g)) rebuildSmoothed(g);
      if (g.cfg.arrowEvery) rebuildArrows(g);
      updateDecorations(g);
    }
    rewriteCalibNorm();
    if (measureA && measureB) drawMeasure(); // 重锚后按新归一化重画测量线
  }

  function totalPoints(): number {
    let n = 0;
    for (const g of gstates.values()) n += g.tCount + g.oCount;
    return n;
  }

  function maybeReanchor(forceGrid: boolean) {
    if (totalPoints() === 0 && !hasLiveMarker()) return;
    const ext = Math.max(
      bbMax[0] - bbMin[0],
      bbMax[1] - bbMin[1],
      bbMax[2] - bbMin[2],
    );
    if (!isFinite(ext)) {
      // 只有 point 模式无缓冲时包围盒为空：用 latest 并集维持锚定（首点即锚）
      return;
    }
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

  function hasLiveMarker(): boolean {
    for (const g of gstates.values()) if (g.latest) return true;
    return false;
  }

  function axisFieldNames(): [string, string, string] {
    const find = (id: string) => curChans.find((c) => c.id === id)?.name ?? "";
    const g1 = curSettings?.groups[0];
    return [find(g1?.chX ?? ""), find(g1?.chY ?? ""), find(g1?.chZ ?? "")];
  }

  /** 首批数据（任意组首次）→ 建立锚定；后续批次增量维护并集 */
  function firstAnchorFromBatch(b: Plot3DBatch) {
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
    }
    baseExtent = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
    scale = (VIEW_HALF * 2) / baseExtent;
    updateScaleVec(); // perAxis：首批即按三轴各自跨度撑满（uniform 下三值 = scale）
  }

  function clearGroup(g: GState) {
    g.tCount = 0;
    g.oCount = 0;
    g.valMin = Infinity;
    g.valMax = -Infinity;
    g.tailGeo?.setDrawRange(0, 0);
    g.ovGeo?.setDrawRange(0, 0);
    g.dirtyFrom = -1;
    g.latest = null;
    g.latestRaw = null;
    g.dot.visible = false;
    g.bbMin = [Infinity, Infinity, Infinity];
    g.bbMax = [-Infinity, -Infinity, -Infinity];
    hideSm(g);
    if (g.arrows) g.arrows.count = 0;
    if (g.startMark) g.startMark.visible = false;
    if (g.markerObj) g.markerObj.visible = false;
    if (measureA && measureA.gid === g.gid) measureA = null;
    if (measureB && measureB.gid === g.gid) measureB = null;
    drawMeasure();
  }

  /** Drop all lazy buffers + layers so the next non-point batch reallocates fresh
   *  (mode switch line/points -> point, or removal + later re-add of the same id). */
  function releaseLayers(g: GState) {
    const layers = [g.tailLine, g.tailPoints, g.ovLine, g.ovPoints, g.smLine, g.arrows]
      .filter((o): o is THREE_NS.Line | THREE_NS.Points | THREE_NS.LineSegments | THREE_NS.InstancedMesh => o !== null);
    disposeOwned(layers);
    for (const obj of layers) scene.remove(obj);
    g.tailGeo = null;
    g.tailLine = null;
    g.tailPoints = null;
    g.posAttr = null;
    g.aTimeAttr = null;
    g.valAttr = null;
    g.tPos = null;
    g.tReal = null;
    g.tT = null;
    g.tVal = null;
    g.ovGeo = null;
    g.ovLine = null;
    g.ovPoints = null;
    g.ovPosAttr = null;
    g.oPos = null;
    g.oReal = null;
    g.oT = null;
    g.oVal = null;
    g.smGeo = null;
    g.smLine = null;
    g.smPosAttr = null;
    g.smTimeAttr = null;
    g.smValAttr = null;
    g.smPos = null;
    g.smT = null;
    g.smVal = null;
    g.smCount = 0;
    g.arrows = null;
    g.dirtyFrom = -1;
  }

  /** Remove a group entirely (settings membership diff): clear data + dispose every
   *  owned resource. dot Sprite is owned per-group (shared dotTex is NOT disposed);
   *  GLTF marker instances share cached template resources and are only detached,
   *  not disposed (cache template release happens on scene dispose). */
  function disposeGroup(g: GState) {
    clearGroup(g);
    releaseLayers(g);
    scene.remove(g.dot);
    (g.dot.material as THREE_NS.SpriteMaterial).dispose();
    if (g.startMark) {
      scene.remove(g.startMark);
      (g.startMark.material as THREE_NS.SpriteMaterial).dispose();
      g.startMark = null;
    }
    releaseMarker(g);
    gstates.delete(g.gid);
  }

  // ---------- 对外接口 ----------
  const api: Plot3DScene = {
    applyBatch(entries, cursorSec) {
      // 两遍处理：先清重灌组（firstData 判定必须在清空之后，与 P86 前单体行为
      // 「清空后首批重建锚」严格等价），再逐组追加
      let anyReloaded = false;
      for (const { gid, reloaded } of entries) {
        if (!reloaded) continue;
        const g = gstates.get(gid);
        if (!g) {
          // unknown/removed gid: never resurrect（P88d 诊断：静默丢弃=面板空白的头号嫌疑）
          console.warn(`[P3D诊断] 丢弃 reloaded 批次：组 ${gid} 不存在于场景`);
          continue;
        }
        clearGroup(g);
        anyReloaded = true;
      }
      let firstData = totalPoints() === 0 && !hasLiveMarker();
      let anyData = false;
      for (const { gid, b } of entries) {
        if (b.t.length === 0) continue;
        const g = gstates.get(gid);
        if (!g) {
          console.warn(`[P3D诊断] 丢弃数据批次：组 ${gid}（${b.t.length} 点）不存在于场景`);
          continue; // unknown/removed gid: drop, no resurrection
        }
        const li = b.t.length - 1;
        g.latestRaw = b.latest ?? { t: b.t[li], x: b.x[li], y: b.y[li], z: b.z[li] };
        g.latest = { t: g.latestRaw.t, x: g.latestRaw.x, y: g.latestRaw.y, z: g.latestRaw.z };
        g.lastT = b.t[li];
        anyData = true;
        if (firstData) {
          firstAnchorFromBatch(b);
          firstData = false;
          rewriteCalibNorm(); // 清空轨迹后重锚：校准点云随新锚重写，避免滞留旧坐标系
        }
        // point 模式：零缓冲红线——只留 latest 标记 + 单点包围盒（详设 §7）
        if (g.cfg.mode === "point") {
          for (let a = 0; a < 3; a++) {
            const v = a === 0 ? b.x[li] : a === 1 ? b.y[li] : b.z[li];
            if (v < g.bbMin[a]) g.bbMin[a] = v;
            if (v > g.bbMax[a]) g.bbMax[a] = v;
          }
          unionBBox();
          updateDecorations(g);
          continue;
        }
        ensureLayers(g);
        if (!g.tReal || !g.tPos || !g.tT || !g.tVal || !g.aTimeAttr) continue;
        for (let i = 0; i < b.t.length; i++) {
          if (g.tCount >= TAIL_CAP) compactTail(g);
          const j = g.tCount * 3;
          const rx = b.x[i];
          const ry = b.y[i];
          const rz = b.z[i];
          g.tReal[j] = rx;
          g.tReal[j + 1] = ry;
          g.tReal[j + 2] = rz;
          g.tT[g.tCount] = b.t[i];
          (g.aTimeAttr.array as Float32Array)[g.tCount] = b.t[i];
          g.tVal[g.tCount] = b.val[i];
          if (b.val[i] < g.valMin) g.valMin = b.val[i];
          if (b.val[i] > g.valMax) g.valMax = b.val[i];
          for (let a = 0; a < 3; a++) {
            const v = a === 0 ? rx : a === 1 ? ry : rz;
            if (v < g.bbMin[a]) g.bbMin[a] = v;
            if (v > g.bbMax[a]) g.bbMax[a] = v;
          }
          g.tCount++;
        }
        unionBBox();
        const half = g.cfg.smooth === "movingAvg" ? (g.cfg.smoothWin - 1) / 2 : 0;
        const from = Math.max(0, g.tCount - b.t.length - half - 1);
        recomputeTailPos(g, from);
        trimGroupMax(g);
        unionBBox();
        if (isSubSmooth(g)) rebuildSmoothed(g);
        updateDecorations(g);
      }
      if (!anyReloaded && !anyData) {
        // 空批次 + 游标变化（如回放 seek 向后：重灌点全 ≤ 水位）→ 仅更新游标
        applyCursor(cursorSec);
        return;
      }
      // 全局时钟：uSpan 用各组最新末点的最大相对秒（游标截断在 applyCursor 处理 uNow）
      let globalLastT = 0;
      for (const g of gstates.values()) if (g.lastT > globalLastT) globalLastT = g.lastT;
      for (const g of gstates.values()) {
        g.uniforms.uSpan.value = Math.max(globalLastT, 1e-3);
        if (isFinite(g.valMin) && isFinite(g.valMax)) {
          g.uniforms.uValMin.value = g.valMin;
          g.uniforms.uValMax.value = g.valMax;
        }
      }
      maybeReanchor(anyReloaded);
      for (const g of gstates.values()) flushTail(g);
      // 游标收尾：null = 恢复全量（与上面 uNow/drawRange 一致）；数值 = 覆盖截断
      applyCursor(cursorSec);
    },

    applySettings(s, chans, cbSafe, accent) {
      if (disposed) return;
      const prevAxisScale = curSettings?.axisScale;
      curSettings = s;
      curChans = chans;
      curAccent = accent;
      const members = new Set(s.groups.map((g) => g.id));
      let removed = false;
      for (const g of gstates.values()) if (!members.has(g.gid)) {
        disposeGroup(g);
        removed = true;
      }
      if (removed) {
        tween = null;
        unionBBox();
        maybeReanchor(true);
      }
      for (const cfg of s.groups) {
        const g = ensureGroup(cfg);
        const prevMode = g.cfg.mode;
        g.cfg = { ...cfg };
        g.uniforms.uMode.value = toModeVal(cfg);
        g.uniforms.uW.value = cfg.fade;
        g.uniforms.uPtSize.value = cfg.pointSize;
        g.uniforms.uOpacity.value = cfg.opacity;
        g.uniforms.uColor.value.set(cfg.color);
        g.uniforms.uPalette.value = cbSafe ? 1 : 0;
        g.uniforms.uBg.value.copy(bgColor);
        (g.dot.material as THREE_NS.SpriteMaterial).color.set(cfg.color);
        (g.dot.material as THREE_NS.SpriteMaterial).opacity =
          cfg.mode === "point" ? cfg.opacity : 1;
        g.dot.scale.setScalar(cfg.mode === "point" ? 0.045 + cfg.pointSize * 0.012 : 0.06);
        if (g.ovLine) {
          (g.ovLine.material as THREE_NS.LineBasicMaterial).color.set(cfg.color);
        }
        if (g.ovPoints) {
          const ou = (g.ovPoints.material as THREE_NS.ShaderMaterial).uniforms;
          ou.uColor.value.set(cfg.color);
          ou.uPtSize.value = Math.max(2, cfg.pointSize * 0.7);
        }
        if (cfg.mode === "point" && prevMode !== "point") {
          // 实时定位不保留历史层的数组与几何。
          clearGroup(g);
          releaseLayers(g);
        } else if (cfg.maxPoints > 0 && g.tCount + g.oCount > cfg.maxPoints) {
          // 静态数据下调小「最大点数」也要立即生效（不等下一批追加）
          trimGroupMax(g);
          unionBBox();
        }
        // P87b：模型/朝向/装饰与派生层随设置刷新（attachMarker 内部幂等）
        attachMarker(g);
        updateDecorations(g);
        if (isSubSmooth(g)) rebuildSmoothed(g);
        else if (g.smGeo) hideSm(g);
        applyOneVis(g);
      }
      // P75 B2：等比/逐轴切换 → 重算逐轴缩放并全量重写归一化坐标
      // （updateScaleVec 须先于 rebuildGrid：网格线端点同样经 toN 映射）
      if (prevAxisScale !== s.axisScale && (totalPoints() > 0 || hasLiveMarker())) {
        updateScaleVec();
        rewriteNorm();
      }
      calMat.color.set(accent); // 校准点云/线框随主题 accent
      (calWire.material as THREE_NS.LineBasicMaterial).color.set(accent);
      controls.autoRotate = s.autoRotate;
      controls.autoRotateSpeed = 1.2;
      controls.zoomToCursor = s.zoomToCursor; // P72：滚轮缩放到光标（three r151+ 原生支持）
      applyModeVis(); // 轨迹/网格/校准层可见性统一裁决（含 calibOn 门控）
      applyCursor(curCursorSec);
      rebuildGrid(axisFieldNames(), accent);
      needsRender = true;
    },

    applyTheme() {
      const bg = new T3.Color(cssVar("--bg-inset", "#0b0d10"));
      bgColor.copy(bg);
      scene.background = bg;
      for (const g of gstates.values()) g.uniforms.uBg.value.copy(bg);
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
      const p = followAnchor();
      if (!p) return;
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

    focusGroup(gid) {
      const g = gstates.get(gid);
      if (!g) return;
      const hasBuf = g.tCount + g.oCount > 0;
      const c = hasBuf
        ? [
            (g.bbMin[0] + g.bbMax[0]) / 2,
            (g.bbMin[1] + g.bbMax[1]) / 2,
            (g.bbMin[2] + g.bbMax[2]) / 2,
          ]
        : g.latest
          ? [g.latest.x, g.latest.y, g.latest.z]
          : null;
      if (!c) return;
      const tgt = new T3.Vector3(toN(c[0], 0), toN(c[1], 1), toN(c[2], 2));
      const off = camera.position.clone().sub(controls.target);
      tween = {
        p0: camera.position.clone(),
        p1: tgt.clone().add(off),
        t0v: controls.target.clone(),
        t1v: tgt,
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

    // ---------- P87b：GLTF 模型注入 / 会话标注旗标 ----------
    beginModelRequest,

    setModelBytes(gid, bytes, request) {
      const g = gstates.get(gid);
      if (disposed || !g || g.cfg.model.kind !== "gltf" || !g.cfg.model.src) return;
      const src = g.cfg.model.src;
      const token = request ?? beginModelRequest(gid);
      const valid = () => !disposed && gstates.get(gid) === g &&
        g.cfg.model.kind === "gltf" && g.cfg.model.src === src && modelRequests.get(g) === token;
      if (!valid()) return;
      attachMarker(g);
      const entry = gltfCache.get(src)!;
      if (entry.template) {
        updateDecorations(g);
        return;
      }
      if (!bytes) {
        cbs.onModelError?.(gid, src);
        return;
      }
      if (!entry.pending) {
        entry.pending = (async () => {
          const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
          if (disposed || gltfCache.get(src) !== entry) return null;
          const gltf = await new Promise<{ scene: THREE_NS.Group }>((resolve, reject) =>
            new GLTFLoader().parse(bytes, "", resolve, reject));
          if (disposed || gltfCache.get(src) !== entry) {
            disposeOwned([gltf.scene], true);
            return null;
          }
          const box = new T3.Box3().setFromObject(gltf.scene);
          const sz = box.getSize(new T3.Vector3());
          const ctr = box.getCenter(new T3.Vector3());
          const scale = 0.09 / Math.max(sz.x, sz.y, sz.z, 1e-6);
          const wrap = new T3.Group();
          gltf.scene.scale.setScalar(scale);
          gltf.scene.position.copy(ctr).multiplyScalar(-scale);
          wrap.add(gltf.scene);
          entry.template = wrap;
          return wrap;
        })();
      }
      const pending = entry.pending;
      void pending.then((template) => {
        if (template && valid()) {
          attachMarker(g);
          updateDecorations(g);
        }
      }, () => {
        if (valid()) cbs.onModelError?.(gid, src);
      }).finally(() => {
        if (entry.pending === pending) entry.pending = null;
      });
    },

    setAnnots(relSecs) {
      flagRels = relSecs.length > 48 ? relSecs.slice(-48) : relSecs;
      while (flagPool.length < flagRels.length) {
        const sp = new T3.Sprite(
          new T3.SpriteMaterial({ map: ensureFlagTex(), transparent: true, depthTest: false }),
        );
        sp.scale.set(0.03, 0.037, 1);
        flagGroup.add(sp);
        flagPool.push(sp);
      }
      refreshFlags();
      needsRender = true;
    },

    snapshotPng() {
      renderer.render(scene, camera); // 同步渲染一帧后再取像素（无需 preserveDrawingBuffer）
      needsRender = false;
      return renderer.domElement.toDataURL("image/png");
    },

    clearTrajectory(gid) {
      if (gid) {
        const g = gstates.get(gid);
        if (g) {
          clearGroup(g);
          scanGroupBB(g);
        }
      } else {
        for (const g of gstates.values()) clearGroup(g);
        for (let a = 0; a < 3; a++) {
          bbMin[a] = Infinity;
          bbMax[a] = -Infinity;
        }
      }
      unionBBox();
      for (const g of gstates.values()) {
        g.uniforms.uNow.value = 0;
        g.uniforms.uSpan.value = 1;
      }
      needsRender = true;
    },

    pick(px, py) {
      if (totalPoints() === 0) return null;
      camera.updateMatrixWorld();
      const rect = renderer.domElement.getBoundingClientRect();
      const vp = new T3.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      const v = new T3.Vector4();
      let best: { g: GState; inOv: boolean; idx: number; d: number } | null = null;
      for (const g of gstates.values()) {
        if (!g.cfg.visible || g.cfg.mode === "point") continue;
        const search = (
          pos: Float32Array | null,
          count: number,
          inOv: boolean,
        ) => {
          if (!pos || count === 0) return;
          // 游标截断范围内才可命中（与 drawRange 一致）
          const n =
            curCursorSec === null
              ? count
              : lowerBoundLe(inOv ? g.oT! : g.tT!, count, curCursorSec);
          if (n === 0) return;
          const stride = Math.max(1, Math.floor(n / 1200));
          let local = -1;
          let bd = Infinity;
          for (let i = 0; i < n; i += stride) {
            v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 1).applyMatrix4(vp);
            if (v.w <= 0) continue;
            const sx = ((v.x / v.w + 1) / 2) * rect.width + rect.left;
            const sy = ((1 - (v.y / v.w + 1) / 2) * rect.height) + rect.top;
            const dx = sx - px;
            const dy = sy - py;
            const d = dx * dx + dy * dy;
            if (d < bd) {
              bd = d;
              local = i;
            }
          }
          if (local < 0) return;
          // 邻域精化
          const lo = Math.max(0, local - stride);
          const hi = Math.min(n - 1, local + stride);
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
              local = i;
            }
          }
          const d = Math.sqrt(bd);
          if (d > 14) return;
          if (!best || d < best.d) best = { g, inOv, idx: local, d };
        };
        if (best) {
          const b0 = best as { g: GState; inOv: boolean; idx: number; d: number };
          if (b0.d <= 2) continue; // 已近中：其余层只做同层竞争，省一半投影
        }
        search(g.tPos, g.tCount, false);
        search(g.oPos, g.oCount, true);
      }
      const hit = best as { g: GState; inOv: boolean; idx: number; d: number } | null;
      if (!hit) return null;
      const { g, inOv, idx: i } = hit;
      const realSrc = inOv ? g.oReal! : g.tReal!;
      const posSrc = inOv ? g.oPos! : g.tPos!;
      const tSrc = inOv ? g.oT! : g.tT!;
      const valSrc = inOv ? g.oVal! : g.tVal!;
      const real: [number, number, number] = [realSrc[i * 3], realSrc[i * 3 + 1], realSrc[i * 3 + 2]];
      v.set(posSrc[i * 3], posSrc[i * 3 + 1], posSrc[i * 3 + 2], 1).applyMatrix4(vp);
      const sx = ((v.x / v.w + 1) / 2) * rect.width + rect.left;
      const sy = (1 - (v.y / v.w + 1) / 2) * rect.height + rect.top;
      return {
        tSec: tSrc[i],
        real,
        val: valSrc[i],
        screen: [sx, sy],
        distPx: hit.d,
        gid: g.gid,
      };
    },

    stats() {
      const out: Record<string, GroupStats> = {};
      for (const g of gstates.values()) out[g.gid] = { tail: g.tCount, overview: g.oCount };
      return { groups: out as Record<GroupId, GroupStats>, fps, gridStep: curGridStep };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
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
      for (const g of [...gstates.values()]) disposeGroup(g);
      disposeOwned([scene], true);
      modelRequests.clear();
      gltfCache.clear();
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
