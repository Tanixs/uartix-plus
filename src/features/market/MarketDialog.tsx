/**
 * P99b-N2：插件市场货架页（发现 / 收藏 / 已装）。
 *
 * 形状照参照物（dsh-market 那类社区货架），但有四条是我们自己的判断：
 *  1. **打开这一页才联网**（组件挂载即拉一次；启动路径零外发，见 `marketStore` 头注）；
 *  2. 拉不到就显示失败页 + 真因 + 重试，**不拿上一份清单当现状**；
 *  3. 索引里被剔除的条目要在页面上数得出来（"少了三支"不能变成静默）；
 *  4. 本页当前只浏览与收藏：没有安装按钮（安装链在 N4，装了个假按钮比没有更坏）。
 *
 * 卡片与详情的每一个字都由 `marketBrowse.cardFacts` 从索引派生——本文件里出现任何
 * 具体条目名/URL 都是 bug（`marketUi.test.ts` 反向钉死了这条）。
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePlugins } from "../plugins/pluginStore";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { useLocale } from "../../i18n/strings";
import { compareInstall, type MarketEntry } from "./marketIndex";
import {
  browseEntries, cardFacts, emptyTalk, facetCategories, MARKET_BROWSE_ONLY, MARKET_NO_ENDORSE,
  MARKET_SORTS, MARKET_TABS, missingFavorites, shelfLine, SORT_LABEL, TAB_LABEL,
  type BrowseInput, type MarketCard, type MarketSort, type MarketTab,
} from "./marketBrowse";
import { clearMissingFavorites, refreshIndex, toggleFavorite, useMarket } from "./marketStore";
import { MarketDetail } from "./MarketDetail";

/** 收藏按钮就用两个字，不用字符图标（§8-25）；详情按钮同理 */
const BTN_FAV_ON = "已收藏";
const BTN_FAV_OFF = "收藏";

function FavButton({ card, onToggle }: { card: MarketCard; onToggle: (id: string) => void }) {
  return (
    <button
      className={`mkt-favbtn${card.favorite ? " on" : ""}`}
      aria-pressed={card.favorite}
      title={card.favorite ? `取消收藏「${card.name}」` : `收藏「${card.name}」`}
      onClick={() => onToggle(card.id)}
    >
      {card.favorite ? BTN_FAV_ON : BTN_FAV_OFF}
    </button>
  );
}

function MarketCardView({ card, onOpen, onToggle }: { card: MarketCard; onOpen: (id: string) => void; onToggle: (id: string) => void }) {
  return (
    <article className={`mkt-card${card.grayed ? " dim" : ""}`} aria-label={card.name}>
      <div className="mkt-card-top">
        <button className="mkt-card-open" onClick={() => onOpen(card.id)} title="看详情、能力与来源">
          <span className="mkt-card-name">{card.name}</span>
          <span className="mkt-card-id">{card.id}</span>
        </button>
        <FavButton card={card} onToggle={onToggle} />
      </div>
      <div className="mkt-card-chips">
        <span className="plg-chip">{card.category}</span>
        <span className="plg-chip">v{card.version}</span>
        <span className={`plg-chip${card.install === "update" ? " warn" : ""}`}>{card.installText}</span>
        {card.verified && (
          <span className="plg-chip" title="这条标记只说明它通过了索引生成脚本的校验，不代表内容经过审核">
            货架标记
          </span>
        )}
      </div>
      <p className="mkt-card-desc">{card.description}</p>
      {card.caps.length > 0 && (
        <div className="mkt-card-chips">
          {card.caps.map((c) => (
            <span key={c.id} className={`plg-chip${c.blocked ? " warn" : ""}`} title={c.note}>
              {c.name}
            </span>
          ))}
        </div>
      )}
      <div className="mkt-card-foot">
        <span className="mkt-dim">
          作者 {card.author} · 更新于 {card.updated} · {card.sizeText}
        </span>
        <button className="btn" onClick={() => onOpen(card.id)} title="看详情、能力与来源">
          详情
        </button>
      </div>
      {card.grayed && <div className="mkt-dim">{card.compatText}（minAppVersion 高于本机），列在这里但不假装能装。</div>}
    </article>
  );
}

export function MarketDialog({ onClose }: { onClose: () => void }) {
  const mkt = useMarket();
  const { plugins } = usePlugins();
  const lang = useLocale();
  const [tab, setTab] = useState<MarketTab>("discover");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<MarketSort>("updated");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showDropped, setShowDropped] = useState(false);

  /** 打开这一页才发第一个请求（不自动联网口径的执行点） */
  useEffect(() => {
    if (mkt.status === "idle") void refreshIndex();
  }, [mkt.status]);

  /** Esc：先收详情，再关窗口——两层弹层要有一层一层的退法 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (detailId) setDetailId(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailId, onClose]);

  const localVersions = useMemo(() => new Map(plugins.map((r) => [r.pkg.id, r.pkg.version])), [plugins]);
  const index = mkt.index;

  /** 浏览输入＝派生层的唯一入参：本机组件不自己算任何字段，交给 `marketBrowse` */
  const browseInput = useMemo<BrowseInput>(
    () => ({
      index,
      tab,
      query,
      category,
      sort,
      lang,
      appVersion: mkt.appVersion,
      favorites: mkt.favorites,
      installOf: (e) => compareInstall(e, localVersions.get(e.id)),
    }),
    [index, tab, query, category, sort, lang, mkt.appVersion, mkt.favorites, localVersions],
  );

  const cards = useMemo(
    () => (index ? browseEntries(browseInput).map((e) => cardFacts(index, e, browseInput)) : []),
    [index, browseInput],
  );

  /** 分类计数用「不吃分类筛选」的范围，否则选了某一类后别的桶看着像空了 */
  const facets = useMemo(
    () => (index ? facetCategories(index, browseEntries({ ...browseInput, category: "all" })) : []),
    [index, browseInput],
  );

  const offShelf = useMemo(() => {
    if (!index) return [];
    const shelf = new Set(index.entries.map((e) => e.id));
    return plugins.filter((r) => !shelf.has(r.pkg.id)).map((r) => r.pkg.name);
  }, [index, plugins]);

  const dropped = index?.dropped ?? [];
  const missing = missingFavorites(index, mkt.favorites);
  const detailEntry: MarketEntry | null = detailId ? (index?.entries.find((e) => e.id === detailId) ?? null) : null;
  const empty = index ? emptyTalk(browseInput, cards.length) : null;

  const doRefresh = () => {
    void refreshIndex().then((s) => {
      const gone = detailId && s.index && !s.index.entries.some((e) => e.id === detailId);
      if (gone) setDetailId(null);
      setNotice(
        s.status === "failed"
          ? { ok: false, msg: s.error }
          : gone
            ? { ok: false, msg: "详情里那条已经不在最新索引里了（下架或被剔除），已退回列表" }
            : { ok: true, msg: `已刷新：${s.index ? `${s.index.entries.length} 条` : "空"}` },
      );
    });
  };

  const doToggle = (id: string) => {
    const r = toggleFavorite(id);
    setNotice({ ok: true, msg: r.added ? "已加入收藏（收藏存在本机，不上传）" : "已从收藏移除" });
  };

  return createPortal(
    <div className="plg-overlay" role="presentation" onClick={onClose}>
      <div className="plg-dialog" role="dialog" aria-modal="true" aria-label="插件市场" onClick={(e) => e.stopPropagation()}>
        <div className="plg-head">
          <span className="plg-title">插件市场</span>
          <span className="plg-sub">
            {mkt.status === "ready" && index
              ? shelfLine(index, { viaMirror: mkt.viaMirror, elapsedMs: mkt.elapsedMs })
              : mkt.status === "loading"
                ? "正在拉取索引…"
                : mkt.status === "failed"
                  ? "拉不到索引"
                  : "尚未拉取"}
          </span>
          <div className="plg-head-actions">
            <button className="btn" onClick={doRefresh} title="重新拉取索引（不内置快照，拉不到就报错）">
              {mkt.status === "loading" ? "拉取中" : "刷新"}
            </button>
            <button className="btn" onClick={onClose} aria-label="关闭插件市场">
              关闭
            </button>
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
            placeholder="搜索名称 / ID / 作者 / 说明 / 分类"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索插件市场"
          />
          <select className="input mkt-sort" value={sort} onChange={(e) => setSort(e.target.value as MarketSort)} aria-label="排序方式">
            {MARKET_SORTS.map((s) => (
              <option key={s} value={s}>{SORT_LABEL[s]}</option>
            ))}
          </select>
        </div>

        <div className="plg-toolbar mkt-tabs" role="tablist" aria-label="市场页签">
          {MARKET_TABS.map((t) => (
            <button
              key={t}
              className={`plg-fchip${tab === t ? " on" : ""}`}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
              {t === "favorites" && mkt.favorites.length > 0 ? ` ${mkt.favorites.length}` : ""}
            </button>
          ))}
        </div>

        {mkt.status === "failed" && (
          <div className="mkt-fail" role="alert">
            <div className="mkt-fail-msg">{mkt.error}</div>
            <div className="mkt-dim">
              索引地址：<code>{getSettings().marketIndexUrl || "/market/index.json"}</code>
              {mkt.viaMirror ? "（本次试过镜像）" : ""}
            </div>
            <div className="mkt-dim">
              这里不放一份"上次成功的清单"当现状：货架是会长大的东西，过期答案不是降级，是错误。
            </div>
            <div className="mkt-dim">
              索引地址与镜像前缀的设置项还没做进设置页（下一批补），所以现在这个地址改不了——拉不到就先按上面的原因查网络。
            </div>
            <button className="btn primary" onClick={doRefresh}>重试</button>
          </div>
        )}

        {mkt.status === "ready" && index && (
          <div className="plg-toolbar mkt-cats">
            <button className={`plg-fchip${category === "all" ? " on" : ""}`} onClick={() => setCategory("all")} title="取消分类筛选">
              全部
            </button>
            {facets.map((f) => (
              <button
                key={f.id}
                className={`plg-fchip${category === f.id ? " on" : ""}`}
                disabled={f.count === 0}
                onClick={() => setCategory(f.id)}
                title={f.count === 0 ? "这一类当前页签里没有条目" : `${f.count} 条`}
              >
                {f.label} {f.count}
              </button>
            ))}
            {dropped.length > 0 && (
              <button className="plg-fchip mkt-dropped" onClick={() => setShowDropped((v) => !v)} title="索引里被校验剔掉的条目与原因">
                被剔除 {dropped.length} 条
              </button>
            )}
          </div>
        )}

        {showDropped && dropped.length > 0 && (
          <ul className="mkt-dropped-list">
            {dropped.map((d) => (
              <li key={d.id}>
                <code>{d.id}</code> · {d.reason}
              </li>
            ))}
          </ul>
        )}

        <div className="plg-list mkt-list">
          {mkt.status === "ready" && tab === "favorites" && missing.length > 0 && (
            <div className="mkt-missing">
              <span className="mkt-dim">收藏里有 {missing.length} 条已经不在架上了：{missing.join("、")}</span>
              <button
                className="btn"
                onClick={() => {
                  const r = clearMissingFavorites();
                  setNotice({ ok: true, msg: `已清掉 ${r.removed} 条下架收藏（在架的没动）` });
                }}
              >
                清除下架收藏
              </button>
            </div>
          )}
          {mkt.status === "ready" && tab === "installed" && offShelf.length > 0 && (
            <div className="mkt-offshelf">
              本机插件库另有 {offShelf.length} 个包不在这份索引里（{offShelf.slice(0, 3).join("、")}
              {offShelf.length > 3 ? " 等" : ""}）。市场只按 id 对照，不猜哪个对应哪个；启停与卸载去插件库看。
            </div>
          )}
          {cards.map((c) => (
            <MarketCardView key={c.id} card={c} onOpen={setDetailId} onToggle={doToggle} />
          ))}
          {mkt.status === "ready" && empty && <div className="plg-empty">{empty.text}</div>}
        </div>

        {mkt.status === "ready" && (
          <div className="plg-notice" role="status">
            {MARKET_BROWSE_ONLY}
          </div>
        )}

        <div className="plg-foot">{MARKET_NO_ENDORSE}</div>

        {detailEntry && index && (
          <MarketDetail entry={detailEntry} index={index} ctx={browseInput} onClose={() => setDetailId(null)} onToggleFavorite={doToggle} />
        )}
      </div>
    </div>,
    document.body,
  );
}
