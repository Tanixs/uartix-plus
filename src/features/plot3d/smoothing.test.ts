/**
 * P87b 平滑/变换内核测试（纯函数）。
 * 钉死契约：细分曲线**穿过原始数据点**、t 单调、端点收敛；变换 R·S+T 数值正确；
 * yawQuat/quatMul 与 three 语义一致（w 分量布局）。
 */
import { describe, expect, it } from "vitest";
import {
  splineKernel,
  kernelFor,
  makeTransform,
  normalizeTransform,
  smoothSub,
  smoothTension,
  velocityYawDeg,
  yawQuat,
  quatMul,
} from "./smoothing";

const line = (n: number) => ({
  px: Array.from({ length: n }, (_, i) => i),
  py: new Array(n).fill(0),
  pz: new Array(n).fill(0),
  t: Array.from({ length: n }, (_, i) => i * 0.1),
});

function run(kernel: ReturnType<typeof kernelFor>, px: number[], py: number[], pz: number[], t: number[], sub: number) {
  const out = { pos: [] as number[], t: [] as number[] };
  kernel!.emit(px, py, pz, t, 0, px.length - 1, sub, out);
  return out;
}

describe("catmullRom 核", () => {
  it("tension=0 时逐点等于线性插值（平滑开关的退化锚）", () => {
    const { px, t } = line(6);
    const z = new Array(6).fill(0);
    const out = run(kernelFor("catmullRom", 0), px, z, z, t, 4);
    expect(out.pos.length / 3).toBe(5 * 4);
    // 段 i→i+1 的第 k 个子点 = (i + k/sub)
    for (let j = 0; j < out.pos.length / 3; j++) {
      const seg = Math.floor(j / 4);
      const frac = (j % 4 + 1) / 4;
      expect(out.pos[j * 3]).toBeCloseTo(seg + frac, 9);
      expect(out.t[j]).toBeCloseTo((seg + frac) * 0.1, 9);
    }
  });

  it("曲线穿过原始数据点：每段末子点 = 下一原始点", () => {
    const n = 8;
    const px = Array.from({ length: n }, (_, i) => i);
    const py = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0 : 3));
    const pz = new Array(n).fill(0);
    const t = Array.from({ length: n }, (_, i) => i);
    const sub = 5;
    const out = run(kernelFor("catmullRom", 1), px, py, pz, t, sub);
    for (let seg = 0; seg < n - 1; seg++) {
      const jEnd = (seg + 1) * sub - 1; // 段末子点下标
      expect(out.pos[jEnd * 3]).toBeCloseTo(px[seg + 1], 9);
      expect(out.pos[jEnd * 3 + 1]).toBeCloseTo(py[seg + 1], 9);
    }
  });

  it("首段/末段镜像外推：点数恒 (n-1)×sub，t 严格递增", () => {
    const { px, py, pz, t } = line(5);
    const out = run(kernelFor("catmullRom", 1), px, py, pz, t, 3);
    expect(out.pos.length / 3).toBe(4 * 3);
    for (let i = 1; i < out.t.length; i++) expect(out.t[i]).toBeGreaterThan(out.t[i - 1]);
  });
});

describe("三次样条核", () => {
  it("端点内插值精确（直线数据 → 线性），曲线过数据点", () => {
    const { px, py, pz, t } = line(7);
    const out = run(splineKernel, px, py, pz, t, 4);
    for (let j = 0; j < out.pos.length / 3; j++) {
      const seg = Math.floor(j / 4);
      const frac = (j % 4 + 1) / 4;
      expect(out.pos[j * 3]).toBeCloseTo(seg + frac, 6);
      expect(out.pos[j * 3 + 1]).toBeCloseTo(0, 6);
    }
  });

  it("锯齿数据：样条在段末子点仍穿过原始点；<3 点回退 CR", () => {
    const px = [0, 1, 2, 3, 4];
    const py = [0, 5, 0, 5, 0];
    const pz = [0, 0, 0, 0, 0];
    const t = [0, 1, 2, 3, 4];
    const out = run(splineKernel, px, py, pz, t, 3);
    for (let seg = 0; seg < 4; seg++) {
      const jEnd = (seg + 1) * 3 - 1;
      expect(out.pos[jEnd * 3]).toBeCloseTo(seg + 1, 6);
      expect(out.pos[jEnd * 3 + 1]).toBeCloseTo(py[seg + 1], 4); // 过点（natural 端部容差）
    }
    const tiny = run(splineKernel, [0, 1], [0, 2], [0, 0], [0, 1], 2);
    expect(tiny.pos.length).toBeGreaterThan(0); // n<3 回退 CR 不抛错
  });
});

describe("核工厂与参数钳位", () => {
  it("none/movingAvg → null（1:1 几何走内联路径）", () => {
    expect(kernelFor("none", 0.5)).toBeNull();
    expect(kernelFor("movingAvg", 0.5)).toBeNull();
    expect(kernelFor("catmullRom", 0.5)).not.toBeNull();
    expect(kernelFor("spline", 0.5)).not.toBeNull();
  });
  it("smoothSub/smoothTension 越界钳位", () => {
    expect(smoothSub(99)).toBe(10);
    expect(smoothSub(0)).toBe(2);
    expect(smoothSub("x")).toBe(4);
    expect(smoothTension(3)).toBe(1);
    expect(smoothTension(-2)).toBe(0);
  });
});

describe("组坐标变换", () => {
  it("恒等变换透传；绕 Z 90° + 缩放 2 + 平移的合成", () => {
    const id = makeTransform({ rotX: 0, rotY: 0, rotZ: 0, offX: 0, offY: 0, offZ: 0, scale: 1 });
    const o: [number, number, number] = [0, 0, 0];
    id(3, 4, 5, o);
    expect(o).toEqual([3, 4, 5]);
    const tf = makeTransform({ rotX: 0, rotY: 0, rotZ: 90, offX: 1, offY: 2, offZ: 3, scale: 2 });
    tf(1, 0, 0, o);
    expect(o[0]).toBeCloseTo(1, 9); // (1,0)·2 绕 Z90 → (0,2)
    expect(o[1]).toBeCloseTo(4, 9);
    expect(o[2]).toBeCloseTo(3, 9);
  });

  it("顺序 R=Rz·Ry·Rx：先绕 X 再 Y 再 Z；normalizeTransform 拒非法", () => {
    const tf = makeTransform({ rotX: 90, rotY: 0, rotZ: 0, offX: 0, offY: 0, offZ: 0, scale: 1 });
    const o: [number, number, number] = [0, 0, 0];
    tf(0, 1, 0, o); // 绕 X 90°：Y→Z
    expect(o[1]).toBeCloseTo(0, 9);
    expect(o[2]).toBeCloseTo(1, 9);
    const bad = normalizeTransform({ rotX: "x", scale: 0, offY: NaN, offZ: 4 });
    expect(bad.rotX).toBe(0);
    expect(bad.scale).toBe(1e-6); // 0 越下限 → 钳到最小正尺度
    expect(bad.offY).toBe(0);
    expect(bad.offZ).toBe(4);
  });
});

describe("朝向小工具", () => {
  it("yawQuat：0°=单位元、90°=绕 Z 半角 (0,0,√2/2,√2/2)", () => {
    expect(yawQuat(0)).toEqual([0, 0, 0, 1]);
    const [x, y, z, w] = yawQuat(90);
    expect(x).toBe(0);
    expect(y).toBe(0);
    expect(z).toBeCloseTo(Math.SQRT1_2, 9);
    expect(w).toBeCloseTo(Math.SQRT1_2, 9);
  });
  it("quatMul 单位元两侧恒等；90°∘90°=180°", () => {
    const q: [number, number, number, number] = [0, 0, 0.7071, 0.7071];
    const e = quatMul(q, [0, 0, 0, 1]);
    expect(e[2]).toBeCloseTo(q[2], 4);
    const r = quatMul(q, q);
    expect(r[3]).toBeCloseTo(0, 3);
    expect(Math.abs(r[2])).toBeCloseTo(1, 3);
  });
  it("velocityYawDeg：+X=0°、+Y=90°、重合点=null", () => {
    expect(velocityYawDeg(0, 0, 1, 0)).toBeCloseTo(0, 9);
    expect(velocityYawDeg(0, 0, 0, 1)).toBeCloseTo(90, 9);
    expect(velocityYawDeg(2, 2, 2, 2)).toBeNull();
  });
});
