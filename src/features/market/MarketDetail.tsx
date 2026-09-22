/**
 * P99b-N2：市场详情（货架页里的弹层，不是第二个窗口）。
 *
 * 这一屏的存在理由只有一个：**装之前要看得清"它会碰到什么"**。
 * 所以能力清单每项都带 `CAP_LABEL.note` 那句人话、不会自动生效的要单独点名、
 * 来源与哈希要能核对。截图这一批**不放**（N3），但也不留空图位——照实说作者给没给。
 *
 * 外链一律走系统浏览器（`openUrl`）：这些地址在 `parseEntry` 里已经过 https + 域白名单，
 * 应用内不加载任何第三方页面（v1 不内嵌评论/讨论区，详设 §8）。
 */
import { createPortal } from "react-dom";
import type { MarketEntry, MarketIndex } from "./marketIndex";
import {
  cardFacts, compatLabel, MARKET_NO_ENDORSE, type MarketCard, versionHistoryText,
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
  onClose: () => void;
  onToggleFavorite: (id: string) => void;
}

export function MarketDetail({ entry, index, ctx, onClose, onToggleFavorite }: MarketDetailProps) {
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
          <button className="btn" onClick={onClose} aria-label="关闭详情">
            返回
          </button>
        </div>

        <div className="mkt-sheet-scroll">
          <div className="mkt-meta">
            <span className="plg-chip">{card.category}</span>
            <span className="plg-chip">v{card.version}</span>
            <span className="plg-chip">{card.installText}</span>
            {card.verified && <span className="plg-chip" title="这条只表示它出现在当前索引里，不代表内容经过审核">货架标记</span>}
            <span className="mkt-dim">作者 {card.author} · 更新于 {card.updated}</span>
            <button className="btn mkt-fav" aria-pressed={card.favorite} onClick={() => onToggleFavorite(card.id)} title={card.favorite ? "取消收藏" : "收藏"}>
              {card.favorite ? "已收藏" : "收藏"}
            </button>
          </div>

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

          <div className="plg-sec">来源与校验</div>
          <div className="mkt-dim">
            包体来自 <code>{offShelfUrl}</code> · {card.sizeText} · sha256 前 12 位 <code>{card.sha12}</code>
          </div>
          <div className="mkt-dim">
            下载后会先算哈希，与索引声明不符就拒绝入库（显示期望与实际两个前缀），不会「差不多就用」。
          </div>
          <div className="mkt-dim">{card.screenshotHint}（截图预览在下一批接通）。</div>
          <div className="mkt-dim">{versionHistoryText(entry, ctx)}</div>
          <div className="mkt-dim">适配本机：{compatLabel(card.compatible)}；条目要求 minAppVersion {entry.minAppVersion}。</div>

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

          <div className="mkt-endorse">{MARKET_NO_ENDORSE}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
