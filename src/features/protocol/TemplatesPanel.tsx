import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { FrameTemplate } from "../../ipc/types";
import * as store from "./templateStore";
import * as teleStore from "./telemetryStore";
import { EmptyState } from "../../shared/EmptyState";
import { clampFlyoutMenu, Flyout } from "../../shared/Flyout";
import { zoomFactor } from "../../shared/zoom";
import { Glyph, IconChevron } from "../../shared/icons";
import { PRESETS, applyPreset, groupDisplayName, presetGroupKey } from "../framecanvas/presets";
import { NewTplDlg } from "../framecanvas/NewTplDlg";
import { requestOpenPanel } from "../ai/appBus";
import { FieldLegend } from "../plot/FieldLegend";
import { tx, useLocale } from "../../i18n/strings";



/**
 * P105 反馈①：上下分割的边界。
 * `SPLIT_MIN/MAX` 是**比例**兜底（防极端值），真正让拖动 1:1 的是 `splitMaxPct()`
 * 里按当下页脚高度算出来的那条上限；`LEGEND_MIN` 与 theme.css 的
 * `.tpl-legend{min-height:min(140px,26%)}` 是同一个意图的两处写法
 * （CSS 那份只在窗口矮到比例兜不住时兜底）。
 */
const SPLIT_MIN = 0.12;
const SPLIT_MAX = 0.85;
const SPLITTER_H = 12;
const LEGEND_MIN = 140;

interface CtxItem {
  label: string;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}

interface CtxMenu {
  x: number;
  y: number;
  items: CtxItem[];
}

function RenameDlg({
  title,
  init,
  onOk,
  onCancel,
}: {
  title: string;
  init: string;
  onOk: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(init);
  useLocale();
  return (
    <div className="fc-dlg-mask" onMouseDown={onCancel}>
      <div className="fc-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fc-dlg-title">{title}</div>
        <div className="fc-dlg-row">
          <label>{tx("名称", "Name")}</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("名称", "Name")} />
        </div>
        <div className="fc-dlg-foot">
          <button className="btn" onClick={onCancel}>{tx("取消", "Cancel")}</button>
          <button className="btn primary" onClick={() => onOk(name.trim() || init)}>{tx("确定", "OK")}</button>
        </div>
      </div>
    </div>
  );
}

export function TemplatesPanel() {
  useLocale();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const tele = useSyncExternalStore(teleStore.subscribe, teleStore.getSnapshot);
  const [newOpen, setNewOpen] = useState(false);
  const [pMenu, setPMenu] = useState(false);
  /**
   * P145：「＋ 预设」那枚菜单原来是一条 `position: absolute; right: 0; min-width: 230px`
   * 住在 `.rp-proto-body{overflow:hidden}` 里——导轨面板可以拖到 180px 宽，
   * 230px 的菜单放不下，左半截（正是每条预设名的头几个字）被祖先裁掉（用户实拍）。
   * 改成走宿主已有的浮层原语 `Flyout`：portal 到 body、按视口夹紧、zoom 补偿，
   * 于是"浮层住在会被裁剪的容器里"这一类病一次了断，而不是给这一枚再补一条 max-width。
   */
  const presetBtnRef = useRef<HTMLButtonElement | null>(null);
  const [presetAnchor, setPresetAnchor] = useState<HTMLElement | null>(null);
  const [note, setNote] = useState("");
  const [expGrp, setExpGrp] = useState<Set<string>>(() => new Set());
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const tplRootRef = useRef<HTMLDivElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!ctx) return;
    const el = ctxMenuRef.current;
    const root = tplRootRef.current;
    if (!el || !root) return;
    const cr = root.getBoundingClientRect();
    clampFlyoutMenu(el, root, ctx.x - cr.left, ctx.y - cr.top);
  }, [ctx]);
  const [rename, setRename] = useState<{ kind: "grp" | "tpl"; key: string; id: string; init: string } | null>(null);
  const [splitPct, setSplitPct] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem("vs.tplSplitPct"));
      return Number.isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (splitPct != null) localStorage.setItem("vs.tplSplitPct", String(splitPct));
    } catch {
      return;
    }
  }, [splitPct]);
  const dragRef = useRef<{ y: number; pct: number; panelH: number } | null>(null);
  /**
   * P105 反馈①（第二轮）：分割条往下拖的**最低限制就是页脚的上边缘**。
   *
   * 上一版我只给图例加了 `min-height`，没同步收这条下限，于是两件事同时坏：
   *  - 列表被 flex 收缩，鼠标前半段在"空走"——用户看到的就是"拖动这么缓慢、范围这么小"；
   *  - 窗口矮一档、或页脚多出一条会换行的同步错误时，最小值之和仍然超过面板，
   *    页脚（含那块半透明红的错误底）就画到图例上面去——用户说的"覆盖"就是这个。
   *
   * 所以这里**量着算**而不是写着猜：页脚高度随错误文本变，写死一个数就又漂了。
   */
  const listRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const splitMaxPct = useCallback(() => {
    const pr = tplRootRef.current, l = listRef.current, m = metaRef.current, f = footerRef.current;
    if (!pr || !l) return SPLIT_MAX;
    const prr = pr.getBoundingClientRect(), lr = l.getBoundingClientRect();
    const footerH = f ? f.getBoundingClientRect().height : 0;
    // 页脚高度是量的不是写死的：它会多出一条会换行的同步错误。
    // meta 也在列表与分割条之间（帧头/帧长/校验那两行），漏了它页脚就会溢出面板底——实测错过一次。
    const metaH = m ? m.getBoundingClientRect().height : 0;
    const avail = prr.bottom - lr.top - (metaH + SPLITTER_H + LEGEND_MIN + footerH);
    const pct = avail / (prr.height || 1);
    // 下限不许高于上限，否则窗口极矮时上下限互换、拖动直接失灵
    return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, pct));
  }, []);
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || d.panelH <= 0) return;
      const next = d.pct + (e.clientY - d.y) / d.panelH;
      setSplitPct(Math.min(splitMaxPct(), Math.max(SPLIT_MIN, next)));
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
    };
  }, [splitMaxPct]);
  /** 存档里的比例是在**别的窗口高度**下拖出来的；换窗口/换缩放后要先按当下重夹一次，
   *  否则第一次渲染就会重叠（拖动时才夹太晚了）。 */
  useLayoutEffect(() => {
    setSplitPct((cur) => (cur == null ? cur : Math.min(cur, splitMaxPct())));
  }, [splitMaxPct]);
  /**
   * 上一次的夹还不够：页脚里那条同步错误是**异步**出现的，挂载时它还不存在，
   * 于是按"矮页脚"算出的上限偏大，错误一出来页脚就溢到面板底外面（实测溢出 76.8px）。
   * 所以上限要跟着页脚与面板的实际尺寸重算 —— 只往下夹、不回弹：
   * 边界在用户眼皮底下自己变回去，比让它停在偏小的位置更糟。
   */
  useEffect(() => {
    const f = footerRef.current, p = tplRootRef.current;
    if (!f || !p || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setSplitPct((cur) => (cur == null ? cur : Math.min(cur, splitMaxPct())));
    });
    ro.observe(f);
    ro.observe(p);
    return () => ro.disconnect();
  }, [splitMaxPct]);

  const groups = useMemo(() => {
    const map = new Map<string, FrameTemplate[]>();
    for (const t of s.rules.templates) {
      const key = presetGroupKey(t) ?? t.id;
      const arr = map.get(key);
      if (arr) arr.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()];
  }, [s.rules.templates]);

  const currentTpl =
    (s.selection?.kind === "template" || s.selection?.kind === "field"
      ? s.rules.templates.find((t) => t.id === s.selection!.templateId)
      : undefined) ?? s.rules.templates[0];

  const toggleDemo = async () => {
    try {
      await store.toggleDemo();
    } catch {
      return;
    }
  };

  const pick = (id: string) => {
    store.setSelection({ kind: "template", templateId: id });
  };

  /** 导出协议簇（或单协议）为 JSON：导入侧走 uartix-templates 副本追加 */
  const exportCluster = async (key: string, tpls: FrameTemplate[]) => {
    const name = groupDisplayName(key, tpls[0]);
    try {
      const path = await save({
        title: tx("导出协议簇 JSON", "Export cluster JSON"),
        defaultPath: `${name}.json`,
        filters: [{ name: "Uartix+ " + tx("协议", "protocol"), extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const groups: Record<string, store.GroupMeta> = {};
      const meta = store.getGroupMeta(key);
      if (meta) groups[key] = meta;
      const content = JSON.stringify(
        { kind: "uartix-templates", version: 1, templates: tpls, groups },
        null,
        2,
      );
      await invoke("save_text_file", { path, content });
      setNote(
        tx("已导出「", "Exported \"") +
          name +
          tx("」（", "\" (") +
          tpls.length +
          tx(" 个帧型）", " frame types)"),
      );
    } catch (e) {
      setNote(tx("导出失败：", "Export failed: ") + String(e).slice(0, 80));
    }
    window.setTimeout(() => setNote(""), 3200);
  };

  const openCtx = (e: React.MouseEvent, key: string, tpls: FrameTemplate[], focused?: FrameTemplate) => {
    e.preventDefault();
    e.stopPropagation();
    const items: CtxItem[] = [];
    const multi = tpls.length > 1;
    const focus = focused ?? (multi ? undefined : tpls[0]);
    if (focus) {
      items.push({
        label: `${focus.name.replace(/·帧型\S+$/, "")}`,
        disabled: true,
      });
      items.push({
        label: tx("复制帧型", "Copy frame type"),
        onClick: () => {
          store.copyTpl(focus.id);
          setCtx(null);
        },
      });
      items.push({
        label: tx("粘贴帧型…", "Paste frame type…"),
        disabled: !store.canPaste(),
        title: store.canPaste() ? tx("粘贴到本组（跨组亦可先复制再粘贴）", "Paste into this group (you can copy from another group first)") : tx("请先复制一个帧型", "Copy a frame type first"),
        onClick: () => {
          store.pasteTpl(key);
          setCtx(null);
        },
      });
      items.push({
        label: tx("重命名帧型…", "Rename frame type…"),
        onClick: () => {
          setRename({ kind: "tpl", key, id: focus.id, init: focus.name });
          setCtx(null);
        },
      });
      items.push({
        label: tx("删除帧型", "Delete frame type"),
        onClick: () => {
          store.removeTemplate(focus.id);
          setCtx(null);
        },
      });
    } else if (multi) {
      const hasPreset = tpls.some((t) => !!t.presetKey);
      items.push({
        label: tx("重命名协议簇…", "Rename cluster…"),
        disabled: hasPreset,
        title: hasPreset ? tx("预设协议簇不可重命名", "Preset clusters cannot be renamed") : tx("修改簇名称", "Change the cluster name"),
        onClick: () => {
          setRename({ kind: "grp", key, id: "", init: groupDisplayName(key, tpls[0]) });
          setCtx(null);
        },
      });
      items.push({
        label: tx("粘贴帧型…", "Paste frame type…"),
        disabled: !store.canPaste(),
        onClick: () => {
          store.pasteTpl(key);
          setCtx(null);
        },
      });
      items.push({
        label: tpls.every((t) => t.enabled) ? tx("整组停用", "Disable whole group") : tx("整组启用", "Enable whole group"),
        onClick: () => {
          store.setGroupEnabled(key, !tpls.every((t) => t.enabled), (t) => presetGroupKey(t) ?? t.id);
          setCtx(null);
        },
      });
      items.push({
        label: tx("导出此簇 JSON…", "Export cluster JSON…"),
        title: tx("导出整簇为可分享文件（导入方以副本追加，不覆盖）", "Export the whole cluster as a shareable file (imported as copies, never overwritten)"),
        onClick: () => {
          setCtx(null);
          void exportCluster(key, tpls);
        },
      });
      items.push({
        label: tx("删除整组", "Delete whole group"),
        onClick: () => {
          store.replaceRules(
            s.rules.templates.filter((t) => !tpls.some((x) => x.id === t.id)),
          );
          setCtx(null);
        },
      });
    }
    setCtx({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, items });
  };

  const onGroupClick = (tpls: FrameTemplate[]) => {
    pick((tpls.find((t) => t.enabled) ?? tpls[0]).id);
  };

  return (
    <div className="tpl-panel" ref={tplRootRef}>
      {/* P104-R4：链路节搬去导轨「接入」了——接口切换与参数在那里一处看完，
          这一栏重新只做"协议模板与帧型树"那一件事。 */}
      <div className="tpl-header">
        {/* P103 批2（1-21）：页签条已显示「协议模板」，面板内不再重复；头部只剩动作行（右对齐） */}
        <div className="tpl-header-actions">
          <button className="btn" title={tx("新建空白协议或协议簇（多帧型分组，可复制/粘贴帧型）", "New blank protocol or cluster (multi frame-type group, copy/paste supported)")} onClick={() => setNewOpen(true)}>
            {tx("＋ 新建", "+ New")}
          </button>
          <div className="tpl-preset-wrap">
          <button ref={presetBtnRef} className="btn tpl-preset-btn" data-tour="preset" aria-haspopup="menu" aria-expanded={pMenu} title={tx("从预设导入协议副本（可反复添加，改崩了删除副本再添加）", "Import editable copies from presets (add repeatedly; delete a broken copy and re-import)")} onClick={() => { setPresetAnchor(presetBtnRef.current); setPMenu((v) => !v); }}>
            {tx("＋ 预设", "+ Preset")} <IconChevron size={12} dir="down" />
          </button>
          {pMenu && (
            <>
              <div className="tpl-menu-mask" onClick={() => setPMenu(false)} />
              <Flyout anchor={presetAnchor} zf={zoomFactor()} minWidth={230}>
                <span className="tpl-menu-title">{tx("导入预设副本", "Import preset copies")}</span>
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    className="tpl-menu-item"
                    role="menuitem"
                    title={p.desc}
                    onClick={() => {
                      setPMenu(false);
                      applyPreset(p);
                    }}
                  >
                    {p.tag} {p.name}
                  </button>
                ))}
              </Flyout>
            </>
          )}
          </div>
        </div>
      </div>
      {note && <div className="tpl-note">{note}</div>}

      <div
        ref={listRef}
        className="tpl-list"
        style={splitPct != null ? { flex: "none", height: `${splitPct * 100}%`, maxHeight: "none" } : undefined}
      >
        {s.rules.templates.length === 0 && (
          <div className="tpl-empty-state">
            <EmptyState
              title={tx("尚无协议模板", "No protocol templates yet")}
              hint={[tx("点「＋ 新建」创建空白协议/协议簇", 'Click "+ New" to create a blank protocol / cluster'), tx("或「＋ 预设」导入已有协议", 'or "+ Preset" to import a built-in protocol')]}
            />
          </div>
        )}
        {groups.map(([key, tpls]) => {
          const multi = tpls.length > 1;
          const open = expGrp.has(key);
          const allOn = tpls.every((t) => t.enabled);
          const someOn = tpls.some((t) => t.enabled);
          const cur = currentTpl && tpls.some((t) => t.id === currentTpl.id);
          const label = multi ? groupDisplayName(key, tpls[0]) : stripF(tpls[0].name);
          const dotC = tpls[0].color;
          const cnt = tpls.reduce((a, t) => a + (tele.tplStats[t.id]?.ok ?? 0), 0);
          const errs = tpls.reduce((a, t) => a + (tele.tplStats[t.id]?.err ?? 0), 0);
          return (
            <div key={key} className={`tpl-grp${cur ? " on" : ""}`}>
              <div
                className="tpl-row tpl-grow"
                onClick={() => {
                  onGroupClick(tpls);
                }}
                onContextMenu={(e) => openCtx(e, key, tpls)}
                title={multi ? `${label} · ${tx("点击选中，点箭头展开帧型；右键：簇菜单", "click to select, arrow expands frame types; right-click: cluster menu")}` : tpls[0].name}
              >
                {multi ? (
                  <button
                    className={`tpl-chev-btn${open ? " open" : ""}`}
                    title={open ? tx("收起帧型列表", "Collapse frame types") : tx("展开帧型列表", "Expand frame types")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpGrp((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      });
                    }}
                  >
                    <Glyph>
                      <polyline points="9 6 15 12 9 18" />
                    </Glyph>
                  </button>
                ) : (
                  <span className="tpl-chev" />
                )}
                <span className="tpl-dot" style={{ background: dotC }} />
                <span className="tpl-row-name">
                  {label}
                  {multi ? (
                    <em className="tpl-src">
                      {tpls.length} {tx("帧型", "types")}{someOn && !allOn ? `·${tx("部分解析", "partial")}` : ""}
                    </em>
                  ) : (
                    tpls[0].presetKey && <em className="tpl-src">{tx("预设", "preset")}</em>
                  )}
                  <span className="tpl-row-stats">
                    {cnt}
                    {errs ? ` / ${tx("错", "err")}${errs}` : ""}
                  </span>
                </span>
                {multi && (
                  <button
                    className="tpl-add-type"
                    title={tx("向此簇添加一条帧型（边界沿用簇内首条，帧头/帧长在帧画布调整）", "Add a frame type to this cluster (boundaries copied from the first; tune header/length in Frame Canvas)")}
                    onClick={(e) => {
                      e.stopPropagation();
                      store.addClusterFrame(key);
                    }}
                  >
                    ＋
                  </button>
                )}
                <input
                  type="checkbox"
                  className="chk-box"
                  checked={allOn}
                  title={allOn ? tx("整组解析中（取消停用）", "Whole group parsing (uncheck to disable)") : someOn ? tx("部分帧型解析中", "Some frame types parsing") : tx("整组停用（点击启用全部）", "Whole group disabled (click to enable all)")}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    store.setGroupEnabled(key, e.target.checked, (t) => presetGroupKey(t) ?? t.id);
                    pick(tpls.find((t) => t.enabled)?.id ?? tpls[0].id);
                  }}
                />
                <button
                  className="tpl-del"
                  title={tx("删除整组协议副本（预设源不受影响，可再导入）", "Delete all copies in this group (preset sources are untouched and can be re-imported)")}
                  onClick={(e) => {
                    e.stopPropagation();
                    store.replaceRules(
                      s.rules.templates.filter((t) => !tpls.some((x) => x.id === t.id)),
                    );
                  }}
                >
                  ×
                </button>
              </div>
              {multi && open && (
                <>
                  {tpls.map((t) => {
                    const st = tele.tplStats[t.id] ?? { ok: 0, err: 0 };
                    return (
                      <div
                        key={t.id}
                        className={`tpl-row tpl-subrow${currentTpl?.id === t.id ? " on" : ""}${t.enabled ? "" : " off"}`}
                        onClick={() => pick(t.id)}
                        onContextMenu={(e) => openCtx(e, key, tpls, t)}
                        title={`${t.name} · ${tx("右键：复制/粘贴/重命名/删除", "right-click: copy/paste/rename/delete")}`}
                      >
                        <span className="tpl-dot" style={{ background: t.color }} />
                        <span className="tpl-row-name">
                          {t.name}
                          <span className="tpl-row-stats">
                            {st.ok}
                            {st.err ? ` / ${tx("错", "err")}${st.err}` : ""}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          className="chk-box"
                          checked={t.enabled}
                          title={tx("启用/停用该帧型", "Enable/disable this frame type")}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            store.patchTemplate(t.id, { enabled: e.target.checked });
                            pick(t.id);
                          }}
                        />
                        <button
                          className="tpl-del"
                          title={tx("删除该帧型副本", "Delete this frame-type copy")}
                          onClick={(e) => {
                            e.stopPropagation();
                            store.removeTemplate(t.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </div>

      {currentTpl && (
        <div className="tpl-meta" ref={metaRef}>
          {tx("帧头", "Header")}{" "}
          {currentTpl.boundary.headerBytes
            .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
            .join(" ") || tx("（无）", "(none)")}
          {" · "}
          {currentTpl.boundary.mode === "fixedLength"
            ? tx(`固定帧长 ${currentTpl.boundary.fixedLength}`, `fixed length ${currentTpl.boundary.fixedLength}`)
            : currentTpl.boundary.mode === "lengthField"
              ? tx("长度字段截帧", "length-field framing")
              : tx("帧尾截帧", "footer framing")}
          {currentTpl.checksum && currentTpl.checksum.algo !== "none"
            ? ` · ${currentTpl.checksum.algo}`
            : ""}
          {currentTpl.boundary.discValue?.length
            ? ` · ${tx("识别位", "disc")}@${currentTpl.boundary.discOffset}`
            : ""}
          <button className="tpl-open" onClick={() => pick(currentTpl.id)}>
            {tx("在面板编辑 →", "Edit in panel →")}
          </button>
        </div>
      )}

      <div
        className="tpl-splitter"
        title={tx("上下拖动调整列表高度（双击复位）", "Drag vertically to resize the list (double-click to reset)")}        onMouseDown={(e) => {
          const panelEl = tplRootRef.current;
          dragRef.current = {
            y: e.clientY,
            pct: splitPct ?? 0.4,
            panelH: panelEl ? panelEl.clientHeight : 400,
          };
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
        }}
        onDoubleClick={() => setSplitPct(null)}
      >
        <span />
      </div>

      {/* P105-C：字段图例回到「协议」下面的这一格。导轨是**单槽**，
          原来「协议」与「通道」永远不能同屏 —— 而字段本来就是协议解析出来的产物，
          拆成两格是这轮改动自己造出来的人为割裂。
          上面那根分割条现在分的就是"模板列表 ↔ 字段图例"，机制没新造一个。 */}
      <div className="tpl-legend">
        <FieldLegend />
      </div>

      <div className="tpl-footer" ref={footerRef}>
        {s.syncError && <div className="tpl-sync-error">{s.syncError}</div>}
        <div className="tpl-demo">
          <button
            className={`btn ${s.demoRunning ? "danger" : ""}`}
            data-tour="demo"
            onClick={toggleDemo}
          >
            {s.demoRunning ? tx("停止演示源", "Stop demo source") : tx("启动演示源", "Start demo source")}
          </button>
        </div>
      </div>

      {newOpen && (
        <NewTplDlg
          onOk={(r) => {
            setNewOpen(false);
            if (r.mode === "cluster") {
              store.createCluster(r.name, r.count, r.len);
            } else if (r.mode === "csv") {
              store.createCsvTemplate(r.delim, r.elemType, r.lineEnd);
            } else {
              store.createBlankTemplate(r.len);
            }
            requestOpenPanel("framecanvas");
          }}
          onCancel={() => setNewOpen(false)}
        />
      )}

      {rename && (
        <RenameDlg
          title={rename.kind === "grp" ? tx("重命名协议簇", "Rename cluster") : tx("重命名帧型", "Rename frame type")}
          init={rename.init}
          onOk={(nm) => {
            if (rename.kind === "grp") store.renameGroup(rename.key, nm);
            else store.patchTemplate(rename.id, { name: nm });
            setRename(null);
          }}
          onCancel={() => setRename(null)}
        />
      )}

      {ctx && (
        <>
          <div className="fc-menu-mask" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
          <div className="fc-menu" ref={ctxMenuRef} style={{ left: ctx.x, top: ctx.y }}>
            {ctx.items.map((it) => (
              <button
                key={it.label}
                className={`fc-menu-item${it.disabled ? "" : ""}`}
                disabled={it.disabled}
                title={it.title}
                onClick={it.onClick}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function stripF(n: string): string {
  return n.replace(/\s*\(副本\)\s*$/, "");
}
