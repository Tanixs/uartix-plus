/**
 * P99b-N3：市场图片的渲染层（卡片首图 / 详情轮播 / 大图）。
 *
 * 这一层**不含任何策略**：放行什么格式、尺寸超不超限、并发与缓存全在 `marketImages.ts`
 * （§8-48：组件里的逻辑测不到，测不到就等于没守卫）。这里只做四件事：
 * 显示、说清为什么没显示、给一个重试、点开大图。
 *
 * 两条硬口径：
 *  - **三种"没显示"话术不同**（格式不放行 / 太大 / 取回失败），失败原因全文挂在 title 上，
 *    截断交给 CSS 的 `line-clamp`——JS 里剪一刀就等于把真因剪掉（A7 同族）；
 *  - 占位一律用骨架块，**不放 emoji 或字符图标**（§8-25）。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { IconChevron } from "../../shared/icons";
import { loadImage, marketImageSlot, subscribeMarketImages, type ImageSlot } from "./marketImages";

const BTN_RETRY = "重试";
const BTN_CLOSE = "关闭";

function useImage(url: string): ImageSlot {
  const slot = useSyncExternalStore(subscribeMarketImages, () => marketImageSlot(url), () => marketImageSlot(url));
  // 只在 idle 时起一次：失败不自动重试（404 不会因为再问一次变成 200，只会变成一直转圈）
  useEffect(() => {
    if (slot.status === "idle") void loadImage(url);
  }, [url, slot.status]);
  return slot;
}

export function MarketImage({ url, alt, onZoom }: { url: string; alt: string; onZoom?: () => void }) {
  const slot = useImage(url);
  if (slot.status === "ok") {
    return (
      <img
        className="mkt-img"
        src={slot.dataUrl}
        alt={alt}
        title={onZoom ? "点开看大图" : alt}
        onClick={onZoom}
      />
    );
  }
  if (slot.status === "idle" || slot.status === "loading") {
    return <span className="mkt-img mkt-img-skel" role="img" aria-label={`${alt} 正在取回`} />;
  }
  return (
    <span className={`mkt-img mkt-img-bad ${slot.status}`} role="img" aria-label={`${alt}：${slot.msg}`} title={slot.msg}>
      <span className="mkt-img-why">{slot.msg}</span>
      {slot.status === "failed" ? (
        <button className="btn mkt-img-retry" title={`重新取回「${alt}」`} onClick={() => void loadImage(url)}>
          {BTN_RETRY}
        </button>
      ) : null}
    </span>
  );
}

/**
 * 详情里的轮播：箭头**叠在图上**（左右各一枚半透明圆钮），计数在右下角。
 * 索引来自货架数组本身，不来自缓存尺寸（缓存会淘汰，图却还在架上）。
 * 只有一张时不放箭头——没得翻还摆两个按钮，是假面。
 */
export function ShotStrip({ urls, name }: { urls: readonly string[]; name: string }) {
  const [i, setI] = useState(0);
  const [big, setBig] = useState(false);
  if (urls.length === 0) return null;
  const at = Math.min(Math.max(i, 0), urls.length - 1);
  const cur = urls[at];
  const many = urls.length > 1;
  return (
    <div className="mkt-shots">
      <div className="mkt-shot-stage">
        <MarketImage url={cur} alt={`${name} 预览图 ${at + 1}/${urls.length}`} onZoom={() => setBig(true)} />
        {many ? (
          <>
            <button
              className="mkt-shot-nav prev"
              title={`上一张预览图（${at}/${urls.length}）`}
              aria-label="上一张"
              disabled={at === 0}
              onClick={() => setI(at - 1)}
            >
              <IconChevron dir="left" size={18} />
            </button>
            <button
              className="mkt-shot-nav next"
              title={`下一张预览图（${at + 2}/${urls.length}）`}
              aria-label="下一张"
              disabled={at === urls.length - 1}
              onClick={() => setI(at + 1)}
            >
              <IconChevron dir="right" size={18} />
            </button>
            <span className="mkt-shot-n">{at + 1} / {urls.length}</span>
          </>
        ) : null}
      </div>
      {many ? (
        <div className="mkt-shot-dots" role="tablist" aria-label="预览图选择">
          {urls.map((u, k) => (
            <button
              key={u}
              className={`mkt-shot-dot${k === at ? " on" : ""}`}
              role="tab"
              aria-selected={k === at}
              title={`看第 ${k + 1} 张（共 ${urls.length} 张）`}
              onClick={() => setI(k)}
            />
          ))}
        </div>
      ) : null}
      {big ? <BigShot url={cur} name={`${name} 预览图 ${at + 1}/${urls.length}`} onClose={() => setBig(false)} /> : null}
    </div>
  );
}

/** 大图：portal 到 body（§8-20），Esc 关，点遮罩也关。走同一份缓存，不会再取一次 */
function BigShot({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const slot = useImage(url);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="mkt-big" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <div className="mkt-big-inner" onClick={(e) => e.stopPropagation()}>
        {slot.status === "ok" ? (
          <img className="mkt-big-img" src={slot.dataUrl} alt={name} />
        ) : (
          <span className="mkt-big-msg">{slot.status === "idle" || slot.status === "loading" ? "正在取回…" : slot.msg}</span>
        )}
        <div className="mkt-big-foot">
          <span className="mkt-big-name">{name}</span>
          <button className="btn" title="关闭大图（Esc）" onClick={onClose}>{BTN_CLOSE}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
