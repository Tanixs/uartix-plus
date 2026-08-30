import { useEffect, useState, useSyncExternalStore } from "react";
import type { ParityMode } from "../../ipc/types";
import * as store from "./serialStore";
import { useSettings } from "../settings/settingsStore";
import { t } from "../../i18n/strings";

export function SerialToolbar() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useSettings(); // 语言切换时随设置重渲染
  const locked = s.status !== "disconnected";
  const [baudText, setBaudText] = useState(String(s.config.baud));

  useEffect(() => {
    setBaudText(String(s.config.baud));
  }, [s.config.baud]);

  const onConnect = async () => {
    if (s.status === "disconnected") {
      if (!s.config.port) {
        store.setError(t("tb.selectPortFirst"));
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
      ? t("tb.disconnect")
      : s.status === "reconnecting"
        ? t("tb.reconnecting")
        : t("tb.connect");

  return (
    <div className="toolbar-group">
      <button
        className={`connect-btn ${s.status}`}
        onClick={onConnect}
        title={
          s.status === "connected"
            ? t("tb.clickDisconnect")
            : s.status === "reconnecting"
              ? t("tb.serialReconnecting")
              : t("tb.openSerial")
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
        title={t("tb.port")}
      >
        <option value="">{t("tb.portPlaceholder")}</option>
        {s.ports.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name} — {p.friendly}
          </option>
        ))}
      </select>
      <input
        className="input baud"
        disabled={locked}
        value={baudText}
        title={t("tb.baud")}
        inputMode="numeric"
        onChange={(e) => {
          setBaudText(e.target.value);
          const v = parseInt(e.target.value, 10);
          if (!Number.isNaN(v) && v > 0) store.setConfig({ baud: v });
        }}
      />
      <select
        className="input"
        disabled={locked}
        value={s.config.dataBits}
        title={t("tb.dataBits")}
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
        title={t("tb.parity")}
        onChange={(e) =>
          store.setConfig({ parity: e.target.value as ParityMode })
        }
      >
        <option value="none">{t("tb.parityNone")}</option>
        <option value="even">{t("tb.parityEven")}</option>
        <option value="odd">{t("tb.parityOdd")}</option>
      </select>
      <select
        className="input"
        disabled={locked}
        value={s.config.stopBits}
        title={t("tb.stopBits")}
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
