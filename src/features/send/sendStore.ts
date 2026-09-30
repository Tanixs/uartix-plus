/**
 * P121-B · 发送谱的 store。
 *
 * 三条与仓库既有 store 同构的规矩：
 *  - **写方法一律先过 `guardLocked()`**（§8-38 权限面封闭）。P121-A 刚在 `commandStore` 上
 *    补了两处漏的，这里从第一行起就不留缺口；
 *  - 落盘 250ms 防抖，解析失败即清键（不拿坏数据继续跑）；
 *  - 撤销用快照栈（`templateStore.ts:232-267` 同一手法，上限 50），不引第三方状态库。
 */
import type { SendField, SendParam, SendTemplate } from "./sendTypes";
import { guardLocked } from "../operator/lock";
import { tx } from "../../i18n/strings";

const KEY = "vs.sendTemplates";
const HISTORY_MAX = 50;

let templates: SendTemplate[] = [];
const listeners = new Set<() => void>();
const undoStack: string[] = [];
const redoStack: string[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  for (const cb of [...listeners]) cb();
}

function scheduleSave() {
  if (typeof localStorage === "undefined") return;
  // 裸 setTimeout 而不是 window.setTimeout：单测跑在 node 环境（没有 `window`），
  // 写 `window.` 会让这个 store 在测试里一 import 就炸
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      localStorage.setItem(KEY, JSON.stringify(templates));
    } catch {
      /* 配额满：内存里仍是真值，下一次改动再试 */
    }
  }, 250);
}

function pushHistory() {
  undoStack.push(JSON.stringify(templates));
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
}

function load(): SendTemplate[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    // 只认结构上说得通的条目：字段数组缺失的半条记录会让编码器在运行期抛奇怪错误
    return parsed
      .filter(
        (t): t is SendTemplate =>
          !!t && typeof t === "object" && Array.isArray((t as SendTemplate).fields) &&
          Array.isArray((t as SendTemplate).params),
      )
      // 序号计数器缺就归零：它是状态不是配置，缺一个值不该让整张谱不可用
      .map((t) => ({ ...t, nextSeq: Number.isFinite(t.nextSeq) ? t.nextSeq : 0 }));
  } catch {
    localStorage.removeItem(KEY);
    return [];
  }
}

templates = load();

/**
 * 跨面板的"选这张谱"请求（Hex 右键、反推入口都靠它，不然它们只能新建一张谱却选不中）。
 * nonce 让"再点一次同一张"也能触发 —— 面板那边是按 nonce 变化生效的，不是按 id。
 */
let selectReq: { id: string; nonce: number } | null = null;

export function requestSelect(id: string) {
  selectReq = { id, nonce: (selectReq?.nonce ?? 0) + 1 };
  emit();
}

export function getSelectReq() {
  return selectReq;
}

export function getSelectNonce() {
  return selectReq?.nonce ?? 0;
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): SendTemplate[] {
  return templates;
}

export function getTemplate(id: string): SendTemplate | null {
  return templates.find((t) => t.id === id) ?? null;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function write(next: SendTemplate[]) {
  templates = next;
  scheduleSave();
  emit();
}

export function addTemplate(name?: string): string {
  if (guardLocked()) return "";
  pushHistory();
  const id = uid("st");
  const tpl: SendTemplate = {
    id,
    name: name?.trim() || tx("新发送谱", "New send template"),
    note: "",
    fields: [],
    params: [],
    checksum: null,
    nextSeq: 0,
    createdAt: Date.now(),
  };
  write([...templates, tpl]);
  return id;
}

/**
 * 一次写入一整张草稿谱（反推、将来的预设包都走这里）。
 *
 * 为什么不逐块 `addField`：一张十二块的草稿会烧掉十二条撤销 —— 用户按一次 Ctrl+Z 只想回到
 * "还没反推"那个状态，不该按十二次。草稿是**一个动作**。
 * `nextSeq` 原样保留：反推出来的序号域起点就是那一帧的值，归零等于第一次发就发错。
 */
export function addDraftTemplate(draft: SendTemplate): string {
  if (guardLocked()) return "";
  pushHistory();
  const id = uid("st");
  let name = draft.name?.trim() || tx("反推的发送谱", "Inferred template");
  let n = 2;
  while (templates.some((t) => t.name === name)) name = `${draft.name} (${n++})`;
  write([
    ...templates,
    { ...draft, id, name, params: draft.params ?? [], createdAt: Date.now() },
  ]);
  return id;
}

export function patchTemplate(id: string, patch: Partial<SendTemplate>) {
  if (guardLocked()) return;
  pushHistory();
  write(templates.map((t) => (t.id === id ? { ...t, ...patch, id: t.id } : t)));
}

export function removeTemplate(id: string) {
  if (guardLocked()) return;
  pushHistory();
  write(templates.filter((t) => t.id !== id));
}

export function duplicateTemplate(id: string): string {
  if (guardLocked()) return "";
  const src = templates.find((t) => t.id === id);
  if (!src) return "";
  pushHistory();
  const copy: SendTemplate = {
    ...structuredClone(src),
    id: uid("st"),
    name: `${src.name} ${tx("副本", "copy")}`,
    // 计数器不跟着复制：两张谱各发各的，都从 5 开始就是让设备看到两个 5。
    // 副本是一条新流，从 0 起；真要接上原流的尾巴，用户在序号框里手填一次。
    nextSeq: 0,
    createdAt: Date.now(),
  };
  write([...templates, copy]);
  return copy.id;
}

/* ================== 字段与参数 ==================
 * 都按 templateId 定位后整体替换：谱是"一张表"，逐字段增量更新只会让撤销栈碎成一地。
 */

function withFields(id: string, mutate: (fields: SendField[]) => SendField[]) {
  if (guardLocked()) return;
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  pushHistory();
  write(templates.map((t) => (t.id === id ? { ...t, fields: mutate(t.fields) } : t)));
}

export function addField(id: string, field: SendField, at?: number) {
  withFields(id, (fs) => {
    const next = [...fs];
    next.splice(at === undefined ? next.length : Math.max(0, Math.min(at, next.length)), 0, field);
    return next;
  });
}

export function patchField(id: string, fieldId: string, patch: Partial<SendField>) {
  withFields(id, (fs) => fs.map((f) => (f.id === fieldId ? { ...f, ...patch, id: f.id } : f)));
}

export function removeField(id: string, fieldId: string) {
  withFields(id, (fs) => fs.filter((f) => f.id !== fieldId));
}

/** 拖拽换位（画布内拖动落点）与上下移按钮共用这一个出口 */
export function moveField(id: string, from: number, to: number) {
  if (from === to) return;
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  if (from < 0 || from >= tpl.fields.length || to < 0 || to >= tpl.fields.length) return;
  withFields(id, (fs) => {
    const next = [...fs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  });
}

export function addParam(id: string, param: SendParam) {
  if (guardLocked()) return;
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  pushHistory();
  write(templates.map((t) => (t.id === id ? { ...t, params: [...t.params, param] } : t)));
}

export function patchParam(id: string, paramId: string, patch: Partial<SendParam>) {
  if (guardLocked()) return;
  pushHistory();
  write(
    templates.map((t) =>
      t.id === id
        ? { ...t, params: t.params.map((p) => (p.id === paramId ? { ...p, ...patch, id: p.id } : p)) }
        : t,
    ),
  );
}

/**
 * 删参数前先问"还有字段引用它吗"。引用式的东西最怕**静默悬空**：参数没了、字段还在按老 id 取值，
 * 症状是"预览突然一直报错"，而用户看不出是谁被删了。（P113-E 的快照引用是同族教训）
 */
export function removeParam(id: string, paramId: string): { ok: true } | { ok: false; usedBy: string[] } {
  if (guardLocked()) return { ok: false, usedBy: [] };
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return { ok: false, usedBy: [] };
  const usedBy = tpl.fields
    .filter((f) => f.source.kind === "param" && f.source.paramId === paramId)
    .map((f) => f.name);
  if (usedBy.length) return { ok: false, usedBy };
  pushHistory();
  write(templates.map((t) => (t.id === id ? { ...t, params: t.params.filter((p) => p.id !== paramId) } : t)));
  return { ok: true };
}

/* ================== 撤销 ================== */

export function canUndo() {
  return undoStack.length > 0;
}
export function canRedo() {
  return redoStack.length > 0;
}

function restore(json: string) {
  const prev = JSON.parse(json) as SendTemplate[];
  // 撤销栈里存的是**配置**，运行期计数器不跟着回退：
  // 改完字段发过 5 帧再 Ctrl+Z，把 seq 拨回 0 等于让设备重收一遍 0..4。
  // 被撤销掉的那张谱（removeTemplate 后 undo）没有现值可继承，只能用快照里那个。
  const live = new Map(templates.map((t) => [t.id, t.nextSeq]));
  templates = prev.map((t) => ({ ...t, nextSeq: live.get(t.id) ?? t.nextSeq }));
  scheduleSave();
  emit();
}

export function undo() {
  if (guardLocked()) return;
  const prev = undoStack.pop();
  if (prev === undefined) return;
  redoStack.push(JSON.stringify(templates));
  restore(prev);
}

export function redo() {
  if (guardLocked()) return;
  const next = redoStack.pop();
  if (next === undefined) return;
  undoStack.push(JSON.stringify(templates));
  restore(next);
}

/* ================== 导入导出 ================== */

export function exportTemplates(): SendTemplate[] {
  return structuredClone(templates);
}

/** 文件信封的 kind：与 `uartix-controls` 同一族，导入时靠它认文件是不是我们要的那种 */
const FILE_KIND = "uartix-sendspecs";

/** 打包成文件内容。计数器（`nextSeq`）是运行期状态，不跟着谱分享——导出去、导入回 0 */
export function packSpecFile(list: SendTemplate[]): string {
  return JSON.stringify(
    {
      kind: FILE_KIND,
      version: 1,
      data: list.map((t) => ({ ...t, nextSeq: 0 })),
    },
    null,
    2,
  );
}

/** 认不出来就整份拒收（返回 null），而不是"能解析几条算几条" */
export function unpackSpecFile(text: string): SendTemplate[] | null {
  try {
    const obj = JSON.parse(text) as { kind?: string; data?: unknown };
    if (!obj || obj.kind !== FILE_KIND || !Array.isArray(obj.data)) return null;
    return obj.data as SendTemplate[];
  } catch {
    return null;
  }
}

/** 重名加序号合并（`templateStore.importTemplates` 同一语义：导入不该覆盖用户的东西） */
export function importTemplates(incoming: SendTemplate[]): number {
  if (guardLocked()) return 0;
  if (!Array.isArray(incoming) || !incoming.length) return 0;
  pushHistory();
  let added = 0;
  for (const raw of incoming) {
    if (!raw || !Array.isArray(raw.fields)) continue;
    const base = raw.name?.trim() || tx("导入的发送谱", "Imported template");
    let name = base;
    let n = 2;
    while (templates.some((t) => t.name === name)) name = `${base} (${n++})`;
    const tpl: SendTemplate = {
      ...raw,
      id: uid("st"),
      name,
      params: Array.isArray(raw.params) ? raw.params : [],
      fields: raw.fields,
      // 同 duplicateTemplate：导入的是一条新流，计数器从 0 起，不接文件里那个尾巴
      nextSeq: 0,
    };
    templates = [...templates, tpl];
    added++;
  }
  if (added) {
    scheduleSave();
    emit();
  }
  return added;
}

/** 清空全部。撤销栈里还能退回去，所以这不是不可恢复操作 */
export function clearAll() {
  if (guardLocked()) return;
  pushHistory();
  write([]);
}

/**
 * 取本次发送该用的自增序号，并**同步**把计数器往前推一格（D9）。
 *
 * 为什么是"先占号、发失败再退号"（`reserveSeq` + `refundSeq`），而不是"发成功后才推"：
 * 推号若发生在 `await sendCmd` 之后，两次重叠的发送（快速连点、循环发送、序列器）
 * 会读到同一个号各发一帧、然后把计数器推两格——设备看到的是"同一个号来两次、中间缺一个"。
 * 同步占号把这件事堵死；失败退还保住的仍是「失败不跳号」那条承诺。
 *
 * 刻意**不过 `guardLocked()`**：只读锁锁的是"改配置"，而发一帧正是现场操作员的本职。
 * 但序号存在谱里，所以它照样写盘、发通知——关键是**四个入口共用一个计数器**：
 * 面板、命令库、卡片、序列器各存一份的话，设备看到的 seq 就会跳号，
 * 而这正是"自增帧序号"这个字段要解决的问题本身。
 */
export function reserveSeq(id: string): number {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return 0;
  const at = Number.isFinite(tpl.nextSeq) ? tpl.nextSeq : 0;
  write(templates.map((t) => (t.id === id ? { ...t, nextSeq: (at + 1) % seqWrap(t) } : t)));
  return at;
}

/**
 * 发失败时把刚占的号退回去。只在这个号**仍是最新一次占号**时才退——
 * 两次发送重叠、前一次失败的话，后一个号已经发出去了，硬退会把已用的号再放出去一次。
 */
export function refundSeq(id: string, value: number) {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  if (tpl.nextSeq !== (value + 1) % seqWrap(tpl)) return;
  write(templates.map((t) => (t.id === id ? { ...t, nextSeq: value } : t)));
}

/** 序号回绕周期：谱上那个 seq 字段的宽度说了算（`wrap` 显式给定时以它为准） */
function seqWrap(tpl: SendTemplate): number {
  const seqField = tpl.fields.find((f) => f.source.kind === "seq");
  return seqField && seqField.source.kind === "seq"
    ? seqField.source.wrap ?? Math.pow(2, 8 * Math.max(1, seqField.size ?? 1))
    : 256;
}

/** 归零 / 手改序号：这是对谱内容的显式编辑，走锁也走撤销 */
export function setSeq(id: string, value: number) {
  if (guardLocked()) return;
  pushHistory();
  write(templates.map((t) => (t.id === id ? { ...t, nextSeq: Math.max(0, Math.floor(value) || 0) } : t)));
}
