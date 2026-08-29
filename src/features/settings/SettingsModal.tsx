import { useEffect, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useSettings, patch, type WorkspacePreset } from "./settingsStore";
import { t } from "../../i18n/strings";
import * as templateStore from "../protocol/templateStore";
import * as controlsStore from "../controls/controlsStore";
import * as commandStore from "../controls/commandStore";
import { Section } from "../../shared/Section";
import appIcon from "../../assets/icon.svg";

const PRESETS: { key: WorkspacePreset; label: string }[] = [
  { key: "proto", label: t("set.preset.proto") },
  { key: "analyze", label: t("set.preset.analyze") },
  { key: "attitude", label: t("set.preset.attitude") },
  { key: "console", label: t("set.preset.console") },
];

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
    { key: "diagnostics", label: t("set.diagnostics") },
    { key: "io", label: t("set.io") },
    { key: "about", label: t("set.about") },
  ];

  const row = (label: string, node: React.ReactNode) => (
    <div className="set-row">
      <label>{label}</label>
      <div className="set-ctl">{node}</div>
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
                  <div className="set-seg">
                    {(["dark", "light"] as const).map((th) => (
                      <button key={th} className={settings.theme === th ? "on" : ""} onClick={() => patch({ theme: th })}>
                        {th === "dark" ? t("set.theme.dark") : t("set.theme.light")}
                      </button>
                    ))}
                  </div>
                ))}
                {row(t("set.zoom"), (
                  <div className="set-seg">
                    {[90, 100, 110, 125].map((z) => (
                      <button key={z} className={settings.zoom === z ? "on" : ""} onClick={() => patch({ zoom: z })}>
                        {z}%
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
            {tab === "workspace" && (
              <>
                {row(t("set.preset"), (
                  <div className="set-seg col">
                    {PRESETS.map((p) => (
                      <button
                        key={p.key}
                        className={settings.workspace === p.key ? "on" : ""}
                        onClick={() => {
                          patch({ workspace: p.key });
                          onResetLayout(p.key);
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                ))}
                {row("", <button className="btn" onClick={() => onResetLayout(settings.workspace)}>{t("set.resetLayout")}</button>)}
                {row("控制画板格尺寸", (
                  <div className="set-seg">
                    {([48, 60, 72, 90, 110] as const).map((c) => (
                      <button key={c} className={settings.cellSize === c ? "on" : ""} onClick={() => patch({ cellSize: c })}>
                        {c === 48 ? "48 微型" : c === 60 ? "60 极小" : c === 72 ? "72 紧凑" : c === 90 ? "90 标准" : "110 宽松"}
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
            {tab === "data" && (
              row(t("set.decimals"), (
                <div className="form-row">
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
                  <span className="form-hint">0~6 位；字段图例上的「N位」按钮可循环切换，与此处实时同步</span>
                </div>
              ))
            )}
            {tab === "diagnostics" && (
              row(t("set.perfHud"), (
                <label className="set-switch">
                  <input
                    type="checkbox"
                    checked={settings.perfHud}
                    onChange={(e) => patch({ perfHud: e.target.checked })}
                  />
                  <span />
                </label>
              ))
            )}
            {tab === "io" && (
              <>
                <div className="set-io-block">
                  <div className="set-io-label">{t("set.exportTemplates")}</div>
                  <div className="set-io-actions">
                    <button
                      className="btn"
                      onClick={async () => {
                        const d = templateStore.exportTemplatesWithMeta();
                        await saveJson("uartix-templates", d);
                        setMsg("模板已导出");
                      }}
                    >
                      {t("set.export")}
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const d = await loadJson<{ templates: Parameters<typeof templateStore.importTemplates>[0]; groups?: Record<string, { name: string }> }>(["uartix-templates"]);
                        if (!d) return;
                        if (d.groups) templateStore.importGroupsMeta(d.groups);
                        templateStore.importTemplates(d.templates);
                        setMsg(`已导入 ${d.templates.length} 个模板（副本）`);
                      }}
                    >
                      {t("set.import")}
                    </button>
                  </div>
                </div>
                <div className="set-io-block">
                  <div className="set-io-label">{t("set.exportControls")}</div>
                  <div className="set-io-actions">
                    <button
                      className="btn"
                      onClick={async () => {
                        await saveJson("uartix-controls", controlsStore.exportPages());
                        setMsg("控制画布已导出");
                      }}
                    >
                      {t("set.export")}
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const d = await loadJson<Parameters<typeof controlsStore.importPage>[0] & { name?: string }>(["uartix-controls"]);
                        if (!d) return;
                        const arr = Array.isArray(d) ? d[0] : d;
                        const id = controlsStore.importPage(arr);
                        setMsg(`已导入为新控制页（${(arr.cards ?? []).length} 卡片）`);
                        void id;
                      }}
                    >
                      {t("set.import")}
                    </button>
                  </div>
                </div>
                <div className="set-io-block">
                  <div className="set-io-label">{t("set.exportCommands")}</div>
                  <div className="set-io-actions">
                    <button
                      className="btn"
                      onClick={async () => {
                        await saveJson("uartix-commands", commandStore.exportGroups());
                        setMsg("命令库已导出");
                      }}
                    >
                      {t("set.export")}
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const d = await loadJson<Parameters<typeof commandStore.importGroupsMerge>[0]>(["uartix-commands"]);
                        if (!d) return;
                        commandStore.importGroupsMerge(d);
                        setMsg("命令库已合并导入");
                      }}
                    >
                      {t("set.import")}
                    </button>
                  </div>
                </div>
                <div className="set-io-hint">{t("set.ioHint")}</div>
              </>
            )}
            {tab === "about" && (
              <>
                <div className="set-about-head">
                  <img src={appIcon} alt="Uartix+" width={56} height={56} />
                  <div>
                    <div className="set-about-name">Uartix+</div>
                    <div className="set-about-desc">可视化串口协议分析仪</div>
                  </div>
                </div>
                {row(t("set.version"), <span className="set-mono">{appVersion ? `${appVersion} (M7)` : "0.2.0 (M7)"}</span>)}
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
                {row("", (
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
                ))}
              </>
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
