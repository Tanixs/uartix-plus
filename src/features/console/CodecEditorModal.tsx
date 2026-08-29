import { useRef, useState } from "react";
import * as ucStore from "./userCodecStore";
import {
  buildUserFrame,
  validateUserCodec,
  type UserCodecDef,
  type UserSeg,
} from "./commandFactory";

type CheckAlgo = Extract<UserSeg, { kind: "check" }>["algo"];

const CHECK_ALGOS: { v: CheckAlgo; label: string }[] = [
  { v: "sum8", label: "SUM8 累加和（1字节）" },
  { v: "xor8", label: "XOR8 异或（1字节）" },
  { v: "sum16", label: "SUM16 累加和（2字节）" },
  { v: "crc16-modbus", label: "CRC16-Modbus" },
  { v: "crc16-ccitt", label: "CRC16-CCITT-FALSE" },
  { v: "crc16-x25", label: "CRC16-X25" },
  { v: "ano-scac", label: "匿名V7 SC+AC（2字节）" },
];

const VAR_TYPES: { v: Extract<UserSeg, { kind: "var" }>["type"]; label: string }[] = [
  { v: "u8", label: "U8（1字节）" },
  { v: "u16", label: "U16（2字节）" },
  { v: "u32", label: "U32（4字节）" },
  { v: "s16", label: "S16 有符号（2字节）" },
  { v: "s32", label: "S32 有符号（4字节）" },
  { v: "f32", label: "F32 浮点（4字节）" },
  { v: "ascii", label: "文本（UTF-8 变长）" },
];

/** 编辑器内的实时示例预览：用默认值试组一帧 */
function samplePreview(name: string, note: string, segs: UserSeg[]) {
  const sample: Record<string, string> = {};
  for (const s of segs) {
    if (s.kind === "var") {
      sample[`f_${s.name}`] = s.def || (s.type === "ascii" ? "ABC" : "1");
    }
  }
  try {
    const r = buildUserFrame({ id: "tmp", name, note, segs, createdAt: 0 }, sample);
    return { parts: r.parts, frames: r.frames, err: null as string | null };
  } catch (e) {
    return { parts: [], frames: [], err: String(e).replace(/^Error:\s*/, "") as string | null };
  }
}

export function CodecEditorModal(props: {
  initial: UserCodecDef | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [note, setNote] = useState(props.initial?.note ?? "");
  const [segs, setSegs] = useState<UserSeg[]>(() =>
    props.initial
      ? structuredClone(props.initial.segs)
      : [
          { kind: "fixed", label: "帧头", bytes: "AA 55" },
          { kind: "var", name: "命令", type: "u8", le: true, def: "01" },
          { kind: "check", algo: "sum8", be: false },
        ],
  );
  const [err, setErr] = useState<string | null>(null);

  const patch = (i: number, p: Record<string, unknown>) =>
    setSegs((s) => s.map((x, j) => (j === i ? ({ ...x, ...p } as UserSeg) : x)));
  const move = (i: number, dir: -1 | 1) =>
    setSegs((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (i: number) => setSegs((s) => s.filter((_, j) => j !== i));

  const sample = samplePreview(name, note, segs);

  const save = () => {
    const def = { name, segs };
    const vErr = validateUserCodec(def);
    if (vErr) {
      setErr(vErr);
      return;
    }
    try {
      // 试组一帧，确保模板可运行
      buildUserFrame({ id: "tmp", name, note, segs, createdAt: 0 }, sampleFor(def.segs));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      return;
    }
    if (props.initial) {
      ucStore.update({ ...props.initial, name, note, segs });
      props.onSaved(props.initial.id);
    } else {
      const id = ucStore.add({ name, note, segs });
      props.onSaved(id);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={props.onClose}>
      <div className="modal qk-editor" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{props.initial ? "编辑自定义协议" : "新建自定义协议"}</div>
        <div className="qk-ed-grid">
          <div className="qk-fgroup">
            <label className="qk-flabel">协议名称</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：我的舵机协议"
            />
          </div>
          <div className="qk-fgroup">
            <label className="qk-flabel">备注（会显示在协议顶部）</label>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如：用于舵机控制，速度范围 0~100"
            />
          </div>
        </div>

        <div className="qk-ed-subtitle">帧组成（从上到下依次发送）</div>
        <div className="qk-ed-segs">
          {segs.map((s, i) => (
            <div key={i} className="qk-ed-seg">
              <span className="qk-ed-idx">{i + 1}</span>
              <span className={`qk-ed-kind k-${s.kind}`}>
                {s.kind === "fixed" ? "固定字节" : s.kind === "var" ? "变量字段" : s.kind === "len" ? "长度段" : "校验段"}
              </span>
              {s.kind === "fixed" && (
                <>
                  <input
                    className="input"
                    style={{ width: 90 }}
                    value={s.label}
                    onChange={(e) => patch(i, { label: e.target.value } as Partial<UserSeg>)}
                    placeholder="名称，如：帧头"
                  />
                  <input
                    className="input"
                    style={{ width: 150, fontFamily: "var(--font-mono)" }}
                    value={s.bytes}
                    onChange={(e) => patch(i, { bytes: e.target.value } as Partial<UserSeg>)}
                    placeholder="HEX，如：AA 55"
                    spellCheck={false}
                  />
                </>
              )}
              {s.kind === "var" && (
                <>
                  <input
                    className="input"
                    style={{ width: 90 }}
                    value={s.name}
                    onChange={(e) => patch(i, { name: e.target.value } as Partial<UserSeg>)}
                    placeholder="字段名"
                  />
                  <select
                    className="input"
                    style={{ width: 150 }}
                    value={s.type}
                    onChange={(e) => patch(i, { type: e.target.value } as Partial<UserSeg>)}
                  >
                    {VAR_TYPES.map((t) => (
                      <option key={t.v} value={t.v}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input"
                    style={{ width: 84 }}
                    value={s.le ? "le" : "be"}
                    onChange={(e) => patch(i, { le: e.target.value === "le" } as Partial<UserSeg>)}
                    title="字节序：小端=低字节在前（常见），大端=高字节在前"
                  >
                    <option value="le">小端</option>
                    <option value="be">大端</option>
                  </select>
                  <input
                    className="input"
                    style={{ width: 80 }}
                    value={s.def ?? ""}
                    onChange={(e) => patch(i, { def: e.target.value } as Partial<UserSeg>)}
                    placeholder="默认值"
                  />
                </>
              )}
              {s.kind === "len" && (
                <span className="qk-ed-hint">自动 = 本段之后到帧尾（不含校验）的字节数，U8</span>
              )}
              {s.kind === "check" && (
                <>
                  <select
                    className="input"
                    style={{ width: 200 }}
                    value={s.algo}
                    onChange={(e) => patch(i, { algo: e.target.value } as Partial<UserSeg>)}
                  >
                    {CHECK_ALGOS.map((a) => (
                      <option key={a.v} value={a.v}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input"
                    style={{ width: 110 }}
                    value={s.be ? "be" : "le"}
                    onChange={(e) => patch(i, { be: e.target.value === "be" } as Partial<UserSeg>)}
                    title="校验字节顺序（SUM8/XOR8/匿名SC+AC 不受影响）"
                  >
                    <option value="le">低字节在前</option>
                    <option value="be">高字节在前</option>
                  </select>
                  <span className="qk-ed-hint">计算范围：帧头到本段之前</span>
                </>
              )}
              <span className="qk-ed-ops">
                <button className="btn" disabled={i === 0} onClick={() => move(i, -1)} title="上移">
                  ↑
                </button>
                <button
                  className="btn"
                  disabled={i === segs.length - 1}
                  onClick={() => move(i, 1)}
                  title="下移"
                >
                  ↓
                </button>
                <button className="btn" onClick={() => remove(i)} title="删除该段">
                  ✕
                </button>
              </span>
            </div>
          ))}
          {!segs.length && <div className="qk-empty">还没有段，从下方添加</div>}
        </div>
        <div className="qk-ed-add">
          <button
            className="btn"
            onClick={() => setSegs((s) => [...s, { kind: "fixed", label: "", bytes: "" }])}
          >
            ＋固定字节
          </button>
          <button
            className="btn"
            onClick={() =>
              setSegs((s) => [...s, { kind: "var", name: `值${s.filter((x) => x.kind === "var").length + 1}`, type: "u8", le: true, def: "0" }])
            }
          >
            ＋变量字段
          </button>
          <button className="btn" onClick={() => setSegs((s) => [...s, { kind: "len" }])}>
            ＋长度段
          </button>
          <button
            className="btn"
            onClick={() => setSegs((s) => [...s, { kind: "check", algo: "sum8", be: false }])}
          >
            ＋校验段
          </button>
        </div>

        <div className="qk-ed-subtitle">示例预览（用默认值试组一帧）</div>
        <div className="qk-factory-preview">
          {sample.err ? (
            <div className="qk-note">{sample.err}</div>
          ) : (
            <div className="qk-parts">
              {sample.parts.map((p, i) => (
                <span key={i} className="fp-col">
                  <span className={`fp ${p.cls}`}>{p.text}</span>
                  <span className="fp-label">{p.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {err && <div className="qk-err" style={{ padding: "4px 0 0" }}>{err}</div>}
        <div className="form-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function sampleFor(segs: UserSeg[]): Record<string, string> {
  const sample: Record<string, string> = {};
  for (const s of segs) {
    if (s.kind === "var") {
      sample[`f_${s.name}`] = s.def || (s.type === "ascii" ? "ABC" : "1");
    }
  }
  return sample;
}

export function MyCodecsModal(props: {
  onClose: () => void;
  onEdit: (def: UserCodecDef) => void;
  onDeleted: (id: string) => void;
}) {
  const [snap, setSnap] = useState(ucStore.getSnapshot());
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => setSnap(ucStore.getSnapshot());

  const doExport = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(ucStore.exportAll(), null, 2));
      setMsg(`已复制 ${snap.codecs.length} 个协议到剪贴板（JSON）`);
      setErr(null);
    } catch {
      setErr("复制失败：剪贴板不可用");
    }
  };

  const doImport = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as UserCodecDef[];
      const arr = Array.isArray(data) ? data : [data];
      const n = ucStore.importMerge(arr);
      setMsg(n ? `已导入 ${n} 个协议` : "没有可导入的协议");
      setErr(null);
      refresh();
    } catch {
      setErr("导入失败：不是有效的协议 JSON 文件");
    }
  };

  return (
    <div className="modal-mask" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">管理我的协议</div>
        <div className="qk-manage-list">
          {snap.codecs.map((c) => (
            <div key={c.id} className="qk-manage-row">
              <span style={{ width: 160, overflow: "hidden", textOverflow: "ellipsis" }} title={c.note}>
                {c.name}
              </span>
              <span className="qk-ed-hint" style={{ flex: 1 }}>
                {c.segs.length} 段
              </span>
              <button className="btn" onClick={() => props.onEdit(c)}>
                编辑
              </button>
              <button
                className="btn"
                onClick={() => {
                  ucStore.remove(c.id);
                  props.onDeleted(c.id);
                  refresh();
                }}
              >
                删除
              </button>
            </div>
          ))}
          {!snap.codecs.length && (
            <div className="qk-empty">还没有自定义协议，点「指令工厂」旁的「＋新建自定义协议」创建</div>
          )}
        </div>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={doExport} disabled={!snap.codecs.length}>
            导出（复制到剪贴板）
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            导入（JSON 文件）
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
              e.target.value = "";
            }}
          />
        </div>
        {msg && <div className="qk-msg" style={{ padding: "6px 0 0" }}>{msg}</div>}
        {err && <div className="qk-err" style={{ padding: "6px 0 0" }}>{err}</div>}
      </div>
    </div>
  );
}
