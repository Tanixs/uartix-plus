import { useEffect, useState, useSyncExternalStore } from "react";
import * as serialStore from "./serialStore";
import type { IfaceKind } from "./serialStore";
import { IfaceParams } from "./ifaces";
import { IFACE_ITEMS, ifaceLabels, linkSummary } from "./linkSummary";
import { useSettings } from "../settings/settingsStore";
import { toggleRailPanel } from "../../shell/railState";
import { toast } from "../ai/extRuntime";
import { devIface } from "../../dev/bootOverrides";
import { t, tx, useLocale } from "../../i18n/strings";

/**
 * P104-R4 导轨「接入」面板：接口选择 + 该接口的全部链路参数。
 *
 * 这就是用户要的那件事——"把串口、网络等配置放在一起"。在此之前它们是散的：
 * 接口切换器在工具栏（一枚下拉）、参数在「协议与连接」面板里的可折叠链路节、
 * 连接钮在工具栏。想知道"现在走哪条路、参数是什么"要看两个地方。
 * 现在一处看完，工具栏只留一枚只读胶囊 + 连接钮。
 *
 * 切换接口的动作与原来那枚下拉**逐字一致**：连着或正在重连就先 `closePort()` 再 `setIface`。
 * 这不是可以顺手改进的地方——换接口必然换句柄，先关后开是唯一的顺序。
 */
export function LinkPanel() {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  useSettings(); // 语言切换时随设置重渲染（接口名现在也是渲染时取值）

  // P105-E 取证入口：接口选择今天不落盘，不靠 ?iface= 就拍不到其余四种（详设 §验收）
  useEffect(() => {
    const k = devIface();
    if (k) serialStore.setIface(k);
  }, []);

  // 工具栏那枚胶囊的落点：它派发 ux:focus-link，这里把自己展开并聚焦第一个控件
  useEffect(() => {
    const on = () => {
      toggleRailPanel("link");
      requestAnimationFrame(() => {
        const root = document.querySelector("[data-link-panel]");
        root?.scrollIntoView({ block: "nearest" });
        (root?.querySelector("select") as HTMLSelectElement | null)?.focus();
      });
    };
    window.addEventListener("ux:focus-link", on);
    return () => window.removeEventListener("ux:focus-link", on);
  }, []);

  const [breakMs, setBreakMs] = useState(20);
  const [breaking, setBreaking] = useState(false);
  const connected = s.status === "connected";

  // P106：modem 线只在"串口 + 已连接 + 面板开着"时读，500ms 一次；面板收起组件就卸载，表也就停了。
  // 读失败一律退回"未知"（不弹错、不断连）：虚拟串口与部分 CH340 驱动根本不支持读这几条线。
  useEffect(() => {
    if (s.iface !== "serial" || s.status !== "connected") {
      serialStore.setModemLines(null);
      return;
    }
    let stop = false;
    const poll = async () => {
      try {
        const m = await serialStore.readModemLines();
        if (!stop) serialStore.setModemLines(m);
      } catch {
        if (!stop) serialStore.setModemLines(null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [s.iface, s.status]);

  const setLine = async (k: "dtr" | "rts", level: boolean) => {
    try {
      await serialStore.setControlLines(k === "dtr" ? { dtr: level } : { rts: level });
    } catch (e) {
      serialStore.setError(String(e));
    }
  };

  const doBreak = async () => {
    setBreaking(true);
    try {
      await serialStore.sendBreak(breakMs);
      toast(tx("Break 已发送", "Break sent"));
    } catch (e) {
      serialStore.setError(String(e));
    } finally {
      setBreaking(false);
    }
  };

  // 一颗钮写三种状态：VOFA+ 那排 DTR/RTS 是一信号一钮，两枚高/低在这里太啰。
  // 但"没设过"必须自己站得住一个字面 —— 只画"没按下"会被读成"低电平"，那是在撒谎。
  const lineWord = (v: boolean | null) =>
    v === null ? tx("未设置", "unset") : v ? tx("高", "High") : tx("低", "Low");
  const lineTip = (v: boolean | null) =>
    v === null
      ? tx("Uartix+ 还没碰过这条线（打开串口也不会碰）；点一下置为高", "Uartix+ has never driven this line (opening the port won't either); click to drive it high")
      : tx("再点一下翻转电平", "Click again to flip the level");

  const pick = (k: (typeof IFACE_ITEMS)[number]) => {
    if (s.status === "connected" || s.status === "reconnecting") {
      void serialStore.closePort();
    }
    serialStore.setIface(k);
  };

  return (
    <div className="lk" data-link-panel>
      {/* 选择层：五颗 chip 换成一枚下拉（用户口径：五种接口不该占两行、也不该和参数一个视觉重量）。
          抬成一张 inset 卡片 + 近场影，与下面的参数分层；状态行跟着选择器走，因为它说的是"这条路现在通不通"。 */}
      <div className="lk-pick">
        <label className="lk-pick-label" htmlFor="lk-iface">{t("iface.title")}</label>
        <select
          id="lk-iface"
          className="input lk-pick-select"
          value={s.iface}
          onChange={(e) => pick(e.target.value as IfaceKind)}
          title={tx("切换接口会先断开当前连接", "Switching interfaces closes the current link first")}
        >
          {IFACE_ITEMS.map((k) => (
            <option key={k} value={k}>{ifaceLabels()[k]}</option>
          ))}
        </select>
        <div className="lk-state">
          <span className={`dot ${s.status}`} />
          {s.status === "connected"
            ? linkSummary(s)
            : s.status === "reconnecting"
              ? tx("重连中", "Reconnecting")
              : tx("未连接", "Offline")}
        </div>
      </div>

      <div className="lk-params">
        <IfaceParams kind={s.iface} />
      </div>

      {s.iface === "serial" && (
        <div className="lk-lines">
          <div className="lk-lines-head">
            <span className="lk-lines-title">{tx("控制线", "Control lines")}</span>
            <span className="lk-lines-note">{tx("打开串口时不主动碰这两条线", "Opening the port never drives these lines")}</span>
          </div>
          <div className="lk-line-row">
            <span className="lk-line-name" title={tx("数据终端就绪", "Data Terminal Ready")}>DTR</span>
            <span className="lk-line-btns">
              <button type="button" className="btn sm" aria-pressed={s.ctrl.dtr === true}
                disabled={!connected} title={lineTip(s.ctrl.dtr)}
                onClick={() => void setLine("dtr", s.ctrl.dtr !== true)}>{lineWord(s.ctrl.dtr)}</button>
            </span>
          </div>
          <div className="lk-line-row">
            <span className="lk-line-name" title={tx("请求发送", "Request To Send")}>RTS</span>
            <span className="lk-line-btns">
              <button type="button" className="btn sm" aria-pressed={s.ctrl.rts === true}
                disabled={!connected} title={lineTip(s.ctrl.rts)}
                onClick={() => void setLine("rts", s.ctrl.rts !== true)}>{lineWord(s.ctrl.rts)}</button>
            </span>
          </div>
          <div className="lk-line-ind" aria-label={tx("对端回来的四条线（只读）", "Lines coming back from the peer (read-only)")}>
            {(["cts", "dsr", "ri", "dcd"] as const).map((k) => (
              <span key={k} className={`lk-ind${s.modem?.[k] === true ? " on" : s.modem?.[k] === false ? " off" : " unknown"}`}
                title={s.modem?.[k] === true || s.modem?.[k] === false
                  ? `${k.toUpperCase()} ${s.modem[k] ? tx("高", "High") : tx("低", "Low")}`
                  : tx("驱动未提供该线读数", "The driver does not report this line")}>
                {k.toUpperCase()}
              </span>
            ))}
          </div>
          <div className="lk-line-row">
            <span className="lk-line-name" title={tx("拉低 TX 一段时间（LIN 唤醒、设备中断）", "Hold TX low for a while (LIN wake-up, device break)")}>Break</span>
            <span className="lk-line-btns">
              <input className="input lk-break-ms" type="number" min={1} max={1000} step={1}
                value={breakMs} disabled={!connected || breaking}
                onChange={(e) => setBreakMs(Number(e.target.value))} aria-label={tx("Break 时长（毫秒）", "Break duration (ms)")} />
              <button type="button" className="btn sm" disabled={!connected || breaking}
                onClick={() => void doBreak()}>{breaking ? tx("发送中", "Sending") : tx("发送", "Send")}</button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
