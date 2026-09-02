import { getSnapshot as getFrames } from "../table/framesStore";
import { getSnapshot as getTele } from "../protocol/telemetryStore";
import { getSnapshot as getSerial } from "../serial/serialStore";

export interface Anomaly {
  key: string;
  title: string;
  detail: string;
}

const STALL_MS = 10000;
const BAD_RATE = 0.05;
const JUMP_RATIO = 0.6;
const MAX_ANOMALIES = 6;

export function detectAnomalies(): Anomaly[] {
  const out: Anomaly[] = [];
  const tele = getTele();
  const denom = tele.stats.total + tele.stats.errors;
  if (denom > 50 && tele.stats.errors / denom > BAD_RATE) {
    const rate = ((tele.stats.errors / denom) * 100).toFixed(1);
    out.push({
      key: "badframe",
      title: `坏帧率偏高（${rate}%）`,
      detail: `累计总帧 ${tele.stats.total}，错误 ${tele.stats.errors}。多为波特率不匹配、线噪干扰或帧头误识别，可先降低波特率验证，再检查 GND 与屏蔽。`,
    });
  }

  const serial = getSerial();
  const rows = getFrames().rows;
  if (serial.status === "connected" && rows.length > 0) {
    const gap = Date.now() - rows[rows.length - 1].tsMs;
    if (gap > STALL_MS) {
      out.push({
        key: "stall",
        title: `连接中但 ${(gap / 1000).toFixed(0)} 秒无新帧`,
        detail: `端口 ${serial.iface === "serial" ? serial.config.port : serial.portName ?? ""} 处于连接状态，但最近一帧已距今 ${(gap / 1000).toFixed(0)} 秒。设备可能停发、触发条件未满足，或对端未按启用模板的格式发送。`,
      });
    }
  }

  if (rows.length > 8) {
    const stride = Math.max(1, Math.floor(rows.length / 400));
    const lastVal = new Map<string, number>();
    const span = new Map<string, { min: number; max: number }>();
    const jumped = new Map<string, { from: number; to: number; name: string; tpl: string }>();
    for (let i = 0; i < rows.length; i += stride) {
      const r = rows[i];
      if (!r.valid) continue;
      for (const f of r.fields) {
        const k = `${r.tplId}/${f.id}`;
        const v = f.value;
        if (!Number.isFinite(v)) continue;
        const s = span.get(k);
        if (s) {
          if (v < s.min) s.min = v;
          if (v > s.max) s.max = v;
        } else {
          span.set(k, { min: v, max: v });
        }
        const prev = lastVal.get(k);
        if (prev !== undefined && !jumped.has(k)) {
          const rg = span.get(k)!;
          const w = rg.max - rg.min;
          if (w > 0 && Math.abs(v - prev) > JUMP_RATIO * w) {
            jumped.set(k, { from: prev, to: v, name: f.name, tpl: r.tplName });
          }
        }
        lastVal.set(k, v);
      }
    }
    for (const j of jumped.values()) {
      out.push({
        key: `jump-${j.tpl}-${j.name}`,
        title: `字段「${j.name}」疑似突变`,
        detail: `模板「${j.tpl}」的 ${j.name} 出现相邻采样从 ${fmt(j.from)} 到 ${fmt(j.to)} 的跳变。若为姿态角请检查是否跨 ±180° 卷绕；若为控制量请确认是否指令突切或丢帧后跳值。`,
      });
    }
  }
  return out.slice(0, MAX_ANOMALIES);
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

export function anomaliesToText(ans: Anomaly[]): string {
  return ans.map((a) => `- ${a.title}：${a.detail}`).join("\n");
}
