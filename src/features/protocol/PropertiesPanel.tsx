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
  const [txt, setTxt] = useState(
    value.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
  );
  useEffect(() => {
    setTxt(value.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "));
  }, [value]);
  const commit = () => {
    const out: number[] = [];
    let ok = true;
    for (const tok of txt.split(/[\s,]+/)) {
      if (!tok) continue;
      const m = tok.replace(/^0x/i, "");
      if (!/^[0-9a-fA-F]{1,2}$/.test(m)) {
        ok = false;
        break;
      }
      out.push(parseInt(m, 16));
    }
    if (ok && (out.length || allowEmpty)) onCommit(out);
    else
      setTxt(
        value.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
      );
  };
  return (
    <input
      className="input hexbytes"
      style={{ width: 130 }}
      title={title}
      placeholder={placeholder}
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
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
const ROLE_NAMES: Record<FieldRole, string> = {
  header: "帧头", addr: "目标地址", id: "功能码", length: "数据长度", seq: "序号",
  payload: "数据载荷", data: "数据内容", checksum: "和校验", checksum2: "附加校验", footer: "帧尾",
};
const ALGOS: { id: ChecksumAlgo; name: string }[] = [
  { id: "sum8", name: "累加和 Sum8" },
  { id: "sumadd", name: "双重累加 Sum+Add (匿名V7)" },
  { id: "xor8", name: "异或 XOR8" },
  { id: "crc16_modbus", name: "CRC16 Modbus" },
  { id: "crc16_ccitt", name: "CRC16 CCITT-FALSE" },
  { id: "crc32", name: "CRC32" },
  { id: "none", name: "无校验" },
];

export function PropertiesPanel() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sel = s.selection;
  const [confirm, setConfirm] = useState<{ fid: string; msg: string; apply?: () => void } | null>(null);

  if (!sel) {
    return (
      <div className="props-panel">
        <div className="ph">
          <div className="ph-card">
            <div className="ph-title">属性</div>
            <div className="ph-desc">
              在左侧选择模板，或在 Hex 区框选字节后右键定义字段。
            </div>
          </div>
        </div>
      </div>
    );
  }

  const tpl = s.rules.templates.find((t) => t.id === sel.templateId);
  if (!tpl) {
    return <div className="props-panel"><div className="props-hint">模板已删除</div></div>;
  }

  if (sel.kind === "template") {
    const b = tpl.boundary;
    return (
      <div className="props-panel">
        <div className="props-title">
          <span className="tpl-dot" style={{ background: tpl.color }} />
          模板属性
        </div>
        <div className="form-row">
          <label>名称</label>
          <TextInput value={tpl.name} onCommit={(v) => store.patchTemplate(tpl.id, { name: v })} />
          <input
            type="color"
            className="color-input"
            value={tpl.color}
            onChange={(e) => store.patchTemplate(tpl.id, { color: e.target.value })}
            title="模板颜色"
          />
        </div>

          <Section title="帧边界">
        <div className="form-row">
          <label>截帧模式</label>
          <select
            className="input"
            value={b.mode}
            onChange={(e) =>
              store.patchBoundary(tpl.id, { mode: e.target.value as BoundaryMode })
            }
          >
            <option value="fixedLength">固定帧头 + 固定长度</option>
            <option value="lengthField">固定帧头 + 长度字段</option>
            <option value="footer">固定帧头 + 帧尾</option>
          </select>
          <HelpHint text="定长：找到帧头后收满「总帧长」即一帧。长度字段：按帧内长度域动态计算帧长。帧尾：收到帧尾字节序列时结帧。" />
        </div>
        <div className="form-row">
          <label>帧头字节</label>
          <HexBytesInput
            value={b.headerBytes}
            onCommit={(v) => store.patchBoundary(tpl.id, { headerBytes: v })}
            title="1~8 字节，作为该模板的路由依据"
          />
        </div>
        {b.mode === "fixedLength" && (
          <div className="form-row">
            <label>总帧长</label>
            <NumInput
              value={b.fixedLength ?? 16}
              onCommit={(v) => store.patchBoundary(tpl.id, { fixedLength: v })}
              title="完整帧的总字节数（含帧头与校验）"
            />
          </div>
        )}
        {b.mode === "lengthField" && (
          <>
            <div className="form-row">
              <div className="form-pair grow">
                <label>长度偏移</label>
                <NumInput
                  value={b.lengthOffset ?? b.headerBytes.length}
                  onCommit={(v) => store.patchBoundary(tpl.id, { lengthOffset: v })}
                />
              </div>
              <div className="form-pair">
                <label>宽度</label>
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
                <label>字节序</label>
                <select
                  className="input"
                  value={b.lengthEndian ?? "little"}
                  onChange={(e) =>
                    store.patchBoundary(tpl.id, { lengthEndian: e.target.value as Endian })
                  }
                >
                  <option value="little">小端</option>
                  <option value="big">大端</option>
                </select>
              </div>
              <div className="form-pair">
                <label>修正 <HelpHint text="总帧长 = 长度域原始值 + 修正值。例：长度域表示帧头之后的字节数时，修正 = 帧头长度 + 长度域宽度。" /></label>
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
            <label>帧尾字节</label>
            <HexBytesInput
              value={b.footerBytes ?? [0x0d, 0x0a]}
              onCommit={(v) => store.patchBoundary(tpl.id, { footerBytes: v })}
            />
          </div>
        )}
        <div className="form-row">
          <label>最大帧长</label>
          <NumInput
            value={b.maxLength}
            onCommit={(v) => store.patchBoundary(tpl.id, { maxLength: v })}
          />
          <HelpHint text="安全上限：候选帧超过此长度直接丢弃并重新同步，防止坏数据撑爆解析器。" />
        </div>
        <div className="form-hint">
          帧识别字段（功能码/帧型码）在字段属性中开启。
          <HelpHint text="协议解析链路：帧头（同步字）定位 → 长度域/固定长度/帧尾定界 → 帧识别字段筛选帧型 → 校验域验证。收满一帧后校验识别字段偏移处的固定字节串，匹配才认定本帧型，不匹配静默丢弃；同簇多帧型（如 WIT 0x51~0x5A、匿名 V7 功能码）靠不同识别值区分。" />
          {(() => {
            const discAt: string[] = [];
            if (b.discOffset != null && b.discValue?.length)
              discAt.push(`@${b.discOffset}=${b.discValue.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
            for (const d of b.discs ?? [])
              discAt.push(`@${d.offset}=${d.value.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
            for (const f of tpl.fields)
              if (f.disc?.length)
                discAt.push(`@${f.offset}=${f.disc.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
            return discAt.length ? `当前生效：${discAt.join("、")}` : "当前未设置";
          })()}
        </div>

          </Section>

          <Section title="校验">
        <div className="form-row">
          <label>算法</label>
          <select
            className="input"
            value={tpl.checksum?.algo ?? "sum8"}
            onChange={(e) =>
              store.patchChecksum(tpl.id, { algo: e.target.value as ChecksumAlgo })
            }
          >
            {ALGOS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {tpl.checksum && tpl.checksum.algo !== "none" && (
          <>
            <div className="form-row">
              <div className="form-pair grow">
                <label>覆盖起点</label>
                <NumInput
                  value={tpl.checksum.coverageStart}
                  onCommit={(v) => store.patchChecksum(tpl.id, { coverageStart: v })}
                  title="相对帧头的起始偏移"
                />
              </div>
              <div className="form-pair">
                <label>终点 <HelpHint text="正数=相对帧头的字节偏移；负数=距帧尾的字节数（-1 = 不含最后1字节，-2 = 不含末尾2字节）。校验只计算覆盖区间内的字节。" /></label>
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

          <Section title="字段列表">
        <div className="props-section">
            字段列表（{tpl.fields.length}）
            <button
              className="btn"
              onClick={() =>
                store.addField(tpl.id, {
                  id: crypto.randomUUID(),
                  name: `字段${tpl.fields.length + 1}`,
                  role: "data",
                  offset: tpl.boundary.headerBytes.length,
                  type: "uint8",
                  endian: "little",
                  color: store.PALETTE[tpl.fields.length % store.PALETTE.length],
                })
              }
            >
              + 添加
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
            <div className="tpl-empty">在 Hex 区框选字节后右键添加字段</div>
          )}
          </div>
        </Section>
      </div>
    );
  }

  const field = tpl.fields.find((f) => f.id === sel.fieldId);
  if (!field) {
    return <div className="props-panel"><div className="props-hint">字段已删除</div></div>;
  }

  const patch = (p: Partial<FieldDef>) => store.patchField(tpl.id, field.id, p);
  const commitSized = (p: Partial<FieldDef>) => {
    const next = { ...field, ...p };
    const c = store.fieldConflictInfo(tpl.id, field.id, next.offset, fieldSize(next));
    if (c.overFrame) {
      setConfirm({ fid: field.id, msg: `无法修改：${c.overFrame}。请先增大「总帧长/最大帧长」或缩小字段。` });
      return;
    }
    if (c.overlapName) {
      setConfirm({
        fid: field.id,
        msg: `修改后将覆盖字段「${c.overlapName}」的前 ${c.overlapBytes} 字节。是否继续？`,
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
          title="返回模板属性"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 6 9 12 15 18" />
          </svg>
          返回模板
        </button>
        <span className="tpl-dot" style={{ background: field.color }} />
        字段属性 · {tpl.name}
      </div>
      <Section title="基础">
      <div className="form-row">
        <label>名称</label>
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
          <label>角色</label>
          <select
            className="input"
            value={field.role}
            onChange={(e) => patch({ role: e.target.value as FieldRole })}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_NAMES[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-pair">
          <label>偏移</label>
          <NumInput value={field.offset} width={64} onCommit={(v) => commitSized({ offset: Math.max(0, Math.round(v)) })} title="相对帧头的字节偏移" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-pair grow">
          <label>类型</label>
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
                {t === "csv" ? "csv·自适应分隔" : t}
              </option>
            ))}
          </select>
        </div>
        {["ascii", "bcd"].includes(field.type) && (
          <div className="form-pair">
            <label>字节数</label>
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
            <label>分隔符</label>
            <TextInput
              value={field.csvDelim ?? ","}
              onCommit={(v) => patch({ csvDelim: v || "," })}
            />
          </div>
          <div className="form-pair">
            <label>元素类型</label>
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
          <label>字节序</label>
          <select
            className="input"
            value={field.endian}
            onChange={(e) => patch({ endian: e.target.value as Endian })}
          >
            <option value="little">小端 LE</option>
            <option value="big">大端 BE</option>
          </select>
        </div>
      )}
      {field.type === "bits" && (
        <div className="form-row">
          <div className="form-pair grow">
            <label>位偏移</label>
            <NumInput value={field.bits?.index ?? 0} onCommit={(v) => patch({ bits: { index: v, count: field.bits?.count ?? 1 } })} />
          </div>
          <div className="form-pair">
            <label>位宽</label>
            <NumInput value={field.bits?.count ?? 1} width={64} onCommit={(v) => patch({ bits: { index: field.bits?.index ?? 0, count: v } })} />
          </div>
        </div>
      )}
      </Section>
      <Section title="帧识别字段">
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
              <label>帧识别位</label>
              <label className="set-switch" title="将此字段用作帧识别位">
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
                {on ? "已启用" : "关闭"}
              </span>
              <HelpHint text="帧头（同步字）定位后，解析器用本字段偏移处的固定识别值筛选帧型：收满一帧后校验该位置字节串，匹配才认定本帧型，不匹配的帧静默丢弃。同一协议簇内不同帧型（如 WIT 0x51~0x5A、匿名 V7 功能码 0x01~0x41）依靠不同识别值区分。识别值占位随字段偏移自动跟随，删除字段即移除识别。" />
            </div>
            {on && (
              <div className="form-row">
                <label>识别值</label>
                <HexBytesInput
                  value={effective!}
                  onCommit={(v) => v.length && store.setFieldDisc(tpl.id, field.id, v)}
                  placeholder="如 51"
                />
                <HelpHint text="本字段偏移处应有的固定字节（Hex），可写多个连续字节，如 5A 或 45 56 23。字段占位将自动扩展到识别值长度。" />
              </div>
            )}
          </>
        );
      })()}
      </Section>
      <Section title="换算与显示">
      <div className="form-row">
        <div className="form-pair grow">
          <label>缩放</label>
          <NumInput
            value={field.scale ?? 1}
            width={72}
            onCommit={(v) => patch({ scale: v })}
            title="物理值 = 原始值 × 缩放 + 偏置"
          />
        </div>
        <div className="form-pair grow">
          <label>偏置</label>
          <NumInput
            value={field.offsetValue ?? 0}
            width={72}
            onCommit={(v) => patch({ offsetValue: v })}
          />
        </div>
      </div>
      <div className="form-row">
        <label>单位</label>
        <TextInput value={field.unit ?? ""} onCommit={(v) => patch({ unit: v || null })} placeholder="如 °C" />
      </div>
      </Section>
      <div className="form-hint">
        修改即时生效：解析规则已热更新到内核，左侧图例数值将按新类型刷新。
      </div>
      {confirm && confirm.fid === field.id && (
        <div className="props-confirm">
          <div className="props-confirm-msg">{confirm.msg}</div>
          <div className="props-confirm-actions">
            <button className="btn" onClick={() => setConfirm(null)}>取消</button>
            {confirm.apply && (
              <button
                className="btn primary"
                onClick={() => {
                  confirm.apply?.();
                  setConfirm(null);
                }}
              >
                覆盖并继续
              </button>
            )}
          </div>
        </div>
      )}
      <button className="btn danger-btn" onClick={() => store.removeField(tpl.id, field.id)}>
        删除该字段
      </button>
    </div>
  );
}
