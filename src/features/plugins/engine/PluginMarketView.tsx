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
import { useEffect, useRef, useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import { readmeImagesForRepo, repoCover, searchPlugins } from "./marketClient";
import { coverGradient, coverHue, coverInitials } from "./marketCover";
import { PLUGIN_TOPIC, hasPluginTopic, type GhRepo } from "./ghSearch";

/** 一枚卡片的状态机。`error` 带原因，因为"装不上"和"网断了"要分开说。 */
type RowState =
  | { kind: "idle" }
  | { kind: "working"; step: "download" | "unpack" | "plan" }
  | { kind: "failed"; msg: string };

export interface PluginMarketViewProps {
  onInstall: (repo: GhRepo) => Promise<void>;
  /** 已经装着的仓库（`owner/name` → 版本），用来把按钮换成「已安装」。 */
  installed: Record<string, string>;
}

const fmtStars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** `2026-10-23T…` → `10-23`。只用来扫一眼"多久没动"，不做本地化。 */
const fmtDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]}` : "";
};

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
  version?: string;
  cover?: string;
  onBack: () => void;
  onInstall: (repo: GhRepo) => Promise<void>;
}) {
  useLocale();
  const { repo } = props;
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
        {props.version ? (
          <span style={{ color: "var(--ok)", fontSize: "var(--fs-sm)" }}>{tx(`已安装 v${props.version}`, `installed v${props.version}`)}</span>
        ) : (
          <button className="btn primary" disabled={installing} onClick={() => void install()}>
            {installing ? tx("准备安装…", "Preparing…") : tx("安装…", "Install…")}
          </button>
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
          {repo.topics.slice(0, 6).map((t) => <span key={t} style={{ color: "var(--text-faint)" }}>#{t}</span>)}
        </div>
        <p style={{ margin: 0, fontSize: "var(--fs-sm)", lineHeight: 1.65 }}>{repo.description || tx("（没有描述）", "(no description)")}</p>
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
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
        version={installed[selected.full]}
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
            {tx(`共 ${total} 个结果，显示前 ${repos.length} 个`, `${total} results, showing first ${repos.length}`)}
          </div>
        ) : null}

        <div className="plg-mkt-grid">
          {(repos ?? []).map((repo) => {
            const st = rows[repo.full] ?? { kind: "idle" };
            const ver = installed[repo.full];
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

                  <div className="plg-mkt-meta">
                    <span>★ {fmtStars(repo.stars)}</span>
                    <span>{fmtDate(repo.updated)}</span>
                    {repo.topics.slice(0, 2).map((t) => (
                      <span key={t} style={{ color: "var(--text-dim)" }}>
                        #{t}
                      </span>
                    ))}
                    <div style={{ flex: "1 1 auto" }} />
                    {ver ? (
                      <span style={{ color: "var(--ok)" }}>{tx(`已安装 v${ver}`, `installed v${ver}`)}</span>
                    ) : st.kind === "working" ? (
                      <span style={{ color: "var(--text-dim)" }}>{stepLabel(st.step)}</span>
                    ) : (
                      <button className="btn" onClick={(e) => { e.stopPropagation(); void install(repo); }}>
                        {st.kind === "failed" ? tx("重试", "Retry") : tx("安装…", "Install…")}
                      </button>
                    )}
                  </div>

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
