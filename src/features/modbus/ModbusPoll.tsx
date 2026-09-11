import { useEffect, useRef, useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { IconPlay, IconStop, IconTrash, IconChevron } from "../../shared/icons";
import * as poll from "./pollStore";
import { FC_LABEL } from "./mb";
import { toast } from "../ai/extRuntime";

/**
 * 主站轮询表（M2-d）：Modbus 工作台的第二页。
 * 行 = 「问谁、用什么功能码、从哪读几个、多久一次、值写进哪个变量」。
 * 值进变量系统后即可直接画曲线 / 进表格 / 被脚本判断，不需要再配协议模板。
 */

const READS = [1, 2, 3, 4];

export function ModbusPoll() {
  useLocale();
  const s = useSyncExternalStore(poll.subscribe, poll.getSnapshot);

  const toggle = () => {
    if (s.running) {
      poll.stop();
      return;
    }
    const err = poll.start();
    if (err) toast(err);
  };

  return (
    <div className="mb-pane">
      <div className="mb-bar">
        <button
          type="button"
          className={`btn sm${s.running ? " warn" : " primary"}`}
          onClick={toggle}
          title={
            s.running
              ? tx("停止轮询（不再占用总线）", "Stop polling (release the bus)")
              : tx("按表轮询；总线同一时刻只有一条在途请求", "Poll the table; only one request in flight at a time")
          }
        >
          {s.running ? <IconStop /> : <IconPlay />}
          {s.running ? tx("轮询中 · 停止", "Polling · Stop") : tx("开始轮询", "Start polling")}
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => poll.addRow({})}
          title={tx("新增一行轮询项", "Add a poll row")}
        >
          <span aria-hidden="true">＋</span>
          {tx("新增", "Add")}
        </button>
        <button type="button" className="btn sm" onClick={poll.addDemoRow} title={tx("插入一条示例：读 1 号从站 40001 起 2 个寄存器", "Insert an example row")}>
          {tx("示例", "Example")}
        </button>
        <label className="mb-f" title={tx("帧格式（不是接口！）：串口侧走 RTU；直连 PLC/网关的 502 端口才用 TCP", "Frame format (not the link!): RTU over serial, TCP only when talking MBAP on port 502")}>
          {tx("帧格式", "Frames")}
          <select
            className="input mb-fault"
            value={s.transport}
            disabled={s.running}
            onChange={(e) => poll.setTransport(e.target.value as "rtu" | "tcp")}
          >
            <option value="rtu">Modbus RTU</option>
            <option value="tcp">Modbus TCP</option>
          </select>
        </label>
        <span className="mb-grow" />
        <span className="mb-counters" onClick={poll.resetStats} title={tx("已发 / 超时 / 异常 —— 点击清零", "Sent / timeouts / errors — click to reset")}>
          {tx("超时", "T/O")} <b className={s.timeouts ? "bad" : ""}>{s.timeouts}</b>
          <i />
          {tx("异常", "Err")} <b className={s.errs ? "bad" : ""}>{s.errs}</b>
        </span>
      </div>

      <div className="mb-pollwrap">
        <table className="mb-poll">
          <thead>
            <tr>
              <th aria-label={tx("启用", "On")} />
              <th>{tx("从站", "Slave")}</th>
              <th>{tx("功能码", "FC")}</th>
              <th>{tx("起始", "Start")}</th>
              <th>{tx("数量", "Qty")}</th>
              <th>{tx("周期 ms", "Period")}</th>
              <th>{tx("元素", "Elem")}</th>
              <th>{tx("倍率", "Scale")}</th>
              <th>{tx("变量名", "Variable")}</th>
              <th>{tx("最新值", "Value")}</th>
              <th>{tx("趋势", "Trend")}</th>
              <th>{tx("延迟", "RTT")}</th>
              <th>{tx("成功/超时", "OK/T-O")}</th>
              <th aria-label={tx("删除", "Delete")} />
            </tr>
          </thead>
          <tbody>
            {s.rows.length === 0 && (
              <tr>
                <td colSpan={14} className="mb-empty">
                  {tx(
                    "还没有轮询项。点「示例」插一条，或自己填：从站 1、功能码 03、起始 0、数量 2、周期 500ms —— 读回来的两个寄存器会成为两个变量，直接就能画曲线。",
                    "No rows yet. Click Example, or fill one in: slave 1, FC 03, start 0, qty 2, period 500 ms — the registers come back as variables you can plot.",
                  )}
                </td>
              </tr>
            )}
            {s.rows.map((r) => (
              <tr key={r.id} className={r.err + r.timeout > 0 ? "bad-row" : ""}>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => poll.updateRow(r.id, { enabled: e.target.checked })}
                    aria-label={tx("启用该轮询项", "Enable this row")}
                  />
                </td>
                <NumCell value={r.slave} min={0} max={247} onCommit={(v) => poll.updateRow(r.id, { slave: v })} />
                <td>
                  <select className="input mb-cell" value={r.fn} onChange={(e) => poll.updateRow(r.id, { fn: Number(e.target.value) })}>
                    {READS.map((f) => (
                      <option key={f} value={f}>
                        {FC_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </td>
                <NumCell value={r.addr} min={0} max={65535} onCommit={(v) => poll.updateRow(r.id, { addr: v })} title={tx(`手册编号 ${poll.hintFor(r.fn, r.addr)}`, `Manual address ${poll.hintFor(r.fn, r.addr)}`)} />
                <NumCell value={r.qty} min={1} max={r.fn === 1 || r.fn === 2 ? 2000 : 125} onCommit={(v) => poll.updateRow(r.id, { qty: v })} />
                <NumCell value={r.periodMs} min={20} max={60000} onCommit={(v) => poll.updateRow(r.id, { periodMs: v })} />
                <NumCell value={r.elem} min={0} max={r.qty - 1} onCommit={(v) => poll.updateRow(r.id, { elem: v })} title={tx("响应里取第几个元素写进这个变量（0 起）", "Which element of the response this variable takes (0-based)")} />
                <NumCell value={r.scale} min={-1e6} max={1e6} float onCommit={(v) => poll.updateRow(r.id, { scale: v })} title={tx("变量值 = 原始值 × 倍率", "Variable = raw × scale")} />
                <td>
                  <input className="input mb-cell mb-var" value={r.varName} onChange={(e) => poll.updateRow(r.id, { varName: e.target.value })} title={tx("曲线/表格/脚本按这个名字引用", "Referenced by this name in plots, tables and scripts")} />
                </td>
                <td className="mb-val mono">{r.last === null ? "–" : String(Math.round(r.last * 1000) / 1000)}</td>
                <td>
                  <Sparkline hist={r.hist} />
                </td>
                <td className="mb-val">{r.latencyMs === null ? "–" : `${r.latencyMs}ms`}</td>
                <td className="mb-val">
                  <b className="ok">{r.ok}</b> / <b className={r.timeout ? "bad" : ""}>{r.timeout}</b>
                </td>
                <td className="mb-ops">
                  <button type="button" className="btn sm icon" onClick={() => poll.moveRow(r.id, -1)} disabled={s.running} aria-label={tx("上移", "Move up")}>
                    <IconChevron dir="down" />
                  </button>
                  <button type="button" className="btn sm icon" onClick={() => poll.removeRow(r.id)} disabled={s.running} aria-label={tx("删除该行", "Delete row")}>
                    <IconTrash />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mb-note">
        {s.lastError
          ? `${tx("最近一次问题", "Last issue")}：${s.lastError}`
          : tx(
              "半双工保护：请求发出后必须等到应答或超时才发下一条；模拟从站运行时本页会被拒绝启动（否则是自己问自己）。",
              "Half-duplex: the next request waits for the reply or a timeout; polling refuses to start while the virtual slave runs.",
            )}
      </div>
    </div>
  );
}

function NumCell({
  value,
  min,
  max,
  float,
  title,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  float?: boolean;
  title?: string;
  onCommit: (v: number) => void;
}) {
  return (
    <td>
      <input
        className="input mb-cell mb-numc"
        type="number"
        min={min}
        max={max}
        step={float ? 0.001 : 1}
        value={value}
        title={title}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          onCommit(Math.min(max, Math.max(min, v)));
        }}
      />
    </td>
  );
}

/**
 * 行内趋势 sparkline（纯 canvas，零依赖零订阅）：
 * hist 引用变化才重绘（pollStore 成功读数时给新数组），超时/异常不重绘。
 * 颜色走 CSS var：canvas 不认 var()，从 computedStyle 读。
 */
function Sparkline({ hist }: { hist: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 92;
    const H = 22;
    if (cv.width !== Math.round(W * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (hist.length < 2) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of hist) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    const color = getComputedStyle(cv).color || "#4a7dff";
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = 1.5 + (i / (hist.length - 1)) * (W - 3);
      const y = H - 3 - ((hist[i] - lo) / span) * (H - 6);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    // 尾点（当前值位置）
    const ly = H - 3 - ((hist[hist.length - 1] - lo) / span) * (H - 6);
    ctx.fillStyle = color;
    ctx.fillRect(W - 3, ly - 1.5, 3, 3);
  }, [hist]);
  return <canvas ref={ref} className="mb-spark" aria-hidden="true" />;
}
