/**
 * P99b-N6 → P102：市场「从哪儿取清单」那两行。
 *
 * P102 起它住在市场弹窗自己里面（顶上那颗齿轮展开），不再占设置→插件管理的顶部——
 * 那一栏只留本地插件库，而这两行服务的正是"这一页从哪儿取"，与货架状态是同一条信息。
 *
 * 两行的回显**全部来自 `marketBrowse.marketEndpointTalk`**：那一层与 `applyMirror` 共用同一个判定内核，
 * 所以这里说「会被用上」就是装包时真的会被用上（详设 R5）。组件里因此不许出现 https / 域名的判断或字面量
 * ——抄一份域名清单进文案就是等着过期（守卫 G2/G6 钉着）。
 *
 * 这里**不再重复一遍货架状态行**：市场页顶上那行 `shelfLine` 已经说了"几条 · 生成于哪天 · 走没走镜像"，
 * 同一个数在同一个窗口里出现两次不是双保险，是两处投影。
 */
import { useSettings, patch } from "../settings/settingsStore";
import { tx } from "../../i18n/strings";
import { SetRow } from "../../shared/SetRow";
import { MARKET_ALLOW_HOSTS, MARKET_BUNDLED_INDEX_URL } from "./marketIndex";
import { marketEndpointTalk } from "./marketBrowse";

export function MarketSourceRows() {
  const settings = useSettings();
  const talk = marketEndpointTalk(settings.marketIndexUrl, settings.marketMirrorPrefix, MARKET_ALLOW_HOSTS);
  return (
    <div className="mkt-source" role="group" aria-label={tx("货架来源", "Shelf source")}>
      <div className="mkt-source-head">
        {tx("货架来源", "Shelf source")}
        <span className="mkt-dim">
          {tx(
            "这两行只决定这一页从哪儿取清单；改完回本页点「刷新」才生效，别处不会替你联网。",
            "These two rows only decide where this page fetches its index. Hit Refresh to apply — nothing else here goes online.",
          )}
        </span>
      </div>
      <SetRow
        label={tx("市场索引地址", "Market index URL")}
        tip={tx(
          "默认是应用自带的那份示例货架（同源、不出网）。换成远程地址就是「从别人那台机器取元数据」，域不在放行清单里的地址会被拒。",
          "Defaults to the sample shelf shipped with the app (same-origin, offline). A remote URL means fetching metadata from that machine; hosts outside the allow-list are rejected.",
        )}
      >
        <input
          className="input"
          style={{ width: 320 }}
          value={settings.marketIndexUrl}
          placeholder={MARKET_BUNDLED_INDEX_URL}
          onChange={(e) => patch({ marketIndexUrl: e.target.value })}
        />
        <span className={`set-talk set-talk-${talk.index.tone}`}>{talk.index.say}</span>
      </SetRow>
      <SetRow
        label={tx("市场镜像前缀", "Market mirror prefix")}
        tip={tx(
          "直连取不到时才试的第二条路。它只改「从哪台机器下载」，改不了下载到的内容：包体仍按索引里声明的哈希与字节数逐条比对，装前还要过一遍生产校验器。",
          "The fallback path tried only after a direct fetch fails. It changes where bytes come from, never what they are: each package is still checked against the hash and byte count the index declares, then run through the production validator.",
        )}
      >
        <input
          className="input"
          style={{ width: 320 }}
          value={settings.marketMirrorPrefix}
          placeholder={tx("留空＝不用镜像", "Empty = no mirror")}
          onChange={(e) => patch({ marketMirrorPrefix: e.target.value })}
        />
        <span className={`set-talk set-talk-${talk.mirror.tone}`}>{talk.mirror.say}</span>
      </SetRow>
    </div>
  );
}
