import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import * as serialStore from "../features/serial/serialStore";
import * as telemetryStore from "../features/protocol/telemetryStore";
import * as templateStore from "../features/protocol/templateStore";
import * as vdevStore from "../features/vdev/vdevStore";
import { useSettings } from "../features/settings/settingsStore";
import { t, tx, useLocale } from "../i18n/strings";

/**
 * P104-B5 信息栏（28px）。
 *
 * 原来这条 24px 的文本栏里，`RX 0 B · TX 0 B · 0 B/s · 帧 0/错 0` 是**一整块不可点的字符串**——
 * 它是全应用唯一一处"数据正在怎样"的常驻读数，却什么也做不了：想知道为什么错了，
 * 得自己想起"错误在哨兵里"、再去面板菜单里翻。这里把每个计数变成通往它主人的入口。
 *
 * sparkline 是这条栏新增的唯一一份**状态**：24 格环形缓冲、1Hz 采样 `bps`。
 * 它只读视图层的数，不碰收发/解析/录放任何一行；也不落盘、不进录制文件。
 */

const HIST = 24;

/** 24 格吞吐历史。放在组件外、模块级：重挂载不该把曲线抹平，也不该每个实例各存一份。 */
const hist: number[] = [];

function pushSample(v: number) {
  hist.push(v);
  if (hist.length > HIST) hist.shift();
}

function Sparkline() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      pushSample(serialStore.getSnapshot().bps);
      setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);
  if (hist.length < 2) return null;
  const max = Math.max(...hist, 1);
  const w = 60;
  const h = 14;
  const pts = hist
    .map((v, i) => {
      const x = (i / (HIST - 1)) * w;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  // tick 只用于触发重绘，值本身要"被用到"，否则 noUnusedLocals 会把它摘掉
  void tick;
  return (
    <svg
      className="ib-spark"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      data-peak={Math.round(max)}
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function InfoBar({
  perfNode,
  onOpenPanel,
}: {
  /** 性能浮层由 App 传进来：PerfHud 要读 App 模块里的 renderTick，不在这里复制一份真值 */
  perfNode?: ReactNode;
  onOpenPanel: (id: string) => void;
}) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const subBoth = (cb: () => void) => {
    const u1 = serialStore.subscribe(cb);
    const u2 = serialStore.subscribeCounters(cb);
    return () => {
      u1();
      u2();
    };
  };
  const serial = useSyncExternalStore(subBoth, serialStore.getSnapshot);
  const tele = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getSnapshot);
  const demo = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const vdev = useSyncExternalStore(vdevStore.subscribe, vdevStore.getSnapshot);
  useSettings();
  const statusText =
    serial.status === "connected"
      ? serial.iface === "serial"
        ? `${t("st.connected")} ${serial.config.port} @ ${serial.config.baud}`
        : `${t("st.connected")} ${serial.portName ?? ""}`
      : serial.status === "reconnecting"
        ? t("st.reconnecting")
        : t("st.disconnected");
  const bpsText =
    serial.bps >= 1024
      ? `${(serial.bps / 1024).toFixed(1)} KB/s`
      : `${serial.bps} B/s`;
  const fmtBytes = (n: number) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

  return (
    <footer className="statusbar">
      <span className="status-left">
        <span className={`dot ${serial.status}`} />
        {statusText}
        {/* C17：演示源在跑时状态栏不再误报「未连接」——数据明明在流动 */}
        {demo.demoRunning && (
          <span
            className="status-demo"
            title={tx("内置演示源运行中（协议面板可停止）", "Built-in demo source running (stop it in the protocol panel)")}
          >
            {tx("演示源", "Demo")}
          </span>
        )}
        {vdev.running && (
          <span
            className="status-demo"
            title={tx(`虚拟设备「${vdev.device ?? ""}」运行中（虚拟设备工坊可停止）`, `Virtual device "${vdev.device ?? ""}" running (stop it in the workshop)`)}
          >
            {tx("虚拟设备", "VDev")}
          </span>
        )}
        {serial.error && <span className="status-error">{serial.error}</span>}
        {perfNode}
      </span>
      <span className="status-right">
        <Sparkline />
        <button
          type="button"
          className="ib-count"
          title={tx("收流字节 · 点击打开 Hex 数据流", "Bytes received · click to open the Hex stream")}
          onClick={() => onOpenPanel("hexview")}
        >
          RX {fmtBytes(serial.rxTotal)}
        </button>
        <span className="ib-sep">·</span>
        <button
          type="button"
          className="ib-count"
          title={tx("发流字节 · 点击打开 Hex 数据流", "Bytes sent · click to open the Hex stream")}
          onClick={() => onOpenPanel("hexview")}
        >
          TX {fmtBytes(serial.txTotal)}
        </button>
        <span className="ib-sep">·</span>
        <span className="ib-rate">{bpsText}</span>
        <span className="ib-sep">·</span>
        <button
          type="button"
          className="ib-count"
          title={tx("解析出的帧数 · 点击打开帧画布", "Parsed frames · click to open the frame canvas")}
          onClick={() => onOpenPanel("framecanvas")}
        >
          {tx("帧", "fr")} {tele.stats.total}
        </button>
        <span className="ib-sep">/</span>
        <button
          type="button"
          className={`ib-count${tele.stats.errors > 0 ? " err" : ""}`}
          title={tx("校验失败的帧 · 点击打开哨兵看异常", "Frames failing validation · click to open the sentinel")}
          onClick={() => onOpenPanel("sentinel")}
        >
          {tx("错", "err")} {tele.stats.errors}
        </button>
      </span>
    </footer>
  );
}
