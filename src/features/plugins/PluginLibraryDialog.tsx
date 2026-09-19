/**
 * P88b-3 §9.3：本地插件库 UI。
 * 提供：搜索、分类、启停、配置、版本历史/回滚、权限查看、复制、导出、导入、
 * 卸载、更新候选批准/拒绝、插件市场（占位）、面板/小部件打开入口。
 * PluginManagerBody 为可复用主体（插件库弹窗与设置→插件管理共用），
 * PluginLibraryDialog 仅保留 overlay/portal 壳。
 * 样式全部使用主题变量（8 主题兼容），无字面量颜色。
 */
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  usePlugins,
  setEnabled,
  setConfigValues,
  exportPackages,
  importPackages,
  duplicate,
  uninstall,
  rollback,
  approveUpdate,
  rejectUpdate,
  shadowExtId,
  PLUGIN_STATE_LABEL,
  type PluginRecord,
} from "./pluginStore";
import { PLUGIN_CAPS, type PluginCap } from "./pluginManifest";
import { setOpen } from "../ai/extensionStore";

const CAP_LABEL: Record<PluginCap, string> = {
  "theme.tokens": "主题 token",
  "ui.panel": "自定义面板",
  "ui.widget": "小部件",
  "ui.action": "界面动作",
  "motion.preset": "动效预设",
  "workspace.preset": "工作区预设",
  "workflow.compose": "工作流组合",
  "report.view": "报告视图",
  "telemetry.read": "读取数据快照",
  "serial.send": "发送串口数据（另受全局发送权限限制）",
  "ai.ask": "向 AI 助手提问",
};

const KIND_FILTERS = ["all", "theme", "widget", "panel", "other"] as const;
const KIND_FILTER_LABEL: Record<string, string> = {
  all: "全部",
  theme: "主题",
  widget: "小部件",
  panel: "面板",
  other: "其他",
};

function recordKinds(r: PluginRecord): string[] {
  return [...new Set(Object.values(r.pkg.artifacts).map((a) => String(a.kind ?? "")))];
}

/** 插件市场占位视图（纯 UI，不接网络；复用既有 .plg-* 样式，避免新增 CSS 与并行会话冲突） */
function PluginMarketPlaceholder({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="plg-toolbar">
        <button className="btn" onClick={onBack}>
          ← 返回插件列表
        </button>
        <input
          className="input plg-search"
          placeholder="搜索 GitHub 话题插件（即将上线）"
          disabled
          aria-label="搜索插件市场"
        />
      </div>
      <div className="plg-list">
        <div className="plg-empty">
          插件市场建设中：未来可在此按 uartix-plugin 话题搜索社区插件，导入后默认停用并经校验后启用。
        </div>
      </div>
    </>
  );
}

/** 插件管理主体（列表+详情+启停+配置+导入导出+更新回滚+市场占位）。
 *  onClose 可选：设置页内嵌时不渲染关闭按钮。 */
export function PluginManagerBody({ onClose }: { onClose?: () => void }) {
  const { plugins } = usePlugins();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof KIND_FILTERS)[number]>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [market, setMarket] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins
      .filter((r) => {
        if (filter !== "all") {
          const kinds = recordKinds(r);
          if (filter === "other" ? kinds.some((k) => !["theme", "widget", "panel"].includes(k)) : !kinds.includes(filter)) return false;
        }
        if (!q) return true;
        return (
          r.pkg.name.toLowerCase().includes(q) ||
          r.pkg.id.toLowerCase().includes(q) ||
          (r.pkg.desc ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [plugins, query, filter]);

  const doExport = (r: PluginRecord) => {
    const res = exportPackages([r.pkg.id]);
    if (!res.ok || !res.json) {
      setNotice({ ok: false, msg: res.msg });
      return;
    }
    void navigator.clipboard
      ?.writeText(res.json)
      .then(() => setNotice({ ok: true, msg: `${res.msg}（包 JSON 已复制到剪贴板）` }))
      .catch(() => setNotice({ ok: true, msg: `${res.msg}（剪贴板不可用，详见控制台）` }));
    console.info("[插件导出]", res.json);
  };

  const onImportFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      setNotice({ ok: false, msg: "文件超过 4MiB 上限" });
      return;
    }
    const text = await f.text();
    const res = importPackages(text);
    setNotice({ ok: res.ok, msg: res.msg });
  };

  const openPanel = (r: PluginRecord, contribId: string) => {
    window.dispatchEvent(
      new CustomEvent("ux:open-ext-panel", { detail: shadowExtId(r.pkg.id, contribId) }),
    );
  };
  const openWidgetFloat = (r: PluginRecord, contribId: string) => {
    setOpen(shadowExtId(r.pkg.id, contribId), true);
  };

  /* —— P88d ⑤：批量多选（导出/启停/卸载） —— */
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) =>
    setSel((prev) => {
      const nx = new Set(prev);
      if (nx.has(id)) nx.delete(id);
      else nx.add(id);
      return nx;
    });
  const allVisibleIds = list.map((r) => r.pkg.id);
  const doBatchExport = () => {
    const res = exportPackages([...sel]);
    if (!res.ok || !res.json) {
      setNotice({ ok: false, msg: res.msg });
      return;
    }
    void navigator.clipboard?.writeText(res.json).catch(() => undefined);
    console.info("[插件批量导出]", res.json);
    setNotice({ ok: true, msg: `${res.msg}（JSON 已复制到剪贴板/控制台）` });
  };
  const doBatchEnable = (on: boolean) => {
    let ok = 0;
    const skipped: string[] = [];
    for (const id of sel) {
      const r = plugins.find((x) => x.pkg.id === id);
      if (!r) continue;
      const res = setEnabled(id, on);
      if (res.ok) ok++;
      else skipped.push(`${r.pkg.name}：${res.msg}`);
    }
    setNotice({
      ok: skipped.length === 0,
      msg: `批量${on ? "启用" : "停用"}完成 ${ok} 个${skipped.length ? `；跳过 ${skipped.length} 个（${skipped[0]}）` : ""}`,
    });
  };
  const doBatchUninstall = () => {
    const names = [...sel].map((id) => plugins.find((x) => x.pkg.id === id)?.pkg.name ?? id);
    if (!window.confirm(`卸载选中的 ${names.length} 个插件？历史版本将一并删除。\n${names.join("、")}`)) return;
    let ok = 0;
    for (const id of sel) if (uninstall(id).ok) ok++;
    setNotice({ ok: true, msg: `已卸载 ${ok} 个插件` });
    setSel(new Set());
  };

  if (market) {
    return <PluginMarketPlaceholder onBack={() => setMarket(false)} />;
  }

  return (
    <>
      <div className="plg-head">
        <span className="plg-title">本地插件库</span>
        <span className="plg-sub">
          {plugins.length ? `${plugins.length} 个插件` : "暂无插件；由 AI 助手「保存为插件」或导入插件包"}
        </span>
        <div className="plg-head-actions">
          <button className="btn" onClick={() => setMarket(true)} title="浏览社区插件（即将上线）">
            插件市场
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} title="导入 uartix-plugin 包（默认停用，校验后才可启用）">
            导入
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              void onImportFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {onClose && (
            <button className="btn" onClick={onClose} aria-label="关闭插件库">
              关闭
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className={notice.ok ? "plg-notice ok" : "plg-notice err"} role="status">
          {notice.msg}
          <button className="plg-notice-x" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      <div className="plg-toolbar">
        <input
          className="input plg-search"
          placeholder="搜索名称 / ID / 描述"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索插件"
        />
        <div className="plg-filters" role="tablist" aria-label="按类型筛选">
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              className={`plg-fchip${filter === k ? " on" : ""}`}
              onClick={() => setFilter(k)}
              role="tab"
              aria-selected={filter === k}
            >
              {KIND_FILTER_LABEL[k]}
            </button>
          ))}
        </div>
        <button
          className={`plg-fchip${selMode ? " on" : ""}`}
          title="多选插件进行批量导出/启停/卸载"
          onClick={() => {
            setSelMode((v) => !v);
            setSel(new Set());
          }}
        >
          {selMode ? "退出选择" : "选择"}
        </button>
      </div>

      {selMode && (
        <div className="plg-batch" role="group" aria-label="批量操作">
          <button className="btn" onClick={() => setSel(new Set(allVisibleIds))}>
            全选
          </button>
          <button
            className="btn"
            onClick={() => setSel(new Set(allVisibleIds.filter((id) => !sel.has(id))))}
          >
            反选
          </button>
          <span className="plg-batch-n">已选 {sel.size}</span>
          <span className="plg-batch-spacer" />
          <button className="btn" disabled={sel.size === 0} onClick={doBatchExport}>
            导出
          </button>
          <button className="btn" disabled={sel.size === 0} onClick={() => doBatchEnable(true)}>
            启用
          </button>
          <button className="btn" disabled={sel.size === 0} onClick={() => doBatchEnable(false)}>
            停用
          </button>
          <button className="btn danger" disabled={sel.size === 0} onClick={doBatchUninstall}>
            卸载
          </button>
        </div>
      )}

      <div className="plg-list">
        {list.length === 0 && <div className="plg-empty">没有匹配的插件</div>}
        {list.map((r) => {
          const enabled = r.state === "enabled";
          return (
            <div key={r.pkg.id} className={`plg-item${detailId === r.pkg.id ? " open" : ""}`}>
              <div className="plg-item-row">
                {selMode && (
                  <input
                    type="checkbox"
                    className="plg-item-check"
                    checked={sel.has(r.pkg.id)}
                    onChange={() => toggleSel(r.pkg.id)}
                    aria-label={`选择插件 ${r.pkg.name}`}
                  />
                )}
                <button
                  className="plg-item-main"
                  onClick={() => (selMode ? toggleSel(r.pkg.id) : setDetailId(detailId === r.pkg.id ? null : r.pkg.id))}
                  title={selMode ? "选中/取消" : "展开详情"}
                >
                  <span className="plg-item-name">{r.pkg.name}</span>
                  <span className="plg-item-id">{r.pkg.id}</span>
                  <span className={`plg-state s-${r.state}`}>{PLUGIN_STATE_LABEL[r.state]}</span>
                  {r.legacy && <span className="plg-chip">迁移件</span>}
                  {r.candidate && <span className="plg-chip warn">有候选 v{r.candidate.version}</span>}
                </button>
                <label className="plg-switch" title={r.legacy?.requiresReview ? "迁移件需人工处理，不可启用" : enabled ? "停用" : "启用"}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!!r.legacy?.requiresReview || r.state === "quarantined"}
                    onChange={(e) => {
                      const res = setEnabled(r.pkg.id, e.target.checked);
                      setNotice({ ok: res.ok, msg: res.msg });
                    }}
                  />
                  <span className="plg-switch-ui" aria-hidden="true" />
                </label>
              </div>

              {detailId === r.pkg.id && (
                <div className="plg-detail">
                  {r.pkg.desc && <div className="plg-detail-desc">{r.pkg.desc}</div>}
                  {r.state === "quarantined" && (
                    <div className="plg-notice err">已隔离：多次违反 iframe 隔离约束（伪造消息/越权），卸载后重新安装可解除。</div>
                  )}
                  {r.legacy?.note && <div className="plg-notice">{r.legacy.note}</div>}

                  <div className="plg-sec">能力与权限</div>
                  <div className="plg-caps">
                    {r.pkg.capabilities.map((c) => (
                      <span key={c} className="plg-chip" title={CAP_LABEL[c]}>
                        {CAP_LABEL[c] ?? c}
                      </span>
                    ))}
                  </div>

                  <div className="plg-sec">产物与操作</div>
                  {Object.entries(r.pkg.contributions).length === 0 && <div className="plg-detail-dim">无可挂载产物</div>}
                  {Object.entries(r.pkg.contributions).map(([key, entries]) =>
                    (entries ?? []).map((it) => {
                      const kindZh =
                        key === "themes" ? "主题" : key === "widgets" ? "小部件" : key === "panels" ? "面板" : key;
                      return (
                        <div key={it.id} className="plg-contrib-row">
                          <span className="plg-chip">{kindZh}</span>
                          <span className="plg-ellipsis">{it.name ?? it.id}</span>
                          {key === "panels" && (
                            <button className="btn" onClick={() => openPanel(r, it.id)}>
                              加入工作区
                            </button>
                          )}
                          {key === "widgets" && (
                            <button className="btn" onClick={() => openWidgetFloat(r, it.id)}>
                              打开浮窗
                            </button>
                          )}
                          {key === "themes" && <span className="plg-detail-dim">启用后自动应用</span>}
                        </div>
                      );
                    }),
                  )}

                  {r.pkg.settingsSchema && r.pkg.settingsSchema.length > 0 && (
                    <>
                      <div className="plg-sec">配置</div>
                      {r.pkg.settingsSchema.map((f) => (
                        <label key={f.key} className="plg-cfg-row">
                          <span className="plg-cfg-label">{f.label}</span>
                          {f.type === "boolean" ? (
                            <input
                              type="checkbox"
                              checked={!!r.config[f.key]}
                              onChange={(e) => setNotice(setConfigValues(r.pkg.id, { [f.key]: e.target.checked }))}
                            />
                          ) : f.type === "enum" ? (
                            <select
                              className="input"
                              value={String(r.config[f.key] ?? f.default)}
                              onChange={(e) => setNotice(setConfigValues(r.pkg.id, { [f.key]: e.target.value }))}
                            >
                              {(f.options ?? []).map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              className="input"
                              type={f.type === "number" ? "number" : "text"}
                              value={String(r.config[f.key] ?? f.default)}
                              onChange={(e) => setNotice(setConfigValues(r.pkg.id, { [f.key]: e.target.value }))}
                            />
                          )}
                        </label>
                      ))}
                    </>
                  )}

                  <div className="plg-sec">版本</div>
                  <div className="plg-detail-dim">
                    当前 v{r.pkg.version}；历史 {r.versions.length} 个
                    {r.versions.length > 0 && r.versions[r.versions.length - 1] && (
                      <>（可回滚到 v{r.versions[r.versions.length - 1].version}）</>
                    )}
                  </div>

                  {r.candidate && (
                    <div className="plg-candidate">
                      <div>
                        候选 v{r.candidate.version}：批准后原子切换，当前版本入历史；失败自动回退。
                      </div>
                      <div className="plg-candidate-actions">
                        <button className="btn primary" onClick={() => setNotice(approveUpdate(r.pkg.id))}>
                          批准更新
                        </button>
                        <button className="btn" onClick={() => setNotice(rejectUpdate(r.pkg.id))}>
                          拒绝
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="plg-actions">
                    <button className="btn" onClick={() => doExport(r)} title="导出为 uartix-plugin 包 JSON（不含配置值与秘密）">
                      导出
                    </button>
                    <button className="btn" onClick={() => setNotice(duplicate(r.pkg.id))} title="另存副本（避开覆盖批准）">
                      复制
                    </button>
                    <button
                      className="btn"
                      disabled={r.versions.length === 0}
                      onClick={() => setNotice(rollback(r.pkg.id))}
                      title="回滚到上一版本（不承诺撤销设备效果）"
                    >
                      回滚
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => {
                        if (!window.confirm(`卸载「${r.pkg.name}」？历史版本将一并删除。`)) return;
                        setNotice(uninstall(r.pkg.id));
                        setDetailId(null);
                      }}
                    >
                      卸载
                    </button>
                  </div>

                  <div className="plg-meta">
                    {r.pkg.provenance.createdBy === "agent" ? "AI 生成" : r.pkg.provenance.createdBy === "legacy" ? "旧扩展迁移" : "本地创建"}
                    {" · "}hostApi {r.pkg.hostApi}
                    {r.pkg.provenance.sourceExtId ? ` · 来源扩展 ${r.pkg.provenance.sourceExtId.slice(0, 8)}` : ""}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="plg-foot">
        能力白名单（{PLUGIN_CAPS.length} 项）之外的声明一律拒绝；导入的插件一律默认停用；作者自报的可信标记不构成信任。
      </div>
    </>
  );
}

/** 插件库弹窗：portal 壳复用 PluginManagerBody */
export function PluginLibraryDialog({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="plg-overlay" role="presentation" onClick={onClose}>
      <div
        className="plg-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="本地插件库"
        onClick={(e) => e.stopPropagation()}
      >
        <PluginManagerBody onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
