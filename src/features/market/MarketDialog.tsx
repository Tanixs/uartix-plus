/**
 * P99b-N2：插件市场货架页（发现 / 收藏 / 已装）。
 *
 * 形状照参照物（dsh-market 那类社区货架），但有四条是我们自己的判断：
 *  1. **打开这一页才联网**（组件挂载即拉一次；启动路径零外发，见 `marketStore` 头注）；
 *  2. 拉不到就显示失败页 + 真因 + 重试，**不拿上一份清单当现状**；
 *  3. 索引里被剔除的条目要在页面上数得出来（"少了三支"不能变成静默）；
 *  4. N4 起这一页有一颗按钮，但它**只发请求**：判定与落地仍是 `marketPending` 里那一条链，
 *     三段执行核在 `marketInstall`，与命令行同一个入口；装完是停用态，覆盖要停在确认卡上。
 *
 * 卡片与详情的每一个字都由 `marketBrowse` 的 `cardFacts` / `cardAction` 派生——本文件里
 * 出现任何具体条目名/URL，或自己判"这一相该显示什么"，都是 bug（`marketUi.test.ts` 钉着）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PLUGIN_STATE_LABEL, setEnabled, shadowExtId, themeArtsOf, usePlugins } from "../plugins/pluginStore";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { toast } from "../ai/extRuntime";
import { activeThemeFacts } from "../../styles/themeFacts";
import { useLocale } from "../../i18n/strings";
import { MARKET_BUNDLED_INDEX_URL, compareInstall, type MarketEntry } from "./marketIndex";
import {
  browseEntries, cardAction, cardFacts, emptyTalk, facetCategories, MARKET_INSTALL_NOTE, MARKET_NO_ENDORSE,
  MARKET_SORTS, MARKET_TABS, missingFavorites, offShelfOf, planQueueAllUpdates, queueAllLine, shelfLine,
  SORT_LABEL, TAB_LABEL, themeEnableFacts, themeStateOf, updateAllLabel,
  type BrowseInput, type MarketAction, type MarketCard, type MarketSort, type MarketTab,
  type ThemeEnableFacts,
} from "./marketBrowse";
import { clearMissingFavorites, refreshIndex, toggleFavorite, useMarket } from "./marketStore";
import { PENDING_CAP, requestMarketInstall, type PendingView } from "./marketPending";
import { useLiveViews, usePendingViews } from "./useMarketPending";
import { MarketImage } from "./MarketImage";
import { MarketDetail } from "./MarketDetail";
import { MarketSourceRows } from "./MarketSourceRows";
import { IconSettings } from "../../shared/icons";

/** 收藏按钮就用两个字，不用字符图标（§8-25）；详情按钮同理 */
const BTN_FAV_ON = "已收藏";
const BTN_FAV_OFF = "收藏";

/** 卡片上那颗：文案/可点/语气全部来自状态表，这里只负责按下去 */
function InstallButton({ action, onInstall, name }: { action: MarketAction; onInstall: () => void; name: string }) {
  return (
    <button
      className={`btn mkt-act mkt-act-${action.tone}`}
      disabled={!action.enabled}
      title={action.hint || `${action.label} ${name}`}
      onClick={onInstall}
    >
      {action.label}
    </button>
  );
}

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

function MarketCardView({
  card, action, theme, onOpen, onToggle, onInstall, onToggleTheme,
}: {
  card: MarketCard; action: MarketAction; theme: ThemeEnableFacts | null;
  onOpen: (id: string) => void; onToggle: (id: string) => void; onInstall: (id: string) => void;
  onToggleTheme: () => void;
}) {
  return (
    <article className={`mkt-card${card.grayed ? " dim" : ""}`} aria-label={card.name}>
      {/* 首图：没有就不占位；取回/格式/尺寸的策略全在 marketImages，这里只显示与出声 */}
      {card.firstShot ? <MarketImage url={card.firstShot} alt={`${card.name} 预览图`} /> : null}
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
        <span className={`plg-chip${card.installWarn ? " warn" : ""}`}>{card.installText}</span>
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
        <div className="mkt-card-acts">
          <button className="btn" onClick={() => onOpen(card.id)} title="看详情、能力与来源">
            详情
          </button>
          {/* 「外观」页签多一颗启停：它只叫 pluginStore.setEnabled（与插件库那颗同一个动作），
              装包那颗不动——"取回校验"与"启用"是两件事，混一颗按钮就会让人以为装完就生效了 */}
          {theme && theme.show ? (
            <button className="btn mkt-theme-toggle" title={theme.talk} onClick={onToggleTheme}>
              {theme.label}
            </button>
          ) : null}
          <InstallButton action={action} name={card.name} onInstall={() => onInstall(card.id)} />
        </div>
      </div>
      {/* 点不动或正在出声时，那句解释贴在按钮下面（要不要贴，也在状态表里算） */}
      {action.showHint && <div className={`mkt-act-hint tone-${action.tone}`}>{action.hint}</div>}
      {card.grayed && <div className="mkt-dim">{card.compatText}（minAppVersion 高于本机），列在这里但不假装能装。</div>}
    </article>
  );
}

export function MarketDialog({ onClose }: { onClose: () => void }) {
  const mkt = useMarket();
  /** 装包请求表（与命令行同一张）：这一页只读它 + 发请求，不自己判到哪一步 */
  const pendingViews = usePendingViews();
  const { plugins } = usePlugins();
  const lang = useLocale();
  const [tab, setTab] = useState<MarketTab>("discover");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<MarketSort>("updated");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  /** 「本机另有 N 个包不在这份索引里」那句：默认一行，点开才是清单（详设 §5-Q3） */
  const [showOffShelf, setShowOffShelf] = useState(false);
  /** 货架来源（索引地址 / 镜像前缀）：P102 从设置页搬进来，默认收着 */
  const [sourceOpen, setSourceOpen] = useState(false);

  /** 拉不到的那一刻是唯一需要改地址的时候：把「来源」摊开，别让人再去找那颗按钮 */
  useEffect(() => {
    if (mkt.status === "failed") setSourceOpen(true);
  }, [mkt.status]);

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

  /** 同一条可能排过几次（重试）：表按发起顺序排，后写进来的就是当前那一枚 */
  const pendingOf = useMemo(() => {
    const m = new Map<string, PendingView>();
    for (const v of pendingViews) m.set(v.entryId, v);
    return m;
  }, [pendingViews]);

  /**
   * 「外观」页签多问一句：这条在本机是"在画 / 装了没启用 / 启用着但没在画"。
   * 判据与话术都在派生层（`themeStateOf` + `themeEnableFacts`），这里只把料喂进去——
   * 在组件里现算就是第五处"谁在画"的副本，那正是详设 §1-8 要灭掉的东西。
   */
  const drawnThemeId = activeThemeFacts().id || null;
  const themeOf = useCallback(
    (entryId: string): ThemeEnableFacts | null => {
      if (tab !== "appearance") return null;
      const rec = plugins.find((r) => r.pkg.id === entryId);
      if (!rec) return null;
      const arts = themeArtsOf(rec.pkg);
      const extId = arts.length ? shadowExtId(rec.pkg.id, arts[0].entryId) : null;
      return themeEnableFacts(themeStateOf({ enabled: rec.state === "enabled" }, drawnThemeId, extId), {
        name: rec.pkg.name,
        drawnName: activeThemeFacts().name || null,
        installs: Object.values(rec.pkg.contributions ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0),
      });
    },
    [tab, plugins, drawnThemeId],
  );

  /** 每张卡那一格的全部真相由派生层算完（24 格穷举在 `marketBrowse.test`），这里只按 id 放好 */
  const rows = useMemo(
    () =>
      cards.map((c) => ({
        card: c,
        action: cardAction(c, pendingOf.get(c.id) ?? null),
        theme: themeOf(c.id),
      })),
    // themeOf 自己带着 [tab, plugins, drawnThemeId] 这三个依赖，这里只认它
    [cards, pendingOf, themeOf],
  );

  /** 启停只叫 pluginStore.setEnabled：判定与投影都归它，市场这里一个字都不重算（详设 §4②） */
  const toggleTheme = (entryId: string, enable: boolean) => {
    const r = setEnabled(entryId, enable);
    toast(r.ok ? r.msg : `没换成：${r.msg}`);
  };

  /** 「全部更新」事先要说清排几条——判定不在这，只数"有更新"与"已在途" */
  const liveViews = useLiveViews();
  const updPlan = useMemo(() => planQueueAllUpdates(cards, liveViews, PENDING_CAP), [cards, liveViews]);

  /** 分类计数用「不吃分类筛选」的范围，否则选了某一类后别的桶看着像空了 */
  const facets = useMemo(
    () => (index ? facetCategories(index, browseEntries({ ...browseInput, category: "all" })) : []),
    [index, browseInput],
  );

  const offShelf = useMemo(
    () =>
      offShelfOf(
        index,
        plugins.map((r) => ({
          id: r.pkg.id,
          name: r.pkg.name,
          version: r.pkg.version,
          // 派生层只管"哪些多出来"，中文状态名从这里（插件库那一份表）带进去，不在层里另立一套
          state: PLUGIN_STATE_LABEL[r.state],
        })),
      ),
    [index, plugins],
  );

  const dropped = index?.dropped ?? [];
  const missing = missingFavorites(index, mkt.favorites);
  const detailEntry: MarketEntry | null = detailId ? (index?.entries.find((e) => e.id === detailId) ?? null) : null;
  /** 详情那一格与卡片用的是同一张表（条目被筛掉了也照样算得出，不另开一份判断） */
  const detailAction: MarketAction | null =
    index && detailEntry ? cardAction(cardFacts(index, detailEntry, browseInput), pendingOf.get(detailEntry.id) ?? null) : null;
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

  /** 点「安装/更新」＝发一次请求。成功不用重复说（那一格马上就变成"正在装入…"），失败必须当场说 */
  const doInstall = (id: string) => {
    const r = requestMarketInstall(id);
    if (!r.ok) setNotice({ ok: false, msg: `没排上：${r.msg}` });
  };

  const doQueueAll = () => {
    const errs: string[] = [];
    let okCount = 0;
    for (const id of updPlan.ids) {
      const r = requestMarketInstall(id);
      if (r.ok) okCount++;
      else errs.push(`${id}：${r.msg}`);
    }
    // 数字要跟实际发生的一致：说"已排入"之前先扣掉当场被拒的，被拒的算进"没排上"那一档
    const said = { ...updPlan, ids: updPlan.ids.slice(0, okCount), overCap: updPlan.overCap + errs.length };
    const line = queueAllLine(said);
    setNotice(errs.length ? { ok: false, msg: `${line}；其中 ${errs.length} 条被当场拒：${errs[0]}` } : { ok: true, msg: line });
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
            <button
              className={`btn btn-icon${sourceOpen ? " on" : ""}`}
              onClick={() => setSourceOpen((v) => !v)}
              title="货架来源：这一页从哪儿取清单"
              aria-label="货架来源"
              aria-expanded={sourceOpen}
            >
              <IconSettings />
            </button>
            <button className="btn" onClick={doRefresh} title="重新拉取索引（不内置快照，拉不到就报错）">
              {mkt.status === "loading" ? "拉取中" : "刷新"}
            </button>
            <button className="btn" onClick={onClose} aria-label="关闭插件市场">
              关闭
            </button>
          </div>
        </div>

        {sourceOpen && <MarketSourceRows />}

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
              索引地址：<code>{getSettings().marketIndexUrl || MARKET_BUNDLED_INDEX_URL}</code>
              {mkt.viaMirror ? "（本次试过镜像）" : ""}
            </div>
            <div className="mkt-dim">
              这里不放一份"上次成功的清单"当现状：货架是会长大的东西，过期答案不是降级，是错误。
            </div>
            <div className="mkt-dim">
              上面「货架来源」那两行就是能改的东西（已替你摊开）：那里会先告诉你填的这条会不会被用上。
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

        {/* 确认卡现在挂在 App 顶层一份（关掉这一页也还在）——见 InstallConfirm 头注 */}

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
              <button
                className="plg-fchip mkt-offshelf-toggle"
                aria-expanded={showOffShelf}
                aria-controls="mkt-offshelf-list"
                title="这些是本机插件库里有、这份索引没有的包；市场不猜哪个对应哪个"
                onClick={() => setShowOffShelf((v) => !v)}
              >
                {showOffShelf ? "收起" : "展开"}：本机另有 {offShelf.length} 个包不在这份索引里
              </button>
              <span className="mkt-dim">启停与卸载去插件库看（那里才有本机留着的那份）。</span>
              {showOffShelf && (
                <ul className="mkt-offshelf-list" id="mkt-offshelf-list">
                  {offShelf.map((p) => (
                    <li key={p.id}>
                      <b>{p.name}</b> <code>{p.id}</code> v{p.version} · {p.state}（已在插件库）
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {mkt.status === "ready" && tab === "installed" && (
            <div className="mkt-updall">
              <button
                className="btn"
                disabled={updPlan.ids.length === 0}
                onClick={doQueueAll}
                title={updPlan.ids.length ? "逐条排队；每条覆盖都会各停一张确认卡，不合并批准" : "只处理「有更新」的那几条"}
              >
                {updateAllLabel(updPlan.ids.length)}
              </button>
              {updPlan.overCap > 0 && (
                <span className="mkt-dim">{`这一轮最多排 ${PENDING_CAP} 条，还有 ${updPlan.overCap} 条要等前面的落地后再点一次`}</span>
              )}
              <span className="mkt-dim">覆盖已有版本一律先停在确认卡上，这里不替你点</span>
            </div>
          )}
          {rows.map(({ card, action, theme }) => (
            <MarketCardView
              key={card.id}
              card={card}
              action={action}
              theme={theme}
              onOpen={setDetailId}
              onToggle={doToggle}
              onInstall={doInstall}
              onToggleTheme={() => toggleTheme(card.id, theme?.state !== "drawn")}
            />
          ))}
          {mkt.status === "ready" && empty && <div className="plg-empty">{empty.text}</div>}
        </div>

        {mkt.status === "ready" && (
          <div className="plg-notice" role="status">
            {MARKET_INSTALL_NOTE}
          </div>
        )}

        <div className="plg-foot">{MARKET_NO_ENDORSE}</div>

        {detailEntry && index && detailAction && (
          <MarketDetail
            entry={detailEntry}
            index={index}
            ctx={browseInput}
            action={detailAction}
            onClose={() => setDetailId(null)}
            onToggleFavorite={doToggle}
            onInstall={doInstall}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
