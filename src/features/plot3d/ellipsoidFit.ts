/**
 * P71 椭球校准拟合（纯函数零依赖）。
 *
 * 磁力计/加计原始三轴点云 → 最小二乘锥面拟合 → 九参数输出：
 * - 硬磁偏置 offset（3）+ 软磁对称校正矩阵 W 的 6 个独立量 = 9 自由度
 *   （W = V·diag(gᵢ)·Vᵀ 对称；固件侧 corrected = W·(raw - offset)，|corrected| ≈ 平均原始场强）
 *
 * 数值红线：原始 ADC 值动辄数千，直接解 9×9 严重病态——
 * 必须先按质心平移 + RMS 半径缩放归一化，解完再反变换。
 */

export interface CalibPts {
  x: number[];
  y: number[];
  z: number[];
}

export interface FitOk {
  ok: true;
  /** 硬磁偏置（原始数据单位） */
  offset: [number, number, number];
  /** 各主轴增益（均值≈1） */
  gains: [number, number, number];
  /** 对称软磁校正矩阵（3×3，行访问 matrix[row][col]） */
  matrix: number[][];
  /** 半轴长（原始数据单位，主轴方向） */
  axes: [number, number, number];
  /** 主方向阵（列 = 各主轴单位向量，正交） */
  rot: number[][];
  /** 半径变异系数 std/mean */
  cv: number;
  /** 归一化半径残差 RMS（|x'|-1 的均方根） */
  rms: number;
  /** 校正后幅值均值 ā = mean‖W·(x−offset)‖（原始单位；预览基准/参考球半径） */
  meanR: number;
  /** 拟合使用的点数 */
  n: number;
}

/** 拟合失败错误码（UI 按码做 i18n；reason 保留中文兜底/日志用） */
export type FitErrCode =
  | "few"
  | "octants"
  | "coincident"
  | "singular"
  | "solveFail"
  | "kNonPos"
  | "hyperboloid"
  | "cigar"
  | "oneSide";

export type FitResult = FitOk | { ok: false; reason: string; code: FitErrCode; p?: (number | string)[] };

/** 模块级最低采样数（9 参数至少几十点才可解；UI 门控另设 500） */
export const FIT_MIN_POINTS = 60;
/** 半轴离散度上限：最大半轴/平均 > 该值视为 cigar 退化（覆盖不足） */
const AXES_RATIO_MAX = 5;

type Mat3 = number[][]; // m[row][col]

/** 3×3 对称 Jacobi 特征分解（返回升序特征值 + 对应正交特征向量列） */
function jacobiEig3(m: Mat3): { vals: [number, number, number]; vecs: Mat3 } {
  const a: Mat3 = [
    [m[0][0], m[0][1], m[0][2]],
    [m[1][0], m[1][1], m[1][2]],
    [m[2][0], m[2][1], m[2][2]],
  ];
  const v: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    // 非对角元素平方和
    const off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
    if (off < 1e-30) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      // 旋转更新 A = JᵀAJ
      for (let i = 0; i < 3; i++) {
        const aip = a[i][p];
        const aiq = a[i][q];
        a[i][p] = c * aip - s * aiq;
        a[i][q] = s * aip + c * aiq;
      }
      for (let i = 0; i < 3; i++) {
        const api = a[p][i];
        const aqi = a[q][i];
        a[p][i] = c * api - s * aqi;
        a[q][i] = s * api + c * aqi;
      }
      for (let i = 0; i < 3; i++) {
        const vip = v[i][p];
        const viq = v[i][q];
        v[i][p] = c * vip - s * viq;
        v[i][q] = s * vip + c * viq;
      }
    }
  }
  const vals: [number, number, number] = [a[0][0], a[1][1], a[2][2]];
  // 升序排序（保持 v 列同步）
  const order = [0, 1, 2].sort((i, j) => vals[i] - vals[j]);
  return {
    vals: [vals[order[0]], vals[order[1]], vals[order[2]]],
    vecs: [0, 1, 2].map((r) => [v[r][order[0]], v[r][order[1]], v[r][order[2]]]),
  };
}

/** 9×9 正规方程高斯消元（部分主元）；奇异返回 null */
function solve9(A: Float64Array, b: Float64Array): Float64Array | null {
  const n = 9;
  const M = A.slice();
  const y = b.slice();
  let scaleMax = 0;
  for (let i = 0; i < n * n; i++) scaleMax = Math.max(scaleMax, Math.abs(M[i]));
  if (scaleMax <= 0) return null;
  for (let col = 0; col < n; col++) {
    // 部分主元
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r * n + col]) > Math.abs(M[piv * n + col])) piv = r;
    }
    if (Math.abs(M[piv * n + col]) < 1e-12 * scaleMax) return null;
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = M[col * n + c];
        M[col * n + c] = M[piv * n + c];
        M[piv * n + c] = t;
      }
      const t = y[col];
      y[col] = y[piv];
      y[piv] = t;
    }
    const d = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r * n + c] -= f * M[col * n + c];
      y[r] -= f * y[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r];
    for (let c = r + 1; c < n; c++) s -= M[r * n + c] * x[c];
    x[r] = s / M[r * n + r];
  }
  return x;
}

/** 八象限覆盖计数（以点云质心为原点；0-8） */
export function octantCoverage(pts: CalibPts): number {
  const n = Math.min(pts.x.length, pts.y.length, pts.z.length);
  if (n === 0) return 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < n; i++) {
    mx += pts.x[i];
    my += pts.y[i];
    mz += pts.z[i];
  }
  mx /= n;
  my /= n;
  mz /= n;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const sx = pts.x[i] >= mx ? 1 : 0;
    const sy = pts.y[i] >= my ? 1 : 0;
    const sz = pts.z[i] >= mz ? 1 : 0;
    seen.add((sx << 2) | (sy << 1) | sz);
  }
  return seen.size;
}

/** CV 等级 */
export function grade(cv: number): "优" | "良" | "差" {
  if (cv < 0.03) return "优";
  if (cv < 0.08) return "良";
  return "差";
}

/**
 * 最小二乘椭球拟合。
 * 返回 ok:false 时 reason 为用户可读中文（直接展示）。
 */
export function fitEllipsoid(pts: CalibPts): FitResult {
  const n = Math.min(pts.x.length, pts.y.length, pts.z.length);
  if (n < FIT_MIN_POINTS) {
    return { ok: false, reason: `采样点数不足（${n}/${FIT_MIN_POINTS}），请继续翻滚传感器采样`, code: "few", p: [n, FIT_MIN_POINTS] };
  }
  // 覆盖门（确定性拒绝半球/局部采样：数学上仍可解但系数严重有偏，不如拒绝）
  if (octantCoverage(pts) < 6) {
    return { ok: false, reason: "象限覆盖不足：点云集中在部分空间区域，请绕各轴翻滚一圈（画 8 字）覆盖全部象限后重试", code: "octants" };
  }

  // ---------- 归一化：质心平移 + RMS 半径缩放 ----------
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < n; i++) {
    mx += pts.x[i];
    my += pts.y[i];
    mz += pts.z[i];
  }
  mx /= n;
  my /= n;
  mz /= n;
  let r2sum = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts.x[i] - mx;
    const dy = pts.y[i] - my;
    const dz = pts.z[i] - mz;
    r2sum += dx * dx + dy * dy + dz * dz;
  }
  const s = Math.sqrt(r2sum / n);
  if (!(s > 0) || !Number.isFinite(s)) {
    return { ok: false, reason: "采样点重合，无法拟合（请检查数据是否在变化）", code: "coincident" };
  }

  // ---------- 正规方程 DᵀD·v = Dᵀ1（q 空间，q=(p-μ)/s） ----------
  const A = new Float64Array(81);
  const rhs = new Float64Array(9);
  // 设计矩阵行：[qx², qy², qz², 2qx·qy, 2qx·qz, 2qy·qz, 2qx, 2qy, 2qz]
  for (let i = 0; i < n; i++) {
    const qx = (pts.x[i] - mx) / s;
    const qy = (pts.y[i] - my) / s;
    const qz = (pts.z[i] - mz) / s;
    const d = [qx * qx, qy * qy, qz * qz, 2 * qx * qy, 2 * qx * qz, 2 * qy * qz, 2 * qx, 2 * qy, 2 * qz];
    for (let r = 0; r < 9; r++) {
      rhs[r] += d[r]; // 目标恒为 1 → Dᵀ1 = 各列和
      for (let c = r; c < 9; c++) A[r * 9 + c] += d[r] * d[c];
    }
  }
  for (let r = 0; r < 9; r++) for (let c = 0; c < r; c++) A[r * 9 + c] = A[c * 9 + r];

  const v = solve9(A, rhs);
  if (!v) {
    return { ok: false, reason: "采样覆盖不足：点分布近乎共面或集中在半球，请让传感器在空间各方向充分翻滚后重试", code: "singular" };
  }

  // ---------- 锥面参数还原（q 空间） ----------
  // qᵀMq + 2bᵀq = 1；中心 c = -M⁻¹b；(q-c)ᵀ(M/k)(q-c) = 1，k = 1 + cᵀMc
  const M: Mat3 = [
    [v[0], v[3], v[4]],
    [v[3], v[1], v[5]],
    [v[4], v[5], v[2]],
  ];
  const b = [v[6], v[7], v[8]];
  // 解 M·c = -b（3×3 高斯消元，M 对称）
  const c = solve3(M, [-b[0], -b[1], -b[2]]);
  if (!c) {
    return { ok: false, reason: "采样覆盖不足：请让传感器在空间各方向充分翻滚后重试", code: "solveFail" };
  }
  const Mc = matVec(M, c);
  const k = 1 + (c[0] * Mc[0] + c[1] * Mc[1] + c[2] * Mc[2]);
  if (!(k > 0)) {
    return { ok: false, reason: "采样覆盖不足：请让传感器在空间各方向充分翻滚后重试", code: "kNonPos" };
  }

  const { vals, vecs } = jacobiEig3(M);
  // 半轴（q 空间）= sqrt(k/λ)；要求全部 λ > 0（椭球而非双曲面）
  if (!(vals[0] > 0) || !(vals[1] > 0) || !(vals[2] > 0)) {
    return { ok: false, reason: "采样覆盖不足：点云分布无法构成封闭椭球，请全方位翻滚后重试", code: "hyperboloid" };
  }
  const axesQ = vals.map((l) => Math.sqrt(k / l)) as [number, number, number];
  const axesMean = (axesQ[0] + axesQ[1] + axesQ[2]) / 3;
  if (axesQ[0] / axesMean > AXES_RATIO_MAX) {
    return { ok: false, reason: "采样覆盖不足：椭球过度细长（旋转平面缺失），请绕各轴都翻滚一圈后重试", code: "cigar" };
  }
  // 主轴单侧覆盖检测（q 空间）：半球/局部采样时拟合仍可解但系数严重有偏——
  // 任一主方向上 minority < 8% 即拒绝（全向采样时每侧 ≈50%，阈值极安全）
  for (let i = 0; i < 3; i++) {
    let neg = 0;
    for (let j = 0; j < n; j++) {
      const qx = (pts.x[j] - mx) / s - c[0];
      const qy = (pts.y[j] - my) / s - c[1];
      const qz = (pts.z[j] - mz) / s - c[2];
      const u = vecs[0][i] * qx + vecs[1][i] * qy + vecs[2][i] * qz;
      if (u < 0) neg++;
    }
    if (Math.min(neg, n - neg) / n < 0.08) {
      return { ok: false, reason: "采样覆盖不足：某主轴方向只采样了单侧，请继续翻滚补齐对侧后重试", code: "oneSide" };
    }
  }

  // ---------- 反归一化（原始空间） ----------
  // 半轴（原始）= s·sqrt(k/λ)；校正 x' = W·(p-offset)，W = V·diag(gᵢ)·Vᵀ 对称，
  // gᵢ = ā/aᵢ（均值≈1），W 使 |x'| ≈ ā（平均原始场强）
  const axesOrig = axesQ.map((a) => a * s) as [number, number, number];
  const aMean = (axesOrig[0] + axesOrig[1] + axesOrig[2]) / 3;
  const gains = axesOrig.map((a) => aMean / a) as [number, number, number];
  const W: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let cix = 0; cix < 3; cix++) {
      let sum = 0;
      for (let i = 0; i < 3; i++) sum += vecs[r][i] * gains[i] * vecs[cix][i];
      W[r][cix] = sum;
    }
  }
  const offset: [number, number, number] = [mx + c[0] * s, my + c[1] * s, mz + c[2] * s];

  // ---------- 质量指标：对全体点应用校正 ----------
  let rsum = 0;
  let r2sumC = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts.x[i] - offset[0];
    const dy = pts.y[i] - offset[1];
    const dz = pts.z[i] - offset[2];
    const rx = W[0][0] * dx + W[0][1] * dy + W[0][2] * dz;
    const ry = W[1][0] * dx + W[1][1] * dy + W[1][2] * dz;
    const rz = W[2][0] * dx + W[2][1] * dy + W[2][2] * dz;
    const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
    rsum += r;
    r2sumC += r * r;
  }
  const rMean = rsum / n;
  const variance = Math.max(0, r2sumC / n - rMean * rMean);
  const cv = Math.sqrt(variance) / rMean;
  // 归一化半径残差：((r/ā)-1) 的 RMS = std(r)/ā（均值项相消）
  const rms = Math.sqrt(variance) / aMean;

  return { ok: true, offset, gains, matrix: W, axes: axesOrig, rot: vecs, cv, rms, meanR: rMean, n };
}

/** 3×3 高斯消元（部分主元）；奇异返回 null */
function solve3(M: Mat3, b: [number, number, number]): [number, number, number] | null {
  const a = [
    [M[0][0], M[0][1], M[0][2], b[0]],
    [M[1][0], M[1][1], M[1][2], b[1]],
    [M[2][0], M[2][1], M[2][2], b[2]],
  ];
  let scale = 0;
  for (const row of a) for (const e of row) scale = Math.max(scale, Math.abs(e));
  if (scale <= 0) return null;
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < 1e-12 * scale) return null;
    if (piv !== col) {
      const t = a[col];
      a[col] = a[piv];
      a[piv] = t;
    }
    for (let r = col + 1; r < 3; r++) {
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c2 = col; c2 < 4; c2++) a[r][c2] -= f * a[col][c2];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s2 = a[r][3];
    for (let c2 = r + 1; c2 < 3; c2++) s2 -= a[r][c2] * x[c2];
    x[r] = s2 / a[r][r];
  }
  return [x[0], x[1], x[2]];
}

function matVec(M: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

// ================= 加计六面校准（P73） =================

/** 单面采集统计（该面朝上静止 2s 时间窗） */
export interface Accel6Face {
  /** 三轴均值（原始单位） */
  mean: [number, number, number];
  /** 三轴标准差（原始单位） */
  std: [number, number, number];
  /** 样本数 */
  n: number;
}

export interface Accel6Ok {
  ok: true;
  /** 零偏/硬磁（原始单位） */
  offset: [number, number, number];
  /** 各轴增益（1/s）；校正 a' = (a − offset)·gain ≈ 1g */
  gains: [number, number, number];
  /** 各轴尺度 s（原始单位/g）；参考椭球半轴 = s·gRef */
  scales: [number, number, number];
  /** 三轴尺度一致性 CV = std(|s|)/mean(|s|)，>2% 提示装配/对齐问题 */
  cvScale: number;
  /** 各面校正后非主轴分量占比最大值（对齐/正交性指示，理想≈0；报告不拒绝） */
  faceDev: number;
  /** 六面数据透传 */
  faces: Accel6Face[];
  /** 按 cvScale 三档 */
  grade: "优" | "良" | "差";
}

export type Accel6ErrCode = "facesIncomplete" | "faceFew" | "zeroDiff" | "axisOrder" | "sigma";

export type Accel6Result = Accel6Ok | { ok: false; reason: string; code: Accel6ErrCode; p?: (number | string)[] };

/** 每面最少样本（2s 窗在常见采样率下远超 30） */
export const ACCEL6_MIN_SAMPLES = 30;
/** 面内抖动门：合成 σ 超过尺度均值 5% 判未静止 */
const ACCEL6_STD_MAX = 0.05;

/**
 * 经典六面法（主轴分量法）：面顺序固定 [+X, −X, +Y, −Y, +Z, −Z]（该面朝上静止）。
 * 轴 i 取面 2i/2i+1 在该轴上的均值分量：
 *   offset_i = (a⁺ + a⁻)/2；s_i = (a⁺ − a⁻)/(2·gRef)（原始单位/g）；gain_i = 1/s_i。
 * 已知限制（详设 §4.1）：假设三轴理想正交、摆放水平；倾斜/非正交误差进 faceDev 指标
 * 而不被解算吸收——不做 12 参数带倾斜 LS（P74+ 再议）。
 */
export function fitAccelSix(faces: Accel6Face[], gRef = 1): Accel6Result {
  if (faces.length !== 6) {
    return { ok: false, reason: "六面数据不完整（需要 +X/-X/+Y/-Y/+Z/-Z 六面各采一次）", code: "facesIncomplete" };
  }
  const AX = ["X", "Y", "Z"] as const;
  for (let i = 0; i < 6; i++) {
    const f = faces[i];
    if (!f || f.n < ACCEL6_MIN_SAMPLES) {
      return {
        ok: false,
        reason: `面 ${i + 1}（${i % 2 === 0 ? "+" : "−"}${AX[i >> 1]}）样本不足（${f?.n ?? 0}/${ACCEL6_MIN_SAMPLES}），请重新采集该面`,
        code: "faceFew",
        p: [i, (f?.n ?? 0), ACCEL6_MIN_SAMPLES],
      };
    }
  }
  // 主轴分量解算
  const offset: [number, number, number] = [0, 0, 0];
  const scales: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const ap = faces[2 * i].mean[i];
    const an = faces[2 * i + 1].mean[i];
    offset[i] = (ap + an) / 2;
    scales[i] = (ap - an) / (2 * gRef);
  }
  const sMean = (Math.abs(scales[0]) + Math.abs(scales[1]) + Math.abs(scales[2])) / 3;
  if (!(sMean > 0) || !Number.isFinite(sMean)) {
    return { ok: false, reason: "两面均值差≈0：请检查采集顺序（+X 与 −X 是否摆对）", code: "zeroDiff" };
  }
  // 尺度异常：符号翻转（+面均值反而更小 = 顺序错）或幅值塌陷（某轴差异过小）
  for (let i = 0; i < 3; i++) {
    if (scales[i] <= 0 || Math.abs(scales[i]) < 0.2 * sMean) {
      return {
        ok: false,
        reason: `${["X", "Y", "Z"][i]} 轴两面均值差异常（+面应大于 −面）：疑似采集顺序错或传感器异常，请核对后重采`,
        code: "axisOrder",
        p: [i],
      };
    }
  }
  // 未静止门：任一面合成 σ > 5%·s̄·gRef
  for (let i = 0; i < 6; i++) {
    const sTot = Math.hypot(faces[i].std[0], faces[i].std[1], faces[i].std[2]);
    if (sTot > ACCEL6_STD_MAX * sMean * gRef) {
      return {
        ok: false,
        reason: `面 ${i + 1}（${i % 2 === 0 ? "+" : "−"}${AX[i >> 1]}）采集抖动过大（σ 超尺度均值 5%），请放稳后重采该面`,
        code: "sigma",
        p: [i],
      };
    }
  }
  // 质量指标
  let sv = 0;
  for (let i = 0; i < 3; i++) sv += (Math.abs(scales[i]) - sMean) ** 2;
  const cvScale = Math.sqrt(sv / 3) / sMean;
  // 对齐/正交性指示：各面校正后非主轴分量占比（重力应纯沿主轴；倾斜/非正交才非零）
  const gains = scales.map((s) => 1 / s) as [number, number, number];
  let faceDev = 0;
  for (let i = 0; i < 6; i++) {
    const dom = i >> 1;
    const f = faces[i];
    let off2 = 0;
    let tot2 = 0;
    for (let a = 0; a < 3; a++) {
      const c = (f.mean[a] - offset[a]) * gains[a];
      tot2 += c * c;
      if (a !== dom) off2 += c * c;
    }
    if (tot2 > 0) faceDev = Math.max(faceDev, Math.sqrt(off2 / tot2));
  }
  return {
    ok: true,
    offset,
    gains,
    scales,
    cvScale,
    faceDev,
    faces: faces.map((f) => ({ mean: [...f.mean], std: [...f.std], n: f.n })),
    grade: grade(cvScale),
  };
}

/** 单点校正后幅值 r = ‖W·(x−offset)‖（在线预览/残差着色共用，~15 FLOP） */
export function correctedRadius(x: number, y: number, z: number, fit: FitOk): number {
  const W = fit.matrix;
  const dx = x - fit.offset[0];
  const dy = y - fit.offset[1];
  const dz = z - fit.offset[2];
  const rx = W[0][0] * dx + W[0][1] * dy + W[0][2] * dz;
  const ry = W[1][0] * dx + W[1][1] * dy + W[1][2] * dz;
  const rz = W[2][0] * dx + W[2][1] * dy + W[2][2] * dz;
  return Math.sqrt(rx * rx + ry * ry + rz * rz);
}
