import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { FrameRow } from "../../ipc/types";
import * as framesStore from "./framesStore";
import * as templateStore from "../protocol/templateStore";
import {
  IconColumns,
  IconPause,
  IconPlay,
  IconTrash,
} from "../../shared/icons";
import { EmptyState } from "../../shared/EmptyState";
import { useSettings } from "../settings/settingsStore";
import { t } from "../../i18n/strings";

const ROW_H = 26;
const HEADER_H = 26;

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
  key: string;
  label: string;
}

export function DataTable() {
  useSettings(); // 语言切换时随设置重渲染
  const frames = useSyncExternalStore(framesStore.subscribe, framesStore.getSnapshot);
  const proto = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
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
      t.fields.map((f) => ({ key: f.id, label: `${t.name}·${f.name}` })),
    );
  }, [templates]);

  const cols: Col[] = useMemo(() => {
    return [
      { key: "ts", label: "时间" },
      { key: "tpl", label: "模板" },
      ...fieldColsAll.filter((c) => !hiddenCols.has(c.key)),
      { key: "valid", label: "状态" },
    ];
  }, [fieldColsAll, hiddenCols]);

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
      const { key, dir } = sort;
      arr = [...arr].sort((a, b) => {
        let c = 0;
        if (key === "ts") c = a.tsMs - b.tsMs;
        else if (key === "tpl") c = a.tplName.localeCompare(b.tplName, "zh");
        else if (key === "valid") c = (a.valid ? 1 : 0) - (b.valid ? 1 : 0);
        else {
          const fa = a.fields.find((x) => x.id === key);
          const fb = b.fields.find((x) => x.id === key);
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
  const gridCols = `92px 108px repeat(${Math.max(cols.length - 3, 0)}, minmax(96px, 1fr)) 76px`;

  const cellText = (r: FrameRow, key: string): string => {
    if (key === "ts") return fmtTime(r.tsMs);
    if (key === "tpl") return r.tplName;
    if (key === "valid") return r.valid ? "OK" : "ERR";
    const f = r.fields.find((x) => x.id === key);
    if (!f) return "–";
    return f.text !== null ? f.text : fmtNum(f.value);
  };

  const doExport = async (kind: "csv" | "xlsx") => {
    const path = await save({
      title: t("tbl.exportTitle"),
      defaultPath: `vs-data-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${kind}`,
      filters: [
        { name: kind === "csv" ? "CSV 文件" : "Excel 工作簿", extensions: [kind] },
      ],
    });
    if (!path) return;
    const fieldCols = cols.slice(2, -1);    const aoa: (string | number)[][] = [
      ["时间", "模板", "状态", ...fieldCols.map((c) => c.label)],
      ...shown.map((r) => [
        fmtTime(r.tsMs),
        r.tplName,
        r.valid ? "OK" : r.error ?? "ERR",
        ...fieldCols.map((c) => {
          const f = r.fields.find((x) => x.id === c.key);
          if (!f) return "";
          return f.text !== null ? f.text : Number(f.value.toFixed(6));
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
        const XLSX = await import("xlsx");
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "数据");
        const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
        await invoke("save_binary_file", { path, content: Array.from(new Uint8Array(buf)) });
      }
    } catch (e) {
      console.error("导出失败", e);
    }
  };

  const toggleSort = (key: string) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 1 };
      if (s.dir === 1) return { key, dir: -1 };
      return null;
    });
  };

  const arrow = (key: string) =>
    sort?.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "";

  return (
    <div className="tbl">
      <div className="tbl-bar">
        <button
          className={`btn icon-btn ${frames.paused ? "warn" : ""}`}
          onClick={() => framesStore.setPaused(!frames.paused)}
          title={frames.paused ? t("tbl.resume") : t("tbl.pause")}
        >
          {frames.paused ? <IconPlay /> : <IconPause />}
        </button>
        <button className="btn icon-btn" onClick={() => framesStore.clearRows()} title={t("tbl.clear")}>
          <IconTrash />
        </button>
        <select
          className="input"
          value={frames.maxRows}
          title={t("tbl.cap")}
          onChange={(e) => framesStore.setMaxRows(Number(e.target.value))}
        >
          {[500, 1000, 5000, 10000, 50000].map((n) => (
            <option key={n} value={n}>
              {t("tbl.cache")} {n}
            </option>
          ))}
        </select>
        <input
          className="input tbl-filter"
          placeholder={t("tbl.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <details className="col-menu">
          <summary className="btn icon-btn" title={t("tbl.columns")}>
            <IconColumns />
          </summary>
          <div className="col-menu-pop">
            {fieldColsAll.length === 0 && (
              <div className="tpl-empty">{t("tbl.noCols")}</div>
            )}
            {fieldColsAll.map((c) => (
              <label key={c.key} className="chk">
                <input
                  type="checkbox"
                  checked={!hiddenCols.has(c.key)}
                  onChange={() => toggleCol(c.key)}
                />
                {c.label}
              </label>
            ))}
            {fieldColsAll.length > 0 && (
              <button className="btn" onClick={() => setHiddenCols(new Set())}>
                {t("tbl.showAll")}
              </button>
            )}
          </div>
        </details>
        <div className="tbl-bar-spacer" />
        {frames.capped && (
          <span className="tbl-capped" title={t("tbl.capped")}>
            {t("tbl.truncated")}
          </span>
        )}
        <button className="btn" onClick={() => doExport("csv")} title={t("tbl.exportCsv")}>
          CSV
        </button>
        <button className="btn" onClick={() => doExport("xlsx")} title={t("tbl.exportExcel")}>
          XLSX
        </button>
      </div>
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
                onClick={() => toggleSort(c.key)}
                title={`${t("tbl.sortBy")}：${c.label}`}
              >
                {c.label}
                {arrow(c.key)}
                {!["ts", "tpl", "valid"].includes(c.key) && (
                  <button
                    className="tbl-col-del"
                    title={t("tbl.hideCol")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCol(c.key);
                    }}
                  >
                    ×
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
                  {cellText(r, c.key)}
                </div>
              ))}
            </div>
          ))}
          {total === 0 && (
            <div className="tbl-empty-slot">
              <EmptyState
                title={t("tbl.empty")}
                hint={[
                  "启动演示源或连接串口并定义协议模板后",
                  "解析帧将逐行显示在此",
                ]}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
