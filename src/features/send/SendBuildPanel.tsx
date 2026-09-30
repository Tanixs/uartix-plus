/**
 * P121-C · TX组帧台（旧名「发送组包」，2026-09-30 用户改名）。
 *
 * 为什么是一枚独立面板而不是"塞回控制台"：用户的原话是"指令工厂挤在控制台里有点拥挤"。
 * 这不是样式问题——导轨二级面板固定 300px（`SHELL_CHROME.railPanelW`），
 * 料板 + 字节带 + 属性 + 预览四块在里面放不下，硬放就是今天控制台的翻版。
 *
 * 交互与接收侧同族但方向相反：帧画布是"在真帧上框选一段字节 → 命名"，
 * 这里是"往空字节带上摆块 → 填值"。**用的是 DOM 字节条而不是 canvas**
 * （详设 §12.2 的改判）：帧画布的 canvas 服务于归档、滚动、缩放那一套，
 * 发送谱没有这些，共用只会把改动 134KB 文件的风险引进来。
 *
 * 预览与发送调的是同一个 `encodeSend`（P121-A 立的那条规矩）：
 * 界面上看到的字节**就是**点发送会出去的字节，没有第二份计算。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChecksumAlgo, Endian, FieldRole, FieldType } from "../../ipc/types";
import { tx, useLocale } from "../../i18n/strings";
import { EmptyState } from "../../shared/EmptyState";
import { attachPdragZone, beginPointerDrag, type PdragDetail } from "../../shared/pointerDrag";
import { IconDownload, IconPlus, IconTrash, IconUpload } from "../../shared/icons";
import { runCommand } from "../controls/cmdExec";
import * as cmdStore from "../controls/commandStore";
import * as controlsStore from "../controls/controlsStore";
import { guardLocked } from "../operator/lock";
import { NumInput, TextInput } from "../protocol/PropertiesPanel";
import * as sendStore from "./sendStore";
import { encodeSend, intRangeOf, parseHexInput } from "./encodeSend";
import {
  dropIndexAt,
  moveTargetIndex,
  sendFieldWidth,
  type SendField,
  type SendParamType,
  type SendTemplate,
} from "./sendTypes";

/**
 * 参数类型表。`enum` 故意不在选项里：它的档位表还没有编辑入口，
 * 给一个"选了却没法填"的选项就是假开关；但**已有** enum 参数的谱（导进来的）照样显示原值。
 */
const PARAM_TYPES: SendParamType[] = ["int", "uint", "float", "text"];

/** 字段类型 → 参数类型：u16 块不该自动长出一个带符号的 int 参数 */
const paramTypeOf = (t: FieldType): SendParamType =>
  t === "float32" || t === "float64" ? "float" : t.startsWith("u") ? "uint" : "int";

/** 料板：每一项就是一个字段预设。顺序即界面顺序，按"结构件 → 数值 → 文本 → 计算件"排 */
const PALETTE: { key: string; label: () => string; make: () => Omit<SendField, "id"> }[] = [
  { key: "header", label: () => tx("帧头", "Header"), make: () => ({ name: tx("帧头", "Header"), type: "uint8", endian: "big", role: "header", source: { kind: "const", bytes: [0xaa] } }) },
  { key: "const", label: () => tx("固定字节", "Fixed bytes"), make: () => ({ name: "00", type: "uint8", endian: "big", role: "data", source: { kind: "const", bytes: [0x00] } }) },
  { key: "u8", label: () => "u8", make: () => ({ name: "u8", type: "uint8", endian: "big", role: "data", source: { kind: "param", paramId: "" } }) },
  { key: "u16", label: () => "u16", make: () => ({ name: "u16", type: "uint16", endian: "big", role: "data", source: { kind: "param", paramId: "" } }) },
  { key: "u32", label: () => "u32", make: () => ({ name: "u32", type: "uint32", endian: "big", role: "data", source: { kind: "param", paramId: "" } }) },
  { key: "i16", label: () => "i16", make: () => ({ name: "i16", type: "int16", endian: "big", role: "data", source: { kind: "param", paramId: "" } }) },
  { key: "f32", label: () => "f32", make: () => ({ name: "f32", type: "float32", endian: "big", role: "data", source: { kind: "param", paramId: "" } }) },
  { key: "f64", label: () => "f64", make: () => ({ name: "f64", type: "float64", endian: "big", role: "data", source: { kind: "param", paramId: "" } }) },
  { key: "bcd", label: () => "BCD", make: () => ({ name: "bcd", type: "bcd", size: 2, endian: "big", role: "data", source: { kind: "param", paramId: "" } }) },
  { key: "bits", label: () => tx("位段", "Bits"), make: () => ({ name: "bit", type: "bits", endian: "big", role: "data", bits: { index: 0, count: 1 }, source: { kind: "param", paramId: "" } }) },
  { key: "ascii", label: () => tx("文本", "Text"), make: () => ({ name: "txt", type: "ascii", size: 4, endian: "big", role: "payload", source: { kind: "param", paramId: "" } }) },
  { key: "seq", label: () => tx("帧序号", "Sequence"), make: () => ({ name: "seq", type: "uint8", endian: "big", role: "seq", source: { kind: "seq" } }) },
  { key: "len", label: () => tx("长度域", "Length"), make: () => ({ name: "len", type: "uint8", endian: "big", role: "length", source: { kind: "len", covers: "after" } }) },
  { key: "ck", label: () => tx("校验段", "Checksum"), make: () => ({ name: "ck", type: "uint8", endian: "big", role: "checksum", source: { kind: "const", bytes: [] } }) },
  { key: "footer", label: () => tx("帧尾", "Footer"), make: () => ({ name: tx("帧尾", "Footer"), type: "uint8", endian: "big", role: "footer", source: { kind: "const", bytes: [0x55] } }) },
];

const TYPES: FieldType[] = ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64", "ascii", "bcd", "bits"];
const ENDIANS: Endian[] = ["big", "little", "big-word-swap", "little-word-swap"];
const ROLES: FieldRole[] = ["header", "addr", "id", "seq", "length", "data", "payload", "checksum", "footer"];
const CK_ALGOS: ChecksumAlgo[] = ["none", "sum8", "xor8", "sumadd", "crc16_modbus", "crc16_ccitt", "crc32"];

const roleLabel = (r: FieldRole): string =>
  ({
    header: tx("帧头", "header"), addr: tx("地址", "addr"), id: tx("标识", "id"), seq: tx("序号", "seq"),
    length: tx("长度", "length"), data: tx("数据", "data"), payload: tx("载荷", "payload"),
    checksum: tx("校验", "checksum"), checksum2: tx("校验 2", "checksum 2"), footer: tx("帧尾", "footer"),
  })[r];

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;
const hexOf = (f: SendField) =>
  f.source.kind === "const" ? f.source.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ") : "";

/** 落点：把带上的块读成矩形，判定规则本身在 `sendTypes.dropIndexAt`（那条规则要能单独测） */
function dropIndex(el: HTMLElement, clientX: number): number {
  return dropIndexAt(
    Array.from(el.querySelectorAll<HTMLElement>("[data-sb-field]")).map((c) => c.getBoundingClientRect()),
    clientX,
  );
}

export function SendBuildPanel() {
  useLocale();
  const tpls = useSyncExternalStore(sendStore.subscribe, sendStore.getSnapshot);
  const [selId, setSelId] = useState("");
  const [selField, setSelField] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [at, setAt] = useState(-1);
  const stripRef = useRef<HTMLDivElement>(null);

  const tpl: SendTemplate | null = tpls.find((x) => x.id === selId) ?? tpls[0] ?? null;
  useEffect(() => {
    if (tpl && selId !== tpl.id) setSelId(tpl.id);
  }, [tpl, selId]);

  // 换一张谱：上一张的报错和"已存为指令"不该还挂在下面冒充当前状态
  useEffect(() => {
    setErr("");
    setMsg("");
  }, [selId]);

  // 预览用的序号 = 谱自己的计数器：这样"预览里那个 seq"就是下一次发送真会带上的那个
  const preview = useMemo(() => {
    if (!tpl) return null;
    try {
      const r = encodeSend(tpl, { seq: tpl.nextSeq ?? 0 });
      return { ok: true as const, ...r };
    } catch (e) {
      return { ok: false as const, msg: String(e).replace(/^Error:\s*/, "") };
    }
  }, [tpl]);

  const field = tpl?.fields.find((f) => f.id === selField) ?? null;

  const insertAt = useCallback(
    (key: string, index: number) => {
      if (!tpl) return;
      const spec = PALETTE.find((p) => p.key === key);
      if (!spec) return;
      const made: SendField = { id: uid("sf"), ...spec.make() };
      if (made.source.kind === "param") {
        // 参数化字段必须同时留下参数定义，否则预览第一步就报"引用了不存在的参数"
        const pid = uid("sp");
        made.name = made.name || pid;
        made.source = { kind: "param", paramId: pid };
        sendStore.addParam(tpl.id, { id: pid, name: made.name, type: paramTypeOf(made.type), def: "0" });
      }
      // 校验段一落地就把算法定下来：留着 null 让用户先摆块再回头找下拉，
      // 换来的是预览报"字段标成校验但没选算法"——一个只有作者看得懂的中间态
      if (made.role === "checksum" && !tpl.checksum) {
        sendStore.patchTemplate(tpl.id, { checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2 } });
      }
      sendStore.addField(tpl.id, made, index);
      setSelField(made.id);
      setErr("");
    },
    [tpl],
  );

  useEffect(() => {
    const el = stripRef.current;
    if (!el || !tpl) return;
    return attachPdragZone(el, {
      kinds: "sendspec,sendfield",
      onOver: (d: PdragDetail) => setAt(dropIndex(el, d.x)),
      onLeave: () => setAt(-1),
      onDrop: (d: PdragDetail) => {
        const index = dropIndex(el, d.x);
        setAt(-1);
        if (d.kind === "sendspec") insertAt(d.data, index);
        else if (d.kind === "sendfield") {
          const from = tpl.fields.findIndex((f) => f.id === d.data);
          const to = moveTargetIndex(from, index);
          sendStore.moveField(tpl.id, from, to);
        }
      },
    });
  }, [tpl, insertAt]);

  /**
   * 面板这枚「发送一次」走的就是命令库、快捷栏、卡片那同一条 `runCommand`：
   * 占号 / 编码 / 失败退号的判据因此只有一份。参数值不在这层另存一份——
   * 面板上编辑的就是谱里的默认值，要临时改一版归命令与卡片的覆盖管。
   */
  const send = async () => {
    if (!tpl || !preview?.ok) return;
    try {
      await runCommand({
        sendMode: "hex",
        template: "",
        script: "",
        scriptEnabled: false,
        sendTemplateId: tpl.id,
      });
      setErr("");
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  /**
   * 存为指令 = 存一条**引用**，不是存一串字节。
   *
   * 今天快捷栏那枚「存为指令」把当前参数值烤成 hex 字面量写进 `template`
   * （详设 §1.4）：存完参数就没了、长度不再回填、校验不再重算，用户以为存下的是"怎么做一帧"，
   * 实际存下的是"那一帧当时长什么样"。这里交给 `addReferenceCommand`，改谱命令跟着变。
   *
   * 不带 `overrides`：面板上编辑的就是谱的默认值，那份值属于谱、不属于这条命令。
   * "这条指令要发另一个值"是命令自己的事（参数条覆盖），别在这里长出第二份真值。
   */
  const saveAsCommand = () => {
    if (!tpl || !preview?.ok) return;
    const id = cmdStore.addReferenceCommand({
      templateId: tpl.id,
      name: tpl.name,
      note:
        tpl.note ||
        tx(
          "由发送谱「{n}」引用：改谱即改命令",
          "Referenced from template “{n}”: editing the template edits this",
        ).replace("{n}", tpl.name),
    });
    if (id) setMsg(tx("已存为指令（引用这张谱）", "Saved as a command — it references this template"));
  };

  /**
   * 导出 / 导入 = 一张谱的**文件**往返。
   *
   * 为什么走 Tauri 的另存为而不是 `<a download>`：与控制画布 / 参数集 / 编排器那几处
   * 同一族（`save_text_file` / `read_text_file`），文件对话框能记住目录，
   * 而"发谱"是要拿去给同事、拿去配另一台机器的东西。
   */
  const doExport = async () => {
    if (!tpl) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({
        title: tx("导出发送谱", "Export send template"),
        defaultPath: `uartix-sendspec-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
        filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("save_text_file", { path, content: sendStore.packSpecFile([tpl]) });
      setMsg(tx("已导出到文件", "Exported to file"));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const doImport = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await open({
        multiple: false,
        filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const list = sendStore.unpackSpecFile(await invoke<string>("read_text_file", { path }));
      if (!list) {
        setErr(tx("不是发送谱文件（kind 不匹配）", "Not a send-template file (kind does not match)"));
        return;
      }
      const n = sendStore.importTemplates(list);
      setMsg(
        n
          ? tx(`已导入 ${n} 张谱`, `Imported ${n} templates`)
          : tx("文件里没有可导入的谱", "Nothing importable in that file"),
      );
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  /**
   * D11：参数的「生成控件」——在控制画布落一张滑条卡，卡的值灌进这个参数。
   *
   * 卡片带的是**引用**（`sendTemplateId` + `paramId`），不是此刻烤出来的字节：
   * 改谱，这张卡跟着变（详设 §7 P121-D 的验收句）。
   * 参数没声明 min/max 就用滑条默认的 0~100；`text` / `enum` 两档现在没有对应的
   * 卡片类型（选择框卡还没造），所以那两行的按钮是 disabled + 一句为什么，不是点了没反应。
   */
  const spawnSliderCard = (paramId: string) => {
    if (!tpl) return;
    // 就地拦锁：`controlsStore.addCard/patchCard` 今天不拦（它们还要服务只读锁下的正常操作，
    // 比如开关卡记自己那一档），所以这颗按钮的入口自己把关。
    if (guardLocked()) return;
    const p = tpl.params.find((x) => x.id === paramId);
    const page = controlsStore.activePage();
    if (!p || !page) {
      setErr(tx("没有可落卡片的控制页", "No control page to place the card on"));
      return;
    }
    // 范围：参数自己声明的优先；没声明就按**吃这个参数的那块能装下什么**推。
    // 写死 0~100 的后果是实测过的：u16 参数的默认值 1234，生成出来的滑条上限 100、
    // 开机值被夹成 100 —— 卡发出去的不是谱里那个值。
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

  const patchSel = (patch: Partial<SendField>) => {
    if (tpl && field) sendStore.patchField(tpl.id, field.id, patch);
  };

  return (
    <div className="sb">
      <div className="sb-bar p-bar">
        <button
          className="btn icon-btn"
          title={tx("新建", "New")}
          onClick={() => {
            const id = sendStore.addTemplate();
            if (id) setSelId(id);
          }}
        >
          <IconPlus />
        </button>
        <button
          className="btn icon-btn"
          title={tx("从文件导入发送谱", "Import send templates from a file")}
          onClick={() => void doImport()}
        >
          <IconUpload />
        </button>
        <button
          className="btn icon-btn"
          title={tx("导出这份发送谱到文件", "Export this template to a file")}
          disabled={!tpl}
          onClick={() => void doExport()}
        >
          <IconDownload />
        </button>
        <button className="btn" onClick={() => sendStore.undo()} disabled={!sendStore.canUndo()}>
          {tx("撤销", "Undo")}
        </button>
        <button className="btn" onClick={() => sendStore.redo()} disabled={!sendStore.canRedo()}>
          {tx("重做", "Redo")}
        </button>
        {tpl && (
          <>
            <input
              className="input sb-name"
              value={tpl.name}
              onChange={(e) => sendStore.patchTemplate(tpl.id, { name: e.target.value })}
            />
            <button
              className="btn icon-btn"
              title={tx("复制这份发送谱", "Duplicate this template")}
              onClick={() => setSelId(sendStore.duplicateTemplate(tpl.id))}
            >
              <IconPlus />
            </button>
            <button
              className="btn icon-btn"
              title={tx("删除这份发送谱", "Delete this template")}
              onClick={() => {
                sendStore.removeTemplate(tpl.id);
                setSelId("");
              }}
            >
              <IconTrash />
            </button>
          </>
        )}
        <div className="sb-bar-spacer" />
        <select
          className="input"
          value={tpl?.id ?? ""}
          onChange={(e) => setSelId(e.target.value)}
          title={tx("切换发送谱", "Switch template")}
        >
          {!tpl && <option value="">{tx("（无）", "(none)")}</option>}
          {tpls.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>

      {!tpl ? (
        <EmptyState
          title={tx("还没有发送谱", "No send templates yet")}
          hint={[tx("一张谱描述一帧要发的字节：帧头、字段、长度域、校验", "A template describes one frame to send: header, fields, length, checksum")]}
          actions={[{ label: tx("新建", "New"), onClick: () => setSelId(sendStore.addTemplate()), primary: true }]}
        />
      ) : (
        <div className="sb-body">
          <div className="sb-palette" role="group" aria-label={tx("字段料板", "Field palette")}>
            {PALETTE.map((p) => (
              <button
                key={p.key}
                className="sb-chip sb-palette-chip"
                title={tx("拖到字节带上，或点一下加到尾部", "Drag onto the byte strip, or click to append")}
                onPointerDown={(e) =>
                  beginPointerDrag(e, { kind: "sendspec", data: p.key, label: p.label() })
                }
                onClick={() => insertAt(p.key, sendStore.getTemplate(tpl.id)?.fields.length ?? 0)}
              >
                {p.label()}
              </button>
            ))}
          </div>

          <div
            className="sb-strip"
            ref={stripRef}
            role="group"
            aria-label={tx("字节带", "Byte strip")}
            onDragOver={(e) => e.preventDefault()}
          >
            {tpl.fields.length === 0 && <span className="sb-strip-blank">{tx("从料板拖一块进来，或点一下加到尾部", "Drag a block from the palette, or click one to append it")}</span>}
            {tpl.fields.map((f, i) => (
              <span key={f.id} className="sb-slot-wrap">
                {at === i && <i className="sb-caret" aria-hidden="true" />}
                <button
                  data-sb-field={f.id}
                  className={`sb-chip sb-f-${f.role}${f.id === selField ? " on" : ""}`}
                  title={`${roleLabel(f.role)} · ${f.type} · ${sendFieldWidth(f)}B`}
                  onPointerDown={(e) =>
                    beginPointerDrag(e, { kind: "sendfield", data: f.id, label: f.name })
                  }
                  onClick={() => setSelField(f.id)}
                >
                  <b>{f.name}</b>
                  <i>{hexOf(f) || f.type}</i>
                </button>
              </span>
            ))}
            {at >= tpl.fields.length && tpl.fields.length > 0 && <i className="sb-caret" aria-hidden="true" />}
          </div>

          <div className="sb-side">
            {field ? (
              <>
                <label className="sb-row">
                  <span>{tx("名称", "Name")}</span>
                  <input className="input" value={field.name} onChange={(e) => patchSel({ name: e.target.value })} />
                </label>
                <label className="sb-row">
                  <span>{tx("类型", "Type")}</span>
                  <select className="input" value={field.type} onChange={(e) => patchSel({ type: e.target.value as FieldType })}>
                    {TYPES.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                <label className="sb-row">
                  <span>{tx("角色", "Role")}</span>
                  <select className="input" value={field.role} onChange={(e) => patchSel({ role: e.target.value as FieldRole })}>
                    {ROLES.map((x) => (
                      <option key={x} value={x}>
                        {roleLabel(x)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sb-row">
                  <span>{tx("字节序", "Byte order")}</span>
                  <select className="input" value={field.endian} onChange={(e) => patchSel({ endian: e.target.value as Endian })}>
                    {ENDIANS.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                {(field.type === "ascii" || field.type === "bcd") && (
                  <label className="sb-row">
                    <span>{tx("字节数", "Bytes")}</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={field.size ?? 1}
                      onChange={(e) => patchSel({ size: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </label>
                )}
                {field.type === "bits" && (
                  <label className="sb-row">
                    <span>{tx("位起 / 位宽", "Bit / width")}</span>
                    <span className="sb-inline">
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
                  </label>
                )}
                <label className="sb-row">
                  <span>{tx("值来源", "Value from")}</span>
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
                </label>
                {field.source.kind === "const" && (
                  <label className="sb-row">
                    <span>{tx("字节 (hex)", "Bytes (hex)")}</span>
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
                  </label>
                )}
                {field.source.kind === "var" && (
                  <label className="sb-row">
                    <span>{tx("变量名", "Variable")}</span>
                    <input
                      className="input"
                      value={field.source.name}
                      onChange={(e) => patchSel({ source: { kind: "var", name: e.target.value } })}
                    />
                  </label>
                )}
                {field.source.kind === "len" && (
                  <label className="sb-row">
                    <span>{tx("长度数谁", "Length counts")}</span>
                    <select
                      className="input"
                      value={field.source.covers}
                      onChange={(e) => patchSel({ source: { kind: "len", covers: e.target.value as "self" | "after" | "body", adjust: field.source.kind === "len" ? field.source.adjust : undefined } })}
                    >
                      <option value="after">{tx("它之后的字节", "bytes after it")}</option>
                      <option value="body">{tx("含它自身", "including itself")}</option>
                      <option value="self">{tx("整帧", "whole frame")}</option>
                    </select>
                  </label>
                )}
                <button className="btn sb-danger" onClick={() => sendStore.removeField(tpl.id, field.id)}>
                  {tx("删除这个字段", "Remove this field")}
                </button>
              </>
            ) : (
              <div className="sb-hint">{tx("点字节带上的一块来编辑它", "Click a block on the strip to edit it")}</div>
            )}

            <div className="sb-params">
              <div className="sb-sec">{tx("参数", "Parameters")}</div>
              {tpl.params.map((p) => (
                <div key={p.id} className="sb-param">
                  <div className="sb-row">
                    <span>{tx("名字", "Name")}</span>
                    <TextInput
                      value={p.name}
                      onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { name: v })}
                    />
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
                  </div>
                  <div className="sb-row">
                    <span>{tx("类型", "Type")}</span>
                    <select
                      className="input"
                      value={p.type}
                      onChange={(e) =>
                        sendStore.patchParam(tpl.id, p.id, { type: e.target.value as SendParamType })
                      }
                    >
                      {(p.type === "enum" ? [...PARAM_TYPES, "enum" as SendParamType] : PARAM_TYPES).map(
                        (t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <div className="sb-row">
                    <span>{tx("默认值", "Default")}</span>
                    <TextInput
                      value={p.def}
                      placeholder="0"
                      onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { def: v })}
                    />
                  </div>
                  {p.type !== "text" && p.type !== "enum" && (
                    <div className="sb-row">
                      <span>{tx("范围", "Range")}</span>
                      <NumInput
                        value={p.min ?? 0}
                        width={62}
                        title={tx("最小值：生成滑条卡时当滑条下限", "Minimum — the lower bound of a generated slider")}
                        onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { min: v })}
                      />
                      <NumInput
                        value={p.max ?? 100}
                        width={62}
                        title={tx("最大值：生成滑条卡时当滑条上限", "Maximum — the upper bound of a generated slider")}
                        onCommit={(v) => sendStore.patchParam(tpl.id, p.id, { max: v })}
                      />
                    </div>
                  )}
                  {p.type === "enum" && (
                    <div className="sb-hint">
                      {tx("档位表还不能在这里编辑：导进来的谱原样保留，改不了", "The option table isn't editable here yet — imported specs keep theirs untouched")}
                    </div>
                  )}
                </div>
              ))}
              {!tpl.params.length && (
                <div className="sb-hint">
                  {tx("没有参数：把某块的来源选成「参数」就有了", "No parameters — set a block’s source to Parameter")}
                </div>
              )}
              <div className="sb-hint">
                {tx("默认值就是发出去的那一帧里的值；要临时改一版，在命令或卡片上覆盖它。", "The default is what goes out; override it per command or card for a one-off value.")}
              </div>
            </div>

            <div className="sb-params">
              <div className="sb-sec">{tx("校验", "Checksum")}</div>
              <label className="sb-row">
                <span>{tx("算法", "Algorithm")}</span>
                <select
                  className="input"
                  value={tpl.checksum?.algo ?? "none"}
                  onChange={(e) => {
                    const algo = e.target.value as ChecksumAlgo;
                    sendStore.patchTemplate(tpl.id, {
                      checksum: algo === "none" ? null : { algo, coverageStart: tpl.checksum?.coverageStart ?? 0, coverageEnd: tpl.checksum?.coverageEnd ?? -1 },
                    });
                  }}
                >
                  {CK_ALGOS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              {tpl.checksum && (
                <label className="sb-row">
                  <span>{tx("覆盖起 / 止", "Coverage")}</span>
                  <span className="sb-inline">
                    <input
                      className="input"
                      type="number"
                      value={tpl.checksum.coverageStart}
                      onChange={(e) =>
                        sendStore.patchTemplate(tpl.id, { checksum: { ...tpl.checksum!, coverageStart: Number(e.target.value) } })
                      }
                    />
                    <input
                      className="input"
                      type="number"
                      value={tpl.checksum.coverageEnd}
                      onChange={(e) =>
                        sendStore.patchTemplate(tpl.id, { checksum: { ...tpl.checksum!, coverageEnd: Number(e.target.value) } })
                      }
                    />
                  </span>
                </label>
              )}
            </div>
          </div>
        </div>
      )}

      {tpl && (
        <div className="sb-foot">
          <div className={`sb-preview${preview?.ok ? "" : " bad"}`}>
            {preview?.ok ? preview.hex : preview?.msg || ""}
          </div>
          <div className="sb-notes">
            {preview?.ok ? preview.notes.join(" · ") : ""}
            {err ? ` ${err}` : ""}
            {msg ? ` ${msg}` : ""}
          </div>
          <button className="btn" disabled={!preview?.ok} onClick={saveAsCommand}>
            {tx("存为指令", "Save as command")}
          </button>
          <button className="btn primary" disabled={!preview?.ok} onClick={() => void send()}>
            {tx("发送一次", "Send once")}
          </button>
        </div>
      )}
    </div>
  );
}
