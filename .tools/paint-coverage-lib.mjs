/**
 * P154-A · 绘画级覆盖率的判据本体。抽成纯函数是因为它有**两个消费方**：
 * `paint-coverage.mjs --check`（活体跑量后比对）与 `check-paint-coverage.mjs`（第 17 道门，
 * 静态核账本形状 + 夹具自证）。判据只能有一份——两本尺迟早各说各话。
 */

export const FLOOR_KEYS = ["deltaPct", "handlePct", "propDeltaPct"];

/**
 * 比对一次实跑 agg 与账本地板。返回违规串数组（空 = 过）。
 * 三张百分比是**地板**（只升不降——覆盖率与问题数那本账方向相反）；
 * elems / faces 是分母自证：分母缩水先查"面是不是没开出来"，不许拿小分母去及格线。
 */
export function judgeAgg(agg, led, label = "实测") {
  const bad = [];
  if (!led || typeof led !== "object" || !led.floor) return [`${label}: 账本没有 floor 段`];
  for (const k of FLOOR_KEYS) {
    const v = agg[k];
    if (typeof v !== "number" || Number.isNaN(v)) bad.push(`${label}: ${k} 不是数（采样没跑出来？先修采样）`);
    else if (v < led.floor[k]) bad.push(`${label}: ${k} ${v}% < 地板 ${led.floor[k]}%`);
  }
  if (agg.elems < led.floor.elems) {
    bad.push(`${label}: 分母画脸元素 ${agg.elems} < 地板 ${led.floor.elems}（面开不出来或结构变了——先查分母，再谈覆盖率）`);
  }
  if (agg.faces.length < led.floor.faces) {
    bad.push(`${label}: 记账面 ${agg.faces.length} < 地板 ${led.floor.faces}`);
  }
  return bad;
}

/** 账本形状判据（第 17 道门用）。返回违规串数组。 */
export function judgeLedger(led) {
  const bad = [];
  if (!led || typeof led !== "object") return ["账本不是对象"];
  if (typeof led.judge !== "string" || led.judge.length < 20) bad.push("judge 字段缺失或太短（地板的来历必须写在账本里）");
  if (led.cand !== "fluent" || led.base !== "light") bad.push(`账本对必须是 fluent/light（实测 ${led.cand}/${led.base}）——换对照要重新采数，不许沿用旧地板`);
  if (led.version !== 1) bad.push("version 必须 1（升版本 = 换判据，要连门一起改）");
  for (const k of FLOOR_KEYS) {
    const v = led.floor?.[k];
    if (typeof v !== "number" || !(v >= 0 && v <= 100)) bad.push(`floor.${k} 缺失或不在 0..100`);
  }
  if (!Number.isInteger(led.floor?.elems) || led.floor.elems <= 0) bad.push("floor.elems 缺失或 ≤0（分母自证不能是 0）");
  if (!Number.isInteger(led.floor?.faces) || led.floor.faces <= 0) bad.push("floor.faces 缺失或 ≤0");
  for (const k of [...FLOOR_KEYS, "elems", "faces"]) {
    const m = led.measured?.[k];
    if (typeof m !== "number") bad.push(`measured.${k} 缺失（采数那次的实测值必须留档，地板才可反驳）`);
    else if (m < led.floor[k]) bad.push(`floor.${k}(${led.floor[k]}) 高于留档实测 ${m} —— 地板不许拍在实测之上`);
  }
  return bad;
}
