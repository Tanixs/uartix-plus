import { useRef, useState } from "react";
import * as ucStore from "./userCodecStore";
import { IconArrowDown, IconArrowUp, IconClose } from "../../shared/icons";
import { t, tx, useLocale } from "../../i18n/strings";
import {
  buildUserFrame,
  validateUserCodec,
  type UserCodecDef,
  type UserSeg,
} from "./commandFactory";

type CheckAlgo = Extract<UserSeg, { kind: "check" }>["algo"];
type VarType = Extract<UserSeg, { kind: "var" }>["type"];
type SegKind = UserSeg["kind"];

/**
 * 下拉里的出现顺序。表里只有**码**（键序 = 顺序），标签在渲染时挑 —— 模块级一旦拼好字符串就把语言冻死了。
 * 用 `Record<…, true>` 而不是数组：联合类型加一种校验/类型时，数组会静默少一项，Record 少键编译不过。
 */
const CHECK_ALGO_SLOTS: Record<CheckAlgo, true> = {
  sum8: true, xor8: true, sum16: true, "crc16-modbus": true, "crc16-ccitt": true, "crc16-x25": true, "ano-scac": true,
};
const VAR_TYPE_SLOTS: Record<VarType, true> = {
  u8: true, u16: true, u32: true, s16: true, s32: true, f32: true, ascii: true,
};
const CHECK_ALGOS = Object.keys(CHECK_ALGO_SLOTS) as CheckAlgo[];
const VAR_TYPES = Object.keys(VAR_TYPE_SLOTS) as VarType[];

function checkAlgoLabel(a: CheckAlgo): string {
  switch (a) {
    case "sum8": return tx("SUM8 累加和（1字节）", "SUM8 checksum (1 byte)");
    case "xor8": return tx("XOR8 异或（1字节）", "XOR8 checksum (1 byte)");
    case "sum16": return tx("SUM16 累加和（2字节）", "SUM16 checksum (2 bytes)");
    case "crc16-modbus": return "CRC16-Modbus";
    case "crc16-ccitt": return "CRC16-CCITT-FALSE";
    case "crc16-x25": return "CRC16-X25";
    case "ano-scac": return tx("匿名V7 SC+AC（2字节）", "ANO V7 SC+AC (2 bytes)");
  }
}

function varTypeLabel(v: VarType): string {
  switch (v) {
    case "u8": return tx("U8（1字节）", "U8 (1 byte)");
    case "u16": return tx("U16（2字节）", "U16 (2 bytes)");
    case "u32": return tx("U32（4字节）", "U32 (4 bytes)");
    case "s16": return tx("S16 有符号（2字节）", "S16 signed (2 bytes)");
    case "s32": return tx("S32 有符号（4字节）", "S32 signed (4 bytes)");
    case "f32": return tx("F32 浮点（4字节）", "F32 float (4 bytes)");
    case "ascii": return tx("文本（UTF-8 变长）", "Text (UTF-8, variable length)");
  }
}

function segKindLabel(k: SegKind): string {
  switch (k) {
    case "fixed": return tx("固定字节", "Fixed bytes");
    case "var": return tx("变量字段", "Variable");
    case "len": return tx("长度段", "Length");
    case "check": return tx("校验段", "Checksum");
  }
}

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
  useLocale(); // 这一面是 tx() 出来的话术，切语言要有人重渲染
  const [name, setName] = useState(props.initial?.name ?? "");
  const [note, setNote] = useState(props.initial?.note ?? "");
  const [segs, setSegs] = useState<UserSeg[]>(() =>
    props.initial
      ? structuredClone(props.initial.segs)
      : [
          // 种子段名会随协议持久化，那是**用户数据**：按新建那一刻的界面语言播种，之后跟着用户走
          { kind: "fixed", label: tx("帧头", "Header"), bytes: "AA 55" },
          { kind: "var", name: tx("命令", "Command"), type: "u8", le: true, def: "01" },
          { kind: "check", algo: "sum8", be: false },
        ],
  );
  // 校验/组帧的报错文字出自 commandFactory.ts —— 同一条文字也是 AI 工具的回执，换语言是契约改动，不在这一批动
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
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={props.onClose}>
      <div className="modal qk-editor" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{props.initial ? tx("编辑自定义协议", "Edit custom protocol") : tx("新建自定义协议", "New custom protocol")}</div>
        <div className="qk-ed-grid">
          <div className="qk-fgroup">
            <label className="qk-flabel">{tx("协议名称", "Protocol name")}</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tx("如：我的舵机协议", "e.g. My servo protocol")}
            />
          </div>
          <div className="qk-fgroup">
            <label className="qk-flabel">{tx("备注（会显示在协议顶部）", "Note (shown above the protocol)")}</label>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={tx("如：用于舵机控制，速度范围 0~100", "e.g. Servo control, speed range 0~100")}
            />
          </div>
        </div>

        <div className="qk-ed-subtitle">{tx("帧组成（从上到下依次发送）", "Frame layout (sent top to bottom)")}</div>
        <div className="qk-ed-segs">
          {segs.map((s, i) => (
            <div key={i} className="qk-ed-seg">
              <span className="qk-ed-idx">{i + 1}</span>
              <span className={`qk-ed-kind k-${s.kind}`}>
                {segKindLabel(s.kind)}
              </span>
              {s.kind === "fixed" && (
                <>
                  <input
                    className="input"
                    style={{ width: 90 }}
                    value={s.label}
                    onChange={(e) => patch(i, { label: e.target.value } as Partial<UserSeg>)}
                    placeholder={tx("名称，如：帧头", "Name, e.g. Header")}
                  />
                  <input
                    className="input"
                    style={{ width: 150, fontFamily: "var(--font-mono)" }}
                    value={s.bytes}
                    onChange={(e) => patch(i, { bytes: e.target.value } as Partial<UserSeg>)}
                    placeholder={tx("HEX，如：AA 55", "HEX, e.g. AA 55")}
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
                    placeholder={tx("字段名", "Field name")}
                  />
                  <select
                    className="input"
                    style={{ width: 150 }}
                    value={s.type}
                    onChange={(e) => patch(i, { type: e.target.value } as Partial<UserSeg>)}
                  >
                    {VAR_TYPES.map((code) => (
                      <option key={code} value={code}>
                        {varTypeLabel(code)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input"
                    style={{ width: 84 }}
                    value={s.le ? "le" : "be"}
                    onChange={(e) => patch(i, { le: e.target.value === "le" } as Partial<UserSeg>)}
                    title={tx("字节序：小端=低字节在前（常见），大端=高字节在前", "Byte order: little-endian = low byte first (common), big-endian = high byte first")}
                  >
                    <option value="le">{tx("小端", "Little")}</option>
                    <option value="be">{tx("大端", "Big")}</option>
                  </select>
                  <input
                    className="input"
                    style={{ width: 80 }}
                    value={s.def ?? ""}
                    onChange={(e) => patch(i, { def: e.target.value } as Partial<UserSeg>)}
                    placeholder={tx("默认值", "Default")}
                  />
                </>
              )}
              {s.kind === "len" && (
                <span className="qk-ed-hint">{tx("自动 = 本段之后到帧尾（不含校验）的字节数，U8", "Auto = bytes from after this segment to the frame tail (checksum excluded), as U8")}</span>
              )}
              {s.kind === "check" && (
                <>
                  <select
                    className="input"
                    style={{ width: 200 }}
                    value={s.algo}
                    onChange={(e) => patch(i, { algo: e.target.value } as Partial<UserSeg>)}
                  >
                    {CHECK_ALGOS.map((code) => (
                      <option key={code} value={code}>
                        {checkAlgoLabel(code)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input"
                    style={{ width: 110 }}
                    value={s.be ? "be" : "le"}
                    onChange={(e) => patch(i, { be: e.target.value === "be" } as Partial<UserSeg>)}
                    title={tx("校验字节顺序（SUM8/XOR8/匿名SC+AC 不受影响）", "Checksum byte order (of no consequence for SUM8/XOR8/ANO SC+AC)")}
                  >
                    <option value="le">{tx("低字节在前", "Low byte first")}</option>
                    <option value="be">{tx("高字节在前", "High byte first")}</option>
                  </select>
                  <span className="qk-ed-hint">{tx("计算范围：帧头到本段之前", "Range: frame head up to this segment")}</span>
                </>
              )}
              <span className="qk-ed-ops">
                <button className="btn" disabled={i === 0} onClick={() => move(i, -1)} title={tx("上移", "Move up")}>
                  <IconArrowUp />
                </button>
                <button
                  className="btn"
                  disabled={i === segs.length - 1}
                  onClick={() => move(i, 1)}
                  title={tx("下移", "Move down")}
                >
                  <IconArrowDown />
                </button>
                <button className="btn" onClick={() => remove(i)} title={tx("删除该段", "Delete this segment")}>
                  <IconClose />
                </button>
              </span>
            </div>
          ))}
          {!segs.length && <div className="qk-empty">{tx("还没有段，从下方添加", "No segments yet — add them below")}</div>}
        </div>
        <div className="qk-ed-add">
          <button
            className="btn"
            onClick={() => setSegs((s) => [...s, { kind: "fixed", label: "", bytes: "" }])}
          >
            {tx("＋固定字节", "+ Fixed bytes")}
          </button>
          <button
            className="btn"
            onClick={() =>
              setSegs((s) => {
                const seq = s.filter((x) => x.kind === "var").length + 1;
                return [...s, { kind: "var", name: tx(`值${seq}`, `Value${seq}`), type: "u8", le: true, def: "0" }];
              })
            }
          >
            {tx("＋变量字段", "+ Variable")}
          </button>
          <button className="btn" onClick={() => setSegs((s) => [...s, { kind: "len" }])}>
            {tx("＋长度段", "+ Length")}
          </button>
          <button
            className="btn"
            onClick={() => setSegs((s) => [...s, { kind: "check", algo: "sum8", be: false }])}
          >
            {tx("＋校验段", "+ Checksum")}
          </button>
        </div>

        <div className="qk-ed-subtitle">{tx("示例预览（用默认值试组一帧）", "Sample preview (one frame built from the defaults)")}</div>
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
            {t("c.cancel")}
          </button>
          <button className="btn primary" onClick={save}>
            {t("c.save")}
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

/** 回执条：槽位（绿/红）与种类分开存，文字渲染时才挑 —— 整句进 state 就等于把语言冻在动作那一刻 */
type CodecMsg = { kind: "copied"; n: number } | { kind: "imported"; n: number } | { kind: "empty" };
function msgText(m: CodecMsg): string {
  switch (m.kind) {
    case "copied": return tx(`已复制 ${m.n} 个协议到剪贴板（JSON）`, `Copied ${m.n} protocols to the clipboard (JSON)`);
    case "imported": return tx(`已导入 ${m.n} 个协议`, `Imported ${m.n} protocols`);
    case "empty": return tx("没有可导入的协议", "There was nothing to import");
  }
}
function errText(code: "copy" | "import"): string {
  switch (code) {
    case "copy": return tx("复制失败：剪贴板不可用", "Copy failed: the clipboard is unavailable");
    case "import": return tx("导入失败：不是有效的协议 JSON 文件", "Import failed: not a valid protocol JSON file");
  }
}

export function MyCodecsModal(props: {
  onClose: () => void;
  onEdit: (def: UserCodecDef) => void;
  onDeleted: (id: string) => void;
}) {
  useLocale();
  const [snap, setSnap] = useState(ucStore.getSnapshot());
  const [err, setErr] = useState<"copy" | "import" | null>(null);
  const [msg, setMsg] = useState<CodecMsg | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => setSnap(ucStore.getSnapshot());

  const doExport = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(ucStore.exportAll(), null, 2));
      setMsg({ kind: "copied", n: snap.codecs.length });
      setErr(null);
    } catch {
      setErr("copy");
    }
  };

  const doImport = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as UserCodecDef[];
      const arr = Array.isArray(data) ? data : [data];
      const n = ucStore.importMerge(arr);
      setMsg(n ? { kind: "imported", n } : { kind: "empty" });
      setErr(null);
      refresh();
    } catch {
      setErr("import");
    }
  };

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{tx("管理我的协议", "Manage my protocols")}</div>
        <div className="qk-manage-list">
          {snap.codecs.map((c) => (
            <div key={c.id} className="qk-manage-row">
              <span style={{ width: 160, overflow: "hidden", textOverflow: "ellipsis" }} title={c.note}>
                {c.name}
              </span>
              <span className="qk-ed-hint" style={{ flex: 1 }}>
                {tx(`${c.segs.length} 段`, `${c.segs.length} segments`)}
              </span>
              <button className="btn" onClick={() => props.onEdit(c)}>
                {tx("编辑", "Edit")}
              </button>
              <button
                className="btn"
                onClick={() => {
                  ucStore.remove(c.id);
                  props.onDeleted(c.id);
                  refresh();
                }}
              >
                {t("c.delete")}
              </button>
            </div>
          ))}
          {!snap.codecs.length && (
            <div className="qk-empty">{tx("还没有自定义协议", "No custom protocols yet")}</div>
          )}
        </div>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={doExport} disabled={!snap.codecs.length}>
            {tx("导出（复制到剪贴板）", "Export (copy to clipboard)")}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            {tx("导入（JSON 文件）", "Import (JSON file)")}
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
        {msg && <div className="qk-msg" style={{ padding: "6px 0 0" }}>{msgText(msg)}</div>}
        {err && <div className="qk-err" style={{ padding: "6px 0 0" }}>{errText(err)}</div>}
      </div>
    </div>
  );
}
