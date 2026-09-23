/**
 * P99b-N2：市场详情（货架页里的弹层，不是第二个窗口）。
 *
 * 这一屏的存在理由只有一个：**装之前要看得清"它会碰到什么"**。
 * 所以能力清单每项都带 `CAP_LABEL.note` 那句人话、不会自动生效的要单独点名、
 * 来源与哈希要能核对。预览图从 N3 起是真图（`ShotStrip`），作者没给就照实说没给。
 * N4 起这一屏多了一颗按钮——它只发请求，落到哪一步看的是 `marketPending` 那张表。
 *
 * 外链一律走系统浏览器（`openUrl`）：这些地址在 `parseEntry` 里已经过 https + 域白名单，
 * 应用内不加载任何第三方页面（v1 不内嵌评论/讨论区，详设 §8）。
 */
import { createPortal } from "react-dom";
import { ShotStrip } from "./MarketImage";
import type { MarketEntry, MarketIndex } from "./marketIndex";
import { packageOrigin } from "./marketIndex";
import {
  cardFacts, compatLabel, MARKET_NO_ENDORSE, type MarketAction, type MarketCard, versionHistoryText,
} from "./marketBrowse";
import type { BrowseContext } from "./marketBrowse";

/** 点外链＝离开应用到系统浏览器，这句要写在链接旁边，不能等点了才说 */
const EXTERNAL_NOTE = "以下链接会用系统浏览器打开外部站点，应用内不加载第三方页面。";

function urlHostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

function ExternalLink({ label, url }: { label: string; url: string }) {
  return (
    <button
      className="btn mkt-link"
      title={`用系统浏览器打开 ${urlHostOf(url)}`}
      onClick={() => {
        void import("@tauri-apps/plugin-opener")
          .then((m) => m.openUrl(url))
          .catch((e: unknown) => console.warn("[market] 外链打不开", url, e));
      }}
    >
      {label}
    </button>
  );
}

export interface MarketDetailProps {
  entry: MarketEntry;
  index: MarketIndex;
  ctx: BrowseContext;
  /** 这一格的全部真相由 `marketBrowse.cardAction` 算好传进来（与卡片同一张表） */
  action: MarketAction;
  onClose: () => void;
  onToggleFavorite: (id: string) => void;
  onInstall: (id: string) => void;
}

export function MarketDetail({ entry, index, ctx, action, onClose, onToggleFavorite, onInstall }: MarketDetailProps) {
  const card: MarketCard = cardFacts(index, entry, ctx);
  const blocked = card.caps.filter((c) => c.blocked);
  const offShelfUrl = urlHostOf(entry.packageUrl);
  return createPortal(
    <div className="mkt-sheet" role="presentation" onMouseDown={onClose}>
      <div
        className="mkt-sheet-body"
        role="dialog"
        aria-modal="true"
        aria-label={`${card.name} 详情`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mkt-sheet-head">
          <div className="mkt-sheet-title">
            <span className="mkt-card-name">{card.name}</span>
            <span className="mkt-card-id">{card.id}</span>
          </div>
          <button
            className={`btn mkt-act mkt-act-${action.tone}`}
            disabled={!action.enabled}
            title={action.hint || `${action.label} ${card.name}`}
            onClick={() => onInstall(card.id)}
          >
            {action.label}
          </button>
          <button className="btn mkt-fav" aria-pressed={card.favorite} onClick={() => onToggleFavorite(card.id)} title={card.favorite ? "取消收藏" : "收藏"}>
            {card.favorite ? "已收藏" : "收藏"}
          </button>
          <button className="btn" onClick={onClose} aria-label="关闭详情">
            返回
          </button>
        </div>

        <div className="mkt-sheet-scroll">
          {/* 顶部大图：给几张排几张，箭头叠在图上；这一层不产生任何判定（策略在 marketImages） */}
          <ShotStrip urls={entry.screenshots} name={card.name} />
          {entry.screenshots.length > 0 && (
            <div className="mkt-dim mkt-shots-tip">预览图由投稿人提供，只作参考；本机装完长什么样，取决于包里的声明。</div>
          )}

          <div className="mkt-meta">
            <span className="plg-chip">{card.category}</span>
            <span className="plg-chip">v{card.version}</span>
            <span className={`plg-chip${card.installWarn ? " warn" : ""}`}>{card.installText}</span>
            {card.verified && <span className="plg-chip" title="这条只表示它出现在当前索引里，不代表内容经过审核">货架标记</span>}
            <span className="mkt-dim">作者 {card.author} · 更新于 {card.updated}</span>
          </div>
          {/* 详情地方大，这一格的解释一直贴着（要不要贴由状态表说了算的是卡片） */}
          {action.hint && <div className={`mkt-act-hint tone-${action.tone}`}>{action.hint}</div>}

          <div className="mkt-detail-grid">
            <div className="mkt-detail-main">
              <p className="mkt-desc">{card.description}</p>
              {card.otherLangDescription && <p className="mkt-dim">{card.otherLangDescription}</p>}

              <div className="plg-sec">它会用到的能力</div>
              {card.caps.length === 0 && <div className="mkt-dim">这个包不声明任何能力。</div>}
              <ul className="mkt-caps">
                {card.caps.map((c) => (
                  <li key={c.id}>
                    <span className={`plg-chip${c.blocked ? " warn" : ""}`}>{c.name}</span>
                    <span className="mkt-cap-note">{c.note}</span>
                  </li>
                ))}
              </ul>
              {blocked.length > 0 && (
                <div className="plg-notice">
                  标了警示的这几项（{blocked.map((c) => c.name).join("、")}）不属于自动放行集：装上之后不会自己生效，要看得见效果得再去插件库启用一次。
                </div>
              )}
            </div>

            <aside className="mkt-detail-side">
              <div className="plg-sec">来源与校验</div>
              <div className="mkt-side-line">包体来自 <code>{offShelfUrl}</code></div>
              <div className="mkt-side-line">出处：{card.origin}</div>
              <div className="mkt-side-line">{card.sizeText} · sha256 前 12 位 <code>{card.sha12}</code></div>
              <div className="mkt-side-line">下载后先算哈希，与索引声明不符就拒绝入库（显示期望与实际两个前缀），不会「差不多就用」。</div>
              {/* 上面那句出处来自派生层（`cardFacts.origin`）；这里"要不要多说一段"用的必须是契约层同一条判定，不许自己比字符串 */}
              {packageOrigin(entry) === "npm" && (
                <div className="mkt-side-line">这一条取回的是 npm 官方 registry 的那枚 tarball，我们只从里面取出<b>那一枚插件清单</b>——<b>不装依赖、不跑任何包内脚本</b>，取出来照样过生产校验器。</div>
              )}

              <div className="plg-sec">适配</div>
              <div className="mkt-side-line">{compatLabel(card.compatible)}</div>
              <div className="mkt-side-line">条目要求 minAppVersion {entry.minAppVersion}</div>
              <div className="mkt-side-line">{versionHistoryText(entry, ctx)}</div>
              <div className="mkt-side-line">{card.screenshotHint}</div>

              <div className="plg-sec">外部链接</div>
              <div className="mkt-dim">{EXTERNAL_NOTE}</div>
              <div className="mkt-links">
                {entry.homepage && <ExternalLink label="主页" url={entry.homepage} />}
                {entry.discussion && <ExternalLink label="讨论" url={entry.discussion} />}
                {entry.changelogUrl && <ExternalLink label="更新记录" url={entry.changelogUrl} />}
                {!entry.homepage && !entry.discussion && !entry.changelogUrl && (
                  <span className="mkt-dim">作者没留任何链接。</span>
                )}
              </div>
            </aside>
          </div>
        </div>

        <div className="mkt-sheet-foot">{MARKET_NO_ENDORSE}</div>
      </div>
    </div>,
    document.body,
  );
}
