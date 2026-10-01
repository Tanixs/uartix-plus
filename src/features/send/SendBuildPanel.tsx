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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { ChecksumAlgo, CrcParams, Endian, FieldRole, FieldType } from "../../ipc/types";
import { tx, useLocale } from "../../i18n/strings";
import { CRC_DEFAULT, parseCrcLiteral } from "../../shared/checksums";
import { EmptyState } from "../../shared/EmptyState";
import { attachPdragZone, beginPointerDrag, type PdragDetail } from "../../shared/pointerDrag";
import { IconChevron, IconClock, IconDownload, IconPlus, IconTrash, IconUpload } from "../../shared/icons";
import { Flyout } from "../../shared/Flyout";
import { useSettings } from "../settings/settingsStore";
import { SEND_PRESETS, applySendPreset, type SendPresetDef } from "./sendPresets";
import * as frameStore from "../framecanvas/frameStore";
import { draftFromFrame } from "./fromFrame";
import { runCommand } from "../controls/cmdExec";
import * as cmdStore from "../controls/commandStore";
import * as controlsStore from "../controls/controlsStore";
import * as templateStore from "../protocol/templateStore";
import { revealTargets } from "../controls/cardBinding";
import { DeriveError, toReceiveTpl } from "./specToProtocol";
import { guardLocked } from "../operator/lock";
import { NumInput, TextInput } from "../protocol/PropertiesPanel";
import * as sendStore from "./sendStore";
import { encodeSend, intRangeOf, parseHexInput } from "./encodeSend";
import {
  CELL_GAP,
  MIN_COLS,
  PITCH,
  RULER_W,
  canResize,
  caretAt,
  guessBadFieldId,
  gridModel,
  hexByte,
  insertIndexAtBoundary,
  LABEL_MIN_W,
  predictedBlocks,
  resizeWidthBy,
  resizedField,
  rowsOf,
  segBox,
  segEndsBlock,
  type GridBlock,
} from "./byteGrid";
import {
  SEND_FIELD_ROLES,
  moveTargetIndex,
  paramTypeOf,
  type SendField,
  type SendParamType,
  type SendTemplate,
} from "./sendTypes";

/**
 * 参数类型表。`enum` 故意不在选项里：它的档位表还没有编辑入口，
 * 给一个"选了却没法填"的选项就是假开关；但**已有** enum 参数的谱（导进来的）照样显示原值。
 */
const PARAM_TYPES: SendParamType[] = ["int", "uint", "float", "text"];

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
const CK_ALGOS: ChecksumAlgo[] = [
  "none",
  "sum8",
  "xor8",
  "sumadd",
  "sum16",
  "crc16_modbus",
  "crc16_ccitt",
  "crc16_x25",
  "crc_custom",
  "crc32",
];

/**
 * 切到 crc_custom 时先给一组**当场就能算出东西**的参数（CRC-16/CCITT-FALSE，`CRC_DEFAULT`）。
 * 留一个空参数组就是"选了算法却填不出帧"的中间态——这面板一路在消的就是这种态。
 */

const roleLabel = (r: FieldRole): string =>
  ({
    header: tx("帧头", "header"), addr: tx("地址", "addr"), id: tx("标识", "id"), seq: tx("序号", "seq"),
    length: tx("长度", "length"), data: tx("数据", "data"), payload: tx("载荷", "payload"),
    checksum: tx("校验", "checksum"), checksum2: tx("校验 2", "checksum 2"), footer: tx("帧尾", "footer"),
  })[r];

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;
const hexOf = (f: SendField) =>
  f.source.kind === "const" ? f.source.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ") : "";

/**
 * 落点：指针下面那条**字节边界**（全局下标），落在带的空白处（最后一行下面）返回 null ⇒ 追加到尾部。
 *
 * 网格里有两种命中物：格子（一个字节）与它上方那一行的块条段。条段也得能判——
 * 条带占了上半行，`elementsFromPoint` 常常先命中它。"边界→插到第几块前面"是
 * `byteGrid.insertIndexAtBoundary` 那条纯规则，这里只负责把像素换成字节下标。
 */
function boundaryAt(el: HTMLElement, x: number, y: number): number | null {
  for (const node of document.elementsFromPoint(x, y)) {
    if (!el.contains(node)) continue;
    const cell = node.closest<HTMLElement>("[data-byte-index]");
    if (cell) {
      const r = cell.getBoundingClientRect();
      const i = Number(cell.dataset.byteIndex);
      return i + (x - r.left > r.width / 2 ? 1 : 0);
    }
    const seg = node.closest<HTMLElement>("[data-seg-byte]");
    if (seg) {
      const len = Number(seg.dataset.segLen);
      const g = Number(seg.dataset.segByte);
      if (!len) return g;
      const r = seg.getBoundingClientRect();
      const pitch = r.width / len;
      const k = Math.max(0, Math.min(len - 1, Math.floor((x - r.left) / pitch)));
      return g + k + (x - r.left - k * pitch > pitch / 2 ? 1 : 0);
    }
  }
  return null;
}

/**
 * 让控制画布把某张卡闪一下。
 * 走的是脚本 `setControl` 那条现成的事件桥（`vs-control-trigger`）的同一族写法，
 * 不为一句话新造总线；控制画布没开着就没有监听者，这正好是我们要的安静。
 */
function revealCard(cardId: string) {
  window.dispatchEvent(new CustomEvent("vs-control-reveal", { detail: { cardId } }));
}

/** 定位成功那一句：当场闪一次、还是跳过去再闪一次，说的都是同一句话 */
const locatedLine = (cardName: string) =>
  tx(`已定位到画布上的「${cardName}」`, `located: “${cardName}” on the canvas`);

export function SendBuildPanel() {
  useLocale();
  // 浮层的定位要按缩放折算（共享 Flyout 的约定：它写回 style 时除以 zf）
  const settings = useSettings();
  const zf = (settings.zoom || 100) / 100;
  const tpls = useSyncExternalStore(sendStore.subscribe, sendStore.getSnapshot);
  const [selId, setSelId] = useState("");
  const [selField, setSelField] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  /** 「＋ 预设」的下拉开着时锚定的那颗键（浮层走共享 Flyout：portal 到 body，窄面板自动翻向） */
  const [presetAnchor, setPresetAnchor] = useState<HTMLElement | null>(null);
  const [at, setAt] = useState(-1);
  const stripRef = useRef<HTMLDivElement>(null);
  /** 一行放几格：按带的实际宽度算，窄面板不许把尺撑出横向滚动条 */
  const [cols, setCols] = useState(12);
  /** 就地改字节的那一格（只有 const 块允许），null = 没有 */
  const [edit, setEdit] = useState<{ fieldId: string; off: number } | null>(null);
  /** 上一次派生写了哪些假设（只在点下那颗键的那一刻产生，换谱就清） */
  const [derivedNotes, setDerivedNotes] = useState<string[]>([]);
  /** 来处标注要按 id 查协议名，所以这里订阅协议规则（名字不烘进谱里，改了还能认得出） */
  const rules = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);

  const tpl: SendTemplate | null = tpls.find((x) => x.id === selId) ?? tpls[0] ?? null;
  useEffect(() => {
    if (tpl && selId !== tpl.id) setSelId(tpl.id);
  }, [tpl, selId]);

  // 别的面板请这里选一张谱（Hex 右键、反推入口）：按 nonce 变化生效，再点同一张也该有反应
  const selNonce = useSyncExternalStore(sendStore.subscribe, sendStore.getSelectNonce);
  useEffect(() => {
    const req = sendStore.getSelectReq();
    if (req) setSelId(req.id);
  }, [selNonce]);

  /**
   * 「照最近收到的一帧起一张谱」。
   * 归档只在帧画布开着的时候收字节，所以"没有可反推的帧"是一种正常状态，要说清为什么没有。
   */
  const draftFromLastFrame = () => {
    const list = frameStore.archiveRef().list;
    const row = list[list.length - 1];
    if (!row?.bytes?.length) {
      setErr(
        tx(
          "帧归档里没有帧，反推不了：先收到一帧（归档只在帧画布开着时收字节）",
          "Nothing to infer — the archive holds no frame (it only fills while the frame canvas is open)",
        ),
      );
      return;
    }
    try {
      const bytes = Array.from(row.bytes);
      const { tpl: draft, notes } = draftFromFrame(bytes, row.tplId, `${tx("照帧起的谱", "Frame draft")} ${row.tplName}`);
      const id = sendStore.addDraftTemplate(draft);
      if (!id) {
        setErr(tx("Operator 只读：不能新建发送谱", "Operator read-only: no new send template"));
        return;
      }
      setSelId(id);
      setMsg(notes.join("；"));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // 换一张谱：上一张的报错和"已存为指令"不该还挂在下面冒充当前状态
  useEffect(() => {
    setErr("");
    setMsg("");
    setDerivedNotes([]);
  }, [selId]);

  // 预览用的序号 = 谱自己的计数器：这样"预览里那个 seq"就是下一次发送真会带上的那个
  /**
   * P122-D3 · 卡片正在拖动时的实时值。
   *
   * 它只在这一次拖动期间存在，松手就回到「发送一次」真正会发的那一帧 —— 因为面板底部那句
   * "看到的字节就是上线的字节"是这批立下的规矩，不能拿一个瞬态值偷偷把它换掉。
   * 所以 live 期间预览行改口说清这是谁的那一帧，而不是继续冒充发送口径。
   */
  const [live, setLive] = useState<{ specId: string; paramId: string; value: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ specId?: string; paramId?: string; value?: string | null }>).detail;
      if (!d?.specId || !d.paramId) return;
      if (d.value === null || d.value === undefined || d.value === "") setLive(null);
      else setLive({ specId: d.specId, paramId: d.paramId, value: String(d.value) });
    };
    window.addEventListener("vs-send-live", on);
    return () => window.removeEventListener("vs-send-live", on);
  }, []);
  const liveOn = !!live && !!tpl && live.specId === tpl.id ? live : null;
  const preview = useMemo(() => {
    if (!tpl) return null;
    try {
      const r = encodeSend(tpl, {
        seq: tpl.nextSeq ?? 0,
        values: liveOn ? { [liveOn.paramId]: liveOn.value } : undefined,
      });
      return { ok: true as const, ...r };
    } catch (e) {
      return { ok: false as const, msg: String(e).replace(/^Error:\s*/, "") };
    }
  }, [tpl, liveOn]);

  const field = tpl?.fields.find((f) => f.id === selField) ?? null;

  /**
   * 网格的数据只认预览这一份：画出来的第 i 格就是将要发出的第 i 字节。
   * 编码没过就没有字节可画 —— 退化成条带（块名 + 声明宽度），格子与尺一律不画。
   */
  const grid = useMemo(() => (tpl ? gridModel(tpl, preview?.ok ? preview : null) : null), [tpl, preview]);
  const rows = useMemo(() => (grid ? rowsOf(grid, cols) : []), [grid, cols]);
  const band: GridBlock[] = useMemo(() => {
    if (!tpl || !grid) return [];
    return preview?.ok ? grid.blocks : predictedBlocks(tpl);
  }, [tpl, grid, preview]);
  const approx = !!tpl && band.length > 0 && !preview?.ok;
  const badId = tpl && preview && !preview.ok ? guessBadFieldId(preview.msg, tpl) : "";
  const caret = at >= 0 && grid ? caretAt(grid, at) : null;
  /** 哪些块给拖宽的把手（只有 const 与 bcd，理由见 `byteGrid.resizedField`） */
  const resizable = useMemo(() => new Set((tpl?.fields ?? []).filter(canResize).map((x) => x.id)), [tpl]);
  /**
   * 覆盖条常态收起（P123-A）。那条 3px 的线回答的是"这个校验算到哪"，可它和
   * "这一格能就地改"的下划线上下相邻、同一个色族，窄面板里没人分得清是哪条在说话。
   * 现在：选中校验块才画线，平时由底部那行摘要报数 —— 点摘要就选中校验块，线就出来。
   */
  const covShown = field?.role === "checksum";
  const ckField = tpl?.fields.find((f) => f.role === "checksum") ?? null;

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const fit = () => setCols(Math.max(MIN_COLS, Math.floor((el.clientWidth - 12 - RULER_W + CELL_GAP) / PITCH)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tpl?.id]);

  /**
   * P122-C：这一块的值在控制画布上被谁用着 —— 在当前页就当场定位（闪一下），
   * 在别的页就把话写清楚并给一颗「去那里」，什么都没有就明说没有控件在用这个参数。
   *
   * 判据全在 `revealTargets`（纯函数，能钉住）；这里只负责问一次、说一句。
   * deps 只放谱 id 与参数 id：在名字框里打一个字就闪一次别人的面板，那不叫联动叫打扰。
   */
  const [link, setLink] = useState<{
    line: string;
    pageId?: string;
    cardId?: string;
    cardName?: string;
  } | null>(null);
  const specId = tpl?.id ?? "";
  const linkParamId = field?.source.kind === "param" ? field.source.paramId : "";
  useEffect(() => {
    // D2：常驻色跟着"现在盯着哪一块"走。放在最前面，是因为选了非参数块也要把上一次的高亮收掉
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
    if (here) {
      revealCard(here.cardId);
    }
    const more =
      hits.length > 1 ? tx(`（共 ${hits.length} 张）`, ` (${hits.length} cards)`) : "";
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

  // 面板关掉就把高亮收掉：不然"谁正被盯着"会留在控制画布上冒充当前状态
  useEffect(() => () => sendStore.setFocus(null), []);

  /**
   * D1 · 拖块右边界改宽度。
   *
   * 拖的过程中只改这一个本地状态（虚影 + 那一格数），松手才落一次 store ——
   * 一路 pointermove 都写 store 的话，撤销栈会被一次拖动灌进几十条。
   * 只有 const 与 bcd 有把手：它们的宽度真的是自己说得上；`ascii` 的字节数跟着值走
   * （编码器不 padding 也不截断），给它把手就是个拖了什么都不改的假开关。
   */
  const [resize, setResize] = useState<{ fieldId: string; width: number } | null>(null);
  const resizeOff = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeOff.current?.(), []);

  const startResize = (e: React.PointerEvent, fieldId: string, from: number) => {
    if (guardLocked() || !tpl) return;
    const specIdOf = tpl.id;
    const fields = tpl.fields;
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => setResize({ fieldId, width: resizeWidthBy(from, ev.clientX - x0) });
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      resizeOff.current = null;
    };
    const finish = (ev: PointerEvent | null) => {
      detach();
      setResize(null);
      if (!ev) return;
      const w = resizeWidthBy(from, ev.clientX - x0);
      if (w === from) return;
      const f = fields.find((x) => x.id === fieldId);
      if (!f) return;
      const patch = resizedField(f, w);
      if (patch) sendStore.patchField(specIdOf, fieldId, patch);
    };
    const onUp = (ev: PointerEvent) => finish(ev);
    const onCancel = () => finish(null);
    resizeOff.current = () => finish(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    setResize({ fieldId, width: from });
  };

  /**
   * 「写成解析协议」：把这张谱变成一份能解析自己发出去的东西的模板（P122-B 的那座桥）。
   *
   * 只在编得出帧的时候派生 —— 投影吃的就是这一帧，偏移是前缀和，没有猜测。
   * 但它仍然做了三件**替你先定下来**的事（帧头、变长块的长度、长度域→修正值），
   * 所以每一条都进 notes 并原样列在界面上：派生不是"帮你猜好了"。
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

  /** 格子里改一个字节：只写进这一块自己的 const 数组，别的来源一概不接 */
  const commitByte = (fieldId: string, off: number, text: string) => {    setEdit(null);
    const f = tpl?.fields.find((x) => x.id === fieldId);
    if (!f || f.source.kind !== "const") return;
    // 编辑期间块自己的字节数变了（撤销就是一条这样的路）：写下去会长出空洞字节，宁可放弃这次提交
    if (off < 0 || off >= f.source.bytes.length) return;
    const t = text.trim().toLowerCase();
    if (!/^[0-9a-f]{1,2}$/.test(t)) {
      setErr(tx("一个格子只收 1~2 位十六进制（比如 2a）", "One cell takes 1-2 hex digits (like 2a)"));
      return;
    }
    const bytes = f.source.bytes.slice();
    bytes[off] = Number.parseInt(t, 16);
    sendStore.patchField(tpl.id, fieldId, { source: { kind: "const", bytes } });
    setErr("");
  };

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
    const idxAt = (x: number, y: number) => {
      const b = boundaryAt(el, x, y);
      return b === null ? tpl.fields.length : insertIndexAtBoundary(band, b);
    };
    return attachPdragZone(el, {
      kinds: "sendspec sendfield",
      onOver: (d: PdragDetail) => setAt(idxAt(d.x, d.y)),
      onLeave: () => setAt(-1),
      onDrop: (d: PdragDetail) => {
        const index = idxAt(d.x, d.y);
        setAt(-1);
        if (d.kind === "sendspec") insertAt(d.data, index);
        else if (d.kind === "sendfield") {
          const from = tpl.fields.findIndex((f) => f.id === d.data);
          const to = moveTargetIndex(from, index);
          sendStore.moveField(tpl.id, from, to);
        }
      },
    });
  }, [tpl, insertAt, band]);

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

  /**
   * 载入一份出厂预设谱。
   *
   * 落库只有 `sendStore.importTemplates` 这一个出口 —— 于是"只追加、重名加序号、id 每次新生成"
   * 与「导入文件」是同一套语义，不必在这里再写一遍，也写不出第二份。
   * 锁着的时候 importTemplates 静默返回 0，所以先问一次锁：点了按钮一声不响是它最坏的失败方式。
   */
  const loadPreset = (def: SendPresetDef) => {
    setPresetAnchor(null);
    if (guardLocked()) {
      setErr(tx("Operator 只读：不能载入预设谱", "Operator read-only: presets can't be loaded"));
      return;
    }
    const n = sendStore.importTemplates(applySendPreset(def));
    if (!n) {
      setErr(tx("一张都没载入（这份预设是空的）", "Nothing loaded — this preset is empty"));
      return;
    }
    setErr("");
    // 载入后跳到第一张新谱：预设是"想看看它长什么样"才点的，留在原来那张谱上就等于没给看
    const list = sendStore.getSnapshot();
    const first = list[list.length - n];
    if (first) setSelId(first.id);
    setMsg(
      tx(`已载入 ${n} 张预设谱（只新增，不动你已有的）`, `Loaded ${n} preset templates — added only, nothing of yours touched`),
    );
  };

  /** 点开的那份预设菜单：锚在按钮上，portal 在 body（浮层的统一去处） */
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!presetAnchor) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if ((t && presetMenuRef.current?.contains(t)) || presetAnchor.contains(t)) return;
      setPresetAnchor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresetAnchor(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [presetAnchor]);

  const patchSel = (patch: Partial<SendField>) => {
    if (tpl && field) sendStore.patchField(tpl.id, field.id, patch);
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
          title={tx(
            "从预设载入示例谱（可反复载入；改崩了删掉那一份再载入一次）",
            "Load example templates from a preset (repeatable; delete a broken one and load it again)",
          )}
          aria-expanded={presetAnchor !== null}
          onClick={(e) => {
            // currentTarget 在事件派发结束就被 React 置空，所以这里同步取走再交给 updater
            const el = e.currentTarget;
            setPresetAnchor((cur) => (cur === el ? null : el));
          }}
        >
          {tx("预设", "Preset")} <IconChevron dir="down" size={12} />
        </button>
        {presetAnchor && (
          <Flyout anchor={presetAnchor} zf={zf} minWidth={220}>
            <div ref={presetMenuRef}>
              <div className="ctx-group">{tx("载入示例谱（只新增，不动你已有的）", "Load examples — added, never overwriting yours")}</div>
              {SEND_PRESETS.map((d) => (
                <button key={d.key} className="ctx-item" title={d.desc} onClick={() => loadPreset(d)}>
                  {d.tag} · {d.name}
                </button>
              ))}
            </div>
          </Flyout>
        )}
        <button
          className="btn icon-btn"
          title={tx(
            "照最近收到的一帧起一张谱（能重算验证的才写进谱，其余按定长字节放）",
            "Draft a template from the last received frame (only what recomputes exactly gets inferred; the rest lands as fixed bytes)",
          )}
          onClick={draftFromLastFrame}
        >
          <IconClock />
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
        <>
          {/* 空状态里没有页脚，报错只能自己挂在这里 —— 不然点了「照一帧起谱」而归档是空的，
              屏幕上一个字都不动，用户只会以为按钮坏了 */}
          {err !== "" && <div className="sb-danger">{err}</div>}
          <EmptyState
            title={tx("还没有发送谱", "No send templates yet")}
            hint={[tx("描述一帧要发的字节", "Describe the bytes one frame sends")]}
            actions={[
              { label: tx("新建", "New"), onClick: () => setSelId(sendStore.addTemplate()), primary: true },
              { label: tx("照最近收到的一帧起谱", "Draft from last frame"), onClick: draftFromLastFrame },
            ]}
          />
        </>
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
            className={`sb-strip${liveOn ? " live" : ""}`}
            ref={stripRef}
            role="group"
            aria-label={tx("字节带", "Byte strip")}
            onDragOver={(e) => e.preventDefault()}
          >
            {tpl.fields.length === 0 && <span className="sb-strip-blank">{tx("从料板拖一块进来，或点一下加到尾部", "Drag a block from the palette, or click one to append it")}</span>}

            {/* 条带：块名 + 顺序。编码没过时它就是你唯一能看的东西 —— 没有字节就不画格子、不画尺 */}
            {approx && (
              <div className="sb-band sb-band-loose" style={{ ["--blk"]: "var(--text-dim)" } as CSSProperties}>
                {band.map((b, bi) => (
                  <button
                    key={b.fieldId}
                    type="button"
                    data-seg-byte={b.start}
                    data-seg-len={b.len}
                    className={`sb-seg${b.len === 0 ? " sb-seg-point" : ""} sb-r-${b.role}${b.fieldId === selField ? " on" : ""}${b.fieldId === badId ? " bad" : ""}${at === bi ? " drop" : ""}`}
                    style={{ width: Math.max(12, b.len * PITCH - CELL_GAP) }}
                    title={`${b.name} · ${roleLabel(b.role)} · ${b.len}B`}
                    onPointerDown={(e) => beginPointerDrag(e, { kind: "sendfield", data: b.fieldId, label: b.name })}
                    onClick={() => setSelField(b.fieldId)}
                  >
                    {b.len * PITCH - CELL_GAP >= LABEL_MIN_W ? b.name : ""}
                  </button>
                ))}
                {at >= band.length && <i className="sb-drop-caret" aria-hidden="true" />}
              </div>
            )}
            {approx && (
              <div className="sb-hint">
                {tx(
                  "还没算出字节：条带按声明宽度摆块的顺序，格子与尺要等编码通过才画。",
                  "No bytes yet: the band shows block order at declared widths — cells and the ruler appear once encoding succeeds.",
                )}
              </div>
            )}

            {rows.map((row) => {
              const cw = row.cells * PITCH - CELL_GAP;
              return (
                <div className="sb-rowgrid" key={row.idx0}>
                  <div className="sb-ruler">{row.idx0.toString(16).toUpperCase().padStart(2, "0")}</div>
                  <div className="sb-track" style={{ width: cw }}>
                    <div className="sb-band" style={{ width: cw }}>
                      {row.segs.map((s) => {
                        const box = segBox(s);
                        // 把手只画在块的"最后一截"上：跨行的块中间那道断口不是它的边界
                        const ends = segEndsBlock(row.idx0, s);
                        const rz = resize && ends && resize.fieldId === s.block.fieldId ? resize : null;
                        return (
                          <Fragment key={`${s.block.fieldId}:${s.start}`}>
                            <button
                              type="button"
                              data-seg-byte={row.idx0 + s.start}
                              data-seg-len={s.len}
                              className={`sb-seg${s.point ? " sb-seg-point" : ""} sb-r-${s.block.role}${s.block.fieldId === selField ? " on" : ""}${s.block.fieldId === badId ? " bad" : ""}${rz ? " resizing" : ""}`}
                              style={
                                {
                                  left: box.left,
                                  width: box.width,
                                  ...(s.block.color ? { ["--blk"]: s.block.color } : {}),
                                } as CSSProperties
                              }
                              title={`${s.block.name} · ${roleLabel(s.block.role)} · ${s.block.len}B${s.block.editable ? tx(" · 双击格子可就地改那个字节", " · double-click a cell to edit that byte") : ""}`}
                              onPointerDown={(e) =>
                                beginPointerDrag(e, { kind: "sendfield", data: s.block.fieldId, label: s.block.name })
                              }
                              onClick={() => setSelField(s.block.fieldId)}
                            >
                              {s.point ? "·" : s.cont || box.width < LABEL_MIN_W ? "" : s.block.name}
                            </button>
                            {rz && (
                              <i
                                className="sb-ghost"
                                aria-hidden="true"
                                style={{ left: box.left, width: Math.max(4, rz.width * PITCH - CELL_GAP) }}
                              />
                            )}
                            {rz && (
                              <i className="sb-grip-tag" aria-hidden="true" style={{ left: box.left + rz.width * PITCH }}>
                                {rz.width} B
                              </i>
                            )}
                            {ends && resizable.has(s.block.fieldId) && (
                              <button
                                type="button"
                                className="sb-grip"
                                style={{ left: box.left + box.width - 1 }}
                                title={tx("拖动改这块的字节数", "Drag to change this block's byte count")}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  startResize(e, s.block.fieldId, s.block.len);
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                            {ends && s.block.type === "ascii" && (
                              <i
                                className="sb-grip-na"
                                aria-hidden="true"
                                style={{ left: box.left + box.width - 1 }}
                                title={tx(
                                  "文本块没有把手：它发出去几个字节跟着值走，编码器不补长也不截断",
                                  "A text block has no grip: how many bytes it sends follows the value — the encoder neither pads nor truncates",
                                )}
                              />
                            )}
                          </Fragment>
                        );
                      })}
                    </div>
                    <div className="sb-cells">
                      {Array.from({ length: row.cells }, (_, k) => {
                        const i = row.idx0 + k;
                        const b = grid?.owner[i] ?? null;
                        const ed = !!b && b.editable && edit?.fieldId === b.fieldId && edit.off === i - b.start;
                        const mark = caret && caret.cell === i ? (caret.side === "left" ? " drop-l" : " drop-r") : "";
                        if (ed && b) {
                          return (
                            <span className={`sb-cell sb-cell-edit${b.fieldId === selField ? " on" : ""}`} key={i} data-byte-index={i}>
                              <input
                                className="sb-byte"
                                defaultValue={hexByte(grid!.bytes[i])}
                                maxLength={2}
                                autoFocus
                                aria-label={`${tx("字节", "Byte")} ${i}`}
                                onBlur={(e) => commitByte(b.fieldId, i - b.start, e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitByte(b.fieldId, i - b.start, e.currentTarget.value);
                                  else if (e.key === "Escape") setEdit(null);
                                  else e.stopPropagation();
                                }}
                              />
                            </span>
                          );
                        }
                        return (
                          <button
                            key={i}
                            type="button"
                            data-byte-index={i}
                            className={`sb-cell${b ? ` sb-r-${b.role}${b.fieldId === selField ? " on" : ""}${b.editable ? " ed" : ""}` : ""}${mark}`}
                            title={b ? `${b.name} · ${roleLabel(b.role)}` : tx("不属于任何块", "No block here")}
                            onClick={() => b && setSelField(b.fieldId)}
                            onDoubleClick={() => {
                              if (b?.editable) setEdit({ fieldId: b.fieldId, off: i - b.start });
                            }}
                          >
                            {hexByte(grid!.bytes[i])}
                          </button>
                        );
                      })}
                    </div>
                    {!!row.cov.length && covShown && (
                      <div className="sb-cov">
                        {row.cov.map((c) => (
                          <i
                            key={c.start}
                            aria-hidden="true"
                            style={{ left: c.start * PITCH, width: c.len * PITCH - CELL_GAP }}
                            title={tx("校验覆盖到的字节", "Bytes the checksum covers")}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
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
                    {SEND_FIELD_ROLES.map((x) => (
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
                {link && (
                  <div className="sb-link">
                    <span className="sb-hint">{link.line}</span>
                    {/* 只有真的在别的页上才有这颗键：当前页已经闪过了还留一个"去那里"，那就是假开关 */}
                    {link.pageId !== undefined && link.cardId !== undefined && (
                      <button
                        className="btn"
                        onClick={() => {
                          if (!link.pageId || !link.cardId || !link.cardName) return;
                          controlsStore.setActivePage(link.pageId);
                          // 卡是新页面上刚渲染出来的，等一拍再闪（协议画布那条反向定位同一节奏）
                          const cardId = link.cardId;
                          window.setTimeout(() => revealCard(cardId), 80);
                          // 人都跳过去了，那句话不许还停在"在别的页上"
                          setLink({ line: locatedLine(link.cardName) });
                        }}
                      >
                        {tx("去那里", "Go there")}
                      </button>
                    )}
                  </div>
                )}
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
              {tpl.checksum?.algo === "crc_custom" && (
                <>
                  <label className="sb-row">
                    <span>{tx("位数", "Width")}</span>
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
                  </label>
                  {(["poly", "init", "xorout"] as const).map((k) => (
                    <label className="sb-row" key={k}>
                      <span>{k}</span>
                      <TextInput value={"0x" + crcOf()[k].toString(16)} onCommit={(v) => commitCrcNum(k, v)} />
                    </label>
                  ))}
                  <label className="sb-row">
                    <span>{tx("反射", "Reflect")}</span>
                    <span className="sb-inline">
                      <input
                        type="checkbox"
                        checked={crcOf().refin}
                        onChange={(e) => setCrc({ refin: e.target.checked })}
                      />
                      <span>{tx("输入", "in")}</span>
                      <input
                        type="checkbox"
                        checked={crcOf().refout}
                        onChange={(e) => setCrc({ refout: e.target.checked })}
                      />
                      <span>{tx("输出", "out")}</span>
                    </span>
                  </label>
                  <div className="sb-hint">
                    {tx(
                      "线上字节序跟着反射走：反射算法低字节在前 —— 同样的参数下 Modbus / X-25 与具名算法逐字节相同",
                      "Wire byte order follows reflection: reflected means low byte first — with these parameters Modbus / X-25 match the named algorithms byte for byte",
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="sb-params">
              <div className="sb-sec">{tx("解析协议", "Parsing protocol")}</div>
              {tpl.fromTplId && (
                <div className="sb-hint">
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
                <div className="sb-hint" key={i}>
                  {n}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tpl && (
        <div className="sb-foot">
          {liveOn && (
            <div className="sb-live">
              {tx(
                `参数「${tpl.params.find((p) => p.id === liveOn.paramId)?.name ?? liveOn.paramId}」正被卡片拖到 ${liveOn.value} —— 这一帧是它此刻的，松手就回到「发送一次」那一帧`,
                `Parameter “${tpl.params.find((p) => p.id === liveOn.paramId)?.name ?? liveOn.paramId}” is being dragged to ${liveOn.value} — this is that frame right now; release returns to what Send once sends`,
              )}
            </div>
          )}
          <div className={`sb-preview${preview?.ok ? "" : " bad"}`}>
            {preview?.ok ? preview.hex : preview?.msg || ""}
          </div>
          {ckField && grid?.cov && (
            <button
              type="button"
              className="sb-cov-sum"
              onClick={() => setSelField(ckField.id)}
              title={tx("点它就选中校验块，把算到哪一段画在格子上", "Click to select the checksum block and draw the range under the cells")}
            >
              {tx("校验覆盖", "Checksum covers")} {hexByte(grid.cov.start)}–{hexByte(grid.cov.start + grid.cov.len - 1)}
            </button>
          )}
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
