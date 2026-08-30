import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as THREE_NS from "three";
import type { OrbitControls as OrbitControlsType } from "three/examples/jsm/controls/OrbitControls.js";
import * as store from "./attitudeStore";
import type { EulerOrder } from "./attitudeStore";
import * as templateStore from "../protocol/templateStore";

const ORDERS: EulerOrder[] = ["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"];

const deg2rad = (d: number) => (d * Math.PI) / 180;

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
  } else {
    // ---- 四轴（X 布局，机头朝 +X）----
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x272c35,
      metalness: 0.35,
      roughness: 0.55,
    });
    const midMat = new THREE.MeshStandardMaterial({
      color: 0x39414e,
      metalness: 0.3,
      roughness: 0.5,
    });
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x8b93a1,
      metalness: 0.85,
      roughness: 0.3,
    });
    const accentSolid = new THREE.MeshStandardMaterial({
      color: new THREE.Color(accent),
      metalness: 0.2,
      roughness: 0.45,
    });
    const canopyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(accent),
      metalness: 0.1,
      roughness: 0.2,
      transparent: true,
      opacity: 0.55,
    });
    const props: THREE_NS.Group[] = [];

    // 机身：下主版 + 上舱盖 + 前挡风 + 电池
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.16, 0.78), darkMat);
    model.add(plate);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.17, 0.5), midMat);
    canopy.position.set(-0.08, 0.16, 0);
    model.add(canopy);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.42), canopyMat);
    windshield.position.set(0.26, 0.16, 0);
    windshield.rotation.z = -0.5;
    model.add(windshield);
    const battery = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.12, 0.32), darkMat);
    battery.position.set(-0.05, 0.3, 0);
    model.add(battery);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.34), accentSolid);
    strap.position.set(-0.05, 0.3, 0);
    model.add(strap);
    // 机头标识条
    const noseBar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.6), accentSolid);
    noseBar.position.set(0.52, 0.02, 0);
    model.add(noseBar);

    // 起落架：两侧滑橇 + 支腿
    const railGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.92, 8);
    const legGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.3, 8);
    for (const sx of [1, -1]) {
      const rail = new THREE.Mesh(railGeo, metalMat);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(sx * 0.3, -0.32, 0);
      model.add(rail);
      for (const sz of [1, -1]) {
        const leg = new THREE.Mesh(legGeo, darkMat);
        leg.position.set(sx * 0.3, -0.17, sz * 0.26);
        leg.rotation.x = sz * 0.22;
        model.add(leg);
      }
    }

    // 四条斜臂 + 电机 + 双叶桨（对桨反向自转）
    const armGeo = new THREE.BoxGeometry(0.09, 0.075, 0.82);
    const bellGeo = new THREE.CylinderGeometry(0.1, 0.125, 0.15, 14);
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
      arm.position.set(sx * 0.45, 0.02, sz * 0.45);
      model.add(arm);

      const bell = new THREE.Mesh(bellGeo, metalMat);
      bell.position.set(sx * 0.72 * inv, 0.1, sz * 0.72 * inv);
      model.add(bell);

      const prop = new THREE.Group();
      prop.position.set(sx * 0.72 * inv, 0.2, sz * 0.72 * inv);
      const hub = new THREE.Mesh(hubGeo, darkMat);
      prop.add(hub);
      for (const rot of [0, Math.PI]) {
        const blade = new THREE.Mesh(bladeGeo, accentSolid);
        blade.scale.set(0.46, 0.012, 0.075);
        blade.position.set(Math.cos(rot) * 0.23, 0.015, Math.sin(rot) * 0.23);
        blade.rotation.y = rot;
        prop.add(blade);
      }
      model.add(prop);
      props.push(prop);
    });
    model.userData.props = props;
  }

  const axisLen = type === "cube" ? 1.35 : 1.15;
  const mkAxis = (color: number, dir: [number, number, number]) => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(dir[0] * axisLen, dir[1] * axisLen, dir[2] * axisLen),
    ]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  };
  model.add(mkAxis(0xe5534b, [1, 0, 0]));
  model.add(mkAxis(0x3fb950, [0, 1, 0]));
  model.add(mkAxis(0x4e9cef, [0, 0, 1]));
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
      buildModel(model, cfgRef.current.model, THREE, accent);
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
  }, [themeTick, attitude.config.model]);

  const onTemplateChange = (templateId: string) => {
    const t = proto.rules.templates.find((x) => x.id === templateId);
    const patch = t
      ? store.autoMatch(t.fields.filter((f) => f.type !== "ascii"))
      : {};
    store.setConfig({ templateId, ...patch });
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
          value={attitude.config.model}
          title="模型"
          onChange={(e) =>
            store.setConfig({ model: e.target.value as "cube" | "uav" })
          }
        >
          <option value="uav">四轴飞行器</option>
          <option value="cube">立方体</option>
        </select>
        <button className="btn" onClick={resetView} title="复位观察视角">
          复位视角
        </button>
        <div className="v3d-hud" ref={hudRef}>
          等待姿态数据…
        </div>
      </div>
      <div className="v3d-canvas" ref={wrapRef}>
        <div className="v3d-host" ref={hostRef} />
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
