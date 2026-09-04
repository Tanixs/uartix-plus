import { useEffect, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { THEME_LIST, useSettings, patch, type ThemeMode, type WorkspacePreset, AI_PRESETS, AI_FORMATS, type AiPreset, type AiFormat } from "./settingsStore";
import { useLayouts, removeLayout, renameLayout } from "./layoutsStore";
import { FULL_KIND, exportFullBackup, importDispatch } from "./transfer";
import { t, tx } from "../../i18n/strings";
import * as templateStore from "../protocol/templateStore";
import * as controlsStore from "../controls/controlsStore";
import * as commandStore from "../controls/commandStore";
import {
  clearAll,
  removeExt,
  setEnabled,
  setOpen,
  useExtensions,
  importAll,
  exportAll,
  EXT_TYPE_LABEL,
  PERM_LABEL,
  type AiExtension,
  type ExtType,
} from "../ai/extensionStore";
import { applyStyleExts, startScript, stopScript } from "../ai/extRuntime";
import { popWidgetToDesktop } from "../ai/widgetShell";
import { openExtPanel } from "../ai/extBus";
import { Section } from "../../shared/Section";
import { HelpHint } from "../../shared/HelpHint";
import { IconEye, IconEyeOff } from "../../shared/icons";
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

/** 权限短标签（行内展示；完整描述见 PERM_LABEL，hover 行可见） */
const PERM_SHORT: Record<string, string> = {
  css: "CSS",
  read: "读",
  send: "发",
  script: "JS",
};

const EXT_FILTERS: { key: "all" | ExtType; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "theme", label: EXT_TYPE_LABEL.theme },
  { key: "style", label: EXT_TYPE_LABEL.style },
  { key: "widget", label: EXT_TYPE_LABEL.widget },
  { key: "panel", label: EXT_TYPE_LABEL.panel },
  { key: "script", label: EXT_TYPE_LABEL.script },
];

/* ---------------- 扩展管理页 ---------------- */

function ExtPage({ notify }: { notify: (s: string) => void }) {
  const settings = useSettings();
  const es = useExtensions();
  const [filter, setFilter] = useState<"all" | ExtType>("all");

  const applyToggle = (ext: AiExtension, on: boolean) => {
    if (ext.type === "script" && on) {
      if (!settings.aiCreativity || !settings.aiScript) {
        notify("启用脚本需要：AI 服务 → 创造模式 + 允许行为脚本");
        return;
      }
      if (!confirm(`启用脚本「${ext.name}」将在主界面执行其 JS（高权限）。确定？`)) return;
    }
    setEnabled(ext.id, on);
    if (ext.type === "script") {
      if (on) startScript(ext);
      else stopScript(ext.id);
    } else if (ext.type === "theme" || ext.type === "style") {
      applyStyleExts();
    }
  };

  /** 批量启停：脚本不参与批量启用（需逐个确认），批量停用包含脚本 */
  const bulk = (on: boolean) => {
    for (const e of es.exts) {
      if (e.enabled === on) continue;
      if (e.type === "script" && on) continue;
      setEnabled(e.id, on);
    }
    if (es.exts.some((e) => e.type === "theme" || e.type === "style")) applyStyleExts();
    notify(on ? "已启用全部非脚本扩展" : "已停用全部扩展");
  };

  const popToDesktop = (ext: AiExtension) => {
    popWidgetToDesktop({ id: ext.id, name: ext.name, chrome: ext.chrome });
  };

  const doExport = async () => {
    const path = await save({
      title: "导出 AI 扩展",
      defaultPath: "uartix-extensions.json",
      filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      await invoke("save_text_file", { path, content: exportAll() });
      notify("扩展已导出");
    } catch (e) {
      notify(`导出失败：${String(e).slice(0, 80)}`);
    }
  };

  const doImport = async () => {
    const path = await open({
      title: "导入 AI 扩展",
      multiple: false,
      filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      const content = await invoke<string>("read_text_file", { path });
      notify(importAll(content).msg);
    } catch (e) {
      notify(`导入失败：${String(e).slice(0, 80)}`);
    }
  };

  const list = filter === "all" ? es.exts : es.exts.filter((e) => e.type === filter);
  const countOf = (k: "all" | ExtType) =>
    k === "all" ? es.exts.length : es.exts.filter((x) => x.type === k).length;

  return (
    <>
      <div className="ext-toolbar">
        <div className="ext-chips">
          {EXT_FILTERS.map((f) => (
            <button
              key={f.key}
              className={filter === f.key ? "on" : ""}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <em>{countOf(f.key)}</em>
            </button>
          ))}
        </div>
        <div className="ext-ops">
          <button className="btn" onClick={() => bulk(true)} disabled={!es.exts.length}>
            全部启用
          </button>
          <button className="btn" onClick={() => bulk(false)} disabled={!es.exts.length}>
            全部停用
          </button>
          <button className="btn" onClick={() => void doImport()}>导入</button>
          <button className="btn" onClick={() => void doExport()}>导出</button>
        </div>
      </div>
      {!settings.aiCreativity && (
        <div className="ext-warn">
          创造模式未开启：无法安装新扩展（已装扩展仍可使用）。到「AI 服务」页开启创造模式。
        </div>
      )}
      {list.length === 0 ? (
        <div className="ext-empty">
          {es.exts.length === 0
            ? "暂无扩展。开启创造模式后，在 AI 助手输入「做一个 XX 挂件/主题/面板」即可安装；也可在此导入他人分享的扩展包（uartix-extensions.json）。"
            : "该类型下暂无扩展"}
        </div>
      ) : (
        <div className="ext-list">
          {list.map((e) => (
            <div key={e.id} className={`ext-row${e.enabled ? " on" : ""}`} title={e.desc || e.name}>
              <label className="set-switch" title={e.enabled ? "停用" : "启用"}>
                <input
                  type="checkbox"
                  checked={e.enabled}
                  onChange={(ev) => applyToggle(e, ev.target.checked)}
                />
                <span />
              </label>
              <div className="ext-info">
                <div className="ext-name-line">
                  <span className="ai-ext-badge">{EXT_TYPE_LABEL[e.type]}</span>
                  <span className="ext-name">{e.name}</span>
                  <span className="ext-ver">v{e.version}</span>
                  {e.type === "script" && <span className="ext-risk">高权限</span>}
                  {e.type === "script" && e.enabled && (
                    <span className="ai-ext-running">运行中</span>
                  )}
                </div>
                {e.desc && <div className="ext-desc">{e.desc}</div>}
                <div
                  className="ext-perms"
                  title={`权限：${e.perms.map((p) => PERM_LABEL[p]).join("；")}`}
                >
                  {e.perms.map((p) => (
                    <span key={p} className="ext-perm">
                      {PERM_SHORT[p]}
                    </span>
                  ))}
                </div>
              </div>
              <div className="ai-widget-ops">
                {e.type === "widget" && (
                  <>
                    <button
                      className="btn"
                      onClick={() => setOpen(e.id, !es.openIds.includes(e.id))}
                    >
                      {es.openIds.includes(e.id) ? "收起" : "打开"}
                    </button>
                    <button className="btn" onClick={() => void popToDesktop(e)}>
                      桌面
                    </button>
                  </>
                )}
                {e.type === "panel" && (
                  <button className="btn" onClick={() => openExtPanel(e.id)}>
                    加入工作区
                  </button>
                )}
                <button
                  className="btn danger-btn"
                  onClick={() => {
                    if (!confirm(`删除扩展「${e.name}」？不可恢复。`)) return;
                    if (e.type === "script") stopScript(e.id);
                    removeExt(e.id);
                    if (e.type === "theme" || e.type === "style") applyStyleExts();
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="set-danger">
        <div className="set-danger-head">危险操作</div>
        <div className="set-danger-body">
          <button
            className="btn danger-btn"
            onClick={() => {
              if (!confirm("清空全部扩展？（主题/样式/挂件/面板/脚本；协议/画布/命令不受影响）")) return;
              for (const e of es.exts) if (e.type === "script") stopScript(e.id);
              clearAll();
              applyStyleExts();
              notify("已清空全部扩展");
            }}
          >
            清空全部扩展
          </button>
          <span className="set-danger-note">
            移除全部扩展并停用其效果；协议模板、控制画布、命令库不受影响。
          </span>
        </div>
      </div>
    </>
  );
}

export function SettingsModal({ onClose, onResetLayout, initialTab, onApplyLayout, onSaveLayout }: { onClose: () => void; onResetLayout: (p: WorkspacePreset) => void; initialTab?: string; onApplyLayout: (id: string) => boolean; onSaveLayout: (name: string) => boolean }) {
  const settings = useSettings();
  const layouts = useLayouts();
  const [layoutName, setLayoutName] = useState("");
  const [tab, setTab] = useState(initialTab ?? "general");
  const [msg, setMsg] = useState("");
  const [showKey, setShowKey] = useState(false);
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
    { key: "ai", label: t("set.ai") },
    { key: "ext", label: t("set.ext") },
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
                {row(t("set.layouts.save"), (
                  <div className="qk-fgroup">
                    <input
                      className="input"
                      style={{ width: 160 }}
                      placeholder={t("set.layouts.namePh")}
                      maxLength={24}
                      value={layoutName}
                      onChange={(e) => setLayoutName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && layoutName.trim()) {
                          if (onSaveLayout(layoutName)) {
                            setLayoutName("");
                            setMsg(t("set.layouts.saved"));
                          }
                        }
                      }}
                    />
                    <button
                      className="btn primary"
                      disabled={!layoutName.trim()}
                      onClick={() => {
                        if (onSaveLayout(layoutName)) {
                          setLayoutName("");
                          setMsg(t("set.layouts.saved"));
                        } else {
                          setMsg(t("set.layouts.saveFail"));
                        }
                      }}
                    >
                      {t("set.layouts.save")}
                    </button>
                  </div>
                ), t("set.layouts.save.tip"))}
                {layouts.slots.length > 0 && row(t("set.layouts.title"), (
                  <div className="preset-grid">
                    {layouts.slots.map((s) => (
                      <div
                        key={s.id}
                        className={`preset-card layout-slot${s.auto ? " auto" : ""}`}
                        title={s.auto ? t("set.layouts.autoTip") : t("set.layouts.applyTip")}
                        onClick={() => {
                          if (onApplyLayout(s.id)) setMsg(`${t("set.layouts.applied")}${s.name}`);
                          else setMsg(t("set.layouts.applyFail"));
                        }}
                      >
                        <span className="preset-name">{s.name}</span>
                        <span className="preset-desc">{new Date(s.ts).toLocaleString()}</span>
                        {!s.auto && (
                          <span className="layout-slot-ops">
                            <button
                              className="layout-op-btn"
                              title="重命名"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                const nn = prompt("新名称", s.name);
                                if (nn && nn.trim()) renameLayout(s.id, nn);
                              }}
                            >
                              ✎
                            </button>
                            <button
                              className="layout-op-btn danger"
                              title="删除"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                if (confirm(`删除布局「${s.name}」？`)) removeLayout(s.id);
                              }}
                            >
                              ×
                            </button>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ), t("set.layouts.tip"))}
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
            {tab === "ai" && (
              <>
                <div className="set-group-title">{t("set.ai.grp.preset")}</div>
                {row(t("set.ai.preset"), (
                  <select
                    className="input"
                    value={settings.aiPreset}
                    onChange={(e) => {
                      const p = e.target.value as AiPreset;
                      patch({
                        aiPreset: p,
                        aiBaseUrl: AI_PRESETS[p].baseUrl,
                        aiModel: AI_PRESETS[p].model,
                        aiFormat: p === "anthropic" ? "anthropic" : "chat",
                      });
                    }}
                  >
                    {(Object.keys(AI_PRESETS) as AiPreset[]).map((k) => (
                      <option key={k} value={k}>
                        {AI_PRESETS[k].label}
                      </option>
                    ))}
                  </select>
                ), t("set.ai.preset.tip"))}
                <div className="set-group-title">{t("set.ai.grp.model")}</div>
                {row(t("set.ai.key"), (
                  <div className="ai-key-wrap">
                    <input
                      className="input"
                      style={{ width: 280 }}
                      type={showKey ? "text" : "password"}
                      value={settings.aiApiKey}
                      placeholder={settings.aiPreset === "ollama" ? "本地 Ollama 无需 Key" : "sk-…"}
                      onChange={(e) => patch({ aiApiKey: e.target.value })}
                    />
                    <button
                      className="ai-key-eye"
                      title={showKey ? "隐藏 API Key" : "显示 API Key"}
                      onClick={() => setShowKey((v) => !v)}
                    >
                      {showKey ? <IconEyeOff /> : <IconEye />}
                    </button>
                  </div>
                ), t("set.ai.key.tip"))}
                {row(t("set.ai.model"), (
                  <input
                    className="input"
                    style={{ width: 280 }}
                    value={settings.aiModel}
                    onChange={(e) => patch({ aiModel: e.target.value })}
                  />
                ), t("set.ai.model.tip"))}
                {row(t("set.ai.baseUrl"), (
                  <input
                    className="input"
                    style={{ width: 280 }}
                    value={settings.aiBaseUrl}
                    placeholder="https://api.deepseek.com"
                    onChange={(e) => patch({ aiBaseUrl: e.target.value })}
                  />
                ), t("set.ai.baseUrl.tip"))}
                {row(t("set.ai.format"), (
                  <select
                    className="input"
                    value={settings.aiFormat}
                    onChange={(e) => patch({ aiFormat: e.target.value as AiFormat })}
                  >
                    {AI_FORMATS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                ), t("set.ai.format.tip"))}
                {row(t("set.ai.temp"), (
                  <input
                    type="number"
                    className="input"
                    style={{ width: 72 }}
                    min={0}
                    max={2}
                    step={0.1}
                    value={settings.aiTemperature}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      patch({ aiTemperature: Math.max(0, Math.min(2, v)) });
                    }}
                  />
                ), t("set.ai.temp.tip"))}
                {row(t("set.ai.thinking"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.showThinking}
                      onChange={(e) => patch({ showThinking: e.target.checked })}
                    />
                    <span />
                  </label>
                ), t("set.ai.thinking.tip"))}
                <details className="set-coll">
                  <summary>{t("set.ai.grp.net")}</summary>
                  <div className="set-coll-body">
                    {row(t("set.ai.proxy"), (
                      <input
                        className="input"
                        style={{ width: 280 }}
                        value={settings.aiProxy}
                        placeholder="http://127.0.0.1:7890（留空 = 跟随系统）"
                        onChange={(e) => patch({ aiProxy: e.target.value })}
                      />
                    ), t("set.ai.proxy.tip"))}
                    {row(t("set.ai.noProxy"), (
                      <input
                        className="input"
                        style={{ width: 280 }}
                        value={settings.aiNoProxy}
                        placeholder="localhost,127.0.0.1,.cn,*.lan"
                        onChange={(e) => patch({ aiNoProxy: e.target.value })}
                      />
                    ), t("set.ai.noProxy.tip"))}
                  </div>
                </details>
                <div className="set-group-title">{t("set.ai.grp.creative")}</div>
                {row(t("set.ai.creative"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.aiCreativity}
                      onChange={(e) => patch({ aiCreativity: e.target.checked })}
                    />
                    <span />
                  </label>
                ), t("set.ai.creative.tip"))}
                {settings.aiCreativity && row(t("set.ai.widgetSend"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.aiWidgetSend}
                      onChange={(e) => patch({ aiWidgetSend: e.target.checked })}
                    />
                    <span />
                  </label>
                ), t("set.ai.widgetSend.tip"))}
                {settings.aiCreativity && row(t("set.ai.script"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.aiScript}
                      onChange={(e) => patch({ aiScript: e.target.checked })}
                    />
                    <span />
                  </label>
                ), t("set.ai.script.tip"))}
                <div className="set-row">
                  <label>
                    {t("set.ai.manage")}
                    <HelpHint text={t("set.ai.manage.tip")} />
                  </label>
                  <div className="set-ctl">
                    <button className="btn primary" onClick={() => setTab("ext")}>
                      {t("set.ai.manageBtn")}
                    </button>
                  </div>
                </div>
                <div className="set-danger">
                  <div className="set-danger-head">{t("set.ai.danger")}</div>
                  <div className="set-danger-body">
                    <button
                      className="btn danger-btn"
                      onClick={() => {
                        if (!confirm("清除全部 AI 扩展？（主题/样式/小部件/面板/脚本；协议/画布/命令不受影响）")) return;
                        clearAll();
                        applyStyleExts();
                        setMsg("已重置 AI 扩展");
                      }}
                    >
                      {t("set.ai.reset")}
                    </button>
                    <button
                      className="btn danger-btn"
                      onClick={() => {
                        if (!confirm("恢复出厂将清除：协议模板、控制画布、命令库、变量、全部设置与 AI 扩展，且不可恢复。确定继续？")) return;
                        const kill: string[] = [];
                        for (let i = 0; i < localStorage.length; i++) {
                          const k = localStorage.key(i);
                          if (k?.startsWith("vs.")) kill.push(k);
                        }
                        kill.forEach((k) => localStorage.removeItem(k));
                        location.reload();
                      }}
                    >
                      {t("set.ai.factory")}
                    </button>
                    <span className="set-danger-note">{t("set.ai.reset.tip")}</span>
                  </div>
                </div>
                <div className="set-io-hint">{t("set.ai.privacy")}</div>
              </>
            )}
            {tab === "ext" && <ExtPage notify={setMsg} />}
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
                    <div className="set-about-desc">
                      {tx("嵌入式可视化上位机", "Visual host-computer suite for embedded systems")}
                    </div>
                  </div>
                </div>
                <p className="set-about-intro">
                  {tx(
                    "Uartix+ 是一台跑在电脑上的上位机。向下，它连着单片机、惯导、云台、机器人这些下位机；向上，它把一串串看不懂的原始字节变成结构、数值、曲线和画面，再把你的操作回写成设备能够接受的指令。",
                    "Uartix+ is a host computer running on your PC. Downward it talks to MCUs, IMUs, gimbots and robots; upward it turns raw bytes into structure, numbers, curves and pictures, then writes your actions back as commands the device accepts.",
                  )}
                </p>
                <p className="set-about-intro">
                  {tx(
                    "它不是只会收发字符的串口助手。协议无需编写解析代码——在数据流上框选字节即可定义帧结构与字段含义；界面无需编写界面代码——拖拽控件就能拼出专属调试台。连接、校验、测量、可视化、脚本自动化与数据导出，在同一处完成闭环。",
                    "It is far more than a serial terminal that echoes characters. Protocols need no parser code: select bytes on the stream to define the frame layout and what each field means. Interfaces need no UI code: drag widgets together into a bench of your own. Connecting, checksums, measurement, visualisation, scripting and export close the loop in one place.",
                  )}
                </p>
                <p className="set-about-intro">
                  {tx(
                    "自 v0.3.6 起内置 AI 助手：说出需求，它便能生成协议模板、控制卡片、停靠面板乃至无边框悬浮小部件，并直接替你执行操作。Rust 内核与二进制数据通道，让数十万帧的长时间采集依旧流畅。",
                    "Since v0.3.6 a built-in AI assistant turns requests into protocol templates, control cards, dockable panels and even borderless floating widgets, and carries out operations on your behalf. A Rust core over a binary data channel keeps hundreds of thousands of frames of long-running capture smooth.",
                  )}
                </p>
                {row(t("set.version"), <span className="set-mono">{appVersion}</span>)}
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
