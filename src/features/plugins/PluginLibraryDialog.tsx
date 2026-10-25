/**
 * P174-R3 / 0.6.0：插件管理的唯一正文。
 *
 * 旧 `pluginStore` 的列表/详情/导入/发布/模块宿主代码已经从这一页移除；现在只有
 * 设置页的「插件管理」一处挂载它（AI 顶栏的入口也改成打开设置页，不再弹第二个窗口），
 * 视觉沿用原有 `plg-*` 类名。
 */
import { useEffect, useRef, useState } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { IconClose, IconSearch } from "../../shared/icons";
import { PluginEngineSection } from "./engine/PluginEngineSection";
import { openMarketDialog } from "./engine/marketDialog";
import { FILTERS, filterLabel, type PluginFilter } from "./engine/pluginKinds";

export function PluginManagerBody() {
  useLocale();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="plg-toolbar">
        <div className="plg-search-box">
          <span className="plg-search-ico" aria-hidden="true"><IconSearch /></span>
          <input
            ref={searchRef}
            className="input plg-search"
            placeholder={tx("搜索名称 / ID / 描述", "Search name / ID / description")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={tx("搜索插件", "Search plugins")}
            aria-keyshortcuts="/"
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {!query ? <kbd className="plg-search-kbd" aria-hidden="true">/</kbd> : null}
          {query ? (
            <button
              type="button"
              className="plg-search-clear"
              title={tx("清空搜索", "Clear search")}
              aria-label={tx("清空搜索", "Clear search")}
              onClick={() => setQuery("")}
            >
              <IconClose />
            </button>
          ) : null}
        </div>
        <div className="plg-filters" role="tablist" aria-label={tx("按产物筛选", "Filter by contribution")}>
          {FILTERS.map((k) => {
            const l = filterLabel(k);
            return (
              <button
                key={k}
                className={`plg-fchip${filter === k ? " on" : ""}`}
                onClick={() => setFilter(k)}
                role="tab"
                aria-selected={filter === k}
                title={k === "widget" ? tx("小部件；透明/无边框就是「浮窗」那种形态", "Widgets; transparent/frameless is the floating-window presentation") : undefined}
              >
                {tx(l.zh, l.en)}
              </button>
            );
          })}
        </div>
        <div className="plg-toolbar-actions">
          <button className="btn primary" onClick={() => openMarketDialog()} title={tx("从 GitHub 话题拉取社区插件", "Pull community plugins from the GitHub topic")}>
            {tx("插件市场", "Plugin market")}
          </button>
        </div>
      </div>

      <div className="plg-list">
        <PluginEngineSection query={query} filter={filter} />
      </div>
    </>
  );
}
