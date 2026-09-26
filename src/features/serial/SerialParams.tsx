import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ParityMode } from "../../ipc/types";
import * as store from "./serialStore";
import * as sessionStore from "../session/sessionStore";
import { useSettings } from "../settings/settingsStore";
import { t, tx, useLocale } from "../../i18n/strings";
import { IconChevron } from "../../shared/icons";

const BAUDS = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
  1000000, 2000000, 3000000,
];

/**
 * P105-E：接入面板的字段行 = 标签列 + 控件列。
 *
 * 病根不是"间距不对"，是**全面板零个 `<label>`**：五只盒子并排、彼此贴死，
 * 含义只活在 `title` 里 —— 第一次用的人看到的是一排不知道填什么的小框。
 *
 * 为什么是 `div` + 控件自带 `aria-label`，而不是把整行包进 `<label>`：
 * 波特率那一格里有 `.baud-combo`（内含 `.baud-menu` 与两颗按钮），帧格式那一格里有
 * 三只下拉 —— `<label>` 的内容模型是 phrasing content，塞 div 进去不合法；
 * 而隐式关联只指向**第一个** labelable 后代，用它命名三只下拉是在撒谎。
 * 所以可见标签归排版，可访问名归控件自己（`aria-label` 与可见文字同一个变量，不是第二真相）。
 */
export function Field({
  label,
  tip,
  children,
}: {
  label: string;
  tip?: string;
  children: ReactNode;
}) {
  return (
    <div className="lk-row">
      <span className="lk-label" title={tip ?? label}>
        {label}
      </span>
      <div className="lk-ctl">{children}</div>
    </div>
  );
}

/** 连接/断开主行动。`data-tour="connect"` 是引导锚点，搬走时必须跟着这颗钮走。 */
export function ConnectButton() {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useSettings(); // 语言切换时随设置重渲染

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
      // 录制中禁止断开：录制 tap 在 Rust 侧持续接管帧流，断开会截断会话
      if (sessionStore.isRecording()) {
        store.setError(tx("录制中禁止断开连接", "Cannot disconnect while recording"));
        return;
      }
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
    <button
      className={`connect-btn ${s.status}`}
      data-tour="connect"
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
  );
}

/** 串口参数编辑区（端口/波特率/数据位/校验/停止位）。
 *  P104-B6a：从 SerialToolbar 拆出来，是为了让同一个编辑器既能留在顶栏（旧位置），
 *  也能整块搬进左栏「协议与连接」（B6 的新位置）——拆之前它和连接钮焊死在一个 div 里。 */
export function LinkParams() {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useSettings(); // 语言切换时随设置重渲染（t() 的取值来源）
  const locked = s.status !== "disconnected";
  const [baudText, setBaudText] = useState(String(s.config.baud));
  const [baudOpen, setBaudOpen] = useState(false);
  const comboRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBaudText(String(s.config.baud));
  }, [s.config.baud]);

  useEffect(() => {
    if (!baudOpen) return;
    const close = (e: MouseEvent) => {
      if (!comboRef.current?.contains(e.target as Node)) setBaudOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [baudOpen]);

  const PORT_LABEL = t("tb.port");
  // 标题用短键，长句（"预设或自定义"）留在 tip：标签列要能对齐，说明文字不该撑歪它
  const BAUD_LABEL = t("tb.baudShort");
  const FORMAT_LABEL = tx("数据格式", "Frame format");

  return (
    <>
      {s.ports.length ? (
        <Field label={PORT_LABEL} tip={PORT_LABEL}>
          <select
            className="input"
            disabled={locked}
            value={s.config.port}
            aria-label={PORT_LABEL}
            onChange={(e) => store.setConfig({ port: e.target.value })}
          >
            <option value="">{t("tb.portPlaceholder")}</option>
            {s.ports.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} — {p.friendly}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        // 端口列表由 Rust 侧 1500ms 热插拔轮询推事件（`serial.rs` start_hotplug），
        // 插上就会自己出现 —— 所以这里**不放刷新按钮**：那是一颗按了不会更快的假按钮。
        <Field label={PORT_LABEL} tip={PORT_LABEL}>
          <span className="lk-hint">
            {tx("未发现串口 · 插上后自动出现在这里", "No serial port · it appears once plugged in")}
          </span>
        </Field>
      )}
      <Field label={BAUD_LABEL} tip={t("tb.baud")}>
        <div className="baud-combo" ref={comboRef}>
          <input
            className="input baud"
            disabled={locked}
            value={baudText}
            aria-label={BAUD_LABEL}
            inputMode="numeric"
            onChange={(e) => {
              setBaudText(e.target.value);
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v) && v > 0) store.setConfig({ baud: v });
            }}
          />
          <button
            className={`baud-toggle ${baudOpen ? "open" : ""}`}
            disabled={locked}
            title={tx("常用波特率", "Common baud rates")}
            aria-label={tx("常用波特率", "Common baud rates")}
            onClick={() => setBaudOpen((v) => !v)}
          >
            <IconChevron size={13} dir="down" />
          </button>
          {baudOpen && (
            <div className="baud-menu">
              {BAUDS.map((b) => (
                <button
                  key={b}
                  className={b === s.config.baud ? "on" : ""}
                  onClick={() => {
                    store.setConfig({ baud: b });
                    setBaudOpen(false);
                  }}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>
      </Field>
      {/* P104-B6：数据位 / 校验 / 停止位是**一个**概念（帧格式），过去是三只各带边框、
          间隔 8px 的独立下拉，读起来像三件互不相干的事。合成一只框：外框承担边框与圆角，
          三只内部去皮（顺带少两条带宽度边框声明，G 门只降不升）。
          P105-E 给它补上行的名字——框管"三只是一组"，标签管"这一组是数据格式"。
          三只的 title 保留在各自元素上：组标签的 tooltip 会盖掉它们，反而丢了信息。 */}
      <Field label={FORMAT_LABEL} tip={tx("数据位 · 校验 · 停止位", "Data bits · parity · stop bits")}>
        <div className="frm-combo">
          <select
            className="input"
            disabled={locked}
            value={s.config.dataBits}
            aria-label={t("tb.dataBits")}
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
            aria-label={t("tb.parity")}
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
            aria-label={t("tb.stopBits")}
            title={t("tb.stopBits")}
            onChange={(e) =>
              store.setConfig({ stopBits: Number(e.target.value) as 1 | 2 })
            }
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </div>
      </Field>
      {/* P104-B5：ModbusBadge 不在这里。它原挂在参数尾部，而注释写着
          「服务在跑就必须看得见（面板可能已关）」——参数搬进左栏后，面板一关它就没了，
          这条保证会被静默拆掉。徽标是状态不是参数，留在命令条。 */}
    </>
  );
}
