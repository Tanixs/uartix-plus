import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { FrameRow, ValueLabel } from "../../ipc/types";
import * as framesStore from "./framesStore";
import { labeledValue } from "../../shared/valueLabels";
import * as templateStore from "../protocol/templateStore";
import { presetGroupKey, groupDisplayName } from "../framecanvas/presets";
import { ColumnTreeMenu, type ColGroup } from "./ColumnTreeMenu";
import {
  IconChevron,
  IconClose,
  IconColumns,
  IconDownload,
  IconPause,
  IconPlay,
  IconTrash,
} from "../../shared/icons";
import { EmptyState } from "../../shared/EmptyState";
import { Toolbar } from "../../shared/Toolbar";
import { ActionMenu } from "../../shared/ActionMenu";
import { useSettings } from "../settings/settingsStore";
import { t, tx, useLocale } from "../../i18n/strings";

const ROW_H = 26;
const HEADER_H = 26;
const DECODABLE_ROLES = new Set(["data", "payload", "id", "seq", "length"]);

function loadHiddenCols(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem("vs.table.hidden") ?? "[]");
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

interface Col {
  /** 列身份：字段列是 `f:<模板id>:<字段id>`。字段 id 只在模板内唯一（旧档是 4/5/6 这类
      按模板计数的小数字），跨模板平铺成同一列表时会撞 key，所以必须带上模板作用域。 */
  key: string;
  label: string;
  /** 字段列才有：取数/标签用的原始字段 id */
  fieldId?: string;
}

export function DataTable() {
  useSettings(); // 语言切换时随设置重渲染
  /** 表头是 tx() 出来的，而 `cols` 是 memo 的 —— 不按住语言，切完语言表头会停在旧文案 */
  const loc = useLocale();
  const frames = useSyncExternalStore(framesStore.subscribe, framesStore.getSnapshot);
  const proto = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const [sort, setSort] = useState<{ key: string; fieldId?: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(loadHiddenCols);
  const [menuOpen, setMenuOpen] = useState(false);
  const colBtnRef = useRef<HTMLButtonElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(240);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const frozenRef = useRef<FrameRow[]>([]);

  if (!frames.paused) frozenRef.current = frames.rows;
  const baseRows = frames.paused ? frozenRef.current : frames.rows;
  const templates = proto.rules.templates;

  const fieldColsAll: Col[] = useMemo(() => {
    return templates.flatMap((t) =>
      t.fields
        .filter((f) => DECODABLE_ROLES.has(f.role))
        .map((f) => ({
          key: `f:${t.id}:${f.id}`,
          fieldId: f.id,
          label: `${t.name}·${f.name}`,
        })),
    );
  }, [templates]);

  const colGroups: ColGroup[] = useMemo(() => {
    const out: ColGroup[] = [];
    const byKey = new Map<string, ColGroup>();
    for (const t of templates) {
      const fields = t.fields
        .filter((f) => DECODABLE_ROLES.has(f.role))
        .map((f) => ({ id: `f:${t.id}:${f.id}`, name: f.name, csv: f.type === "csv" }));
      const key = presetGroupKey(t) ?? t.id;
      let g = byKey.get(key);
      if (!g) {
        g = { key, name: groupDisplayName(key, t), tpls: [] };
        byKey.set(key, g);
        out.push(g);
      }
      g.tpls.push({ id: t.id, name: t.name, color: t.color, enabled: t.enabled, fields });
    }
    return out;
  }, [templates]);

  useEffect(() => {
    localStorage.setItem("vs.table.hidden", JSON.stringify([...hiddenCols]));
  }, [hiddenCols]);

  useEffect(() => {
    const ids = new Set(fieldColsAll.map((c) => c.key));
    /* 旧档隐藏列存的是裸字段 id；列身份升级成带模板作用域后要就地迁移，
       否则用户之前藏掉的列会在升级后重新冒出来。 */
    const scopedByField = new Map<string, string[]>();
    for (const c of fieldColsAll) {
      if (!c.fieldId) continue;
      const arr = scopedByField.get(c.fieldId) ?? [];
      arr.push(c.key);
      scopedByField.set(c.fieldId, arr);
    }
    setHiddenCols((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else for (const scoped of scopedByField.get(id) ?? []) next.add(scoped);
      }
      const same = next.size === prev.size && [...prev].every((id) => next.has(id));
      return same ? prev : next;
    });
  }, [fieldColsAll]);

  const setVisibleMany = (ids: string[], visible: boolean) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (visible) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const cols: Col[] = useMemo(() => {
    return [
      { key: "ts", label: tx("时间", "Time") },
      { key: "tpl", label: tx("模板", "Template") },
      ...fieldColsAll.filter(
        (c) => !hiddenCols.has(c.key) && !(c.fieldId && hiddenCols.has(c.fieldId)),
      ),
      { key: "valid", label: tx("状态", "Status") },
    ];
  }, [fieldColsAll, hiddenCols, loc]);

  /** 值标签索引（字段 id → 标签表）：只收录配了标签的字段，单元格按值附注文字 */
  const labelById = useMemo(() => {
    const m = new Map<string, ValueLabel[]>();
    for (const t of templates) for (const f of t.fields) if (f.labels?.length) m.set(f.id, f.labels);
    return m;
  }, [templates]);

  const toggleCol = (key: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const shown = useMemo(() => {
    let arr = baseRows;
    const q = filter.trim().toLowerCase();
    if (q) {
      arr = arr.filter((r) => {
        if (r.tplName.toLowerCase().includes(q)) return true;
        if (fmtTime(r.tsMs).includes(q)) return true;
        for (const f of r.fields) {
          if (f.name.toLowerCase().includes(q)) return true;
          if (f.text !== null && f.text.toLowerCase().includes(q)) return true;
          if (String(f.value).includes(q)) return true;
        }
        return false;
      });
    }
    if (sort) {
      const { key, fieldId, dir } = sort;
      arr = [...arr].sort((a, b) => {
        let c = 0;
        if (key === "ts") c = a.tsMs - b.tsMs;
        else if (key === "tpl") c = a.tplName.localeCompare(b.tplName, "zh");
        else if (key === "valid") c = (a.valid ? 1 : 0) - (b.valid ? 1 : 0);
        else {
          const fid = fieldId ?? key;
          const fa = a.fields.find((x) => x.id === fid);
          const fb = b.fields.find((x) => x.id === fid);
          if (fa && fb) {
            if (fa.text !== null || fb.text !== null) {
              c = (fa.text ?? "").localeCompare(fb.text ?? "", "zh");
            } else {
              c = fa.value - fb.value;
            }
          } else if (fa) c = 1;
          else if (fb) c = -1;
        }
        return c * dir;
      });
    }
    return arr;
  }, [baseRows, filter, sort]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 33 : e.deltaX;
      if (!dy && !dx) return;
      e.preventDefault();
      el.scrollTop += dy;
      el.scrollLeft += dx;
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    if (followRef.current && !sort && !filter && !frames.paused) {
      const el = bodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [shown.length, sort, filter, frames.paused]);

  const total = shown.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
  const end = Math.min(total, start + Math.ceil(viewH / ROW_H) + 8);
  const slice = shown.slice(start, end);
  // 时间列 104px：ts 是 12px 等宽体的 "00:00:01.204"（12 字符 × 约 7.2px ≈ 86px）加 .tbl-cell 左右各 8px 内距
  // ≈ 102px；此前给 92px，实测列里显示成 "00:00:01.…"（夹具截图实锤）。表头与行共用这一个串，不会错位。
  const gridCols = `104px 108px repeat(${Math.max(cols.length - 3, 0)}, minmax(96px, 1fr)) 76px`;

  const cellText = (r: FrameRow, col: Col): string => {
    if (col.key === "ts") return fmtTime(r.tsMs);
    if (col.key === "tpl") return r.tplName;
    if (col.key === "valid") return r.valid ? "OK" : "ERR";
    const id = col.fieldId ?? col.key;
    const f = r.fields.find((x) => x.id === id);
    if (!f) return "–";
    if (f.text !== null) return f.text;
    return labeledValue(labelById.get(id), f.value, fmtNum);
  };

  const doExport = async (kind: "csv" | "xlsx") => {
    const path = await save({
      title: t("tbl.exportTitle"),
      defaultPath: `vs-data-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${kind}`,
      filters: [
        {
          name: kind === "csv" ? tx("CSV 文件", "CSV file") : tx("Excel 工作簿", "Excel workbook"),
          extensions: [kind],
        },
      ],
    });
    if (!path) return;
    const fieldCols = cols.slice(2, -1);
    /** 导出表头从 `cols` 取，不在这三个词再抄一遍 —— 抄了就会有"界面英文、文件表头中文"那天 */
    const head = (k: string) => cols.find((c) => c.key === k)?.label ?? k;
    const aoa: (string | number)[][] = [
      [head("ts"), head("tpl"), head("valid"), ...fieldCols.map((c) => c.label)],
      ...shown.map((r) => [
        fmtTime(r.tsMs),
        r.tplName,
        r.valid ? "OK" : r.error ?? "ERR",
        ...fieldCols.map((c) => {
          const fid = c.fieldId ?? c.key;
          const f = r.fields.find((x) => x.id === fid);
          if (!f) return "";
          if (f.text !== null) return f.text;
          // 导出同样带上值标签（异常码等枚举量在 Excel 里直接可读）
          const lb = labelById.has(fid)
            ? labeledValue(labelById.get(fid), f.value, (n) => String(n))
            : "";
          return lb || Number(f.value.toFixed(6));
        }),
      ]),
    ];
    try {
      if (kind === "csv") {
        const esc = (v: string | number) => {
          const s = String(v);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = "\uFEFF" + aoa.map((row) => row.map(esc).join(",")).join("\r\n");
        await invoke("save_text_file", { path, content: csv });
      } else {
        await invoke("export_xlsx", { path, rows: aoa });
      }
    } catch (e) {
      console.error("export failed", e);
    }
  };

  const toggleSort = (col: Col) => {
    setSort((s) => {
      if (!s || s.key !== col.key) return { key: col.key, fieldId: col.fieldId, dir: 1 };
      if (s.dir === 1) return { key: col.key, fieldId: col.fieldId, dir: -1 };
      return null;
    });
  };

  const arrow = (key: string) =>
    sort?.key === key ? (
      <IconChevron size={12} dir={sort.dir === 1 ? "up" : "down"} />
    ) : null;

  return (
    <div className="tbl">
      {/* P179-UI03：左=数据范围（缓存上限 + 筛选 + 截断状态），右=视图/工具（≤3 + ⋯）。
          分析包与导出收进 ⋯：它们是低频动作，不该与"暂停/清空"同权重。 */}
      <Toolbar
        className="tbl-bar"
        left={
          <>
            <select
              className="input tbl-cap"
              value={frames.maxRows}
              title={t("tbl.cap")}
              aria-label={t("tbl.cap")}
              onChange={(e) => framesStore.setMaxRows(Number(e.target.value))}
            >
              {[500, 1000, 5000, 10000, 50000].map((n) => (
                <option key={n} value={n}>
                  {t("tbl.cache")} {n} {t("tbl.rows")}
                </option>
              ))}
            </select>
            <input
              className="input tbl-filter"
              placeholder={t("tbl.filter")}
              aria-label={t("tbl.filter")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {frames.capped && (
              <span className="tbl-capped" title={t("tbl.capped")}>
                {t("tbl.truncated")}
              </span>
            )}
          </>
        }
        right={
          <>
            <button
              className={`btn icon-btn ${frames.paused ? "on" : ""}`}
              onClick={() => framesStore.setPaused(!frames.paused)}
              title={frames.paused ? t("tbl.resume") : t("tbl.pause")}
              aria-label={frames.paused ? t("tbl.resume") : t("tbl.pause")}
              aria-pressed={frames.paused}
            >
              {frames.paused ? <IconPlay /> : <IconPause />}
            </button>
            <button className="btn icon-btn" onClick={() => framesStore.clearRows()} title={t("tbl.clear")} aria-label={t("tbl.clear")}>
              <IconTrash />
            </button>
            <button
              ref={colBtnRef}
              className={`btn icon-btn ${menuOpen ? "on" : ""}`}
              title={t("tbl.columns")}
              aria-label={t("tbl.columns")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <IconColumns />
            </button>
            <ActionMenu
              label={tx("更多数据操作", "More data actions")}
              items={[
                {
                  id: "analysis",
                  label: tx("导出分析包", "Export analysis package"),
                  title: tx("打开分析包；在对话框中选择缓存范围", "Open analysis package; choose the cache scope in the dialog"),
                  Icon: <IconDownload />,
                  // The event accepts a computed snapshot, not a row selection. Open the
                  // global dialog without a snapshot; the user picks its cache scope there.
                  onSelect: () => window.dispatchEvent(new Event("vs-analysis-export")),
                },
                {
                  id: "csv",
                  label: tx("导出 CSV", "Export CSV"),
                  title: t("tbl.exportCsv"),
                  Icon: <IconDownload />,
                  onSelect: () => doExport("csv"),
                },
                {
                  id: "xlsx",
                  label: tx("导出 XLSX", "Export XLSX"),
                  title: t("tbl.exportExcel"),
                  Icon: <IconDownload />,
                  onSelect: () => doExport("xlsx"),
                },
              ]}
            />
          </>
        }
      />
      {menuOpen && (
        <ColumnTreeMenu
          anchor={colBtnRef.current}
          groups={colGroups}
          hidden={hiddenCols}
          onSetMany={setVisibleMany}
          onToggleField={toggleCol}
          onClose={() => setMenuOpen(false)}
        />
      )}
      <div className="tbl-scroll" ref={bodyRef} onScroll={onScroll}>
        <div
          className="tbl-inner"
          style={{ height: HEADER_H + total * ROW_H, minWidth: "100%", width: "max-content" }}
        >
          <div className="tbl-header" style={{ gridTemplateColumns: gridCols, height: HEADER_H }}>
            {cols.map((c) => (
              <div
                key={c.key}
                className="tbl-hcell"
                data-ctl="col"
                onClick={() => toggleSort(c)}
                title={`${t("tbl.sortBy")}：${c.label}`}
              >
                {c.label}
                {arrow(c.key)}
                {c.fieldId && (
                  <button
                    className="tbl-col-del"
                    title={t("tbl.hideCol")}
                    aria-label={t("tbl.hideCol")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCol(c.key);
                    }}
                  >
                    {/* UI-15：字符「×」换成 SVG 图标，字符图标在不同字体下光学尺寸不一致 */}
                    <IconClose />
                  </button>
                )}
              </div>
            ))}
          </div>
          {slice.map((r, i) => (
            <div
              key={r.seq.toString() + r.tsMs.toString() + i}
              className={`tbl-row ${r.valid ? "" : "err"}`}
              style={{ top: HEADER_H + (start + i) * ROW_H, gridTemplateColumns: gridCols, height: ROW_H }}
              title={r.error ?? t("tbl.locate")}
              onClick={() => templateStore.locate(r.seq)}
            >
              {cols.map((c) => (
                <div key={c.key} className="tbl-cell">
                  {cellText(r, c)}
                </div>
              ))}
            </div>
          ))}
        </div>
        {/* P155-E：空态**不能**住在 .tbl-inner 里——那里 total=0 时高度只有表头那 26px，
            老的 top:40px+bottom:0 直接算出负高，空态骑在表头上（实测宿主 26px / 溢出裁切）。
            挂到 .tbl-scroll（position:relative 由 CSS 给），top 用 HEADER_H 同一出处，
            让出表头那一条，剩下的滚动区里居中。 */}
        {total === 0 && (
          <div className="tbl-empty-slot" style={{ top: HEADER_H }}>
            <EmptyState
              title={t("tbl.empty")}
              hint={[tx("启动演示源或连接串口后，解析出的帧会逐行显示在这里", "Once the demo source or the serial port is running, parsed frames fill in row by row")]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

