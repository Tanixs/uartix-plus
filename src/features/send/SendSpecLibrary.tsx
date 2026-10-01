/**
 * P124-B · 发送谱清单，住在左侧导轨「协议 › 发送谱」。
 *
 * 判据是导轨自己写下的那条分界线："库在左，视图在中间画布"（`shell/SideRail.tsx`）。
 * 发送谱是**库**：一组可命名、被命令/卡片/序列器引用、可导入导出的对象。
 * 以前它的对象管理与编辑工作台挤在同一枚面板里，工具条一半对象动作、一半文档动作 ——
 * 于是那枚 `＋`（新建一张谱）紧贴着「预设」，读起来就成了"＋预设"。
 *
 * 动作一律走 `specOps`（与面板共用同一份实现），结果话术显示在**这一面**：
 * 从哪儿点的就从哪儿回，不然用户点完不知道系统有没有听见。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { Flyout } from "../../shared/Flyout";
import { IconChevron, IconClock, IconDownload, IconPlus, IconUpload } from "../../shared/icons";
import { requestOpenPanel } from "../ai/appBus";
import { useSettings } from "../settings/settingsStore";
import * as sendStore from "./sendStore";
import { SEND_PRESETS, type SendPresetDef } from "./sendPresets";
import {
  createSpec,
  draftFromLastFrame,
  duplicateSpec,
  exportSpec,
  importSpec,
  loadPresetPack,
  removeSpec,
  specByteLen,
  specRefCount,
  type SpecOpResult,
} from "./specOps";
import type { SendTemplate } from "./sendTypes";

export function SendSpecLibrary() {
  useLocale();
  const settings = useSettings();
  const zf = (settings.zoom || 100) / 100;
  const tpls = useSyncExternalStore(sendStore.subscribe, sendStore.getSnapshot);
  const selected = useSyncExternalStore(sendStore.subscribe, sendStore.getSelectedSpec);
  const [msg, setMsg] = useState("");
  const [bad, setBad] = useState(false);
  const [presetAnchor, setPresetAnchor] = useState<HTMLElement | null>(null);
  const [rowMenu, setRowMenu] = useState<{ tpl: SendTemplate; anchor: HTMLElement } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const presetRef = useRef<HTMLDivElement | null>(null);

  const show = (r: SpecOpResult) => {
    setBad(!r.ok);
    setMsg(r.msg);
    if (r.selectId) sendStore.requestSelect(r.selectId);
  };

  // 浮层开着时：点外面或按 Esc 收起（与面板里那颗「预设」同一套行为）
  useEffect(() => {
    if (!presetAnchor && !rowMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (presetAnchor && (presetRef.current?.contains(t) || presetAnchor.contains(t))) return;
      if (rowMenu && (menuRef.current?.contains(t) || rowMenu.anchor.contains(t))) return;
      setPresetAnchor(null);
      setRowMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPresetAnchor(null);
        setRowMenu(null);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [presetAnchor, rowMenu]);

  const openIn = (id: string) => {
    sendStore.requestSelect(id);
    requestOpenPanel("sendbuild");
  };

  const loadPreset = (def: SendPresetDef) => {
    setPresetAnchor(null);
    const r = loadPresetPack(def);
    show(r);
    if (r.ok) requestOpenPanel("sendbuild");
  };

  return (
    <div className="spl">
      <div className="spl-bar">
        <button
          className="btn"
          title={tx("新建一张空谱，然后到 TX组帧台里往字节带上摆块", "Create an empty template, then add blocks on the grid")}
          onClick={() => {
            show(createSpec());
            requestOpenPanel("sendbuild");
          }}
        >
          <IconPlus /> {tx("新建谱", "New")}
        </button>
        <button
          className="btn icon-btn"
          title={tx(
            "载入示例谱（可反复载入；改崩了删掉那一份再载入一次）",
            "Load example templates (repeatable; delete a broken one and load it again)",
          )}
          aria-expanded={presetAnchor !== null}
          onClick={(e) => {
            const el = e.currentTarget;
            setPresetAnchor((cur) => (cur === el ? null : el));
          }}
        >
          <IconChevron dir="down" size={12} />
        </button>
        <button
          className="btn icon-btn"
          title={tx(
            "照最近收到的一帧起一张谱（能重算验证的才写进谱，其余按定长字节放）",
            "Draft a template from the last received frame (only what recomputes exactly gets inferred)",
          )}
          onClick={() => {
            show(draftFromLastFrame());
            requestOpenPanel("sendbuild");
          }}
        >
          <IconClock />
        </button>
        <span className="spl-bar-spacer" />
        <button className="btn icon-btn" title={tx("从文件导入发送谱", "Import from file")} onClick={() => void importSpec().then(show)}>
          <IconUpload />
        </button>
        <button
          className="btn icon-btn"
          title={tx("把当前这张谱导出成文件", "Export the current template to a file")}
          onClick={() => {
            const t = tpls.find((x) => x.id === selected) ?? tpls[0];
            if (t) void exportSpec(t).then(show);
          }}
        >
          <IconDownload />
        </button>
      </div>

      {presetAnchor && (
        <Flyout anchor={presetAnchor} zf={zf} minWidth={220}>
          <div ref={presetRef}>
            <div className="ctx-group">{tx("载入示例谱（只新增，不动你已有的）", "Load examples — added, never overwriting yours")}</div>
            {SEND_PRESETS.map((d) => (
              <button key={d.key} className="ctx-item" title={d.desc} onClick={() => loadPreset(d)}>
                {d.tag} · {d.name}
              </button>
            ))}
          </div>
        </Flyout>
      )}
      {rowMenu && (
        <Flyout anchor={rowMenu.anchor} zf={zf} minWidth={170}>
          <div ref={menuRef}>
            <button
              className="ctx-item"
              onClick={() => {
                show(duplicateSpec(rowMenu.tpl));
                setRowMenu(null);
              }}
            >
              {tx("复制这一张", "Duplicate")}
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                void exportSpec(rowMenu.tpl).then(show);
                setRowMenu(null);
              }}
            >
              {tx("导出这一张", "Export this one")}
            </button>
            <button
              className="ctx-item danger"
              title={tx("撤销可以退回来", "Undo brings it back")}
              onClick={() => {
                show(removeSpec(rowMenu.tpl));
                setRowMenu(null);
              }}
            >
              {tx("删除这一张", "Delete")}
            </button>
          </div>
        </Flyout>
      )}

      <div className="spl-list">
        {tpls.map((t) => {
          const bytes = specByteLen(t);
          const refs = specRefCount(t.id);
          return (
            <div key={t.id} className={`spl-row${t.id === selected ? " on" : ""}`}>
              <button type="button" className="spl-main" onClick={() => openIn(t.id)} title={t.note || t.name}>
                <span className="spl-name">{t.name}</span>
                <span className="spl-meta">
                  {tx(
                    `${t.fields.length} 块 · ${bytes === null ? "编不出" : bytes + " B"} · ${t.params.length} 参数${
                      t.checksum && t.checksum.algo !== "none" ? " · " + t.checksum.algo : ""
                    }${refs ? " · 被 " + refs + " 条指令引用" : ""}`,
                    `${t.fields.length} blocks · ${bytes === null ? "won't encode" : bytes + " B"} · ${t.params.length} params${
                      t.checksum && t.checksum.algo !== "none" ? " · " + t.checksum.algo : ""
                    }${refs ? " · referenced by " + refs : ""}`,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="spl-kebab"
                aria-label={tx("这一张谱的操作", "Actions for this template")}
                onClick={(e) => {
                  const el = e.currentTarget;
                  setRowMenu((cur) => (cur?.tpl.id === t.id ? null : { tpl: t, anchor: el }));
                }}
              >
                ⋯
              </button>
            </div>
          );
        })}
        {!tpls.length && (
          <div className="spl-none">
            {tx("还没有发送谱：新建一张，或从预设载入。", "No send templates yet — create one or load a preset.")}
          </div>
        )}
      </div>
      {msg && (
        <div className={`spl-msg${bad ? " bad" : ""}`} role="status">
          {msg}
        </div>
      )}
    </div>
  );
}
