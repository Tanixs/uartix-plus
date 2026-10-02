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
import { HelpHint } from "../../shared/HelpHint";
import { IconChevron } from "../../shared/icons";
import * as controlsStore from "../controls/controlsStore";
import { revealTargets } from "../controls/cardBinding";
import { roleNames } from "./roleNames";
import { setInspectorFocus, txeBackToSpec } from "./focus";
import { guardLocked } from "../operator/lock";
import * as templateStore from "../protocol/templateStore";
import { SEND_FIELD_ROLES, formatEnumSpec, paramTypeOf, parseEnumSpec, type SendField, type SendParam, type SendParamType, type SendTemplate } from "../send/sendTypes";
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
 * 参数类型表。`enum` 以前故意不在选项里——它的档位表没有编辑入口，给一个"选了却没法填"的选项
 * 就是假开关（§8-34）。P127-A 把那张表补上了（卡里的「档位表」那一行），假开关的指控不再成立，
 * 于是收进来。`text` / `enum` 仍然点不动「生成控件」：选择框卡还没做，那颗键的问号在说这件事。
 */
const PARAM_TYPES: SendParamType[] = ["int", "uint", "float", "text", "enum"];

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
  /** 哪个参数展开了（本地态：这是"看哪儿"，不是谱的内容，不该落盘也不该进撤销栈） */
  const [openParams, setOpenParams] = useState<Record<string, boolean>>({});
  /**
   * 档位表被拒收的次数。拒收时那张表**没变**，可输入框里还留着刚打的那一句（`TextInput` 自己
   * 存着草稿），于是红字说的和被拒的那句已经不在屏上了——下一句更糟：如果改成与谱里相同的内容，
   * `TextInput` 认为"没变化"根本不提交，红字就永远留在那儿。
   * 拿它当 `key`：拒收那一刻整块重挂，框子回到谱里真正那张表，话和框说的就是同一件事。
   */
  const [enumNonce, setEnumNonce] = useState<Record<string, number>>({});

  /** 与面板底部那行 hex 同一个纯编码器：换界面不换算法，才谈得上"看到的就是发出去的" */
  const preview = useMemo(() => {
    if (!tpl) return null;
    try {
      return { ok: true as const, ...encodeSend(tpl, { seq: tpl.nextSeq ?? 0 }) };
    } catch (e) {
      // 类名剥两层：`Error:` 是老账，`SendEncodeError:` 是这一族自己的。这行红字是给人读的一句
      // 话，前面挂一个异常类名就像系统在替自己辩解（面板脚那行今天还带着它，那是另一处的事）。
      return { ok: false as const, msg: String(e).replace(/^(Error|SendEncodeError):\s*/, "") };
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

  // 选中一个"来源=参数"的块，就把它绑的那个参数展开 —— 分级折叠最怕的就是"要滚开才知道是谁"
  useEffect(() => {
    if (linkParamId) setOpenParams((m) => (m[linkParamId] ? m : { ...m, [linkParamId]: true }));
  }, [linkParamId]);

  /**
   * 删一条参数。走的是 `sendStore.removeParam` 那道守卫：还有块按 id 在取它的时候**不删**，
   * 并把是哪几个块点出来 —— 参数没了而块还按老 id 取值，症状是"预览突然一直报错"，
   * 而用户看不出谁被删了（store 里那段注释记的就是 P113-E 的同族教训）。
   * 界面这边不另建一份"谁在用"的账：两处各算一遍就会有一天算出两个答案。
   */
  const dropParam = (p: SendParam) => {
    if (!tpl) return;
    const r = sendStore.removeParam(tpl.id, p.id);
    if (r.ok) {
      setErr("");
      setMsg(tx(`参数「${p.name}」已删掉`, `Parameter “${p.name}” removed`));
      return;
    }
    // usedBy 空 = 这张谱不在了，或是只读锁（锁那侧 store 自己弹过话）：都不该在这里复述一遍
    if (!r.usedBy.length) return;
    setMsg("");
    setErr(
      tx(
        `删不掉：还有 ${r.usedBy.length} 个块在用参数「${p.name}」（${r.usedBy.join("、")}）。先把这些块的值来源换掉。`,
        `Can't remove: ${r.usedBy.length} block(s) still read parameter “${p.name}” (${r.usedBy.join(", ")}). Switch those blocks' value source first.`,
      ),
    );
  };

  /**
   * 写档位表。三件事按"谁会造成静默"排：
   *  1. 不成对的条目（少了 `=`、值空着）原样退回界面点名 —— 悄悄丢一档的症状是
   *     "我明明写了停止，按下去却报「不在档位里」"，那句还是编码器说的实话；
   *  2. 同名两档也点名：编码器 `find` 只取第一条，后面那档永远发不出去，而且不报错；
   *  3. 值本身编不出字节（比如给 u8 写了「启动=256」）**不在这里判** ——
   *     判它就得在这儿再写一份"什么值能进什么字段"的规则，那就是第二份真值。
   *     这条交给编码器：它的话原样显示在下面的红字里。
   */
  const commitEnum = (p: SendParam, text: string) => {
    if (!tpl) return;
    const { map, bad, dupes } = parseEnumSpec(text);
    // 拒收时把框子收回谱里真正那张表：红字说的是"那一句没写进去"，框里却还留着那一句，
    // 读起来就成了"屏上这个值没生效"——而屏上那个值根本不在谱里。两边得说同一件事。
    const snapBack = () => setEnumNonce((m) => ({ ...m, [p.id]: (m[p.id] ?? 0) + 1 }));
    if (bad.length) {
      setErr(
        tx(
          `档位表里这几条不是「名字=值」：${bad.join("、")} —— 这一句没写进谱，原来那张表还在`,
          `These rows aren't “label=value”: ${bad.join(", ")} — nothing was written; the previous table still stands`,
        ),
      );
      snapBack();
      return;
    }
    if (dupes.length) {
      setErr(
        tx(
          `同一个名字写了两档：${dupes.join("、")} —— 编码器只取第一条，后面那一档永远发不出去`,
          `Duplicated labels: ${dupes.join(", ")} — the encoder takes the first match, so the later row could never be sent`,
        ),
      );
      snapBack();
      return;
    }
    sendStore.patchParam(tpl.id, p.id, { enumMap: map });
    setErr("");
  };

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
    <div
      className="props-panel"
      onKeyDown={(e) => {
        // Esc 从这一块退回整张谱。只在这块面板还握着 tx 焦点时才认，别抢别人的 Esc
        if (e.key === "Escape" && txeBackToSpec()) e.stopPropagation();
      }}
    >
      {/* 页头一行搞定，与帧画布那块同一形状（P125-A）：返回键 + 色点 + 「对象 · 名」。
          上一版把面包屑和标题排成两行，两行都是 12px 灰字，中间没有留白 ⇒ 看着就是"字贴在一起"。
          返回键不是装饰：Esc 也走同一件事，它的 tooltip 就是那句键盘话。 */}
      <div className="props-title">
        {field && (
          <button
            type="button"
            className="back-btn"
            onClick={() => setInspectorFocus({ side: "tx", id: tpl.id, fieldId: "" })}
            title={tx("回到这张谱的属性（Esc）", "Back to this spec's properties (Esc)")}
          >
            <IconChevron size={13} dir="left" />
            {tx("返回", "Back")}
          </button>
        )}
        {field?.color && <span className="tpl-dot" style={{ background: field.color }} />}
        <span className="tpl-name">
          {field
            ? `${tx("发送块", "Send block")} · ${field.name}`
            : `${tx("发送谱", "Send spec")} · ${tpl.name}`}
        </span>
      </div>
      {!field && (
        <div className="form-hint">
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
            // 标签收成「位段」（与料板上那颗同名），两个框各自说自己是谁 ——
            // 原来叫"位起 / 位宽"，六个字加斜杠放不下 56px 的标签列，标签自己先折成两排
            <FormRow label={tx("位段", "Bit span")}>
              <span className="form-pair grow">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={7}
                  title={tx("起始位：从这一字节的第几位开始", "First bit: which bit of the byte it starts at")}
                  value={field.bits?.index ?? 0}
                  onChange={(e) => patchSel({ bits: { index: Number(e.target.value), count: field.bits?.count ?? 1 } })}
                />
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={8}
                  title={tx("位宽：占几位", "Width: how many bits")}
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
            {/* 五种来源各有一句"什么时候用它"，写在行下就是三排灰字（图一那种杂乱）。
                收进问号：悬停才占地方，不悬停时这一屏只有行。 */}
            <HelpHint
              text={tx(
                "固定字节 = 帧头、帧尾、写死的操作码；参数 = 每次触发可以改的值；解析变量 = 取接收侧刚解析出来的实时值，取不到就报错，不会把 {名字} 原样发给设备；自增序号 = 每发一帧加一个步进；长度回填 = 按这一帧的字节数自动填。",
                "Fixed = header, footer, hard-coded op codes; Parameter = a value you can change per trigger; Parsed variable = the live value the receiver just parsed, and a missing one is an error rather than a literal {name} on the wire; Auto counter = steps forward each frame; Length = backfilled from this frame's byte count.",
              )}
            />
          </FormRow>
          {field.source.kind === "seq" && (
            <FormRow label={tx("步进回绕", "Step / wrap")}>
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
              <span className="sb-hint">{link.line}</span>
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
            <FormRow label={tx("固定字节", "Fixed bytes")}>
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
        {/* 编不出帧时把编码器的原话搬到这里一句。它和面板脚上那行红字是同一个纯函数的同一个结果，
            不是第二份真相 —— 搬的理由只是位置：刚在卡里改完一档，报错该出现在手边，而不是
            "另一面面板的底部那儿"。「256 装不进 u8」这类话只有编码器会说。 */}
        {!err && preview && !preview.ok && <div className="props-warn">{preview.msg}</div>}
        {msg && <div className="form-hint">{msg}</div>}

      {/* 这一层的读法整句收在组头这颗问号里：原来每张卡各挂一句"展开来改它的默认值与范围"，
          四条参数就是四句一模一样的话 —— 说一次就够，而且说在组头比说在卡上更对（那是"这组怎么读"，
          不是"这张卡怎么读"）。卡头只留真状态：正在编的这块用的是哪一条。 */}
      <div className="props-section">
        <span>{tx("参数", "Parameters")}</span>
        <HelpHint
          text={tx(
            "一张卡 = 一个参数，点开才看到它的名字、类型、默认值与范围；标着「当前块」的那张，就是你正在编的这块在取值的参数。默认值就是发出去的那一帧里的值。要临时改一版有两条路，都不动默认值：命令设置弹窗里的「覆盖参数」只改这一条命令（空着的那一行才走默认值）；控制画布上绑了这个参数的滑条 / 开关卡，它设的值只算那一次发送。",
            "One card = one parameter: its name, type, default and range appear when you expand it. The card flagged “this block” is the parameter the block you are editing reads. The default is what goes out in the frame. Two ways to send something else once, neither touching the default: the Override parameters section of this command's settings dialog changes just that command (an empty row still follows the default), while a slider or switch card bound to this parameter overrides only that one send.",
          )}
        />
      </div>
      {tpl.params.map((p) => {
        const open = !!openParams[p.id];
        const bound = field?.source.kind === "param" && field.source.paramId === p.id;
        return (
          <div key={p.id} className={`props-item${bound ? " cur" : ""}${open ? " open" : ""}`}>
            <button
              type="button"
              className="props-item-head"
              aria-expanded={open}
              onClick={() => setOpenParams((m2) => ({ ...m2, [p.id]: !open }))}
              title={bound ? tx("你正在编的这块，取的就是这个参数", "The block you are editing reads this parameter") : undefined}
            >
              <span className="props-item-name">{p.name}</span>
              <span className="props-item-tag">{p.type}</span>
              {bound && <span className="props-item-flag">{tx("当前块", "this block")}</span>}
              <span className="props-item-arrow"><IconChevron size={12} dir={open ? "down" : "right"} /></span>
            </button>
            {open && (
              <div className="props-item-body">
                <FormRow label={tx("名字", "Name")}>
                  <TextInput value={p.name} onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { name: v })} />
                </FormRow>
                <FormRow label={tx("类型", "Type")}>
                  <select
                    className="input"
                    value={p.type}
                    onChange={(e) => sendStore.patchParam(tpl.id, p.id, { type: e.target.value as SendParamType })}
                  >
                    {PARAM_TYPES.map((t) => (
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
                    {/* 问号放进 form-pair 里，不是放在行尾：form-pair 是 `flex:1 1 130px`，
                        行又是 flex-wrap，于是"标签 + 那对框 + 问号"在窄面板里算的是基准宽 56+130+13+16 > 面板宽
                        ⇒ 问号掉到第二排（实测 263px 面板行高 45px）。放进那一个 flex 项里，
                        两个输入框能缩到各自 56px，整行 24px 站得住，也不用为它新写一条 CSS。 */}
                    <span className="form-pair grow">
                      <NumInput
                        value={p.min ?? 0}
                        title={tx("最小值", "Minimum")}
                        onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { min: v })}
                      />
                      <NumInput
                        value={p.max ?? 100}
                        title={tx("最大值", "Maximum")}
                        onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { max: v })}
                      />
                      {/* 原来只在两个输入框上各挂一句"生成滑条卡时当下限/上限"——这句是真的，
                          但少了一半：编码器同样拿它拦帧，越界就报错。少说这半句会让人以为
                          范围只是个滑条装饰，于是填了数却不知道怎么把这一帧填错。 */}
                      <HelpHint
                        text={tx(
                          "这两条线同时管两件事：发这一帧时越界会被拦下并报「小于下限 / 大于上限」；用它生成滑条卡时，它俩就是滑条的上下限。",
                          "These two bounds do two jobs: a value outside them is refused with an error when the frame is encoded, and they become the slider's limits when a card is generated from this parameter.",
                        )}
                      />
                    </span>
                  </FormRow>
                )}
                {p.type === "enum" && (
                  <FormRow label={tx("档位表", "Options")}>
                    <TextInput
                      key={`enum-${p.id}-${enumNonce[p.id] ?? 0}`}
                      value={formatEnumSpec(p.enumMap)}
                      placeholder={tx("启动=01; 停止=00", "on=01; off=00")}
                      onCommit={(v) => commitEnum(p, v)}
                    />
                    <HelpHint
                      text={tx(
                        "写成「界面名字 = 发出去的值」，用分号或换行分开。触发时输入左边的名字，发出去的是右边的值；默认值也必须是其中一档（名字或值都行），否则这一帧编不出来。",
                        "Write pairs of “label = bytes to send”, separated by ; or newlines. Typing the label on the left sends the value on the right; the default has to be one of these rows too, or the frame won't encode.",
                      )}
                    />
                  </FormRow>
                )}
                <div className="form-row">
                  <button
                    className="btn"
                    disabled={p.type === "text" || p.type === "enum"}
                    title={
                      p.type === "text" || p.type === "enum"
                        ? undefined
                        : tx(
                            "在控制画布生成一张滑条卡，值灌进这个参数",
                            "Create a slider card on the control canvas that feeds this parameter",
                          )
                    }
                    onClick={() => spawnSliderCard(p.id)}
                  >
                    {tx("生成控件", "Add control")}
                  </button>
                  {/* 禁用键的 title 在浏览器里不弹 —— 偏偏那颗键上写着"为什么点不动"。
                      只有真点不动的时候才给这颗问号，能用的时候不摆空牌子。 */}
                  {(p.type === "text" || p.type === "enum") && (
                    <HelpHint
                      text={tx(
                        "文本 / 枚举参数还没有对应的控件类型（选择框卡在 P122）：没有卡能灌这个参数，所以这颗键点不动。",
                        "Text and enum parameters have no matching card type yet (the select card is in P122), so nothing can feed this parameter.",
                      )}
                    />
                  )}
                </div>
                {/* 这颗键补的是这一层欠的出口：值来源每切一次「参数」就长一条，而今天只能改名不能删。
                    危险键不和「生成控件」并排（挨在一起就有误点），也不挂问号 —— 它不 disabled，
                    守卫生效时那句点名话走页级报错，那才是它该出现的地方。 */}
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <button
                    className="btn sb-danger"
                    title={tx(
                      "从参数表里删掉它。还有块在按这个名字取值时不会删，会点名是哪几个块。",
                      "Remove it from the parameter table. While a block still reads it, nothing is deleted — the blocks get named instead.",
                    )}
                    onClick={() => dropParam(p)}
                  >
                    {tx("删掉这个参数", "Remove this parameter")}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {!tpl.params.length && (
        <div className="form-hint">
          {tx("没有参数：把某块的来源选成「参数」就有了", "No parameters — set a block’s source to Parameter")}
        </div>
      )}

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
          <FormRow label={tx("覆盖起止", "Coverage")}>
            <span className="form-pair grow">
              <NumInput
                value={tpl.checksum.coverageStart}
                title={tx("起点：从第几字节算起", "Start: which byte the check begins at")}
                onCommit={(v) => sendStore.patchTemplate(tpl.id, { checksum: { ...tpl.checksum!, coverageStart: v } })}
              />
              <NumInput
                value={tpl.checksum.coverageEnd}
                title={tx("终点：算到第几字节（负数按距帧尾算）", "End: which byte it stops at (negative counts from the tail)")}
                onCommit={(v) => sendStore.patchTemplate(tpl.id, { checksum: { ...tpl.checksum!, coverageEnd: v } })}
              />
              <HelpHint
                text={tx(
                  "从第几字节算到第几字节。终点填负数按距帧尾算：-2 = 不含最后两字节。",
                  "Which bytes the check runs over. A negative end counts from the tail: -2 excludes the last two bytes.",
                )}
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
                {/* 这句是"反射还会顺带决定线上字节序"——两排灰字挂在参数底下，
                    看着像校验区的一条通用说明，其实是这一行的事（P125-B 收进这颗问号） */}
                <HelpHint
                  text={tx(
                    "线上字节序跟着反射走：勾了输出反射就低字节在前 —— 同样这组参数下，Modbus / X-25 与具名算法逐字节相同。",
                    "The wire byte order follows reflection: with output reflection on, the low byte goes first — so this same parameter set matches the named Modbus / X-25 algorithms byte for byte.",
                  )}
                />
              </span>
            </FormRow>
          </>
        )}
      </Section>

      <Section title={tx("解析协议", "Parsing protocol")}>
        {tpl.fromTplId && (
          <div className="form-hint">
            {(() => {
              const src = rules.rules.templates.find((t) => t.id === tpl.fromTplId);
              return src
                ? tx(`这张谱是从协议「${src.name}」的帧起头的`, `Drafted from frames of protocol “${src.name}”`)
                : tx("这张谱起自某个协议的帧，那个协议已经删了", "Drafted from a protocol that has since been deleted");
            })()}
          </div>
        )}
        <div className="form-row" style={{ marginBottom: 0 }}>
          <button
            className="btn"
            disabled={!preview?.ok}
            title={
              preview?.ok
                ? tx(
                    "照这张谱的块顺序与宽度新建一份解析协议（只新建，不动已有协议）",
                    "Create a parsing protocol from this spec's block order and widths — it adds one, it never rewrites an existing one",
                  )
                : undefined
            }
            onClick={deriveProtocol}
          >
            {tx("写成解析协议", "Write as protocol")}
          </button>
          {/* 与「生成控件」同一件事：禁用键的 title 弹不出来，点不动的原因就必须换个地方说 */}
          {!preview?.ok && (
            <HelpHint
              text={tx(
                "编不出帧就派生不出协议：这一帧现在报错，先修好它。",
                "No frame, nothing to derive — this frame currently fails to encode; fix that first.",
              )}
            />
          )}
        </div>
        {derivedNotes.map((n, i) => (
          <div className="form-hint" key={i}>
            {n}
          </div>
        ))}
      </Section>
    </div>
  );
}

/** 角色中文名两边共用一份（P123-C：措辞取接收侧那版，见 inspector/roleNames） */
const roleLabelOf = (r: FieldRole): string => roleNames()[r];
