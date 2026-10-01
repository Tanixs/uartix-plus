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
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { FieldRole } from "../../ipc/types";
import { tx, useLocale } from "../../i18n/strings";
import { EmptyState } from "../../shared/EmptyState";
import { attachPdragZone, beginPointerDrag, type PdragDetail } from "../../shared/pointerDrag";
import { clampFlyoutMenu } from "../../shared/Flyout";
import { getSnapshot as readSettings, patch as patchSettings, useSettings } from "../settings/settingsStore";
import { runCommand } from "../controls/cmdExec";
import * as cmdStore from "../controls/commandStore";
import { guardLocked } from "../operator/lock";
import { isOpen as isPanelOpen } from "../../panels/panelActivity";
import { openProtocolTab } from "../../shell/railState";
import { requestOpenPanel } from "../ai/appBus";
import { setInspectorFocus, txeBackToSpec, useInspectorFocus } from "../inspector/focus";
import { roleNames } from "../inspector/roleNames";
import * as sendStore from "./sendStore";
import { encodeSend } from "./encodeSend";
import {
  CELL_GAP,
  CELL_W,
  MIN_COLS,
  canResize,
  caretAt,
  guessBadFieldId,
  gridModel,
  hexByte,
  insertIndexAtBoundary,
  LABEL_MIN_W,
  predictedBlocks,
  pitchOf,
  resizeWidthBy,
  resizedField,
  rowsOf,
  rulerW,
  segBox,
  segEndsBlock,
  type GridBlock,
} from "./byteGrid";
import {
  moveTargetIndex,
  paramTypeOf,
  type SendField,
  type SendTemplate,
} from "./sendTypes";

/**
 * 参数类型表。`enum` 故意不在选项里：它的档位表还没有编辑入口，
 * 给一个"选了却没法填"的选项就是假开关；但**已有** enum 参数的谱（导进来的）照样显示原值。
 */

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


/**
 * 切到 crc_custom 时先给一组**当场就能算出东西**的参数（CRC-16/CCITT-FALSE，`CRC_DEFAULT`）。
 * 留一个空参数组就是"选了算法却填不出帧"的中间态——这面板一路在消的就是这种态。
 */

const roleLabel = (r: FieldRole): string => roleNames()[r];

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

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

/** 定位成功那一句：当场闪一次、还是跳过去再闪一次，说的都是同一句话 */

export function SendBuildPanel() {
  useLocale();
  // 浮层的定位要按缩放折算（共享 Flyout 的约定：它写回 style 时除以 zf）
  const settings = useSettings();
  const zf = (settings.zoom || 100) / 100;
  /**
   * 缩放（P123-B）：格宽只有一个真值 = 设置项 `sbCellSize`，像素全从 `pitchOf` 算，
   * CSS 那侧靠 `--sb-cell` 拿同一个数（原来 CSS 里另写死一份 22px，缩放就成第二份真相）。
   */
  const cellW = settings.sbCellSize;
  const pitch = pitchOf(cellW);
  const ruler = rulerW(cellW);
  /** 字号与条带高跟着格宽派生。字号**不自造一档**：E 门要求刻度，所以这里只出一个
   *  乘数（基准是 `--fs-sm`），上限 1.6 —— 96 档的格子配 12px 太空、配 52px 又一行放不下三个字节。
   *  22 档算出来是 ×1 / 15px ⇒ 默认档一个像素都不变。 */
  const fsK = Math.min(1.6, cellW / CELL_W).toFixed(3);
  const bandH = Math.max(13, Math.min(24, Math.round(cellW * 0.68)));
  const tpls = useSyncExternalStore(sendStore.subscribe, sendStore.getSnapshot);
  const [selId, setSelId] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  /**
   * 块上的右键菜单（P123-D）。锚在点击处、定位在面板根上 —— 侧栏退役后"删一块 / 复制一块"
   * 没了近路，右键就是那条近路；它不新开属性页，只把这一块选中并给两个动作。
   */
  const [menu, setMenu] = useState<{ x: number; y: number; fieldId: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuElRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(-1);
  const stripRef = useRef<HTMLDivElement>(null);
  /** 一行放几格：按带的实际宽度算，窄面板不许把尺撑出横向滚动条 */
  const [cols, setCols] = useState(12);
  /** 就地改字节的那一格（只有 const 块允许），null = 没有 */
  const [edit, setEdit] = useState<{ fieldId: string; off: number } | null>(null);

  const tpl: SendTemplate | null = tpls.find((x) => x.id === selId) ?? tpls[0] ?? null;

  /**
   * 选中哪一块住在 `inspector/focus`（属性页要读它，所以它不许再住在面板的本地 state 里）。
   * 只认"这一侧 + 这一张谱"的焦点：换到别的谱，上一次选中的块自然失效。
   */
  const focus = useInspectorFocus();
  const selField = focus?.side === "tx" && focus.id === (tpl?.id ?? "") ? focus.fieldId : "";
  const focusSpecId = tpl?.id ?? "";
  const setSelField = useCallback(
    (id: string) => {
      if (!focusSpecId) return;
      setInspectorFocus({ side: "tx", id: focusSpecId, fieldId: id });
      // 点一块 = 要看它的属性：属性页没开着就叫它出来。只读锁下编辑会被 store 拦，
      // 把该看的那一面摆到眼前本身就是答案，所以这里不再多问一句"要不要打开"。
      if (!isPanelOpen("properties")) requestOpenPanel("properties");
    },
    [focusSpecId],
  );

  // 换谱时把 tx 的焦点挪到新谱（只在 tx 本来就握着焦点时才挪 —— 用户正在编解析协议就别去抢）
  useEffect(() => {
    if (tpl && focus?.side === "tx" && focus.id !== tpl.id) setInspectorFocus({ side: "tx", id: tpl.id, fieldId: "" });
    // 写完就把条件消掉了（focus.id 已等于 tpl.id），所以多跑一次不会再写：不循环
  }, [tpl, focus?.side, focus?.id]);
  useEffect(() => {
    if (tpl && selId !== tpl.id) setSelId(tpl.id);
  }, [tpl, selId]);

  // 别的面板请这里选一张谱（Hex 右键、反推入口）：按 nonce 变化生效，再点同一张也该有反应
  const selNonce = useSyncExternalStore(sendStore.subscribe, sendStore.getSelectNonce);
  useEffect(() => {
    const req = sendStore.getSelectReq();
    if (req) setSelId(req.id);
  }, [selNonce]);


  // 换一张谱：上一张的报错和"已存为指令"不该还挂在下面冒充当前状态
  useEffect(() => {
    setErr("");
    setMsg("");
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

  const openBlockMenu = (e: React.MouseEvent, fieldId: string) => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    e.preventDefault();
    setSelField(fieldId); // 右键也选中：菜单说的就是这一块，属性页跟着它
    setMenu({ x: (e.clientX - r.left) / zf, y: (e.clientY - r.top) / zf, fieldId });
  };
  useLayoutEffect(() => {
    const el = menuElRef.current;
    const root = rootRef.current;
    if (menu && el && root) clampFlyoutMenu(el, root, menu.x, menu.y);
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && menuElRef.current?.contains(t)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /** 复制一块就插在它后面：来源照抄（两块吃同一个参数是合法配置，计数器本来就共用一个） */
  const duplicateBlock = (fieldId: string) => {
    if (!tpl || guardLocked()) return;
    const at = tpl.fields.findIndex((x) => x.id === fieldId);
    const f = tpl.fields[at];
    if (!f) return;
    sendStore.addField(tpl.id, { ...f, id: uid("sf"), name: `${f.name} 2` }, at + 1);
  };

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const fit = () => setCols(Math.max(MIN_COLS, Math.floor((el.clientWidth - 12 - ruler + CELL_GAP) / pitch)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // 缩放改的是 pitch/ruler，不改条带元素的尺寸 ⇒ ResizeObserver 不会因此回调，
    // 所以每行几格必须跟着这两个数重算，否则放大后还是按旧档排（P123-B）
  }, [tpl?.id, pitch, ruler]);

  /** 上下限与帧画布同一对数（20~96）：两屏的手势该给出同一个结果 */
  const setCellW = (next: number) =>
    patchSettings({ sbCellSize: Math.max(20, Math.min(96, Math.round(next))) });

  /** 网格上 Ctrl+滚轮缩放 —— 与帧画布画布上那条手势同一条（P123-B） */
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onW = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = readSettings().sbCellSize;
      const next = Math.max(20, Math.min(96, cur + (e.deltaY < 0 ? 2 : -2)));
      if (next !== cur) patchSettings({ sbCellSize: next });
    };
    el.addEventListener("wheel", onW, { passive: false });
    return () => el.removeEventListener("wheel", onW);
  }, []);

  /** 缩放后把选中那块拉回视野：格宽一变行就重排，不锚定就是"我看的字节跳走了" */
  useEffect(() => {
    const on = stripRef.current?.querySelector(".sb-seg.on") ?? null;
    on?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cellW]);



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
    const move = (ev: PointerEvent) => setResize({ fieldId, width: resizeWidthBy(from, ev.clientX - x0, pitch) });
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
      const w = resizeWidthBy(from, ev.clientX - x0, pitch);
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
    [tpl, setSelField],
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





  /** 点开的那份预设菜单：锚在按钮上，portal 在 body（浮层的统一去处） */



  return (
    <div
      className="sb"
      ref={rootRef}
      onKeyDown={(e) => {
        // 菜单没开时，Esc 从这一块退回整张谱（与属性页那侧同一个手势）
        if (e.key === "Escape" && !menu) txeBackToSpec();
      }}
    >
      <div className="sb-bar p-bar">
        {/* P124-B：工具条只剩"我在编哪一张、这一步撤销什么、格子多大"。
            新建 / 预设 / 照帧起谱 / 导入 / 导出 / 复制 / 删除都是**对象级**动作，
            它们的家在左侧 协议 › 发送谱 —— 挤在这条里就会长出"＋预设"那种误读。 */}
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
        {tpl && (
          <input
            className="input sb-name"
            value={tpl.name}
            onChange={(e) => sendStore.patchTemplate(tpl.id, { name: e.target.value })}
          />
        )}
        <div className="sb-bar-spacer" />
        <button className="btn" onClick={() => sendStore.undo()} disabled={!sendStore.canUndo()}>
          {tx("撤销", "Undo")}
        </button>
        <button className="btn" onClick={() => sendStore.redo()} disabled={!sendStore.canRedo()}>
          {tx("重做", "Redo")}
        </button>
        <label className="sb-cellsz" title={tx("字节格尺寸（20~96，网格上 Ctrl+滚轮缩放，自动保存）", "Byte-cell size (20–96; Ctrl+wheel over the grid zooms; saved automatically)")}>
          <input
            type="range"
            min={20}
            max={96}
            value={cellW}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => setCellW(Number(e.target.value))}
          />
          <b>{cellW}</b>
        </label>
      </div>

      {!tpl ? (
        <>
          {/* 空状态里没有页脚，报错只能自己挂在这里 —— 点了那颗直达键而导轨那一节没能打开，
              屏幕上一个字都不动，用户只会以为按钮坏了 */}
          {err !== "" && <div className="sb-danger">{err}</div>}
          <EmptyState
            title={tx("还没有发送谱", "No send templates yet")}
            hint={[tx("描述一帧要发的字节", "Describe the bytes one frame sends")]}
            actions={[
              {
                label: tx("去 协议 › 发送谱 新建", "Create one under Protocol › Send specs"),
                onClick: () => openProtocolTab("send"),
                primary: true,
              },
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
            style={{ ["--sb-cell"]: `${cellW}px`, ["--sb-fs-k"]: fsK, ["--sb-band"]: `${bandH}px` } as CSSProperties}
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
                    style={{ width: Math.max(12, b.len * pitch - CELL_GAP) }}
                    title={`${b.name} · ${roleLabel(b.role)} · ${b.len}B`}
                    onPointerDown={(e) => beginPointerDrag(e, { kind: "sendfield", data: b.fieldId, label: b.name })}
                    onClick={() => setSelField(b.fieldId)}
                    onContextMenu={(e) => openBlockMenu(e, b.fieldId)}
                  >
                    {b.len * pitch - CELL_GAP >= LABEL_MIN_W ? b.name : ""}
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
              const cw = row.cells * pitch - CELL_GAP;
              return (
                <div className="sb-rowgrid" key={row.idx0}>
                  <div className="sb-ruler" style={{ width: ruler }}>{row.idx0.toString(16).toUpperCase().padStart(2, "0")}</div>
                  <div className="sb-track" style={{ width: cw }}>
                    <div className="sb-band" style={{ width: cw }}>
                      {row.segs.map((s) => {
                        const box = segBox(s, pitch);
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
                              onContextMenu={(e) => openBlockMenu(e, s.block.fieldId)}
                            >
                              {s.point ? "·" : s.cont || box.width < LABEL_MIN_W ? "" : s.block.name}
                            </button>
                            {rz && (
                              <i
                                className="sb-ghost"
                                aria-hidden="true"
                                style={{ left: box.left, width: Math.max(4, rz.width * pitch - CELL_GAP) }}
                              />
                            )}
                            {rz && (
                              <i className="sb-grip-tag" aria-hidden="true" style={{ left: box.left + rz.width * pitch }}>
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
                            style={{ left: c.start * pitch, width: c.len * pitch - CELL_GAP }}
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

      {menu &&
        (() => {
          const mf = tpl?.fields.find((x) => x.id === menu.fieldId) ?? null;
          if (!mf) return null;
          const locked = guardLocked();
          const why = tx("Operator 只读锁开着：配置改不动", "Operator read-only lock is on: configuration can't change");
          return (
            <div
              className="sb-menu"
              ref={menuElRef}
              style={{ left: menu.x, top: menu.y }}
              role="menu"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="sb-menu-head">
                {mf.name}
                <span className="sb-menu-sub">
                  {mf.type} · {roleLabel(mf.role)}
                </span>
              </div>
              <button
                type="button"
                role="menuitem"
                className="sb-menu-item"
                disabled={locked}
                title={locked ? why : tx("在它后面再来一块一样的", "Append an identical block right after it")}
                onClick={() => {
                  duplicateBlock(mf.id);
                  setMenu(null);
                }}
              >
                {tx("复制这块", "Duplicate block")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="sb-menu-item danger"
                disabled={locked}
                title={locked ? why : tx("从这张谱上删掉它", "Remove it from this template")}
                onClick={() => {
                  if (tpl) sendStore.removeField(tpl.id, mf.id);
                  setMenu(null);
                }}
              >
                {tx("删除这块", "Remove block")}
              </button>
              {canResize(mf) && (
                <div className="sb-menu-hint">
                  {tx("改字节数：拖它右边界那条把手（指针移到带上才现身）", "To change its width: drag the handle on its right edge (it appears when the pointer is over the band)")}
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
