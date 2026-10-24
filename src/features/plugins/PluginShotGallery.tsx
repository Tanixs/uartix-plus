import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "../../shared/icons";
import { tx, useLocale } from "../../i18n/strings";

export interface PluginShotGalleryProps {
  shots: readonly string[];
  name: string;
  max: number;
  busy?: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

export function PluginShotGallery({ shots, name, max, busy = false, onAdd, onRemove }: PluginShotGalleryProps) {
  useLocale();
  const [big, setBig] = useState<number | null>(null);

  useEffect(() => {
    if (big !== null && big >= shots.length) setBig(shots.length ? shots.length - 1 : null);
  }, [big, shots.length]);

  useEffect(() => {
    if (big === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setBig(null);
      } else if (e.key === "ArrowLeft") {
        setBig((v) => (v === null ? v : Math.max(0, v - 1)));
      } else if (e.key === "ArrowRight") {
        setBig((v) => (v === null ? v : Math.min(shots.length - 1, v + 1)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big, shots.length]);

  const at = big === null ? null : Math.min(big, shots.length - 1);
  const full = shots.length >= max;
  return (
    <div className="plg-shots">
      <div className="plg-shots-head">
        <span className="plg-sec">{tx("详情截图", "Detail screenshots")}</span>
        <span className="plg-detail-dim">{shots.length} / {max}</span>
        <button
          type="button"
          className="btn"
          disabled={busy || full}
          title={full ? tx(`最多 ${max} 张，先移除一张再添加`, `Up to ${max}; remove one before adding`) : tx("添加截图（可多选）", "Add screenshots (multiple)")}
          onClick={onAdd}
        >
          {busy ? tx("处理中…", "Processing…") : tx("添加截图", "Add screenshots")}
        </button>
      </div>
      {shots.length === 0 ? (
        <div className="plg-shot-empty">
          {tx(`还没有详情截图。可加多张界面预览，最多 ${max} 张、单张 200KB。`, `No detail screenshots yet. Add interface previews, up to ${max} at 200KB each.`)}
        </div>
      ) : (
        <div className="plg-shot-grid">
          {shots.map((s, i) => (
            <div className="plg-shot" key={`${i}-${s.slice(-24)}`}>
              <button
                type="button"
                className="plg-shot-open"
                title={tx("点开看大图", "Open the full-size image")}
                aria-label={tx(`查看截图 ${i + 1}`, `View screenshot ${i + 1}`)}
                onClick={() => setBig(i)}
              >
                <img src={s} alt={tx(`${name} 截图 ${i + 1}`, `${name} screenshot ${i + 1}`)} />
              </button>
              <button
                type="button"
                className="plg-shot-del"
                title={tx(`移除截图 ${i + 1}`, `Remove screenshot ${i + 1}`)}
                aria-label={tx(`移除截图 ${i + 1}`, `Remove screenshot ${i + 1}`)}
                onClick={() => onRemove(i)}
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}
      {at !== null ? createPortal(
        <div
          className="plg-big"
          role="dialog"
          aria-modal="true"
          aria-label={tx(`${name} 截图 ${at + 1}/${shots.length}`, `${name} screenshot ${at + 1} of ${shots.length}`)}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBig(null);
          }}
        >
          <div className="plg-big-inner">
            <img className="plg-big-img" src={shots[at]} alt={tx(`${name} 截图 ${at + 1}`, `${name} screenshot ${at + 1}`)} />
            <div className="plg-big-foot">
              <button type="button" className="btn" disabled={at === 0} onClick={() => setBig(at - 1)}>
                {tx("上一张", "Previous")}
              </button>
              <span className="plg-big-n">{at + 1} / {shots.length}</span>
              <button type="button" className="btn" disabled={at === shots.length - 1} onClick={() => setBig(at + 1)}>
                {tx("下一张", "Next")}
              </button>
              <button type="button" className="btn" autoFocus onClick={() => setBig(null)}>
                {tx("关闭", "Close")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
