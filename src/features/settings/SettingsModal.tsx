import { useEffect, useState, useSyncExternalStore } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { THEME_LIST, useSettings, patch, type ThemeMode, type WorkspacePreset, AI_PRESETS, AI_FORMATS, type AiPreset, type AiFormat } from "./settingsStore";
import { useLayouts, removeLayout, renameLayout } from "./layoutsStore";
import { FULL_KIND, exportFullBackup, importDispatch } from "./transfer";
import { t, tx } from "../../i18n/strings";
import { alertDialog, confirmDialog } from "../../shared/Dialog";
import * as templateStore from "../protocol/templateStore";
import * as controlsStore from "../controls/controlsStore";
import * as commandStore from "../controls/commandStore";
import { PluginManagerBody } from "../plugins/PluginLibraryDialog";
import * as sentinelStore from "../sentinel/sentinelStore";
import * as timeCursor from "../analysis/timeCursorStore";
import * as mcpServer from "../mcp/mcpServer";
import { jobCenter } from "../mcp/jobExecutor";
import { JobDetails } from "../mcp/JobDetails";
import { OperatorGenBlock } from "../operator/OperatorGen";
import { mcpServerConfig } from "../mcp/mcpTools";
import { imageStoreStats, setImageLimits, clearAllImages } from "../ai/imageStore";
import { toast } from "../ai/extRuntime";
import { subscribe as subExts, getSnapshot as getExtSnap } from "../ai/extensionStore";
import { cleanBaseUrl } from "../agent/provider";
import { aiStyleFootprint, clearAiStyleLayers, subscribeAiStyle } from "../agent/aiStyleLayers";
import { appearanceDefaults, appearanceDefaultLabels } from "./settingsSchema";
import { Section } from "../../shared/Section";
import { HelpHint } from "../../shared/HelpHint";
import { IconEye, IconEyeOff, IconEdit, IconTrash } from "../../shared/icons";
import appIcon from "../../assets/icon.svg";
import avatarUrl from "../../assets/avatar.png";

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const PRESETS: { key: WorkspacePreset; label: string; desc: string }[] = [
  { key: "proto", label: t("set.preset.proto"), desc: "画布 + 属性 + Hex" },
  { key: "analyze", label: t("set.preset.analyze"), desc: "表格 + 曲线 + 频谱" },
  { key: "attitude", label: t("set.preset.attitude"), desc: "3D 姿态 + 曲线" },
  { key: "console", label: t("set.preset.console"), desc: "仅控制台" },
  { key: "video", label: t("set.preset.video"), desc: "图传 + 控制画板" },
  { key: "calib", label: t("set.preset.calib"), desc: "3D 轨迹 + 曲线观察" },
  { key: "auto", label: t("set.preset.auto"), desc: "编排器 + 序列器 + 哨兵" },
  { key: "modbus", label: t("set.preset.modbus"), desc: "工作台 + Hex + 控制台" },
  { key: "vdev", label: t("set.preset.vdev"), desc: "工坊 + 曲线 + 画布" },
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
  let content: string;
  try {
    content = await invoke<string>("read_text_file", { path });
  } catch (e) {
    await alertDialog(`读取失败: ${e}`);
    return null;
  }
  try {
    const obj = JSON.parse(content) as { kind?: string; data?: T };
    if (!obj.kind || !kinds.includes(obj.kind) || obj.data === undefined) {
      await alertDialog("文件格式不正确：kind 不匹配或缺少 data");
      return null;
    }
    return obj.data;
  } catch (e) {
    await alertDialog(`JSON 解析失败: ${e}`);
    return null;
  }
}

/* ---------------- 插件管理页（旧扩展管理已废弃，内嵌插件库主体） ---------------- */

function ExtPage() {
  return (
    <div className="set-plg-embed">
      <PluginManagerBody />
    </div>
  );
}

/* ---------------- AI 服务：测试连接（E2） ---------------- */

/** 按 Rust ai_agent_turn 的错误文本分类：密钥 / 网络 / 其他 */
function classifyConnError(e: string): string {
  if (/HTTP 401|HTTP 403|Unauthorized|Forbidden/i.test(e)) return "密钥无效";
  if (/连接失败|中断|超时|timeout|timed out|Could not connect|dns|error sending request|invalid URL/i.test(e))
    return "无法连接服务端";
  return e.slice(0, 80);
}

function AiConnTestRow() {
  const settings = useSettings();
  const [st, setSt] = useState<{ status: "idle" | "testing" | "ok" | "err"; msg: string }>({
    status: "idle",
    msg: "",
  });
  const configured =
    settings.aiPreset === "ollama" ? settings.aiBaseUrl.trim().length > 0 : settings.aiApiKey.trim().length > 0 && settings.aiBaseUrl.trim().length > 0;
  const run = async () => {
    setSt({ status: "testing", msg: "" });
    const t0 = Date.now();
    try {
      await invoke("ai_agent_turn", {
        reqId: crypto.randomUUID(),
        baseUrl: cleanBaseUrl(settings.aiBaseUrl),
        apiKey: settings.aiApiKey,
        model: settings.aiModel,
        format: settings.aiFormat,
        proxy: settings.aiProxy || null,
        noProxy: settings.aiNoProxy || null,
        messages: [{ role: "user", content: "ping" }],
        tools: [],
      });
      setSt({ status: "ok", msg: `连接正常 · ${Date.now() - t0}ms` });
    } catch (e) {
      setSt({ status: "err", msg: classifyConnError(String(e)) });
    }
  };
  return (
    <div className="set-row">
      <label>
        {tx("测试连接", "Test connection")}
        <HelpHint text={tx("向当前配置的模型服务发一条最小请求（ping），验证地址/密钥/网络是否可用；不消耗多少额度", "Sends one minimal request (ping) to the configured model endpoint to verify URL / key / network; costs almost no quota")} />
      </label>
      <div className="set-ctl set-conn-test">
        <button
          className="btn"
          disabled={!configured || st.status === "testing"}
          title={configured ? tx("发一条 ping 请求验证配置", "Send a ping request to verify the config") : tx("请先填写 Base URL 与 API Key", "Fill in Base URL and API Key first")}
          onClick={() => void run()}
        >
          {tx("测试连接", "Test connection")}
        </button>
        {st.status === "testing" && <span className="set-conn-note">{tx("测试中…", "Testing…")}</span>}
        {st.status === "ok" && <span className="set-conn-note ok">{st.msg}</span>}
        {st.status === "err" && <span className="set-conn-note err">{st.msg}</span>}
      </div>
    </div>
  );
}

export function SettingsModal({ onClose, onResetLayout, initialTab, onApplyLayout, onSaveLayout }: { onClose: () => void; onResetLayout: (p: WorkspacePreset) => void; initialTab?: string; onApplyLayout: (id: string) => boolean; onSaveLayout: (name: string) => boolean }) {
  const settings = useSettings();
  const timeLinked = useSyncExternalStore(timeCursor.subscribe, () => timeCursor.getSnapshot().linked);
  const snt = useSyncExternalStore(sentinelStore.subscribe, sentinelStore.getSnapshot);
  // P91 D5：插件主题与内置主题的互认——内联层恒压过样式表，过去选择器显示"自己选中"
  // 而界面其实被插件覆盖，且切内置主题不会重跑样式层。现在把覆盖态显出来并给一键停用。
  const extSnap = useSyncExternalStore(subExts, getExtSnap);
  const themeLayers = extSnap.exts.filter((e) => e.enabled && e.type === "theme");
  const disableThemeLayers = async () => {
    const { setEnabled } = await import("../plugins/pluginStore");
    const refs = [...new Set(themeLayers.map((e) => e.pluginRef).filter(Boolean))] as string[];
    if (!refs.length) {
      toast("这些主题层不是插件提供的，请到 AI 助手 → 插件库处理");
      return;
    }
    const failed: string[] = [];
    for (const id of refs) {
      const r = setEnabled(id, false);
      if (!r.ok) failed.push(`${id}：${r.msg}`);
    }
    toast(failed.length ? `部分停用失败：${failed.join("；")}` : `已停用 ${refs.length} 个插件主题，界面回到内置主题`);
  };
  /**
   * P98-M1 外观来源面板。
   * 用户报的"AI 改了圆角，停用和卸载都撤不回去"真因在这里：AI 的 token 覆盖层与组件样式层
   * **都不归插件生命周期管**（`removeProjections` 只清扩展投影），而旧 UI 那一行的显示条件是
   * `themeLayers.length > 0`——只数插件主题层 ⇒ 罪魁祸首是 AI 层时，那一行按定义不会出现。
   */
  const [aiStyle, setAiStyle] = useState(() => aiStyleFootprint());
  useEffect(() => {
    const off = subscribeAiStyle(() => setAiStyle(aiStyleFootprint()));
    return off;
  }, []);
  const clearAi = () => {
    const r = clearAiStyleLayers();
    setAiStyle(aiStyleFootprint());
    toast(r.tokens || r.layers
      ? `已清除 AI 的外观改动：${r.tokens} 项 token 覆盖 + ${r.layers} 层组件样式。你的设置与已存插件不受影响`
      : "AI 当前没有留下临时外观改动");
  };
  const restoreAppearanceDefaults = async () => {
    const pluginThemeCount = new Set(themeLayers.map((e) => e.pluginRef).filter(Boolean)).size;
    const willDo = [
      aiStyle.tokens ? `清除 AI 的 ${aiStyle.tokens} 项 token 覆盖` : "",
      aiStyle.layers.length ? `清除 AI 的 ${aiStyle.layers.length} 层组件样式` : "",
      pluginThemeCount ? `停用 ${pluginThemeCount} 个插件主题` : "",
      `外观设置回默认（${appearanceDefaultLabels().join("、")}）`,
    ].filter(Boolean);
    const ok = await confirmDialog({
      message: `恢复外观默认将执行：\n· ${willDo.join("\n· ")}\n\n注意：这一项**会把你自己在设置里选的主题/缩放/精度等一并回默认**。\n只想撤掉 AI 动过的，请用上面的「清除 AI 的全部临时改动」。\n协议模板、命令库、插件库等其他数据不受影响。`,
      danger: true,
      okLabel: "恢复外观默认",
    });
    if (!ok) return;
    clearAiStyleLayers();
    if (pluginThemeCount) {
      const { setEnabled } = await import("../plugins/pluginStore");
      for (const id of [...new Set(themeLayers.map((e) => e.pluginRef).filter(Boolean))] as string[]) {
        void setEnabled(id, false);
      }
    }
    patch(appearanceDefaults());
    setAiStyle(aiStyleFootprint());
    toast("外观已恢复默认（其他数据未动）");
  };
  const layouts = useLayouts();
  const [layoutName, setLayoutName] = useState("");
  const [tab, setTab] = useState(initialTab ?? "general");
  const [msg, setMsg] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [mcpCliPath, setMcpCliPath] = useState(() => localStorage.getItem("vs.mcpCliPath") ?? "");
  const mcpSt = useSyncExternalStore(mcpServer.subscribe, mcpServer.getStatus);
  const jobSt = useSyncExternalStore(jobCenter.subscribe, jobCenter.getSnapshot);
  const [appVersion, setAppVersion] = useState("");
  const [storage, setStorage] = useState<{ local: number; idb: { count: number; bytes: number } | null; quota: { usage: number; quota: number } | null } | null>(null);
  const [updState, setUpdState] = useState<{
    status: "idle" | "checking" | "downloading" | "latest" | "ready" | "error";
    msg: string;
  }>({ status: "idle", msg: "" });

  // 存储占用：进「数据」页时采集（localStorage 全 key + AI 图片 IDB + 浏览器配额）
  useEffect(() => {
    if (tab !== "data") return;
    let alive = true;
    const collect = async () => {
      let local = 0;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) local += k.length + (localStorage.getItem(k)?.length ?? 0);
        }
      } catch {
        /* 忽略 */
      }
      const [idb, est] = await Promise.all([
        imageStoreStats().catch(() => null),
        navigator.storage?.estimate?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (alive) setStorage({ local: local * 2, idb, quota: est ? { usage: est.usage ?? 0, quota: est.quota ?? 0 } : null });
    };
    void collect();
    return () => {
      alive = false;
    };
  }, [tab]);

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
    { key: "monitor", label: tx("监测", "Monitoring") },
    { key: "ai", label: t("set.ai") },
    { key: "ext", label: t("set.ext") },
    { key: "mcp", label: `${tx("集成", "Integration")}${jobSt.jobs.some((j) => ["queued", "running", "cancel_requested"].includes(j.state)) ? ` (${jobSt.jobs.filter((j) => ["queued", "running", "cancel_requested"].includes(j.state)).length})` : ""}` },
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
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={onClose}>
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
                {row("当前外观被谁改了", (
                  <div className="set-apr">
                    <ul className="set-apr-list">
                      <li>
                        <span className="set-apr-name">内置主题</span>
                        <span className="set-apr-val">{t(`set.theme.${settings.theme}`)}</span>
                        <span className="set-apr-note">样式表，切换只改它</span>
                      </li>
                      <li className={themeLayers.length ? "on" : ""}>
                        <span className="set-apr-name">插件主题层</span>
                        <span className="set-apr-val">{themeLayers.length ? `${themeLayers.length} 个生效` : "无"}</span>
                        {themeLayers.length > 0 && (
                          <button className="btn sm" onClick={() => void disableThemeLayers()}>停用</button>
                        )}
                      </li>
                      <li className={aiStyle.tokens ? "on ai" : ""}>
                        <span className="set-apr-name">AI 临时 token 覆盖</span>
                        <span className="set-apr-val">{aiStyle.tokens ? `${aiStyle.tokens} 项` : "无"}</span>
                        {aiStyle.tokens > 0 && (
                          <span className="set-apr-note">{aiStyle.tokenNames.slice(0, 4).join(" ")}{aiStyle.tokenNames.length > 4 ? " …" : ""}</span>
                        )}
                      </li>
                      <li className={aiStyle.layers.length ? "on ai" : ""}>
                        <span className="set-apr-name">AI 组件样式层</span>
                        <span className="set-apr-val">{aiStyle.layers.length ? `${aiStyle.layers.length} 层` : "无"}</span>
                        {aiStyle.layers.length > 0 && (
                          <span className="set-apr-note">{aiStyle.layers.map((l) => l.name).slice(0, 3).join("、")}{aiStyle.layers.length > 3 ? " …" : ""}</span>
                        )}
                      </li>
                    </ul>
                    <div className="set-apr-ops">
                      <button className="btn sm primary" disabled={aiStyle.clean} onClick={clearAi}>
                        清除 AI 的全部临时改动
                      </button>
                      <button className="btn sm danger" onClick={() => void restoreAppearanceDefaults()}>
                        恢复外观默认
                      </button>
                    </div>
                    <p className="set-apr-hint">
                      后两层是 AI 本次会话改的（圆角/尺寸/阴影/临时主题都在这里），<b>不落盘、也不归插件停用管</b>——
                      所以停用或卸载插件撤不掉它们，用上面第一个按钮。第二个会连你自己选的主题与缩放一起回默认。
                    </p>
                  </div>
                ), "从上到下层层覆盖：内置主题 < 插件主题 < AI 临时层。哪一层有内容，就说明当前界面是被它改的")}
                {row(t("set.zoom"), (
                  <div className="set-seg">
                    {[90, 100, 110, 125].map((z) => (
                      <button key={z} className={settings.zoom === z ? "on" : ""} onClick={() => patch({ zoom: z })}>
                        {z}%
                      </button>
                    ))}
                  </div>
                ), t("set.zoom.tip"))}
                {row(tx("减弱动效", "Reduce motion"), (
                  <label className="set-switch">
                    <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => patch({ reduceMotion: e.target.checked })} />
                    <span />
                  </label>
                ), tx("关闭呼吸灯、闪烁与过渡动画（不依赖系统设置）；低配设备或动画敏感场景可开", "Turn off pulsing, blinking and transitions regardless of the OS setting; useful on weak hardware or motion sensitivity"))}
                {row(tx("跨面板时间联动", "Link panel time cursors"), (
                  <label className="set-switch">
                    <input type="checkbox" aria-label={tx("跨面板时间联动", "Link panel time cursors")} checked={timeLinked} onChange={(e) => timeCursor.setLinked(e.target.checked)} />
                    <span />
                  </label>
                ), tx("同步 2D 时间横轴与 3D 的定位游标；关闭后不互相定位，但回放跳转仍会移动实际播放位置。本次运行有效。", "Synchronize 2D time-axis and 3D cursors. Disabling this stops cross-panel positioning, not actual replay seeks. Applies to this run."))}
                {row(tx("分析包", "Analysis package"), (
                  <button className="btn" onClick={() => {
                    onClose();
                    window.setTimeout(() => window.dispatchEvent(new Event("vs-analysis-export")), 0);
                  }}>{tx("导出分析包…", "Export analysis package…")}</button>
                ), tx("选择缓存窗口与模块，导出到本地新目录；不会自动上传。面板内也保留相关入口。", "Choose a cache window and modules, then export to a new local directory. Nothing is uploaded automatically. Panel shortcuts remain available."))}
                {row(tx("断线自动重连", "Auto reconnect"), (
                  <label className="set-switch">
                    <input type="checkbox" checked={settings.autoReconnect} onChange={(e) => patch({ autoReconnect: e.target.checked })} />
                    <span />
                  </label>
                ), tx("串口/TCP/UDP 意外断开后（拔线、对端重启）每 3 秒重试连接，最多 3 次；手动断开不触发，BLE 不参与", "After an unexpected drop (unplug, peer restart) retry serial/TCP/UDP every 3s, up to 3 times; manual close never triggers it; BLE excluded"))}
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
                              <IconEdit />
                            </button>
                            <button
                              className="layout-op-btn danger"
                              title="删除"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void (async () => {
                                  if (
                                    await confirmDialog({
                                      message: `删除布局「${s.name}」？`,
                                      danger: true,
                                      okLabel: "删除",
                                    })
                                  )
                                    removeLayout(s.id);
                                })();
                              }}
                            >
                              <IconTrash />
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
                {row(t("set.fcCellSize"), (
                  <div className="form-pair grow" style={{ gap: 8, alignItems: "center" }}>
                    <input
                      type="range"
                      min={20}
                      max={96}
                      value={settings.fcCellSize}
                      onChange={(e) => patch({ fcCellSize: Number(e.target.value) })}
                    />
                    <b style={{ minWidth: 26, textAlign: "right" }}>{settings.fcCellSize}</b>
                  </div>
                ), t("set.fcCellSize.tip"))}
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
                {row(tx("曲线色板", "Curve palette"), (
                  <select
                    className="input"
                    style={{ width: 150 }}
                    value={settings.chartPalette}
                    onChange={(e) =>
                      patch({ chartPalette: e.target.value === "cbSafe" ? "cbSafe" : "standard" })
                    }
                  >
                    <option value="standard">{tx("标准", "Standard")}</option>
                    <option value="cbSafe">{tx("色觉友好（Okabe-Ito）", "Color-blind safe (Okabe-Ito)")}</option>
                  </select>
                ), tx("新加入的 2D 曲线通道自动分配颜色时使用；色觉友好板在各类色觉缺陷下仍可区分（已手动改色的通道不受影响）", "Palette used when new 2D curve channels get auto colors; the safe palette stays distinguishable under common color vision deficiencies (manually recolored channels unaffected)"))}
                <div className="set-group-title">{tx("存储占用", "Storage usage")}</div>
                {row(tx("本地数据", "Local data"), (
                  <span className="set-usage">
                    {storage
                      ? tx(
                          `设置与历史 ${fmtBytes(storage.local)} · AI 图片 ${storage.idb ? `${storage.idb.count} 张 / ${fmtBytes(storage.idb.bytes)}` : tx("不可用", "n/a")}${storage.quota ? ` · 浏览器配额 ${fmtBytes(storage.quota.usage)} / ${fmtBytes(storage.quota.quota)}` : ""}`,
                          `Settings & history ${fmtBytes(storage.local)} · AI images ${storage.idb ? `${storage.idb.count} / ${fmtBytes(storage.idb.bytes)}` : "n/a"}${storage.quota ? ` · browser quota ${fmtBytes(storage.quota.usage)} / ${fmtBytes(storage.quota.quota)}` : ""}`,
                        )
                      : tx("采集中…", "measuring…")}
                  </span>
                ), tx("localStorage 存设置/会话/聊天文本（上限约 5MB），AI 聊天图片存 IndexedDB；「+面板」等布局也计入设置", "localStorage holds settings/sessions/chat text (~5MB cap); AI chat images live in IndexedDB; panel layouts count as settings too"))}
                {row(tx("AI 图片上限", "AI image limits"), (
                  <span className="set-inline">
                    <input
                      type="number"
                      className="input"
                      style={{ width: 72 }}
                      min={10}
                      max={5000}
                      defaultValue={Number(localStorage.getItem("vs.aiImages.max")) || 300}
                      key={`imgc-${tab}`}
                      onBlur={(e) => {
                        const c = Math.round(Number(e.target.value));
                        const m = Math.round(Number(localStorage.getItem("vs.aiImages.mb")) || 64);
                        if (Number.isFinite(c)) setImageLimits(c, m);
                      }}
                    />
                    <span className="set-usage">{tx("张 ×", "items ×")}</span>
                    <input
                      type="number"
                      className="input"
                      style={{ width: 72 }}
                      min={8}
                      max={512}
                      defaultValue={Number(localStorage.getItem("vs.aiImages.mb")) || 64}
                      key={`imgm-${tab}`}
                      onBlur={(e) => {
                        const m = Math.round(Number(e.target.value));
                        const c = Math.round(Number(localStorage.getItem("vs.aiImages.max")) || 300);
                        if (Number.isFinite(m)) setImageLimits(c, m);
                      }}
                    />
                    <span className="set-usage">MB</span>
                  </span>
                ), tx("超出上限按最久未用淘汰（LRU）；修改后立即按新上限整理", "Least-recently-used images are evicted beyond the cap; changes prune immediately"))}
                {row(tx("清理", "Cleanup"), (
                  <span className="set-inline">
                    <button
                      className="btn"
                      onClick={() => {
                        void clearAllImages().then(async () => {
                          setMsg(tx("AI 图片缓存已清空（聊天里的旧图刷新后不再显示）", "AI image cache cleared (old chat images won't restore after reload)"));
                          const idb = await imageStoreStats().catch(() => null);
                          setStorage((prev) => (prev ? { ...prev, idb } : prev));
                        });
                      }}
                    >
                      {tx("清空 AI 图片", "Clear AI images")}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        sentinelStore.clearAlerts();
                        setMsg(tx("哨兵报警历史已清空", "Sentinel alert history cleared"));
                      }}
                    >
                      {tx("清空哨兵报警", "Clear sentinel alerts")}
                    </button>
                  </span>
                ), tx("不影响协议模板/命令/卡片等配置；聊天文字记录也不会被删", "Protocol templates, commands and cards are untouched; chat text history stays too"))}
              </>
            )}
            {tab === "monitor" && (
              <>
                <div className="set-group-title">{tx("异常检测", "Anomaly detection")}</div>
                {row(tx("突变灵敏度", "Spike sensitivity"), (
                  <select className="input" style={{ width: 150 }} value={snt.cfg.sensitivity} onChange={(e) => sentinelStore.setSensitivity(e.target.value as "low" | "mid" | "high")}>
                    <option value="low">{tx("低（少误报）", "Low (fewer false alarms)")}</option>
                    <option value="mid">{tx("中", "Medium")}</option>
                    <option value="high">{tx("高（快检出）", "High (fast detection)")}</option>
                  </select>
                ), tx("数值通道双 EMA z-score 报警阈值；哨兵面板未打开时也可在此预设", "Dual-EMA z-score threshold for channel spikes; preset here even when the panel is closed"))}
                {row(tx("静默阈值", "Silence threshold"), (
                  <select className="input" style={{ width: 90 }} value={snt.cfg.silenceSec} onChange={(e) => sentinelStore.setSilenceSec(Number(e.target.value))}>
                    {[1, 2, 3, 5, 10, 15, 30].map((n) => (
                      <option key={n} value={n}>{n}s</option>
                    ))}
                  </select>
                ), tx("连接中超过该时长收不到任何帧即报「通信静默」", "Report link silence when connected but no frames for this long"))}
                {row(tx("错误帧率阈值", "Error-rate threshold"), (
                  <select className="input" style={{ width: 90 }} value={snt.cfg.errRatePct} onChange={(e) => sentinelStore.setErrRatePct(Number(e.target.value))}>
                    {[5, 10, 20, 50].map((n) => (
                      <option key={n} value={n}>{n}%</option>
                    ))}
                  </select>
                ), tx("近 3 秒解码错误帧占比超该值报警", "Alert when the invalid-frame ratio over the last 3s exceeds this"))}
                <div className="set-group-title">{tx("报警", "Alerts")}</div>
                {row(tx("报警提示音", "Alert sound"), (
                  <label className="set-switch">
                    <input type="checkbox" checked={snt.cfg.sound} onChange={(e) => sentinelStore.setSound(e.target.checked)} />
                    <span />
                  </label>
                ), tx("哨兵新报警的合成提示音：严重三连哔 / 警告单哔 / 恢复柔音", "Synthesized tones for new sentinel alerts: critical triple beep / warning single / recovery soft"))}
                {snt.cfg.sound && row(tx("提示音音量", "Alert volume"), (
                  <span className="set-inline">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={snt.cfg.volume}
                      onChange={(e) => sentinelStore.setVolume(Number(e.target.value))}
                      onMouseUp={() => void import("../sentinel/sentinelSound").then((m) => m.playAlertTone("warn", false, snt.cfg.volume))}
                      style={{ width: 140, accentColor: "var(--accent)" }}
                    />
                    <span className="set-usage">{snt.cfg.volume}</span>
                  </span>
                ), tx("拖动后松开可试听一次", "Release the slider to preview once"))}
                {row(tx("报警历史容量", "Alert history cap"), (
                  <select className="input" style={{ width: 90 }} value={snt.cfg.alertCap} onChange={(e) => sentinelStore.setAlertCap(Number(e.target.value))}>
                    {[100, 200, 500, 1000, 2000].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                ), tx("哨兵面板保留的报警条数（环形覆盖，最旧被挤掉）", "How many alerts the sentinel keeps (ring buffer, oldest evicted)"))}
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
                    placeholder={AI_PRESETS[settings.aiPreset].model}
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
                {/* P96-K4：模型行为与界面显示拆成两项（以前一个 showThinking 管两件事，
                    想关掉长静默只能连思维链显示一起关） */}
                {row(t("set.ai.deepThink"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.deepThink !== false}
                      onChange={(e) => patch({ deepThink: e.target.checked })}
                    />
                    <span />
                  </label>
                ), t("set.ai.deepThink.tip"))}
                {row(t("set.ai.idle"), (
                  <input
                    className="input"
                    style={{ width: 76 }}
                    type="number"
                    min={30}
                    max={600}
                    step={10}
                    value={settings.streamIdleSecs}
                    onChange={(e) => {
                      const v = Math.round(Number(e.target.value));
                      if (!Number.isFinite(v)) return;
                      patch({ streamIdleSecs: Math.max(30, Math.min(600, v)) });
                    }}
                  />
                ), t("set.ai.idle.tip"))}
                <AiConnTestRow />
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
                {/*
                  P98-M2：原「创造模式（AI 插件）」三项已清退两项。
                  `aiCreativity` 是死码（prompts 从不读 `enabled`，只当过另两行的显示条件）；
                  `aiScript` 更糟——说明写着"允许调用高权限动作"，实际 `prompts.ts` 一句 `void perms`
                  什么都不拦，真实高权限判定走硬编码的 highPriv。**留着一个假装生效的安全控件，
                  比没有控件更危险**（用户会以为关掉它就安全了）。
                  `aiWidgetSend` 是真门（appActions 的 openPort/closePort + 小部件 send/ask），
                  它是**全机发送总闸**而不是"AI 插件的子功能"，所以搬到这里并改名。
                */}
                <div className="set-group-title">{tx("权限与安全", "Permissions & safety")}</div>
                <div className="set-danger-note">
                  {tx(
                    "以下是本机能力总闸：关掉后即使 Agent 档位给了授权域也调不动。默认全部关闭，按需开启。",
                    "Machine-wide capability switches. Turning one off blocks the capability even when the Agent tier grants that domain. All off by default.",
                  )}
                </div>
                {row(t("set.ai.widgetSend"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.aiWidgetSend}
                      onChange={(e) => patch({ aiWidgetSend: e.target.checked })}
                    />
                    <span />
                  </label>
                ), t("set.ai.widgetSend.tip"))}
                {row(tx("Agent 文件白名单", "Agent file whitelist"), (
                  <input
                    className="input"
                    style={{ width: 280 }}
                    value={settings.agentFsRoots}
                    placeholder={tx("如 D:\\Projects;D:\\data（留空=关闭）", "e.g. D:\\Projects;D:\\data (empty = off)")}
                    onChange={(e) => patch({ agentFsRoots: e.target.value })}
                  />
                ), tx(
                  "Agent 的 fs_read/fs_list 只能访问白名单内的路径；多个目录用分号分隔，留空表示文件工具关闭",
                  "fs_read/fs_list can only access whitelisted paths; separate folders with semicolons; empty disables file tools",
                ))}
                {row(tx("Agent 允许执行命令", "Agent may run commands"), (
                  <label className="set-switch">
                    <input
                      type="checkbox"
                      checked={settings.agentShellEnabled}
                      onChange={(e) => patch({ agentShellEnabled: e.target.checked })}
                    />
                    <span />
                  </label>
                ), tx(
                  "命令执行总开关，默认关闭。开启后 Agent 仍需在「自定义」档位勾选命令行域，且每条命令都弹出批准卡逐条确认；单条命令 10s 超时自动终止、输出窗口 64KB（超出时首尾都保留并标明中间省略量，原文仍可分页取回）",
                  "Master switch for shell_exec, off by default. Even when on, the Agent must pick the shell domain in custom scope and every command shows an approval card; 10s timeout and a 64 KiB output window per command (beyond it both ends are kept and the omitted span is stated, full text stays pageable)",
                ))}
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
                        void (async () => {
                          if (!(await confirmDialog({ message: "恢复出厂将清除：协议模板、控制画布、命令库、变量、全部设置与插件库，且不可恢复。确定继续？", danger: true, okLabel: "清除并重启准备" }))) return;
                          const kill: string[] = [];
                          for (let i = 0; i < localStorage.length; i++) {
                            const k = localStorage.key(i);
                            if (k?.startsWith("vs.")) kill.push(k);
                          }
                          kill.forEach((k) => localStorage.removeItem(k));
                          location.reload();
                        })();
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
            {tab === "ext" && <ExtPage />}
            {tab === "mcp" && (
              <>
                <div className="set-group-title">{tx("MCP 服务器（AI IDE 反向集成）", "MCP server (AI IDE integration)")}</div>
                {row(tx("启用 MCP 桥", "Enable MCP bridge"), (
                  <label className="set-switch">
                    <input type="checkbox" checked={settings.mcpEnabled} onChange={(e) => patch({ mcpEnabled: e.target.checked })} />
                    <span />
                  </label>
                ), tx("在本机 127.0.0.1 开一个受 token 保护的本地控制平面，让 Claude Desktop / Cursor 等 AI IDE 经 MCP 直接读取实时遥测、发送指令、跑测试序列。关闭时零开销", "Runs a token-protected localhost control plane so AI IDEs (Claude Desktop / Cursor) can read live telemetry, send commands and run test sequences over MCP. Zero overhead when off"))}
                {row(tx("端口", "Port"), (
                  <input
                    className="input"
                    style={{ width: 110 }}
                    inputMode="numeric"
                    value={settings.mcpPort}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (Number.isFinite(n)) patch({ mcpPort: n });
                    }}
                    onBlur={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (!Number.isFinite(n) || n < 1024 || n > 65535) patch({ mcpPort: 7731 });
                    }}
                  />
                ), tx("1024~65535；被占用时启动会给出提示，改端口即可。客户端经发现文件自动定位，无需同步修改配置", "1024~65535. Clients auto-locate the app via the discovery file, so changing this needs no config edits"))}
                {row(tx("握手 Token", "Handshake token"), (
                  <span className="set-inline">
                    <input className="input" style={{ width: 260 }} readOnly value={settings.mcpToken} onFocus={(e) => e.currentTarget.select()} />
                    <button className="btn" onClick={() => patch({ mcpToken: crypto.randomUUID().replace(/-/g, "") })}>
                      {tx("重新生成", "Regenerate")}
                    </button>
                  </span>
                ), tx("桥接客户端首次连接必须出示此 token；重新生成后旧配置立即失效", "Bridge clients must present this token on connect; regenerating invalidates old ones instantly"))}
                {row(tx("桥接 CLI 路径", "Bridge CLI path"), (
                  <input
                    className="input"
                    style={{ width: 340 }}
                    value={mcpCliPath}
                    placeholder="…\\dist-cli\\uartix-mcp.cjs"
                    onChange={(e) => {
                      setMcpCliPath(e.target.value);
                      localStorage.setItem("vs.mcpCliPath", e.target.value);
                    }}
                  />
                ), tx("uartix-mcp.cjs 的绝对路径（npm run build:mcp 产出）。下面的复制配置会使用它；需要本机装有 Node ≥ 18", "Absolute path to uartix-mcp.cjs (built by npm run build:mcp), used by the copy buttons below; requires Node ≥ 18"))}
                {row(tx("复制客户端配置", "Copy client config"), (
                  <span className="set-inline">
                    <button
                      className="btn"
                      onClick={() => {
                        void navigator.clipboard.writeText(mcpServerConfig(mcpCliPath)).then(
                          () => toast("已复制 Claude Desktop / Cursor 通用配置"),
                          () => toast("复制失败：请手动复制输入框内容"),
                        );
                      }}
                    >
                      {tx("复制 MCP JSON", "Copy MCP JSON")}
                    </button>
                  </span>
                ), tx("粘贴到 %APPDATA%\\Claude\\claude_desktop_config.json 或 Cursor 的 ~/.cursor/mcp.json，重启客户端即可", "Paste into %APPDATA%\\Claude\\claude_desktop_config.json or Cursor's ~/.cursor/mcp.json and restart the client"))}
                <div className="set-group-title">{tx("远程权限", "Remote permissions")}</div>
                {row(tx("允许远程发送", "Allow remote sending"), (
                  <label className="set-switch">
                    <input type="checkbox" checked={settings.mcpAllowSend} onChange={(e) => patch({ mcpAllowSend: e.target.checked })} />
                    <span />
                  </label>
                ), tx("关闭时 send / run_sequence 工具直接拒绝；开启后 IDE 智能体可真实向设备发包", "send / run_sequence tools are rejected while off; when on, IDE agents can really send to the device"))}
                {row(tx("允许高权限动作", "Allow high-privilege actions"), (
                  <label className="set-switch">
                    <input type="checkbox" checked={settings.mcpHighPriv} onChange={(e) => patch({ mcpHighPriv: e.target.checked })} />
                    <span />
                  </label>
                ), tx("openPort/closePort、删除模板/命令/卡片等破坏性动作的开关（与高权限动作同一集合）", "Gates openPort/closePort and destructive remove actions (same set as high-privilege actions)"))}
                <div className="set-group-title">{tx("任务（P88a 异步任务）", "Jobs (async tasks)")}</div>
                <div className="set-danger-note">{tx("收到≠成功；停止中≠已停止。取消不会撤销已发生的设备操作。", "Accepted is not success. Stopping is not stopped. Cancelling never undoes effects already sent.")}</div>
                {jobSt.jobs.length === 0 ? (
                  <div className="set-io-hint">
                    {tx("暂无任务。异步任务经 MCP create_job 提交（sequence.validate / 仅无副作用步骤的 sequence.run），用 get_job 查询、cancel_job 停止；与短调用不同，提交后立刻返回任务号。", "No jobs. Submit async jobs via MCP create_job (sequence.validate / sequence.run with side-effect-free steps only), poll get_job and stop via cancel_job. Unlike short calls, submission returns a jobId immediately.")}
                  </div>
                ) : (
                  <div className="set-usage" style={{ display: "inline-block", maxWidth: 460, textAlign: "left" }}>
                    {jobSt.jobs.map((jobRow) => (
                      <div key={jobRow.jobId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
                        <code style={{ fontSize: 11 }}>{jobRow.jobId.slice(-10)}</code>
                        <span>{jobRow.taskType} · MCP · {Math.max(0, Math.round(((jobRow.finishedAt ?? Date.now()) - jobRow.createdAt) / 1000))}s</span>
                        <JobDetails jobId={jobRow.jobId} />
                        <span className={jobRow.state === "succeeded" ? "set-ok-note" : jobRow.state === "cancel_requested" || jobRow.state === "running" ? "set-danger-note" : ""}>
                          {jobRow.state === "cancel_requested" ? tx("停止中", "stopping") : jobRow.state}
                        </span>
                        <span style={{ opacity: 0.7 }}>{jobRow.phase}</span>
                        {jobRow.effectStatus !== "none" && <span>· effect={jobRow.effectStatus}</span>}
                        {jobRow.resultAvailability === "result_evicted" && <span>· {tx("结果已淘汰", "result evicted")}</span>}
                        {jobRow.error?.code === "needs_manual_confirmation" && <span>· {tx("需本机人工确认（不会自动执行）", "needs on-device manual confirmation (never auto-runs)")}</span>}
                        {["queued", "running", "cancel_requested"].includes(jobRow.state) && (
                          <button
                            className="btn"
                            style={{ padding: "0 8px", fontSize: 11 }}
                            disabled={jobRow.state === "cancel_requested"}
                            onClick={() => { void jobCenter.cancel(jobRow.jobId, "ui"); }}
                          >
                            {jobRow.state === "cancel_requested" ? tx("停止中…", "stopping…") : tx("取消", "Cancel")}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="set-group-title">{tx("运行状态", "Runtime status")}</div>
                {row(tx("桥状态", "Bridge status"), (
                  <span className="set-usage">
                    {mcpSt.running
                      ? tx(`运行中 · 端口 ${mcpSt.port} · ${mcpSt.clients} 个客户端`, `running · port ${mcpSt.port} · ${mcpSt.clients} client(s)`)
                      : tx("未运行", "not running")}
                  </span>
                ), tx("启用后此处应显示「运行中」；客户端连接数变化即时刷新", "Shows running after enable; client count refreshes live"))}
                {mcpSt.audit.length > 0 && row(tx("最近调用", "Recent calls"), (
                  <span className="set-usage" style={{ display: "inline-block", maxWidth: 380, textAlign: "left" }}>
                    {mcpSt.audit.slice(-5).reverse().map((a) => (
                      <div key={`${a.ts}-${a.kind}`}>
                        {new Date(a.ts).toLocaleTimeString()} · {a.kind} · {a.ok ? "OK" : "ERR"} · {a.ms}ms
                      </div>
                    ))}
                  </span>
                ), tx("最近 5 次远程工具调用（共保留 50 条审计环形）", "Last 5 remote tool calls (50-entry audit ring)"))}
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
                <OperatorGenBlock
                  notify={(s) => setMsg(s)}
                />
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
