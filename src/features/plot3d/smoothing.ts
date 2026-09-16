/**
 * P87b 平滑内核（纯函数，无 three/无 DOM，vitest 直接可测）。
 *
 * 契约：内核只生成**显示几何**顶点流；真实值原始列（f64 副列）永不被改写——
 * pick/测量/导出/游标截断读的都是原始点（「平滑只影响视觉不篡改数据」红线）。
 * - CR（向心 Catmull-Rom）：曲线**穿过**原始数据点；tension=0 退化为直线段、
 *   1=全曲率（0~1 与线性位置 lerp，语义直观可滑杆）。
 * - 三次样条（natural，Thomas 追赶法解三对角）：整窗一次解，曲率连续。
 * sub（每条原始段细分顶点数 2~10）与插值时间戳由调用方（scene）按批拼装。
 * 「贝塞尔圆角」与「自定义 expr 平滑」按 R3.1 决策延后（覆盖面与成本评估在详设）。
 */

export interface SmoothKernel {
  /** 往 out 追加 [from,to) 覆盖段（to = 原始点数-1 的段上界）细分顶点。
   *  out.pos/out.t 平行追加；out.val 给 undefined 由调用方线性插值。
   *  px/py/pz/t 为等长原始数组（真实值与相对秒），from/to 为原始点下标（含首顶点）。 */
  emit(
    px: ArrayLike<number>,
    py: ArrayLike<number>,
    pz: ArrayLike<number>,
    t: ArrayLike<number>,
    from: number,
    to: number,
    sub: number,
    out: { pos: number[]; t: number[] },
  ): void;
}

const clampF = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function smoothSub(v: unknown): number {
  return Math.round(clampF(typeof v === "number" && isFinite(v) ? v : 4, 2, 10));
}
export function smoothTension(v: unknown): number {
  return clampF(typeof v === "number" && isFinite(v) ? v : 0.5, 0, 1);
}

/** 向心参数化 CR 单段求值（u∈[0,1]，端点 p1→p2；p0/p3 可为 null=端段镜像外推） */
function crAt(
  p0: number, p1: number, p2: number, p3: number,
  u: number, tension: number,
): number {
  // 均匀参数化 CR（向心版需时间戳进核，细分按段索引均分足够视觉平滑）；
  // tension 通过把曲率项与线性插值 lerp 实现：0=直线、1=完整 CR
  const lin = p1 + (p2 - p1) * u;
  const u2 = u * u;
  const u3 = u2 * u;
  const cr =
    0.5 *
    (2 * p1 +
      (p2 - p0) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (3 * p1 - 3 * p2 + p3 - p0) * u3);
  return lin + (cr - lin) * tension;
}

/** Catmull-Rom：逐段 sub 细分（不含段起点——起点=上段终点，首点由调用方写入） */
export const crKernel = (tension: number): SmoothKernel => ({
  emit(px, py, pz, t, from, to, sub, out) {
    const n = px.length;
    for (let i = from; i < to && i + 1 < n; i++) {
      const i0 = Math.max(0, i - 1);
      const i3 = Math.min(n - 1, i + 2);
      for (let k = 1; k <= sub; k++) {
        const u = k / sub;
        out.pos.push(
          crAt(px[i0], px[i], px[i + 1], px[i3], u, tension),
          crAt(py[i0], py[i], py[i + 1], py[i3], u, tension),
          crAt(pz[i0], pz[i], pz[i + 1], pz[i3], u, tension),
        );
        out.t.push(t[i] + (t[i + 1] - t[i]) * u);
      }
    }
  },
});

/** 三次样条（natural）：整窗解一次二阶导（Thomas），再逐段 Hermite 求值细分。
 *  与 CR 的差异：曲率连续（无 CR 在密集转折处的轻微鼓包），成本 O(窗)。 */
export const splineKernel: SmoothKernel = {
  emit(px, py, pz, t, from, to, sub, out) {
    const n = px.length;
    if (n < 3) {
      crKernel(1).emit(px, py, pz, t, from, to, sub, out);
      return;
    }
    // natural 二阶导 M：内部点满足 h_{i-1}M_{i-1}+2(h_{i-1}+h_i)M_i+h_iM_{i+1}=6·dif
    const h = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) h[i] = Math.max(1e-9, t[i + 1] - t[i]);
    const solve = (p: ArrayLike<number>, M: Float64Array) => {
      // Thomas 追赶（严格对角占优恒稳）：M 先存 d'，回代后为最终二阶导
      const cPrime = new Float64Array(n - 1);
      M[0] = 0;
      M[n - 1] = 0;
      for (let i = 1; i < n - 1; i++) {
        const dif = (p[i + 1] - p[i]) / h[i] - (p[i] - p[i - 1]) / h[i - 1];
        const a = h[i - 1];
        const b = 2 * (h[i - 1] + h[i]);
        const c = h[i];
        const m = b - (i > 1 ? a * cPrime[i - 1] : 0);
        if (i < n - 2) cPrime[i] = c / m;
        M[i] = (6 * dif - (i > 1 ? a * M[i - 1] : 0)) / m;
      }
      for (let i = n - 2; i >= 1; i--) M[i] = M[i] - cPrime[i] * M[i + 1];
    };
    const Mx = new Float64Array(n);
    const My = new Float64Array(n);
    const Mz = new Float64Array(n);
    solve(px, Mx);
    solve(py, My);
    solve(pz, Mz);
    const seg = (
      p: ArrayLike<number>,
      M: Float64Array,
      i: number,
      hi: number,
      u: number,
    ) => {
      const A = 1 - u;
      const B = u;
      return (
        A * p[i] +
        B * p[i + 1] +
        ((A * A * A - A) * M[i] + (B * B * B - B) * M[i + 1]) * (hi * hi) / 6
      );
    };
    for (let i = from; i < to && i + 1 < n; i++) {
      const hi = h[i];
      for (let k = 1; k <= sub; k++) {
        const u = k / sub;
        out.pos.push(seg(px, Mx, i, hi, u), seg(py, My, i, hi, u), seg(pz, Mz, i, hi, u));
        out.t.push(t[i] + hi * u);
      }
    }
  },
};

export type SmoothKind = "none" | "movingAvg" | "catmullRom" | "spline";

export function kernelFor(kind: SmoothKind, tension: number): SmoothKernel | null {
  if (kind === "catmullRom") return crKernel(tension);
  if (kind === "spline") return splineKernel;
  return null; // none / movingAvg = 1:1 几何（scene 内联），无细分核
}

/** 滑动平均（1:1，收缩窗边界）：scene 尾窗几何与指标共用；in 为交织 xyz（步长 3） */
export function movingAvgInPlace(
  srcReal: Float64Array,
  dst: Float32Array,
  count: number,
  from: number,
  half: number,
  map: (v: number, axis: 0 | 1 | 2) => number,
): void {
  for (let i = from; i < count; i++) {
    const a0 = Math.max(0, i - half);
    const a1 = Math.min(count - 1, i + half);
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const c = a1 - a0 + 1;
    for (let k = a0; k <= a1; k++) {
      sx += srcReal[k * 3];
      sy += srcReal[k * 3 + 1];
      sz += srcReal[k * 3 + 2];
    }
    dst[i * 3] = map(sx / c, 0);
    dst[i * 3 + 1] = map(sy / c, 1);
    dst[i * 3 + 2] = map(sz / c, 2);
  }
}

/** 组坐标变换（P87b）：p' = R(z·y·x 欧拉角°)·(p·scale) + off —— 泵内单点真相，
 *  轨迹/导出/配对统计/朝向全部经它，保证「显示=导出」同源。 */
export interface GroupTransform {
  rotX: number; // 度
  rotY: number;
  rotZ: number;
  offX: number;
  offY: number;
  offZ: number;
  scale: number;
}

export const IDENTITY_TRANSFORM: GroupTransform = {
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  offX: 0,
  offY: 0,
  offZ: 0,
  scale: 1,
};

export function normalizeTransform(q: unknown): GroupTransform {
  const p = (typeof q === "object" && q !== null ? q : {}) as Partial<GroupTransform>;
  const num = (v: unknown, fb: number) =>
    typeof v === "number" && isFinite(v) ? v : fb;
  return {
    rotX: num(p.rotX, 0) % 360,
    rotY: num(p.rotY, 0) % 360,
    rotZ: num(p.rotZ, 0) % 360,
    offX: num(p.offX, 0),
    offY: num(p.offY, 0),
    offZ: num(p.offZ, 0),
    scale: clampF(num(p.scale, 1), 1e-6, 1e9),
  };
}

/** 变换器（每 tick 构造一次，闭包复用三角函数） */
export function makeTransform(tf: GroupTransform): (x: number, y: number, z: number, out: [number, number, number]) => void {
  const isId =
    tf.rotX === 0 && tf.rotY === 0 && tf.rotZ === 0 && tf.offX === 0 && tf.offY === 0 && tf.offZ === 0 && tf.scale === 1;
  const s = tf.scale;
  const rx = (tf.rotX * Math.PI) / 180;
  const ry = (tf.rotY * Math.PI) / 180;
  const rz = (tf.rotZ * Math.PI) / 180;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  if (isId) return (x, y, z, out) => void (out[0] = x, out[1] = y, out[2] = z);
  // R = Rz·Ry·Rx（Z-then-Y-then-X 旋转的逆序复合：点先绕 X，再 Y，再 Z）
  const m00 = cz * cy;
  const m01 = cz * sy * sx - sz * cx;
  const m02 = cz * sy * cx + sz * sx;
  const m10 = sz * cy;
  const m11 = sz * sy * sx + cz * cx;
  const m12 = sz * sy * cx - cz * sx;
  const m20 = -sy;
  const m21 = cy * sx;
  const m22 = cy * cx;
  return (x, y, z, out) => {
    const ax = x * s;
    const ay = y * s;
    const az = z * s;
    out[0] = m00 * ax + m01 * ay + m02 * az + tf.offX;
    out[1] = m10 * ax + m11 * ay + m12 * az + tf.offY;
    out[2] = m20 * ax + m21 * ay + m22 * az + tf.offZ;
  };
}

/** 欧拉角（度，Z·Y·X 序）+ 偏航符号 → three 四元数输入 [x,y,z,w]；
 *  heading 源在 scene 合成：q = qZ(heading·sign) ∘ qPitchRoll（调用方编排，
 *  本函数只给「绕 Z 的 yaw 度」→四元数分量，纯函数好测）。 */
export function yawQuat(deg: number): [number, number, number, number] {
  const r = (deg * Math.PI) / 360; // 半角
  return [0, 0, Math.sin(r), Math.cos(r)];
}

/** 四元数乘法（three 布局 [x,y,z,w]，a∘b 语义：先应用 b 再应用 a —— 与 three multiplyQuaternions(a,b) 一致） */
export function quatMul(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 三点差分方向角（度）：(x0,y0)→(x1,y1) 相对 +X；null=退化（重合点） */
export function velocityYawDeg(x0: number, y0: number, x1: number, y1: number): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}
