import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { RxEventPayload, TxEventPayload } from "../../ipc/types";
import * as store from "../serial/serialStore";
import { IconPause, IconPlay, IconTrash } from "../../shared/icons";

interface Chunk {
  kind: "rx" | "tx";
  bytes: Uint8Array;
  ts: number;
}

const FILE_CHUNK_BYTES = 2048;
const MAX_CONSOLE_BLOCKS = 400;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0").toUpperCase();
    if (i < bytes.length - 1) out += " ";
  }
  return out;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function applyNewline(
  text: string,
  mode: "none" | "lf" | "crlf",
): string {
  if (mode === "lf") return text + "\n";
  if (mode === "crlf") return text + "\r\n";
  return text;
}

export function ConsolePanel() {
  const [mode, setMode] = useState<"ascii" | "hex">("ascii");
  const [showTs, setShowTs] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [showTx, setShowTx] = useState(true);
  const [showRx, setShowRx] = useState(true);
  const [paused, setPaused] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sendMode, setSendMode] = useState<"ascii" | "hex">("ascii");
  const [sendText, setSendText] = useState("");
  const [newline, setNewline] = useState<"none" | "lf" | "crlf">("none");
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("vs.sendHistory") ?? "[]");
    } catch {
      return [];
    }
  });
  const [error, setError] = useState<string | null>(null);

  const chunksRef = useRef<Chunk[]>([]);
  const viewRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileBusyRef = useRef(0);
  const decoderRef = useRef(new TextDecoder("utf-8"));
  const pausedRef = useRef(false);
  const showTxRef = useRef(true);
  const showRxRef = useRef(true);
  const modeRef = useRef(mode);

  pausedRef.current = paused || autoPaused;
  showTxRef.current = showTx;
  showRxRef.current = showRx;
  modeRef.current = mode;

  const renderBytes = (bytes: Uint8Array): string =>
    modeRef.current === "hex"
      ? toHex(bytes)
      : decoderRef.current.decode(bytes, { stream: true });

  useEffect(() => {
    const unsubs: UnlistenFn[] = [];
    listen<RxEventPayload>("serial:rx", (e) => {
      chunksRef.current.push({
        kind: "rx",
        bytes: Uint8Array.from(e.payload.bytes),
        ts: e.payload.tsLast,
      });
    }).then((u) => unsubs.push(u));
    listen<TxEventPayload>("serial:tx", (e) => {
      if (fileBusyRef.current > 0) return;
      chunksRef.current.push({
        kind: "tx",
        bytes: Uint8Array.from(e.payload.bytes),
        ts: e.payload.ts,
      });
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const chunks = chunksRef.current;
      if (!chunks.length || pausedRef.current) return;
      chunksRef.current = [];
      const el = viewRef.current;
      if (!el) return;
      let appended = false;
      for (const c of chunks) {
        let s: string;
        if (c.kind === "tx") {
          if (!showTxRef.current) continue;
          s = `[TX ${fmtTime(c.ts)}] ${renderBytes(c.bytes)}\n`;
        } else {
          if (!showRxRef.current) continue;
          const body = renderBytes(c.bytes);
          if (!body) continue;
          s = (showTs ? `[${fmtTime(c.ts)}] ` : "") + body;
        }
        el.appendChild(document.createTextNode(s));
        appended = true;
        while (el.childNodes.length > MAX_CONSOLE_BLOCKS) {
          el.removeChild(el.firstChild as ChildNode);
        }
      }
      if (appended && !pausedRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const onScroll = () => {
    const el = viewRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    setAutoPaused(!atBottom);
  };

  const clearAll = () => {
    chunksRef.current = [];
    decoderRef.current = new TextDecoder("utf-8");
    if (viewRef.current) viewRef.current.textContent = "";
  };

  const toggleRecord = async () => {
    try {
      if (recording) {
        await store.stopRecord();
        setRecording(false);
      } else {
        const path = await save({
          title: "保存接收日志",
          defaultPath: `vs-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`,
          filters: [
            { name: "日志文件", extensions: ["log", "txt"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
        if (!path) return;
        await store.startRecord(path);
        setRecording(true);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const pushHistory = (item: string) => {
    const next = [item, ...history.filter((h) => h !== item)].slice(0, 20);
    setHistory(next);
    localStorage.setItem("vs.sendHistory", JSON.stringify(next));
  };

  const doSend = async () => {
    const payload =
      sendMode === "ascii" ? applyNewline(sendText, newline) : sendText;
    if (!payload.trim()) return;
    try {
      await store.sendData(sendMode, payload);
      setError(null);
      pushHistory(sendText);
    } catch (e) {
      setError(String(e));
    }
  };

  const onFile = async (f: File) => {
    const buf = new Uint8Array(await f.arrayBuffer());
    fileBusyRef.current += 1;
    try {
      let hex = "";
      for (let i = 0; i < buf.length; i++) {
        hex += buf[i].toString(16).padStart(2, "0");
      }
      for (let i = 0; i < hex.length; i += FILE_CHUNK_BYTES * 2) {
        await store.sendData("hex", hex.slice(i, i + FILE_CHUNK_BYTES * 2));
      }
      if (viewRef.current) {
        viewRef.current.appendChild(
          document.createTextNode(
            `[TX ${fmtTime(Date.now())}] 文件 ${f.name}（${buf.length} 字节）\n`,
          ),
        );
        viewRef.current.scrollTop = viewRef.current.scrollHeight;
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setTimeout(() => {
        fileBusyRef.current -= 1;
      }, 300);
    }
  };

  const effectivePaused = paused || autoPaused;

  return (
    <div className="console">
      <div className="console-bar">
        <select
          className="input"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as "ascii" | "hex");
            decoderRef.current = new TextDecoder("utf-8");
          }}
          title="接收显示模式"
        >
          <option value="ascii">ASCII</option>
          <option value="hex">Hex</option>
        </select>
        <label className="chk">
          <input
            type="checkbox"
            checked={showTs}
            onChange={(e) => setShowTs(e.target.checked)}
          />
          时间戳
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
          />
          自动换行
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={showRx}
            onChange={(e) => setShowRx(e.target.checked)}
          />
          显示RX
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={showTx}
            onChange={(e) => setShowTx(e.target.checked)}
          />
          显示TX
        </label>
        <button
          className={`btn icon-btn ${effectivePaused ? "warn" : ""}`}
          onClick={() => {
            setPaused(!paused);
            setAutoPaused(false);
          }}
          title={effectivePaused ? "继续" : "暂停"}
        >
          {effectivePaused ? <IconPlay /> : <IconPause />}
        </button>
        <button className="btn icon-btn" onClick={clearAll} title="清空">
          <IconTrash />
        </button>
        <div className="console-spacer" />
        {recording && (
          <span className="rec">
            <span className="rec-dot" />
            记录中
          </span>
        )}
        <button className="btn" onClick={toggleRecord}>
          {recording ? "停止记录" : "记录日志"}
        </button>
      </div>
      <div
        ref={viewRef}
        className={`console-view ${wrap ? "wrap" : ""}`}
        onScroll={onScroll}
      />
      <div className="console-send">
        <select
          className="input"
          value={sendMode}
          onChange={(e) => setSendMode(e.target.value as "ascii" | "hex")}
          title="发送模式"
        >
          <option value="ascii">ASCII</option>
          <option value="hex">Hex</option>
        </select>
        {sendMode === "ascii" && (
          <select
            className="input"
            value={newline}
            onChange={(e) =>
              setNewline(e.target.value as "none" | "lf" | "crlf")
            }
            title="追加换行符"
          >
            <option value="none">无换行</option>
            <option value="lf">\n</option>
            <option value="crlf">\r\n</option>
          </select>
        )}
        <input
          className="input console-input"
          placeholder={
            sendMode === "hex" ? "AA 55 01（十六进制）" : "输入要发送的内容，回车发送"
          }
          value={sendText}
          onChange={(e) => setSendText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) doSend();
          }}
        />
        <select
          className="input"
          value=""
          onChange={(e) => {
            if (e.target.value) setSendText(e.target.value);
          }}
          title="发送历史"
        >
          <option value="">历史{history.length ? `(${history.length})` : ""}</option>
          {history.map((h, i) => (
            <option key={i} value={h}>
              {h.slice(0, 40)}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={doSend}>
          发送
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          发文件
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="console-error">{error}</div>}
    </div>
  );
}
