import { useState } from "react";
import type { CSSProperties } from "react";

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
  { v: "float32", label: "float（小数）" },
  { v: "uint8", label: "uint8" },
  { v: "int8", label: "int8" },
  { v: "uint16", label: "uint16" },
  { v: "int16", label: "int16" },
  { v: "uint32", label: "uint32" },
  { v: "int32", label: "int32" },
  { v: "float64", label: "float64" },
];

export function NewTplDlg({
  onOk,
  onCancel,
}: {
  onOk: (r: NewTplResult) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"single" | "cluster" | "csv">("single");
  const [len, setLen] = useState("16");
  const [name, setName] = useState("协议簇 1");
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
          新建协议 <span className="fc-dlg-sub">单协议 / 协议簇 / 自适应文本帧</span>
        </div>
        <div className="fc-dlg-row">
          <label>类型</label>
          <div className="fc-dlg-roles">
            <button
              className={`fc-role-chip${mode === "single" ? " on" : ""}`}
              style={{ "--chipc": "#4e9cef" } as CSSProperties}
              onClick={() => setMode("single")}
            >
              <i />
              单协议
            </button>
            <button
              className={`fc-role-chip${mode === "cluster" ? " on" : ""}`}
              style={{ "--chipc": "#bc8cff" } as CSSProperties}
              onClick={() => setMode("cluster")}
            >
              <i />
              协议簇
            </button>
            <button
              className={`fc-role-chip${mode === "csv" ? " on" : ""}`}
              style={{ "--chipc": "#39c5cf" } as CSSProperties}
              onClick={() => setMode("csv")}
            >
              <i />
              自适应文本帧
            </button>
          </div>
        </div>
        {mode === "cluster" && (
          <div className="fc-dlg-row">
            <label>簇名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 匿名 V8" />
          </div>
        )}
        {mode !== "csv" && (
          <div className="fc-dlg-row">
            <label>{mode === "cluster" ? "帧型条数" : "帧长度"}</label>
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
                <span className="fc-dlg-sub">1–64 种帧型</span>
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
              <label>分隔符</label>
              <input
                autoFocus
                value={delim}
                onChange={(e) => setDelim(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ok) fire();
                  e.stopPropagation();
                }}
                placeholder="如 , 或 \\ 或 ;"
                style={{ width: 110 }}
              />
            </div>
            <div className="fc-dlg-row">
              <label>元素类型</label>
              <select value={elemType} onChange={(e) => setElemType(e.target.value)}>
                {CSV_TYPES.map((t) => (
                  <option key={t.v} value={t.v}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="fc-dlg-row">
              <label>行尾</label>
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
            ? "空画布按此长度铺格子：可框选定义字段，再用属性面板搭截帧方式。"
            : mode === "cluster"
              ? "创建多条独立帧型并归组：一个页签/一行一键展开；每条帧型可右键复制/粘贴、独立启停或删除。"
              : "JustFloat 式：按分隔符自适应切分为 通道1…通道N（随每帧段数动态变化，上限 64），每个通道可单独看值/开曲线/供脚本引用。"}
        </div>
        <div className="fc-dlg-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={!ok} onClick={fire}>
            创建{mode === "cluster" ? "协议簇" : mode === "csv" ? "自适应帧" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
