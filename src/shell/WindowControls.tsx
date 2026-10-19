/**
 * P157-F · 窗口键组（置顶 + 最小化 / 最大化 / 关闭）——身份栏与设置页共用。
 *
 * 设置页开着时身份栏整条被盖住，这组键挂在页内右上角（用户点名的 ZCode 同位）。
 * `.tb-win` / `.tb-btn` 的形状与身份栏同源，两处读起来是同一件东西。
 * 置顶状态走 `windowCtl` 的共享 store——两处按钮同一份真值，不再各存 `useState`。
 * 浏览器（无 Tauri）走 `getWinSafe` 的 no-op 桩，纯浏览器验证通道不断。
 */
import { useEffect, useState } from "react";
import { t, useLocale } from "../i18n/strings";
import { Glyph } from "../shared/icons";
import { getWinSafe, useWindowPin } from "./windowCtl";

export const IconPin = () => (
  <Glyph>
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-.89 1.55l-1.72.9A2 2 0 0 0 5.34 15z" />
  </Glyph>
);

/**
 * `withPin`：设置页要 [置顶][最小][最大][关闭] 四连；身份栏的置顶住在 SystemButtons
 * （fullPage 时那四颗应用入口收走、置顶单独留下），所以身份栏这边不再重复渲染。
 */
export function WinKeys({ withPin = false }: { withPin?: boolean }) {
  useLocale(); // 这组按钮的 title 是 t() 出来的，切语言要有人重渲染
  const win = getWinSafe();
  const [maxed, setMaxed] = useState(false);
  const [pinned, togglePin] = useWindowPin();
  useEffect(() => {
    let un: () => void = () => {};
    void win.isMaximized().then(setMaxed);
    void win.onResized(() => void win.isMaximized().then(setMaxed)).then((u) => {
      un = u;
    });
    return () => un();
  }, [win]);
  return (
    <div className="tb-win">
      {withPin && (
        <button
          className={`tb-btn${pinned ? " on" : ""}`}
          data-ctl="tool"
          title={pinned ? t("title.unpin") : t("title.pin")}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          <IconPin />
        </button>
      )}
      <button className="tb-btn" data-ctl="tool" title={t("title.minimize")} onClick={() => void win.minimize()}>
        <Glyph>
          <line x1="5" y1="12" x2="19" y2="12" />
        </Glyph>
      </button>
      <button
        className="tb-btn"
        data-ctl="tool"
        title={maxed ? t("title.restore") : t("title.maximize")}
        onClick={() => void win.toggleMaximize()}
      >
        {maxed ? (
          <Glyph>
            <rect x="8" y="8" width="12" height="12" rx="1.5" />
            <path d="M5 16V5a1 1 0 0 1 1-1h11" />
          </Glyph>
        ) : (
          <Glyph>
            <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
          </Glyph>
        )}
      </button>
      <button className="tb-btn tb-close" data-ctl="tool" title={t("title.close")} onClick={() => void win.close()}>
        <Glyph>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </Glyph>
      </button>
    </div>
  );
}
