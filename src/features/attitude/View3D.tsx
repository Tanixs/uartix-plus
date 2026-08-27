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
  const rotorMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent),
    transparent: true,
    opacity: 0.4,
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
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.2, 0.78), bodyMat);
    model.add(plate);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), accentMat);
    dome.position.set(0.32, 0.14, 0);
    model.add(dome);
    const armGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.35, 10);
    const podGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.16, 12);
    const rotorGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.02, 24);
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const arm = new THREE.Mesh(armGeo, bodyMat);
      arm.rotation.z = Math.PI / 2;
      arm.rotation.y = Math.atan2(sz, sx);
      arm.position.set(sx * 0.5, 0, sz * 0.5);
      model.add(arm);
      const pod = new THREE.Mesh(podGeo, bodyMat);
      pod.position.set(sx * 0.92, 0.08, sz * 0.92);
      model.add(pod);
      const rotor = new THREE.Mesh(rotorGeo, rotorMat);
      rotor.position.set(sx * 0.92, 0.18, sz * 0.92);
      model.add(rotor);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 16), accentMat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(0.62, 0.05, 0);
    model.add(nose);
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
