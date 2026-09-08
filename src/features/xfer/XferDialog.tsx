import { useRef, useState, useSyncExternalStore } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as store from "./xferStore";
import * as serialStore from "../serial/serialStore";
import { useSettings } from "../settings/settingsStore";
import { t, tx } from "../../i18n/strings";

/**
 * XMODEM/YMODEM 文件传输对话框（P49）。
 * 只做参数选择与进度展示：协议状态机、RX 截流、接口路由全在 Rust xfer.rs。
 */

const PROTO_ITEMS: { key: string; label: string; hint: string }[] = [
  {
    key: "ymodem",
    label: "YMODEM",
    hint: tx("带文件名批次头，1K 数据块；STM32 串口 Bootloader 等常用", "Batch header with filename, 1K blocks; used by STM32 UART bootloader"),
  },
  {
    key: "xmodem1k",
    label: "XMODEM-1K",
    hint: tx("1K 数据块 + CRC16，吞吐优先", "1K blocks + CRC16, throughput first"),
  },
  {
    key: "xmodem",
    label: "XMODEM",
    hint: tx("128B 数据块，校验方式由设备首个应答决定（NAK=校验和 / C=CRC16）", "128B blocks, mode from first reply (NAK=checksum / C=CRC16)"),
  },
];

export function XferDialog({
  onClose,
  initial,
}: {
  onClose: () => void;
  /** AI xferStart 动作预填：初始协议与文件路径 */
  initial?: { proto: string; path: string } | null;
}) {
  useSettings();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  const [proto, setProto] = useState(initial?.proto ?? "ymodem");
  const [path, setPath] = useState(initial?.path ?? "");
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);

  const connected = serial.status === "connected";

  const pickFile = async () => {
    const p = await openDialog({
      multiple: false,
      directory: false,
      title: tx("选择要发送的文件", "Choose file to send"),
    });
    if (typeof p === "string") setPath(p);
  };

  const doStart = async () => {
    if (!path || busyRef.current) return;
    busyRef.current = true;
    setErr(null);
    try {
      await store.start(proto, path);
    } catch (e) {
      setErr(String(e));
    } finally {
      busyRef.current = false;
    }
  };

  const p = s.progress;
  const pct = p && p.total > 0 ? Math.min(100, (p.bytes / p.total) * 100) : 0;
  const phaseLabel = p ? tx(store.PHASE_LABEL[p.phase][0], store.PHASE_LABEL[p.phase][1]) : null;
  const running = s.active;

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && running !== true && onClose()}>
      <div className="modal xfer-modal">
        <div className="modal-title">{tx("XMODEM / YMODEM 文件传输", "XMODEM / YMODEM file transfer")}</div>
        <div className="xfer-body">
          <div className="xfer-row">
            <label>{tx("协议", "Protocol")}</label>
            <select
              className="input"
              value={proto}
              disabled={running}
              onChange={(e) => setProto(e.target.value)}
              title={PROTO_ITEMS.find((x) => x.key === proto)?.hint}
            >
              {PROTO_ITEMS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
            <span className="xfer-hint">{PROTO_ITEMS.find((x) => x.key === proto)?.hint}</span>
          </div>
          <div className="xfer-row">
            <label>{tx("文件", "File")}</label>
            <input
              className="input xfer-path"
              value={path}
              readOnly
              placeholder={tx("选择固件/数据文件…", "Choose firmware/data file…")}
            />
            <button className="btn" disabled={running} onClick={() => void pickFile()}>
              {tx("浏览", "Browse")}
            </button>
          </div>

          {p && (
            <div className="xfer-progress">
              <div className="xfer-phead">
                <span className={running ? "xfer-run" : p.phase === "done" ? "xfer-ok" : "xfer-bad"}>
                  {phaseLabel}
                  {p.msg ? ` — ${p.msg}` : ""}
                </span>
                {p.bps > 0 && <span>{store.fmtBps(p.bps)}</span>}
              </div>
              <div className="xfer-bar">
                <div className="xfer-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="xfer-meta">
                {p.blocks > 0 && (
                  <span>
                    {tx("块", "Block")} {p.block}/{p.blocks}
                  </span>
                )}
                <span>
                  {p.bytes}/{p.total} B
                </span>
                {p.retries > 0 && (
                  <span className="xfer-retry">
                    {tx("重试", "Retries")} {p.retries}
                  </span>
                )}
              </div>
            </div>
          )}

          {!running && s.lastDone && (
            <div className={`xfer-result ${s.lastDone.ok ? "xfer-ok" : "xfer-bad"}`}>
              {s.lastDone.msg}
            </div>
          )}
          {err && <div className="xfer-result xfer-bad">{err}</div>}
          {!connected && (
            <div className="xfer-result xfer-bad">
              {tx("未连接任何接口：请先连接串口 / TCP / UDP / BLE", "No interface connected: connect serial / TCP / UDP / BLE first")}
            </div>
          )}

          <div className="xfer-tip">
            {tx(
              "传输期间设备应答（ACK/NAK）不会进入帧解析与 HexView；发送的块仍显示在控制台。中止会向设备发送 CAN。",
              "Receiver ACK/NAK bytes bypass frame parsing and HexView during transfer; sent blocks still show in console. Abort sends CAN to the device.",
            )}
          </div>
        </div>
        <div className="modal-foot">
          {running ? (
            <button className="btn danger-btn" onClick={() => void store.abort()}>
              {tx("中止传输", "Abort")}
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                {t("c.close")}
              </button>
              <button className="btn primary" disabled={!path} onClick={() => void doStart()}>
                {tx("开始发送", "Start")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
