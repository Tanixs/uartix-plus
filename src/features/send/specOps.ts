/**
 * P124-B · 发送谱的**对象级**操作（新建 / 复制 / 删除 / 预设 / 照帧起谱 / 文件往返）。
 *
 * 为什么单独一个模块：这些动作操作的都不是"我正在编的这一张"，而是"谱这个集合"。
 * 它们原先长在 TX组帧台的工具条上，于是那条工具条一半对象动作、一半文档动作 ——
 * 用户看到的是一枚 `＋` 紧贴着「预设」，读出来就是"＋预设"（而 `＋` 其实是"新建一张谱"）。
 * 抽出来之后：导轨那一节（清单）和面板（工作台）共用同一份实现，谁也不抄第二遍。
 *
 * 一律返回 `{ ok, msg }` 而不是自己弹提示：**结果话术该由发起它的那一面显示**，
 * 清单里点「导入」和面板里点「导入」如果落在两个位置，用户就找不到反馈了。
 */
import * as cmdStore from "../controls/commandStore";
import * as frameStore from "../framecanvas/frameStore";
import { guardLocked } from "../operator/lock";
import { tx } from "../../i18n/strings";
import { draftFromFrame } from "./fromFrame";
import { applySendPreset, type SendPresetDef } from "./sendPresets";
import { encodeSend } from "./encodeSend";
import * as sendStore from "./sendStore";
import type { SendTemplate } from "./sendTypes";

export interface SpecOpResult {
  ok: boolean;
  msg: string;
  /** 需要把工作台焦点交给某张谱时给出（新建 / 照帧起谱 / 载入预设） */
  selectId?: string;
}

/** 新建一张空谱。锁着就说明为什么，不静默返回 null */
export function createSpec(): SpecOpResult {
  const id = sendStore.addTemplate();
  if (!id) return { ok: false, msg: tx("Operator 只读：不能新建发送谱", "Operator read-only: no new send template") };
  return { ok: true, msg: tx("已新建一张发送谱", "Send template created"), selectId: id };
}

export function duplicateSpec(tpl: SendTemplate): SpecOpResult {
  const id = sendStore.duplicateTemplate(tpl.id);
  if (!id) return { ok: false, msg: tx("Operator 只读：不能复制发送谱", "Operator read-only: can't duplicate") };
  return { ok: true, msg: tx("已复制一份", "Duplicated"), selectId: id };
}

export function removeSpec(tpl: SendTemplate): SpecOpResult {
  if (guardLocked()) return { ok: false, msg: tx("Operator 只读：不能删除发送谱", "Operator read-only: can't delete") };
  sendStore.removeTemplate(tpl.id);
  return { ok: true, msg: tx(`已删除「${tpl.name}」（Ctrl+Z 可以退回来）`, `Deleted “${tpl.name}” — Ctrl+Z brings it back`) };
}

/** 载入一组出厂预设：落库只有 `importTemplates` 这一个出口（只追加、重名加序号、id 新生成） */
export function loadPresetPack(def: SendPresetDef): SpecOpResult {
  if (guardLocked()) {
    return { ok: false, msg: tx("Operator 只读：不能载入预设谱", "Operator read-only: presets can't be loaded") };
  }
  const n = sendStore.importTemplates(applySendPreset(def));
  if (!n) return { ok: false, msg: tx("一张都没载入（这份预设是空的）", "Nothing loaded — this preset is empty") };
  const last = sendStore.getSnapshot()[sendStore.getSnapshot().length - 1];
  return {
    ok: true,
    msg: tx(`已载入 ${n} 张预设谱（只新增，不动你已有的）`, `Loaded ${n} preset templates — added, yours untouched`),
    selectId: last?.id,
  };
}

/**
 * 照最近收到的一帧起一张谱。
 *
 * 反推只写能重算验证的部分（校验段要真算得出那串尾巴、长度回填后还得整帧编回原样），
 * 替他做过哪些判断全写进返回的 msg —— 派生不是"帮你猜好了"。
 */
export function draftFromLastFrame(): SpecOpResult {
  const list = frameStore.archiveRef().list;
  const row = list[list.length - 1];
  if (!row?.bytes?.length) {
    return {
      ok: false,
      msg: tx(
        "帧归档里没有帧，反推不了：先收到一帧（归档只在帧画布开着时收字节）",
        "Nothing to infer — the archive holds no frame (it only fills while the frame canvas is open)",
      ),
    };
  }
  try {
    const bytes = Array.from(row.bytes);
    const { tpl: draft, notes } = draftFromFrame(bytes, row.tplId, `${tx("照帧起的谱", "Frame draft")} ${row.tplName}`);
    const id = sendStore.addDraftTemplate(draft);
    if (!id) {
      return { ok: false, msg: tx("Operator 只读：不能新建发送谱", "Operator read-only: no new send template") };
    }
    return { ok: true, msg: notes.join("；"), selectId: id };
  } catch (e) {
    return { ok: false, msg: String(e).replace(/^Error:\s*/, "") };
  }
}

/** 导出 / 导入 = 一张谱的**文件**往返（走 Tauri 另存为，与控制画布/编排器同一族） */
export async function exportSpec(tpl: SendTemplate): Promise<SpecOpResult> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await save({
      title: tx("导出发送谱", "Export send template"),
      defaultPath: `uartix-sendspec-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
      filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
    });
    if (!path) return { ok: true, msg: tx("已取消导出", "Export cancelled") };
    await invoke("save_text_file", { path, content: sendStore.packSpecFile([tpl]) });
    return { ok: true, msg: tx("已导出到文件", "Exported to file") };
  } catch (e) {
    return { ok: false, msg: String(e).replace(/^Error:\s*/, "") };
  }
}

export async function importSpec(): Promise<SpecOpResult> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await open({ multiple: false, filters: [{ name: "Uartix+ JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return { ok: true, msg: tx("已取消导入", "Import cancelled") };
    const list = sendStore.unpackSpecFile(await invoke<string>("read_text_file", { path }));
    if (!list) return { ok: false, msg: tx("不是发送谱文件（kind 不匹配）", "Not a send-template file (kind does not match)") };
    const n = sendStore.importTemplates(list);
    return n
      ? { ok: true, msg: tx(`已导入 ${n} 张谱`, `Imported ${n} templates`) }
      : { ok: false, msg: tx("文件里没有可导入的谱", "Nothing importable in that file") };
  } catch (e) {
    return { ok: false, msg: String(e).replace(/^Error:\s*/, "") };
  }
}

/** 这张谱现在编出来多少字节；编不出 ⇒ null（清单不许把"算不出来"画成一个数） */
export function specByteLen(t: SendTemplate): number | null {
  try {
    return encodeSend(t, { seq: t.nextSeq ?? 0 }).bytes.length;
  } catch {
    return null;
  }
}

/**
 * 有多少条命令在引用这张谱。
 *
 * 引用式命令（`sendTemplateId`）改谱就跟着变，所以删谱之前这个数字必须看得见 ——
 * 不然用户删掉的是"那几条指令的做法"，而指令本身还在库里，点下去才发现空了。
 */
export function specRefCount(specId: string): number {
  let n = 0;
  const walk = (items: commandStoreLike) => {
    for (const it of items) {
      if ("items" in it && Array.isArray((it as { items?: unknown[] }).items)) walk((it as { items: commandStoreLike }).items);
      else if ((it as { sendTemplateId?: string }).sendTemplateId === specId) n++;
    }
  };
  walk(cmdStore.getSnapshot().groups as unknown as commandStoreLike);
  return n;
}

type commandStoreLike = readonly { items?: unknown[]; sendTemplateId?: string }[];
