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
  armModulePackage,
  PLUGIN_STATE_LABEL,
  type PluginRecord,
} from "./pluginStore";
import { contribKeyLabel, artifactKindLabel, type WorkflowArtifact } from "./artifact";
import { deprecatedContribKeys } from "./pluginStore";
import { requestApplyLayout } from "../ai/appBus";
import { pushDraft } from "../ai/chatStore";
import { looksLikeLayoutJson } from "../settings/applyLayout";
import { unknownTemplateTools, templateToPrompt } from "../agent/taskTemplate";
import { moduleArtifactsOf } from "./moduleHost";
import { moduleDiagnostics, type ModuleStatus } from "./moduleBus";
import { describeToolChange, pluginToolChangeOf, pluginToolDefsOf } from "./pluginToolDefs";
import { CAP_LABEL, PLUGIN_CAPS, describeDiff, manifestDiff, type PluginManifest } from "./pluginManifest";
import { setOpen } from "../ai/extensionStore";
import { MarketDialog } from "../market/MarketDialog";

/** 逻辑模块运行态的说法（穷举 Record：加一种状态忘了配说法，编译期就红） */
const MODULE_STATUS_ZH: Record<ModuleStatus | "none", string> = {
  none: "未运行",
  probing: "自证中",
  live: "在线",
  blocked: "封网自证未通过（已拦停）",
  dead: "已失控终止（停用再启用可重来）",
};

/**
 * 种类筛选：只有这几类各占一个按钮，其余一律进「其他」。
 * 中文名取自产物元表（P99a-D1a：以前这里手抄过一份"主题/小部件/面板"，元表改名就漂）；
 * 下面那句过滤判定与按钮清单共用同一个 `FILTERED_KINDS`，不再是两处手抄的同一件事。
 */
const FILTERED_KINDS = ["theme", "widget", "panel"] as const;
const KIND_FILTERS = ["all", ...FILTERED_KINDS, "other"] as const;
const KIND_FILTER_LABEL: Record<(typeof KIND_FILTERS)[number], string> = {
  all: "全部",
  theme: artifactKindLabel("theme"),
  widget: artifactKindLabel("widget"),
  panel: artifactKindLabel("panel"),
  other: "其他",
};

function recordKinds(r: PluginRecord): string[] {
  return [...new Set(Object.values(r.pkg.artifacts).map((a) => String(a.kind ?? "")))];
}

/**
 * 候选 vs 现役的差异（P99a-E2 / B3）。
 *
 * 三行都是**信息**，不是新增审批：批准仍然是原来那一次点击，不额外要勾选、不额外展开。
 * 刻意**不假装**能列出"工具变化"——工具是模块在 Worker 里跑起来才自报的（`moduleBus` 每次启动
 * 先 `clearPluginTools`），批准前根本不知道；编一个看起来完整的差异，比直说"这一项目前还不知道"更坏。
 */
function CandidateDiff({ cur, cand }: { cur: PluginManifest; cand: PluginManifest }) {
  const d = manifestDiff(cur, cand);
  const text = describeDiff(d);
  return (
    <>
      <div className="plg-detail-dim">{text || "与当前版本没有能力或产物数量的变化（可能只改了内容本身）"}</div>
      {d.capsAddedBlocking.length > 0 && (
        <div className="plg-notice">
          新要的能力里有「{d.capsAddedBlocking.map((c) => CAP_LABEL[c].name).join("、")}」——这类能力不属于自动放行集，
          批准后也不会自己生效，要看效果请把这个包再启用一次。
        </div>
      )}
      {d.capsRemoved.length > 0 && (
        <div className="plg-notice">
          这一版会收回「{d.capsRemoved.map((c) => CAP_LABEL[c].name).join("、")}」，用到它的那部分功能会开始不调。
        </div>
      )}
      <div className="plg-detail-dim">
        工具清单要批准并启用后才由模块报上来（所以批准卡上给不出它）；启用后在本包详情的
        「为 AI 助手提供的工具」一节里能看全，那里还会写明这一版比上一版多了哪几支。
      </div>
    </>
  );
}

/** 插件管理主体（列表+详情+启停+配置+导入导出+更新回滚+市场入口）。
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
          if (filter === "other" ? kinds.some((k) => !(FILTERED_KINDS as readonly string[]).includes(k)) : !kinds.includes(filter)) return false;
        }
        if (!q) return true;
        return (
          r.pkg.name.toLowerCase().includes(q) ||
          r.pkg.id.toLowerCase().includes(q) ||
          (r.pkg.desc ?? "").toLowerCase().includes(q)
        );
      })
      // P91 D6：Agent 生成的插件聚到列表尾部（同名系列原地升版 + 成簇排列，
      // 不再和用户手装的插件交错成一摞"看起来重复"的条目）
      .sort((a, b) => {
        const ag = a.pkg.provenance?.createdBy === "agent" ? 1 : 0;
        const bg = b.pkg.provenance?.createdBy === "agent" ? 1 : 0;
        return ag - bg || b.updatedAt - a.updatedAt;
      });
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

  /**
   * 应用插件带来的工作区布局（P99a-D1b：这是 `workspacePreset` 从"能存不能用"变成有投影的那一步）。
   * 整屏覆盖 ⇒ 先确认；执行前自动把当前布局快照进"自动备份槽"，所以点错了回得去。
   */
  const applyWorkspaceLayout = (r: PluginRecord, entry: string) => {
    const art = r.pkg.artifacts[entry] as { layout?: unknown } | undefined;
    if (!looksLikeLayoutJson(art?.layout)) {
      setNotice({ ok: false, msg: "这份内容看着不像布局 JSON，已拒绝应用（别让 clear() 先清空界面再撞异常）" });
      return;
    }
    if (!window.confirm(`应用「${r.pkg.name}」的工作区布局？\n当前排列会被替换，并自动存进 设置 → 布局 的自动备份槽。`)) return;
    requestApplyLayout(art?.layout, (err) =>
      setNotice(err
        ? { ok: false, msg: err }
        : { ok: true, msg: `已应用「${r.pkg.name}」的布局；想换回去用 设置 → 布局 的自动备份槽` }),
    );
  };

  /**
   * 把任务模板填进 AI 助手的输入框（**只填不发**：发不发、用哪个授权档都是用户的决定）。
   * 工具存在性在这里再查一次：模板是"当初存的"，工具面是"现在这些"，中间可能已经变了；
   * 查不到不拦载入，但必须点名说清哪几步会撞 unknown_tool（静默填一段跑不动的话等于骗人）。
   */
  const loadTemplate = async (r: PluginRecord, entry: string) => {
    const art = r.pkg.artifacts[entry] as unknown as WorkflowArtifact | undefined;
    if (!art || typeof art.goal !== "string" || !Array.isArray(art.steps)) {
      setNotice({ ok: false, msg: "这个模板读不出目标与步骤（可能是已下架的旧形态），请在 AI 助手里重新生成一份" });
      return;
    }
    const [{ hostEntryNames }, { pluginToolName }, { allPluginToolDefs }] = await Promise.all([
      import("../agent/hostEntries"),
      import("../agent/toolRegistry"),
      import("./pluginToolDefs"),
    ]);
    const known = [
      ...hostEntryNames(),
      ...allPluginToolDefs().map((d) => pluginToolName(d.pkgId, d.baseName)),
    ];
    const unknown = unknownTemplateTools(art, known);
    pushDraft(templateToPrompt(art, { name: r.pkg.name, version: r.pkg.version }));
    setNotice(unknown.length
      ? { ok: false, msg: `已填入输入框（未发送）。但这几步本机没有对应工具：${unknown.join("、")}——先改掉或删掉，否则 Agent 会在这几步上撞 unknown_tool` }
      : { ok: true, msg: "任务模板已填入 AI 助手输入框（还没有发送）" });
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

  return (
    <>
      <div className="plg-head">
        <span className="plg-title">本地插件库</span>
        <span className="plg-sub">
          {plugins.length ? `${plugins.length} 个插件` : "暂无插件；由 AI 助手「保存为插件」或导入插件包"}
        </span>
        <div className="plg-head-actions">
          <button className="btn" onClick={() => setMarket(true)} title="浏览社区插件货架：实时拉取索引，看得见来源、能力与哈希">
            浏览市场
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
                  {r.candidate && <span className="plg-chip warn">有候选 v{r.candidate.version}</span>}
                </button>
                <label className="plg-switch" title={enabled ? "停用" : "启用"}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={r.state === "quarantined"}
                    onChange={(e) => {
                      const want = e.target.checked;
                      if (!want) {
                        const res = setEnabled(r.pkg.id, false);
                        setNotice({ ok: res.ok, msg: res.msg });
                        return;
                      }
                      /**
                       * P99a-B1：带逻辑模块的包，启用前先等 realm 封网自证回来。
                       * 红了就不启用（开关跟着 store 里的状态自然回落，不做"先亮起来再标灰"）。
                       */
                      if (!moduleArtifactsOf(r.pkg).length) {
                        const res = setEnabled(r.pkg.id, true);
                        setNotice({ ok: res.ok, msg: res.msg });
                        return;
                      }
                      void armModulePackage(r.pkg.id).then((probe) => {
                        if (!probe.ok) {
                          setNotice({ ok: false, msg: probe.msg });
                          return;
                        }
                        const res = setEnabled(r.pkg.id, true);
                        setNotice({ ok: res.ok, msg: `${res.msg}｜${probe.msg}` });
                      });
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
                  <div className="plg-sec">能力与权限</div>
                  <div className="plg-caps">
                    {r.pkg.capabilities.map((c) => (
                      <span key={c} className="plg-chip" title={CAP_LABEL[c].note}>
                        {CAP_LABEL[c].name}
                      </span>
                    ))}
                  </div>

                  {/* P99a-B3：含逻辑模块的包要看得见"跑没跑起来、注册了哪几支工具"，
                      否则用户只知道"启用了"，却不知道 Agent 面为什么少了/多了东西。 */}
                  {moduleArtifactsOf(r.pkg).length > 0 && (
                    <>
                      <div className="plg-sec">逻辑模块</div>
                      <div className="plg-notice">
                        运行状态：{MODULE_STATUS_ZH[moduleDiagnostics(r.pkg.id).status]}
                        {moduleDiagnostics(r.pkg.id).probeFailed.length
                          ? ` · 未通过项：${moduleDiagnostics(r.pkg.id).probeFailed.join("、")}`
                          : ""}
                        {moduleDiagnostics(r.pkg.id).rebuilds
                          ? ` · 因失控重建 ${moduleDiagnostics(r.pkg.id).rebuilds} 次`
                          : ""}
                      </div>
                      {pluginToolDefsOf(r.pkg.id).length > 0 && (
                        <>
                          <div className="plg-sec">为 AI 助手提供的工具</div>
                          <div className="plg-caps">
                            {pluginToolDefsOf(r.pkg.id).map((t) => (
                              <span key={t.baseName} className="plg-chip" title={t.description}>
                                {t.baseName}
                              </span>
                            ))}
                          </div>
                          {/* P99a-F2（B3 剩余那半）：批准更新时说不清"多了哪几支工具"，
                              但模块报齐的那一刻起，这一条就有了真实答案。 */}
                          {pluginToolChangeOf(r.pkg.id) && (
                            <div className="plg-detail-dim">
                              与上一版报上来的清单相比：{describeToolChange(pluginToolChangeOf(r.pkg.id))}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}

                  <div className="plg-sec">产物与操作</div>
                  {Object.entries(r.pkg.contributions).length === 0 && <div className="plg-detail-dim">无可挂载产物</div>}
                  {Object.entries(r.pkg.contributions).map(([key, entries]) =>
                    (entries ?? []).map((it) => {
                      const kindZh = contribKeyLabel(key);
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
                          {key === "workspacePresets" && (
                            <button className="btn" onClick={() => applyWorkspaceLayout(r, it.entry)}>
                              应用此布局
                            </button>
                          )}
                          {key === "workflows" && (
                            <button className="btn" onClick={() => void loadTemplate(r, it.entry)}>
                              载入 AI 助手
                            </button>
                          )}
                        </div>
                      );
                    }),
                  )}
                  {deprecatedContribKeys(r.pkg).length > 0 && (
                    <div className="plg-detail-dim" role="status">
                      这个包里还有已下架的产物形态（{deprecatedContribKeys(r.pkg).join("、")}）：
                      它不会出现在任何运行时里，请在 AI 助手里重新生成（动效预设已并入主题、报告视图已并入面板）
                    </div>
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
                      <CandidateDiff cur={r.pkg} cand={r.candidate} />
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
                    {r.pkg.provenance.createdBy === "agent" ? "AI 生成" : r.pkg.provenance.createdBy === "import" ? "导入" : "本地创建"}
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

      {market && <MarketDialog onClose={() => setMarket(false)} />}
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
