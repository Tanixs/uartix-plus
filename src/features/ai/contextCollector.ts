import { getSnapshot as getSerial } from "../serial/serialStore";
import { getSnapshot as getProto } from "../protocol/templateStore";
import { getSnapshot as getFrames } from "../table/framesStore";
import { getSnapshot as getTelemetry } from "../protocol/telemetryStore";
import { getSnapshot as getPlot, fullAligned } from "../plot/plotStore";

export interface ContextSelection {
  conn: boolean;
  protocol: boolean;
  samples: boolean;
  hex: boolean;
}

export const DEFAULT_CONTEXT: ContextSelection = {
  conn: false,
  protocol: true,
  samples: false,
  hex: true,
};

export interface ContextBlock {
  key: keyof ContextSelection;
  title: string;
  text: string;
}

const SAMPLE_N = 12;

export function summaryTemplates(): string {
  const proto = getProto();
  const enabled = proto.rules.templates.filter((t) => t.enabled);
  if (enabled.length === 0) return "（当前无启用的协议模板）";
  return enabled
    .map((t) => {
      const b = t.boundary;
      const hex = (arr: number[]) => arr.map((x) => "0x" + x.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      const bound =
        b.mode === "fixedLength"
          ? `固定长度 ${b.fixedLength}B，帧头 [${hex(b.headerBytes)}]`
          : b.mode === "lengthField"
            ? `帧头 [${hex(b.headerBytes)}]，长度字段@偏移${b.lengthOffset} ${b.lengthSize}B ${b.lengthEndian === "big" ? "大端" : "小端"}（adjust=${b.lengthAdjust}）`
            : `帧尾 [${hex(b.footerBytes ?? [])}]`;
      const ck = t.checksum
        ? `${t.checksum.algo}（覆盖 ${t.checksum.coverageStart}~${t.checksum.coverageEnd}，${t.checksum.endian === "big" ? "大端" : "小端"}）`
        : "无";
      const fs = t.fields
        .map(
          (f) =>
            `${f.name}@${f.offset}:${f.type}${f.endian === "big" ? " BE" : ""}${f.scale ? "×" + f.scale : ""}${f.unit ? "(" + f.unit + ")" : ""}`,
        )
        .join("，");
      return `【${t.name}】${bound}；校验：${ck}；字段：${fs || "无"}`;
    })
    .join("\n");
}

export function collectContext(sel: ContextSelection): ContextBlock[] {
  const blocks: ContextBlock[] = [];
  if (sel.conn) {
    const s = getSerial();
    const tele = getTelemetry();
    const iface = s.iface === "serial" ? "串口" : s.iface === "udp" ? "UDP" : s.iface === "tcp-client" ? "TCP 客户端" : "TCP 服务端";
    const cfg =
      s.iface === "serial"
        ? `${s.config.port} @ ${s.config.baud} ${s.config.dataBits}${s.config.parity[0].toUpperCase()}${s.config.stopBits}`
        : `远端 ${s.net.remoteHost}:${s.net.remotePort} / 本地 ${s.net.localHost}:${s.net.localPort}`;
    blocks.push({
      key: "conn",
      title: "连接配置",
      text: `接口：${iface}\n配置：${cfg}\n状态：${s.status}\nRX：${s.rxTotal} B（${s.bps} B/s）\nTX：${s.txTotal} B\n解析统计：总帧 ${tele.stats.total}，错误 ${tele.stats.errors}`,
    });
  }
  if (sel.protocol) {
    blocks.push({ key: "protocol", title: "协议模板摘要", text: summaryTemplates() });
  }
  if (sel.samples) {
    const rows = getFrames().rows.slice(-SAMPLE_N);
    if (rows.length === 0) {
      blocks.push({ key: "samples", title: `最近 ${SAMPLE_N} 帧样本`, text: "（暂无解析数据）" });
    } else {
      const text = rows
        .map((r) => {
          const fs = r.fields.map((f) => `${f.name}=${f.text ?? f.value}`).join(", ");
          return `[${r.tplName}${r.valid ? "" : " 坏帧"}] ${fs || `len=${r.len}`}`;
        })
        .join("\n");
      blocks.push({ key: "samples", title: `最近 ${rows.length} 帧样本`, text });
    }
  }
  if (sel.hex) {
    const h = getProto().hexSelection;
    if (h && h.bytes.length > 0) {
      const hex = h.bytes
        .slice(0, 256)
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join(" ");
      blocks.push({
        key: "hex",
        title: `Hex 选区（偏移 ${h.start}，${h.bytes.length} B）`,
        text: h.bytes.length > 256 ? `${hex} …（共 ${h.bytes.length} B）` : hex,
      });
    }
  }
  return blocks;
}

export function contextToText(blocks: ContextBlock[]): string {
  if (blocks.length === 0) return "";
  return `\n\n---\n[以下为用户授权附加的软件内上下文]\n${blocks
    .map((b) => `<<${b.title}>>\n${b.text}`)
    .join("\n")}`;
}

export function curveStatsText(): string {
  const plot = getPlot();
  const full = fullAligned();
  const n = full.x.length;
  if (n === 0) return "（2D 曲线暂无数据点）";
  const isTime = plot.settings.xSource === "time";
  const xUnit = isTime ? "s" : "index";
  const lines: string[] = [
    `数据点 ${n}，X 范围 ${fmtN(full.x[0])}~${fmtN(full.x[n - 1])} ${xUnit}`,
  ];
  const stride = Math.max(1, Math.floor(n / 800));
  plot.channels.forEach((ch, ci) => {
    if (!ch.visible) return;
    const col = full.cols[ci];
    let cnt = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let sx = 0;
    let sxx = 0;
    let sxy = 0;
    let sy = 0;
    let crossings = 0;
    let prevSign = 0;
    let firstX = 0;
    let lastX = 0;
    let lastY = 0;
    for (let i = 0; i < n; i += stride) {
      const y = col[i];
      if (y === null || !Number.isFinite(y)) continue;
      const x = full.x[i];
      if (cnt === 0) {
        firstX = x;
        min = y;
        max = y;
      }
      lastX = x;
      lastY = y;
      if (y < min) min = y;
      if (y > max) max = y;
      sum += y;
      sx += x;
      sxx += x * x;
      sxy += x * y;
      sy += y;
      cnt++;
      const sign = y > sum / cnt ? 1 : y < sum / cnt ? -1 : 0;
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++;
      if (sign !== 0) prevSign = sign;
    }
    if (cnt === 0) return;
    const mean = sum / cnt;
    const denom = cnt * sxx - sx * sx;
    const slope =
      Math.abs(denom) > 1e-12 && cnt > 2 ? (cnt * sxy - sx * sy) / denom : 0;
    const dur = Math.abs(lastX - firstX);
    const period =
      crossings >= 4 && dur > 0 ? (2 * dur) / crossings : null;
    const range = max - min;
    const noise =
      range > 0 ? `峰峰值 ${fmtN(range)}` : "近似恒值";
    lines.push(
      `通道「${ch.name}」：点数 ${cnt}，均值 ${fmtN(mean)}，范围 [${fmtN(min)}, ${fmtN(max)}]，${noise}，趋势斜率 ${slope >= 0 ? "+" : ""}${fmtN(slope)}/${xUnit}${period ? `，疑似周期 ${fmtN(period)} ${xUnit}` : ""}，末端值 ${fmtN(lastY)}`,
    );
  });
  if (lines.length === 1) return "（2D 曲线无可见通道）";
  return lines.join("\n");
}

function fmtN(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 10000 || a < 0.001)) return v.toExponential(2);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3);
  return v.toPrecision(3);
}
