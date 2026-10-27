/**
 * P174-A14：插件市场的浏览面（GitHub 话题检索）。
 *
 * 设计取向：**不是弹窗，是同一块面板的另一个视图**。
 * 弹窗的问题是一次只能做一件事（看完得关掉、装完又得打开），而"搜 → 看 → 装 → 启用"
 * 是一条连续的活。切视图还能保住下面的批准卡：装完直接落到「已安装」那一栏的批准条上。
 *
 * 视觉上刻意克制：卡片是**信息密度**的容器，不是装饰品——一枚插件只有"它是什么、
 * 谁写的、多久没动、能不能装"四件事要说，多于这些的都不放。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import { readmeImagesForRepo, repoCover, repoManifest, searchPlugins, type RepoManifestInfo } from "./marketClient";
import { coverGradient, coverHue, coverInitials } from "./marketCover";
import { PLUGIN_TOPIC, hasPluginTopic, type GhRepo } from "./ghSearch";
import {
  filterRepos,
  installedNote,
  marketStateOf,
  sortRepos,
  type MarketFilter,
  type MarketInstalled,
  type MarketSort,
  type MarketState,
} from "./marketStatus";

/** 一枚卡片的状态机。`error` 带原因，因为"装不上"和"网断了"要分开说。 */
type RowState =
  | { kind: "idle" }
  | { kind: "working"; step: "download" | "unpack" | "plan" }
  | { kind: "failed"; msg: string };

export interface PluginMarketViewProps {
  onInstall: (repo: GhRepo) => Promise<void>;
  /** 已经装着的仓库（`owner/name` → 版本与启停/批准态），用来把按钮换成「已安装 / 更新」。 */
  installed: Record<string, MarketInstalled>;
}

const fmtStars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** `2026-10-23T…` → `10-23`。只用来扫一眼"多久没动"，不做本地化。 */
const fmtDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]}` : "";
};

/** 卡片与详情共用的一句状态话术：判据在 `marketStatus`，话术在这里过 `tx()`。 */
function stateText(state: MarketState, inst: MarketInstalled | undefined, remote: string): string {
  const v = inst?.version ?? "";
  if (state === "absent") return tx("未安装", "not installed");
  if (state === "updatable") return tx(`可更新 v${v} → v${remote}`, `update v${v} → v${remote}`);
  if (state === "behind") return tx(`已安装 v${v}（比仓库还新）`, `installed v${v} (ahead of the repo)`);
  return tx(`已安装 v${v}`, `installed v${v}`);
}

/** 已装但还没到"能用"的那一步：市场里就说实话，别让用户回去翻插件管理才知道。 */
function noteText(inst: MarketInstalled): string {
  const n = installedNote(inst);
  if (n === "unapproved") return tx("权限待批准", "approval pending");
  if (n === "disabled") return tx("已停用", "disabled");
  return "";
}

function kindTexts(k: RepoManifestInfo["kinds"]): string[] {
  const out: string[] = [];
  if (k.panels > 0) out.push(tx(`面板 ×${k.panels}`, `panels ×${k.panels}`));
  if (k.themes > 0) out.push(tx(`主题 ×${k.themes}`, `themes ×${k.themes}`));
  if (k.widgets > 0) out.push(tx(`小部件 ×${k.widgets}`, `widgets ×${k.widgets}`));
  if (k.presets > 0) out.push(tx(`预设 ×${k.presets}`, `presets ×${k.presets}`));
  if (k.tasks > 0) out.push(tx(`任务 ×${k.tasks}`, `tasks ×${k.tasks}`));
  if (k.commands > 0) out.push(tx(`命令 ×${k.commands}`, `commands ×${k.commands}`));
  return out;
}

/** 一项声明最多列四条，剩下的收成 `…+N`：预告是给人扫一眼的，不是把清单抄一遍。 */
function listed(v: string[]): string {
  const head = v.slice(0, 4).join("、");
  return v.length > 4 ? `${head} …+${v.length - 4}` : head;
}

/**
 * 权限预告。装**之前**就把清单声明的能力面摊开——以前这些要等下载解包后在批准卡上才第一次看见，
 * 而"我先看看它要什么再决定装不装"正是市场该有的动作。
 *
 * 它只是预告：真判据仍是下载后的 `planFolder()` + 批准卡，这里读到什么都不放行。
 */
function permTexts(p: RepoManifestInfo["perms"]): string[] {
  const out: string[] = [];
  if (p.read.length) out.push(tx(`读：${listed(p.read)}`, `read: ${listed(p.read)}`));
  if (p.write.length) out.push(tx(`写：${listed(p.write)}`, `write: ${listed(p.write)}`));
  if (p.spawn.length) out.push(tx(`起子进程：${listed(p.spawn)}`, `spawn: ${listed(p.spawn)}`));
  if (p.connect.length) out.push(tx(`联网：${listed(p.connect)}`, `connect: ${listed(p.connect)}`));
  if (p.ui.length) out.push(tx(`界面：${listed(p.ui)}`, `ui: ${listed(p.ui)}`));
  if (p.secrets.length) out.push(tx(`密钥：${listed(p.secrets)}`, `secrets: ${listed(p.secrets)}`));
  if (p.ai.length) out.push(tx(`AI：${listed(p.ai)}`, `ai: ${listed(p.ai)}`));
  return out;
}

/** 外链一律交给系统浏览器：WebView 里导航出去就回不来，也等于把会话上下文交给别人。 */
function openExternal(url: string): Promise<void> {
  return import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
}

const FILTERS: { id: MarketFilter; label: () => string }[] = [
  { id: "all", label: () => tx("全部", "All") },
  { id: "absent", label: () => tx("没装过", "Not installed") },
  { id: "installed", label: () => tx("已安装", "Installed") },
  { id: "updatable", label: () => tx("可更新", "Updatable") },
];

const SORTS: { id: MarketSort; label: () => string }[] = [
  { id: "updated", label: () => tx("最近更新", "Recently updated") },
  { id: "stars", label: () => tx("Star 多", "Most starred") },
  { id: "name", label: () => tx("名称", "Name") },
];

/** 左栏封面砖：有 cover 显示 cover，没有就按仓库名生成一枚色块，绝不出现破图。 */
function RepoCover({ repo, cover }: { repo: GhRepo; cover?: string }) {
  const hue = coverHue(repo.full);
  return (
    <span className="plg-mkt-cover" aria-hidden="true">
      {cover ? (
        <img src={cover} alt="" loading="lazy" />
      ) : (
        <span className="plg-mkt-ph" style={{ background: coverGradient(hue) }}>
          {coverInitials(repo.name)}
        </span>
      )}
    </span>
  );
}

function RepoDetail(props: {
  repo: GhRepo;
  inst?: MarketInstalled;
  /** 仓库那份 plugin.json 的摘要；null = 还没读到或读不到（这时不猜"可更新"） */
  remote?: RepoManifestInfo | null;
  cover?: string;
  onBack: () => void;
  onInstall: (repo: GhRepo) => Promise<void>;
}) {
  useLocale();
  const { repo } = props;
  const state = marketStateOf(props.inst, props.remote?.version ?? "");
  const [imgs, setImgs] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [slide, setSlide] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setSlide(0);
    readmeImagesForRepo(repo)
      .then((x) => {
        if (alive) setImgs(x);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [repo]);

  async function install(): Promise<void> {
    setInstalling(true);
    setErr("");
    try {
      await props.onInstall(repo);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setInstalling(false);
    }
  }

  // 封面放第一张：它是这个包"长什么样"的官方答案；README 图只是补充。
  const slides = props.cover ? [props.cover, ...imgs.filter((x) => x !== props.cover)] : imgs;
  const img = slides[slide];
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--sp-2)", padding: "var(--sp-2) var(--sp-3)", borderBottom: "1px solid var(--border)", flex: "0 0 auto" }}>
        <button className="btn" onClick={props.onBack}>{tx("← 返回市场", "← Back to market")}</button>
        <span style={{ fontWeight: 600 }}>{repo.name}</span>
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>{repo.full}</span>
        <span style={{ flex: 1 }} />
        {state === "absent" || state === "updatable" ? (
          <button className="btn primary" disabled={installing} onClick={() => void install()}>
            {installing
              ? tx("准备安装…", "Preparing…")
              : state === "updatable"
                ? tx(`更新到 v${props.remote?.version ?? ""}`, `Update to v${props.remote?.version ?? ""}`)
                : tx("安装…", "Install…")}
          </button>
        ) : (
          <span style={{ color: "var(--ok)", fontSize: "var(--fs-sm)" }}>
            {stateText(state, props.inst, props.remote?.version ?? "")}
          </span>
        )}
      </div>

      <div style={{ padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <div style={{ position: "relative", border: "1px solid var(--border)", borderRadius: "var(--radius-m)", background: "var(--bg-inset)", minHeight: 220, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {img ? (
            <img src={img} alt="" style={{ display: "block", width: "100%", maxHeight: 380, objectFit: "contain" }} loading="lazy" />
          ) : busy ? (
            <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>{tx("正在读 README 预览…", "Reading README previews…")}</span>
          ) : (
            <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--sp-2)" }}>
              <span
                className="plg-mkt-ph"
                aria-hidden="true"
                style={{
                  width: 168,
                  height: 112,
                  borderRadius: "var(--radius-m)",
                  background: coverGradient(coverHue(repo.full)),
                }}
              >
                {coverInitials(repo.name)}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
                {tx("这个仓库没有上传封面，也没有 README 预览图", "This repo has no cover and no README preview image")}
              </span>
            </span>
          )}
          {slides.length > 1 ? (
            <>
              <button className="btn" style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)" }} onClick={() => setSlide((n) => (n - 1 + slides.length) % slides.length)} aria-label={tx("上一张", "Previous")}>‹</button>
              <button className="btn" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }} onClick={() => setSlide((n) => (n + 1) % slides.length)} aria-label={tx("下一张", "Next")}>›</button>
              <span style={{ position: "absolute", right: 10, bottom: 8, fontSize: "var(--fs-xs)", color: "var(--text-dim)", background: "color-mix(in srgb, var(--bg-panel) 80%, transparent)", padding: "1px 6px", borderRadius: "var(--radius-pill)" }}>{slide + 1} / {slides.length}</span>
            </>
          ) : null}
        </div>
        {slides.length > 1 ? (
          <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
            {slides.map((_, i) => (
              <button key={i} onClick={() => setSlide(i)} aria-label={tx(`第 ${i + 1} 张`, `Image ${i + 1}`)} style={{ width: 7, height: 7, padding: 0, border: "none", borderRadius: "50%", cursor: "pointer", background: i === slide ? "var(--accent)" : "var(--border)" }} />
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap", fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
          <span>★ {fmtStars(repo.stars)}</span>
          <span>{fmtDate(repo.updated)}</span>
          {repo.archived ? <span style={{ color: "var(--warn)" }}>{tx("已归档", "archived")}</span> : null}
          {hasPluginTopic(repo) ? <span style={{ color: "var(--ok)" }}>#{PLUGIN_TOPIC}</span> : null}
          {/* 话题徽章已经说过 #uartix-plugin，列表里再列一遍是同一件事说两遍 */}
          {repo.topics.filter((t) => t !== PLUGIN_TOPIC).slice(0, 6).map((t) => <span key={t} style={{ color: "var(--text-faint)" }}>#{t}</span>)}
        </div>
        <p style={{ margin: 0, fontSize: "var(--fs-sm)", lineHeight: 1.65 }}>{repo.description || tx("（没有描述）", "(no description)")}</p>

        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--sp-2)", fontSize: "var(--fs-xs)" }}>
          <span style={{ color: state === "updatable" ? "var(--warn)" : state === "absent" ? "var(--text-faint)" : "var(--ok)" }}>
            {stateText(state, props.inst, props.remote?.version ?? "")}
          </span>
          {props.inst ? <span style={{ color: "var(--warn)" }}>{noteText(props.inst)}</span> : null}
          {props.remote ? kindTexts(props.remote.kinds).map((k) => <span key={k} style={{ color: "var(--text-dim)" }}>{k}</span>) : null}
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => void openExternal(repo.htmlUrl)}>{tx("在 GitHub 打开", "Open on GitHub")}</button>
        </div>

        {props.remote && permTexts(props.remote.perms).length ? (
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-m)", background: "var(--bg-inset)", padding: "8px 10px" }}>
            <div style={{ fontSize: "var(--fs-xs)", fontWeight: 600, color: "var(--text-dim)", marginBottom: 4 }}>
              {tx("它声明的能力面", "What it asks for")}
            </div>
            <ul style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 2, fontSize: "var(--fs-xs)", color: "var(--text-dim)", lineHeight: 1.6 }}>
              {permTexts(props.remote.perms).map((p) => <li key={p}>{p}</li>)}
            </ul>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)", marginTop: 6, lineHeight: 1.6 }}>
              {tx(
                "这是清单里的声明，装之前先看清；真正放行与否仍以下载解包后那张批准卡为准。",
                "These are the manifest's declarations, shown before you install. What actually runs is still decided by the approval card after the package is downloaded and validated.",
              )}
            </div>
          </div>
        ) : props.remote ? (
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>{tx("这份清单没有声明任何能力面。", "This manifest declares no capabilities.")}</div>
        ) : null}

        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{repo.htmlUrl}</div>
        {err ? <div style={{ color: "var(--danger)", fontSize: "var(--fs-sm)" }}>{err}</div> : null}
      </div>
    </div>
  );
}

export function PluginMarketView({ onInstall, installed }: PluginMarketViewProps) {
  useLocale(); // 切语言时整块重渲染（话术全在 tx() 里）
  const [text, setText] = useState("");
  const [onlyTopic, setOnlyTopic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [rateLimited, setRateLimited] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<GhRepo | null>(null);
  /** `owner/name` → 仓库那份清单的摘要。只为"已装的"与"正打开的"取，见下面的 effect。 */
  const [manifests, setManifests] = useState<Record<string, RepoManifestInfo | null>>({});
  const [filter, setFilter] = useState<MarketFilter>("all");
  const [sort, setSort] = useState<MarketSort>("updated");
  const seq = useRef(0);
  /** 已经取过清单的 `full@updated`：翻页/重搜不重复打 API，仓库更新了才算新的一轮。 */
  const seen = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const stateOf = (repo: GhRepo): MarketState =>
    marketStateOf(installed[repo.full], manifests[repo.full]?.version ?? "");

  /**
   * 远端版本按需取：**只读已装的那几枚 + 当前打开的那一枚**。
   *
   * 一次搜索 30+ 枚仓库，全读的话未登录 10 次/分钟立刻见底，而且绝大多数仓库用户根本
   * 不关心它比本机新还是旧。已装集合是用户自己的小数目，这笔额度算得过来。
   */
  useEffect(() => {
    if (!repos?.length) return;
    const want = repos.filter((r) => installed[r.full] || selected?.full === r.full);
    if (!want.length) return;
    let alive = true;
    for (const r of want) {
      const key = `${r.full}@${r.updated}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      void repoManifest(r).then((m) => {
        if (!alive) return;
        setManifests((x) => ({ ...x, [r.full]: m }));
      });
    }
    return () => {
      alive = false;
    };
    // manifests 不进依赖：它是这个 effect 自己写的东西，进依赖就是自激循环。
    // 去重靠 seen（按 full@updated）：仓库更新了才会再取一次，重搜/翻页不重复打 API。
  }, [repos, installed, selected]);

  const shown = useMemo(
    () => sortRepos(filterRepos(repos ?? [], filter, (r) => marketStateOf(installed[r.full], manifests[r.full]?.version ?? "")), sort),
    [repos, filter, sort, installed, manifests],
  );

  // 封面按可见顺序补，四条并发：既不会把一屏卡片卡在"等图"上，也不至于一次打出几十个请求。
  useEffect(() => {
    if (!repos?.length) return;
    let alive = true;
    const queue = repos.slice(0, 36);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (alive && next < queue.length) {
        const repo = queue[next++];
        const url = await repoCover(repo);
        if (!alive || !url) continue;
        setCovers((c) => (c[repo.full] === url ? c : { ...c, [repo.full]: url }));
      }
    };
    void Promise.all(Array.from({ length: 4 }, worker));
    return () => {
      alive = false;
    };
  }, [repos]);

  async function run(nextText = text, nextOnly = onlyTopic) {
    const mine = ++seq.current;
    setBusy(true);
    setErr("");
    setRateLimited(false);
    try {
      const r = await searchPlugins({ text: nextText, topic: nextOnly ? PLUGIN_TOPIC : "" });
      if (mine !== seq.current) return; // 慢的那次回来了，别把新的结果盖掉
      setRepos(r.repos);
      setTotal(r.total);
      setRateLimited(r.rateLimited);
    } catch (e) {
      if (mine !== seq.current) return;
      setRepos([]);
      setTotal(0);
      setErr(String((e as Error)?.message ?? e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }

  async function install(repo: GhRepo) {
    setRows((r) => ({ ...r, [repo.full]: { kind: "working", step: "download" } }));
    try {
      await onInstall(repo);
      setRows((r) => ({ ...r, [repo.full]: { kind: "idle" } }));
    } catch (e) {
      setRows((r) => ({ ...r, [repo.full]: { kind: "failed", msg: String((e as Error)?.message ?? e) } }));
    }
  }

  if (selected) {
    return (
      <RepoDetail
        repo={selected}
        inst={installed[selected.full]}
        remote={manifests[selected.full]}
        cover={covers[selected.full]}
        onBack={() => setSelected(null)}
        onInstall={onInstall}
      />
    );
  }

  const stepLabel = (s: "download" | "unpack" | "plan") =>
    s === "download"
      ? tx("下载中…", "Downloading…")
      : s === "unpack"
        ? tx("解包中…", "Unpacking…")
        : tx("校验包…", "Validating…");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: "1 1 auto",
        borderTop: "1px solid var(--border)",
      }}
    >
      {/* 检索区 */}
      <div
        style={{
          padding: "var(--sp-3)",
          borderBottom: "1px solid var(--border)",
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "var(--sp-2)" }}>
          <span style={{ fontSize: "var(--fs-md)", fontWeight: 600 }}>{tx("插件市场", "Plugin market")}</span>
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
            {tx(
              "仓库打上 uartix-plugin 话题就会被检索到；装之前仍要过一遍权限批准卡",
              "Repos tagged with the uartix-plugin topic show up here. Installing still goes through the permission card.",
            )}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--sp-2)" }}>
          <input
            ref={inputRef}
            className="input"
            value={text}
            placeholder={tx("搜插件：yolo、串口、数据…", "Search plugins: yolo, serial, data…")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            style={{ flex: "1 1 240px", minWidth: 0 }}
          />
          <button
            className="btn"
            onClick={() => {
              const next = !onlyTopic;
              setOnlyTopic(next);
              void run(text, next);
            }}
            title={tx("只搜带 uartix-plugin 话题的仓库", "Only repos tagged uartix-plugin")}
            style={
              onlyTopic
                ? { borderColor: "var(--accent)", color: "var(--accent)" }
                : { color: "var(--text-dim)" }
            }
          >
            #{PLUGIN_TOPIC}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void run()}>
            {busy ? tx("检索中…", "Searching…") : tx("搜索", "Search")}
          </button>
        </div>

        {/* 结果内筛选与排序：都只动"已经搜出来的这一批"，不再打一次 GitHub——
            市场是用户主动联网的地方，能省一次请求就省一次。 */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--sp-1)" }}>
          {FILTERS.map((f) => {
            const n = f.id === "all" ? (repos?.length ?? 0) : filterRepos(repos ?? [], f.id, stateOf).length;
            return (
              <button
                key={f.id}
                className={`btn sm${filter === f.id ? " primary" : ""}`}
                onClick={() => setFilter(f.id)}
                disabled={!repos?.length}
              >
                {f.label()}
                <span style={{ color: filter === f.id ? "inherit" : "var(--text-faint)" }}>&nbsp;{n}</span>
              </button>
            );
          })}
          <span style={{ flex: 1 }} />
          <select
            className="input"
            value={sort}
            disabled={!repos?.length}
            onChange={(e) => setSort(e.target.value as MarketSort)}
            title={tx("排序方式", "Sort order")}
            style={{ width: "auto", height: "var(--ctl-h-1)", fontSize: "var(--fs-xs)" }}
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label()}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 结果 */}
      <div style={{ overflow: "auto", flex: "1 1 auto", padding: "var(--sp-3)" }}>
        {err ? (
          <div style={{ color: "var(--danger)", fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>
            {tx("检索失败：", "Search failed: ")}
            {err}
            <div style={{ color: "var(--text-dim)", marginTop: "var(--sp-1)" }}>
              {tx(
                "常见原因：没联网、代理没配、或 GitHub 限流（未登录 10 次/分钟；在 设置 → 集成 配了 GitHub Token 会自动带上，额度更高）。",
                "Usual causes: offline, proxy not set, or GitHub rate limit (10/min unauthenticated; a GitHub Token under Settings → Integration is sent automatically for a higher quota).",
              )}
            </div>
          </div>
        ) : null}

        {rateLimited ? (
          <div style={{ color: "var(--warn)", fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>
            {tx("GitHub 限流了，等一分钟再搜（未登录每分钟 10 次）。", "GitHub rate limit hit. Wait a minute (10/min unauthenticated).")}
          </div>
        ) : null}

        {!err && !rateLimited && repos === null ? (
          <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
            {tx("输入关键词后回车；留空回车＝看看最近更新的插件。", "Type a keyword and press Enter; empty shows recently updated plugins.")}
          </div>
        ) : null}

        {!err && !rateLimited && repos && repos.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
            {onlyTopic
              ? tx("没有匹配的仓库。换个词，或关掉 #话题 搜全站（多半不是插件）。", "No match. Try another word, or turn off the topic filter.")
              : tx("没有匹配的仓库。", "No matching repos.")}
          </div>
        ) : null}

        {repos && repos.length ? (
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)", marginBottom: "var(--sp-2)" }}>
            {shown.length === repos.length
              ? tx(`共 ${total} 个结果，显示前 ${repos.length} 个`, `${total} results, showing first ${repos.length}`)
              : tx(`共 ${total} 个结果，这一批里 ${shown.length} 个符合筛选`, `${total} results, ${shown.length} of this batch match the filter`)}
          </div>
        ) : null}

        {repos?.length && !shown.length ? (
          <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
            {tx("这一批里没有符合筛选的。换个筛选项，或先「全部」。", "Nothing in this batch matches the filter. Pick another, or All.")}
          </div>
        ) : null}

        <div className="plg-mkt-grid">
          {shown.map((repo) => {
            const st = rows[repo.full] ?? { kind: "idle" };
            const inst = installed[repo.full];
            const remote = manifests[repo.full];
            const state = marketStateOf(inst, remote?.version ?? "");
            const actionable = state === "absent" || state === "updatable";
            return (
              <div key={repo.full} className="plg-mkt-card" onClick={() => setSelected(repo)}>
                <RepoCover repo={repo} cover={covers[repo.full]} />

                <div className="plg-mkt-body">
                  <div className="plg-mkt-head">
                    <span className="plg-mkt-name">{repo.name}</span>
                    {hasPluginTopic(repo) ? (
                      <span className="plg-mkt-badge" title={tx("带 uartix-plugin 话题", "tagged uartix-plugin")}>
                        plugin
                      </span>
                    ) : null}
                    {repo.archived ? (
                      <span style={{ fontSize: "var(--fs-xs)", color: "var(--warn)" }}>{tx("已归档", "archived")}</span>
                    ) : null}
                  </div>

                  <div className="plg-mkt-id">{repo.full}</div>

                  <div className="plg-mkt-desc">{repo.description || tx("（没有描述）", "(no description)")}</div>

                  {remote ? (
                    <div className="plg-mkt-kinds">
                      {kindTexts(remote.kinds).map((k) => (
                        <span key={k} className="plg-mkt-kind">{k}</span>
                      ))}
                    </div>
                  ) : null}

                  <div className="plg-mkt-meta">
                    <span>★ {fmtStars(repo.stars)}</span>
                    <span>{fmtDate(repo.updated)}</span>
                    {repo.topics.slice(0, 2).map((t) => (
                      <span key={t} style={{ color: "var(--text-dim)" }}>
                        #{t}
                      </span>
                    ))}
                    <div style={{ flex: "1 1 auto" }} />
                    {inst && !actionable ? (
                      <span style={{ color: "var(--ok)" }}>{stateText(state, inst, remote?.version ?? "")}</span>
                    ) : st.kind === "working" ? (
                      <span style={{ color: "var(--text-dim)" }}>{stepLabel(st.step)}</span>
                    ) : (
                      <button
                        className={state === "updatable" ? "btn primary" : "btn"}
                        onClick={(e) => { e.stopPropagation(); void install(repo); }}
                      >
                        {st.kind === "failed"
                          ? tx("重试", "Retry")
                          : state === "updatable"
                            ? tx(`更新到 v${remote?.version ?? ""}`, `Update to v${remote?.version ?? ""}`)
                            : tx("安装…", "Install…")}
                      </button>
                    )}
                  </div>

                  {inst && noteText(inst) ? (
                    <div className="plg-mkt-note">{noteText(inst)}</div>
                  ) : null}

                  {st.kind === "failed" ? <div className="plg-mkt-fail">{st.msg}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
