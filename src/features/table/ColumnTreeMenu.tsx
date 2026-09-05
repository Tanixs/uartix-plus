import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Flyout } from "../../shared/Flyout";
import { IconChevron } from "../../shared/icons";
import { useSettings } from "../settings/settingsStore";
import { t, tx } from "../../i18n/strings";

export interface ColLeaf {
  id: string;
  name: string;
  csv: boolean;
}

export interface ColTpl {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
  fields: ColLeaf[];
}

export interface ColGroup {
  key: string;
  name: string;
  tpls: ColTpl[];
}

type Tri = "on" | "off" | "part";

function triOf(ids: string[], hidden: Set<string>): Tri {
  let vis = 0;
  for (const id of ids) if (!hidden.has(id)) vis++;
  if (vis === 0) return "off";
  if (vis === ids.length) return "on";
  return "part";
}

function TriBox({ state }: { state: Tri }) {
  return <span className={`chk-tri ${state}`} aria-checked={state === "on"} role="checkbox" />;
}

export function ColumnTreeMenu(props: {
  anchor: HTMLElement | null;
  groups: ColGroup[];
  hidden: Set<string>;
  onSetMany: (ids: string[], visible: boolean) => void;
  onToggleField: (id: string) => void;
  onClose: () => void;
}) {
  const settings = useSettings();
  const zf = (settings.zoom || 100) / 100;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [grpOpen, setGrpOpen] = useState<string | null>(null);
  const [tplOpen, setTplOpen] = useState<string | null>(null);

  const totalLeaves = useMemo(
    () => props.groups.reduce((n, g) => n + g.tpls.reduce((m, t) => m + t.fields.length, 0), 0),
    [props.groups],
  );
  const shownCount = useMemo(() => {
    let n = 0;
    for (const g of props.groups)
      for (const t of g.tpls) for (const f of t.fields) if (!props.hidden.has(f.id)) n++;
    return n;
  }, [props.groups, props.hidden]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    const a = props.anchor;
    if (!el || !a || !a.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return;
    const ar = a.getBoundingClientRect();
    let left = ar.left;
    let top = ar.bottom + 6;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - 8 - r.width;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - r.height);
    left = Math.max(8, left);
    top = Math.max(8, top);
    el.style.left = `${left / zf}px`;
    el.style.top = `${top / zf}px`;
    el.style.visibility = "visible";
  });

  useEffect(() => {
    const hit = (el: Element | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
    };
    const insideAny = (x: number, y: number) => {
      if (hit(props.anchor, x, y)) return true;
      if (hit(rootRef.current, x, y)) return true;
      for (const el of Array.from(document.querySelectorAll(".ctx-flyout")))
        if (hit(el, x, y)) return true;
      return false;
    };
    const onDown = (e: PointerEvent) => {
      if (!insideAny(e.clientX, e.clientY)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    const onWheel = (e: WheelEvent) => {
      const tgt = e.target as Element | null;
      if (tgt && (rootRef.current?.contains(tgt) || tgt.closest(".ctx-flyout"))) return;
      props.onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  });

  const setRow = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };

  const leafIds = (t: ColTpl) => t.fields.map((f) => f.id);
  const grpIds = (g: ColGroup) => g.tpls.flatMap((t) => leafIds(t));

  const grpRow = (g: ColGroup) => {
    const ids = grpIds(g);
    return (
      <div className={`coltree-row ${g.tpls.length === 0 ? "disabled" : ""}`} key={g.key}>
        <button
          className="coltree-chk"
          title={tx("勾选/取消整簇", "Toggle whole cluster")}
          onClick={() => props.onSetMany(ids, triOf(ids, props.hidden) !== "on")}
        >
          <TriBox state={triOf(ids, props.hidden)} />
        </button>
        <button
          className="coltree-main"
          ref={setRow(`g:${g.key}`)}
          onClick={() => {
            setGrpOpen(grpOpen === g.key ? null : g.key);
            setTplOpen(null);
          }}
        >
          <span className="coltree-name">{g.name}</span>
          <span className="coltree-cnt">
            {g.tpls.reduce((n, t) => n + t.fields.length, 0)}
          </span>
          <IconChevron dir={grpOpen === g.key ? "down" : "right"} size={13} />
        </button>
      </div>
    );
  };

  return createPortal(
    <div ref={rootRef} className="ctx-menu coltree" style={{ left: -9999, top: -9999, visibility: "hidden" }}>
      {totalLeaves === 0 && <div className="tpl-empty">{t("tbl.noCols")}</div>}
      {props.groups.map((g) => (
        <div key={g.key}>
          {grpRow(g)}
          {grpOpen === g.key && (
            <Flyout anchor={rowRefs.current.get(`g:${g.key}`) ?? null} zf={zf} minWidth={230}>
              {g.tpls.length === 0 && <div className="ctx-group">{tx("空簇", "Empty cluster")}</div>}
              {g.tpls.map((t2) => (
                <div key={t2.id}>
                  <div className={`coltree-row ${t2.enabled ? "" : "disabled"}`}>
                    <button
                      className="coltree-chk"
                      title={tx("勾选/取消整帧所有字段", "Toggle all fields of this frame")}
                      onClick={() =>
                        props.onSetMany(leafIds(t2), triOf(leafIds(t2), props.hidden) !== "on")
                      }
                    >
                      <TriBox state={triOf(leafIds(t2), props.hidden)} />
                    </button>
                    <button
                      className="coltree-main"
                      ref={setRow(`t:${t2.id}`)}
                      onClick={() => setTplOpen(tplOpen === t2.id ? null : t2.id)}
                    >
                      <span className="coltree-dot" style={{ background: t2.color }} />
                      <span className="coltree-name">{t2.name}</span>
                      {!t2.enabled && <span className="coltree-off">{tx("停用", "off")}</span>}
                      {t2.fields.length > 0 && (
                        <IconChevron dir={tplOpen === t2.id ? "down" : "right"} size={13} />
                      )}
                    </button>
                  </div>
                  {tplOpen === t2.id && (
                    <Flyout anchor={rowRefs.current.get(`t:${t2.id}`) ?? null} zf={zf} minWidth={170}>
                      {t2.fields.length === 0 && (
                        <div className="ctx-group">{tx("无可解析字段", "No decodable fields")}</div>
                      )}
                      {t2.fields.map((f) => {
                        const vis = !props.hidden.has(f.id);
                        return (
                          <button
                            key={f.id}
                            className="coltree-row leaf ctx-item"
                            onClick={() => props.onToggleField(f.id)}
                          >
                            <TriBox state={vis ? "on" : "off"} />
                            <span className="coltree-name">{f.name}</span>
                            {f.csv && <span className="coltree-tag">CSV</span>}
                          </button>
                        );
                      })}
                    </Flyout>
                  )}
                </div>
              ))}
            </Flyout>
          )}
        </div>
      ))}
      {totalLeaves > 0 && (
        <div className="coltree-foot">
          <span className="coltree-cnt">
            {tx(`已显示 ${shownCount} / 共 ${totalLeaves} 列`, `Shown ${shownCount} of ${totalLeaves}`)}
          </span>
          <button className="btn sm" onClick={() => props.onSetMany(props.groups.flatMap(grpIds), true)}>
            {t("tbl.showAll")}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
