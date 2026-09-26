import * as serialStore from "./serialStore";
import type { IfaceKind } from "./serialStore";
import { t, tx } from "../../i18n/strings";

const PARITY_LETTER: Record<string, string> = { none: "N", even: "E", odd: "O" };

/** 五种数据接口的名字与法定顺序。
 *  放这个 .ts 而不是组件文件：命令条的胶囊与导轨的「接入」面板都要读它，
 *  而组件文件混导出常量会让 react-refresh 放弃热更新。 */
export const ifaceLabels = (): Record<IfaceKind, string> => ({
  serial: t("iface.serial"),
  "tcp-client": t("iface.tcpClient"),
  "tcp-server": t("iface.tcpServer"),
  udp: t("iface.udp"),
  ble: t("iface.ble"),
});

export const IFACE_ITEMS: IfaceKind[] = ["serial", "tcp-client", "tcp-server", "udp", "ble"];

/**
 * 工具栏那枚只读链路胶囊的文本。
 *
 * R4 起开头带接口名：接口切换器（原来那枚药丸下拉）搬进了导轨「接入」，
 * 顶栏只剩这一处说"连着什么"，接口名再省掉就真没人说了。
 *
 * 单独一个 .ts 而不是留在 ifaces.tsx：后者是组件文件，混一个非组件导出
 * 会让 react-refresh 放弃热更新（lint 的 only-export-components 就是钉这个）。
 */
export function linkSummary(
  s: ReturnType<typeof serialStore.getSnapshot>,
): string {
  const kind = ifaceLabels()[s.iface];
  if (s.iface === "serial") {
    const p = PARITY_LETTER[s.config.parity] ?? "?";
    return `${kind} · ${s.config.port || tx("未选端口", "No port")} · ${s.config.baud} · ${s.config.dataBits}${p}${s.config.stopBits}`;
  }
  if (s.iface === "ble") {
    const d = s.bleDevices.find((x) => x.id === s.bleDeviceId);
    return `${kind} · ${d?.name || d?.id || tx("未选设备", "No device")}`;
  }
  const n = s.net;
  if (s.iface === "tcp-server") return `${kind} · ${n.localHost || "0.0.0.0"}:${n.localPort}`;
  if (s.iface === "tcp-client") return `${kind} · ${n.remoteHost || "—"}:${n.remotePort || "—"}`;
  return n.remoteHost
    ? `${kind} · ${n.localPort} → ${n.remoteHost}:${n.remotePort}`
    : `${kind} · ${n.localPort}`;
}
