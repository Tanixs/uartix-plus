import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  BoundaryMode,
  ChecksumAlgo,
  Endian,
  FieldDef,
  FieldRole,
  FieldType,
} from "../../ipc/types";
import * as store from "./templateStore";
import { fieldSize } from "./templateStore";
import { Section } from "../../shared/Section";
import { HelpHint } from "../../shared/HelpHint";
import { parseHexBytes, formatHexBytes } from "../../shared/hexBytes";
import { tx, useLocale } from "../../i18n/strings";

export function NumInput({
  value,
  onCommit,
  width,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  width?: number;
  title?: string;
}) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  const commit = () => {
    const v = parseFloat(txt.replace(",", "."));
    if (!Number.isNaN(v)) onCommit(v);
    else setTxt(String(value));
  };
  return (
    <input
      className="input num"
      style={width ? { width } : { flex: "1 1 90px", minWidth: 56 }}
      title={title}
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

export function TextInput({
  value,
  onCommit,
  width,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  width?: number;
  placeholder?: string;
}) {
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  const commit = () => {
    if (txt !== value) onCommit(txt);
  };
  return (
    <input
      className="input"
      style={width ? { width } : { flex: "1 1 110px", minWidth: 70 }}
      placeholder={placeholder}
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function HexBytesInput({
  value,
  onCommit,
  title,
  allowEmpty,
  placeholder,
}: {
  value: number[];
  onCommit: (v: number[]) => void;
  title?: string;
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const [txt, setTxt] = useState(formatHexBytes(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setTxt(formatHexBytes(value));
    setBad(false);
  }, [value]);
  const commit = () => {
    const out = parseHexBytes(txt);
    if (out !== null && (out.length || allowEmpty)) {
      setBad(false);
      onCommit(out);
    } else {
      setBad(out === null || !allowEmpty);
      setTxt(formatHexBytes(value));
    }
  };
  return (
    <input
      className={`input hexbytes${bad ? " bad" : ""}`}
      style={{ width: 130 }}
      title={title}
      placeholder={placeholder}
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onFocus={() => setBad(false)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

const FIELD_TYPES: FieldType[] = [
  "uint8", "int8", "uint16", "int16", "uint32", "int32",
  "float32", "float64", "ascii", "bcd", "bits", "csv",
];
const ROLES: FieldRole[] = ["header", "addr", "id", "length", "seq", "payload", "data", "checksum", "checksum2", "footer"];
const roleNames = (): Record<FieldRole, string> => ({
  header: tx("帧头", "Header"), addr: tx("目标地址", "Address"), id: tx("功能码", "Command ID"), length: tx("数据长度", "Length"), seq: tx("序号", "Seq"),
  payload: tx("数据载荷", "Payload"), data: tx("数据内容", "Data"), checksum: tx("和校验", "Checksum"), checksum2: tx("附加校验", "Checksum2"), footer: tx("帧尾", "Footer"),
});
const ALGOS: { id: ChecksumAlgo; name: () => string }[] = [
  { id: "sum8", name: () => tx("累加和 Sum8", "Sum8") },
  { id: "sumadd", name: () => tx("双重累加 Sum+Add (匿名V7)", "Sum+Add (AnoV7)") },
  { id: "xor8", name: () => tx("异或 XOR8", "XOR8") },
  { id: "crc16_modbus", name: () => "CRC16 Modbus" },
  { id: "crc16_ccitt", name: () => "CRC16 CCITT-FALSE" },
  { id: "crc32", name: () => "CRC32" },
  { id: "none", name: () => tx("无校验", "None") },
];

export function PropertiesPanel() {
  useLocale();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sel = s.selection;
  const [confirm, setConfirm] = useState<{ fid: string; msg: string; apply?: () => void } | null>(null);

  if (!sel) {
    return (
      <div className="props-panel">
        <div className="ph">
          <div className="ph-card">
            <div className="ph-title">{tx("属性", "Properties")}</div>
            <div className="ph-desc">
              {tx(
                "在左侧选择模板，或在 Hex 区框选字节后右键定义字段。",
                "Select a template on the left, or drag-select bytes in the Hex view and right-click to define fields.",
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const tpl = s.rules.templates.find((t) => t.id === sel.templateId);
  if (!tpl) {
    return <div className="props-panel"><div className="props-hint">{tx("模板已删除", "Template deleted")}</div></div>;
  }

  if (sel.kind === "template") {
    const b = tpl.boundary;
    return (
      <div className="props-panel">
        <div className="props-title">
          <span className="tpl-dot" style={{ background: tpl.color }} />
          {tx("模板属性", "Template Properties")}
        </div>
        <div className="form-row">
          <label>{tx("名称", "Name")}</label>
          <TextInput value={tpl.name} onCommit={(v) => store.patchTemplate(tpl.id, { name: v })} />
          <input
            type="color"
            className="color-input"
            value={tpl.color}
            onChange={(e) => store.patchTemplate(tpl.id, { color: e.target.value })}
            title={tx("模板颜色", "Template color")}
          />
        </div>

          <Section title={tx("帧边界", "Frame Boundary")}>
        <div className="form-row">
          <label>{tx("截帧模式", "Framing Mode")}</label>
          <select
            className="input"
            value={b.mode}
            onChange={(e) =>
              store.patchBoundary(tpl.id, { mode: e.target.value as BoundaryMode })
            }
          >
            <option value="fixedLength">{tx("固定帧头 + 固定长度", "Header + Fixed Length")}</option>
            <option value="lengthField">{tx("固定帧头 + 长度字段", "Header + Length Field")}</option>
            <option value="footer">{tx("固定帧头 + 帧尾", "Header + Footer")}</option>
          </select>
          <HelpHint text={tx(
            "定长：找到帧头后收满「总帧长」即一帧。长度字段：按帧内长度域动态计算帧长。帧尾：收到帧尾字节序列时结帧。",
            "Fixed length: one frame = header + total length. Length field: frame size from the in-frame length field. Footer: frame ends at footer byte sequence.",
          )} />
        </div>
        <div className="form-row">
          <label>{tx("帧头字节", "Header Bytes")}</label>
          <HexBytesInput
            value={b.headerBytes}
            onCommit={(v) => store.patchBoundary(tpl.id, { headerBytes: v })}
            allowEmpty
            title={tx(
              "0~8 字节，作为该模板的路由依据；可为空（从首字节直接收集，如逗号分隔文本流）",
              "0–8 bytes used to route frames; may be empty (collect from first byte, e.g. comma-separated text)",
            )}
          />
        </div>
        {b.mode === "fixedLength" && (
          <div className="form-row">
            <label>{tx("总帧长", "Total Length")}</label>
            <NumInput
              value={b.fixedLength ?? 16}
              onCommit={(v) => store.patchBoundary(tpl.id, { fixedLength: v })}
              title={tx("完整帧的总字节数（含帧头与校验）", "Total bytes of a full frame (incl. header & checksum)")}
            />
          </div>
        )}
        {b.mode === "lengthField" && (
          <>
            <div className="form-row">
              <div className="form-pair grow">
                <label>{tx("长度偏移", "Length Offset")}</label>
                <NumInput
                  value={b.lengthOffset ?? b.headerBytes.length}
                  onCommit={(v) => store.patchBoundary(tpl.id, { lengthOffset: v })}
                />
              </div>
              <div className="form-pair">
                <label>{tx("宽度", "Width")}</label>
                <select
                  className="input"
                  value={b.lengthSize ?? 1}
                  onChange={(e) =>
                    store.patchBoundary(tpl.id, { lengthSize: Number(e.target.value) })
                  }
                >
                  <option value={1}>u8</option>
                  <option value={2}>u16</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-pair grow">
                <label>{tx("字节序", "Endianness")}</label>
                <select
                  className="input"
                  value={b.lengthEndian ?? "little"}
                  onChange={(e) =>
                    store.patchBoundary(tpl.id, { lengthEndian: e.target.value as Endian })
                  }
                >
                  <option value="little">{tx("小端", "Little")}</option>
                  <option value="big">{tx("大端", "Big")}</option>
                </select>
              </div>
              <div className="form-pair">
                <label>{tx("修正", "Adjust")} <HelpHint text={tx("总帧长 = 长度域原始值 + 修正值。例：长度域表示帧头之后的字节数时，修正 = 帧头长度 + 长度域宽度。", "Total length = raw length field + adjust. E.g. if the length field counts bytes after the header, adjust = header length + field width.")} /></label>
                <NumInput
                  value={b.lengthAdjust ?? 0}
                  width={64}
                  onCommit={(v) => store.patchBoundary(tpl.id, { lengthAdjust: v })}
                />
              </div>
            </div>
          </>
        )}
        {b.mode === "footer" && (
          <div className="form-row">
            <label>{tx("帧尾字节", "Footer Bytes")}</label>
            <HexBytesInput
              value={b.footerBytes ?? [0x0d, 0x0a]}
              onCommit={(v) => store.patchBoundary(tpl.id, { footerBytes: v })}
            />
          </div>
        )}
        <div className="form-row">
          <label>{tx("最大帧长", "Max Frame Length")}</label>
          <NumInput
            value={b.maxLength}
            onCommit={(v) => store.patchBoundary(tpl.id, { maxLength: v })}
          />
          <HelpHint text={tx(
            "安全上限：候选帧超过此长度直接丢弃并重新同步，防止坏数据撑爆解析器。",
            "Safety cap: candidate frames longer than this are dropped and re-synced, protecting the parser from corrupt data.",
          )} />
        </div>
        <div className="form-hint">
          <HelpHint text={tx(
            "帧识别字段（功能码/帧型码）在字段属性中开启。协议解析链路：帧头（同步字）定位 → 长度域/固定长度/帧尾定界 → 帧识别字段筛选帧型 → 校验域验证。收满一帧后校验识别字段偏移处的固定字节串，匹配才认定本帧型，不匹配静默丢弃；同簇多帧型（如 WIT 0x51~0x5A、匿名 V7 功能码）靠不同识别值区分。",
            "Frame discriminator (command/frame-type code) is enabled in field properties. Pipeline: header sync → length/fixed/footer delimiting → discriminator filters frame type → checksum verifies. After a full frame, the fixed bytes at the discriminator offset must match, otherwise the frame is silently dropped; multiple frame types in one cluster (WIT 0x51~0x5A, AnoV7 command codes) are told apart by different values.",
          )} />
          {tx("解析链路：帧头定位 → 定界 → 识别筛选 → 校验", "Pipeline: header sync → delimit → discriminate → verify")}
          {(() => {
            const discAt: string[] = [];
            if (b.discOffset != null && b.discValue?.length)
              discAt.push(`@${b.discOffset}=${b.discValue.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
            for (const d of b.discs ?? [])
              discAt.push(`@${d.offset}=${d.value.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
            for (const f of tpl.fields)
              if (f.disc?.length)
                discAt.push(`@${f.offset}=${f.disc.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
            return discAt.length
              ? `${tx("当前生效", "Active")}: ${discAt.join(", ")}`
              : tx("当前未设置", "Not set");
          })()}
        </div>

          </Section>

          <Section title={tx("校验", "Checksum")}>
        <div className="form-row">
          <label>{tx("算法", "Algorithm")}</label>
          <select
            className="input"
            value={tpl.checksum?.algo ?? "sum8"}
            onChange={(e) =>
              store.patchChecksum(tpl.id, { algo: e.target.value as ChecksumAlgo })
            }
          >
            {ALGOS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name()}
              </option>
            ))}
          </select>
        </div>
        {tpl.checksum && tpl.checksum.algo !== "none" && (
          <>
            <div className="form-row">
              <div className="form-pair grow">
                <label>{tx("覆盖起点", "Coverage Start")}</label>
                <NumInput
                  value={tpl.checksum.coverageStart}
                  onCommit={(v) => store.patchChecksum(tpl.id, { coverageStart: v })}
                  title={tx("相对帧头的起始偏移", "Start offset relative to the frame header")}
                />
              </div>
              <div className="form-pair">
                <label>{tx("终点", "End")} <HelpHint text={tx("正数=相对帧头的字节偏移；负数=距帧尾的字节数（-1 = 不含最后1字节，-2 = 不含末尾2字节）。校验只计算覆盖区间内的字节。", "Positive = byte offset from the frame header; negative = distance from the frame tail (-1 excludes the last byte, -2 excludes the last two). The checksum covers only bytes inside the range.")} /></label>
                <NumInput
                  value={tpl.checksum.coverageEnd}
                  width={64}
                  onCommit={(v) => store.patchChecksum(tpl.id, { coverageEnd: v })}
                />
              </div>
            </div>
          </>
        )}

          </Section>

          <Section title={tx("字段列表", "Fields")}>
        <div className="props-section">
            {`${tx("字段列表", "Fields")}（${tpl.fields.length}）`}
            <button
              className="btn"
              onClick={() =>
                store.addField(tpl.id, {
                  id: crypto.randomUUID(),
                  name: `${tx("字段", "Field")}${tpl.fields.length + 1}`,
                  role: "data",
                  offset: tpl.boundary.headerBytes.length,
                  type: "uint8",
                  endian: "little",
                  color: store.PALETTE[tpl.fields.length % store.PALETTE.length],
                })
              }
            >
              {tx("+ 添加", "+ Add")}
            </button>
          </div>
        <div className="field-table">
          {tpl.fields.map((f) => {
            const selected =
              s.selection?.kind === "field" && s.selection.fieldId === f.id;
            return (
              <div
                key={f.id}
                className={`field-row ${selected ? "selected" : ""}`}
                onClick={() =>
                  store.setSelection({
                    kind: "field",
                    templateId: tpl.id,
                    fieldId: f.id,
                  })
                }
              >
                <span className="tpl-dot" style={{ background: f.color }} />
                <span className="field-row-name">{f.name}</span>
                <span className="field-row-meta">
                  @{f.offset} · {f.type}
                </span>
                <button
                  className="tpl-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.removeField(tpl.id, f.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          {tpl.fields.length === 0 && (
            <div className="tpl-empty">{tx("在 Hex 区框选字节后右键添加字段", "Drag-select bytes in the Hex view, then right-click to add a field")}</div>
          )}
          </div>
        </Section>
      </div>
    );
  }

  const field = tpl.fields.find((f) => f.id === sel.fieldId);
  if (!field) {
    return <div className="props-panel"><div className="props-hint">{tx("字段已删除", "Field deleted")}</div></div>;
  }

  const patch = (p: Partial<FieldDef>) => store.patchField(tpl.id, field.id, p);
  const commitSized = (p: Partial<FieldDef>) => {
    const next = { ...field, ...p };
    const c = store.fieldConflictInfo(tpl.id, field.id, next.offset, fieldSize(next));
    if (c.overFrame) {
      setConfirm({ fid: field.id, msg: tx(`无法修改：${c.overFrame}。请先增大「总帧长/最大帧长」或缩小字段。`, `Cannot apply: ${c.overFrame}. Increase total/max frame length or shrink the field first.`) });
      return;
    }
    if (c.overlapName) {
      setConfirm({
        fid: field.id,
        msg: tx(
          `修改后将覆盖字段「${c.overlapName}」的前 ${c.overlapBytes} 字节。是否继续？`,
          `This will overwrite the first ${c.overlapBytes} bytes of field "${c.overlapName}". Continue?`,
        ),
        apply: () => patch(p),
      });
      return;
    }
    patch(p);
  };
  const numeric = !["ascii", "bcd"].includes(field.type);

  return (
    <div className="props-panel">
      <div className="props-title">
        <button
          className="back-btn"
          onClick={() => store.setSelection({ kind: "template", templateId: tpl.id })}
          title={tx("返回模板属性", "Back to template properties")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 6 9 12 15 18" />
          </svg>
          {tx("返回模板", "Back")}
        </button>
        <span className="tpl-dot" style={{ background: field.color }} />
        {`${tx("字段属性", "Field Properties")} · ${tpl.name}`}
      </div>
      <Section title={tx("基础", "Basics")}>
      <div className="form-row">
        <label>{tx("名称", "Name")}</label>
        <TextInput value={field.name} onCommit={(v) => patch({ name: v })} />
        <input
          type="color"
          className="color-input"
          value={field.color}
          onChange={(e) => patch({ color: e.target.value })}
        />
      </div>
      <div className="form-row">
        <div className="form-pair grow">
          <label>{tx("角色", "Role")}</label>
          <select
            className="input"
            value={field.role}
            onChange={(e) => patch({ role: e.target.value as FieldRole })}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleNames()[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-pair">
          <label>{tx("偏移", "Offset")}</label>
          <NumInput value={field.offset} width={64} onCommit={(v) => commitSized({ offset: Math.max(0, Math.round(v)) })} title={tx("相对帧头的字节偏移", "Byte offset relative to the frame header")} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-pair grow">
          <label>{tx("类型", "Type")}</label>
          <select
            className="input"
            value={field.type}
            onChange={(e) => {
              const t = e.target.value as FieldType;
              const size = fieldSize({ ...field, type: t });
              commitSized({ type: t, size: ["ascii", "bcd"].includes(t) ? (field.size ?? size) : null });
            }}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "csv" ? tx("csv·自适应分隔", "csv·auto-split") : t}
              </option>
            ))}
          </select>
        </div>
        {["ascii", "bcd"].includes(field.type) && (
          <div className="form-pair">
            <label>{tx("字节数", "Bytes")}</label>
            <NumInput
              value={field.size ?? fieldSize(field)}
              width={64}
              onCommit={(v) => commitSized({ size: Math.max(1, Math.round(v)) })}
            />
          </div>
        )}
      </div>
      {field.type === "csv" && (
        <div className="form-row">
          <div className="form-pair">
            <label>{tx("分隔符", "Delimiter")}</label>
            <TextInput
              value={field.csvDelim ?? ","}
              onCommit={(v) => patch({ csvDelim: v || "," })}
            />
          </div>
          <div className="form-pair">
            <label>{tx("元素类型", "Element type")}</label>
            <select
              className="input"
              value={field.csvType ?? "float32"}
              onChange={(e) => patch({ csvType: e.target.value })}
            >
              <option value="float32">float32</option>
              <option value="float64">float64</option>
              <option value="uint8">uint8</option>
              <option value="int8">int8</option>
              <option value="uint16">uint16</option>
              <option value="int16">int16</option>
              <option value="uint32">uint32</option>
              <option value="int32">int32</option>
            </select>
          </div>
        </div>
      )}
      {numeric && field.type !== "uint8" && field.type !== "int8" && field.type !== "bits" && (
        <div className="form-row">
          <label>{tx("字节序", "Endianness")}</label>
          <select
            className="input"
            value={field.endian}
            onChange={(e) => patch({ endian: e.target.value as Endian })}
          >
            <option value="little">{tx("小端 LE", "Little Endian")}</option>
            <option value="big">{tx("大端 BE", "Big Endian")}</option>
          </select>
        </div>
      )}
      {field.type === "bits" && (
        <div className="form-row">
          <div className="form-pair grow">
            <label>{tx("位偏移", "Bit Offset")}</label>
            <NumInput value={field.bits?.index ?? 0} onCommit={(v) => patch({ bits: { index: v, count: field.bits?.count ?? 1 } })} />
          </div>
          <div className="form-pair">
            <label>{tx("位宽", "Bit Width")}</label>
            <NumInput value={field.bits?.count ?? 1} width={64} onCommit={(v) => patch({ bits: { index: field.bits?.index ?? 0, count: v } })} />
          </div>
        </div>
      )}
      </Section>
      <Section title={tx("帧识别字段", "Frame Discriminator")}>
      {(() => {
        const b = tpl.boundary;
        const effective = field.disc?.length
          ? field.disc
          : b.discOffset === field.offset && b.discValue?.length
            ? b.discValue
            : b.discs?.find((x) => x.offset === field.offset && x.value.length)?.value;
        const on = !!effective?.length;
        return (
          <>
            <div className="form-row">
              <label>{tx("帧识别位", "Discriminator")}</label>
              <label className="set-switch" title={tx("将此字段用作帧识别位", "Use this field as the frame discriminator")}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    store.setFieldDisc(tpl.id, field.id, e.target.checked ? (effective?.length ? effective : [0]) : null)
                  }
                />
                <span />
              </label>
              <span className="form-hint" style={{ margin: 0 }}>
                {on ? tx("已启用", "Enabled") : tx("关闭", "Off")}
              </span>
              <HelpHint text={tx(
                "帧头（同步字）定位后，解析器用本字段偏移处的固定识别值筛选帧型：收满一帧后校验该位置字节串，匹配才认定本帧型，不匹配的帧静默丢弃。同一协议簇内不同帧型（如 WIT 0x51~0x5A、匿名 V7 功能码 0x01~0x41）依靠不同识别值区分。识别值占位随字段偏移自动跟随，删除字段即移除识别。",
                "After header sync, the parser filters frame types by the fixed value at this field's offset: bytes at the position must match, otherwise the frame is silently dropped. Frame types within one cluster (WIT 0x51~0x5A, AnoV7 0x01~0x41) are told apart by different values. The placeholder follows the field offset; deleting the field removes the discriminator.",
              )} />
            </div>
            {on && (
              <div className="form-row">
                <label>{tx("识别值", "Value")}</label>
                <HexBytesInput
                  value={effective!}
                  onCommit={(v) => v.length && store.setFieldDisc(tpl.id, field.id, v)}
                  placeholder={tx("如 51", "e.g. 51")}
                />
                <HelpHint text={tx(
                  "本字段偏移处应有的固定字节（Hex），可写多个连续字节，如 5A 或 45 56 23。字段占位将自动扩展到识别值长度。",
                  "Fixed byte(s) expected at this offset (hex), e.g. 5A or 45 56 23. The field span grows to cover the value length.",
                )} />
              </div>
            )}
          </>
        );
      })()}
      </Section>
      <Section title={tx("换算与显示", "Scaling & Display")}>
      <div className="form-row">
        <div className="form-pair grow">
          <label>{tx("缩放", "Scale")}</label>
          <NumInput
            value={field.scale ?? 1}
            width={72}
            onCommit={(v) => patch({ scale: v })}
            title={tx("物理值 = 原始值 × 缩放 + 偏置", "Physical = raw × scale + bias")}
          />
        </div>
        <div className="form-pair grow">
          <label>{tx("偏置", "Bias")}</label>
          <NumInput
            value={field.offsetValue ?? 0}
            width={72}
            onCommit={(v) => patch({ offsetValue: v })}
          />
        </div>
      </div>
      <div className="form-row">
        <label>{tx("单位", "Unit")}</label>
        <TextInput value={field.unit ?? ""} onCommit={(v) => patch({ unit: v || null })} placeholder={tx("如 °C", "e.g. °C")} />
      </div>
      </Section>
      <div className="form-hint">
        {tx(
          "修改即时生效：解析规则已热更新到内核，左侧图例数值将按新类型刷新。",
          "Changes apply instantly: rules are hot-synced to the parser core; legend values refresh with the new type.",
        )}
      </div>
      {confirm && confirm.fid === field.id && (
        <div className="props-confirm">
          <div className="props-confirm-msg">{confirm.msg}</div>
          <div className="props-confirm-actions">
            <button className="btn" onClick={() => setConfirm(null)}>{tx("取消", "Cancel")}</button>
            {confirm.apply && (
              <button
                className="btn primary"
                onClick={() => {
                  confirm.apply?.();
                  setConfirm(null);
                }}
              >
                {tx("覆盖并继续", "Overwrite & continue")}
              </button>
            )}
          </div>
        </div>
      )}
      <button className="btn danger-btn" onClick={() => store.removeField(tpl.id, field.id)}>
        {tx("删除该字段", "Delete Field")}
      </button>
    </div>
  );
}
