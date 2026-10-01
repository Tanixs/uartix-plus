/**
 * P123-C · 发送谱的块 / 参数 / 校验编辑面，住在「属性」面板里。
 *
 * 它是从 `SendBuildPanel` 的侧栏**整块搬来**的，不是重写：每一条行话术、每一个"为什么 disabled"、
 * 每一句派生假设都原样带过来。搬家的理由是那 240px —— 侧栏常驻就把字节网格挤成图一那样，
 * 而"点一块去右边编辑"这件事，接收侧早就在「属性」面板里做了一遍，两套逻辑该收成一套。
 *
 * 三条边界：
 *  1. 选中谁由 `inspector/focus` 说，这里只**读** specId/fieldId；写回一律走 `sendStore`
 *     （只读锁在 store 层拦，界面不假装）；
 *  2. 预览用同一个 `encodeSend` 现算 —— 与面板底部那行 hex 是同一个纯函数，不是第二份真相；
 *  3. 「常驻关联色」与联动闪一下这两件事跟着"现在盯着哪一块"走，所以它们的订阅/收尾
 *     一起从面板搬了过来：面板关了高亮就该收掉，不许留在控制画布上冒充当前状态。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChecksumAlgo, CrcParams, Endian, FieldRole, FieldType } from "../../ipc/types";
import { tx, useLocale } from "../../i18n/strings";
import { CRC_DEFAULT, parseCrcLiteral } from "../../shared/checksums";
import { FormRow, NumInput, TextInput } from "../../shared/FormInputs";
import { Section } from "../../shared/Section";
import * as controlsStore from "../controls/controlsStore";
import { revealTargets } from "../controls/cardBinding";
import { roleNames } from "./roleNames";
import { guardLocked } from "../operator/lock";
import * as templateStore from "../protocol/templateStore";
import { SEND_FIELD_ROLES, paramTypeOf, type SendField, type SendParamType, type SendTemplate } from "../send/sendTypes";
import { encodeSend, intRangeOf, parseHexInput } from "../send/encodeSend";
import * as sendStore from "../send/sendStore";
import { DeriveError, toReceiveTpl } from "../send/specToProtocol";

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

const TYPES: FieldType[] = ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64", "ascii", "bcd", "bits"];
const ENDIANS: Endian[] = ["big", "little", "big-word-swap", "little-word-swap"];
const CK_ALGOS: ChecksumAlgo[] = [
  "none",
  "sum8",
  "xor8",
  "sumadd",
  "sum16",
  "crc16_modbus",
  "crc16_ccitt",
  "crc16_x25",
  "crc32",
  "crc_custom",
];
/**
 * 参数类型表。`enum` 故意不在选项里：它的档位表还没有编辑入口，
 * 给一个"选了却没法填"的选项就是假开关；但**已有** enum 参数的谱（导进来的）照样显示原值。
 */
const PARAM_TYPES: SendParamType[] = ["int", "uint", "float", "text"];

const hexOf = (f: SendField) =>
  f.source.kind === "const" ? f.source.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ") : "";

/** 定位成功那一句：当场闪一次、还是跳过去再闪一次，说的都是同一句话 */
const locatedLine = (cardName: string) =>
  tx(`已定位到画布上的「${cardName}」`, `located: “${cardName}” on the canvas`);

function revealCard(cardId: string) {
  window.dispatchEvent(new CustomEvent("vs-control-reveal", { detail: { cardId } }));
}

export function SendFieldInspector(props: { specId: string; fieldId: string }) {
  useLocale();
  const tpls = useSyncExternalStore(sendStore.subscribe, sendStore.getSnapshot);
  const rules = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const tpl: SendTemplate | null = tpls.find((x) => x.id === props.specId) ?? null;
  const field: SendField | null = tpl?.fields.find((f) => f.id === props.fieldId) ?? null;

  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [derivedNotes, setDerivedNotes] = useState<string[]>([]);
  const [link, setLink] = useState<{ line: string; pageId?: string; cardId?: string; cardName?: string } | null>(null);

  /** 与面板底部那行 hex 同一个纯编码器：换界面不换算法，才谈得上"看到的就是发出去的" */
  const preview = useMemo(() => {
    if (!tpl) return null;
    try {
      return { ok: true as const, ...encodeSend(tpl, { seq: tpl.nextSeq ?? 0 }) };
    } catch (e) {
      return { ok: false as const, msg: String(e).replace(/^Error:\s*/, "") };
    }
  }, [tpl]);

  const patchSel = (patch: Partial<SendField>) => {
    if (tpl && field) sendStore.patchField(tpl.id, field.id, patch);
  };

  /* —— 联动：这一块的值在控制画布上被谁用着 —— */
  const specId = tpl?.id ?? "";
  const linkParamId = field?.source.kind === "param" ? field.source.paramId : "";
  useEffect(() => {
    // 常驻色跟着"现在盯着哪一块"走。放在最前面，是因为选了非参数块也要把上一次的高亮收掉
    sendStore.setFocus(specId && linkParamId ? { specId, paramId: linkParamId } : null);
    if (!specId || !linkParamId) {
      setLink(null);
      return;
    }
    const snap = controlsStore.getSnapshot();
    const hits = revealTargets(specId, linkParamId, snap.pages, snap.activePageId);
    if (!hits.length) {
      setLink({
        line: tx(
          "没有控件在用这个参数：拖滑条不改变这一帧",
          "No control uses this parameter: dragging a slider changes nothing in this frame",
        ),
      });
      return;
    }
    const here = hits.find((h) => h.onActivePage);
    const h = here ?? hits[0];
    if (here) revealCard(here.cardId);
    const more = hits.length > 1 ? tx(`（共 ${hits.length} 张）`, ` (${hits.length} cards)`) : "";
    setLink(
      here
        ? { line: locatedLine(here.cardName) }
        : {
            line: tx(
              `绑在页面「${h.pageName}」的「${h.cardName}」上${more}`,
              `bound to “${h.cardName}” on page “${h.pageName}”${more}`,
            ),
            pageId: h.pageId,
            cardId: h.cardId,
            cardName: h.cardName,
          },
    );
  }, [specId, linkParamId]);

  // 编辑面收掉了（属性页关掉 / 换去编解析协议）就把高亮收掉：不然"谁正被盯着"会留在控制画布上冒充当前状态
  useEffect(
    () => () => {
      sendStore.setFocus(null);
    },
    [],
  );

  /**
   * 参数一键生成滑条卡。
   *
   * 卡片带的是**引用**（`sendTemplateId` + `paramId`），不是此刻烤出来的字节：改谱，这张卡跟着变。
   * 范围：参数自己声明的优先；没声明就按**吃这个参数的那块能装下什么**推 —— 写死 0~100 的后果
   * 是实测过的：u16 参数默认值 1234，生成出来的滑条上限 100、开机值被夹成 100。
   */
  const spawnSliderCard = (paramId: string) => {
    if (!tpl) return;
    // 就地拦锁：`controlsStore.addCard/patchCard` 今天不拦（它们还要服务只读锁下的正常操作），
    // 所以这颗按钮的入口自己把关。
    if (guardLocked()) return;
    const p = tpl.params.find((x) => x.id === paramId);
    const page = controlsStore.activePage();
    if (!p || !page) {
      setErr(tx("没有可落卡片的控制页", "No control page to place the card on"));
      return;
    }
    const users = tpl.fields.filter((f) => f.source.kind === "param" && f.source.paramId === p.id);
    const widest = users.reduce<[number, number] | null>((acc, f) => {
      const r = intRangeOf(f.type);
      if (!r) return acc;
      return !acc || r[1] > acc[1] ? r : acc;
    }, null);
    const declared = Number.isFinite(p.min) || Number.isFinite(p.max);
    const lo = declared ? (p.min ?? widest?.[0] ?? 0) : (widest?.[0] ?? 0);
    const hi = declared ? (p.max ?? widest?.[1] ?? 100) : (widest?.[1] ?? 100);
    const def = Math.min(Math.max(Number(p.def) || 0, Math.min(lo, hi)), Math.max(lo, hi));
    const id = controlsStore.addCard(page.id, "slider");
    controlsStore.patchCard(page.id, id, {
      name: p.name,
      sendTemplateId: tpl.id,
      paramId: p.id,
      template: "",
      sendMode: "hex",
      min: Math.min(lo, hi),
      max: Math.max(lo, hi),
      defaultValue: def,
      step: p.type === "float" ? 0.01 : 1,
    });
    setMsg(tx("已在控制画布生成一张滑条卡（引用这张谱）", "Slider card created on the control canvas — it references this template"));
  };

  /**
   * 派生解析协议。替他定的那三件事（帧头怎么认出来的、变长块取的是这一帧量到的字节数、
   * 覆盖终点的口径换算）每一条都进 notes 并原样列出来：派生不是"帮你猜好了"。
   */
  const deriveProtocol = () => {
    if (!tpl || !preview?.ok) return;
    if (guardLocked()) return;
    try {
      const { tpl: made, notes } = toReceiveTpl(tpl, { bytes: preview.bytes, spans: preview.spans }, {
        id: crypto.randomUUID(),
        color: templateStore.PALETTE[rules.rules.templates.length % templateStore.PALETTE.length],
      });
      const id = templateStore.addDerivedTemplate(made);
      const stored = templateStore.getSnapshot().rules.templates.find((t) => t.id === id);
      setDerivedNotes(notes);
      setMsg(tx(`已派生解析协议「${stored?.name ?? made.name}」`, `Derived protocol “${stored?.name ?? made.name}” created`));
      setErr("");
    } catch (e) {
      setErr(e instanceof DeriveError ? e.message : String(e).replace(/^Error:\s*/, ""));
    }
  };

  /** 参数化 CRC 的读写：没选 crc_custom 时界面不显示这些行，读到的就是那组能算的默认参数 */
  const crcOf = (): CrcParams => tpl?.checksum?.crc ?? CRC_DEFAULT;
  const setCrc = (patch: Partial<CrcParams>) => {
    if (!tpl?.checksum) return;
    sendStore.patchTemplate(tpl.id, { checksum: { ...tpl.checksum, crc: { ...crcOf(), ...patch } } });
  };
  /** poly / init / xorout 用十六进制写最自然（0x1021）；认不出来就点名，原值留在谱里 */
  const commitCrcNum = (key: "poly" | "init" | "xorout", text: string) => {
    const n = parseCrcLiteral(text);
    if (n === null) {
      // 这条会留在屏上直到下一次成功提交，所以得说清"没写进去"——不然看着像现在这帧坏了
      setErr(
        `${tx(`CRC ${key}：「${text}」不是数字（认十进制或 0x 十六进制）`, `CRC ${key}: “${text}” is not a number (decimal or 0x hex)`)} ${tx(
          "—— 这个值没写进谱，原来那个还在",
          "— this value was not written in; the previous one still stands",
        )}`,
      );
      return;
    }
    setCrc({ [key]: n });
    setErr("");
  };

  if (!tpl) {
    return (
      <div className="props-panel">
        <div className="props-hint">{tx("这张发送谱已被删除。", "This send template was deleted.")}</div>
      </div>
    );
  }

  return (
    <div className="props-panel">
      <Section title={tx("发送块", "Send block")}>
        {!field && (
          <div className="props-hint">
            {tx("在 TX组帧台的字节网格上点一块来编辑它。", "Click a block on the TX frame builder grid to edit it.")}
          </div>
        )}
        {field && (
          <>
            <FormRow label={tx("名称", "Name")}>
              <input className="input" value={field.name} onChange={(e) => patchSel({ name: e.target.value })} />
            </FormRow>
            <FormRow label={tx("类型", "Type")}>
              <select className="input" value={field.type} onChange={(e) => patchSel({ type: e.target.value as FieldType })}>
                {TYPES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </FormRow>
            <FormRow label={tx("角色", "Role")}>
              <select className="input" value={field.role} onChange={(e) => patchSel({ role: e.target.value as FieldRole })}>
                {SEND_FIELD_ROLES.map((x) => (
                  <option key={x} value={x}>
                    {roleLabelOf(x)}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label={tx("字节序", "Byte order")}>
              <select className="input" value={field.endian} onChange={(e) => patchSel({ endian: e.target.value as Endian })}>
                {ENDIANS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </FormRow>
            {(field.type === "ascii" || field.type === "bcd") && (
              <FormRow label={tx("字节数", "Bytes")}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={field.size ?? 1}
                  onChange={(e) => patchSel({ size: Math.max(1, Number(e.target.value) || 1) })}
                />
              </FormRow>
            )}
            {field.type === "bits" && (
              <FormRow label={tx("位起 / 位宽", "Bit / width")}>
                <span className="form-pair grow">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={7}
                    value={field.bits?.index ?? 0}
                    onChange={(e) => patchSel({ bits: { index: Number(e.target.value), count: field.bits?.count ?? 1 } })}
                  />
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={8}
                    value={field.bits?.count ?? 1}
                    onChange={(e) => patchSel({ bits: { index: field.bits?.index ?? 0, count: Number(e.target.value) } })}
                  />
                </span>
              </FormRow>
            )}
            <FormRow label={tx("值来源", "Value from")}>
              <select
                className="input"
                value={field.source.kind}
                onChange={(e) => {
                  const k = e.target.value;
                  if (k === "param") {
                    const pid = uid("sp");
                    sendStore.addParam(tpl.id, { id: pid, name: field.name, type: paramTypeOf(field.type), def: "0" });
                    patchSel({ source: { kind: "param", paramId: pid } });
                  } else if (k === "const") patchSel({ source: { kind: "const", bytes: [0] } });
                  else if (k === "var") patchSel({ source: { kind: "var", name: "" } });
                  else if (k === "seq") patchSel({ source: { kind: "seq" } });
                  else patchSel({ source: { kind: "len", covers: "after" } });
                }}
              >
                {["const", "param", "var", "seq", "len"].map((k) => (
                  <option key={k} value={k}>
                    {k === "const" ? tx("固定字节", "Fixed") : k === "param" ? tx("参数", "Parameter") : k === "var" ? tx("解析变量", "Parsed variable") : k === "seq" ? tx("自增序号", "Auto counter") : tx("长度回填", "Length")}
                  </option>
                ))}
              </select>
            </FormRow>
            {field.source.kind === "seq" && (
              <FormRow label={tx("步进 / 回绕", "Step / wrap")}>
                <span className="form-pair grow">
                  <NumInput
                    value={field.source.step ?? 1}
                    title={tx("每发一帧加多少", "How much the counter advances per frame")}
                    onCommit={(v) => patchSel({ source: { kind: "seq", step: v, wrap: field.source.kind === "seq" ? field.source.wrap : undefined } })}
                  />
                  <NumInput
                    value={field.source.wrap ?? Math.pow(2, 8 * Math.max(1, field.size ?? 1))}
                    title={tx("加到多少回到 0（默认按位宽）", "Where the counter wraps (defaults to the field width)")}
                    onCommit={(v) => patchSel({ source: { kind: "seq", step: field.source.kind === "seq" ? field.source.step : undefined, wrap: v } })}
                  />
                </span>
              </FormRow>
            )}
            {field.source.kind === "len" && (
              <>
                <FormRow label={tx("长度数谁", "Length counts")}>
                  <select
                    className="input"
                    value={field.source.covers}
                    onChange={(e) => patchSel({ source: { kind: "len", covers: e.target.value as "self" | "after" | "body", adjust: field.source.kind === "len" ? field.source.adjust : undefined } })}
                  >
                    <option value="after">{tx("它之后的字节", "bytes after it")}</option>
                    <option value="body">{tx("含它自身", "including itself")}</option>
                    <option value="self">{tx("整帧", "whole frame")}</option>
                  </select>
                </FormRow>
                <FormRow label={tx("长度修正", "Length adjust")}>
                  <NumInput
                    value={field.source.adjust ?? 0}
                    title={tx("回填的值再加减这个数（帧长含不含某些字节时用）", "Add this to the backfilled length")}
                    onCommit={(v) => patchSel({ source: { kind: "len", covers: field.source.kind === "len" ? field.source.covers : "after", adjust: v } })}
                  />
                </FormRow>
              </>
            )}
            {link && (
              <div className="sb-link">
                <span className="props-hint">{link.line}</span>
                {/* 只有真的在别的页上才有这颗键：当前页已经闪过了还留一个"去那里"，那就是假开关 */}
                {link.pageId !== undefined && link.cardId !== undefined && link.cardName !== undefined && (
                  <button
                    className="btn"
                    onClick={() => {
                      const { pageId, cardId, cardName } = link;
                      if (!pageId || !cardId || !cardName) return;
                      controlsStore.setActivePage(pageId);
                      // 卡是新页面上刚渲染出来的，等一拍再闪（协议画布那条反向定位同一节奏）
                      window.setTimeout(() => revealCard(cardId), 80);
                      // 人都跳过去了，那句话不许还停在"在别的页上"
                      setLink({ line: locatedLine(cardName) });
                    }}
                  >
                    {tx("去那里", "Go there")}
                  </button>
                )}
              </div>
            )}
            {field.source.kind === "const" && (
              <FormRow label={tx("字节 (hex)", "Bytes (hex)")}>
                <TextInput
                  value={hexOf(field)}
                  placeholder="AA 55"
                  onCommit={(v) => {
                    const { bytes, bad } = parseHexInput(v);
                    if (bad.length) {
                      setErr(
                        tx(
                          `「${bad.join(" ")}」不是成对的十六进制（写 12 34，或连着写 1234）`,
                          `"${bad.join(" ")}" is not whole hex pairs — write 12 34, or contiguous 1234`,
                        ),
                      );
                      return;
                    }
                    patchSel({ source: { kind: "const", bytes } });
                    setErr("");
                  }}
                />
              </FormRow>
            )}
            {field.source.kind === "var" && (
              <FormRow label={tx("变量名", "Variable")}>
                <input
                  className="input"
                  value={field.source.name}
                  onChange={(e) => patchSel({ source: { kind: "var", name: e.target.value } })}
                />
              </FormRow>
            )}
            <button className="btn sb-danger" onClick={() => sendStore.removeField(tpl.id, field.id)}>
              {tx("删除这个字段", "Remove this field")}
            </button>
          </>
        )}
        {err && <div className="props-warn">{err}</div>}
        {msg && <div className="props-hint">{msg}</div>}
      </Section>

      <Section title={tx("参数", "Parameters")}>
        {tpl.params.map((p) => (
          <div key={p.id} className="props-param">
            <FormRow label={tx("名字", "Name")}>
              <TextInput value={p.name} onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { name: v })} />
              <button
                className="btn"
                disabled={p.type === "text" || p.type === "enum"}
                title={
                  p.type === "text" || p.type === "enum"
                    ? tx(
                        "文本 / 枚举参数还没有对应的控件类型（选择框卡在 P122）",
                        "Text and enum parameters have no matching card type yet (the select card is in P122)",
                      )
                    : tx(
                        "在控制画布生成一张滑条卡，值灌进这个参数",
                        "Create a slider card on the control canvas that feeds this parameter",
                      )
                }
                onClick={() => spawnSliderCard(p.id)}
              >
                {tx("生成控件", "Add control")}
              </button>
            </FormRow>
            <FormRow label={tx("类型", "Type")}>
              <select
                className="input"
                value={p.type}
                onChange={(e) => sendStore.patchParam(tpl.id, p.id, { type: e.target.value as SendParamType })}
              >
                {(p.type === "enum" ? [...PARAM_TYPES, "enum" as SendParamType] : PARAM_TYPES).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label={tx("默认值", "Default")}>
              <TextInput value={p.def} placeholder="0" onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { def: v })} />
            </FormRow>
            {p.type !== "text" && p.type !== "enum" && (
              <FormRow label={tx("范围", "Range")}>
                <span className="form-pair grow">
                  <NumInput
                    value={p.min ?? 0}
                    title={tx("最小值：生成滑条卡时当滑条下限", "Minimum — the lower bound of a generated slider")}
                    onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { min: v })}
                  />
                  <NumInput
                    value={p.max ?? 100}
                    title={tx("最大值：生成滑条卡时当滑条上限", "Maximum — the upper bound of a generated slider")}
                    onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { max: v })}
                  />
                </span>
              </FormRow>
            )}
            {p.type === "enum" && (
              <div className="props-hint">
                {tx("档位表还不能在这里编辑：导进来的谱原样保留，改不了", "The option table isn't editable here yet — imported specs keep theirs untouched")}
              </div>
            )}
          </div>
        ))}
        {!tpl.params.length && (
          <div className="props-hint">
            {tx("没有参数：把某块的来源选成「参数」就有了", "No parameters — set a block’s source to Parameter")}
          </div>
        )}
        <div className="props-hint">
          {tx("默认值就是发出去的那一帧里的值；要临时改一版，在命令或卡片上覆盖它。", "The default is what goes out; override it per command or card for a one-off value.")}
        </div>
      </Section>

      <Section title={tx("校验", "Checksum")}>
        <FormRow label={tx("算法", "Algorithm")}>
          <select
            className="input"
            value={tpl.checksum?.algo ?? "none"}
            onChange={(e) => {
              const algo = e.target.value as ChecksumAlgo;
              sendStore.patchTemplate(tpl.id, {
                checksum:
                  algo === "none"
                    ? null
                    : {
                        algo,
                        coverageStart: tpl.checksum?.coverageStart ?? 0,
                        coverageEnd: tpl.checksum?.coverageEnd ?? -1,
                        crc: algo === "crc_custom" ? (tpl.checksum?.crc ?? CRC_DEFAULT) : null,
                      },
              });
            }}
          >
            {CK_ALGOS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </FormRow>
        {tpl.checksum && (
          <FormRow label={tx("覆盖起 / 止", "Coverage")} title={tx("负数按距帧尾算：-2 = 不含最后两字节", "Negative counts from the end: -2 excludes the last two bytes")}>
            <span className="form-pair grow">
              <NumInput
                value={tpl.checksum.coverageStart}
                onCommit={(v) => sendStore.patchTemplate(tpl.id, { checksum: { ...tpl.checksum!, coverageStart: v } })}
              />
              <NumInput
                value={tpl.checksum.coverageEnd}
                onCommit={(v) => sendStore.patchTemplate(tpl.id, { checksum: { ...tpl.checksum!, coverageEnd: v } })}
              />
            </span>
          </FormRow>
        )}
        {tpl.checksum?.algo === "crc_custom" && (
          <>
            <FormRow label={tx("位数", "Width")}>
              <select
                className="input"
                value={crcOf().width}
                onChange={(e) => setCrc({ width: Number(e.target.value) as CrcParams["width"] })}
              >
                {([8, 16, 32] as const).map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </FormRow>
            {(["poly", "init", "xorout"] as const).map((k) => (
              <FormRow key={k} label={k}>
                <TextInput value={"0x" + crcOf()[k].toString(16)} onCommit={(v) => commitCrcNum(k, v)} />
              </FormRow>
            ))}
            <FormRow label={tx("反射", "Reflect")}>
              <span className="form-pair grow">
                <input type="checkbox" checked={crcOf().refin} onChange={(e) => setCrc({ refin: e.target.checked })} />
                <span>{tx("输入", "in")}</span>
                <input type="checkbox" checked={crcOf().refout} onChange={(e) => setCrc({ refout: e.target.checked })} />
                <span>{tx("输出", "out")}</span>
              </span>
            </FormRow>
            <div className="props-hint">
              {tx(
                "线上字节序跟着反射走：反射算法低字节在前 —— 同样的参数下 Modbus / X-25 与具名算法逐字节相同",
                "Wire byte order follows reflection: reflected means low byte first — with these parameters Modbus / X-25 match the named algorithms byte for byte",
              )}
            </div>
          </>
        )}
      </Section>

      <Section title={tx("解析协议", "Parsing protocol")}>
        {tpl.fromTplId && (
          <div className="props-hint">
            {(() => {
              const src = rules.rules.templates.find((t) => t.id === tpl.fromTplId);
              return src
                ? tx(`这张谱是从协议「${src.name}」的帧起头的`, `Drafted from frames of protocol “${src.name}”`)
                : tx("这张谱起自某个协议的帧，那个协议已经删了", "Drafted from a protocol that has since been deleted");
            })()}
          </div>
        )}
        <button
          className="btn"
          disabled={!preview?.ok}
          title={
            preview?.ok
              ? tx(
                  "照这张谱的块顺序与宽度新建一份解析协议（只新建，不动已有协议）",
                  "Create a parsing protocol from this spec's block order and widths — it adds one, it never rewrites an existing one",
                )
              : tx("编不出帧就派生不出协议：先修好下面那句报错", "No frame, nothing to derive — fix the error below first")
          }
          onClick={deriveProtocol}
        >
          {tx("写成解析协议", "Write as protocol")}
        </button>
        {derivedNotes.map((n, i) => (
          <div className="props-hint" key={i}>
            {n}
          </div>
        ))}
      </Section>
    </div>
  );
}

/** 角色中文名两边共用一份（P123-C：措辞取接收侧那版，见 inspector/roleNames） */
const roleLabelOf = (r: FieldRole): string => roleNames()[r];
