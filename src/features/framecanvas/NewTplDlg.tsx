import { useState } from "react";
import type { CSSProperties } from "react";
import { tx, useLocale } from "../../i18n/strings";

export interface NewTplResult {
  mode: "single" | "cluster" | "csv";
  name: string;
  len: number;
  count: number;
  delim: string;
  elemType: string;
  lineEnd: string;
}

const CSV_TYPES = [
  { v: "float32", zh: "float（小数）", en: "float (decimal)" },
  { v: "uint8", zh: "uint8", en: "uint8" },
  { v: "int8", zh: "int8", en: "int8" },
  { v: "uint16", zh: "uint16", en: "uint16" },
  { v: "int16", zh: "int16", en: "int16" },
  { v: "uint32", zh: "uint32", en: "uint32" },
  { v: "int32", zh: "int32", en: "int32" },
  { v: "float64", zh: "float64", en: "float64" },
];

export function NewTplDlg({
  onOk,
  onCancel,
}: {
  onOk: (r: NewTplResult) => void;
  onCancel: () => void;
}) {
  useLocale();
  const [mode, setMode] = useState<"single" | "cluster" | "csv">("single");
  const [len, setLen] = useState("16");
  const [name, setName] = useState(tx("协议簇 1", "Protocol cluster 1"));
  const [count, setCount] = useState("4");
  const [delim, setDelim] = useState(",");
  const [elemType, setElemType] = useState("float32");
  const [lineEnd, setLineEnd] = useState("LF");
  const l = parseInt(len, 10);
  const c = parseInt(count, 10);
  const lenOk = Number.isFinite(l) && l >= 2 && l <= 512;
  const cntOk = Number.isFinite(c) && c >= 1 && c <= 64;
  const delimOk = delim.length > 0;
  const ok = lenOk && (mode !== "cluster" || cntOk) && (mode !== "csv" || delimOk);
  const fire = () =>
    onOk({
      mode,
      name: name.trim() || "协议簇",
      len: l,
      count: c,
      delim,
      elemType,
      lineEnd,
    });
  return (
    <div className="fc-dlg-mask" onMouseDown={onCancel}>
      <div className="fc-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fc-dlg-title">
          {tx("新建协议", "New protocol")} <span className="fc-dlg-sub">{tx("单协议 / 协议簇 / 自适应文本帧", "single / cluster / adaptive text frame")}</span>
        </div>
        <div className="fc-dlg-row">
          <label>{tx("类型", "Type")}</label>
          <div className="fc-dlg-roles">
            <button
              className={`fc-role-chip${mode === "single" ? " on" : ""}`}
              style={{ "--chipc": "#4e9cef" } as CSSProperties}
              onClick={() => setMode("single")}
            >
              <i />
              {tx("单协议", "Single")}
            </button>
            <button
              className={`fc-role-chip${mode === "cluster" ? " on" : ""}`}
              style={{ "--chipc": "#bc8cff" } as CSSProperties}
              onClick={() => setMode("cluster")}
            >
              <i />
              {tx("协议簇", "Cluster")}
            </button>
            <button
              className={`fc-role-chip${mode === "csv" ? " on" : ""}`}
              style={{ "--chipc": "#39c5cf" } as CSSProperties}
              onClick={() => setMode("csv")}
            >
              <i />
              {tx("自适应文本帧", "Adaptive text")}
            </button>
          </div>
        </div>
        {mode === "cluster" && (
          <div className="fc-dlg-row">
            <label>{tx("簇名称", "Cluster name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("如 匿名 V8", "e.g. Anonymous V8")} />
          </div>
        )}
        {mode !== "csv" && (
          <div className="fc-dlg-row">
            <label>{mode === "cluster" ? tx("帧型条数", "Frame types") : tx("帧长度", "Frame length")}</label>
            {mode === "cluster" ? (
              <div className="form-pair grow">
                <input
                  autoFocus
                  type="number"
                  min={1}
                  max={64}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && ok) fire();
                    e.stopPropagation();
                  }}
                />
                <span className="fc-dlg-sub">{tx("1–64 种帧型", "1–64 frame types")}</span>
              </div>
            ) : (
              <input
                autoFocus
                type="number"
                min={2}
                max={512}
                value={len}
                onChange={(e) => setLen(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ok) fire();
                  e.stopPropagation();
                }}
              />
            )}
          </div>
        )}
        {mode === "csv" && (
          <>
            <div className="fc-dlg-row">
              <label>{tx("分隔符", "Delimiter")}</label>
              <input
                autoFocus
                value={delim}
                onChange={(e) => setDelim(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ok) fire();
                  e.stopPropagation();
                }}
                placeholder={tx("如 , 或 \\ 或 ;", "e.g. , or \\ or ;")}
                style={{ width: 110 }}
              />
            </div>
            <div className="fc-dlg-row">
              <label>{tx("元素类型", "Element type")}</label>
              <select value={elemType} onChange={(e) => setElemType(e.target.value)}>
                {CSV_TYPES.map((t) => (
                  <option key={t.v} value={t.v}>
                    {tx(t.zh, t.en)}
                  </option>
                ))}
              </select>
            </div>
            <div className="fc-dlg-row">
              <label>{tx("行尾", "Line end")}</label>
              <select value={lineEnd} onChange={(e) => setLineEnd(e.target.value)}>
                <option value="LF">LF（\\n 0x0A）</option>
                <option value="CRLF">CRLF（\\r\\n）</option>
                <option value="CR">CR（\\r）</option>
                <option value="TAB">TAB（\\t）</option>
              </select>
            </div>
          </>
        )}
        <div className="fc-dlg-warn soft">
          {mode === "single"
            ? tx("空画布按此长度铺格子：可框选定义字段，再用属性面板搭截帧方式。", "The empty canvas is laid out with cells of this length: drag-select to define fields, then set the framing mode in the properties panel.")
            : mode === "cluster"
              ? tx("创建多条独立帧型并归组：一个页签/一行一键展开；每条帧型可右键复制/粘贴、独立启停或删除。", "Creates several independent frame types grouped together: one tab / one row to expand all; each type supports right-click copy/paste, independent enable/disable or delete.")
              : tx("JustFloat 式：按分隔符自适应切分为 通道1…通道N（随每帧段数动态变化，上限 64），每个通道可单独看值/开曲线/供脚本引用。", "JustFloat style: split adaptively by the delimiter into Channel 1…N (follows the per-frame segment count, max 64); each channel can show values, open a curve or be referenced by scripts.")}
        </div>
        <div className="fc-dlg-foot">
          <button className="btn" onClick={onCancel}>{tx("取消", "Cancel")}</button>
          <button className="btn primary" disabled={!ok} onClick={fire}>
            {tx("创建", "Create")}{mode === "cluster" ? tx("协议簇", " cluster") : mode === "csv" ? tx("自适应帧", " adaptive frame") : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
