import { useSyncExternalStore } from "react";
import { tx } from "../../i18n/strings";
import { requestOpenPanel } from "../ai/appBus";
import * as slave from "./slaveStore";
import * as poll from "./pollStore";

/**
 * 工具栏徽标：Modbus 从站 / 主站轮询在跑就必须可见——
 * 面板关掉后服务仍在运行（状态机是模块级的），若没有这枚徽标，
 * 软件会"看起来什么都没做但在偷偷应答/发请求"，现场无法判断。
 */
export function ModbusBadge() {
  const sl = useSyncExternalStore(slave.subscribe, slave.getSnapshot);
  const pl = useSyncExternalStore(poll.subscribe, poll.getSnapshot);
  if (!sl.running && !pl.running) return null;
  const text =
    sl.running && pl.running
      ? tx("Modbus 从站+轮询", "Modbus slave+poller")
      : sl.running
        ? tx(`Modbus 从站 ${sl.address}`, `Modbus slave ${sl.address}`)
        : tx(`Modbus 轮询 ${pl.rows.filter((r) => r.enabled).length} 项`, `Modbus poll ${pl.rows.filter((r) => r.enabled).length}`);
  return (
    <button
      type="button"
      className="tb-mb-badge"
      onClick={() => requestOpenPanel("modbus")}
      title={tx("Modbus 服务正在运行，点击打开工作台", "Modbus service is running — click to open the workbench")}
    >
      <span className="tb-mb-dot" aria-hidden="true" />
      {text}
    </button>
  );
}
