import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type * as THREE_NS from "three";
import type { OrbitControls as OrbitControlsType } from "three/examples/jsm/controls/OrbitControls.js";
import type { GLTFLoader as GLTFLoaderType } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as store from "./attitudeStore";
import type { EulerOrder } from "./attitudeStore";
import * as templateStore from "../protocol/templateStore";

const ORDERS: EulerOrder[] = ["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"];

const deg2rad = (d: number) => (d * Math.PI) / 180;

type ModelSel = "uav" | "cube" | "cesium" | "custom";

interface CustomMeta {
  name: string;
  path: string;
}

const SEL_KEY = "vs.3d.sel";
const CUSTOM_KEY = "vs.3d.custom";
const ROT_KEY = "vs.3d.rot";

let customBytesCache: ArrayBuffer | null = null;

function loadSel(): ModelSel {
  const s = localStorage.getItem(SEL_KEY);
  return s === "cube" || s === "cesium" || s === "custom" ? s : "uav";
}

function loadCustom(): CustomMeta | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as CustomMeta;
    return p && p.path ? p : null;
  } catch {
    return null;
  }
}

/** 平面"贴纸"箭头：平放在模型顶部，指向 +X 机头方向 */
function addStickerArrow(
  model: THREE_NS.Group,
  THREE: typeof THREE_NS,
  topY: number,
  span: number,
): void {
  const s = span * 0.34;
  const shape = new THREE.Shape();
  shape.moveTo(-0.62 * s, -0.2 * s);
  shape.lineTo(0.1 * s, -0.2 * s);
  shape.lineTo(0.1 * s, -0.42 * s);
  shape.lineTo(0.62 * s, 0);
  shape.lineTo(0.1 * s, 0.42 * s);
  shape.lineTo(0.1 * s, 0.2 * s);
  shape.lineTo(-0.62 * s, 0.2 * s);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffd43b,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = topY + span * 0.012;
  model.add(mesh);
}

function buildModel(
  model: THREE_NS.Group,
  type: "cube" | "uav",
  THREE: typeof THREE_NS,
  accent: string,
): void {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x9aa4b2,
    metalness: 0.35,
    roughness: 0.45,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent),
    metalness: 0.2,
    roughness: 0.4,
  });

  if (type === "cube") {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), bodyMat);
    model.add(box);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.7, 1.7, 1.7)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }),
    );
    model.add(edges);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 16), accentMat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(1.1, 0, 0);
    model.add(nose);
    addStickerArrow(model, THREE, 0.88, 1.4);
    return;
  }

  // ---- 四轴（X 布局，机头朝 +X）----
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x47505f,
    metalness: 0.35,
    roughness: 0.55,
  });
  const midMat = new THREE.MeshStandardMaterial({
    color: 0x5c6678,
    metalness: 0.3,
    roughness: 0.5,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x9aa3b1,
    metalness: 0.85,
    roughness: 0.3,
  });
  const accentSolid = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent),
    metalness: 0.2,
    roughness: 0.45,
  });
  const ledMat = new THREE.MeshStandardMaterial({
    color: 0xe5534b,
    emissive: 0xe5534b,
    emissiveIntensity: 0.9,
  });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x11151b,
    metalness: 0.1,
    roughness: 0.15,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent),
    metalness: 0.1,
    roughness: 0.2,
    transparent: true,
    opacity: 0.55,
  });
  const props: THREE_NS.Group[] = [];

  // 碳板机架：下主板 + 上盖板 + 4 铜柱（铜柱严格连接两板：0.07 → 0.26）
  const plate = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.14, 0.78), darkMat);
  model.add(plate);
  const topPlate = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.5), midMat);
  topPlate.position.set(-0.06, 0.3, 0);
  model.add(topPlate);
  const standoffGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.19, 8);
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const so = new THREE.Mesh(standoffGeo, metalMat);
      so.position.set(-0.06 + sx * 0.24, 0.165, sz * 0.18);
      model.add(so);
    }
  }

  // 舱盖 + 前挡风
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.44), midMat);
  canopy.position.set(-0.1, 0.42, 0);
  model.add(canopy);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.38), glassMat);
  windshield.position.set(0.2, 0.42, 0);
  windshield.rotation.z = -0.5;
  model.add(windshield);

  // 电池（顶置）+ 扎带
  const battery = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.11, 0.3), darkMat);
  battery.position.set(-0.08, 0.5, 0);
  model.add(battery);
  for (const sx of [1, -1]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.32), accentSolid);
    strap.position.set(-0.08 + sx * 0.12, 0.5, 0);
    model.add(strap);
  }

  // 前置云台相机：球机 + 镜头 + 挂架
  const gimbalArm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), metalMat);
  gimbalArm.position.set(0.4, -0.08, 0);
  model.add(gimbalArm);
  const camBall = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12), midMat);
  camBall.position.set(0.4, -0.18, 0);
  model.add(camBall);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12), lensMat);
  lens.rotation.z = Math.PI / 2;
  lens.position.set(0.5, -0.18, 0);
  model.add(lens);
  const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 16), accentSolid);
  lensRing.rotation.y = Math.PI / 2;
  lensRing.position.set(0.51, -0.18, 0);
  model.add(lensRing);

  // 机头标识条 + 尾部 LED
  const noseBar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.56), accentSolid);
  noseBar.position.set(0.5, 0.02, 0);
  model.add(noseBar);
  const tailLed = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.5), ledMat);
  tailLed.position.set(-0.5, 0.02, 0);
  model.add(tailLed);

  // 天线：两根后向斜立 5.8G 鞭状天线
  const antGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.34, 6);
  const antCap = new THREE.SphereGeometry(0.024, 8, 8);
  for (const sz of [1, -1]) {
    const ant = new THREE.Mesh(antGeo, lensMat);
    ant.position.set(-0.42, 0.42, sz * 0.1);
    ant.rotation.x = sz * 0.5;
    ant.rotation.z = 0.35;
    model.add(ant);
    const cap = new THREE.Mesh(antCap, accentSolid);
    cap.position.set(-0.51, 0.55, sz * 0.16);
    model.add(cap);
  }

  // 起落架：两侧滑橇 + 支腿
  const railGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.92, 8);
  const legGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.3, 8);
  for (const sx of [1, -1]) {
    const rail = new THREE.Mesh(railGeo, metalMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(sx * 0.3, -0.34, 0);
    model.add(rail);
    for (const sz of [1, -1]) {
      const leg = new THREE.Mesh(legGeo, darkMat);
      leg.position.set(sx * 0.3, -0.18, sz * 0.26);
      leg.rotation.x = sz * 0.22;
      model.add(leg);
    }
  }

  // 四条斜臂 + 电机（铃 + 顶盖 + 桨帽）+ 双叶桨（对桨反向自转）
  // 桨盘直径 0.72：相邻桨间隙 ≥0.34，绝不互相碰撞；电机沿臂外移到 0.78
  const armGeo = new THREE.BoxGeometry(0.09, 0.07, 0.86);
  const bellGeo = new THREE.CylinderGeometry(0.1, 0.125, 0.15, 14);
  const bellTopGeo = new THREE.CylinderGeometry(0.06, 0.1, 0.05, 14);
  const hubGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.05, 10);
  const bladeGeo = new THREE.SphereGeometry(1, 12, 8);
  const dirs: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  dirs.forEach(([sx, sz]) => {
    const inv = 1 / Math.SQRT2;
    const arm = new THREE.Mesh(armGeo, darkMat);
    arm.rotation.y = sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4;
    arm.position.set(sx * 0.47, 0.02, sz * 0.47);
    model.add(arm);

    const bell = new THREE.Mesh(bellGeo, metalMat);
    bell.position.set(sx * 0.78 * inv, 0.08, sz * 0.78 * inv);
    model.add(bell);
    const bellTop = new THREE.Mesh(bellTopGeo, darkMat);
    bellTop.position.set(sx * 0.78 * inv, 0.18, sz * 0.78 * inv);
    model.add(bellTop);

    const prop = new THREE.Group();
    prop.position.set(sx * 0.78 * inv, 0.22, sz * 0.78 * inv);
    const hub = new THREE.Mesh(hubGeo, darkMat);
    prop.add(hub);
    for (const rot of [0, Math.PI]) {
      const blade = new THREE.Mesh(bladeGeo, accentSolid);
      blade.scale.set(0.36, 0.012, 0.06);
      blade.position.set(Math.cos(rot) * 0.18, 0.015, Math.sin(rot) * 0.18);
      blade.rotation.y = rot;
      prop.add(blade);
    }
    model.add(prop);
    props.push(prop);
  });
  model.userData.props = props;
  addStickerArrow(model, THREE, 0.555, 1.0);
}

export function View3D() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE_NS.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControlsType | null>(null);
  const cfgRef = useRef(store.getSnapshot().config);
  const [themeTick, setThemeTick] = useState(0);
  const attitude = useSyncExternalStore(store.subscribe, store.getSnapshot);
  cfgRef.current = attitude.config;
  const proto = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const [sel, setSel] = useState<ModelSel>(loadSel);
  const [custom, setCustom] = useState<CustomMeta | null>(loadCustom);
  const [rot, setRot] = useState<number>(() => Number(localStorage.getItem(ROT_KEY) ?? 0));
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  const tpl = proto.rules.templates.find(
    (t) => t.id === attitude.config.templateId,
  );
  const numericFields = (tpl?.fields ?? []).filter((f) => f.type !== "ascii");

  useEffect(() => {
    let disposed = false;
    let cleanup: () => void = () => {};

    (async () => {
      const THREE = await import("three");
      const { OrbitControls } = await import(
        "three/examples/jsm/controls/OrbitControls.js"
      );
      const wrap = wrapRef.current;
      const host = hostRef.current;
      if (disposed || !wrap || !host) return;

      const cs = getComputedStyle(document.documentElement);
      const bgColor = cs.getPropertyValue("--bg-inset").trim() || "#0b0d10";
      const gridColor = cs.getPropertyValue("--border").trim() || "#262b33";
      const accent = cs.getPropertyValue("--accent").trim() || "#4e9cef";

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(bgColor);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(3.2, 2.3, 3.6);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(
        Math.max(wrap.clientWidth, 60),
        Math.max(wrap.clientHeight, 60),
      );
      host.appendChild(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      cameraRef.current = camera;
      controlsRef.current = controls;

      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const key = new THREE.DirectionalLight(0xffffff, 1.5);
      key.position.set(4, 6, 3);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.45);
      fill.position.set(-4, -2, -4);
      scene.add(fill);

      const grid = new THREE.GridHelper(
        8,
        16,
        new THREE.Color(gridColor),
        new THREE.Color(gridColor),
      );
      const gridMat = grid.material as THREE_NS.Material;
      gridMat.transparent = true;
      gridMat.opacity = 0.35;
      scene.add(grid);
      scene.add(new THREE.AxesHelper(1.5));

      const model = new THREE.Group();
      if (sel === "cesium" || sel === "custom") {
        try {
          const { GLTFLoader } = (await import(
            "three/examples/jsm/loaders/GLTFLoader.js"
          )) as { GLTFLoader: typeof GLTFLoaderType };
          let buf: ArrayBuffer | null = null;
          if (sel === "cesium") {
            const res = await fetch("/models/CesiumDrone.glb");
            if (!res.ok) throw new Error(`模型资源缺失 (${res.status})`);
            buf = await res.arrayBuffer();
          } else if (custom) {
            if (customBytesCache) {
              buf = customBytesCache;
            } else {
              const bin = await invoke<number[]>("read_binary_file", { path: custom.path });
              buf = new Uint8Array(bin).buffer;
              customBytesCache = buf;
            }
          }
          if (disposed) return;
          if (!buf) throw new Error("未选择模型文件");
          const loader = new GLTFLoader();
          const gltf = await new Promise<{ scene: THREE_NS.Group }>(
            (resolve, reject) => loader.parse(buf as ArrayBuffer, "", resolve, reject),
          );
          if (disposed) return;
          // 归一化：等比缩放至 ~2.4 单位，居中到原点，机头朝向可修正
          const inner = gltf.scene;
          inner.rotation.y = deg2rad(rot);
          const box0 = new THREE.Box3().setFromObject(inner);
          const size = box0.getSize(new THREE.Vector3());
          const s = 2.4 / (Math.max(size.x, size.y, size.z) || 1);
          inner.scale.setScalar(s);
          const box1 = new THREE.Box3().setFromObject(inner);
          const center = box1.getCenter(new THREE.Vector3());
          inner.position.x -= center.x;
          inner.position.z -= center.z;
          inner.position.y -= center.y;
          model.add(inner);
          const box2 = new THREE.Box3().setFromObject(model);
          const span = box2.max.y - box2.min.y;
          addStickerArrow(model, THREE, box2.max.y, Math.max(span, 0.8));
        } catch (e) {
          setLoadErr(String(e).replace(/^Error:\s*/, ""));
          buildModel(model, "uav", THREE, accent);
        }
      } else {
        buildModel(model, sel, THREE, accent);
      }
      scene.add(model);

      const targetQ = new THREE.Quaternion();
      const eul = new THREE.Euler();
      let raf = 0;
      let last = performance.now();
      let lastRender = 0;
      let visible = true;
      const io = new IntersectionObserver((es) => {
        visible = es[0]?.isIntersecting ?? true;
      });
      io.observe(host);
      const FRAME_MS = 1000 / 30;
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        if (!visible || now - lastRender < FRAME_MS) return;
        lastRender = now;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        controls.update();
        const cfg = cfgRef.current;
        const v = store.values;
        if (cfg.mode === "euler") {
          eul.set(
            (cfg.invertX ? -1 : 1) * deg2rad(v.roll),
            (cfg.invertY ? -1 : 1) * deg2rad(v.pitch),
            (cfg.invertZ ? -1 : 1) * deg2rad(v.yaw),
            cfg.order,
          );
          targetQ.setFromEuler(eul);
        } else {
          targetQ.set(v.qx, v.qy, v.qz, v.qw).normalize();
        }
        model.quaternion.slerp(targetQ, 1 - Math.exp(-dt * 14));
        const props = model.userData.props as THREE_NS.Group[] | undefined;
        if (props) {
          for (let i = 0; i < props.length; i++) {
            props[i].rotation.y += dt * (i % 2 === 0 ? 16 : -16);
          }
        }
        if (hudRef.current) {
          hudRef.current.textContent = v.has
            ? `R ${v.roll.toFixed(1)}°  P ${v.pitch.toFixed(1)}°  Y ${v.yaw.toFixed(1)}°`
            : "等待姿态数据…";
        }
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(loop);

      const ro = new ResizeObserver(() => {
        const w = Math.max(wrap.clientWidth, 60);
        const h = Math.max(wrap.clientHeight, 60);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });
      ro.observe(wrap);

      cleanup = () => {
        cancelAnimationFrame(raf);
        io.disconnect();
        ro.disconnect();
        controls.dispose();
        renderer.dispose();
        scene.traverse((obj) => {
          const mesh = obj as THREE_NS.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const mat = mesh.material as THREE_NS.Material | THREE_NS.Material[];
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) mat.dispose();
        });
        if (renderer.domElement.parentElement === host) {
          host.removeChild(renderer.domElement);
        }
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [themeTick, sel, rot, custom]);

  const onTemplateChange = (templateId: string) => {
    const t = proto.rules.templates.find((x) => x.id === templateId);
    const patch = t
      ? store.autoMatch(t.fields.filter((f) => f.type !== "ascii"))
      : {};
    store.setConfig({ templateId, ...patch });
  };

  const pickModel = async () => {
    const path = await open({
      title: "选择 3D 模型（建议 GLB）",
      multiple: false,
      filters: [{ name: "3D 模型", extensions: ["glb", "gltf"] }],
    });
    if (typeof path !== "string") return;
    try {
      await invoke<number[]>("read_binary_file", { path });
      const meta: CustomMeta = {
        name: path.split(/[\\/]/).pop() ?? "模型",
        path,
      };
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(meta));
      setCustom(meta);
      setLoadErr(null);
      setSel("custom");
      localStorage.setItem(SEL_KEY, "custom");
    } catch (e) {
      setLoadErr(`导入失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
  };

  const changeSel = (v: ModelSel) => {
    localStorage.setItem(SEL_KEY, v);
    setLoadErr(null);
    setSel(v);
  };

  const resetView = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    camera.position.set(3.2, 2.3, 3.6);
    controls.target.set(0, 0, 0);
    controls.update();
  };

  const isEuler = attitude.config.mode === "euler";
  const isGltf = sel === "cesium" || sel === "custom";
  const fieldSelect = (
    value: string,
    onChange: (v: string) => void,
    label: string,
  ) => (
    <label className="v3d-field">
      <span>{label}</span>
      <select
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {numericFields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="view3d">
      <div className="v3d-bar">
        <select
          className="input"
          value={sel}
          title="模型"
          onChange={(e) => changeSel(e.target.value as ModelSel)}
        >
          <option value="uav">四轴飞行器</option>
          <option value="cube">立方体</option>
          <option value="cesium">四轴 · 精细（Cesium）</option>
          {custom && <option value="custom">外部模型 · {custom.name}</option>}
        </select>
        <button className="btn" onClick={() => void pickModel()} title="导入外部 GLB/GLTF 模型">
          导入模型
        </button>
        {isGltf && (
          <select
            className="input"
            value={rot}
            title="机头朝向修正（绕竖直轴旋转）"
            onChange={(e) => {
              const v = Number(e.target.value);
              localStorage.setItem(ROT_KEY, String(v));
              setRot(v);
            }}
          >
            <option value={0}>机头 +X</option>
            <option value={90}>机头 +Z</option>
            <option value={180}>机头 -X</option>
            <option value={270}>机头 -Z</option>
          </select>
        )}
        <button className="btn" onClick={resetView} title="复位观察视角">
          复位视角
        </button>
        <div className="v3d-hud" ref={hudRef}>
          等待姿态数据…
        </div>
      </div>
      <div className="v3d-canvas" ref={wrapRef}>
        <div className="v3d-host" ref={hostRef} />
        {loadErr && <div className="v3d-loaderr">模型加载失败：{loadErr}（已回退内置四轴）</div>}
      </div>
      <div className="v3d-bind">
        <div className="v3d-bind-row">
          <label className="v3d-field grow">
            <span>模板</span>
            <select
              className="input"
              value={attitude.config.templateId}
              onChange={(e) => onTemplateChange(e.target.value)}
              title="选择后自动按字段名匹配姿态字段"
            >
              <option value="">— 选择协议模板 —</option>
              {proto.rules.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="v3d-seg">
            <button
              className={`btn ${isEuler ? "warn" : ""}`}
              onClick={() => store.setConfig({ mode: "euler" })}
            >
              欧拉角
            </button>
            <button
              className={`btn ${!isEuler ? "warn" : ""}`}
              onClick={() => store.setConfig({ mode: "quaternion" })}
            >
              四元数
            </button>
          </div>
          <button
            className="btn"
            onClick={() =>
              store.setConfig(
                store.autoMatch(numericFields),
              )
            }
            title="按字段名关键词自动匹配（roll/pitch/yaw 或 qw/qx/qy/qz）"
          >
            自动匹配
          </button>
        </div>
        {isEuler ? (
          <div className="v3d-bind-row">
            {fieldSelect(attitude.config.roll, (v) => store.setConfig({ roll: v }), "Roll")}
            {fieldSelect(attitude.config.pitch, (v) => store.setConfig({ pitch: v }), "Pitch")}
            {fieldSelect(attitude.config.yaw, (v) => store.setConfig({ yaw: v }), "Yaw")}
            <label className="v3d-field">
              <span>顺序</span>
              <select
                className="input"
                value={attitude.config.order}
                onChange={(e) =>
                  store.setConfig({ order: e.target.value as EulerOrder })
                }
                title="欧拉角旋转顺序（惯导常用 ZYX）"
              >
                {ORDERS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
            <div className="v3d-inv">
              <span>取反</span>
              {(["X", "Y", "Z"] as const).map((ax) => (
                <button
                  key={ax}
                  className={`btn inv-chip ${attitude.config[`invert${ax}`] ? "warn" : ""}`}
                  onClick={() =>
                    store.setConfig({
                      [`invert${ax}`]: !attitude.config[`invert${ax}`],
                    } as Partial<typeof attitude.config>)
                  }
                  title={`反转 ${ax} 轴角度`}
                >
                  {ax}⊖
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="v3d-bind-row">
            {fieldSelect(attitude.config.qw, (v) => store.setConfig({ qw: v }), "W")}
            {fieldSelect(attitude.config.qx, (v) => store.setConfig({ qx: v }), "X")}
            {fieldSelect(attitude.config.qy, (v) => store.setConfig({ qy: v }), "Y")}
            {fieldSelect(attitude.config.qz, (v) => store.setConfig({ qz: v }), "Z")}
          </div>
        )}
      </div>
    </div>
  );
}
