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
    return parsed.filter(
      (t): t is SendTemplate =>
        !!t && typeof t === "object" && Array.isArray((t as SendTemplate).fields) &&
        Array.isArray((t as SendTemplate).params),
    );
  } catch {
    localStorage.removeItem(KEY);
    return [];
  }
}

templates = load();

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
    textMode: "hex",
    createdAt: Date.now(),
  };
  write([...templates, tpl]);
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
  templates = JSON.parse(json) as SendTemplate[];
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
