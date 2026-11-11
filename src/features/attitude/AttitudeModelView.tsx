import { useEffect, useRef } from "react";
import type * as THREE_NS from "three";
import type { OrbitControls as OrbitControlsType } from "three/examples/jsm/controls/OrbitControls.js";
import * as store from "./attitudeStore";
import { useSettings } from "../settings/settingsStore";
import { tx } from "../../i18n/strings";
import * as panelActivity from "../../panels/panelActivity";
import { buildModel } from "./View3D";
import {
  nextQuality,
  pixelRatioFor,
  targetFpsOf,
  type QualityLevel,
} from "./attitudeViewQuality";

const deg2rad = (d: number) => (d * Math.PI) / 180;

export interface AttitudeModelViewProps {
  /** 锁定后 OrbitControls 不接管指针：卡片拖动/页面滚动不会被误转视角。 */
  locked?: boolean;
}

/**
 * 姿态 3D **模型视图**：只画模型那一块，不挂面板工具栏/绑定区/状态栏。
 *
 * 与停靠版 `View3D` 的分工：
 * - 数据只订阅 `attitudeStore`（绑定配置与数值都在那），不碰协议模板表；
 * - 每实例一个 WebGL 上下文，因此看 `attitudeViewQuality` 的预算与降级阶梯；
 * - 可见性用 `panelActivity.isVisible("attitude3d")`，由宿主按 rAF 比较卡片 rect 得出；
 * - 像素比取 `dpr × 全局缩放`，硬上限 2。
 */
export function AttitudeModelView({ locked = false }: AttitudeModelViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControlsType | null>(null);
  const lockedRef = useRef(locked);
  const settings = useSettings();
  const zoomRef = useRef(settings.zoom);
  zoomRef.current = settings.zoom;
  lockedRef.current = locked;

  useEffect(() => {
    if (controlsRef.current) controlsRef.current.enabled = !locked;
  }, [locked]);

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

      let level: QualityLevel = 0;
      const zf = () => (zoomRef.current || 100) / 100;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio || 1, zf(), level));
      renderer.setSize(
        Math.max(wrap.clientWidth, 60),
        Math.max(wrap.clientHeight, 60),
      );
      host.appendChild(renderer.domElement);

      // 左键旋转、右键平移、滚轮缩放都是 OrbitControls 默认映射，不另写手势。
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enabled = !lockedRef.current;
      controlsRef.current = controls;

      // 滚轮分流：指针在卡片内时，OrbitControls 已经在 canvas 上完成缩放，
      // 这里在宿主上截停冒泡，避免事件继续传到底下 `.ctl-grid` 的整板滚轮
      // handler（否则缩放模型的同时控制画布也在滚）。锁定时不拦：模型不接管
      // 指针，滚轮交还给画布滚动，与"锁定交互"的语义一致。
      // 非被动监听是必须的：被动监听里 preventDefault 会被忽略。
      // 缩放量取 deltaY，不依赖 clientX/Y，所以全局 CSS zoom 不影响滚轮手感。
      const onWheel = (e: WheelEvent) => {
        if (lockedRef.current) return;
        e.stopPropagation();
        e.preventDefault();
      };
      host.addEventListener("wheel", onWheel, { passive: false });

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
      buildModel(model, store.getSnapshot().config.model, THREE, accent);
      scene.add(model);

      const targetQ = new THREE.Quaternion();
      const eul = new THREE.Euler();
      let raf = 0;
      let last = performance.now();
      let lastRender = 0;
      let lastData = -1;
      let frames = 0;
      let sampleAt = performance.now();
      let levelAt = performance.now();

      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        // 卡片滚出视口 / 宿主页签在后台：完全不画，也不采样（否则 fps 会被算成 0 而误降级）。
        if (!panelActivity.isVisible("attitude3d")) {
          sampleAt = now;
          levelAt = now;
          frames = 0;
          return;
        }
        if (now - lastRender < 1000 / targetFpsOf(level)) return;
        lastRender = now;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        controls.update();

        const cfg = store.getSnapshot().config;
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
        if (hintRef.current && v.has !== (lastData === 1)) {
          lastData = v.has ? 1 : 0;
          hintRef.current.style.display = v.has ? "none" : "flex";
        }
        renderer.render(scene, camera);

        // 每秒采一次帧率；降级只改像素比，不重建场景、不重置相机。
        frames++;
        if (now - sampleAt >= 1000) {
          const fps = (frames * 1000) / (now - sampleAt);
          frames = 0;
          sampleAt = now;
          const next = nextQuality(level, { fps, msInLevel: now - levelAt });
          if (next !== level) {
            level = next;
            levelAt = now;
            renderer.setPixelRatio(
              pixelRatioFor(window.devicePixelRatio || 1, zf(), level),
            );
            renderer.setSize(
              Math.max(wrap.clientWidth, 60),
              Math.max(wrap.clientHeight, 60),
            );
          }
        }
      };
      raf = requestAnimationFrame(loop);

      const ro = new ResizeObserver(() => {
        const w = Math.max(wrap.clientWidth, 60);
        const h = Math.max(wrap.clientHeight, 60);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio || 1, zf(), level));
        renderer.setSize(w, h);
      });
      ro.observe(wrap);

      // 主题切换只改颜色，不重建场景（重建会丢相机位置，看起来像"切主题重置了视角"）。
      const mo = new MutationObserver(() => {
        const c2 = getComputedStyle(document.documentElement);
        scene.background = new THREE.Color(
          c2.getPropertyValue("--bg-inset").trim() || "#0b0d10",
        );
        const gc = c2.getPropertyValue("--border").trim() || "#262b33";
        // GridHelper 的颜色烘进了顶点色，改材质色无效，直接重建最稳（只在切主题时发生）。
        grid.geometry.dispose();
        (grid.material as THREE_NS.Material).dispose();
        const fresh = new THREE.GridHelper(
          8,
          16,
          new THREE.Color(gc),
          new THREE.Color(gc),
        );
        const fm = fresh.material as THREE_NS.Material;
        fm.transparent = true;
        fm.opacity = 0.35;
        scene.remove(grid);
        scene.add(fresh);
      });
      mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });

      cleanup = () => {
        cancelAnimationFrame(raf);
        host.removeEventListener("wheel", onWheel);
        ro.disconnect();
        mo.disconnect();
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
        controlsRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return (
    <div className="att-view" ref={wrapRef}>
      <div className="att-view-host" ref={hostRef} />
      <div className="att-view-empty" ref={hintRef}>
        {tx("等待姿态数据…", "Waiting for attitude data…")}
      </div>
      {locked && (
        <div className="att-view-locked">
          {tx("交互已锁定", "Interaction locked")}
        </div>
      )}
    </div>
  );
}
