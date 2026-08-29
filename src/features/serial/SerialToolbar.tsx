import { useEffect, useState, useSyncExternalStore } from "react";
import type { ParityMode } from "../../ipc/types";
import * as store from "./serialStore";

const BAUDS = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000,
  3000000,
];

export function SerialToolbar() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const locked = s.status !== "disconnected";
  const [baudText, setBaudText] = useState(String(s.config.baud));

  useEffect(() => {
    setBaudText(String(s.config.baud));
  }, [s.config.baud]);

  const onConnect = async () => {
    if (s.status === "disconnected") {
      if (!s.config.port) {
        store.setError("请先选择串口");
        return;
      }
      try {
        await store.openPort();
      } catch {
        return;
      }
    } else {
      await store.closePort();
    }
  };

  const label =
    s.status === "connected"
      ? "断开"
      : s.status === "reconnecting"
        ? "重连中…"
        : "连接";

  return (
    <div className="toolbar-group">
      <button
        className={`connect-btn ${s.status}`}
        onClick={onConnect}
        title={
          s.status === "connected"
            ? "点击断开串口"
            : s.status === "reconnecting"
              ? "串口断开，正在自动重连"
              : "打开串口连接"
        }
      >
        <span className="connect-dot" />
        {label}
      </button>
      <select
        className="input"
        disabled={locked}
        value={s.config.port}
        onChange={(e) => store.setConfig({ port: e.target.value })}
        title="串口"
      >
        <option value="">COM 口</option>
        {s.ports.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name} — {p.friendly}
          </option>
        ))}
      </select>
      <input
        className="input baud"
        list="vs-bauds"
        disabled={locked}
        value={baudText}
        title="波特率（预设或自定义）"
        onChange={(e) => {
          setBaudText(e.target.value);
          const v = parseInt(e.target.value, 10);
          if (!Number.isNaN(v) && v > 0) store.setConfig({ baud: v });
        }}
      />
      <datalist id="vs-bauds">
        {BAUDS.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <select
        className="input"
        disabled={locked}
        value={s.config.dataBits}
        title="数据位"
        onChange={(e) =>
          store.setConfig({ dataBits: Number(e.target.value) as 7 | 8 })
        }
      >
        <option value={7}>7</option>
        <option value={8}>8</option>
      </select>
      <select
        className="input"
        disabled={locked}
        value={s.config.parity}
        title="校验位"
        onChange={(e) =>
          store.setConfig({ parity: e.target.value as ParityMode })
        }
      >
        <option value="none">无校验</option>
        <option value="even">偶校验</option>
        <option value="odd">奇校验</option>
      </select>
      <select
        className="input"
        disabled={locked}
        value={s.config.stopBits}
        title="停止位"
        onChange={(e) =>
          store.setConfig({ stopBits: Number(e.target.value) as 1 | 2 })
        }
      >
        <option value={1}>1</option>
        <option value={2}>2</option>
      </select>
    </div>
  );
}
