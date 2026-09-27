/**
 * P88b-3 §9.3：本地插件库 UI。
 * 提供：搜索、分类、启停、配置、版本历史/回滚、权限查看、复制、导出、导入、
 * 卸载、更新候选批准/拒绝、插件市场入口（弹窗由 App 渲染，这里只发信号）、面板/小部件打开入口。
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
  type PluginRecord,
} from "./pluginStore";
// 界面上屏的种类名/状态名走 `pluginUiNames`（按语言挑）；元表里那份中文是 CLI 与模型摘要用的原文，别拿到这里
import { contribName, kindName, stateName } from "./pluginUiNames";
import type { WorkflowArtifact } from "./artifact";
import { deprecatedContribKeys, themeArtsOf } from "./pluginStore";
// P99b-N5：主题那颗开关的话术与设置页/市场同一处（三处各写一遍就会互相打架）
import { themeButtonTalk } from "../settings/themePicker";
import { activeThemeFacts } from "../../styles/themeFacts";
import { requestApplyLayout, requestOpenMarket } from "../ai/appBus";
import { pushDraft } from "../ai/chatStore";
import { looksLikeLayoutJson } from "../settings/applyLayout";
import { unknownTemplateTools, templateToPrompt } from "../agent/taskTemplate";
import { moduleArtifactsOf } from "./moduleHost";
import { moduleDiagnostics, type ModuleStatus } from "./moduleBus";
import { describeToolChange, pluginToolChangeOf, pluginToolDefsOf } from "./pluginToolDefs";
import { CAP_LABEL, PLUGIN_CAPS, describeDiff, manifestDiff, type PluginManifest } from "./pluginManifest";
import { setOpen } from "../ai/extensionStore";
import { Glyph, IconColumns, IconDock, IconPlug, IconStack } from "../../shared/icons";

/**
 * 列表行的类型图标。插件那一面原来只有"名字 + id + 状态 + 开关"一条线，
 * 用户判"感觉很单调" —— 单调的不是颜色，是**一眼扫不出这批东西各是什么**。
 * 图标只走 `shared/icons.tsx` 这一处出处（H 门），并且是装饰性的：
 * 可读名字仍由 `aria-hidden` 的那颗开关与文字给，不靠形状传达唯一信息。
 */
function KindIcon({ kinds }: { kinds: readonly string[] }) {
  const one = kinds[0];
  const Ico = one === "theme" ? IconStack : one === "widget" ? IconColumns : one === "panel" ? IconDock : IconPlug;
  return (
    <span className="plg-item-ico" aria-hidden="true">
      <Ico />
    </span>
  );
}
import { t, tx, useLocale } from "../../i18n/strings";

/**
 * 那颗开关的 tooltip。带主题产物的包要说清"会挤掉谁"（P99b-N5 同级互斥），
 * 其余包沿用"启用/停用"两个字——话术本身在 `settings/themePicker` 里，与设置页、市场同源。
 */
function switchTalk(r: PluginRecord): string {
  const on = r.state === "enabled";
  if (!themeArtsOf(r.pkg).length) return on ? tx("停用", "Disable") : tx("启用", "Enable");
  const f = activeThemeFacts();
  return themeButtonTalk(f.pluginId === r.pkg.id ? "drawn" : "other", r.pkg.name);
}

/**
 * 逻辑模块运行态的说法。
 * 原来是一张穷举 `Record`（加一种状态忘了配说法，编译期就红）——那个性质要留住，
 * 所以改成 `switch` 但**不写 default**：`strict`（strictNullChecks）下少一种取值就报
 * "Function lacks ending return statement"。表里的中文不能直接双语化（扫描器认不出表那个形状，
 * 会把已翻好的记成债），所以每个分支各调一次 `tx()`。
 */
function moduleStatusText(s: ModuleStatus | "none"): string {
  switch (s) {
    case "none":
      return tx("未运行", "Not running");
    case "probing":
      return tx("自证中", "Self-checking");
    case "live":
      return tx("在线", "Online");
    case "blocked":
      return tx("封网自证未通过（已拦停）", "Sandboxed self-check failed (held back)");
    case "dead":
      return tx("已失控终止（停用再启用可重来）", "Killed after runaway (disable and re-enable to retry)");
  }
}

/**
 * 逻辑模块那一格：运行状态 + 未通过项 + 因失控重建次数。
 * 三段各自 `tx()` 再拼，不写成一句套着 `${x ? \`…\` : ""}` 的大模板 ——
 * 嵌套模板里的引号会让整句难读，而分成片段后每一段都是一个能独立核对的双语串。
 */
function moduleBlock(pkgId: string): string {
  const d = moduleDiagnostics(pkgId);
  const parts = [tx(`运行状态：${moduleStatusText(d.status)}`, `Running: ${moduleStatusText(d.status)}`)];
  if (d.probeFailed.length) parts.push(tx(`未通过项：${d.probeFailed.join("、")}`, `Failed checks: ${d.probeFailed.join(", ")}`));
  if (d.rebuilds) parts.push(tx(`因失控重建 ${d.rebuilds} 次`, `${d.rebuilds} rebuild(s) after runaway`));
  return parts.join(" · ");
}

/**
 * 种类筛选：只有这几类各占一个按钮，其余一律进「其他」。
 * 中文名取自产物元表（P99a-D1a：以前这里手抄过一份"主题/小部件/面板"，元表改名就漂）；
 * 下面那句过滤判定与按钮清单共用同一个 `FILTERED_KINDS`，不再是两处手抄的同一件事。
 * 原来这张表是模块级 const，求值期就把语言钉死了 ⇒ 改成取值时才拼。
 */
const FILTERED_KINDS = ["theme", "widget", "panel"] as const;
const KIND_FILTERS = ["all", ...FILTERED_KINDS, "other"] as const;

function kindFilterLabel(k: (typeof KIND_FILTERS)[number]): string {
  switch (k) {
    case "all":
      return tx("全部", "All");
    case "other":
      return tx("其他", "Other");
    default:
      return kindName(k);
  }
}

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
      <div className="plg-detail-dim">
        {text || tx("与当前版本没有能力或产物数量的变化（可能只改了内容本身）", "No change in capabilities or artifact counts vs the current version (maybe only its content changed)")}
      </div>
      {d.capsAddedBlocking.length > 0 && (
        <div className="plg-notice">
          {tx(
            `新要的能力里有「${d.capsAddedBlocking.map((c) => CAP_LABEL[c].name).join("、")}」——这类能力不属于自动放行集，批准后也不会自己生效，要看效果请把这个包再启用一次。`,
            `This version asks for “${d.capsAddedBlocking.map((c) => CAP_LABEL[c].name).join(", ")}” — those are not auto-granted, and approving won't activate them either; re-enable this package to see the effect.`,
          )}
        </div>
      )}
      {d.capsRemoved.length > 0 && (
        <div className="plg-notice">
          {tx(
            `这一版会收回「${d.capsRemoved.map((c) => CAP_LABEL[c].name).join("、")}」，用到它的那部分功能会开始不调。`,
            `This version takes back “${d.capsRemoved.map((c) => CAP_LABEL[c].name).join(", ")}”; whatever used it will stop being callable.`,
          )}
        </div>
      )}
      <div className="plg-detail-dim">
        {tx(
          "工具清单要批准并启用后才由模块报上来（所以批准卡上给不出它）；启用后在本包详情的「为 AI 助手提供的工具」一节里能看全，那里还会写明这一版比上一版多了哪几支。",
          "The tool list is only reported by the module after you approve and enable it (so the approval card can't show it). Once enabled, the “Tools provided to the AI assistant” section in this package's details lists every one, plus what this version added.",
        )}
      </div>
    </>
  );
}

/** 插件管理主体（列表+详情+启停+配置+导入导出+更新回滚+市场入口）。
 *  onClose 可选：设置页内嵌时不渲染关闭按钮。 */
export function PluginManagerBody({ onClose }: { onClose?: () => void }) {
  useLocale(); // 这一面的话术全是 tx() 出来的，切语言要有人重渲染
  const { plugins } = usePlugins();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof KIND_FILTERS)[number]>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
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
      .then(() => setNotice({ ok: true, msg: tx(`${res.msg}（包 JSON 已复制到剪贴板）`, `${res.msg} (package JSON copied to the clipboard)` ) }))
      .catch(() => setNotice({ ok: true, msg: tx(`${res.msg}（剪贴板不可用，详见控制台）`, `${res.msg} (clipboard unavailable — see the console)` ) }));
    console.info("[plugin export]", res.json);
  };

  const onImportFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      setNotice({ ok: false, msg: tx("文件超过 4MiB 上限", "The file is over the 4MiB limit") });
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
      setNotice({ ok: false, msg: tx("这份内容看着不像布局 JSON，已拒绝应用（别让 clear() 先清空界面再撞异常）", "That doesn't look like layout JSON, so it was rejected (clear() would wipe the UI before the exception)" ) });
      return;
    }
    if (!window.confirm(tx(
      `应用「${r.pkg.name}」的工作区布局？\n当前排列会被替换，并自动存进 设置 → 布局 的自动备份槽。`,
      `Apply the workspace layout from “${r.pkg.name}”?\nThe current arrangement is replaced, and snapshotted first into the auto-backup slot under Settings → Layout.`,
    ))) return;
    requestApplyLayout(art?.layout, (err) =>
      setNotice(err
        ? { ok: false, msg: err }
        : { ok: true, msg: tx(`已应用「${r.pkg.name}」的布局；想换回去用 设置 → 布局 的自动备份槽`, `Layout from “${r.pkg.name}” applied; to switch back use the auto-backup slot under Settings → Layout`) }),
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
      setNotice({ ok: false, msg: tx("这个模板读不出目标与步骤（可能是已下架的旧形态），请在 AI 助手里重新生成一份", "This template has no readable goal or steps (likely a retired older shape) — regenerate one in the AI assistant") });
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
      ? { ok: false, msg: tx(`已填入输入框（未发送）。但这几步本机没有对应工具：${unknown.join("、")}——先改掉或删掉，否则 Agent 会在这几步上撞 unknown_tool`, `Filled into the input box (not sent). But these steps have no local tool: ${unknown.join(", ")} — edit or drop them first, or the Agent will hit unknown_tool there`) }
      : { ok: true, msg: tx("任务模板已填入 AI 助手输入框（还没有发送）", "Task template filled into the AI assistant's input box (not sent yet)") });
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
    console.info("[plugin batch export]", res.json);
    setNotice({ ok: true, msg: tx(`${res.msg}（JSON 已复制到剪贴板/控制台）`, `${res.msg} (JSON copied to the clipboard / console)`) });
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
      msg: on
        ? tx(`批量启用完成 ${ok} 个${skipped.length ? `；跳过 ${skipped.length} 个（${skipped[0]}）` : ""}`, `Batch enable done for ${ok}${skipped.length ? `; skipped ${skipped.length} (${skipped[0]})` : ""}`)
        : tx(`批量停用完成 ${ok} 个${skipped.length ? `；跳过 ${skipped.length} 个（${skipped[0]}）` : ""}`, `Batch disable done for ${ok}${skipped.length ? `; skipped ${skipped.length} (${skipped[0]})` : ""}`),
    });
  };
  const doBatchUninstall = () => {
    const names = [...sel].map((id) => plugins.find((x) => x.pkg.id === id)?.pkg.name ?? id);
    if (!window.confirm(tx(
      `卸载选中的 ${names.length} 个插件？历史版本将一并删除。\n${names.join("、")}`,
      `Uninstall the ${names.length} selected plugins? Their history versions go too.\n${names.join(", ")}`,
    ))) return;
    let ok = 0;
    for (const id of sel) if (uninstall(id).ok) ok++;
    setNotice({ ok: true, msg: tx(`已卸载 ${ok} 个插件`, `Uninstalled ${ok} plugin(s)`) });
    setSel(new Set());
  };

  return (
    <>
      <div className="plg-head">
        <span className="plg-title">{tx("本地插件库", "Local plugin library")}</span>
        <span className="plg-sub">
          {plugins.length ? tx(`${plugins.length} 个插件`, `${plugins.length} plugin(s)`) : tx("暂无插件；由 AI 助手「保存为插件」或导入插件包", "No plugins yet — save one from the AI assistant or import a package")}
        </span>
        <div className="plg-head-actions">
          <button
            className="btn"
            onClick={requestOpenMarket}
            title={tx("打开社区插件货架：实时拉取索引，看得见来源、能力与哈希", "Open the community shelf: live index, with origin, capabilities and hashes")}
          >
            {tx("插件市场", "Plugin market")}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} title={tx("导入 uartix-plugin 包（默认停用，校验后才可启用）", "Import a uartix-plugin package (installed disabled; enable it after validation)")}>
            {tx("导入", "Import")}
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
            <button className="btn" onClick={onClose} aria-label={tx("关闭插件库", "Close the plugin library")}>
              {t("c.close")}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className={notice.ok ? "plg-notice ok" : "plg-notice err"} role="status">
          {notice.msg}
          <button className="plg-notice-x" aria-label={tx("关闭提示", "Dismiss")} onClick={() => setNotice(null)}>
            <Glyph><path d="M18 6L6 18M6 6l12 12" /></Glyph>
          </button>
        </div>
      )}

      <div className="plg-toolbar">
        <input
          className="input plg-search"
          placeholder={tx("搜索名称 / ID / 描述", "Search name / ID / description")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={tx("搜索插件", "Search plugins")}
        />
        <div className="plg-filters" role="tablist" aria-label={tx("按类型筛选", "Filter by kind")}>
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              className={`plg-fchip${filter === k ? " on" : ""}`}
              onClick={() => setFilter(k)}
              role="tab"
              aria-selected={filter === k}
            >
              {kindFilterLabel(k)}
            </button>
          ))}
        </div>
        <button
          className={`plg-fchip${selMode ? " on" : ""}`}
          title={tx("多选插件进行批量导出/启停/卸载", "Multi-select plugins to export / enable / disable / uninstall in batch")}
          onClick={() => {
            setSelMode((v) => !v);
            setSel(new Set());
          }}
        >
          {selMode ? tx("退出选择", "Exit selection") : tx("选择", "Select")}
        </button>
      </div>

      {/* 确认卡搬到 App 顶层一份了：插件库关掉也要看得见命令行发起的那条请求 */}

      {selMode && (
        <div className="plg-batch" role="group" aria-label={tx("批量操作", "Batch actions")}>
          <button className="btn" onClick={() => setSel(new Set(allVisibleIds))}>
            {tx("全选", "Select all")}
          </button>
          <button
            className="btn"
            onClick={() => setSel(new Set(allVisibleIds.filter((id) => !sel.has(id))))}
          >
            {tx("反选", "Invert")}
          </button>
          <span className="plg-batch-n">{tx(`已选 ${sel.size}`, `${sel.size} selected`)}</span>
          <span className="plg-batch-spacer" />
          <button className="btn" disabled={sel.size === 0} onClick={doBatchExport}>
            {tx("导出", "Export")}
          </button>
          <button className="btn" disabled={sel.size === 0} onClick={() => doBatchEnable(true)}>
            {tx("启用", "Enable")}
          </button>
          <button className="btn" disabled={sel.size === 0} onClick={() => doBatchEnable(false)}>
            {tx("停用", "Disable")}
          </button>
          <button className="btn danger" disabled={sel.size === 0} onClick={doBatchUninstall}>
            {tx("卸载", "Uninstall")}
          </button>
        </div>
      )}

      <div className="plg-list">
        {list.length === 0 && <div className="plg-empty">{tx("没有匹配的插件", "No plugins match")}</div>}
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
                    aria-label={tx(`选择插件 ${r.pkg.name}`, `Select ${r.pkg.name}`)}
                  />
                )}
                <button
                  className="plg-item-main"
                  onClick={() => (selMode ? toggleSel(r.pkg.id) : setDetailId(detailId === r.pkg.id ? null : r.pkg.id))}
                  title={selMode ? tx("选中/取消", "Check / uncheck") : tx("展开详情", "Expand details")}
                >
                  <KindIcon kinds={recordKinds(r)} />
                  <span className="plg-item-body">
                    <span className="plg-item-line">
                      <span className="plg-item-name">{r.pkg.name}</span>
                      <span className="plg-item-id">{r.pkg.id}</span>
                      {/* AI 生成的包要标出来，但它**不构成信任**：能力白名单之外一律拒绝，
                          这条徽标只是让人知道该多看一眼来源。 */}
                      {r.pkg.provenance?.createdBy === "agent" && (
                        <span className="plg-chip">{tx("AI 生成", "agent-made")}</span>
                      )}
                      {r.candidate && <span className="plg-chip warn">{tx(`有候选 v${r.candidate.version}`, `Update candidate v${r.candidate.version}`)}</span>}
                    </span>
                    {r.pkg.desc && <span className="plg-item-desc">{r.pkg.desc}</span>}
                  </span>
                  <span className={`plg-state s-${r.state}`}>{stateName(r.state)}</span>
                </button>
                <label className="plg-switch" title={switchTalk(r)}>
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
                    <div className="plg-notice err">
                      {tx(
                        "已隔离：多次违反 iframe 隔离约束（伪造消息/越权），卸载后重新安装可解除。",
                        "Quarantined: repeated iframe-isolation violations (spoofed messages / overreach). Uninstall and reinstall to clear it.",
                      )}
                    </div>
                  )}
                  <div className="plg-sec">{tx("能力与权限", "Capabilities and permissions")}</div>
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
                      <div className="plg-sec">{tx("逻辑模块", "Logic modules")}</div>
                      <div className="plg-notice">
                        {moduleBlock(r.pkg.id)}
                      </div>
                      {pluginToolDefsOf(r.pkg.id).length > 0 && (
                        <>
                          <div className="plg-sec">{tx("为 AI 助手提供的工具", "Tools provided to the AI assistant")}</div>
                          <div className="plg-caps">
                            {pluginToolDefsOf(r.pkg.id).map((d) => (
                              <span key={d.baseName} className="plg-chip" title={d.description}>
                                {d.baseName}
                              </span>
                            ))}
                          </div>
                          {/* P99a-F2（B3 剩余那半）：批准更新时说不清"多了哪几支工具"，
                              但模块报齐的那一刻起，这一条就有了真实答案。 */}
                          {pluginToolChangeOf(r.pkg.id) && (
                            <div className="plg-detail-dim">
                              {tx(`与上一版报上来的清单相比：${describeToolChange(pluginToolChangeOf(r.pkg.id))}`, `Compared with what the previous version reported: ${describeToolChange(pluginToolChangeOf(r.pkg.id))}`)}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}

                  <div className="plg-sec">{tx("产物与操作", "Artifacts and actions")}</div>
                  {Object.entries(r.pkg.contributions).length === 0 && <div className="plg-detail-dim">{tx("无可挂载产物", "No mountable artifacts")}</div>}
                  {Object.entries(r.pkg.contributions).map(([key, entries]) =>
                    (entries ?? []).map((it) => {
                      const kindLabel = contribName(key);
                      return (
                        <div key={it.id} className="plg-contrib-row">
                          <span className="plg-chip">{kindLabel}</span>
                          <span className="plg-ellipsis">{it.name ?? it.id}</span>
                          {key === "panels" && (
                            <button className="btn" onClick={() => openPanel(r, it.id)}>
                              {tx("加入工作区", "Add to workspace")}
                            </button>
                          )}
                          {key === "widgets" && (
                            <button className="btn" onClick={() => openWidgetFloat(r, it.id)}>
                              {tx("打开浮窗", "Open as float")}
                            </button>
                          )}
                          {key === "themes" && (
                            <span className="plg-detail-dim" title={tx("内置与插件主题同级：启用它就把它换上，原来在画那枚会被停用", "Built-in and plugin themes are peers: enabling this one replaces what's on screen and disables the previous one")}>
                              {tx("在画那一枚由它顶替", "takes over the theme on screen")}
                            </span>
                          )}
                          {key === "workspacePresets" && (
                            <button className="btn" onClick={() => applyWorkspaceLayout(r, it.entry)}>
                              {tx("应用此布局", "Apply this layout")}
                            </button>
                          )}
                          {key === "workflows" && (
                            <button className="btn" onClick={() => void loadTemplate(r, it.entry)}>
                              {tx("载入 AI 助手", "Load into the AI assistant")}
                            </button>
                          )}
                        </div>
                      );
                    }),
                  )}
                  {deprecatedContribKeys(r.pkg).length > 0 && (
                    <div className="plg-detail-dim" role="status">
                      {tx(
                        `这个包里还有已下架的产物形态（${deprecatedContribKeys(r.pkg).join("、")}）：它不会出现在任何运行时里，请在 AI 助手里重新生成（动效预设已并入主题、报告视图已并入面板）`,
                        `This package still carries retired artifact kinds (${deprecatedContribKeys(r.pkg).join(", ")}): they never load, so regenerate them in the AI assistant (motion presets folded into themes, report views folded into panels)`,
                      )}
                    </div>
                  )}

                  {r.pkg.settingsSchema && r.pkg.settingsSchema.length > 0 && (
                    <>
                      <div className="plg-sec">{tx("配置", "Configuration")}</div>
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

                  <div className="plg-sec">{tx("版本", "Versions")}</div>
                  <div className="plg-detail-dim">
                    {tx(`当前 v${r.pkg.version}；历史 ${r.versions.length} 个`, `Current v${r.pkg.version}; ${r.versions.length} in history`)}
                    {r.versions.length > 0 && r.versions[r.versions.length - 1] && (
                      <>{tx(`（可回滚到 v${r.versions[r.versions.length - 1].version}）`, `(can roll back to v${r.versions[r.versions.length - 1].version})`)}</>
                    )}
                  </div>

                  {r.candidate && (
                    <div className="plg-candidate">
                      <div>
                        {tx(
                          `候选 v${r.candidate.version}：批准后原子切换，当前版本入历史；失败自动回退。`,
                          `Candidate v${r.candidate.version}: approving swaps atomically and moves the current version into history; a failure rolls back on its own.`,
                        )}
                      </div>
                      <CandidateDiff cur={r.pkg} cand={r.candidate} />
                      <div className="plg-candidate-actions">
                        <button className="btn primary" onClick={() => setNotice(approveUpdate(r.pkg.id))}>
                          {tx("批准更新", "Approve update")}
                        </button>
                        <button className="btn" onClick={() => setNotice(rejectUpdate(r.pkg.id))}>
                          {tx("拒绝", "Reject")}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="plg-actions">
                    <button className="btn" onClick={() => doExport(r)} title={tx("导出为 uartix-plugin 包 JSON（不含配置值与秘密）", "Export as a uartix-plugin package JSON (no config values or secrets)")}>
                      {tx("导出", "Export")}
                    </button>
                    <button className="btn" onClick={() => setNotice(duplicate(r.pkg.id))} title={tx("另存副本（避开覆盖批准）", "Save a copy (so the approval isn't overwritten)")}>
                      {t("c.copy")}
                    </button>
                    <button
                      className="btn"
                      disabled={r.versions.length === 0}
                      onClick={() => setNotice(rollback(r.pkg.id))}
                      title={tx("回滚到上一版本（不承诺撤销设备效果）", "Roll back to the previous version (device side effects are not undone)")}
                    >
                      {tx("回滚", "Roll back")}
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => {
                        if (!window.confirm(tx(`卸载「${r.pkg.name}」？历史版本将一并删除。`, `Uninstall “${r.pkg.name}”? Its history versions go too.`))) return;
                        setNotice(uninstall(r.pkg.id));
                        setDetailId(null);
                      }}
                    >
                      {tx("卸载", "Uninstall")}
                    </button>
                  </div>

                  <div className="plg-meta">
                    {r.pkg.provenance.createdBy === "agent"
                      ? tx("AI 生成", "AI-generated")
                      : r.pkg.provenance.createdBy === "import"
                        ? tx("导入", "Imported")
                        : tx("本地创建", "Created locally")}
                    {" · "}hostApi {r.pkg.hostApi}
                    {r.pkg.provenance.sourceExtId
                      ? tx(` · 来源扩展 ${r.pkg.provenance.sourceExtId.slice(0, 8)}`, ` · from extension ${r.pkg.provenance.sourceExtId.slice(0, 8)}`)
                      : ""}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="plg-foot">
        {tx(`能力白名单（${PLUGIN_CAPS.length} 项）之外的声明一律拒绝；导入的插件一律默认停用；作者自报的可信标记不构成信任。`, `Anything outside the capability allowlist (${PLUGIN_CAPS.length} entries) is rejected; imported plugins start disabled; an author's own trust claims earn no trust.`)}
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
        aria-label={tx("本地插件库", "Local plugin library")}
        onClick={(e) => e.stopPropagation()}
      >
        <PluginManagerBody onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
