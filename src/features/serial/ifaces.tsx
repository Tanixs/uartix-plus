import { useSyncExternalStore, type ReactNode } from "react";
import * as serialStore from "./serialStore";
import type { IfaceKind } from "./serialStore";
import * as sessionStore from "../session/sessionStore";
import { useSettings } from "../settings/settingsStore";
import { t, tx, useLocale } from "../../i18n/strings";
import { ConnectButton, Field, LinkParams } from "./SerialParams";

/**
 * P104-B5/B6：接口装配层。
 *
 * 病根：`App.tsx` 里原来的 `NetIfaceBar` / `BleIfaceBar` 与顶栏的 `SerialToolbar` 各把
 * **「连接动作」和「参数编辑」焊在同一行**，于是顶栏想瘦下来就必须整条搬走——
 * 而命令条只要动作、左栏只要参数。这里把两者拆开（那两个组件已随本次拆分删除）：
 *   IfaceAction(kind) → 工具栏（连接/断开，一屏唯一的主行动）
 *   IfaceParams(kind) → 导轨「接入」面板（配置一次用一天；R4 起与接口切换器同处）
 *   linkSummary()（在 ./linkSummary.ts）→ 工具栏那枚只读胶囊（点击派发 ux:focus-link 回到「接入」）
 *
 * 顺带收敛：网络与蓝牙的 onToggle 此前是两份逐字相同的实现（含"录制中禁止断开"那条守卫），
 * 现在只有一份。守卫语义未变。
 */

/** 网络/蓝牙共用的连/断（串口那条另有"必须先选端口"的前置检查，见 ConnectButton） */
function IfaceConnectButton() {
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  useSettings();
  const busy = s.status === "connected" || s.status === "reconnecting";
  const onToggle = async () => {
    if (!busy) {
      await serialStore.openPort();
      return;
    }
    // 录制中禁止断开：录制 tap 在 Rust 侧持续接管帧流，断开会截断会话
    if (sessionStore.isRecording()) {
      serialStore.setError(tx("录制中禁止断开连接", "Cannot disconnect while recording"));
      return;
    }
    await serialStore.closePort();
  };
  return (
    <button
      className={`btn${busy ? " on" : ""}`}
      title={busy ? t("tb.disconnect") : t("tb.connect")}
      // 入门引导第 1 步的聚光灯锚点。原先只有串口那颗（ConnectButton）带它，
      // 于是选 TCP / UDP / BLE 时第 1 步找不到东西可圈，退化成一张漂浮卡 ——
      // 而这一步教的恰恰是"四种接口都在这儿连"。
      data-tour="connect"
      onClick={() => void onToggle()}
    >
      <span className={`dot ${busy ? "connected" : "disconnected"}`} />
      {busy ? t("tb.disconnect") : t("tb.connect")}
    </button>
  );
}

/**
 * 网络三种接口的参数。
 *
 * 每种要填什么**逐种列出来**，不再用 `kind !== "x"` 做减法。减法就是上一个 bug 的来源：
 * 远程地址那格的条件写的是 `kind !== "tcp-client"`，于是 TCP 客户端 —— 唯一
 * 非有目标主机不可的一种 —— 反而没有那一格，而工具栏胶囊还在显示
 * `remoteHost:remotePort`（`linkSummary.ts:43`），也就是显示着一个界面上无处可填的值。
 * 实测（改前）：切到 TCP 客户端，参数区只剩「远程端口」一格。
 * 顺带：TCP 服务端原来挂着「远程地址」，而服务端语义下它不参与监听 —— 已删（用户 2026-09-25 拍）。
 */
function NetParams({ kind }: { kind: Exclude<IfaceKind, "serial" | "ble"> }) {
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  useSettings();
  const busy = s.status === "connected" || s.status === "reconnecting";
  const net = (patch: Parameters<typeof serialStore.setNet>[0]) => serialStore.setNet(patch);

  const rows: { key: string; label: string; tip?: string; el: ReactNode }[] = [];

  if (kind === "tcp-server") {
    rows.push({
      key: "listen",
      label: tx("监听地址", "Listen address"),
      tip: tx(
        "0.0.0.0 接受所有网卡的连接；指定网卡则只接受发往该地址的连接",
        "0.0.0.0 accepts connections on all NICs; a specific address only accepts those sent to it",
      ),
      el: (
        <select
          className="input"
          value={s.net.localHost}
          disabled={busy}
          aria-label={tx("监听地址","Listen address")}
          onChange={(e) => net({ localHost: e.target.value })}
        >
          <option value="0.0.0.0">0.0.0.0 ({tx("所有地址", "all addresses")})</option>
          <option value="127.0.0.1">127.0.0.1 ({tx("仅本机回环", "loopback only")})</option>
          {s.localAddrs.map((a) => (
            <option key={a.ip} value={a.ip}>
              {a.ip} ({a.name})
            </option>
          ))}
          {s.net.localHost &&
            s.net.localHost !== "0.0.0.0" &&
            s.net.localHost !== "127.0.0.1" &&
            !s.localAddrs.some((a) => a.ip === s.net.localHost) && (
              <option value={s.net.localHost}>{s.net.localHost} ({tx("自定义", "custom")})</option>
            )}
        </select>
      ),
    });
    rows.push({
      key: "lport",
      label: t("tb.listenPort"),
      tip: t("tb.localPort"),
      el: (
        <input
          className="input"
          value={String(s.net.localPort)}
          disabled={busy}
          inputMode="numeric"
          aria-label={t("tb.listenPort")}
          onChange={(e) => net({ localPort: Number(e.target.value) || 0 })}
        />
      ),
    });
  } else {
    if (kind === "udp") {
      rows.push({
        key: "lport",
        label: t("tb.localPortUdp"),
        el: (
          <input
            className="input"
            value={String(s.net.localPort)}
            disabled={busy}
            inputMode="numeric"
            aria-label={t("tb.localPortUdp")}
            onChange={(e) => net({ localPort: Number(e.target.value) || 0 })}
          />
        ),
      });
    }
    rows.push({
      key: "rhost",
      label: t("tb.remoteHost"),
      el: (
        <input
          className="input"
          value={s.net.remoteHost}
          disabled={busy}
          aria-label={t("tb.remoteHost")}
          placeholder={kind === "tcp-client" ? "192.168.1.10" : undefined}
          onChange={(e) => net({ remoteHost: e.target.value })}
        />
      ),
    });
    rows.push({
      key: "rport",
      label: t("tb.remotePort"),
      el: (
        <input
          className="input"
          value={String(s.net.remotePort)}
          disabled={busy}
          inputMode="numeric"
          aria-label={t("tb.remotePort")}
          onChange={(e) => net({ remotePort: Number(e.target.value) || 0 })}
        />
      ),
    });
  }

  return (
    <>
      {rows.map((r) => (
        <Field key={r.key} label={r.label} tip={r.tip}>
          {r.el}
        </Field>
      ))}
    </>
  );
}

function BleParams() {
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  useSettings();
  const busy = s.status === "connected" || s.status === "reconnecting";
  const onScan = async () => {
    try {
      if (s.bleScanning) {
        await serialStore.bleScanStop();
      } else {
        await serialStore.bleScanStart();
      }
    } catch {
      /* 错误已在状态栏展示 */
    }
  };
  return (
    <>
      {/* 扫描与设备列表是**同一件事**（先扫到才能选），所以并在一行里；
          原来扫描钮孤零零排在输入堆前面，看着像表单的第一格。 */}
      <Field
        label={tx("设备", "Device")}
        tip={tx("需支持透传（Nordic UART 或可写+可通知特征对）", "Must support transparent transfer (Nordic UART or a writable+notifiable characteristic pair)")}
      >
        <button
          className={`btn${s.bleScanning ? " on" : ""}`}
          disabled={busy}
          aria-label={s.bleScanning ? tx("停止", "Stop") : tx("扫描", "Scan")}
          title={
            s.bleScanning
              ? tx("停止扫描", "Stop scanning")
              : tx("扫描附近 BLE 设备（列表按信号强度排序，每秒刷新）", "Scan nearby BLE devices (sorted by signal, refreshed every second)")
          }
          onClick={() => void onScan()}
        >
          {s.bleScanning ? tx("停止", "Stop") : tx("扫描", "Scan")}
        </button>
        <select
          className="input"
          value={s.bleDeviceId}
          disabled={busy}
          aria-label={tx("设备", "Device")}
          onChange={(e) => serialStore.setBleDevice(e.target.value)}
        >
          <option value="">
            {s.bleDevices.length
              ? tx("选择设备", "Select device")
              : tx("先点「扫描」", "Scan first")}
          </option>
          {s.bleDevices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name || tx("(未命名)", "(unnamed)")} — {d.id} · {d.rssi} dBm
            </option>
          ))}
        </select>
      </Field>
      {s.bleChars.length > 0 && (
        <>
          <Field
            label={tx("写特征", "Write char")}
            tip={tx("发数据：默认自动选择；非标准透传设备可手动指定", "TX: auto-selected by default; pick manually for non-standard devices")}
          >
            <select
              className="input"
              value={s.bleWriteChar}
              aria-label={tx("写特征", "Write char")}
              onChange={(e) => {
                serialStore.setBleCharSel({ bleWriteChar: e.target.value });
                void serialStore.applyBleChars();
              }}
            >
              <option value="">{tx("自动", "Auto")}</option>
              {s.bleChars
                .filter((c) => c.kind.includes("write"))
                .map((c) => (
                  <option key={c.uuid} value={c.uuid}>
                    {c.uuid.slice(0, 8)}… · {c.kind}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label={tx("收特征", "Notify char")}
            tip={tx("notify/indicate：默认自动选择；非标准透传设备可手动指定", "notify/indicate: auto-selected by default; pick manually for non-standard devices")}
          >
            <select
              className="input"
              value={s.bleNotifyChar}
              aria-label={tx("收特征", "Notify char")}
              onChange={(e) => {
                serialStore.setBleCharSel({ bleNotifyChar: e.target.value });
                void serialStore.applyBleChars();
              }}
            >
              <option value="">{tx("自动", "Auto")}</option>
              {s.bleChars
                .filter((c) => c.kind.includes("notify") || c.kind.includes("indicate"))
                .map((c) => (
                  <option key={c.uuid} value={c.uuid}>
                    {c.uuid.slice(0, 8)}… · {c.kind}
                  </option>
                ))}
            </select>
          </Field>
        </>
      )}
    </>
  );
}

/** 命令条：连接/断开（一屏唯一的主行动） */
export function IfaceAction({ kind }: { kind: IfaceKind }) {
  useLocale(); // 守卫三：这一片按钮/字段的话术是 tx() 出来的，切语言得有人重渲染
  return kind === "serial" ? <ConnectButton /> : <IfaceConnectButton />;
}

/** 左栏链路节：参数编辑 */
export function IfaceParams({ kind }: { kind: IfaceKind }) {
  useLocale();
  if (kind === "serial") return <LinkParams />;
  if (kind === "ble") return <BleParams />;
  return <NetParams kind={kind} />;
}
