import * as serialStore from "./serialStore";
import type { IfaceKind } from "./serialStore";
import type { FlowMode } from "../../ipc/types";
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
 * P107：硬件流控之下 RTS 这根线归**驱动**（Windows `fRtsControl=Enable` + `fOutxCtsFlow`，
 * POSIX `CRTSCTS`）。此时手动置电平不报错，只是随后被驱动拖回去 —— 界面必须让路并说明。
 * Rust 侧 `apply_control_lines` 里是同一条判断（重开/重连时不复施加记过的 RTS 电平）。
 *
 * 为什么单独提成函数：这台机器上**一个串口都没有**（`list_ports` 返回空 ⇒ 连不上 ⇒
 * connected 分支在浏览器里根本走不到）。一条"点不动的钮"是这批唯一的安全属性，
 * 留在 JSX 里就等于没测。
 */
export const rtsHeldByDriver = (flow: FlowMode): boolean => flow === "hardware";

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
    // P107：只在**开了**流控时挂尾巴。它不是装饰——"我的字节怎么少了"第一眼该看到这行，
    // 而 none 是默认，把默认值天天印在状态行上只是挤宽度。
    // XON/XOFF、RTS/CTS 不翻：那是标准里的名字，和 8N1 同一类（翻成"软件流控"反而对不上手册）。
    const flow =
      s.config.flow === "software" ? "XON/XOFF" : s.config.flow === "hardware" ? "RTS/CTS" : "";
    return `${kind} · ${s.config.port || tx("未选端口", "No port")} · ${s.config.baud} · ${s.config.dataBits}${p}${s.config.stopBits}${flow ? ` · ${flow}` : ""}`;
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
