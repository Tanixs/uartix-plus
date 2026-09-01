import { useEffect, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { THEME_LIST, useSettings, patch, type ThemeMode, type WorkspacePreset } from "./settingsStore";
import { FULL_KIND, exportFullBackup, importDispatch } from "./transfer";
import { t } from "../../i18n/strings";
import * as templateStore from "../protocol/templateStore";
import * as controlsStore from "../controls/controlsStore";
import * as commandStore from "../controls/commandStore";
import { Section } from "../../shared/Section";
import { HelpHint } from "../../shared/HelpHint";
import appIcon from "../../assets/icon.svg";
import avatarUrl from "../../assets/avatar.png";

const PRESETS: { key: WorkspacePreset; label: string; desc: string }[] = [
  { key: "proto", label: t("set.preset.proto"), desc: "画布 + 属性 + Hex" },
  { key: "analyze", label: t("set.preset.analyze"), desc: "表格 + 2D 曲线" },
  { key: "attitude", label: t("set.preset.attitude"), desc: "3D 姿态 + 曲线" },
  { key: "console", label: t("set.preset.console"), desc: "仅控制台" },
  { key: "video", label: t("set.preset.video"), desc: "图传 + 控制画板" },
];

/** 主题色板预览：bg=窗口底色 panel=内容区 accent=高亮条（与 theme.css 变量块保持一致） */
const THEME_SWATCH: Record<ThemeMode, { bg: string; panel: string; accent: string }> = {
  light: { bg: "#f5f6f8", panel: "#ffffff", accent: "#2f6fce" },
  dark: { bg: "#0f1115", panel: "#161a20", accent: "#4e9cef" },
  navy: { bg: "#0d1322", panel: "#131b2e", accent: "#559df0" },
  ocean: { bg: "#eff4fa", panel: "#ffffff", accent: "#1e6fd9" },
  matcha: { bg: "#eef5ea", panel: "#fbfdf9", accent: "#3e8e52" },
  amber: { bg: "#fdf4ea", panel: "#fffbf6", accent: "#e07b1f" },
  begonia: { bg: "#fbf1f2", panel: "#fffcfc", accent: "#c8445c" },
  glaze: { bg: "#0e1420", panel: "#151d2c", accent: "#d05f6e" },
  system: {
    bg: "linear-gradient(135deg,#f5f6f8 49%,#0f1115 51%)",
    panel: "rgba(128,128,128,0.35)",
    accent: "#4e9cef",
  },
};

async function saveJson(kind: string, data: unknown): Promise<void> {
  const path = await save({
    title: t("set.export"),
    defaultPath: `${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
    filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
  });
  if (!path) return;
  await invoke("save_text_file", {
    path,
    content: JSON.stringify({ kind, version: 1, data }, null, 2),
  });
}

async function loadJson<T>(kinds: string[]): Promise<T | null> {
  const path = await open({
    title: t("set.import"),
    multiple: false,
    filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
  });
  if (typeof path !== "string") return null;
  let content = "";
  try {
    content = await invoke<string>("read_text_file", { path });
  } catch (e) {
    alert(`读取失败: ${e}`);
    return null;
  }
  try {
    const obj = JSON.parse(content) as { kind?: string; data?: T };
    if (!obj.kind || !kinds.includes(obj.kind) || obj.data === undefined) {
      alert("文件格式不正确：kind 不匹配或缺少 data");
      return null;
    }
    return obj.data;
  } catch (e) {
    alert(`JSON 解析失败: ${e}`);
    return null;
  }
}

export function SettingsModal({ onClose, onResetLayout }: { onClose: () => void; onResetLayout: (p: WorkspacePreset) => void }) {
  const settings = useSettings();
  const [tab, setTab] = useState("general");
  const [msg, setMsg] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [updState, setUpdState] = useState<{
    status: "idle" | "checking" | "downloading" | "latest" | "ready" | "error";
    msg: string;
  }>({ status: "idle", msg: "" });

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  const runUpdateCheck = async () => {
    setUpdState({ status: "checking", msg: "正在检查更新…" });
    try {
      const upd = await check();
      if (!upd) {
        setUpdState({ status: "latest", msg: "当前已是最新版本" });
        return;
      }
      setUpdState({ status: "downloading", msg: `发现新版本 ${upd.version}，正在下载安装…` });
      await upd.downloadAndInstall();
      setUpdState({ status: "ready", msg: `已更新到 ${upd.version}，即将重启应用…` });
      setTimeout(() => void relaunch(), 1200);
    } catch (e) {
      const raw = String(e).replace(/^Error:\s*/i, "").replace(/^updater\s*/i, "");
      setUpdState({
        status: "error",
        msg: `检查更新失败：${raw}（若提示未配置更新源，说明更新服务尚未发布）`,
      });
    }
  };

  const tabs: { key: string; label: string }[] = [
    { key: "general", label: t("set.general") },
    { key: "workspace", label: t("set.workspace") },
    { key: "data", label: t("set.data") },
    { key: "io", label: t("set.io") },
    { key: "about", label: t("set.about") },
  ];

  const row = (label: string, node: React.ReactNode, tip?: string) => (
    <div className="set-row">
      <label>
        {label}
        {tip && <HelpHint text={tip} />}
      </label>
      <div className="set-ctl">{node}</div>
    </div>
  );

  const ioBlock = (label: string, tip: string, onExport: () => Promise<void>, onImport: () => Promise<void>) => (
    <div className="set-io-block">
      <div className="set-io-head">
        <div className="set-io-label">
          {label}
          <HelpHint text={tip} />
        </div>
        <div className="set-io-actions">
          <button className="btn" onClick={() => void onExport()}>{t("set.export")}</button>
          <button className="btn" onClick={() => void onImport()}>{t("set.import")}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal set-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("title.settings")}</div>
        <div className="set-body">
          <div className="set-nav">
            {tabs.map((x) => (
              <button key={x.key} className={tab === x.key ? "on" : ""} onClick={() => setTab(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
          <div className="set-content">
            {tab === "general" && (
              <>
                {row(t("set.language"), (
                  <select className="input" value={settings.locale} onChange={(e) => patch({ locale: e.target.value as "zh" | "en" })}>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                ))}
                {row(t("set.theme"), (
                  <div className="theme-grid">
                    {THEME_LIST.map((th) => {
                      const sw = THEME_SWATCH[th];
                      return (
                        <button
                          key={th}
                          className={`theme-card ${settings.theme === th ? "on" : ""}`}
                          title={t(`set.theme.${th}`)}
                          onClick={() => {
                            patch({ theme: th });
                            // 即时同步 DOM（不等 effect 时序）；system 立即解析一次
                            document.documentElement.dataset.theme =
                              th === "system"
                                ? window.matchMedia("(prefers-color-scheme: dark)").matches
                                  ? "dark"
                                  : "light"
                                : th;
                          }}
                        >
                          <span
                            className="theme-swatch"
                            style={{ background: sw.bg }}
                          >
                            <span className="theme-bar" style={{ background: sw.accent }} />
                            <span className="theme-panel" style={{ background: sw.panel }} />
                          </span>
                          <span className="theme-name">{t(`set.theme.${th}`)}</span>
                        </button>
                      );
                    })}
                  </div>
                ), t("set.theme.tip"))}
                {row(t("set.zoom"), (
                  <div className="set-seg">
                    {[90, 100, 110, 125].map((z) => (
                      <button key={z} className={settings.zoom === z ? "on" : ""} onClick={() => patch({ zoom: z })}>
                        {z}%
                      </button>
                    ))}
                  </div>
                ), t("set.zoom.tip"))}
              </>
            )}
            {tab === "workspace" && (
              <>
                {row(t("set.preset"), (
                  <div className="preset-grid">
                    {PRESETS.map((p) => (
                      <button
                        key={p.key}
                        className={`preset-card${settings.workspace === p.key ? " on" : ""}`}
                        onClick={() => {
                          patch({ workspace: p.key });
                          onResetLayout(p.key);
                        }}
                      >
                        <span className="preset-name">{p.label}</span>
                        <span className="preset-desc">{p.desc}</span>
                      </button>
                    ))}
                  </div>
                ), t("set.preset.tip"))}
                {row(t("set.resetLayout"), (
                  <button className="btn" onClick={() => onResetLayout(settings.workspace)}>{t("set.resetLayout")}</button>
                ), t("set.resetLayout.tip"))}
                {row(t("set.cellSize"), (
                  <div className="set-seg">
                    {([48, 60, 72, 90, 110] as const).map((c) => (
                      <button key={c} className={settings.cellSize === c ? "on" : ""} onClick={() => patch({ cellSize: c })}>
                        {c === 48 ? "48 紧凑" : c === 60 ? "60 标准" : c === 72 ? "72 宽松" : c === 90 ? "90 更宽松" : "110 超宽松"}
                      </button>
                    ))}
                  </div>
                ), t("set.cellSize.tip"))}
              </>
            )}
            {tab === "data" && (
              <>
                {row(t("set.decimals"), (
                  <input
                    type="number"
                    className="input"
                    style={{ width: 72 }}
                    min={0}
                    max={6}
                    value={settings.decimals}
                    onChange={(e) => {
                      const v = Math.round(Number(e.target.value));
                      if (!Number.isFinite(v)) return;
                      patch({ decimals: Math.max(0, Math.min(6, v)) });
                    }}
                  />
                ), t("set.decimals.tip"))}
                {row(t("set.perfHud"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.perfHud}
                      onChange={(e) => patch({ perfHud: e.target.checked })}
                    />
                    <span />
                  </label>
                ), t("set.perfHud.tip"))}
              </>
            )}
            {tab === "io" && (
              <>
                {ioBlock(
                  t("set.exportFull"),
                  t("set.io.full.tip"),
                  async () => {
                    await saveJson(FULL_KIND, exportFullBackup());
                    setMsg("全部配置已导出");
                  },
                  async () => {
                    const d = await loadJson<unknown>([FULL_KIND]);
                    if (!d) return;
                    setMsg(await importDispatch(FULL_KIND, d));
                  },
                )}
                {ioBlock(
                  t("set.exportTemplates"),
                  t("set.io.templates.tip"),
                  async () => {
                    const d = templateStore.exportTemplatesWithMeta();
                    await saveJson("uartix-templates", d);
                    setMsg("模板已导出");
                  },
                  async () => {
                    const d = await loadJson<unknown>(["uartix-templates"]);
                    if (!d) return;
                    const obj = d as { kind?: string; data?: unknown };
                    setMsg(await importDispatch(obj.kind ?? "uartix-templates", obj.data ?? d));
                  },
                )}
                {ioBlock(
                  t("set.exportControls"),
                  t("set.io.controls.tip"),
                  async () => {
                    await saveJson("uartix-controls", controlsStore.exportPages());
                    setMsg("控制画布已导出");
                  },
                  async () => {
                    const d = await loadJson<unknown>(["uartix-controls"]);
                    if (!d) return;
                    const obj = d as { kind?: string; data?: unknown };
                    setMsg(await importDispatch(obj.kind ?? "uartix-controls", obj.data ?? d));
                  },
                )}
                {ioBlock(
                  t("set.exportCommands"),
                  t("set.io.commands.tip"),
                  async () => {
                    await saveJson("uartix-commands", commandStore.exportGroups());
                    setMsg("命令库已导出");
                  },
                  async () => {
                    const d = await loadJson<unknown>(["uartix-commands"]);
                    if (!d) return;
                    const obj = d as { kind?: string; data?: unknown };
                    setMsg(await importDispatch(obj.kind ?? "uartix-commands", obj.data ?? d));
                  },
                )}
                <div className="set-io-hint">{t("set.ioHint")}</div>
              </>
            )}
            {tab === "about" && (
              <div className="set-about-rows">
                <div className="set-about-head">
                  <img src={appIcon} alt="Uartix+" width={56} height={56} />
                  <div>
                    <div className="set-about-name">Uartix+</div>
                    <div className="set-about-desc">可视化串口协议分析仪</div>
                  </div>
                </div>
                {row(t("set.version"), <span className="set-mono">{appVersion ?? "0.3.0"}</span>)}
                {row("作者", (
                  <button
                    className="author-link"
                    onClick={() => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl("http://larix.teuioe.cn/"))}
                    title="访问作者主页"
                  >
                    <img src={avatarUrl} alt="Tanix" width={22} height={22} className="author-avatar" />
                    <span className="author-name">Tanix</span>
                  </button>
                ))}
                {row("官网", (
                  <button className="btn" onClick={() => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl("https://larix.teuioe.cn/uartix-plus"))}>
                    larix.teuioe.cn/uartix-plus
                  </button>
                ))}
                {row(t("set.repo"), (
                  <button className="btn" onClick={() => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl("https://github.com/Tanixs/uartix-plus"))}>
                    github.com/Tanixs/uartix-plus
                  </button>
                ))}
                {row(t("set.license"), <span>MIT</span>)}
                {row(t("set.checkUpdate"), (
                  <div className="qk-fgroup">
                    <button
                      className="btn"
                      disabled={updState.status === "checking" || updState.status === "downloading"}
                      onClick={() => void runUpdateCheck()}
                    >
                      {updState.status === "checking" || updState.status === "downloading" ? "检查中…" : t("set.checkUpdate")}
                    </button>
                    {updState.msg && <span className="qk-fhint">{updState.msg}</span>}
                  </div>
                ), t("set.checkUpdate.tip"))}
              </div>
            )}
            {msg && <div className="set-msg">{msg}</div>}
          </div>
        </div>
        <div className="modal-foot">
          <span />
          <button className="btn primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

export { Section };
