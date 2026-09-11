import { useRef, useState, useSyncExternalStore } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as store from "./xferStore";
import * as serialStore from "../serial/serialStore";
import { isRecording } from "../session/sessionStore";
import { toast } from "../ai/extRuntime";
import { useSettings } from "../settings/settingsStore";
import { t, tx } from "../../i18n/strings";

/**
 * XMODEM/YMODEM 文件传输对话框（P49）。
 * 支持双向：发送（PC→设备烧录）/ 接收（设备→PC 抓取固件/日志）。
 * 只做参数选择与进度展示：协议状态机、RX 截流、接口路由全在 Rust xfer.rs。
 */

const PROTO_ITEMS: { key: string; label: string; hint: string }[] = [
  {
    key: "ymodem",
    label: "YMODEM",
    hint: tx("带文件名批次头，1K 数据块；STM32 串口 Bootloader 等常用", "Batch header with filename, 1K blocks; used by STM32 UART bootloader"),
  },
  {
    key: "ymodemg",
    label: "YMODEM-G",
    hint: tx("流式连发不等 ACK：吞吐极限、无重试，要求链路极可靠（直连串口）；设备出错会直接取消", "Streaming without per-block ACK: max throughput, no retries; needs a reliable link (direct serial); receiver cancels on error"),
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
  /** AI xferStart 动作预填：初始协议与文件路径列表（多文件顺序传输） */
  initial?: { proto: string; paths: string[] } | null;
}) {
  useSettings();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  const [dir, setDir] = useState<"send" | "receive">("send");
  const [proto, setProto] = useState(initial?.proto ?? "ymodem");
  const [paths, setPaths] = useState<string[]>(initial?.paths ?? []);
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);

  const connected = serial.status === "connected";
  const receiving = dir === "receive";
  const path = paths[0] ?? "";

  const pickFile = async () => {
    if (receiving) {
      const p = await saveDialog({
        title: tx("选择保存位置", "Choose where to save"),
        defaultPath: "received.bin",
      });
      if (typeof p === "string") setPaths([p]);
      return;
    }
    const picked = await openDialog({
      multiple: true,
      directory: false,
      title: tx("选择要发送的文件（可多选）", "Choose files to send (multi-select)"),
    });
    if (Array.isArray(picked)) {
      if (picked.length > 0) setPaths(picked);
    } else if (typeof picked === "string") {
      setPaths([picked]);
    }
  };

  const doStart = async () => {
    if (!paths.length || busyRef.current) return;
    busyRef.current = true;
    setErr(null);
    // 互斥提示（非阻断）：录制中开传输 → 传输期间 RX 字节不进录制（Rust 侧反向已硬拒绝）
    if (isRecording()) {
      toast(
        tx(
          "会话录制进行中：传输期间的接收字节不会进入录制，录制内容会有空洞",
          "Session recording is active: bytes received during the transfer bypass the recording, leaving a gap",
        ),
      );
    }
    try {
      if (receiving) await store.receiveStart(proto, path);
      else if (paths.length > 1) await store.startQueue(proto, paths);
      else await store.start(proto, path);
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
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && running !== true && onClose()}>
      <div className="modal xfer-modal">
        <div className="modal-title">{tx("XMODEM / YMODEM 文件传输", "XMODEM / YMODEM file transfer")}</div>
        <div className="xfer-body">
          <div className="xfer-row">
            <label>{tx("方向", "Direction")}</label>
            <div className="xfer-dir" role="radiogroup" aria-label={tx("传输方向", "Transfer direction")}>
              <button
                type="button"
                className={`btn ${!receiving ? "primary" : ""}`}
                disabled={running}
                aria-pressed={!receiving}
                onClick={() => setDir("send")}
              >
                {tx("PC → 设备（发送）", "PC → device (send)")}
              </button>
              <button
                type="button"
                className={`btn ${receiving ? "primary" : ""}`}
                disabled={running}
                aria-pressed={receiving}
                onClick={() => setDir("receive")}
              >
                {tx("设备 → PC（接收）", "device → PC (receive)")}
              </button>
            </div>
          </div>
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
              value={paths.length > 1 ? tx(`共 ${paths.length} 个文件（首个：${paths[0].split(/[\\/]/).pop()}…）`, `${paths.length} files (first: ${paths[0].split(/[\\/]/).pop()}…)`) : path}
              readOnly
              placeholder={receiving ? tx("选择保存位置…", "Choose where to save…") : tx("选择固件/数据文件…（可多选）", "Choose firmware/data files… (multi-select)")}
            />
            {!receiving && paths.length > 1 && !running && (
              <button className="btn" onClick={() => setPaths([])} title={tx("清空列表", "Clear list")}>
                {tx("清空", "Clear")}
              </button>
            )}
            <button className="btn" disabled={running} onClick={() => void pickFile()}>
              {tx("浏览", "Browse")}
            </button>
          </div>

          {p && (
            <div className="xfer-progress">
              <div className="xfer-phead">
                <span className={running ? "xfer-run" : p.phase === "done" ? "xfer-ok" : "xfer-bad"}>
                  {s.queue ? `${tx("文件", "File")} ${s.queue.idx + 1}/${s.queue.total} — ` : ""}
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
            {receiving
              ? tx(
                  "接收方以 CRC16 模式握手（'C'/'G'）；收到的数据块不进帧解析与 HexView。YMODEM 按批次头自动裁剪文件大小；XMODEM 裁掉末尾 0x1A 填充。中止会向设备发送 CAN。",
                  "Receiver handshakes in CRC mode ('C'/'G'); received blocks bypass frame parsing and HexView. YMODEM trims to the header size; XMODEM trims trailing 0x1A padding. Abort sends CAN.",
                )
              : tx(
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
              <button className="btn primary" disabled={!paths.length} onClick={() => void doStart()}>
                {receiving
                  ? tx("开始接收", "Start receiving")
                  : paths.length > 1
                    ? tx(`开始发送（${paths.length} 个文件）`, `Start sending (${paths.length} files)`)
                    : tx("开始发送", "Start")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
