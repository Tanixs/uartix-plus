import { useState, useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { IconPlay, IconStop, IconTrash } from "../../shared/icons";
import * as slave from "./slaveStore";
import * as pollStore from "./pollStore";
import { toast } from "../ai/extRuntime";
import { MB_EXCEPTION_LABELS, type MbArea } from "./mb";
import { ModbusPoll } from "./ModbusPoll";

/**
 * Modbus 工作台（M2-c 从站 / M2-d 主站轮询）。
 *
 * 面板只是**视图**：从站与轮询的状态机在模块级 store 里，关掉页签服务照跑。
 * （前端有面板生命周期门控 panelActivity.isOpen——若服务随面板卸载，
 * 用户一关页签从站就不应答，这种"偶发失联"在现场几乎无法排查。）
 */

const AREAS: { key: MbArea; zh: string; en: string; bit: boolean }[] = [
  { key: "coil", zh: "线圈 0x（可读写位）", en: "Coils 0x (R/W bits)", bit: true },
  { key: "disc", zh: "离散输入 1x（只读位）", en: "Discrete inputs 1x (read-only)", bit: true },
  { key: "holding", zh: "保持寄存器 4x（可写字）", en: "Holding 4x (R/W words)", bit: false },
  { key: "input", zh: "输入寄存器 3x（只读字）", en: "Input 3x (read-only)", bit: false },
];

export function ModbusWorkbench() {
  useLocale();
  const s = useSyncExternalStore(slave.subscribe, slave.getSnapshot);
  const [tab, setTab] = useState<"slave" | "poll">("slave");

  return (
    <div className="mb">
      <div className="mb-tabs" role="tablist">
        <button
          role="tab"
          type="button"
          aria-selected={tab === "slave"}
          className={`mb-tab${tab === "slave" ? " on" : ""}`}
          onClick={() => setTab("slave")}
        >
          {tx("模拟从站", "Virtual slave")}
          {s.running && <i className="mb-dot" aria-hidden="true" />}
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === "poll"}
          className={`mb-tab${tab === "poll" ? " on" : ""}`}
          onClick={() => setTab("poll")}
        >
          {tx("主站轮询", "Master poller")}
        </button>
      </div>
      {tab === "slave" ? <SlaveTab /> : <ModbusPoll />}
    </div>
  );
}

/* ================= 模拟从站 ================= */

function SlaveTab() {
  useLocale();
  const s = useSyncExternalStore(slave.subscribe, slave.getSnapshot);
  const c = s.counters;

  return (
    <div className="mb-pane">
      <div className="mb-bar">
        <button
          type="button"
          className={`btn sm${s.running ? " warn" : " primary"}`}
          onClick={() => {
            if (s.running) {
              slave.stop();
              return;
            }
            // 互斥对称：轮询在跑时拒绝启从站（轮询侧同理，见 pollStore.blockReason）
            if (pollStore.isRunning()) {
              toast(
                tx(
                  "主站轮询正在运行：请先停轮询再开从站——自己问自己答会得出「假健康」",
                  "Master poller is running: stop it before starting the slave — answering your own requests fakes good health",
                ),
              );
              return;
            }
            slave.start();
          }}
          title={
            s.running
              ? tx("停止应答（从总线退出）", "Stop answering (leave the bus)")
              : tx("开始应答总线上的 Modbus 请求", "Start answering requests on the bus")
          }
        >
          {s.running ? <IconStop /> : <IconPlay />}
          {s.running ? tx("运行中 · 停止", "Running · Stop") : tx("启动从站", "Start slave")}
        </button>

        <label className="mb-f">
          {tx("从站地址", "Slave ID")}
          <input
            className="input mb-n60"
            type="number"
            min={0}
            max={247}
            value={s.address}
            onChange={(e) => slave.patch({ address: Number(e.target.value) })}
          />
        </label>
        <label className="mb-chk">
          <input
            type="checkbox"
            checked={s.anyAddress}
            onChange={(e) => slave.patch({ anyAddress: e.target.checked })}
          />
          {tx("应答所有地址", "Answer any ID")}
        </label>
        <label className="mb-f" title={tx("应答前延时：复现慢从站导致的主站超时", "Delay before replying: reproduces master timeouts")}>
          {tx("延时", "Delay")}
          <input
            className="input mb-n60"
            type="number"
            min={0}
            max={5000}
            step={10}
            value={s.delayMs}
            onChange={(e) => slave.patch({ delayMs: Number(e.target.value) })}
          />
          ms
        </label>
        <label className="mb-f">
          {tx("故障注入", "Fault")}
          <select
            className="input mb-fault"
            value={s.fault}
            onChange={(e) => slave.patch({ fault: e.target.value as slave.FaultMode })}
          >
            <option value="none">{tx("正常应答", "Normal")}</option>
            <option value="exception">{tx("一律回异常码", "Always exception")}</option>
            <option value="everyOther">{tx("隔一次回异常", "Every other")}</option>
            <option value="noReply">{tx("不回应答（掉线）", "Never reply")}</option>
          </select>
        </label>
        {(s.fault === "exception" || s.fault === "everyOther") && (
          <select
            className="input mb-code"
            value={s.faultCode}
            onChange={(e) => slave.patch({ faultCode: Number(e.target.value) })}
            title={tx("注入的规范异常码", "Exception code to inject")}
          >
            {MB_EXCEPTION_LABELS.map((l) => (
              <option key={l.v} value={l.v}>
                {l.v} {l.t}
              </option>
            ))}
          </select>
        )}
        <span className="mb-grow" />
        <span
          className="mb-counters"
          onClick={slave.resetCounters}
          title={tx("请求 / 应答 / 异常 / 忽略 / 噪声字节 —— 点击清零", "Requests / replies / exceptions / ignored / noise bytes — click to reset")}
        >
          {tx("请求", "Req")} <b>{c.requests}</b>
          <i />
          {tx("应答", "Rsp")} <b className="ok">{c.replies}</b>
          <i />
          {tx("异常", "Exc")} <b className={c.exceptions ? "bad" : ""}>{c.exceptions}</b>
          <i />
          {tx("忽略", "Ign")} <b>{c.ignored}</b>
          <i />
          {tx("噪声", "Noise")} <b>{c.noise}</b>
        </span>
      </div>

      <div className="mb-split">
        <BankEditor />
        <div className="mb-log">
          <div className="mb-log-head">
            <span>{tx("对话记录", "Conversation")}</span>
            <button type="button" className="btn sm" onClick={slave.clearEvents} disabled={!s.events.length}>
              <IconTrash />
              {tx("清空", "Clear")}
            </button>
          </div>
          <div className="mb-log-list">
            {!s.events.length && (
              <div className="mb-empty">
                {tx(
                  "启动后接上串口（或让另一台机器/指令工厂向本机发请求），每一条请求与应答都记在这里；本机发出的帧同时进发送日志。",
                  "Once started, every request and reply is listed here; frames we send also land in the TX log.",
                )}
              </div>
            )}
            {s.events.map((e, i) => (
              <div key={`${e.ts}-${i}`} className={`mb-ev mb-ev-${e.dir}`}>
                <span className="mb-ev-ts">
                  {new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false })}
                </span>
                <span className="mb-ev-txt">{e.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- 数据区 ---- */

const PAGE = 48;

function BankEditor() {
  useLocale();
  const s = useSyncExternalStore(slave.subscribe, slave.getSnapshot);
  const [area, setArea] = useState<MbArea>("holding");
  const [page, setPage] = useState(0);
  const [hexMode, setHexMode] = useState(false);
  /** 正在编辑的格子：网络写入触发重渲染时不能把用户敲到一半的内容冲掉 */
  const [draft, setDraft] = useState<{ i: number; v: string } | null>(null);
  const meta = AREAS.find((a) => a.key === area)!;
  const bank =
    area === "coil"
      ? slave.banks.coils
      : area === "disc"
        ? slave.banks.discs
        : area === "holding"
          ? slave.banks.holding
          : slave.banks.input;
  const total = meta.bit ? bank.length * 8 : bank.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(page, pages - 1);
  const base = p * PAGE;
  const count = Math.min(PAGE, total - base);

  const commit = (i: number, raw: string) => {
    const t = raw.trim();
    const v = /^0x/i.test(t) ? Number.parseInt(t, 16) : Number(t);
    if (!Number.isFinite(v)) return;
    if (meta.bit) slave.setBit(area as "coil" | "disc", i, !!v);
    else slave.setWord(area as "holding" | "input", i, v);
  };

  return (
    <div className="mb-bank">
      <div className="mb-bank-bar">
        <select
          className="input mb-area"
          value={area}
          onChange={(e) => {
            setArea(e.target.value as MbArea);
            setPage(0);
            setDraft(null);
          }}
        >
          {AREAS.map((a) => (
            <option key={a.key} value={a.key}>
              {tx(a.zh, a.en)}
            </option>
          ))}
        </select>
        <label className="mb-chk">
          <input type="checkbox" checked={hexMode} onChange={(e) => setHexMode(e.target.checked)} />
          HEX
        </label>
        <button type="button" className="btn sm" onClick={() => slave.seedDemo(area)} title={tx("填一组正弦/交替位演示数据", "Fill demo values")}>
          {tx("演示数据", "Demo")}
        </button>
        <span className="mb-grow" />
        <label className="mb-f">
          {tx("位区容量", "Bits")}
          <input
            className="input mb-n60"
            type="number"
            min={8}
            max={2048}
            step={8}
            value={slave.banks.coils.length * 8}
            onChange={(e) => slave.resize(Number(e.target.value) / 8, s.wordSize)}
          />
        </label>
        <label className="mb-f">
          {tx("字区容量", "Words")}
          <input
            className="input mb-n60"
            type="number"
            min={1}
            max={4096}
            value={slave.banks.holding.length}
            onChange={(e) => slave.resize(s.bitSize, Number(e.target.value))}
          />
        </label>
        <span className="mb-page">
          <button type="button" className="btn sm" onClick={() => setPage(p - 1)} disabled={p <= 0} aria-label={tx("上一页", "Previous page")}>
            ‹
          </button>
          <b>
            {p + 1}/{pages}
          </b>
          <button type="button" className="btn sm" onClick={() => setPage(p + 1)} disabled={p >= pages - 1} aria-label={tx("下一页", "Next page")}>
            ›
          </button>
        </span>
      </div>

      {meta.bit ? (
        <div className="mb-bits" role="group" aria-label={tx("位区", "Bit area")}>
          {Array.from({ length: count }, (_, k) => {
            const i = base + k;
            const on = ((bank[i >> 3] ?? 0) >> (i & 7)) & 1;
            return (
              <button
                type="button"
                key={i}
                className={`mb-bit${on ? " on" : ""}`}
                aria-pressed={!!on}
                title={tx(`第 ${i} 位（点击翻转）`, `Bit ${i} (click to toggle)`)}
                onClick={() => slave.setBit(area as "coil" | "disc", i, !on)}
              >
                <span className="mb-bit-i">{i}</span>
                <span className="mb-bit-v">{on}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mb-words" role="group" aria-label={tx("字区", "Word area")}>
          {Array.from({ length: count }, (_, k) => {
            const i = base + k;
            const v = (bank as Uint16Array)[i] ?? 0;
            const shown = draft && draft.i === i ? draft.v : hexMode ? "0x" + v.toString(16).toUpperCase().padStart(4, "0") : String(v);
            return (
              <label className="mb-word" key={i} title={tx(`寄存器 ${i}（4x 手册编号 ${40001 + i}）`, `Register ${i} (4x #${40001 + i})`)}>
                <span className="mb-bit-i">{i}</span>
                <input
                  className="input mb-cell"
                  value={shown}
                  onChange={(e) => setDraft({ i, v: e.target.value })}
                  onBlur={(e) => {
                    if (draft?.i === i) commit(i, e.target.value);
                    setDraft(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setDraft(null);
                  }}
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
